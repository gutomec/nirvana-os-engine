import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeJcs } from "./canonicalize.ts";
import { canonicalWorkerArgv, classifyExistingService, createBunProcessAdapter, fetchServiceHealth, portFreeProbe, processDigestFromIdentity, terminateVerifiedProcess, type ProcessInspection, type ServiceProcessAdapter } from "./adapters.ts";
import { acquireLock, captureLockIdentity, createPrivateLockCandidateDirectory, removeLockCandidateIfOwned, removeLockTokenIfOwned } from "./lock.ts";
import { digestCanonicalPath, resolveServiceRef } from "./paths.ts";
import { publishNoReplace } from "./no-replace.ts";
import { createNativeNoReplace } from "./no-replace-native.ts";
import { validateInstance, validateLockOwner, validateServiceConfig } from "./schema-validator.ts";
import { IncompatibleStateError, createPrivateWriteTestHarness, readStateFileStrict, writeDurableJson, writePrivateBytes, digestJcs, type ServiceIo } from "./state.ts";
import { stopMacInput } from "./control.ts";
import type { GlanceServiceCommandResultV1, ServiceConfigV1, ServiceTarget } from "./types.ts";

const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalizeJcs(value)).digest("hex")}` as const;
const digestBytes = (value: Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}` as const;

export function deriveServiceTarget(nirvanaHome: string, config: ServiceConfigV1): ServiceTarget {
  return { nirvanaHomeDigest: digestCanonicalPath(nirvanaHome), scope: config.scope, projectRootDigest: config.scope === "project" ? config.project_root_digest : undefined, port: config.port, configDigest: digest(config) };
}

type MutatingOperation = "start" | "stop" | "restart";
export type StatePair = { kind: "absent" } | { kind: "partial"; configPresent: boolean; instancePresent: boolean; changed: boolean } | { kind: "complete" };
type ExistingInspection = { kind: "healthy"; pid: number; result: GlanceServiceCommandResultV1; processMatches: true; portMatches: true; healthMatches: true } | { kind: "stale"; processAbsent: true; portFree: true; healthAbsent: true } | { kind: "conflict"; result: GlanceServiceCommandResultV1 } | { kind: "indeterminate"; code: string };
type Sha256 = `sha256:${string}`;
type StartPhase = "allocated" | "secret_written" | "config_written" | "spawned" | "instance_published" | "readiness_published" | "healthy" | "running_published";

export interface StartAttempt { instanceId: string; startupId: string; secretRef: string; configDigest: Sha256; secretDigest: Sha256; phase: StartPhase; spawned?: { pid: number; processDigest: Sha256; logRef: string }; startingInstanceDigest?: Sha256; readinessDigest?: Sha256 }
export type FailedStartCleanup = { kind: "cleaned"; identity: "not-spawned" | "absent" | "exact"; terminated: boolean; portAbsent: true; healthAbsent: true; evidenceRef: string } | { kind: "preserved"; identity: "foreign" | "indeterminate"; terminated: false; evidenceRef: string };

export class StartFailure extends Error {
  constructor(readonly original: unknown, readonly cleanup: FailedStartCleanup) {
    super(original instanceof Error ? original.message : "GLANCE_SERVICE_START_FAILED");
    this.name = "StartFailure";
  }
}

export interface ManagerInstrumentation {
  now?(): number;
  sleep?(ms: number): Promise<void>;
  adapter?: ServiceProcessAdapter;
  workerEntrypoint?: string;
  fetchHealth?(port: number): Promise<Record<string, unknown> | undefined>;
  count?(event: "spawn" | "write" | "lockWrite" | "terminate", detail?: string): void;
  failWrite?: (artifact: "config" | "instance" | "secret" | "readiness", boundary: "before" | "fsync", path: string) => boolean;
  perturbInspection?(pid: number, inspection: ProcessInspection): ProcessInspection;
  failStopDelivery?(): boolean;
  onCleanup?(cleanup: FailedStartCleanup): void;
  onCleanupAttempt?(attempt: Readonly<StartAttempt>): void;
  onSpawn?(spawned: { pid: number; startupId: string; secretRef: string; processDigest: Sha256; logRef: string }): void;
}

