import { expect, test } from "bun:test";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopMacInput } from "../lib/glance/service/control.ts";
import { drainServer } from "../lib/glance/service/request-drain.ts";
import { fetchServiceHealth } from "../lib/glance/service/adapters.ts";
import { resolveServiceRef } from "../lib/glance/service/paths.ts";
import { validateInstance } from "../lib/glance/service/schema-validator.ts";
import { parseStrictJson } from "../lib/glance/service/strict-json.ts";
import { ServiceIoError, digestJcs, writeDurableJson, writePrivateBytes } from "../lib/glance/service/state.ts";
import { createGlanceServiceManager, restartBackend, startBackend, statusBackend, stopBackend, type ManagerBackend } from "../lib/glance/service/manager.ts";
import type { GlanceServiceCommandResultV1 } from "../lib/glance/service/types.ts";
import { createStartupReadiness, createStopControl, runServiceWorker } from "../scripts/glance-service-worker.ts";
import { createRealLifecycleHarness } from "./helpers/glance-service-lifecycle.ts";

function allocateLoopbackPort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
  const port = probe.port;
  probe.stop(true);
  return port;
}

function manualScheduler() {
  let now = 0;
  let jobs: { due: number; callback: () => void }[] = [];
  const schedule = (callback: () => void, ms: number) => { jobs.push({ due: now + ms, callback }); return Symbol("job"); };
  const advance = (delta: number) => {
    now += delta;
    for (;;) {
      const due = jobs.filter(job => job.due <= now).sort((left, right) => left.due - right.due);
      if (!due.length) break;
      jobs = jobs.filter(job => job.due > now);
      for (const job of due) job.callback();
    }
  };
  return { schedule, advance, now: () => now };
}

function createWorkerHarness(port: number) {
  const root = mkdtempSync(join(tmpdir(), "glance-worker-"));
  const instanceId = randomUUID();
  const startupId = randomUUID();
  const secret = randomBytes(32);
  const config = { schema_version: "1.0.0", scope: "global", host: "127.0.0.1", port, read_only: true, lifetime: "persistent", no_open: true };
  const instance = (state: string) => ({
    schema_version: "1.0.0",
    instance_id: instanceId,
    pid: 4242,
    state,
    started_at: new Date().toISOString(),
    config_digest: digestJcs(config),
    process_digest: `sha256:${"b".repeat(64)}`,
    control_secret_ref: `secrets/${instanceId}.control`,
    control_secret_digest: `sha256:${createHash("sha256").update(secret).digest("hex")}`,
    log_ref: "logs/service.log",
  });
  return {
    root,
    instanceId,
    startupId,
    secret,
    secretPath: join(root, "secrets", `${instanceId}.control`),
    configPath: join(root, "config.json"),
    instancePath: join(root, "instance.json"),
    readyPath: join(root, "control", "startup", `${startupId}.ready.json`),
    noncePath: (requestId: string) => join(root, "control", "nonces", `${requestId}.nonce`),
    pendingPath: (requestId: string) => join(root, "control", "pending", `${requestId}.json`),
    processingPath: (requestId: string) => join(root, "control", "processing", `${requestId}.json`),
    instance,
    config,
    readiness: (overrides: Record<string, unknown> = {}) => ({ schema_version: "1.0.0", startup_id: startupId, instance_id: instanceId, instance_digest: digestJcs(instance("starting")), ...overrides }),
  };
}

function signStopRequest(harness: ReturnType<typeof createWorkerHarness>, requestId: string, over: Record<string, unknown> = {}) {
  const nonce = randomBytes(16);
  const base = {
    schema_version: "1.0.0",
    request_id: requestId,
    instance_id: harness.instanceId,
    action: "stop",
    created_at: new Date(Date.now() - 200).toISOString(),
    expires_at: new Date(Date.now() + 20_000).toISOString(),
    nonce_ref: `control/nonces/${requestId}.nonce`,
    nonce_digest: `sha256:${createHash("sha256").update(nonce).digest("hex")}`,
    auth_algorithm: "hmac-sha256",
    ...over,
  };
  return { request: { ...base, auth_tag: createHmac("sha256", Buffer.from(harness.secret)).update(stopMacInput(base)).digest("hex") }, nonce };
}

async function waitForHealth(url: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json() as Record<string, unknown>;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("HEALTH_NEVER_APPEARED");
}

function assembleRuntime(harness: ReturnType<typeof createWorkerHarness>, scheduler: { now(): number; schedule(callback: () => void, ms: number): unknown }, options: { countInstanceReads?: () => void; capturedReadiness?: Map<string, Uint8Array> } = {}) {
  const instancePath = resolveServiceRef(harness.root, "instance.json", false);
  const readiness = createStartupReadiness({
    now: scheduler.now,
    schedule: scheduler.schedule,
    capture: options.capturedReadiness,
  });
  const stopControl = createStopControl({ root: harness.root, now: () => Date.now(), schedule: scheduler.schedule, readPrivate: readFileSync });
  const runtime = {
    io: {
      read: (path: string) => {
        if (path === instancePath) options.countInstanceReads?.();
        return readFileSync(path);
      },
      archive() { throw new Error("archive not wired"); },
    },
    readPrivate: readFileSync,
    waitForStartupReady: readiness.waitForStartupReady,
    consumeStartupReady: readiness.consumeStartupReady,
    watchStop: stopControl.watchStop,
    validateAndConsume: stopControl.validateAndConsume,
    drain: (server: Bun.Server<unknown>) => drainServer(server, { timeoutMs: 2_000 }),
    finalizeStop: async (instance: unknown) => {
      const instancePath = resolveServiceRef(harness.root, "instance.json", false);
      const coreOf = (value: unknown): Record<string, unknown> => {
        const copy = { ...(value as Record<string, unknown>) };
        delete copy.state;
        return copy;
      };
      try {
        if (digestJcs(coreOf(parseStrictJson(readFileSync(instancePath)))) !== digestJcs(coreOf(instance))) return;
        rmSync(instancePath, { force: true });
      } catch { return; }
      try { rmSync(resolveServiceRef(harness.root, (instance as { control_secret_ref: string }).control_secret_ref, true), { force: true }); } catch {}
      try { appendFileSync(resolveServiceRef(harness.root, (instance as { log_ref: string }).log_ref, false), "stopped\n"); } catch {}
    },
    metadata: { engineVersion: "0.7.11", extensionRootDigest: `sha256:${"e".repeat(64)}` as const },
  };
  return { runtime, stopControl };
}

