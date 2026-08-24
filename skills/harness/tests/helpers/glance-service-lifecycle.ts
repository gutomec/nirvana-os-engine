import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchServiceHealth, portFreeProbe, createBunProcessAdapter, type ProcessInspection, type ServiceProcessAdapter } from "../../lib/glance/service/adapters.ts";
import { createGlanceServiceManager, restartBackend, startBackend, statusBackend, stopBackend, type FailedStartCleanup, type ManagerBackend, type ManagerInstrumentation, type StartAttempt } from "../../lib/glance/service/manager.ts";
import type { ServiceConfigV1 } from "../../lib/glance/service/types.ts";

type WriteFailureRequest = { artifact: "config" | "instance" | "secret" | "readiness"; boundary: "before" | "fsync" };

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

export function createRealLifecycleHarness() {
  let currentHome: string | undefined;
  let currentProject: string | undefined;
  let backendInstance: ManagerBackend | undefined;
  const counters = { spawn: 0, write: 0 };
  const lockOperations: string[] = [];
  let observedTarget: unknown;
  const killLog: number[] = [];
  const spawnedChildren: { pid: number; startupId: string; secretRef: string; processDigest: string; logRef: string; attempt?: Readonly<StartAttempt> }[] = [];
  let lastSpawned: (typeof spawnedChildren)[number] | undefined;
  const cleanupResults: FailedStartCleanup[] = [];
  const cleanupAttempts: Readonly<StartAttempt>[] = [];
  const writeFailures: WriteFailureRequest[] = [];
  let stopDeliveryFailures = 0;
  type InspectionMode = undefined | { kind: "foreign" } | { kind: "indeterminate" };
  let inspectionMode: InspectionMode = undefined;
  let pendingInspectionMode: InspectionMode = undefined;

  const baseAdapter = createBunProcessAdapter();
  const adapter: ServiceProcessAdapter = {
    ...baseAdapter,
    async inspect(pid: number): Promise<ProcessInspection> {
      if (inspectionMode?.kind === "indeterminate") throw new Error("INSPECT_INDETERMINATE");
      const inspection = await baseAdapter.inspect(pid);
      if (inspectionMode?.kind === "foreign" && inspection.exists) {
        return { exists: true, entrypoint: join("C:", "Windows", "System32", "notepad.exe"), argv: [join("C:", "Windows", "System32", "notepad.exe"), "/foreign"] };
      }
      return inspection;
    },
  };

  const instrumentation: ManagerInstrumentation = {
    adapter,
    count(event) {
      if (event === "spawn") counters.spawn += 1;
      if (event === "write") counters.write += 1;
    },
    failWrite(artifact, boundary) {
      const index = writeFailures.findIndex(request => request.artifact === artifact && request.boundary === boundary);
      if (index < 0) return false;
      writeFailures.splice(index, 1);
      return true;
    },
    onSpawn(spawned) {
      if (pendingInspectionMode) { inspectionMode = pendingInspectionMode; pendingInspectionMode = undefined; }
      lastSpawned = { ...spawned, attempt: cleanupAttempts[cleanupAttempts.length - 1] };
      spawnedChildren.push(lastSpawned);
    },
    onCleanup(cleanup) { cleanupResults.push(cleanup); },
    onCleanupAttempt(attempt) { cleanupAttempts.push(attempt); },
    failStopDelivery() {
      if (stopDeliveryFailures > 0) { stopDeliveryFailures -= 1; return true; }
      return false;
    },
  };

  function bind(home: string): ManagerBackend {
    const inner = createGlanceServiceManager(home, instrumentation);
    const wrapper: ManagerBackend = {
      stateIo: inner.stateIo,
      get workerEntrypoint() { return inner.workerEntrypoint; },
      serviceRoot: (h: string) => inner.serviceRoot(h),
      readPrivate: inner.readPrivate,
      writePrivate: inner.writePrivate,
      writeJson: inner.writeJson,
      observeStatePair: root => inner.observeStatePair(root),
      async withLock(target, operation, fn) {
        observedTarget = target;
        lockOperations.push(operation);
        return inner.withLock(target, operation, fn);
      },
      inspectExisting: input => inner.inspectExisting(input),
      archiveProvenStale: input => inner.archiveProvenStale(input),
      spawnWaitingWorker: input => inner.spawnWaitingWorker(input),
      awaitHealthy: input => inner.awaitHealthy(input),
      cleanupFailedStart: input => inner.cleanupFailedStart(input),
      requestAuthenticatedStop: input => inner.requestAuthenticatedStop(input),
      inspectStatus: input => inner.inspectStatus(input),
      terminal: (command, state, exitCode, code) => inner.terminal(command, state, exitCode, code),
      conflict: (command, code, current) => inner.conflict(command, code, current),
    };
    return wrapper;
  }

  const harness = {
    async home(): Promise<string> {
      currentHome = mkdtempSync(join(tmpdir(), "glance-home-"));
      backendInstance = bind(currentHome);
      return currentHome;
    },
    async project(): Promise<string> {
      currentProject = mkdtempSync(join(tmpdir(), "glance-project-"));
      return currentProject;
    },
    digestHome(home: string): string { return `sha256:${sha256(new TextEncoder().encode(realpathSync.native(home)))}`; },
    digestProject(project: string): string { return `sha256:${sha256(new TextEncoder().encode(realpathSync.native(project)))}`; },
    globalConfig(port: number) {
      return { schema_version: "1.0.0", scope: "global", host: "127.0.0.1", port, read_only: true, lifetime: "persistent", no_open: true };
    },
    projectConfig(port: number, projectRoot: string) {
      return { schema_version: "1.0.0", scope: "project", host: "127.0.0.1", port, read_only: true, lifetime: "persistent", no_open: true, project_root: projectRoot, project_root_digest: this.digestProject(projectRoot) };
    },
    backend(): ManagerBackend {
      if (!backendInstance) throw new Error("HARNESS_HOME_NOT_CREATED");
      return backendInstance;
    },
    async start(home: string, options: { scope: "global"; port: number } | { scope: "project"; port: number; project_root: string }) {
      const config = options.scope === "global" ? harness.globalConfig(options.port) : harness.projectConfig(options.port, options.project_root);
      return startBackend(harness.backend(), home, config);
    },
    async status(home: string) { return statusBackend(harness.backend(), home); },
    async stop(home: string) { return stopBackend(harness.backend(), home); },
    async restart(home: string, config?: ServiceConfigV1) { return restartBackend(harness.backend(), home, config); },
    async health(started: { port: number }) { return fetchServiceHealth(started.port, 2_000); },
    observedLockTarget(): unknown { return observedTarget; },
    lockOperations(): readonly string[] { return [...lockOperations]; },
    counters(): { spawn: number; write: number } { return { ...counters }; },
    async ownedByteSnapshot(home: string): Promise<{ config: string | null; instance: string | null; readiness: string | null; secret: string | null }> {
      const root = join(home, ".nirvana", "glance", "service");
      const readOrNull = (path: string): string | null => { try { if (!existsSync(path)) return null; return b64(readFileSync(path)); } catch { return null; } };
      let readiness: string | null = null;
      const startupDir = join(root, "control", "startup");
      if (existsSync(startupDir)) {
        const entries = readdirSync(startupDir).filter(name => name.endsWith(".ready.json")).sort();
        if (entries.length) readiness = b64(readFileSync(join(startupDir, entries[0])));
      }
      let secret: string | null = null;
      const secretRefs: string[] = [];
      const attemptSecretRef = cleanupAttempts[cleanupAttempts.length - 1]?.secretRef;
      if (attemptSecretRef) secretRefs.push(attemptSecretRef);
      try {
        const instanceRaw = JSON.parse(new TextDecoder().decode(readFileSync(join(root, "instance.json")))) as { control_secret_ref?: string };
        if (instanceRaw.control_secret_ref) secretRefs.push(instanceRaw.control_secret_ref);
      } catch {}
      for (const ref of secretRefs) {
        const bytes = readOrNull(join(root, ...ref.split("/")));
        if (bytes !== null) { secret = bytes; break; }
      }
      return {
        config: readOrNull(join(root, "config.json")),
        instance: readOrNull(join(root, "instance.json")),
        readiness,
        secret,
      };
    },
    async persistedInstance(home: string): Promise<Record<string, unknown>> {
      const raw = readFileSync(join(home, ".nirvana", "glance", "service", "instance.json"));
      return JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    },
    async archivedInstanceIds(home: string): Promise<string[]> {
      const archiveDir = join(home, ".nirvana", "glance", "service", "control", "archive");
      if (!existsSync(archiveDir)) return [];
      const ids: string[] = [];
      for (const entry of readdirSync(archiveDir)) {
        const instancePath = join(archiveDir, entry, "instance.json");
        if (!existsSync(instancePath)) continue;
        try {
          const parsed = JSON.parse(new TextDecoder().decode(readFileSync(instancePath))) as { instance_id?: string };
          if (parsed.instance_id) ids.push(parsed.instance_id);
        } catch {}
      }
      return ids;
    },
    async privateArtifacts(home: string): Promise<string[]> {
      const root = join(home, ".nirvana", "glance", "service");
      const artifacts: string[] = [];
      for (const relative of ["config.json", "instance.json"]) {
        if (existsSync(join(root, ...relative.split("/")))) artifacts.push(relative);
      }
      const scan = (dir: string, prefix: string) => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir)) artifacts.push(`${prefix}${entry}`);
      };
      scan(join(root, "control", "startup"), "control/startup/");
      scan(join(root, "control", "pending"), "control/pending/");
      scan(join(root, "control", "processing"), "control/processing/");
      scan(join(root, "secrets"), "secrets/");
      return artifacts.sort();
    },
    failNextHealth(options: { workerOutcome: "exited" | "unknown"; identityProof: "absent" | "indeterminate" }): void {
      const inner = instrumentation.fetchHealth;
      void inner;
      instrumentation.fetchHealth = async port => {
        instrumentation.fetchHealth = undefined;
        if (options.workerOutcome === "exited" && lastSpawned) {
          await harness.terminateFixtureProcess(lastSpawned.pid).catch(() => {});
        }
        throw new Error("START_HEALTH");
      };
      const boundManager = createGlanceServiceManager;
      void boundManager;
      if (options.identityProof === "indeterminate") pendingInspectionMode = { kind: "indeterminate" };
    },
    failNextOwnedWrite(request: WriteFailureRequest): void { writeFailures.push(request); },
    queueStopDeliveryFailure(): void { stopDeliveryFailures += 1; },
    drainPendingFailureArming(): void {
      const pendingHealth = instrumentation.fetchHealth;
      instrumentation.fetchHealth = undefined;
      inspectionMode = undefined;
      pendingInspectionMode = undefined;
      if (pendingHealth) void pendingHealth(0).catch(() => {});
    },
    replaceSpawnIdentityBeforeCleanup(_mode: string): void { pendingInspectionMode = { kind: "foreign" }; },
    makeSpawnInspectionIndeterminate(): void { pendingInspectionMode = { kind: "indeterminate" }; },
    lastSpawned() {
      if (!lastSpawned) throw new Error("NO_SPAWN_RECORDED");
      return lastSpawned;
    },
    lastCleanup() {
      const attempt = cleanupAttempts[cleanupAttempts.length - 1];
      const result = cleanupResults[cleanupResults.length - 1];
      if (!result || !attempt) throw new Error("NO_CLEANUP_RECORDED");
      return { attempt, result };
    },
    killPids(): number[] { return [...killLog]; },
    async processPresent(pid: number): Promise<boolean> { return (await baseAdapter.inspect(pid)).exists; },
    async terminateExactWorker(first: { pid: number }): Promise<void> { await harness.terminateFixtureProcess(first.pid); },
    async proveNoProcessPortOrHealth(first: { pid: number; port: number }): Promise<void> {
      if (await harness.processPresent(first.pid)) throw new Error("PROCESS_STILL_PRESENT");
      if (!(await portFreeProbe(first.port))) throw new Error("PORT_STILL_HELD");
      if (await fetchServiceHealth(first.port, 500)) throw new Error("HEALTH_STILL_PRESENT");
    },
    async terminateFixtureProcess(pid: number): Promise<void> {
      killLog.push(pid);
      if (process.platform === "win32") {
        Bun.spawnSync(["taskkill", "/F", "/PID", String(pid), "/T"], { stdout: "ignore", stderr: "ignore" });
      } else {
        try { process.kill(pid, "SIGTERM"); } catch {}
      }
    },
    async diagnoseStartFailure(home: string): Promise<{ state: string; evidence_preserved: boolean }> {
      const cleanup = cleanupResults[cleanupResults.length - 1];
      return {
        state: cleanup?.kind === "preserved" ? "error" : "stale",
        evidence_preserved: (await harness.privateArtifacts(home)).length > 0,
      };
    },
    exitCode(result: { ok: boolean; state: string }): number {
      if (result.ok) return 0;
      if (result.state === "conflict") return 4;
      if (result.state === "stale") return 3;
      if (result.state === "stopped" && !result.ok) return 1;
      return 6;
    },
  };
  return harness;
}