export interface ManagerBackend {
  stateIo: ServiceIo;
  workerEntrypoint: string;
  serviceRoot(home: string): string;
  readPrivate(path: string): Uint8Array;
  writePrivate(path: string, bytes: Uint8Array): void;
  writeJson(path: string, value: unknown): void;
  observeStatePair(root: string): Promise<StatePair>;
  withLock<T>(target: ServiceTarget, operation: MutatingOperation, fn: () => Promise<T>): Promise<T>;
  inspectExisting(input: { root: string; currentTarget: ServiceTarget; config: ServiceConfigV1; instance: unknown }): Promise<ExistingInspection>;
  archiveProvenStale(input: { root: string; configDigest: Sha256; instanceDigest: Sha256; instanceId: string }): Promise<void>;
  spawnWaitingWorker(input: { root: string; target: ServiceTarget; instanceId: string; startupId: string; secretRef: string; argv: string[] }): Promise<{ pid: number; processDigest: Sha256; logRef: string }>;
  awaitHealthy(input: { root: string; target: ServiceTarget; instance: unknown }): Promise<GlanceServiceCommandResultV1>;
  cleanupFailedStart(input: { root: string; attempt: Readonly<StartAttempt>; error: unknown }): Promise<FailedStartCleanup>;
  requestAuthenticatedStop(input: { target: ServiceTarget; instance: unknown; secret: Uint8Array; nonce: Uint8Array; nonceRef: string; requestRef: string }): Promise<GlanceServiceCommandResultV1>;
  inspectStatus(input: { root: string; target: ServiceTarget; config: ServiceConfigV1; instance: unknown }): Promise<GlanceServiceCommandResultV1>;
  terminal(command: "start" | "stop" | "status", state: "stopped" | "stale", exitCode: 0 | 1 | 3, code: string): GlanceServiceCommandResultV1;
  conflict(command: "start", code: string, current: GlanceServiceCommandResultV1): GlanceServiceCommandResultV1;
}

export async function withEffectiveMutationTarget<T>(backend: ManagerBackend, home: string, operation: MutatingOperation, requested: ServiceConfigV1 | undefined, fn: (root: string, target: ServiceTarget, config: ServiceConfigV1) => Promise<T>): Promise<T> {
  const root = backend.serviceRoot(home);
  const config = requested ? validateServiceConfig(requested) : readStateFileStrict(resolveServiceRef(root, "config.json", true), validateServiceConfig, backend.stateIo);
  const target = deriveServiceTarget(home, config);
  return backend.withLock(target, operation, () => fn(root, target, config));
}

async function startFreshLocked(backend: ManagerBackend, root: string, target: ServiceTarget, config: ServiceConfigV1): Promise<GlanceServiceCommandResultV1> {
  const instanceId = randomUUID(), startupId = randomUUID(), secretRef = `secrets/${instanceId}.control`, secret = randomBytes(32), secretDigest = digestBytes(secret), argv = canonicalWorkerArgv(backend.workerEntrypoint, root, startupId), configPath = resolveServiceRef(root, "config.json", false), instancePath = resolveServiceRef(root, "instance.json", false), readyPath = resolveServiceRef(root, `control/startup/${startupId}.ready.json`, false);
  const attempt: StartAttempt = { instanceId, startupId, secretRef, configDigest: target.configDigest, secretDigest, phase: "allocated" };
  try {
    backend.writePrivate(resolveServiceRef(root, secretRef, false), secret);
    attempt.phase = "secret_written";
    backend.writeJson(configPath, config);
    attempt.phase = "config_written";
    const spawned = await backend.spawnWaitingWorker({ root, target, instanceId, startupId, secretRef, argv });
    attempt.spawned = { pid: spawned.pid, processDigest: spawned.processDigest, logRef: spawned.logRef };
    attempt.phase = "spawned";
    const starting = { schema_version: "1.0.0", instance_id: instanceId, pid: spawned.pid, state: "starting", started_at: new Date().toISOString(), config_digest: digest(config), process_digest: spawned.processDigest, control_secret_ref: secretRef, control_secret_digest: secretDigest, log_ref: spawned.logRef };
    const startingDigest = digest(starting);
    attempt.startingInstanceDigest = startingDigest;
    backend.writeJson(instancePath, starting);
    attempt.phase = "instance_published";
    const readiness = { schema_version: "1.0.0", startup_id: startupId, instance_id: instanceId, instance_digest: startingDigest };
    attempt.readinessDigest = digest(readiness);
    backend.writeJson(readyPath, readiness);
    attempt.phase = "readiness_published";
    const healthy = await backend.awaitHealthy({ root, target, instance: starting });
    attempt.phase = "healthy";
    const persisted = readStateFileStrict(instancePath, validateInstance, backend.stateIo);
    if (digest(persisted) !== startingDigest) throw new Error("STARTUP_STATE_CHANGED");
    const running = { ...persisted, state: "running" as const };
    backend.writeJson(instancePath, running);
    const confirmed = readStateFileStrict(instancePath, validateInstance, backend.stateIo);
    if (digest(confirmed) !== digest(running)) throw new Error("RUNNING_STATE_NOT_DURABLE");
    attempt.phase = "running_published";
    return { ...healthy, command: "start", ok: true, state: "running", instance_id: instanceId, pid: spawned.pid, effective_config_digest: target.configDigest };
  } catch (error) {
    const cleanup = await backend.cleanupFailedStart({ root, attempt: { ...attempt, spawned: attempt.spawned ? { ...attempt.spawned } : undefined }, error });
    throw new StartFailure(error, cleanup);
  }
}