test("SVC-STARTUP-WORKER-FASTER-THAN-MANAGER", async () => {
  const port = allocateLoopbackPort();
  const harness = createWorkerHarness(port);
  const baseScheduler = manualScheduler();
  let scheduledPolls = 0;
  const scheduler = { ...baseScheduler, schedule: (callback: () => void, ms: number) => { scheduledPolls++; return baseScheduler.schedule(callback, ms); } };
  let instanceReads = 0;
  try {
    writePrivateBytes(harness.secretPath, harness.secret);
    writeDurableJson(harness.configPath, harness.config);
    const { runtime, stopControl } = assembleRuntime(harness, scheduler, { countInstanceReads: () => { instanceReads++; } });
    const done = runServiceWorker(
      { serviceRoot: harness.root, configRef: "config.json", instanceRef: "instance.json", startupId: harness.startupId },
      runtime,
    );
    scheduler.advance(500);
    expect(scheduledPolls).toBeGreaterThanOrEqual(1);
    expect(instanceReads).toBe(0);
    expect(existsSync(harness.instancePath)).toBe(false);
    expect(existsSync(harness.readyPath)).toBe(false);

    const starting = harness.instance("starting");
    writeDurableJson(harness.instancePath, starting);
    expect(readFileSync(harness.instancePath)).toEqual(Buffer.from(new TextEncoder().encode(`${JSON.stringify(starting)}\n`)));
    writeDurableJson(harness.readyPath, { schema_version: "1.0.0", startup_id: harness.startupId, instance_id: harness.instanceId, instance_digest: digestJcs(starting) });
    scheduler.advance(500);

    const health = await waitForHealth(`http://127.0.0.1:${port}/api/health`);
    expect(health).toMatchObject({
      schema_version: "1.0.0",
      mode: "service",
      instance_id: harness.instanceId,
      port,
      scope: "global",
      lifetime: "persistent",
      allow_actions: false,
      uptime_seconds: expect.any(Number),
      effective_config_digest: digestJcs(harness.config),
      process_digest: `sha256:${"b".repeat(64)}`,
      extension_root_digest: `sha256:${"e".repeat(64)}`,
      read_only: true,
      persistent: true,
    });
    expect(instanceReads).toBe(1);

    const requestId = randomUUID();
    const { request, nonce } = signStopRequest(harness, requestId);
    writePrivateBytes(harness.noncePath(requestId), nonce);
    await stopControl.deliver(request);
    await done;
    expect(existsSync(harness.noncePath(requestId))).toBe(false);
    expect(existsSync(harness.processingPath(requestId))).toBe(false);
    expect(existsSync(harness.readyPath)).toBe(false);
    expect(existsSync(harness.instancePath)).toBe(false);
    expect(existsSync(harness.secretPath)).toBe(false);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}, 30_000);

test("SVC-STARTUP-READY-TIMEOUT", async () => {
  const port = allocateLoopbackPort();
  const harness = createWorkerHarness(port);
  const scheduler = manualScheduler();
  let instanceReads = 0;
  try {
    writePrivateBytes(harness.secretPath, harness.secret);
    writeDurableJson(harness.configPath, harness.config);
    const { runtime } = assembleRuntime(harness, scheduler, { countInstanceReads: () => { instanceReads++; } });
    const done = runServiceWorker(
      { serviceRoot: harness.root, configRef: "config.json", instanceRef: "instance.json", startupId: harness.startupId },
      runtime,
    );
    const outcome = done.then(() => "no-error", (error: unknown) => String((error as Error)?.message));
    scheduler.advance(12_000);
    expect(await outcome).toContain("STARTUP_READY_TIMEOUT");
    expect(instanceReads).toBe(0);
  } finally { rmSync(harness.root, { recursive: true, force: true }); }
}, 30_000);

test("SVC-STARTUP-READY-DIGEST", async () => {
  const port = allocateLoopbackPort();
  const harness = createWorkerHarness(port);
  const scheduler = manualScheduler();
  try {
    writePrivateBytes(harness.secretPath, harness.secret);
    writeDurableJson(harness.configPath, harness.config);
    writeDurableJson(harness.instancePath, harness.instance("starting"));
    writeDurableJson(harness.readyPath, harness.readiness({ instance_digest: `sha256:${"f".repeat(64)}` }));
    const { runtime } = assembleRuntime(harness, scheduler);
    const failure = await runServiceWorker(
      { serviceRoot: harness.root, configRef: "config.json", instanceRef: "instance.json", startupId: harness.startupId },
      runtime,
    ).then(() => undefined, (error: unknown) => error);
    expect(String((failure as Error)?.message)).toContain("STARTUP_INSTANCE_DIGEST");
  } finally { rmSync(harness.root, { recursive: true, force: true }); }
}, 30_000);

const realLifecycle = createRealLifecycleHarness();

test("SVC-CONTRACT-MANAGER-WORKER", async () => {
  const globalHome = await realLifecycle.home();
  const port = allocateLoopbackPort();
  const started = await realLifecycle.start(globalHome, { scope: "global", port });
  expect(started.ok).toBe(true);
  expect(await realLifecycle.health(started)).toMatchObject({
    schema_version: "1.0.0",
    mode: "service",
    instance_id: started.instance_id,
    port,
    scope: "global",
    lifetime: "persistent",
    allow_actions: false,
    engine_version: expect.any(String),
    uptime_seconds: expect.any(Number),
    effective_config_digest: expect.stringMatching(/^sha256:/),
    process_digest: expect.stringMatching(/^sha256:/),
    extension_root_digest: expect.stringMatching(/^sha256:/),
    read_only: true,
    persistent: true,
  });
  const status = await realLifecycle.status(globalHome);
  expect(status).toMatchObject({ command: "status", state: "running", instance_id: started.instance_id, scope: "global" });
  const stopped = await realLifecycle.stop(globalHome);
  expect(stopped.state).toBe("stopped");
  expect(await realLifecycle.privateArtifacts(globalHome)).toEqual([]);
}, 90_000);

test("SVC-CONTRACT-MANAGER-WORKER-PROJECT", async () => {
  const home = await realLifecycle.home(), project = await realLifecycle.project();
  const port = allocateLoopbackPort();
  const started = await realLifecycle.start(home, { scope: "project", project_root: project, port });
  try {
    expect(started.ok).toBe(true);
    expect(realLifecycle.observedLockTarget()).toMatchObject({ nirvanaHomeDigest: realLifecycle.digestHome(home), scope: "project", projectRootDigest: realLifecycle.digestProject(project), port });
    const status = await realLifecycle.status(home);
    expect(status.scope).toBe("project");
    expect(realLifecycle.lockOperations()).not.toContain("status");
    await realLifecycle.stop(home);
  } catch (error) {
    await realLifecycle.terminateFixtureProcess(started.pid!).catch(() => {});
    throw error;
  }
}, 90_000);

test("SVC-START-IDEMPOTENT-REAL-BACKEND-TWICE", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  const first = await startBackend(backend, home, realLifecycle.globalConfig(port));
  try {
    const countersBefore = realLifecycle.counters(), bytesBefore = await realLifecycle.ownedByteSnapshot(home);
    const second = await startBackend(backend, home, realLifecycle.globalConfig(port));
    const countersAfter = realLifecycle.counters(), bytesAfter = await realLifecycle.ownedByteSnapshot(home);
    expect(second).toMatchObject({ state: "running", pid: first.pid, instance_id: first.instance_id });
    expect(countersAfter.spawn).toBe(countersBefore.spawn);
    expect(countersAfter.write).toBe(countersBefore.write);
    expect(bytesAfter).toEqual(bytesBefore);
    expect((await realLifecycle.persistedInstance(home)).state).toBe("running");
  } finally { await realLifecycle.stop(home); }
}, 120_000);

