import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalWorkerArgv, classifyExistingService, createBunProcessAdapter, extractWorkerIdentityFromArgv } from "../lib/glance/service/adapters.ts";

const WORKER_ENTRYPOINT = join("skills", "harness", "scripts", "glance-service-worker.ts");
const SERVICE_ROOT = join(tmpdir(), "svc-root");
const STARTUP_ID = "00000000-0000-4000-8000-000000000001";
const PROCESS_DIGEST = `sha256:${createHash("sha256").update(new TextEncoder().encode("worker-bytes")).digest("hex")}`;

const baseEvidence = () => ({
  expected: {
    instanceId: "123e4567-e89b-12d3-a456-426614174000",
    effectiveConfigDigest: `sha256:${"c".repeat(64)}`,
    engineVersion: "0.7.11",
    workerEntrypoint: WORKER_ENTRYPOINT,
    expectedServiceRoot: SERVICE_ROOT,
    recordedProcessDigest: PROCESS_DIGEST,
    startupId: STARTUP_ID,
    currentProcessDigest: PROCESS_DIGEST,
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

test("SVC-PROCESS-DIGEST", async () => {
  const { processDigestFromEntrypointBytes, startupIdFromLogRef } = await import("../lib/glance/service/adapters.ts") as typeof import("../lib/glance/service/adapters.ts");
  expect(typeof processDigestFromEntrypointBytes).toBe("function");
  expect(typeof startupIdFromLogRef).toBe("function");
  const bytes = new TextEncoder().encode("raw worker entrypoint bytes");
  const expected = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
  expect(processDigestFromEntrypointBytes(bytes)).toBe(expected);
  expect(processDigestFromEntrypointBytes(new TextEncoder().encode("other bytes"))).not.toBe(expected);
  expect(extractWorkerIdentityFromArgv(canonicalWorkerArgv(WORKER_ENTRYPOINT, SERVICE_ROOT, STARTUP_ID))).toEqual({
    entrypoint: WORKER_ENTRYPOINT,
    serviceRoot: SERVICE_ROOT,
    startupId: STARTUP_ID,
  });
  expect(extractWorkerIdentityFromArgv(["bun", "worker.ts"])).toBeNull();
  expect(startupIdFromLogRef(`logs/${STARTUP_ID}.log`)).toBe(STARTUP_ID);
  expect(startupIdFromLogRef("logs/not-a-uuid.log")).toBeNull();
  expect(startupIdFromLogRef("logs/00000000-0000-4000-8000-00000000000A.log")).toBeNull();
  expect(startupIdFromLogRef("logs/00000000-0000-5000-8000-000000000001.log")).toBeNull();
  expect(startupIdFromLogRef("logs/00000000-0000-4000-8000-000000000001")).toBeNull();
  expect(startupIdFromLogRef("logs/../x.log")).toBeNull();
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

test("SVC-IDENTITY-ENGINE-UPDATE-DRIFT", () => {
  const evidence = baseEvidence();
  evidence.health.engine_version = "0.7.10";
  expect(classifyExistingService(evidence)).toMatchObject({ kind: "drift", restartRequired: true });
});

test("SVC-IDENTITY-ENGINE-VERSION-PRECEDENCE", () => {
  const evidence = baseEvidence();
  evidence.health.instance_id = "123e4567-e89b-12d3-a456-426614174001";
  evidence.health.engine_version = "0.7.10";
  expect(classifyExistingService(evidence)).toMatchObject({ kind: "conflict", code: "INSTANCE_CONFLICT" });
});

test("SVC-IDENTITY-BYTES-DRIFT", () => {
  const evidence = baseEvidence();
  evidence.expected.currentProcessDigest = `sha256:${"7".repeat(64)}`;
  expect(classifyExistingService(evidence)).toMatchObject({ kind: "drift", restartRequired: true });
});

test("SVC-IDENTITY-DIGEST-UNAVAILABLE", () => {
  const unavailable = baseEvidence();
  (unavailable.expected as { currentProcessDigest?: string }).currentProcessDigest = undefined;
  expect(classifyExistingService(unavailable)).toMatchObject({ kind: "indeterminate", code: "PROCESS_DIGEST_UNAVAILABLE" });
  const withWrongEngine = baseEvidence();
  (withWrongEngine.expected as { currentProcessDigest?: string }).currentProcessDigest = undefined;
  withWrongEngine.health.engine_version = "0.7.10";
  expect(classifyExistingService(withWrongEngine)).toMatchObject({ kind: "drift", restartRequired: true });
  const withChangedPath = baseEvidence();
  (withChangedPath.expected as { currentProcessDigest?: string }).currentProcessDigest = undefined;
  withChangedPath.process = { ...withChangedPath.process, argv: canonicalWorkerArgv(join("other", "worker.ts"), SERVICE_ROOT, STARTUP_ID) };
  expect(classifyExistingService(withChangedPath)).toMatchObject({ kind: "drift", restartRequired: true });
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

test("SVC-IDENTITY-STARTUP-MISMATCH", () => {
  const evidence = baseEvidence();
  evidence.process = { ...evidence.process, argv: canonicalWorkerArgv(WORKER_ENTRYPOINT, SERVICE_ROOT, "99999999-9999-4999-8999-999999999999") };
  expect(classifyExistingService(evidence)).toMatchObject({ kind: "conflict", code: "PROCESS_CONFLICT" });
});

test("SVC-IDENTITY-STARTUP-BEFORE-ROOT", () => {
  const evidence = baseEvidence();
  evidence.process = { ...evidence.process, argv: canonicalWorkerArgv(WORKER_ENTRYPOINT, join(tmpdir(), "elsewhere"), "99999999-9999-4999-8999-999999999999") };
  expect(classifyExistingService(evidence)).toMatchObject({ kind: "conflict", code: "PROCESS_CONFLICT" });
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

export const IDENTITY_CASES = ["SVC-PROCESS-REAL-UNICODE-SPACES", "SVC-PROCESS-DIGEST", "SVC-IDENTITY-BYTES-DRIFT", "SVC-IDENTITY-DIGEST-UNAVAILABLE", "SVC-IDENTITY-ENTRYPOINT-DRIFT", "SVC-IDENTITY-ENGINE-UPDATE-DRIFT", "SVC-IDENTITY-ENGINE-VERSION-PRECEDENCE", "SVC-IDENTITY-FOREIGN-PORT", "SVC-IDENTITY-HEALTH-MISSING", "SVC-IDENTITY-MATCH", "SVC-IDENTITY-PID-MISSING", "SVC-IDENTITY-STARTUP-BEFORE-ROOT", "SVC-IDENTITY-STARTUP-MISMATCH", "SVC-IDENTITY-WRONG-CONFIG", "SVC-IDENTITY-WRONG-INSTANCE", "SVC-IDENTITY-WRONG-ROOT", "SVC-STATUS-PROCESS-DRIFT"] as const;