async function classifyCompleteState(backend: ManagerBackend, root: string, home: string): Promise<{ config: ServiceConfigV1; instance: unknown; inspection: ExistingInspection; currentTarget: ServiceTarget } | { failure: GlanceServiceCommandResultV1 }> {
  let config: ServiceConfigV1;
  let instance: unknown;
  try {
    config = readStateFileStrict(resolveServiceRef(root, "config.json", true), validateServiceConfig, backend.stateIo);
    instance = readStateFileStrict(resolveServiceRef(root, "instance.json", true), validateInstance, backend.stateIo);
  } catch (error) {
    if (error instanceof IncompatibleStateError) return { failure: backend.terminal("start", "stale", 3, "STATE_INCOMPATIBLE") };
    throw error;
  }
  const currentTarget = deriveServiceTarget(home, config);
  const inspection = await backend.inspectExisting({ root, currentTarget, config, instance });
  return { config, instance, inspection, currentTarget };
}

function buildRunningResult(metadata: { engineVersion: string; extensionRootDigest: Sha256 }, instance: { pid: number; started_at: string; instance_id: string }, target: ServiceTarget, health: Record<string, unknown>, restartRequired: boolean): GlanceServiceCommandResultV1 {
  return {
    schema_version: "1.0.0",
    command: "status",
    ok: true,
    state: "running",
    instance_id: String(health.instance_id ?? instance.instance_id),
    pid: instance.pid,
    url: `http://127.0.0.1:${target.port}`,
    port: target.port,
    scope: target.scope,
    project_root: undefined,
    started_at: instance.started_at,
    uptime_seconds: Number(health.uptime_seconds ?? 0),
    engine_version: String(health.engine_version ?? metadata.engineVersion),
    read_only: true,
    persistent: true,
    log_path: "logs/service.log",
    extension_root_digest: metadata.extensionRootDigest,
    effective_config_digest: target.configDigest,
    restart_required: restartRequired,
    code: "RUNNING",
    message: restartRequired ? "service entrypoint changed since start" : "service healthy",
  };
}

export async function startBackend(backend: ManagerBackend, home: string, requested: ServiceConfigV1): Promise<GlanceServiceCommandResultV1> {
  const root = backend.serviceRoot(home), config = validateServiceConfig(requested), target = deriveServiceTarget(home, config);
  return backend.withLock(target, "start", async () => {
    const observed = await backend.observeStatePair(root);
    if (observed.kind === "absent") return startFreshLocked(backend, root, target, config);
    if (observed.kind === "partial") return backend.terminal("start", "stale", 3, "STATE_PARTIAL");
    let currentConfig: ServiceConfigV1, instance: unknown;
    try {
      currentConfig = readStateFileStrict(resolveServiceRef(root, "config.json", true), validateServiceConfig, backend.stateIo);
      instance = readStateFileStrict(resolveServiceRef(root, "instance.json", true), validateInstance, backend.stateIo);
    } catch (error) {
      if (error instanceof IncompatibleStateError) return backend.terminal("start", "stale", 3, "STATE_INCOMPATIBLE");
      throw error;
    }
    const currentConfigDigest = digest(currentConfig), instanceDigest = digest(instance);
    const currentTarget = deriveServiceTarget(home, currentConfig);
    const inspection = await backend.inspectExisting({ root, currentTarget, config: currentConfig, instance });
    if (inspection.kind === "healthy") {
      if (currentConfigDigest === target.configDigest) return { ...inspection.result, command: "start", ok: true, state: "running", pid: inspection.pid, effective_config_digest: currentConfigDigest };
      return backend.conflict("start", "CONFIG_CONFLICT", inspection.result);
    }
    if (inspection.kind === "conflict") return backend.conflict("start", String(inspection.result.code || "IDENTITY_CONFLICT"), inspection.result);
    if (inspection.kind === "indeterminate") return backend.terminal("start", "stale", 3, inspection.code);
    await backend.archiveProvenStale({ root, configDigest: currentConfigDigest, instanceDigest, instanceId: (instance as { instance_id: string }).instance_id });
    const afterArchive = await backend.observeStatePair(root);
    if (afterArchive.kind !== "absent") return backend.terminal("start", "stale", 3, "STALE_ARCHIVE_INCOMPLETE");
    return startFreshLocked(backend, root, target, config);
  });
}

async function stopWithinLock(backend: ManagerBackend, root: string, home: string): Promise<GlanceServiceCommandResultV1> {
  const observed = await backend.observeStatePair(root);
  if (observed.kind === "absent") return backend.terminal("stop", "stopped", 0, "ALREADY_STOPPED");
  if (observed.kind === "partial") return backend.terminal("stop", "stale", 3, "STATE_PARTIAL");
  let currentConfig: ServiceConfigV1, instance: unknown;
  try {
    currentConfig = readStateFileStrict(resolveServiceRef(root, "config.json", true), validateServiceConfig, backend.stateIo);
    instance = readStateFileStrict(resolveServiceRef(root, "instance.json", true), validateInstance, backend.stateIo);
  } catch (error) {
    if (error instanceof IncompatibleStateError) return backend.terminal("stop", "stale", 3, "STATE_INCOMPATIBLE");
    throw error;
  }
  void deriveServiceTarget(home, currentConfig);
  const typedInstance = instance as { instance_id: string; control_secret_ref: string };
  const secretPath = resolveServiceRef(root, typedInstance.control_secret_ref, true);
  const requestId = randomUUID();
  const nonceRef = `control/nonces/${requestId}.nonce`;
  const requestRef = `control/pending/${requestId}.json`;
  const noncePath = resolveServiceRef(root, nonceRef, false);
  const secret = backend.readPrivate(secretPath);
  const nonce = randomBytes(32);
  backend.writePrivate(noncePath, nonce);
  resolveServiceRef(root, requestRef, false);
  return backend.requestAuthenticatedStop({ target: deriveServiceTarget(home, currentConfig), instance, secret, nonce, nonceRef, requestRef });
}