test("SVC-START-CONFLICT-PRESERVES-OWNED-BYTES", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  const first = await startBackend(backend, home, realLifecycle.globalConfig(port));
  try {
    const bytesBefore = await realLifecycle.ownedByteSnapshot(home);
    const conflict = await startBackend(backend, home, realLifecycle.globalConfig(allocateLoopbackPort()));
    const bytesAfter = await realLifecycle.ownedByteSnapshot(home);
    expect(conflict).toMatchObject({ ok: false, state: "conflict", code: "CONFIG_CONFLICT", pid: first.pid });
    expect(realLifecycle.exitCode(conflict)).toBe(4);
    expect(bytesAfter).toEqual(bytesBefore);
    expect(Object.keys(bytesAfter).sort()).toEqual(["config", "instance", "readiness", "secret"]);
  } finally { await realLifecycle.stop(home); }
}, 120_000);

test("SVC-START-FAILURE-CLEANUP-PROVEN", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  realLifecycle.failNextHealth({ workerOutcome: "exited", identityProof: "absent" });
  await expect(startBackend(backend, home, realLifecycle.globalConfig(port))).rejects.toThrow("START_HEALTH");
  expect(await realLifecycle.privateArtifacts(home)).toEqual([]);
  expect(await realLifecycle.ownedByteSnapshot(home)).toEqual({ config: null, instance: null, readiness: null, secret: null });
}, 120_000);

test("SVC-START-PRE-SPAWN-CLEANUP-NO-PROCESS", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  const killsBefore = realLifecycle.killPids().length;
  realLifecycle.failNextOwnedWrite({ artifact: "config", boundary: "before" });
  await expect(startBackend(backend, home, realLifecycle.globalConfig(port))).rejects.toThrow("INJECTED_CONFIG_WRITE");
  const { attempt, result: cleanup } = realLifecycle.lastCleanup();
  expect(attempt).toMatchObject({ phase: "secret_written", spawned: undefined });
  expect(cleanup).toMatchObject({ kind: "cleaned", identity: "not-spawned", terminated: false });
  expect(realLifecycle.killPids().length).toBe(killsBefore);
  expect(await realLifecycle.ownedByteSnapshot(home)).toEqual({ config: null, instance: null, readiness: null, secret: null });
}, 120_000);

test("SVC-START-INSTANCE-WRITE-FAIL-EXACT-CLEANUP", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  realLifecycle.failNextOwnedWrite({ artifact: "instance", boundary: "before" });
  await expect(startBackend(backend, home, realLifecycle.globalConfig(port))).rejects.toThrow("INJECTED_INSTANCE_WRITE");
  const spawned = realLifecycle.lastSpawned(), cleanup = realLifecycle.lastCleanup();
  expect(cleanup.attempt).toMatchObject({ phase: "spawned", secretRef: spawned.secretRef, spawned: { pid: spawned.pid, processDigest: spawned.processDigest, logRef: spawned.logRef } });
  expect(cleanup.result).toMatchObject({ kind: "cleaned", identity: "exact", terminated: true, portAbsent: true, healthAbsent: true });
  expect(await realLifecycle.processPresent(spawned.pid)).toBe(false);
  expect(await realLifecycle.ownedByteSnapshot(home)).toEqual({ config: null, instance: null, readiness: null, secret: null });
}, 120_000);

test("SVC-START-INSTANCE-FSYNC-FAIL-EXACT-CLEANUP", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  realLifecycle.failNextOwnedWrite({ artifact: "instance", boundary: "fsync" });
  await expect(startBackend(backend, home, realLifecycle.globalConfig(port))).rejects.toThrow("INJECTED_INSTANCE_FSYNC");
  const spawned = realLifecycle.lastSpawned(), cleanup = realLifecycle.lastCleanup();
  expect(cleanup.attempt.startingInstanceDigest).toMatch(/^sha256:/);
  expect(cleanup.attempt.spawned).toEqual({ pid: spawned.pid, processDigest: spawned.processDigest, logRef: spawned.logRef });
  expect(cleanup.result).toMatchObject({ kind: "cleaned", identity: "exact", terminated: true });
  expect(await realLifecycle.processPresent(spawned.pid)).toBe(false);
  expect(await realLifecycle.ownedByteSnapshot(home)).toEqual({ config: null, instance: null, readiness: null, secret: null });
}, 120_000);

