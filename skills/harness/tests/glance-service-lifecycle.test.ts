import { expect, test } from "bun:test";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopMacInput } from "../lib/glance/service/control.ts";
import { drainServer } from "../lib/glance/service/request-drain.ts";
import { resolveServiceRef } from "../lib/glance/service/paths.ts";
import { validateInstance } from "../lib/glance/service/schema-validator.ts";
import { parseStrictJson } from "../lib/glance/service/strict-json.ts";
import { digestJcs, writeDurableJson, writePrivateBytes } from "../lib/glance/service/state.ts";
import { createStartupReadiness, createStopControl, runServiceWorker } from "../scripts/glance-service-worker.ts";

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
      try {
        if (digestJcs(parseStrictJson(readFileSync(instancePath))) !== digestJcs(instance)) return;
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