export async function stopBackend(backend: ManagerBackend, home: string): Promise<GlanceServiceCommandResultV1> {
  const root = backend.serviceRoot(home);
  const observed = await backend.observeStatePair(root);
  if (observed.kind === "absent") return backend.terminal("stop", "stopped", 0, "ALREADY_STOPPED");
  if (observed.kind === "partial") return backend.terminal("stop", "stale", 3, "STATE_PARTIAL");
  let config: ServiceConfigV1;
  try {
    config = readStateFileStrict(resolveServiceRef(root, "config.json", true), validateServiceConfig, backend.stateIo);
  } catch (error) {
    if (error instanceof IncompatibleStateError) return backend.terminal("stop", "stale", 3, "STATE_INCOMPATIBLE");
    throw error;
  }
  const target = deriveServiceTarget(home, config);
  return backend.withLock(target, "stop", () => stopWithinLock(backend, root, home));
}

export async function statusBackend(backend: ManagerBackend, home: string): Promise<GlanceServiceCommandResultV1> {
  const root = backend.serviceRoot(home);
  const observed = await backend.observeStatePair(root);
  if (observed.kind === "absent") return backend.terminal("status", "stopped", 1, "NOT_RUNNING");
  if (observed.kind === "partial") return backend.terminal("status", "stale", 3, "STATE_PARTIAL");
  const configPath = resolveServiceRef(root, "config.json", true), instancePath = resolveServiceRef(root, "instance.json", true);
  try {
    const configBefore = readStateFileStrict(configPath, validateServiceConfig, backend.stateIo);
    const instanceBefore = readStateFileStrict(instancePath, validateInstance, backend.stateIo);
    const result = await backend.inspectStatus({ root, target: deriveServiceTarget(home, configBefore), config: configBefore, instance: instanceBefore });
    const observedAfter = await backend.observeStatePair(root);
    if (observedAfter.kind !== "complete") return backend.terminal("status", "stale", 3, "STATE_CHANGED");
    const configAfter = readStateFileStrict(configPath, validateServiceConfig, backend.stateIo);
    const instanceAfter = readStateFileStrict(instancePath, validateInstance, backend.stateIo);
    return digest(configBefore) === digest(configAfter) && digest(instanceBefore) === digest(instanceAfter) ? result : backend.terminal("status", "stale", 3, "STATE_CHANGED");
  } catch (error) {
    if (error instanceof IncompatibleStateError) return backend.terminal("status", "stale", 3, "STATE_INCOMPATIBLE");
    throw error;
  }
}

export async function restartBackend(backend: ManagerBackend, home: string, requested: ServiceConfigV1): Promise<GlanceServiceCommandResultV1> {
  const config = validateServiceConfig(requested);
  const root = backend.serviceRoot(home);
  const target = deriveServiceTarget(home, config);
  return backend.withLock(target, "restart", async () => {
    const observed = await backend.observeStatePair(root);
    if (observed.kind === "partial") return backend.terminal("restart", "stale", 3, "STATE_PARTIAL");
    let priorConfigRaw: Uint8Array | undefined;
    if (observed.kind === "complete") {
      const configPath = resolveServiceRef(root, "config.json", true);
      priorConfigRaw = backend.stateIo.read(configPath);
      const classification = await classifyCompleteState(backend, root, home);
      if ("failure" in classification) return { ...classification.failure, command: "restart" as const };
      const stopOutcome = await stopWithinLock(backend, root, home);
      if (!(stopOutcome.ok && stopOutcome.state === "stopped")) {
        return { ...stopOutcome, command: "restart" as const, ok: false, code: "RESTART_STOP_FAILED", message: "authenticated stop failed before replacement" };
      }
    }
    try {
      const fresh = await startFreshLocked(backend, root, target, config);
      return { ...fresh, command: "restart" as const, rollback_attempted: false, rollback_state: "not_needed" as const };
    } catch (error) {
      if (!(error instanceof StartFailure)) throw error;
      let rollbackState: "restored_previous" | "restore_failed" = "restore_failed";
      let rollbackAttempted = false;
      if (priorConfigRaw) {
        rollbackAttempted = true;
        try {
          backend.writeJson(resolveServiceRef(root, "config.json", false), JSON.parse(new TextDecoder().decode(priorConfigRaw)));
          rollbackState = "restored_previous";
        } catch { rollbackState = "restore_failed"; }
      }
      const base = backend.terminal("restart", "stale", 3, "REPLACEMENT_FAILED");
      return { ...base, rollback_attempted: rollbackAttempted, rollback_state: rollbackAttempted ? rollbackState : "not_needed" };
    }
  });
}