test("SVC-START-POST-SPAWN-FOREIGN-NOT-KILLED", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  realLifecycle.failNextOwnedWrite({ artifact: "instance", boundary: "before" });
  realLifecycle.replaceSpawnIdentityBeforeCleanup("foreign-digest");
  try {
    await expect(startBackend(backend, home, realLifecycle.globalConfig(port))).rejects.toThrow("INJECTED_INSTANCE_WRITE");
    const spawned = realLifecycle.lastSpawned(), cleanup = realLifecycle.lastCleanup();
    expect(cleanup.result).toMatchObject({ kind: "preserved", identity: "foreign", terminated: false });
    expect(realLifecycle.killPids()).not.toContain(spawned.pid);
    expect(await realLifecycle.processPresent(spawned.pid)).toBe(true);
    expect(await realLifecycle.ownedByteSnapshot(home)).not.toEqual({ config: null, instance: null, readiness: null, secret: null });
    expect(await realLifecycle.diagnoseStartFailure(home)).toMatchObject({ evidence_preserved: true });
  } finally {
    realLifecycle.drainPendingFailureArming();
    await realLifecycle.terminateFixtureProcess(realLifecycle.lastSpawned().pid).catch(() => {});
  }
}, 120_000);

test("SVC-START-POST-SPAWN-INDETERMINATE-PRESERVED", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  realLifecycle.failNextOwnedWrite({ artifact: "instance", boundary: "fsync" });
  realLifecycle.makeSpawnInspectionIndeterminate();
  try {
    await expect(startBackend(backend, home, realLifecycle.globalConfig(port))).rejects.toThrow("INJECTED_INSTANCE_FSYNC");
    const spawned = realLifecycle.lastSpawned(), cleanup = realLifecycle.lastCleanup();
    expect(cleanup.result).toMatchObject({ kind: "preserved", identity: "indeterminate", terminated: false });
    expect(realLifecycle.killPids()).not.toContain(spawned.pid);
    expect(await realLifecycle.processPresent(spawned.pid)).toBe(true);
    expect(await realLifecycle.diagnoseStartFailure(home)).toMatchObject({ evidence_preserved: true });
  } finally {
    realLifecycle.drainPendingFailureArming();
    await realLifecycle.terminateFixtureProcess(realLifecycle.lastSpawned().pid).catch(() => {});
  }
}, 120_000);

test("SVC-START-FAILURE-CLEANUP-INDETERMINATE", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  realLifecycle.failNextHealth({ workerOutcome: "unknown", identityProof: "indeterminate" });
  try {
    await expect(startBackend(backend, home, realLifecycle.globalConfig(port))).rejects.toThrow("START_HEALTH");
    expect(await realLifecycle.privateArtifacts(home)).not.toEqual([]);
    expect(await realLifecycle.diagnoseStartFailure(home)).toMatchObject({ state: expect.stringMatching(/error|stale/), evidence_preserved: true });
  } finally { realLifecycle.drainPendingFailureArming(); }
}, 120_000);

test("SVC-LIFECYCLE-LOCK-TIMEOUT", async () => {
  const home = await realLifecycle.home(), root = stateRoot(home);
  mkdirSync(join(root, "manager.lock"), { recursive: true });
  let simulated = 0;
  const backend = createGlanceServiceManager(home, { now: () => { simulated += 5_000; return simulated; }, sleep: async () => {} });
  try {
    await expect(startBackend(backend, home, realLifecycle.globalConfig(allocateLoopbackPort()))).rejects.toBeInstanceOf(ServiceIoError);
  } finally { rmSync(join(root, "manager.lock"), { recursive: true, force: true }); }
}, 60_000);

test("SVC-LIFECYCLE-LOCK-RELEASE-PRESERVES-REPLACED", async () => {
  const home = await realLifecycle.home(), port = allocateLoopbackPort();
  const started = await startBackend(realLifecycle.backend(), home, realLifecycle.globalConfig(port));
  try {
    expect(started.ok).toBe(true);
    const lockDir = join(stateRoot(home), "manager.lock");
    const inner = realLifecycle.backend();
    const swapped: ManagerBackend = {
      ...inner,
      withLock: (target, operation, fn) => inner.withLock(target, operation, async () => {
        const outcome = await fn();
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir, { recursive: true });
        writeFileSync(join(lockDir, ".owner-token"), Buffer.from([9, 9, 9]));
        return outcome;
      }),
    };
    const stopped = await stopBackend(swapped, home);
    expect(stopped.state).toBe("stopped");
    expect(existsSync(lockDir)).toBe(true);
  } finally { rmSync(join(stateRoot(home), "manager.lock"), { recursive: true, force: true }); }
}, 120_000);

test("SVC-LIFECYCLE-STOP-IDEMPOTENT", async () => {
  const home = await realLifecycle.home();
  const stopped = await realLifecycle.stop(home);
  expect(stopped.state).toBe("stopped");
  expect(stopped.code).toBe("ALREADY_STOPPED");
  expect(realLifecycle.exitCode(stopped)).toBe(0);
}, 60_000);

test("SVC-LIFECYCLE-STOPPED-STATUS", async () => {
  const home = await realLifecycle.home();
  const status = await realLifecycle.status(home);
  expect(status).toMatchObject({ command: "status", ok: false, state: "stopped", code: "NOT_RUNNING" });
  expect(realLifecycle.exitCode(status)).toBe(1);
}, 60_000);

test("SVC-STATEPAIR-CONFIG-ONLY", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend();
  const root = backend.serviceRoot(home);
  const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
  mk(join(root, "control"), { recursive: true });
  wf(join(root, "config.json"), new TextEncoder().encode(`${JSON.stringify(realLifecycle.globalConfig(allocateLoopbackPort()))}\n`));
  expect(await backend.observeStatePair(root)).toEqual({ kind: "partial", configPresent: true, instancePresent: false, changed: false });
  const status = await realLifecycle.status(home);
  expect(status).toMatchObject({ ok: false, state: "stale", code: "STATE_PARTIAL" });
  expect(realLifecycle.exitCode(status)).toBe(3);
  const stopped = await realLifecycle.stop(home);
  expect(stopped).toMatchObject({ state: "stale", code: "STATE_PARTIAL" });
  const started = await startBackend(backend, home, realLifecycle.globalConfig(allocateLoopbackPort()));
  expect(started).toMatchObject({ ok: false, state: "stale", code: "STATE_PARTIAL" });
  expect(existsSync(join(root, "secrets"))).toBe(false);
}, 60_000);

