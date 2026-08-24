import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeJcs } from "../lib/glance/service/canonicalize.ts";
import { canonicalWorkerArgv, classifyExistingService, createBunProcessAdapter, extractWorkerIdentityFromArgv, processDigestFromIdentity } from "../lib/glance/service/adapters.ts";

const WORKER_ENTRYPOINT = join("skills", "harness", "scripts", "glance-service-worker.ts");
const SERVICE_ROOT = join(tmpdir(), "svc-root");
const STARTUP_ID = "00000000-0000-4000-8000-000000000001";
const PROCESS_DIGEST = processDigestFromIdentity({ entrypoint: WORKER_ENTRYPOINT, serviceRoot: SERVICE_ROOT, startupId: STARTUP_ID });

const baseEvidence = () => ({
  expected: {
    instanceId: "123e4567-e89b-12d3-a456-426614174000",
    effectiveConfigDigest: `sha256:${"c".repeat(64)}`,
    engineVersion: "0.7.11",
    workerEntrypoint: WORKER_ENTRYPOINT,
    expectedServiceRoot: SERVICE_ROOT,
    recordedProcessDigest: PROCESS_DIGEST,
  },
  process: { exists: true, entrypoint: process.execPath, argv: canonicalWorkerArgv(WORKER_ENTRYPOINT, SERVICE_ROOT, STARTUP_ID) },
  portOwnedByListener: true,
  health: {
    schema_version: "1.0.0",
    mode: "service",
    instance_id: "123e4567-e89b-12d3-a456-426614174000",
    port: 3737,
    scope: "global",
    lifetime: "persistent",
    allow_actions: false,
    engine_version: "0.7.11",
    uptime_seconds: 12,
    effective_config_digest: `sha256:${"c".repeat(64)}`,
    process_digest: PROCESS_DIGEST,
    extension_root_digest: `sha256:${"e".repeat(64)}`,
    read_only: true,
    persistent: true,
  } as Record<string, unknown>,
});

test("SVC-ADAPTER-CANONICAL-WORKER-ARGV", () => {
  expect(canonicalWorkerArgv("/path/worker.ts", "/srv/root", "startup-id")).toEqual([
    process.execPath,
    "/path/worker.ts",
    "--service-root",
    "/srv/root",
    "--config-ref",
    "config.json",
    "--instance-ref",
    "instance.json",
    "--startup-id",
    "startup-id",
  ]);
});