function artifactOf(path: string): "config" | "instance" | "secret" | "readiness" | undefined {
  const name = path.replaceAll("\\", "/").split("/").pop() ?? "";
  if (name === "config.json") return "config";
  if (name === "instance.json") return "instance";
  if (name.endsWith(".ready.json")) return "readiness";
  if (name.endsWith(".control")) return "secret";
  return undefined;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolveTask => setTimeout(resolveTask, ms));

function readEngineMetadata(): { engineVersion: string; extensionRootDigest: Sha256 } {
  const skillsRoot = join(import.meta.dir, "..", "..", "..", "..");
  const versionBytes = readFileSync(join(skillsRoot, "VERSION"));
  return { engineVersion: new TextDecoder().decode(versionBytes).trim(), extensionRootDigest: `sha256:${createHash("sha256").update(versionBytes).digest("hex")}` };
}

export function createGlanceServiceManager(home: string, instrumentation: ManagerInstrumentation = {}): ManagerBackend {
  const now = instrumentation.now ?? (() => Date.now());
  const sleep = instrumentation.sleep ?? defaultSleep;
  const adapter = instrumentation.adapter ?? createBunProcessAdapter();
  const metadata = readEngineMetadata();
  const native = createNativeNoReplace();
  const rootOf = (): string => join(home, ".nirvana", "glance", "service");

  const buildTerminal = (command: "start" | "stop" | "status" | "restart", state: "stopped" | "stale" | "error", exitCode: 0 | 1 | 3, code: string): GlanceServiceCommandResultV1 =>
    ({ schema_version: "1.0.0", command, ok: exitCode === 0, state, read_only: true, persistent: true, log_path: "logs/service.log", code, message: code });

  const runningResult = (instance: { pid: number; started_at: string; instance_id: string }, target: ServiceTarget, health: Record<string, unknown>, restartRequired: boolean): GlanceServiceCommandResultV1 =>
    buildRunningResult(metadata, instance, target, health, restartRequired);

  const backend: ManagerBackend = {
    stateIo: { read: readFileSync, archive(path) { rmSync(path); } },
    workerEntrypoint: instrumentation.workerEntrypoint ?? join(import.meta.dir, "..", "..", "..", "scripts", "glance-service-worker.ts"),
    serviceRoot(): string {
      const root = rootOf();
      mkdirSync(root, { recursive: true });
      return root;
    },
    readPrivate: readFileSync,
    writePrivate(path: string, bytes: Uint8Array): void {
      const artifact = artifactOf(path);
      if (artifact) instrumentation.count?.("write", artifact);
      if (artifact && instrumentation.failWrite?.(artifact, "before", path)) throw new Error(`INJECTED_${artifact.toUpperCase()}_WRITE`);
      writePrivateBytes(path, bytes);
    },
    writeJson(path: string, value: unknown): void {
      const artifact = artifactOf(path);
      if (artifact) instrumentation.count?.("write", artifact);
      if (artifact && instrumentation.failWrite?.(artifact, "before", path)) throw new Error(`INJECTED_${artifact.toUpperCase()}_WRITE`);
      if (artifact && instrumentation.failWrite?.(artifact, "fsync", path)) {
        const harness = createPrivateWriteTestHarness((operation, perform) => {
          if (operation === "file-fsync" || operation === "directory-fsync") throw new Error(`INJECTED_${artifact.toUpperCase()}_FSYNC`);
          perform();
        });
        harness.write(path, new TextEncoder().encode(`${JSON.stringify(value)}\n`));
        return;
      }
      writeDurableJson(path, value);
    },
    async observeStatePair(root: string): Promise<StatePair> {
      const classify = (name: string): "present" | "absent" => {
        try {
          const target = resolveServiceRef(root, name, false);
          if (!existsSync(target)) return "absent";
          return lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink() ? "present" : "present";
        } catch { return "absent"; }
      };
      const firstConfig = classify("config.json"), firstInstance = classify("instance.json");
      const secondConfig = classify("config.json"), secondInstance = classify("instance.json");
      if (firstConfig === "absent" && firstInstance === "absent" && secondConfig === "absent" && secondInstance === "absent") return { kind: "absent" };
      if (firstConfig === "present" && firstInstance === "present" && secondConfig === "present" && secondInstance === "present") return { kind: "complete" };
      return { kind: "partial", configPresent: secondConfig === "present", instancePresent: secondInstance === "present", changed: firstConfig !== secondConfig || firstInstance !== secondInstance };
    },
    async withLock<T>(_target: ServiceTarget, operation: MutatingOperation, fn: () => Promise<T>): Promise<T> {
      const root = rootOf();
      mkdirSync(root, { recursive: true });
      const destination = join(root, "manager.lock");
      const ownerUuid = randomUUID();
      const token = randomBytes(32);
      const acquiredAt = now();
      const owner = validateLockOwner({
        schema_version: "1.0.0",
        owner_id: ownerUuid,
        manager_pid: process.pid,
        operation,
        target: { nirvana_home_digest: _target.nirvanaHomeDigest, scope: _target.scope, ...(_target.scope === "project" && _target.projectRootDigest ? { project_root_digest: _target.projectRootDigest } : {}), port: _target.port },
        acquired_at: new Date(acquiredAt).toISOString(),
        expires_at: new Date(acquiredAt + 30_000).toISOString(),
        token_ref: `secrets/${ownerUuid}.manager`,
        token_digest: digestBytes(token),
      });
      const io = {
        candidate(op: string): string { return join(root, `.manager-lock-candidate-${op}-${randomUUID()}`); },
        destination,
        mkdir(path: string): void { createPrivateLockCandidateDirectory(path); },
        identity(path: string) { return captureLockIdentity(path); },
        writeToken(path: string, tokenBytes: Uint8Array): void { writePrivateBytes(join(path, ".owner-token"), tokenBytes); },
        writeOwner(path: string, ownerValue: unknown): void { writeDurableJson(join(path, "owner.json"), ownerValue); },
        secureAndSync(): void {},
        rereadAndValidate(path: string): void {
          if (!Buffer.from(readFileSync(join(path, ".owner-token"))).equals(Buffer.from(token))) throw new Error("SERVICE_IO:LOCK_TOKEN_MISMATCH");
          if (!existsSync(join(path, "owner.json"))) throw new Error("SERVICE_IO:LOCK_OWNER_MISSING");
        },
        removeIfIdentity(path: string, identity: ReturnType<typeof captureLockIdentity>): void { removeLockCandidateIfOwned(path, identity, join(path, ".owner-token"), token); },
        removeTokenIfOwned(path: string, tokenBytes: Uint8Array): void { removeLockTokenIfOwned(join(path, ".owner-token"), tokenBytes); },
        native,
      };
      for (;;) {
        try {
          instrumentation.count?.("lockWrite", operation);
          acquireLock(io, `${operation}-${randomUUID()}`, token, owner);
          break;
        } catch (error) {
          if (error instanceof Error && error.message === "LOCK_EXISTS") { await sleep(150); continue; }
          throw error;
        }
      }
      try {
        return await fn();
      } finally {
        rmSync(destination, { recursive: true, force: true });
      }
    },
    async inspectExisting({ root, currentTarget, config, instance }) {
      const typed = instance as { instance_id: string; pid: number; process_digest: string; started_at: string };
      let inspection = await adapter.inspect(typed.pid);
      inspection = instrumentation.perturbInspection?.(typed.pid, inspection) ?? inspection;
      const health = await fetchServiceHealth(currentTarget.port).catch(() => undefined);
      const verdict = classifyExistingService({
        expected: { instanceId: typed.instance_id, effectiveConfigDigest: digest(config), engineVersion: metadata.engineVersion, workerEntrypoint: this.workerEntrypoint, expectedServiceRoot: root, recordedProcessDigest: typed.process_digest },
        process: inspection,
        portOwnedByListener: true,
        health: health as Record<string, unknown> | undefined,
      });
      if (verdict.kind === "match") return { kind: "healthy", pid: typed.pid, result: runningResult(typed, currentTarget, health as Record<string, unknown>, false), processMatches: true as const, portMatches: true as const, healthMatches: true as const };
      if (verdict.kind === "drift") return { kind: "healthy", pid: typed.pid, result: runningResult(typed, currentTarget, health as Record<string, unknown>, true), processMatches: true as const, portMatches: true as const, healthMatches: true as const };
      if (verdict.kind === "stale") {
        const portFree = await portFreeProbe(currentTarget.port);
        if (!portFree) return { kind: "indeterminate", code: "PROCESS_ABSENT_PORT_HELD" };
        return { kind: "stale", processAbsent: true as const, portFree: true as const, healthAbsent: true as const };
      }
      if (verdict.kind === "conflict") return { kind: "conflict", result: { ...buildTerminal("start", "stale", 3, verdict.code), state: "conflict" as const, ok: false, pid: typed.pid, port: currentTarget.port, url: `http://127.0.0.1:${currentTarget.port}` } };
      return { kind: "indeterminate", code: verdict.code };
    },
    async archiveProvenStale({ root, configDigest, instanceDigest, instanceId }) {
      const configPath = resolveServiceRef(root, "config.json", true);
      const instancePath = resolveServiceRef(root, "instance.json", true);
      const currentConfig = readStateFileStrict(configPath, validateServiceConfig, backend.stateIo);
      const currentInstance = readStateFileStrict(instancePath, validateInstance, backend.stateIo);
      if (digest(currentConfig) !== configDigest || digest(currentInstance) !== instanceDigest || currentInstance.instance_id !== instanceId) throw new Error("STALE_PROOF_FAILED");
      const archiveDir = resolveServiceRef(root, `control/archive/${now()}-${randomUUID()}`, false);
      mkdirSync(archiveDir, { recursive: true });
      renameSync(configPath, join(archiveDir, "config.json"));
      renameSync(instancePath, join(archiveDir, "instance.json"));
    },
    async spawnWaitingWorker({ root, startupId, secretRef, argv }) {
      instrumentation.count?.("spawn", startupId);
      const logRef = `logs/${startupId}.log`;
      const spawned = adapter.spawn(argv, {}, join(root, logRef));
      spawned.unref();
      const deadline = now() + 2_500;
      for (;;) {
        const inspection = await adapter.inspect(spawned.pid);
        if (inspection.exists) break;
        if (now() >= deadline) throw new Error("WORKER_EXITED_IMMEDIATELY");
        await sleep(50);
      }
      const processDigest = processDigestFromIdentity({ entrypoint: this.workerEntrypoint, serviceRoot: root, startupId }) as Sha256;
      instrumentation.onSpawn?.({ pid: spawned.pid, startupId, secretRef, processDigest, logRef });
      return { pid: spawned.pid, processDigest, logRef };
    },
    async awaitHealthy({ target, instance }) {
      const deadline = now() + 15_000;
      for (;;) {
        const health = await (instrumentation.fetchHealth ?? fetchServiceHealth)(target.port);
        if (health && health.mode === "service" && health.instance_id === (instance as { instance_id: string }).instance_id && health.effective_config_digest === target.configDigest && health.process_digest === (instance as { process_digest: string }).process_digest && health.allow_actions === false && health.read_only === true && health.persistent === true) {
          return {
            schema_version: "1.0.0", command: "start", ok: true, state: "running",
            url: `http://127.0.0.1:${target.port}`, port: target.port, scope: target.scope,
            uptime_seconds: Number(health.uptime_seconds ?? 0),
            engine_version: String(health.engine_version ?? metadata.engineVersion),
            read_only: true, persistent: true, log_path: "logs/service.log",
            extension_root_digest: metadata.extensionRootDigest,
            effective_config_digest: target.configDigest, code: "HEALTHY", message: "service reported closed health",
          } satisfies GlanceServiceCommandResultV1;
        }
        if (now() >= deadline) throw new Error("START_HEALTH");
        await sleep(100);
      }
    },
    async cleanupFailedStart({ root, attempt }) {
      instrumentation.onCleanupAttempt?.(attempt);
      const evidenceRef = `control/archive/failed-${attempt.startupId}`;
      if (!attempt.spawned) {
        const configPath = resolveServiceRef(root, "config.json", false);
        if (existsSync(configPath)) {
          try { if (digestJcs(readStateFileStrict(configPath, validateServiceConfig, backend.stateIo)) === attempt.configDigest) rmSync(configPath); } catch {}
        }
        const secretPath = resolveServiceRef(root, attempt.secretRef, false);
        if (existsSync(secretPath)) {
          try { if (digestBytes(readFileSync(secretPath)) === attempt.secretDigest) rmSync(secretPath); } catch {}
        }
        const notSpawnedCleanup: FailedStartCleanup = { kind: "cleaned", identity: "not-spawned", terminated: false, portAbsent: true, healthAbsent: true, evidenceRef };
        instrumentation.onCleanup?.(notSpawnedCleanup);
        return notSpawnedCleanup;
      }
      instrumentation.count?.("terminate", String(attempt.spawned.pid));
      const termination = await terminateVerifiedProcess(adapter, attempt.spawned.pid, { entrypoint: this.workerEntrypoint, serviceRoot: root, startupId: attempt.startupId }, { expectedDigest: attempt.spawned.processDigest });
      if (termination === "foreign" || termination === "indeterminate") {
        const cleanupResult = { kind: "preserved", identity: termination, terminated: false, evidenceRef } as FailedStartCleanup;
        instrumentation.onCleanup?.(cleanupResult);
        return cleanupResult;
      }
      const configPath = resolveServiceRef(root, "config.json", false);
      let port: number | undefined;
      try {
        const parsed = JSON.parse(new TextDecoder().decode(readFileSync(configPath))) as { port?: number };
        if (typeof parsed.port === "number") port = parsed.port;
      } catch {}
      if (existsSync(configPath)) {
        try { if (digestJcs(readStateFileStrict(configPath, validateServiceConfig, backend.stateIo)) === attempt.configDigest) rmSync(configPath); } catch {}
      }
      const instancePath = resolveServiceRef(root, "instance.json", false);
      if (existsSync(instancePath)) {
        rmSync(instancePath, { force: true });
      }
      const startupDir = resolveServiceRef(root, "control/startup", false);
      if (existsSync(startupDir)) {
        for (const entry of readdirSync(startupDir)) {
          if (!entry.endsWith(".ready.json")) continue;
          const readyPath = join(startupDir, entry);
          try {
            const raw = JSON.parse(new TextDecoder().decode(readFileSync(readyPath))) as { startup_id?: string };
            if (raw.startup_id === attempt.startupId) rmSync(readyPath);
          } catch { if (entry.includes(attempt.startupId)) rmSync(readyPath, { force: true }); }
        }
      }
      const secretPath = resolveServiceRef(root, attempt.secretRef, false);
      if (existsSync(secretPath)) {
        try { if (digestBytes(readFileSync(secretPath)) === attempt.secretDigest) rmSync(secretPath); } catch {}
      }
      const logPath = resolveServiceRef(root, attempt.spawned.logRef, false);
      if (existsSync(logPath)) rmSync(logPath, { force: true });
      const portAbsent = port === undefined ? true : await portFreeProbe(port);
      const healthAbsent = port === undefined ? true : !(await fetchServiceHealth(port).catch(() => undefined));
      const cleanupResult: FailedStartCleanup = { kind: "cleaned", identity: termination === "absent" ? "absent" : "exact", terminated: termination === "terminated", portAbsent, healthAbsent, evidenceRef };
      instrumentation.onCleanup?.(cleanupResult);
      return cleanupResult;
    },
    async requestAuthenticatedStop({ instance, secret, nonce, nonceRef, requestRef }) {
      if (instrumentation.failStopDelivery?.()) throw new Error("INJECTED_STOP_DELIVERY");
      const root = rootOf();
      const requestId = requestRef.split("/").pop()!.replace(/\.json$/, "");
      const unsigned = {
        schema_version: "1.0.0",
        request_id: requestId,
        instance_id: (instance as { instance_id: string }).instance_id,
        action: "stop" as const,
        created_at: new Date(now()).toISOString(),
        expires_at: new Date(now() + 15_000).toISOString(),
        nonce_ref: nonceRef,
        nonce_digest: digestBytes(nonce),
        auth_algorithm: "hmac-sha256" as const,
      };
      const tag = createHmac("sha256", Buffer.from(secret)).update(stopMacInput(unsigned)).digest("hex");
      backend.writePrivate(resolveServiceRef(root, requestRef, false), new TextEncoder().encode(`${JSON.stringify({ ...unsigned, auth_tag: tag })}\n`));
      const instancePath = resolveServiceRef(root, "instance.json", false);
      const processingPath = resolveServiceRef(root, `control/processing/${requestId}.json`, false);
      const pendingPath = resolveServiceRef(root, requestRef, false);
      const deadline = now() + 20_000;
      for (;;) {
        if (!existsSync(instancePath) && !existsSync(pendingPath) && !existsSync(processingPath)) {
          const configPath = resolveServiceRef(root, "config.json", false);
          if (existsSync(configPath)) {
            const archiveDir = resolveServiceRef(root, `control/archive/${now()}-${randomUUID()}`, false);
            mkdirSync(archiveDir, { recursive: true });
            renameSync(configPath, join(archiveDir, "config.json"));
          }
          return { schema_version: "1.0.0", command: "stop", ok: true, state: "stopped", instance_id: (instance as { instance_id: string }).instance_id, read_only: true, persistent: true, log_path: "logs/service.log", code: "AUTHENTICATED_STOP", message: "worker drained and removed its capabilities" } satisfies GlanceServiceCommandResultV1;
        }
        if (now() >= deadline) return buildTerminal("stop", "stale", 3, "STOP_TIMEOUT");
        await sleep(100);
      }
    },
    async inspectStatus({ root, target, config, instance }) {
      const typed = instance as { instance_id: string; pid: number; process_digest: string; started_at: string };
      let inspection = await adapter.inspect(typed.pid);
      inspection = instrumentation.perturbInspection?.(typed.pid, inspection) ?? inspection;
      const health = await fetchServiceHealth(target.port).catch(() => undefined);
      const verdict = classifyExistingService({
        expected: { instanceId: typed.instance_id, effectiveConfigDigest: digest(config), engineVersion: metadata.engineVersion, workerEntrypoint: this.workerEntrypoint, expectedServiceRoot: root, recordedProcessDigest: typed.process_digest },
        process: inspection,
        portOwnedByListener: true,
        health: health as Record<string, unknown> | undefined,
      });
      if (verdict.kind === "match") return runningResult(typed, target, health as Record<string, unknown>, false);
      if (verdict.kind === "drift") return runningResult(typed, target, health as Record<string, unknown>, true);
      if (verdict.kind === "stale") return buildTerminal("status", "stale", 3, "PROCESS_ABSENT");
      if (verdict.kind === "conflict") return { ...buildTerminal("status", "stale", 3, verdict.code), state: "conflict" as const, ok: false, pid: typed.pid, port: target.port };
      return buildTerminal("status", "stale", 3, verdict.code);
    },
    terminal(command, state, exitCode, code): GlanceServiceCommandResultV1 {
      return buildTerminal(command, state, exitCode, code);
    },
    conflict(command, code, current) {
      return { ...current, command, ok: false, state: "conflict", code, message: code };
    },
  };
  return backend;
}