test("SVC-RESTART-RESTORED", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  const started = await startBackend(backend, home, realLifecycle.globalConfig(port));
  try {
    expect(started.ok).toBe(true);
    const replacementPort = allocateLoopbackPort();
    realLifecycle.failNextHealth({ workerOutcome: "exited", identityProof: "absent" });
    const restarted = await realLifecycle.restart(home, realLifecycle.globalConfig(replacementPort));
    expect(restarted.command).toBe("restart");
    expect(restarted.ok).toBe(false);
    expect(restarted.rollback_attempted).toBe(true);
    expect(restarted.rollback_state).toBe("restored_previous");
    const persistedConfig = JSON.parse(new TextDecoder().decode(readFileSync(join(home, ".nirvana", "glance", "service", "config.json")))) as { port?: number };
    expect(persistedConfig.port).toBe(port);
  } finally { await realLifecycle.terminateFixtureProcess(started.pid!).catch(() => {}); }
}, 120_000);

function countStrictReads(backend: ManagerBackend): { wrapped: ManagerBackend; counts: { read: number } } {
  const counts = { read: 0 };
  const wrapped: ManagerBackend = {
    ...backend,
    stateIo: {
      read: (path: string) => { counts.read += 1; return backend.stateIo.read(path); },
      archive: (path: string) => backend.stateIo.archive(path),
    },
  };
  return { wrapped, counts };
}

function fixtureInstance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const instanceId = randomUUID();
  return {
    schema_version: "1.0.0",
    instance_id: instanceId,
    pid: 9999,
    state: "running",
    started_at: new Date().toISOString(),
    config_digest: `sha256:${"1".repeat(64)}`,
    process_digest: `sha256:${"2".repeat(64)}`,
    control_secret_ref: `secrets/${instanceId}.control`,
    control_secret_digest: `sha256:${"3".repeat(64)}`,
    log_ref: "logs/service.log",
    ...overrides,
  };
}

function stateRoot(home: string): string {
  return join(home, ".nirvana", "glance", "service");
}

test("SVC-STATEPAIR-ABSENT", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend();
  const { wrapped, counts } = countStrictReads(backend);
  const status = await statusBackend(wrapped, home);
  expect(status).toMatchObject({ command: "status", ok: false, state: "stopped", code: "NOT_RUNNING" });
  expect(realLifecycle.exitCode(status)).toBe(1);
  const stopped = await stopBackend(wrapped, home);
  expect(stopped).toMatchObject({ command: "stop", ok: true, state: "stopped", code: "ALREADY_STOPPED" });
  expect(realLifecycle.exitCode(stopped)).toBe(0);
  expect(counts.read).toBe(0);
}, 30_000);

test("SVC-STATEPAIR-INSTANCE-ONLY", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), root = stateRoot(home);
  writeDurableJson(join(root, "instance.json"), fixtureInstance());
  expect(await backend.observeStatePair(root)).toEqual({ kind: "partial", configPresent: false, instancePresent: true, changed: false });
  const status = await realLifecycle.status(home);
  expect(status).toMatchObject({ ok: false, state: "stale", code: "STATE_PARTIAL" });
  expect(realLifecycle.exitCode(status)).toBe(3);
  const stopped = await realLifecycle.stop(home);
  expect(stopped).toMatchObject({ state: "stale", code: "STATE_PARTIAL" });
  const started = await startBackend(backend, home, realLifecycle.globalConfig(allocateLoopbackPort()));
  expect(started).toMatchObject({ ok: false, state: "stale", code: "STATE_PARTIAL" });
}, 30_000);

test("SVC-STATEPAIR-INCOMPATIBLE-CONFIG", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), root = stateRoot(home);
  writeDurableJson(join(root, "config.json"), { unexpected: true });
  writeDurableJson(join(root, "instance.json"), fixtureInstance());
  const status = await realLifecycle.status(home);
  expect(status).toMatchObject({ ok: false, state: "stale", code: "STATE_INCOMPATIBLE" });
  expect(realLifecycle.exitCode(status)).toBe(3);
  const stopped = await realLifecycle.stop(home);
  expect(stopped).toMatchObject({ state: "stale", code: "STATE_INCOMPATIBLE" });
  const started = await startBackend(backend, home, realLifecycle.globalConfig(allocateLoopbackPort()));
  expect(started).toMatchObject({ ok: false, state: "stale", code: "STATE_INCOMPATIBLE" });
}, 30_000);

test("SVC-STATEPAIR-INCOMPATIBLE-INSTANCE", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), root = stateRoot(home);
  writeDurableJson(join(root, "config.json"), realLifecycle.globalConfig(allocateLoopbackPort()));
  writeFileSync(join(root, "instance.json"), new TextEncoder().encode("not-json-at-all"));
  const status = await realLifecycle.status(home);
  expect(status).toMatchObject({ ok: false, state: "stale", code: "STATE_INCOMPATIBLE" });
  const restartedStop = await realLifecycle.stop(home);
  expect(restartedStop).toMatchObject({ state: "stale", code: "STATE_INCOMPATIBLE" });
  const started = await startBackend(backend, home, realLifecycle.globalConfig(allocateLoopbackPort()));
  expect(started).toMatchObject({ ok: false, state: "stale", code: "STATE_INCOMPATIBLE" });
}, 30_000);

test("SVC-STATEPAIR-NONREGULAR-FILES", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), root = stateRoot(home);
  writeDurableJson(join(root, "instance.json"), fixtureInstance());
  const externalFile = join(home, "outside-config.json");
  writeFileSync(externalFile, new TextEncoder().encode("{}"));
  let symlinkCreated = true;
  try { symlinkSync(externalFile, join(root, "config.json")); } catch { symlinkCreated = false; }
  if (symlinkCreated) {
    await expect(backend.observeStatePair(root)).rejects.toBeInstanceOf(ServiceIoError);
    await expect(realLifecycle.status(home)).rejects.toBeInstanceOf(ServiceIoError);
    rmSync(join(root, "config.json"), { force: true });
  }
  rmSync(join(root, "instance.json"), { force: true });
  mkdirSync(join(root, "instance.json"));
  await expect(backend.observeStatePair(root)).rejects.toBeInstanceOf(ServiceIoError);
  await expect(realLifecycle.stop(home)).rejects.toBeInstanceOf(ServiceIoError);
  rmSync(join(root, "instance.json"), { recursive: true, force: true });
  if (process.platform === "win32") {
    const junctionTarget = join(home, "junction-target");
    mkdirSync(junctionTarget);
    symlinkSync(junctionTarget, join(root, "config.json"), "junction");
    await expect(backend.observeStatePair(root)).rejects.toBeInstanceOf(ServiceIoError);
  }
}, 30_000);