test("SVC-PROCESS-REAL-UNICODE-SPACES", async () => {
  const root = mkdtempSync(join(tmpdir(), "glance-adapter-"));
  const unicodeRoot = join(root, "çedo serviço", "root com espaços");
  const logPath = join(root, "logs", "serviço de log.log");
  try {
    const adapter = createBunProcessAdapter();
    const spawned = adapter.spawn([process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1))); setTimeout(() => {}, 4000)", unicodeRoot, "--startup-id", "id com espaço ç"], {}, logPath);
    expect(spawned.pid).toBeGreaterThan(0);
    const deadline = Date.now() + 10_000;
    let echoed = "";
    while (Date.now() < deadline) {
      try { echoed = readFileSync(logPath, "utf8").trim(); if (echoed) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(JSON.parse(echoed)).toEqual([unicodeRoot, "--startup-id", "id com espaço ç"]);
    const inspected = await adapter.inspect(spawned.pid);
    expect(inspected.exists).toBe(true);
    expect(inspected.entrypoint).toBeTruthy();
    expect(await adapter.inspect(999_999_999)).toEqual({ exists: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("SVC-PROCESS-DIGEST", () => {
  const identity = { entrypoint: WORKER_ENTRYPOINT, serviceRoot: SERVICE_ROOT, startupId: STARTUP_ID };
  expect(processDigestFromIdentity(identity)).toBe(`sha256:${new Bun.CryptoHasher("sha256").update(canonicalizeJcs(identity)).digest("hex")}`);
  expect(processDigestFromIdentity({ ...identity, serviceRoot: "/srv/other" })).not.toBe(processDigestFromIdentity(identity));
  expect(extractWorkerIdentityFromArgv(canonicalWorkerArgv(WORKER_ENTRYPOINT, SERVICE_ROOT, STARTUP_ID))).toEqual({
    entrypoint: WORKER_ENTRYPOINT,
    serviceRoot: SERVICE_ROOT,
    startupId: STARTUP_ID,
  });
  expect(extractWorkerIdentityFromArgv(["bun", "worker.ts"])).toBeNull();
});

test("SVC-IDENTITY-MATCH", () => {
  expect(classifyExistingService(baseEvidence())).toMatchObject({ kind: "match", restartRequired: false });
});

test("SVC-IDENTITY-PID-MISSING", () => {
  const evidence = baseEvidence();
  evidence.process = { exists: false };
  expect(classifyExistingService(evidence)).toMatchObject({ kind: "stale", processAbsent: true });
});

test("SVC-IDENTITY-HEALTH-MISSING", () => {
  const evidence = baseEvidence();
  evidence.health = undefined;
  expect(classifyExistingService(evidence)).toMatchObject({ kind: "indeterminate", code: "HEALTH_UNAVAILABLE" });
});

test("SVC-IDENTITY-FOREIGN-PORT", () => {
  const evidence = baseEvidence();
  evidence.health.mode = "cockpit";
  expect(classifyExistingService(evidence)).toMatchObject({ kind: "conflict", code: "FOREIGN_LISTENER" });
});

test("SVC-IDENTITY-WRONG-INSTANCE", () => {
  const evidence = baseEvidence();
  evidence.health.instance_id = "123e4567-e89b-12d3-a456-426614174001";
  expect(classifyExistingService(evidence)).toMatchObject({ kind: "conflict", code: "INSTANCE_CONFLICT" });
});

test("SVC-IDENTITY-WRONG-CONFIG", () => {
  const evidence = baseEvidence();
  evidence.health.effective_config_digest = `sha256:${"9".repeat(64)}`;
  expect(classifyExistingService(evidence)).toMatchObject({ kind: "conflict", code: "CONFIG_CONFLICT" });
});

test("SVC-IDENTITY-WRONG-ENGINE-VERSION", () => {
  const evidence = baseEvidence();
  evidence.health.engine_version = "0.7.10";
  expect(classifyExistingService(evidence)).toMatchObject({ kind: "conflict", code: "ENGINE_CONFLICT" });
});

test("SVC-IDENTITY-ENTRYPOINT-DRIFT", () => {
  const evidence = baseEvidence();
  evidence.process = { ...evidence.process, argv: canonicalWorkerArgv(join("other", "worker.ts"), SERVICE_ROOT, STARTUP_ID) };
  expect(classifyExistingService(evidence)).toMatchObject({ kind: "drift", restartRequired: true });
});

test("SVC-IDENTITY-WRONG-ROOT", () => {
  const evidence = baseEvidence();
  evidence.process = { ...evidence.process, argv: canonicalWorkerArgv(WORKER_ENTRYPOINT, join(tmpdir(), "elsewhere"), STARTUP_ID) };
  expect(classifyExistingService(evidence)).toMatchObject({ kind: "conflict", code: "ROOT_CONFLICT" });
});

test("SVC-IDENTITY-WRONG-PROCESS", () => {
  const evidence = baseEvidence();
  evidence.health.process_digest = PROCESS_DIGEST;
  evidence.expected.recordedProcessDigest = `sha256:${"8".repeat(64)}`;
  expect(classifyExistingService(evidence)).toMatchObject({ kind: "drift", restartRequired: true });
});

test("SVC-STATUS-PROCESS-DRIFT", () => {
  const evidence = baseEvidence();
  evidence.health.process_digest = `sha256:${"8".repeat(64)}`;
  expect(classifyExistingService(evidence)).toMatchObject({ kind: "conflict", code: "PROCESS_CONFLICT" });
});

test("SVC-ADAPTER-SPAWN-LIFECYCLE", async () => {
  const root = mkdtempSync(join(tmpdir(), "glance-adapter-"));
  try {
    const adapter = createBunProcessAdapter();
    const logPath = join(root, "probe.log");
    const spawned = adapter.spawn([process.execPath, "-e", "setTimeout(() => process.exit(0), 50)"], {}, logPath);
    expect(typeof spawned.unref).toBe("function");
    spawned.unref();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await adapter.inspect(spawned.pid)).exists) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect((await adapter.inspect(spawned.pid)).exists).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

export const IDENTITY_CASES = ["SVC-PROCESS-REAL-UNICODE-SPACES", "SVC-PROCESS-DIGEST", "SVC-IDENTITY-ENTRYPOINT-DRIFT", "SVC-IDENTITY-FOREIGN-PORT", "SVC-IDENTITY-HEALTH-MISSING", "SVC-IDENTITY-MATCH", "SVC-IDENTITY-PID-MISSING", "SVC-IDENTITY-WRONG-CONFIG", "SVC-IDENTITY-WRONG-ENGINE-VERSION", "SVC-IDENTITY-WRONG-INSTANCE", "SVC-IDENTITY-WRONG-PROCESS", "SVC-IDENTITY-WRONG-ROOT", "SVC-STATUS-PROCESS-DRIFT"] as const;