async function statusAfterMutatingFiles(home: string, mutate: () => void): Promise<GlanceServiceCommandResultV1> {
  const inner = realLifecycle.backend();
  const wrapper: ManagerBackend = {
    ...inner,
    inspectStatus: async input => {
      const result = await inner.inspectStatus(input);
      mutate();
      return result;
    },
  };
  return statusBackend(wrapper, home);
}

test("SVC-STATUS-FULL-INSTANCE-DIGEST", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  const started = await startBackend(backend, home, realLifecycle.globalConfig(port));
  try {
    expect(started.ok).toBe(true);
    const instancePath = join(stateRoot(home), "instance.json");
    const baseline = readFileSync(instancePath);
    const mutations: Array<(instance: Record<string, unknown>) => Record<string, unknown>> = [
      instance => ({ ...instance, pid: (instance.pid as number) + 1 }),
      instance => ({ ...instance, state: "stopping" }),
      instance => ({ ...instance, started_at: new Date(Date.parse(instance.started_at as string) + 1000).toISOString() }),
      instance => ({ ...instance, process_digest: `sha256:${"c".repeat(64)}` }),
      instance => ({ ...instance, control_secret_ref: `secrets/${randomUUID()}.control` }),
      instance => ({ ...instance, control_secret_digest: `sha256:${"d".repeat(64)}` }),
      instance => ({ ...instance, log_ref: "logs/mutated.log" }),
      instance => ({ ...instance, config_digest: `sha256:${"a".repeat(64)}` }),
      instance => ({ ...instance, last_restart: { attempted_at: new Date().toISOString(), requested_config_digest: `sha256:${"b".repeat(64)}`, effective_config_digest: `sha256:${"a".repeat(64)}`, rollback_state: "not_needed" } }),
    ];
    for (const mutate of mutations) {
      const result = await statusAfterMutatingFiles(home, () => {
        const instance = JSON.parse(new TextDecoder().decode(baseline)) as Record<string, unknown>;
        writeDurableJson(instancePath, mutate(instance));
      });
      expect(result).toMatchObject({ ok: false, state: "stale", code: "STATE_CHANGED" });
      expect(realLifecycle.exitCode(result)).toBe(3);
    }
  } finally { await realLifecycle.stop(home); }
}, 180_000);

test("SVC-STATEPAIR-CHANGED", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  const started = await startBackend(backend, home, realLifecycle.globalConfig(port));
  try {
    expect(started.ok).toBe(true);
    const instancePath = join(stateRoot(home), "instance.json");
    const disappeared = await statusAfterMutatingFiles(home, () => { rmSync(instancePath, { force: true }); });
    expect(disappeared).toMatchObject({ ok: false, state: "stale", code: "STATE_CHANGED" });
    expect(realLifecycle.exitCode(disappeared)).toBe(3);
  } finally { await realLifecycle.stop(home); }
}, 120_000);

test("SVC-STATUS-FULL-CONFIG-DIGEST", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  const started = await startBackend(backend, home, realLifecycle.globalConfig(port));
  try {
    expect(started.ok).toBe(true);
    const configPath = join(stateRoot(home), "config.json");
    const baseline = readFileSync(configPath);
    const result = await statusAfterMutatingFiles(home, () => {
      const config = JSON.parse(new TextDecoder().decode(baseline)) as Record<string, unknown>;
      writeDurableJson(configPath, { ...config, port: allocateLoopbackPort() });
    });
    expect(result).toMatchObject({ ok: false, state: "stale", code: "STATE_CHANGED" });
    expect(realLifecycle.exitCode(result)).toBe(3);
    const swapped = await statusAfterMutatingFiles(home, () => {
      const project = mkdtempSync(join(tmpdir(), "glance-status-project-"));
      writeDurableJson(configPath, realLifecycle.projectConfig(allocateLoopbackPort(), project));
    });
    expect(swapped).toMatchObject({ ok: false, state: "stale", code: "STATE_CHANGED" });
  } finally { await realLifecycle.stop(home); }
}, 120_000);

test("SVC-LIFECYCLE-IO", async () => {
  const home = await realLifecycle.home(), root = stateRoot(home);
  writeDurableJson(join(root, "config.json"), realLifecycle.globalConfig(allocateLoopbackPort()));
  mkdirSync(join(root, "instance.json"));
  await expect(realLifecycle.status(home)).rejects.toBeInstanceOf(ServiceIoError);
  await expect(realLifecycle.stop(home)).rejects.toBeInstanceOf(ServiceIoError);
  await expect(startBackend(realLifecycle.backend(), home, realLifecycle.globalConfig(allocateLoopbackPort()))).rejects.toBeInstanceOf(ServiceIoError);
}, 30_000);

test("SVC-START-PROVEN-STALE-RECOVERY", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  const config = realLifecycle.globalConfig(port);
  const first = await startBackend(backend, home, config);
  try {
    expect(first.ok).toBe(true);
    await realLifecycle.terminateExactWorker(first);
    await realLifecycle.proveNoProcessPortOrHealth(first);
    const countersBefore = realLifecycle.counters();
    const second = await startBackend(backend, home, config);
    expect(second.ok).toBe(true);
    expect(second.pid).not.toBe(first.pid);
    expect(realLifecycle.counters().spawn).toBe(countersBefore.spawn + 1);
    expect(await realLifecycle.archivedInstanceIds(home)).toContain(first.instance_id);
    expect((await realLifecycle.persistedInstance(home)).state).toBe("running");
  } finally { await realLifecycle.stop(home); }
}, 120_000);

test("SVC-LIFECYCLE-STALE-ARCHIVE", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  const first = await startBackend(backend, home, realLifecycle.globalConfig(port));
  await realLifecycle.terminateExactWorker(first);
  await realLifecycle.proveNoProcessPortOrHealth(first);
  const second = await startBackend(backend, home, realLifecycle.globalConfig(port));
  try {
    const archived = await realLifecycle.archivedInstanceIds(home);
    expect(archived).toContain(first.instance_id);
    expect(archived).not.toContain(second.instance_id);
    expect(existsSync(join(stateRoot(home), "control", "archive"))).toBe(true);
  } finally { await realLifecycle.stop(home); }
}, 120_000);

test("SVC-LIFECYCLE-CONFLICT", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  const started = await startBackend(backend, home, realLifecycle.globalConfig(port));
  try {
    const conflict = await startBackend(backend, home, realLifecycle.projectConfig(allocateLoopbackPort(), await realLifecycle.project()));
    expect(conflict).toMatchObject({ ok: false, state: "conflict", code: "CONFIG_CONFLICT" });
    expect(realLifecycle.exitCode(conflict)).toBe(4);
    expect((await realLifecycle.persistedInstance(home)).state).toBe("running");
  } finally { await realLifecycle.stop(home); }
}, 120_000);

test("SVC-LIFECYCLE-CRASH", async () => {
  const home = await realLifecycle.home(), port = allocateLoopbackPort();
  const started = await startBackend(realLifecycle.backend(), home, realLifecycle.globalConfig(port));
  try {
    expect(started.ok).toBe(true);
    await realLifecycle.terminateExactWorker(started);
    await realLifecycle.proveNoProcessPortOrHealth(started);
    const status = await realLifecycle.status(home);
    expect(status).toMatchObject({ ok: false, state: "stale", code: "PROCESS_ABSENT" });
    expect(realLifecycle.exitCode(status)).toBe(3);
    expect(existsSync(join(stateRoot(home), "instance.json"))).toBe(true);
  } finally { rmSync(stateRoot(home), { recursive: true, force: true }); }
}, 120_000);

test("SVC-LIFECYCLE-FOREIGN", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  const started = await startBackend(backend, home, realLifecycle.globalConfig(port));
  try {
    expect(started.ok).toBe(true);
    const spawnBefore = realLifecycle.counters().spawn;
    await realLifecycle.terminateExactWorker(started);
    await realLifecycle.proveNoProcessPortOrHealth(started);
    const foreign = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("probe") });
    try {
      const bytesBefore = await realLifecycle.ownedByteSnapshot(home);
      const result = await startBackend(backend, home, realLifecycle.globalConfig(port));
      expect(result).toMatchObject({ ok: false, state: "stale", code: "PROCESS_ABSENT_PORT_HELD" });
      expect(realLifecycle.counters().spawn).toBe(spawnBefore);
      expect(await realLifecycle.ownedByteSnapshot(home)).toEqual(bytesBefore);
    } finally { foreign.stop(true); }
  } finally { await realLifecycle.stop(home); }
}, 120_000);

test("SVC-LIFECYCLE-IDEMPOTENT", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  const config = realLifecycle.globalConfig(port);
  const first = await startBackend(backend, home, config);
  try {
    const spawnBefore = realLifecycle.counters().spawn;
    const second = await startBackend(backend, home, config);
    expect(second).toMatchObject({ ok: true, state: "running", pid: first.pid, instance_id: first.instance_id });
    expect(realLifecycle.counters().spawn).toBe(spawnBefore);
  } finally { await realLifecycle.stop(home); }
}, 120_000);

test("SVC-LIFECYCLE-START", async () => {
  const home = await realLifecycle.home(), port = allocateLoopbackPort();
  const started = await startBackend(realLifecycle.backend(), home, realLifecycle.globalConfig(port));
  try {
    expect(started).toMatchObject({ ok: true, state: "running", scope: "global", port, url: `http://127.0.0.1:${port}` });
    expect(started.pid).toBeGreaterThan(0);
    expect(realLifecycle.lockOperations()).toContain("start");
    expect((await realLifecycle.persistedInstance(home)).state).toBe("running");
  } finally { await realLifecycle.stop(home); }
}, 120_000);

test("SVC-LIFECYCLE-STATUS", async () => {
  const home = await realLifecycle.home(), port = allocateLoopbackPort();
  const started = await startBackend(realLifecycle.backend(), home, realLifecycle.globalConfig(port));
  try {
    const running = await realLifecycle.status(home);
    expect(running).toMatchObject({ ok: true, state: "running", instance_id: started.instance_id, port, uptime_seconds: expect.any(Number) });
    expect(realLifecycle.lockOperations()).not.toContain("status");
  } finally { await realLifecycle.stop(home); }
}, 120_000);

test("SVC-LIFECYCLE-STOP", async () => {
  const home = await realLifecycle.home(), port = allocateLoopbackPort();
  const started = await startBackend(realLifecycle.backend(), home, realLifecycle.globalConfig(port));
  expect(started.ok).toBe(true);
  const stopped = await realLifecycle.stop(home);
  expect(stopped).toMatchObject({ ok: true, state: "stopped", code: "AUTHENTICATED_STOP", instance_id: started.instance_id });
  expect(await realLifecycle.privateArtifacts(home)).toEqual([]);
}, 120_000);

test("SVC-START-CLEANUP-PRESERVES-UNMATCHED-EVIDENCE", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), root = stateRoot(home), port = allocateLoopbackPort();
  const configBytes = realLifecycle.globalConfig(port);
  writeDurableJson(join(root, "config.json"), configBytes);
  const foreignInstance = fixtureInstance();
  writeDurableJson(join(root, "instance.json"), foreignInstance);
  const attemptSecretRef = `secrets/${randomUUID()}.control`;
  writePrivateBytes(join(root, ...attemptSecretRef.split("/")), randomBytes(32));
  const otherStartupId = randomUUID();
  writeDurableJson(join(root, "control", "startup", `${otherStartupId}.ready.json`), { schema_version: "1.0.0", startup_id: otherStartupId, instance_id: foreignInstance.instance_id as string, instance_digest: `sha256:${"f".repeat(64)}` });
  const doomed = Bun.spawn([process.execPath, "-e", ""]);
  await doomed.exited;
  const attempt = {
    instanceId: randomUUID(),
    startupId: randomUUID(),
    secretRef: attemptSecretRef,
    configDigest: `sha256:${"9".repeat(64)}`,
    secretDigest: `sha256:${"8".repeat(64)}`,
    phase: "spawned" as const,
    spawned: { pid: doomed.pid, processDigest: `sha256:${"7".repeat(64)}` as const, logRef: "logs/foreign.log" },
    startingInstanceDigest: `sha256:${"6".repeat(64)}` as const,
  };
  const cleanup = await backend.cleanupFailedStart({ root, attempt, error: new Error("SYNTHETIC") });
  expect(cleanup.kind).toBe("cleaned");
  expect(JSON.parse(new TextDecoder().decode(readFileSync(join(root, "instance.json"))))).toEqual(foreignInstance);
  expect(JSON.parse(new TextDecoder().decode(readFileSync(join(root, "config.json"))))).toEqual(configBytes);
  expect(existsSync(join(root, ...attemptSecretRef.split("/")))).toBe(true);
  expect(existsSync(join(root, "control", "startup", `${otherStartupId}.ready.json`))).toBe(true);
}, 30_000);

test("SVC-RESTART-INVALID-BEFORE-STOP", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  const started = await startBackend(backend, home, realLifecycle.globalConfig(port));
  try {
    expect(started.ok).toBe(true);
    const operationsBefore = realLifecycle.lockOperations().length;
    await expect(restartBackend(backend, home, realLifecycle.globalConfig(80))).rejects.toThrow();
    expect(realLifecycle.lockOperations().length).toBe(operationsBefore);
    expect((await realLifecycle.persistedInstance(home)).state).toBe("running");
    expect(await fetchServiceHealth(port)).toMatchObject({ mode: "service" });
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
    try {
      const spawnsBeforeInfeasible = realLifecycle.counters().spawn;
      const infeasible = await restartBackend(backend, home, realLifecycle.globalConfig(blocker.port));
      expect(infeasible).toMatchObject({ ok: false, state: "conflict", code: "PORT_BUSY" });
      expect(realLifecycle.exitCode(infeasible)).toBe(4);
      expect(realLifecycle.counters().spawn).toBe(spawnsBeforeInfeasible);
      expect((await realLifecycle.persistedInstance(home)).state).toBe("running");
      expect(await fetchServiceHealth(port)).toMatchObject({ mode: "service" });
    } finally { blocker.stop(true); }
  } finally { await realLifecycle.stop(home); }
}, 120_000);

test("SVC-RESTART-PRESERVE", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  const first = await startBackend(backend, home, realLifecycle.globalConfig(port));
  try {
    expect(first.ok).toBe(true);
    const configBytesBefore = readFileSync(join(stateRoot(home), "config.json"));
    const spawnBefore = realLifecycle.counters().spawn;
    const restarted = await realLifecycle.restart(home, undefined);
    expect(restarted).toMatchObject({ ok: true, state: "running", rollback_attempted: false, rollback_state: "not_needed" });
    expect(restarted.instance_id).not.toBe(first.instance_id);
    expect(restarted.effective_config_digest).toBe(first.effective_config_digest);
    expect(readFileSync(join(stateRoot(home), "config.json")).equals(configBytesBefore)).toBe(true);
    expect(realLifecycle.counters().spawn).toBe(spawnBefore + 1);
  } finally { await realLifecycle.stop(home); }
}, 120_000);

test("SVC-RESTART-STALE-RECOVERY", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  const first = await startBackend(backend, home, realLifecycle.globalConfig(port));
  expect(first.ok).toBe(true);
  await realLifecycle.terminateExactWorker(first);
  await realLifecycle.proveNoProcessPortOrHealth(first);
  const restarted = await realLifecycle.restart(home, undefined);
  try {
    expect(restarted).toMatchObject({ ok: true, state: "running" });
    expect(restarted.instance_id).not.toBe(first.instance_id);
    expect(await realLifecycle.archivedInstanceIds(home)).toContain(first.instance_id);
  } finally { await realLifecycle.stop(home); }
}, 120_000);

test("SVC-RESTART-RESTORE-FAILED", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  const started = await startBackend(backend, home, realLifecycle.globalConfig(port));
  try {
    expect(started.ok).toBe(true);
    realLifecycle.failNextHealth({ workerOutcome: "exited", identityProof: "absent" });
    realLifecycle.failNextOwnedWrite({ artifact: "config", boundary: "before" });
    realLifecycle.failNextOwnedWrite({ artifact: "config", boundary: "before" });
    const restarted = await realLifecycle.restart(home, realLifecycle.globalConfig(allocateLoopbackPort()));
    expect(restarted).toMatchObject({ ok: false, rollback_attempted: true, rollback_state: "restore_failed" });
    expect(existsSync(join(stateRoot(home), "config.json"))).toBe(false);
  } finally { realLifecycle.drainPendingFailureArming(); await realLifecycle.stop(home).catch(() => {}); }
}, 120_000);

test("SVC-RESTART-STOP-FAILED", async () => {
  const home = await realLifecycle.home(), backend = realLifecycle.backend(), port = allocateLoopbackPort();
  const started = await startBackend(backend, home, realLifecycle.globalConfig(port));
  try {
    expect(started.ok).toBe(true);
    realLifecycle.queueStopDeliveryFailure();
    const spawnBefore = realLifecycle.counters().spawn;
    const restarted = await realLifecycle.restart(home, realLifecycle.globalConfig(allocateLoopbackPort()));
    expect(restarted).toMatchObject({ ok: false, code: "RESTART_STOP_FAILED" });
    expect(realLifecycle.counters().spawn).toBe(spawnBefore);
    expect((await realLifecycle.persistedInstance(home)).state).toBe("running");
    expect(await fetchServiceHealth(port)).toMatchObject({ mode: "service" });
  } finally { await realLifecycle.stop(home); }
}, 120_000);

export const LIFECYCLE_CASES = ["SVC-LIFECYCLE-CONFLICT", "SVC-LIFECYCLE-CRASH", "SVC-LIFECYCLE-FOREIGN", "SVC-LIFECYCLE-IDEMPOTENT", "SVC-LIFECYCLE-IO", "SVC-LIFECYCLE-STALE-ARCHIVE", "SVC-LIFECYCLE-START", "SVC-LIFECYCLE-STATUS", "SVC-LIFECYCLE-STOP", "SVC-LIFECYCLE-STOP-IDEMPOTENT", "SVC-LIFECYCLE-STOPPED-STATUS", "SVC-STATEPAIR-ABSENT", "SVC-STATEPAIR-CONFIG-ONLY", "SVC-STATEPAIR-INSTANCE-ONLY", "SVC-STATEPAIR-CHANGED", "SVC-STATUS-FULL-CONFIG-DIGEST", "SVC-STATUS-FULL-INSTANCE-DIGEST", "SVC-STARTUP-WORKER-FASTER-THAN-MANAGER", "SVC-STARTUP-READY-TIMEOUT", "SVC-STARTUP-READY-DIGEST", "SVC-RESTART-INVALID-BEFORE-STOP", "SVC-RESTART-PRESERVE", "SVC-RESTART-RESTORE-FAILED", "SVC-RESTART-RESTORED", "SVC-RESTART-STOP-FAILED"] as const;
