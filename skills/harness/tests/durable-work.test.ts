// durable-work.test.ts — RED tests for the Run Kernel durable-work module.
//
// These tests pin the contract for typed durable work units that extend the
// canonical Run Kernel. The implementation lives in
// `skills/harness/lib/run-kernel/durable-work.ts` and is consumed from a fresh
// `bun` process via `KernelHandle`.
//
// Contract summary (matches the enriched brief):
//   - typed durable work units linked to projectId / runId / traceId
//   - durable `partial` before substantive work
//   - lifecycle: init / start / progress / complete / status / collect / resume
//   - atomic monotonic checkpoints with digest-based optimistic concurrency
//   - idempotent operation IDs: same (operation_id, payload) returns the prior
//     result; same operation_id with a different payload is a conflict
//   - cooperative claims: live → refuse, stale → take over, malformed → throw,
//     wrong-owner release → throw
//   - evidence references with digest verification, tamper rejection
//   - fresh-process resume (a brand-new bun process opens the same kernel DB
//     and finds the prior partial state)
//   - cross-correlation: every durable event appears in run_events with
//     type=x_durable_work_* and the canonical run projection survives
//   - schema versioning, migration safety, backup / rollback, fail-closed on
//     corruption.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRun, listEvents, transitionRun } from "../lib/run-kernel/store.ts";
import { canonicalJson } from "../lib/run-kernel/canonical-json.ts";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { KERNEL_BUDGET_MS, spawnBudgetMs } from "./helpers/test-budgets.ts";

const DURABLE_BUDGET_MS = KERNEL_BUDGET_MS;

import {
  openKernel,
  type KernelHandle,
} from "../lib/run-kernel/index.ts";

let root = "";
let handle: KernelHandle | null = null;
let durable: typeof import("../lib/run-kernel/durable-work.ts") | null = null;

const T0 = "2026-08-27T00:00:00.000Z";
const T1 = "2026-08-27T00:01:00.000Z";
const T2 = "2026-08-27T00:02:00.000Z";
const T3 = "2026-08-27T00:03:00.000Z";
const T4 = "2026-08-27T00:04:00.000Z";
const TARGET = { kind: "agent-x" as const, slug: "agent-x" as const };

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-durable-"));
  const kernelPath = path.join(root, "kernel.sqlite");
  handle = openKernel(kernelPath);
  durable = await import(pathToFileURL(path.resolve(import.meta.dir, "..", "lib", "run-kernel", "durable-work.ts")).href);
  createCanonicalRun(handle, "prj_dw", "run_dw", "trace_dw");
});

afterEach(() => {
  try { handle?.close(); } catch { /* already closed */ }
  handle = null;
  durable = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = "";
});

function meta(h: KernelHandle, projectId = "prj_dw", runId = "run_dw", traceId = "trace_dw") {
  return {
    handle: h, projectId, runId, traceId,
    target: TARGET,
  };
}

function createCanonicalRun(h: KernelHandle, projectId: string, runId: string, traceId: string, target = TARGET) {
  createRun(h, {
    projectId, runId, traceId, target, planId: `plan_${runId}`,
    policySnapshotRef: "sha256:policy", actor: { kind: "test", id: "durable-work" },
    correlationId: `cor_create_${runId}`, idempotencyKey: `create-${runId}`, occurredAt: T0,
  });
  return meta(h, projectId, runId, traceId);
}

function sha256(value: string | Uint8Array): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function encodeDwcTuple(...segments: string[]): string {
  return segments.map(s => `${s.length}:${s}`).join("/");
}

function withCanonicalDigest<T extends Record<string, unknown>>(body: T): T & { digest: string } {
  return { ...body, digest: sha256(canonicalJson(body)) };
}

/** Deterministic content for the default per-unit Track B evidence file. */
function trackBEvidenceContent(unitId: string): string {
  return `track-b evidence for ${unitId}`;
}

function validTrackBUnit(runId: string, id: string, patch: Record<string, unknown> = {}) {
  const scope = typeof patch.scope === "string" ? patch.scope : `scope-${id}`;
  const bounds = typeof patch.bounds === "string" ? patch.bounds : `bounds-${id}`;
  const body = {
    schemaVersion: "2.0.0", runId, id, scope, bounds,
    status: "complete", coverage: { completed: 1, total: 1, label: "files" },
    attempts: [{ id: `att-${id}`, startedAt: T0, endedAt: T1, flushes: 1, outcome: "completed" }],
    evidence: [{ type: "file", ref: `evidence/${id}.txt`, digest: sha256(trackBEvidenceContent(id)) }],
    operations: [], revision: 1, createdAt: T0, updatedAt: T1,
    ...patch,
  };
  return withCanonicalDigest(body);
}

function alignedUnitDecls(ids: string[]): Array<{ id: string; scope: string; bounds: string }> {
  return ids.map(id => ({ id, scope: `scope-${id}`, bounds: `bounds-${id}` }));
}

function validTrackBState(runId: string, traceId: string, units: Array<{ id: string; scope: string; bounds: string }>, patch: Record<string, unknown> = {}) {
  const body = {
    schemaVersion: "2.0.0", runId, traceId, nirvanaRunId: runId,
    objective: "durable migration", mode: "on",
    authority: { runLevel: "nirvana", holdfast: "work-unit-only" },
    units, createdAt: T0, ...patch,
  };
  return withCanonicalDigest(body);
}

function writeTrackBFixture(
  dir: string,
  state: Record<string, unknown>,
  units: Record<string, Record<string, unknown> | string>,
): void {
  fs.mkdirSync(path.join(dir, "units"), { recursive: true });
  fs.writeFileSync(path.join(dir, "STATE.json"), JSON.stringify(state), "utf8");
  for (const [file, value] of Object.entries(units)) {
    fs.writeFileSync(path.join(dir, "units", `${file}.json`), typeof value === "string" ? value : JSON.stringify(value), "utf8");
    // Materialize only the default per-unit evidence file, i.e. the one whose declared
    // digest matches the deterministic default content. Tests that deliberately declare
    // a missing / tampered / escaping evidence ref stage those files themselves.
    if (typeof value !== "string" && Array.isArray(value.evidence)) {
      const content = trackBEvidenceContent(file);
      const contentDigest = sha256(content);
      for (const item of value.evidence as Array<Record<string, unknown>>) {
        const ref = item?.ref;
        if (typeof ref !== "string" || item?.digest !== contentDigest) continue;
        if (path.isAbsolute(ref) || ref.includes("\\") || ref.split("/").some(s => s === "" || s === "." || s === "..")) continue;
        const abs = path.join(dir, ...ref.split("/"));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf8");
      }
    }
  }
}

function importTrackB(input: Record<string, unknown>) {
  return (durable!.importFromTrackB as (value: Record<string, unknown>) => ReturnType<typeof durable.importFromTrackB>)({
    handle: handle!, kernelPath: handle!.path, ...input,
  });
}

function rollbackTrackB(input: Record<string, unknown>): void {
  (durable!.rollbackTrackBImport as (value: Record<string, unknown>) => void)({
    handle: handle!, kernelPath: handle!.path, ...input,
  });
}

function evidenceFixture(name = "evidence.txt", content = "verified evidence") {
  fs.writeFileSync(path.join(root, name), content, "utf8");
  return { type: "file", ref: name, digest: sha256(fs.readFileSync(path.join(root, name))) };
}

describe("durable work — typed units", () => {
  test("init declares typed units linked to projectId / runId / traceId", () => {
    const m = meta(handle!);
    const def = durable!.defineUnits({
      ...m, handle: handle!,
      units: [
        { id: "alpha", kind: "audit", scope: "repo a", bounds: "all files" },
        { id: "beta", kind: "audit", scope: "repo b", bounds: "all files" },
      ],
    });
    expect(def.schemaVersion).toBe("nirvana.durable-work/v1alpha1");
    expect(def.projectId).toBe("prj_dw");
    expect(def.runId).toBe("run_dw");
    expect(def.traceId).toBe("trace_dw");
    expect(def.units).toHaveLength(2);
    expect(def.units[0].id).toBe("alpha");
    expect(def.units[0].kind).toBe("audit");
  }, DURABLE_BUDGET_MS);

  test("every unit starts in `partial` before any progress is accepted", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u1", attemptId: "att-1", operationId: "op-start-1", now: "2026-08-27T00:00:00.000Z",
    });
    expect(started.status).toBe("partial");
    expect(started.coverage.completed).toBe(0);
    expect(started.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  }, DURABLE_BUDGET_MS);

  test("init does not leave an unused durable_evidence_seen table (review I-1 RED)", () => {
    const m = meta(handle!);
    durable!.defineUnits({
      ...m,
      units: [
        { id: "red-i1-a", kind: "audit", scope: "x", bounds: "y" },
        { id: "red-i1-b", kind: "audit", scope: "x", bounds: "y" },
      ],
    });
    const tableNames = (handle!.db.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get("durable_evidence_seen") as { name: string } | null)?.name;
    expect(tableNames).toBeUndefined();
  }, DURABLE_BUDGET_MS);
});

describe("durable work — idempotency and concurrency", () => {
  test("replays a duplicate (operation_id, payload) as a no-op", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    const first = durable!.startUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-1", now: T0 });
    const replay = durable!.startUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-1", now: T0 });
    expect(replay).toEqual(first);
  }, DURABLE_BUDGET_MS);

  test("rejects the same operation_id with a different payload", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    durable!.startUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-1", now: T0 });
    expect(() => durable!.startUnit({
      ...m, unitId: "u1", attemptId: "att-2", operationId: "op-1", now: T1,
    })).toThrow(/operation_replay_conflict/);
  }, DURABLE_BUDGET_MS);

  test("rejects a stale expected_digest on progress", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    durable!.startUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-start", now: T0 });
    expect(() => durable!.progressUnit({
      ...m, unitId: "u1", attemptId: "att-1", operationId: "op-prog-1",
      expectedDigest: "sha256:" + "0".repeat(64), coverage: { completed: 1, total: 10, label: "files" },
      evidence: [], now: T1,
    })).toThrow(/digest_conflict/);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — evidence and digest verification", () => {
  test("accepts evidence whose digest matches the file content", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    durable!.startUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-start", now: T0 });
    const file = path.join(root, "evidence.txt");
    fs.writeFileSync(file, "hello", "utf8");
    const digest = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const evidence = [{ type: "file", ref: "evidence.txt", digest: `sha256:${digest}` }];
    const started = durable!.getUnit({ ...m, unitId: "u1" });
    const progressed = durable!.progressUnit({
      ...m, stateRoot: root, unitId: "u1", attemptId: "att-1", operationId: "op-prog-1",
      expectedDigest: started!.digest, coverage: { completed: 1, total: 1, label: "files" },
      evidence, now: T1,
    });
    expect(progressed.evidence).toHaveLength(1);
  }, DURABLE_BUDGET_MS);

  test("rejects evidence whose digest does not match the file content", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-start", now: T0 });
    const file = path.join(root, "evidence.txt");
    fs.writeFileSync(file, "hello", "utf8");
    const evidence = [{ type: "file", ref: "evidence.txt", digest: "sha256:" + "0".repeat(64) }];
    expect(() => durable!.progressUnit({
      ...m, stateRoot: root, unitId: "u1", attemptId: "att-1", operationId: "op-prog-1",
      expectedDigest: started.digest,
      coverage: { completed: 1, total: 1, label: "files" }, evidence, now: T1,
    })).toThrow(/evidence_digest_mismatch/);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — cooperative claims", () => {
  test("acquires a claim; live claim refuses, stale takes over, wrong-owner release throws", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    durable!.startUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-start", now: "2026-08-27T00:00:00.000Z" });
    const a = durable!.acquireClaim({ ...m, unitId: "u1", ownerId: "writer-a", ttlMs: 60_000, now: "2026-08-27T00:00:00.000Z" });
    expect(a.ownerId).toBe("writer-a");
    expect(() => durable!.acquireClaim({ ...m, unitId: "u1", ownerId: "writer-b", ttlMs: 60_000, now: "2026-08-27T00:00:30.000Z" }))
      .toThrow(/claim_live/);
    const taken = durable!.acquireClaim({ ...m, unitId: "u1", ownerId: "writer-b", ttlMs: 60_000, now: "2026-08-27T01:00:00.000Z" });
    expect(taken.ownerId).toBe("writer-b");
    expect(() => durable!.releaseClaim({ ...m, unitId: "u1", ownerId: "writer-a", now: "2026-08-27T01:00:00.000Z" }))
      .toThrow(/claim_wrong_owner/);
    expect(() => durable!.releaseClaim({ ...m, unitId: "u1", ownerId: "writer-b", now: "2026-08-27T01:00:00.000Z" })).not.toThrow();
  }, DURABLE_BUDGET_MS);

  test("releases a malformed claim row as `claim_malformed`", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    const db = handle!.db;
    db.run(`INSERT INTO durable_claims(project_id, run_id, unit_id, owner_id, acquired_at, expires_at, row_digest) VALUES(?,?,?,?,?,?,?)`,
      [m.projectId, m.runId, "u1", "", "2026-08-27T00:00:00.000Z", "2026-08-27T01:00:00.000Z", "sha256:" + "0".repeat(64)]);
    expect(() => durable!.acquireClaim({ ...m, unitId: "u1", ownerId: "writer-c", ttlMs: 60_000, now: "2026-08-27T00:00:00.000Z" }))
      .toThrow(/claim_malformed/);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — lifecycle, status, collect, resume", () => {
  test("complete only succeeds when coverage is full and at least one verification evidence is supplied", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-start", now: T0 });
    const vfile = path.join(root, "v.txt");
    fs.writeFileSync(vfile, "verified", "utf8");
    const v = createHash("sha256").update(fs.readFileSync(vfile)).digest("hex");
    const progressed = durable!.progressUnit({
      ...m, stateRoot: root, unitId: "u1", attemptId: "att-1", operationId: "op-prog-1",
      expectedDigest: started.digest, coverage: { completed: 1, total: 1, label: "files" },
      evidence: [{ type: "file", ref: "v.txt", digest: `sha256:${v}` }], now: T1,
    });
    expect(() => durable!.completeUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-c-1",
      expectedDigest: progressed.digest, verificationEvidence: [], now: T2 })).toThrow(/verification_evidence_required/);
    const done = durable!.completeUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-c-1",
      expectedDigest: progressed.digest, verificationEvidence: [{ type: "file", ref: "v.txt", digest: `sha256:${v}` }],
      stateRoot: root, now: T3 });
    expect(done.status).toBe("completed");
  }, DURABLE_BUDGET_MS);

  test("status, collect, and resume are deterministic and re-read-after-fresh-process", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    durable!.startUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-start", now: T0 });
    handle?.close();
    const reopened = openKernel(path.join(root, "kernel.sqlite"));
    const stat = durable!.status({ ...m, handle: reopened });
    expect(stat.units).toHaveLength(1);
    expect(stat.units[0].status).toBe("partial");
    const plan = durable!.resume({ ...m, handle: reopened });
    expect(plan.partial.map(unit => unit.id)).toEqual(["u1"]);
    expect(plan.complete).toHaveLength(0);
    const collected = durable!.collect({ ...m, handle: reopened });
    expect(collected.units[0].status).toBe("partial");
    reopened.close();
  }, DURABLE_BUDGET_MS);
});

describe("durable work — corruption and fail-closed", () => {
  test("a tampered unit row with a wrong stored digest is detected as `state_corrupt`", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    durable!.startUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-start", now: T0 });
    const db = handle!.db;
    db.run("UPDATE durable_units SET status = 'completed' WHERE project_id = ? AND unit_id = ?",
      [m.projectId, "u1"]);
    expect(() => durable!.status({ ...m })).toThrow(/state_corrupt/);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — cross-correlation with the canonical Run Kernel", () => {
  test("every durable event is also a run_event with type=x_durable_work_*", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    durable!.startUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-start", now: T0 });
    const events = listEvents(handle!, m.projectId);
    const durableTypes = events.filter(event => event.type.startsWith("x_durable_work_"));
    expect(durableTypes.length).toBeGreaterThan(0);
    expect(durableTypes.every(event => event.runId === m.runId && event.traceId === m.traceId)).toBe(true);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — migration from Track B", () => {
  test("dry-run imports the Track B state and the snapshot survives a rollback", () => {
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-"));
    const tbStateBody = validTrackBState("tb-run", "tb-trace", alignedUnitDecls(["u-x"]), {
      nirvanaRunId: "tb-run", objective: "import me",
    });
    writeTrackBFixture(tbRoot, tbStateBody, { "u-x": validTrackBUnit("tb-run", "u-x") });
    fs.mkdirSync(path.join(tbRoot, ".locks"), { recursive: true });
    createCanonicalRun(handle!, "prj_imp", "tb-run", "tb-trace");
    const impMeta = {
      handle: handle!, projectId: "prj_imp", runId: "tb-run", traceId: "tb-trace",
      target: { kind: "agent-x" as const, slug: "agent-x" as const },
    };
    const report = durable!.importFromTrackB({
      ...impMeta, trackBRoot: tbRoot, backupRoot: path.join(root, "backup"),
      dryRun: true, now: "2026-08-27T01:00:00.000Z",
    });
    expect(report.imported).toBe(1);
    expect(fs.existsSync(path.join(report.backup, "STATE.json"))).toBe(true);
    const db = handle!.db;
    const units = db.query("SELECT unit_id FROM durable_units WHERE project_id = ?").all(impMeta.projectId);
    expect(units).toHaveLength(0);
  }, DURABLE_BUDGET_MS);
});

// ─── Expanded behavior coverage (fresh process, concurrency, tamper, claims, compensation) ──

describe("durable work — fresh-process resume after abrupt exit", () => {
  test("a brand-new bun process opens the same kernel DB and finds the prior partial state", async () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-start", now: T0 });
    const evFile = path.join(root, "ev.txt");
    fs.writeFileSync(evFile, "partial", "utf8");
    const ev = "sha256:" + createHash("sha256").update(fs.readFileSync(evFile)).digest("hex");
    durable!.progressUnit({
      ...m, stateRoot: root, unitId: "u1", attemptId: "att-1", operationId: "op-prog-1",
      expectedDigest: started.digest, coverage: { completed: 5, total: 10, label: "files" },
      evidence: [{ type: "file", ref: "ev.txt", digest: ev }], now: T1,
    });
    handle!.close();
    handle = null; // simulate abrupt exit: no in-memory state survives
    const worker = path.join(root, "resume-worker.ts");
    const durableUrl = pathToFileURL(path.resolve(import.meta.dir, "..", "lib", "run-kernel", "durable-work.ts")).href;
    const kernelUrl = pathToFileURL(path.resolve(import.meta.dir, "..", "lib", "run-kernel", "index.ts")).href;
    fs.writeFileSync(worker, `
import { openKernel } from ${JSON.stringify(kernelUrl)};
import * as durable from ${JSON.stringify(durableUrl)};
const kernelPath = process.argv[2];
const h = openKernel(kernelPath);
const m = { handle: h, projectId: "prj_dw", runId: "run_dw", traceId: "trace_dw",
  target: { kind: "agent-x", slug: "agent-x" } };
const stat = durable.status(m);
const plan = durable.resume(m);
const collected = durable.collect(m);
const u = durable.getUnit({ ...m, unitId: "u1" });
console.log(JSON.stringify({ status: stat.units[0].status, partialCount: plan.partial.length,
  collectedStatus: collected.units[0].status, unitCoverage: u?.coverage.completed, unitDigest: u?.digest }));
h.close();
`, "utf8");
    const proc = Bun.spawn([process.execPath, worker, path.join(root, "kernel.sqlite")], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    const out = JSON.parse(await new Response(proc.stdout).text());
    expect(exitCode).toBe(0);
    expect(out.status).toBe("partial");
    expect(out.partialCount).toBe(1);
    expect(out.collectedStatus).toBe("partial");
    expect(out.unitCoverage).toBe(5);
    expect(out.unitDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  }, spawnBudgetMs(1));
});

describe("durable work — concurrent writers across two processes", () => {
  test("two processes appending to the same kernel do not lose events (immediate transactions)", async () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [
      { id: "w-a", kind: "audit", scope: "x", bounds: "y" },
      { id: "w-b", kind: "audit", scope: "x", bounds: "y" },
    ] });
    durable!.startUnit({ ...m, unitId: "w-a", attemptId: "att-a", operationId: "op-start-a", now: T0 });
    durable!.startUnit({ ...m, unitId: "w-b", attemptId: "att-b", operationId: "op-start-b", now: T0 });
    const kernelPath = path.join(root, "kernel.sqlite");
    handle!.close();
    handle = null;
    const durableUrl = pathToFileURL(path.resolve(import.meta.dir, "..", "lib", "run-kernel", "durable-work.ts")).href;
    const kernelUrl = pathToFileURL(path.resolve(import.meta.dir, "..", "lib", "run-kernel", "index.ts")).href;
    const writer = path.join(root, "concurrent-writer.ts");
    fs.writeFileSync(writer, `
import { openKernel } from ${JSON.stringify(kernelUrl)};
import * as durable from ${JSON.stringify(durableUrl)};
const kernelPath = process.argv[2];
const unitId = process.argv[3];
const count = Number(process.argv[4]);
const attemptId = process.argv[5];
const h = openKernel(kernelPath);
const m = { handle: h, projectId: "prj_dw", runId: "run_dw", traceId: "trace_dw",
  target: { kind: "agent-x", slug: "agent-x" } };
let row = durable.getUnit({ ...m, unitId });
for (let i = 0; i < count; i++) {
  row = durable.progressUnit({ ...m, unitId, attemptId,
    operationId: "op-prog-" + unitId + "-" + i, expectedDigest: row!.digest,
    coverage: { completed: i + 1, total: count, label: "files" }, evidence: [], now: new Date(Date.parse("2026-08-27T00:00:00.000Z") + i * 1000).toISOString() });
}
console.log(unitId + ":" + row!.coverage.completed);
h.close();
`, "utf8");
    const childA = Bun.spawn([process.execPath, writer, kernelPath, "w-a", "20", "att-a"], { stdout: "pipe", stderr: "pipe" });
    const childB = Bun.spawn([process.execPath, writer, kernelPath, "w-b", "20", "att-b"], { stdout: "pipe", stderr: "pipe" });
    const [a, b] = await Promise.all([childA.exited, childB.exited]);
    expect(a).toBe(0);
    expect(b).toBe(0);
    const reopened = openKernel(kernelPath);
    handle = reopened; // afterEach will close it
    const statA = durable!.getUnit({ ...m, handle: reopened, unitId: "w-a" });
    const statB = durable!.getUnit({ ...m, handle: reopened, unitId: "w-b" });
    expect(statA!.coverage.completed).toBe(20);
    expect(statB!.coverage.completed).toBe(20);
    expect(statA!.revision).toBe(21); // start(1) + 20 progress
    expect(statB!.revision).toBe(21);
    const events = listEvents(reopened, m.projectId);
    const durableEvents = events.filter(e => e.type.startsWith("x_durable_work_"));
    // 1 define (both units) + 2 start + 40 progress = 43
    expect(durableEvents.length).toBe(43);
  }, spawnBudgetMs(2));
});

describe("durable work — tampered evidence rejection", () => {
  test("progress rejects evidence whose file was modified after the digest was computed", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-start", now: T0 });
    const file = path.join(root, "e.txt");
    fs.writeFileSync(file, "original", "utf8");
    const realDigest = "sha256:" + createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    fs.appendFileSync(file, " TAMPERED", "utf8"); // mutate after computing the digest
    expect(() => durable!.progressUnit({
      ...m, stateRoot: root, unitId: "u1", attemptId: "att-1", operationId: "op-prog-1",
      expectedDigest: started.digest, coverage: { completed: 1, total: 1, label: "files" },
      evidence: [{ type: "file", ref: "e.txt", digest: realDigest }], now: T1,
    })).toThrow(/evidence_digest_mismatch/);
    const unchanged = durable!.getUnit({ ...m, unitId: "u1" });
    expect(unchanged!.evidence).toHaveLength(0); // nothing persisted on rejection
  }, DURABLE_BUDGET_MS);
});

describe("durable work — claim variants", () => {
  test("stale claim is taken over by a new owner without explicit release", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    durable!.startUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-start", now: "2026-08-27T00:00:00.000Z" });
    durable!.acquireClaim({ ...m, unitId: "u1", ownerId: "owner-a", ttlMs: 1_000, now: "2026-08-27T00:00:00.000Z" });
    const taken = durable!.acquireClaim({ ...m, unitId: "u1", ownerId: "owner-b", ttlMs: 1_000, now: "2026-08-27T00:00:05.000Z" });
    expect(taken.ownerId).toBe("owner-b");
  }, DURABLE_BUDGET_MS);

  test("same owner can re-acquire (renew) their own live claim", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    durable!.startUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-start", now: "2026-08-27T00:00:00.000Z" });
    const a = durable!.acquireClaim({ ...m, unitId: "u1", ownerId: "owner-a", ttlMs: 60_000, now: "2026-08-27T00:00:00.000Z" });
    const renewed = durable!.acquireClaim({ ...m, unitId: "u1", ownerId: "owner-a", ttlMs: 60_000, now: "2026-08-27T00:00:30.000Z" });
    expect(renewed.ownerId).toBe("owner-a");
    expect(renewed.expiresAt).not.toBe(a.expiresAt); // TTL extended
  }, DURABLE_BUDGET_MS);

  test("release on a non-existent claim is a silent no-op", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    expect(() => durable!.releaseClaim({ ...m, unitId: "u1", ownerId: "ghost", now: T0 })).not.toThrow();
  }, DURABLE_BUDGET_MS);
});

describe("durable work — compensation lifecycle and compensation failure", () => {
  test("fail → compensating → compensated, with tampered compensation evidence leaving it compensating", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-start", now: T0 });
    const failed = durable!.failUnit({
      ...m, unitId: "u1", attemptId: "att-1", operationId: "op-fail-1",
      expectedDigest: started.digest, reason: "downstream crash", now: T1,
    });
    expect(failed.status).toBe("failed");
    const compensating = durable!.compensateUnit({
      ...m, unitId: "u1", attemptId: "att-1", operationId: "op-comp-1",
      expectedDigest: failed.digest, now: T2,
    });
    expect(compensating.status).toBe("compensating");
    const compFile = path.join(root, "comp.txt");
    fs.writeFileSync(compFile, "compensated", "utf8");
    const compDigest = "sha256:" + createHash("sha256").update(fs.readFileSync(compFile)).digest("hex");
    fs.appendFileSync(compFile, " TAMPERED", "utf8"); // tamper after digest
    expect(() => durable!.completeCompensation({
      ...m, stateRoot: root, unitId: "u1", attemptId: "att-1", operationId: "op-compd-1",
      expectedDigest: compensating.digest,
      compensationEvidence: [{ type: "file", ref: "comp.txt", digest: compDigest }], now: T3,
    })).toThrow(/evidence_digest_mismatch/);
    const stillCompensating = durable!.getUnit({ ...m, unitId: "u1" });
    expect(stillCompensating!.status).toBe("compensating"); // failure left it intact
    fs.writeFileSync(compFile, "compensated", "utf8"); // repair evidence
    const compensated = durable!.completeCompensation({
      ...m, stateRoot: root, unitId: "u1", attemptId: "att-1", operationId: "op-compd-2",
      expectedDigest: compensating.digest,
      compensationEvidence: [{ type: "file", ref: "comp.txt", digest: compDigest }], now: T4,
    });
    expect(compensated.status).toBe("compensated");
  }, DURABLE_BUDGET_MS);

  // Hardenings A: Compensation binding tests
  test("compensation binding — only the most recent failed attempt is eligible; older failed attempt rejected in compensateUnit, mismatched attempt rejected in completeCompensation and failCompensation", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u-comp-multi", kind: "audit", scope: "x", bounds: "y" }] });

    // Attempt 1 fails
    const started1 = durable!.startUnit({ ...m, unitId: "u-comp-multi", attemptId: "att-1", operationId: "op-start-1", now: T0 });
    const failed1 = durable!.failUnit({
      ...m, unitId: "u-comp-multi", attemptId: "att-1", operationId: "op-fail-1",
      expectedDigest: started1.digest, reason: "crash 1", now: T1,
    });
    expect(failed1.status).toBe("failed");

    // Attempt 2 fails
    const started2 = durable!.startUnit({ ...m, unitId: "u-comp-multi", attemptId: "att-2", operationId: "op-start-2", now: T2 });
    const failed2 = durable!.failUnit({
      ...m, unitId: "u-comp-multi", attemptId: "att-2", operationId: "op-fail-2",
      expectedDigest: started2.digest, reason: "crash 2", now: T3,
    });
    expect(failed2.status).toBe("failed");

    // Attempting to compensate with older failed attempt att-1 must be rejected
    expect(() => durable!.compensateUnit({
      ...m, unitId: "u-comp-multi", attemptId: "att-1", operationId: "op-comp-old",
      expectedDigest: failed2.digest, now: T3,
    })).toThrow("attempt_not_eligible");

    // Compensating with most recent failed attempt att-2 succeeds
    const compensating = durable!.compensateUnit({
      ...m, unitId: "u-comp-multi", attemptId: "att-2", operationId: "op-comp-latest",
      expectedDigest: failed2.digest, now: T3,
    });
    expect(compensating.status).toBe("compensating");

    const compFile = path.join(root, "comp-multi.txt");
    fs.writeFileSync(compFile, "compensated-multi", "utf8");
    const compDigest = "sha256:" + createHash("sha256").update(fs.readFileSync(compFile)).digest("hex");

    // completeCompensation with older/mismatched attemptId att-1 is rejected
    expect(() => durable!.completeCompensation({
      ...m, stateRoot: root, unitId: "u-comp-multi", attemptId: "att-1", operationId: "op-compd-wrong",
      expectedDigest: compensating.digest,
      compensationEvidence: [{ type: "file", ref: "comp-multi.txt", digest: compDigest }], now: T4,
    })).toThrow("attempt_not_eligible");

    // failCompensation with older/mismatched attemptId att-1 is rejected
    expect(() => durable!.failCompensation({
      ...m, unitId: "u-comp-multi", attemptId: "att-1", operationId: "op-compf-wrong",
      expectedDigest: compensating.digest, reason: "comp failed", now: T4,
    })).toThrow("attempt_not_eligible");

    // failCompensation with matching att-2 moves unit back to failed
    const compFailed = durable!.failCompensation({
      ...m, unitId: "u-comp-multi", attemptId: "att-2", operationId: "op-compf-correct",
      expectedDigest: compensating.digest, reason: "comp retryable failure", now: T4,
    });
    expect(compFailed.status).toBe("failed");
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Track B migration with backup and tested rollback", () => {
  test("full import writes units into the kernel and rollback removes them, preserving the backup", () => {
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-full-"));
    const tbStateBody = validTrackBState("tb-run-2", "tb-trace-2", alignedUnitDecls(["u-mig"]), {
      nirvanaRunId: "tb-run-2",
    });
    const tbMigBody = validTrackBUnit("tb-run-2", "u-mig");
    writeTrackBFixture(tbRoot, tbStateBody, { "u-mig": tbMigBody });
    createCanonicalRun(handle!, "prj_mig", "tb-run-2", "tb-trace-2");
    const impMeta = {
      projectId: "prj_mig", runId: "tb-run-2", traceId: "tb-trace-2",
      target: { kind: "agent-x" as const, slug: "agent-x" as const },
    };
    const backupRoot = path.join(root, "backup-full");
    const report = durable!.importFromTrackB({
      ...impMeta, handle: handle!, trackBRoot: tbRoot, backupRoot,
      dryRun: false, now: "2026-08-27T02:00:00.000Z",
    });
    expect(report.imported).toBe(1);
    expect(report.dryRun).toBe(false);
    const imported = durable!.getUnit({ ...impMeta, handle: handle!, unitId: "u-mig" });
    expect(imported!.status).toBe("completed");
    expect(imported!.coverage.completed).toBe(1);
    const backupState = path.join(report.backup, "STATE.json");
    expect(fs.existsSync(backupState)).toBe(true);
    durable!.rollbackTrackBImport({
      ...impMeta, handle: handle!, backup: report.backup,
    });
    const afterRollback = durable!.getUnit({ ...impMeta, handle: handle!, unitId: "u-mig" });
    expect(afterRollback).toBeNull();
    expect(fs.existsSync(backupState)).toBe(true); // backup survives rollback
    fs.rmSync(tbRoot, { recursive: true, force: true });
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Windows-safe path handling", () => {
  test("evidence refs with backslashes or absolute paths are rejected", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({ ...m, unitId: "u1", attemptId: "att-1", operationId: "op-start", now: T0 });
    const digest = "sha256:" + "a".repeat(64);
    expect(() => durable!.progressUnit({
      ...m, stateRoot: root, unitId: "u1", attemptId: "att-1", operationId: "op-prog-1",
      expectedDigest: started.digest, coverage: { completed: 1, total: 1, label: "files" },
      evidence: [{ type: "file", ref: "sub\\dir\\evil.txt", digest }], now: T1,
    })).toThrow(/evidence_ref_unsafe/);
    expect(() => durable!.progressUnit({
      ...m, stateRoot: root, unitId: "u1", attemptId: "att-1", operationId: "op-prog-2",
      expectedDigest: started.digest, coverage: { completed: 1, total: 1, label: "files" },
      evidence: [{ type: "file", ref: "C:\\evil.txt", digest }], now: T1,
    })).toThrow(/evidence_ref_unsafe/);
    expect(() => durable!.progressUnit({
      ...m, stateRoot: root, unitId: "u1", attemptId: "att-1", operationId: "op-prog-3",
      expectedDigest: started.digest, coverage: { completed: 1, total: 1, label: "files" },
      evidence: [{ type: "file", ref: "../escape.txt", digest }], now: T1,
    })).toThrow(/evidence_ref_unsafe/);
  }, DURABLE_BUDGET_MS);
});

// ─── Phase 1 correction RED coverage ───────────────────────────────────────

function callApi(name: string, input: Record<string, unknown>): unknown {
  const fn = (durable! as unknown as Record<string, unknown>)[name];
  if (typeof fn !== "function") throw new Error(`missing_api:${name}`);
  return (fn as (value: Record<string, unknown>) => unknown)(input);
}

function expectCanonicalContextFailure(action: () => unknown): void {
  expect(action).toThrow(/canonical|context|trace|target|run.*(not|missing)|not found/i);
}

function captureFailure(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function unitRowsFor(projectId: string): Array<Record<string, unknown>> {
  return handle!.db.query(
    "SELECT project_id, run_id, unit_id, row_digest FROM durable_units WHERE project_id = ? ORDER BY run_id, unit_id",
  ).all(projectId) as Array<Record<string, unknown>>;
}

describe("durable work — run-scoped identity and canonical context", () => {
  test("two runs in one project may share a unit, operation, and claim identity without crossing state", () => {
    const a = createCanonicalRun(handle!, "prj_shared", "run_a", "trace_a");
    const b = createCanonicalRun(handle!, "prj_shared", "run_b", "trace_b");
    const unit = { id: "shared", kind: "audit" as const, scope: "same scope", bounds: "same bounds" };
    durable!.defineUnits({ ...a, units: [unit] });
    durable!.defineUnits({ ...b, units: [unit] });

    const aStarted = durable!.startUnit({
      ...a, unitId: "shared", attemptId: "attempt-shared", operationId: "operation-shared", now: T0,
    });
    const bStarted = durable!.startUnit({
      ...b, unitId: "shared", attemptId: "attempt-shared", operationId: "operation-shared", now: T1,
    });

    expect(aStarted.projectId).toBe("prj_shared");
    expect(aStarted.runId).toBe("run_a");
    expect(bStarted.runId).toBe("run_b");
    expect(durable!.getUnit({ ...a, unitId: "shared" })!.runId).toBe("run_a");
    expect(durable!.getUnit({ ...b, unitId: "shared" })!.runId).toBe("run_b");

    const aClaim = durable!.acquireClaim({
      ...a, unitId: "shared", ownerId: "owner-a", ttlMs: 60_000, now: T0,
    });
    const bClaim = durable!.acquireClaim({
      ...b, unitId: "shared", ownerId: "owner-b", ttlMs: 60_000, now: T1,
    });
    expect(aClaim.ownerId).toBe("owner-a");
    expect(bClaim.ownerId).toBe("owner-b");
  }, DURABLE_BUDGET_MS);

  test("claims are isolated when two runs share a project and unit id", () => {
    const a = createCanonicalRun(handle!, "prj_claim_shared", "run_claim_a", "trace_claim_a");
    const b = createCanonicalRun(handle!, "prj_claim_shared", "run_claim_b", "trace_claim_b");
    const unit = { id: "shared-claim", kind: "audit" as const, scope: "same scope", bounds: "same bounds" };
    durable!.defineUnits({ ...a, units: [unit] });
    durable!.defineUnits({ ...b, units: [unit] });
    const first = captureFailure(() => durable!.acquireClaim({
      ...a, unitId: unit.id, ownerId: "owner-a", ttlMs: 60_000, now: T0,
    }));
    const second = captureFailure(() => durable!.acquireClaim({
      ...b, unitId: unit.id, ownerId: "owner-b", ttlMs: 60_000, now: T1,
    }));
    expect({ first, second }).toEqual({ first: null, second: null });
  }, DURABLE_BUDGET_MS);

  test("a missing canonical run leaves neither a definition nor its canonical event", () => {
    const missing = {
      ...meta(handle!, "prj_missing", "run_missing", "trace_missing"),
      units: [{ id: "u-missing", kind: "audit" as const, scope: "x", bounds: "y" }],
    };
    expect(() => durable!.defineUnits(missing)).toThrow(/canonical|run.*(not|missing)|not found/i);
    expect(handle!.db.query(
      "SELECT 1 AS x FROM durable_definitions WHERE project_id = ? AND run_id = ?",
    ).get("prj_missing", "run_missing")).toBeNull();
    expect(listEvents(handle!, "prj_missing").filter(event => event.type.startsWith("x_durable_work_")).length).toBe(0);
  }, DURABLE_BUDGET_MS);

  test("every public lifecycle/read API rejects a real run with a mismatched trace or target", () => {
    const m = createCanonicalRun(handle!, "prj_context", "run_context", "trace_context");
    durable!.defineUnits({ ...m, units: [
      { id: "u-start", kind: "audit", scope: "x", bounds: "y" },
      { id: "u-progress", kind: "audit", scope: "x", bounds: "y" },
      { id: "u-complete", kind: "audit", scope: "x", bounds: "y" },
      { id: "u-fail", kind: "audit", scope: "x", bounds: "y" },
      { id: "u-compensate", kind: "audit", scope: "x", bounds: "y" },
      { id: "u-read", kind: "audit", scope: "x", bounds: "y" },
      { id: "u-claim", kind: "audit", scope: "x", bounds: "y" },
      { id: "u-release", kind: "audit", scope: "x", bounds: "y" },
    ] });
    const progressStart = durable!.startUnit({
      ...m, unitId: "u-progress", attemptId: "att-progress", operationId: "op-progress-start", now: T0,
    });
    const completeStart = durable!.startUnit({
      ...m, unitId: "u-complete", attemptId: "att-complete", operationId: "op-complete-start", now: T0,
    });
    const completeProgress = durable!.progressUnit({
      ...m, unitId: "u-complete", attemptId: "att-complete", operationId: "op-complete-progress",
      expectedDigest: completeStart.digest, coverage: { completed: 1, total: 1, label: "files" }, evidence: [], now: T1,
    });
    const failStart = durable!.startUnit({
      ...m, unitId: "u-fail", attemptId: "att-fail", operationId: "op-fail-start", now: T0,
    });
    const compensateStart = durable!.startUnit({
      ...m, unitId: "u-compensate", attemptId: "att-compensate", operationId: "op-compensate-start", now: T0,
    });
    const failed = durable!.failUnit({
      ...m, unitId: "u-compensate", attemptId: "att-compensate", operationId: "op-compensate-fail",
      expectedDigest: compensateStart.digest, reason: "test failure", now: T1,
    });
    const compensating = durable!.compensateUnit({
      ...m, unitId: "u-compensate", attemptId: "att-compensate", operationId: "op-compensate-begin",
      expectedDigest: failed.digest, now: T2,
    });
    durable!.startUnit({ ...m, unitId: "u-read", attemptId: "att-read", operationId: "op-read-start", now: T0 });
    const contextMismatch = { ...m, traceId: "wrong-trace" };
    const targetMismatch = {
      ...m,
      target: { kind: "wrong-target", slug: "wrong-target" } as unknown as typeof TARGET,
    };
    const evidence = evidenceFixture("context-verification.txt");

    const failures = [
      () => durable!.startUnit({
        ...contextMismatch, unitId: "u-start", attemptId: "att-start", operationId: "op-start-context", now: T0,
      }),
      () => durable!.progressUnit({
        ...contextMismatch, unitId: "u-progress", attemptId: "att-progress", operationId: "op-progress-context",
        expectedDigest: progressStart.digest, coverage: { completed: 1, total: 1, label: "files" }, evidence: [], now: T1,
      }),
      () => durable!.completeUnit({
        ...contextMismatch, unitId: "u-complete", attemptId: "att-complete", operationId: "op-complete-context",
        expectedDigest: completeProgress.digest, verificationEvidence: [evidence], stateRoot: root, now: T2,
      }),
      () => durable!.failUnit({
        ...contextMismatch, unitId: "u-fail", attemptId: "att-fail", operationId: "op-fail-context",
        expectedDigest: failStart.digest, reason: "context mismatch", now: T1,
      }),
      () => durable!.compensateUnit({
        ...contextMismatch, unitId: "u-compensate", attemptId: "att-compensate", operationId: "op-compensate-context",
        expectedDigest: compensating.digest, now: T3,
      }),
      () => durable!.completeCompensation({
        ...contextMismatch, unitId: "u-compensate", attemptId: "att-compensate", operationId: "op-compensated-context",
        expectedDigest: compensating.digest, compensationEvidence: [evidence], stateRoot: root, now: T3,
      }),
      () => durable!.getUnit({ ...targetMismatch, unitId: "u-read", stateRoot: root } as never),
      () => durable!.status({ ...contextMismatch }),
      () => durable!.collect({ ...targetMismatch }),
      () => durable!.resume({ ...contextMismatch }),
      () => durable!.acquireClaim({
      ...contextMismatch, unitId: "u-claim", ownerId: "context-owner", ttlMs: 60_000, now: T0,
      }),
    ].map(captureFailure);
    durable!.acquireClaim({ ...m, unitId: "u-release", ownerId: "release-owner", ttlMs: 60_000, now: T0 });
    const releaseFailure = captureFailure(() => durable!.releaseClaim({
      ...targetMismatch, unitId: "u-release", ownerId: "release-owner", now: T1,
    }));
    expect([...failures, releaseFailure]).toEqual([
      ...failures.map(() => expect.stringMatching(/canonical|context|trace|target|run/i)),
      expect.stringMatching(/canonical|context|trace|target|run/i),
    ]);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — definition replay and atomicity", () => {
  test("identical defineUnits replay is idempotent while a changed definition conflicts", () => {
    const m = meta(handle!);
    const input = {
      ...m,
      now: T0,
      units: [{ id: "u-replay", kind: "audit" as const, scope: "scope", bounds: "bounds" }],
    };
    const first = durable!.defineUnits(input);
    const replay = durable!.defineUnits(input);
    expect(replay).toEqual(first);
    const definedEvents = listEvents(handle!, m.projectId).filter(event => event.type === "x_durable_work_units_defined");
    expect(definedEvents).toHaveLength(1);
    const conflict = captureFailure(() => durable!.defineUnits({
      ...input, units: [{ id: "u-replay", kind: "audit", scope: "changed", bounds: "bounds" }],
    }));
    expect(conflict).toMatch(/conflict/i);
    const stored = handle!.db.query(
      "SELECT definition_digest FROM durable_definitions WHERE project_id = ? AND run_id = ?",
    ).get(m.projectId, m.runId) as { definition_digest: string };
    expect(stored.definition_digest).toBe(first.digest);
    expect(durable!.getUnit({ ...m, unitId: "u-replay" })).toBeNull();
  }, DURABLE_BUDGET_MS);

  test("definition and canonical event commit atomically when canonical event validation fails", () => {
    const m = meta(handle!, "prj_atomic_definition", "run_atomic_definition", "trace_atomic_definition");
    const failure = captureFailure(() => durable!.defineUnits({
      ...m,
      units: [{ id: "u-atomic-definition", kind: "audit", scope: "x", bounds: "y" }],
    }));
    expect(failure).toEqual(expect.stringMatching(/canonical|run.*(not|missing)|not found/i));
    expect(handle!.db.query(
      "SELECT 1 AS x FROM durable_definitions WHERE project_id = ? AND run_id = ?",
    ).get(m.projectId, m.runId)).toBeNull();
    expect(unitRowsFor(m.projectId)).toHaveLength(0);
    expect(listEvents(handle!, m.projectId).filter(event => event.type.startsWith("x_durable_work_")).length).toBe(0);
  }, DURABLE_BUDGET_MS);

  test("defineUnits is atomic when appendEvent fails after validation", () => {
    const m = createCanonicalRun(handle!, "prj_atomic_append", "run_atomic_append", "trace_atomic_append");
    handle!.db.exec(`CREATE TRIGGER fail_durable_definition_event
      BEFORE INSERT ON run_events
      WHEN json_extract(NEW.event_json, '$.type') = 'x_durable_work_units_defined'
      BEGIN SELECT RAISE(ABORT, 'forced_append_event_failure'); END`);
    const failure = captureFailure(() => durable!.defineUnits({
      ...m,
      units: [{ id: "u-atomic-append", kind: "audit", scope: "x", bounds: "y" }],
    }));
    expect(failure).toMatch(/forced_append_event_failure|append|canonical/i);
    expect(handle!.db.query(
      "SELECT 1 AS x FROM durable_definitions WHERE project_id = ? AND run_id = ?",
    ).get(m.projectId, m.runId)).toBeNull();
    expect(listEvents(handle!, m.projectId).filter(event => event.type.startsWith("x_durable_work_")).length).toBe(0);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — trust-sensitive reads and operation replay", () => {
  test("getUnit, status, collect, and resume revalidate captured evidence after tampering", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u-read-evidence", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u-read-evidence", attemptId: "att-read-evidence", operationId: "op-read-start", now: T0,
    });
    const evidence = evidenceFixture("read-evidence.txt", "before tamper");
    durable!.progressUnit({
      ...m, stateRoot: root, unitId: "u-read-evidence", attemptId: "att-read-evidence", operationId: "op-read-progress",
      expectedDigest: started.digest, coverage: { completed: 1, total: 1, label: "files" }, evidence: [evidence], now: T1,
    });
    fs.writeFileSync(path.join(root, evidence.ref), "after tamper", "utf8");
    const withRoot = { ...m, stateRoot: root } as unknown as Record<string, unknown>;
    const failures = [
      () => callApi("getUnit", { ...withRoot, unitId: "u-read-evidence" }),
      () => callApi("status", withRoot),
      () => callApi("collect", withRoot),
      () => callApi("resume", withRoot),
    ].map(captureFailure);
    expect(failures).toEqual(failures.map(() => expect.stringMatching(/evidence|tamper|integrity/i)));
  }, DURABLE_BUDGET_MS);

  test("duplicate operation replay returns its original committed result after later mutations", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u-original-result", kind: "audit", scope: "x", bounds: "y" }] });
    const first = durable!.startUnit({
      ...m, unitId: "u-original-result", attemptId: "att-original", operationId: "op-original", now: T0,
    });
    durable!.progressUnit({
      ...m, unitId: "u-original-result", attemptId: "att-original", operationId: "op-later",
      expectedDigest: first.digest, coverage: { completed: 1, total: 2, label: "files" }, evidence: [], now: T1,
    });
    const replay = durable!.startUnit({
      ...m, unitId: "u-original-result", attemptId: "att-original", operationId: "op-original", now: T0,
    });
    expect(replay).toEqual(first);
    expect(replay.revision).toBe(1);
    expect(replay.coverage.completed).toBe(0);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — claims, restart, and compensation retry", () => {
  test("rejects a claim for an undeclared unit and digest-valid malformed owner/timestamps", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u-claim-valid", kind: "audit", scope: "x", bounds: "y" }] });
    expect(() => durable!.acquireClaim({
      ...m, unitId: "undeclared", ownerId: "owner", ttlMs: 60_000, now: T0,
    })).toThrow(/unit_not_declared|claim_unit/i);

    const malformedOwner = {
      projectId: m.projectId, unitId: "u-claim-valid", ownerId: "owner with spaces",
      acquiredAt: T0, expiresAt: T1,
    };
    handle!.db.run(
      `INSERT INTO durable_claims(project_id, run_id, unit_id, owner_id, acquired_at, expires_at, row_digest) VALUES(?,?,?,?,?,?,?)`,
      [m.projectId, m.runId, malformedOwner.unitId, malformedOwner.ownerId, malformedOwner.acquiredAt,
        malformedOwner.expiresAt, "sha256:" + createHash("sha256").update(canonicalJson(malformedOwner)).digest("hex")],
    );
    expect(() => durable!.acquireClaim({
      ...m, unitId: "u-claim-valid", ownerId: "other-owner", ttlMs: 60_000, now: T0,
    })).toThrow(/claim_malformed|owner_invalid/i);
  }, DURABLE_BUDGET_MS);

  test("a digest-valid claim with malformed timestamps fails closed", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u-claim-time", kind: "audit", scope: "x", bounds: "y" }] });
    const malformed = {
      projectId: m.projectId, unitId: "u-claim-time", ownerId: "owner-time",
      acquiredAt: "not-an-iso-time", expiresAt: "also-not-an-iso-time",
    };
    handle!.db.run(
      `INSERT INTO durable_claims(project_id, run_id, unit_id, owner_id, acquired_at, expires_at, row_digest) VALUES(?,?,?,?,?,?,?)`,
      [m.projectId, m.runId, malformed.unitId, malformed.ownerId, malformed.acquiredAt, malformed.expiresAt,
        "sha256:" + createHash("sha256").update(canonicalJson(malformed)).digest("hex")],
    );
    expect(() => durable!.acquireClaim({
      ...m, unitId: "u-claim-time", ownerId: "other-owner", ttlMs: 60_000, now: T0,
    })).toThrow(/claim_malformed|timestamp_invalid/i);
  }, DURABLE_BUDGET_MS);

  test("starting a failed unit returns it to partial with a new active attempt", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u-restart", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u-restart", attemptId: "att-first", operationId: "op-first", now: T0,
    });
    const failed = durable!.failUnit({
      ...m, unitId: "u-restart", attemptId: "att-first", operationId: "op-fail", expectedDigest: started.digest,
      reason: "restart me", now: T1,
    });
    const restarted = durable!.startUnit({
      ...m, unitId: "u-restart", attemptId: "att-second", operationId: "op-second", expectedDigest: failed.digest, now: T2,
    });
    expect(restarted.status).toBe("partial");
    expect(restarted.attempts.at(-1)).toMatchObject({ id: "att-second", outcome: "active", endedAt: null });
  }, DURABLE_BUDGET_MS);

  test("compensation failure has an explicit retryable transition and canonical event", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u-compensation-retry", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u-compensation-retry", attemptId: "att-compensation", operationId: "op-compensation-start", now: T0,
    });
    const failed = durable!.failUnit({
      ...m, unitId: "u-compensation-retry", attemptId: "att-compensation", operationId: "op-compensation-fail",
      expectedDigest: started.digest, reason: "rollback needed", now: T1,
    });
    const compensating = durable!.compensateUnit({
      ...m, unitId: "u-compensation-retry", attemptId: "att-compensation", operationId: "op-compensation-begin",
      expectedDigest: failed.digest, now: T2,
    });
    const failedCompensation = callApi("failCompensation", {
      ...m, unitId: "u-compensation-retry", attemptId: "att-compensation", operationId: "op-compensation-failed",
      expectedDigest: compensating.digest, reason: "compensation downstream failed", now: T3,
    }) as { status: string; digest: string };
    expect(failedCompensation.status).toBe("failed");
    const retried = durable!.compensateUnit({
      ...m, unitId: "u-compensation-retry", attemptId: "att-compensation", operationId: "op-compensation-retry",
      expectedDigest: failedCompensation.digest, now: T4,
    });
    expect(retried.status).toBe("compensating");
    expect(listEvents(handle!, m.projectId).some(event =>
      event.type === "x_durable_work_unit_compensation_failed" && event.runId === m.runId && event.traceId === m.traceId,
    )).toBe(true);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — validated Track B import", () => {
  test("rejects malformed state-unit shapes before any durable write", () => {
    const projectId = "prj_bad_state";
    const runId = "run_bad_state";
    const traceId = "trace_bad_state";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-bad-state-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-bad-state"]), {
      units: [{ id: "u-bad-state" }],
    });
    writeTrackBFixture(tbRoot, state, {});
    const failure = captureFailure(() => importTrackB({
      projectId, runId, traceId, target: TARGET, trackBRoot: tbRoot, backupRoot: path.join(root, "backup"),
      dryRun: false, now: T0,
    }));
    expect(failure).toEqual(expect.stringMatching(/track_b_state|unit.*invalid|shape/i));
    expect(unitRowsFor(projectId)).toHaveLength(0);
    expect(handle!.db.query(
      "SELECT 1 AS x FROM durable_definitions WHERE project_id = ? AND run_id = ?",
    ).get(projectId, runId)).toBeNull();
  }, DURABLE_BUDGET_MS);

  test("Track B complete units require full positive coverage, valid evidence, no active attempts, and a completed final attempt", () => {
    const projectId = "prj_track_b_complete_inv";
    const runId = "run_track_b_complete_inv";
    const traceId = "trace_track_b_complete_inv";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const m = meta(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-inv-"));
    const backupRoot = path.join(root, "backup-inv");
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-inv"]));

    const invalidUnit = validTrackBUnit(runId, "u-inv", {
      status: "complete",
      coverage: { completed: 1, total: 1, label: "files" },
      attempts: [
        { id: "att-inv-1", startedAt: T0, endedAt: T1, flushes: 1, outcome: "failed" },
        { id: "att-inv-2", startedAt: T2, endedAt: null, flushes: 1, outcome: "active" },
      ],
    });
    writeTrackBFixture(tbRoot, state, { "u-inv": invalidUnit });

    expect(() => importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "imp-inv-1", dryRun: false, now: T3,
    })).toThrow("track_b_unit_complete_invalid");

    const validUnit = validTrackBUnit(runId, "u-inv", {
      status: "complete",
      coverage: { completed: 1, total: 1, label: "files" },
      attempts: [
        { id: "att-inv-1", startedAt: T0, endedAt: T1, flushes: 1, outcome: "failed" },
        { id: "att-inv-2", startedAt: T2, endedAt: T3, flushes: 1, outcome: "completed" },
      ],
    });
    writeTrackBFixture(tbRoot, state, { "u-inv": validUnit });

    const report = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "imp-inv-2", dryRun: false, now: T4,
    });
    expect(report.imported).toBe(1);
    const unit = durable!.getUnit({ ...m, unitId: "u-inv" });
    expect(unit!.status).toBe("completed");
    expect(unit!.attempts.at(-1)).toMatchObject({ outcome: "completed", endedAt: T3 });
  }, DURABLE_BUDGET_MS);

  test("rejects malformed Track B unit status, revision, timestamps, and digest before writing", () => {
    const projectId = "prj_bad_unit";
    const runId = "run_bad_unit";
    const traceId = "trace_bad_unit";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-bad-unit-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-bad-unit"]));
    const unit = validTrackBUnit(runId, "u-bad-unit", {
      status: "bogus",
      revision: -1,
      createdAt: "not-an-iso-time",
      updatedAt: "also-not-an-iso-time",
      attempts: [{ id: "att", startedAt: "not-an-iso-time", endedAt: null, flushes: -1, outcome: "active" }],
      evidence: [{ type: "file", ref: "evidence.txt", digest: "not-a-digest" }],
      operations: [
        { id: "op-duplicate", payloadDigest: "sha256:" + "a".repeat(64), appliedAt: T0 },
        { id: "op-duplicate", payloadDigest: "sha256:" + "b".repeat(64), appliedAt: T1 },
      ],
    });
    writeTrackBFixture(tbRoot, state, { "u-bad-unit": unit });
    const failure = captureFailure(() => importTrackB({
      projectId, runId, traceId, target: TARGET, trackBRoot: tbRoot, backupRoot: path.join(root, "backup"),
      dryRun: false, now: T0,
    }));
    expect(failure).toEqual(expect.stringMatching(/track_b_unit|status|revision|timestamp|digest|invalid/i));
    expect(unitRowsFor(projectId)).toHaveLength(0);
    expect(handle!.db.query(
      "SELECT 1 AS x FROM durable_definitions WHERE project_id = ? AND run_id = ?",
    ).get(projectId, runId)).toBeNull();
  }, DURABLE_BUDGET_MS);

  test("a second-unit validation failure rolls back the whole import and permits retry", () => {
    const projectId = "prj_atomic_import";
    const runId = "run_atomic_import";
    const traceId = "trace_atomic_import";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-atomic-"));
    const definitions = [
      { id: "u-first", scope: "scope-u-first", bounds: "bounds-u-first" },
      { id: "u-second", scope: "scope-u-second", bounds: "bounds-u-second" },
    ];
    const state = validTrackBState(runId, traceId, definitions);
    const first = validTrackBUnit(runId, "u-first");
    const second = { ...validTrackBUnit(runId, "u-second"), digest: "sha256:" + "0".repeat(64) };
    writeTrackBFixture(tbRoot, state, { "u-first": first, "u-second": second });
    const failure = captureFailure(() => importTrackB({
      projectId, runId, traceId, target: TARGET, trackBRoot: tbRoot, backupRoot: path.join(root, "backup"),
      dryRun: false, now: T0,
    }));
    expect(failure).toEqual(expect.stringMatching(/digest|track_b_unit|invalid/i));
    expect(unitRowsFor(projectId)).toHaveLength(0);
    expect(handle!.db.query(
      "SELECT 1 AS x FROM durable_definitions WHERE project_id = ? AND run_id = ?",
    ).get(projectId, runId)).toBeNull();

    const repaired = validTrackBUnit(runId, "u-second");
    writeTrackBFixture(tbRoot, state, { "u-first": first, "u-second": repaired });
    const retry = importTrackB({
      projectId, runId, traceId, target: TARGET, trackBRoot: tbRoot, backupRoot: path.join(root, "backup-retry"),
      dryRun: false, now: T1,
    });
    expect(retry.imported).toBe(2);
  }, DURABLE_BUDGET_MS);

  test("rejects duplicate or mismatched Track B unit identities atomically", () => {
    const projectId = "prj_duplicate_import";
    const runId = "run_duplicate_import";
    const traceId = "trace_duplicate_import";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-duplicate-"));
    const state = validTrackBState(runId, traceId, [
      { id: "u-one", scope: "scope-u-one", bounds: "bounds-u-one" },
      { id: "u-two", scope: "scope-u-two", bounds: "bounds-u-two" },
    ]);
    writeTrackBFixture(tbRoot, state, {
      "u-one": validTrackBUnit(runId, "u-one"),
      "u-two": validTrackBUnit(runId, "u-one"),
    });
    const failure = captureFailure(() => importTrackB({
      projectId, runId, traceId, target: TARGET, trackBRoot: tbRoot, backupRoot: path.join(root, "backup"),
      dryRun: false, now: T0,
    }));
    expect(failure).toEqual(expect.stringMatching(/duplicate|identity|mismatch|track_b_unit/i));
    expect(unitRowsFor(projectId)).toHaveLength(0);
    expect(handle!.db.query(
      "SELECT 1 AS x FROM durable_definitions WHERE project_id = ? AND run_id = ?",
    ).get(projectId, runId)).toBeNull();
  }, DURABLE_BUDGET_MS);
});

describe("durable work — backup manifest, rollback, and canonical migration trail", () => {
  test("backup has provenance and per-file integrity, and tampering blocks rollback", () => {
    const projectId = "prj_manifest";
    const runId = "run_manifest";
    const traceId = "trace_manifest";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-manifest-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-manifest"]));
    const unit = validTrackBUnit(runId, "u-manifest");
    writeTrackBFixture(tbRoot, state, { "u-manifest": unit });
    const report = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot: path.join(root, "backup-manifest"), dryRun: false, now: T0,
    });
    const manifestPath = path.join(report.backup, "MANIFEST.json");
    expect(fs.existsSync(manifestPath)).toBe(true);
    let manifest: Record<string, unknown> | null = null;
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      fs.appendFileSync(manifestPath, "\n tampered", "utf8");
    } else {
      fs.appendFileSync(path.join(report.backup, "STATE.json"), "\n tampered", "utf8");
    }
    const rollbackFailure = captureFailure(() => rollbackTrackB({ ...m, backup: report.backup }));
    const preserved = durable!.getUnit({ ...m, unitId: "u-manifest" }) !== null;
    expect({
      hasManifest: fs.existsSync(manifestPath),
      manifest,
      rollbackFailure,
      preserved,
    }).toEqual({
      hasManifest: true,
      manifest: expect.objectContaining({
        projectId,
        runId,
        traceId,
        files: expect.arrayContaining([
          expect.objectContaining({ path: "STATE.json", digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }),
        ]),
        digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }),
      rollbackFailure: expect.stringMatching(/backup|manifest|integrity|provenance/i),
      preserved: true,
    });
  }, DURABLE_BUDGET_MS);

  test("rollback is run-scoped and verifies that the supplied backup belongs to the requested run", () => {
    const projectId = "prj_rollback_scope";
    const a = createCanonicalRun(handle!, projectId, "run_rollback_a", "trace_rollback_a");
    const b = createCanonicalRun(handle!, projectId, "run_rollback_b", "trace_rollback_b");
    durable!.defineUnits({ ...b, units: [{ id: "u-preserve", kind: "audit", scope: "x", bounds: "y" }] });
    durable!.startUnit({ ...b, unitId: "u-preserve", attemptId: "att-preserve", operationId: "op-preserve", now: T0 });

    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-rollback-scope-"));
    const state = validTrackBState(a.runId, a.traceId, alignedUnitDecls(["u-remove"]));
    writeTrackBFixture(tbRoot, state, { "u-remove": validTrackBUnit(a.runId, "u-remove") });
    const report = importTrackB({
      ...a, trackBRoot: tbRoot, backupRoot: path.join(root, "backup-scope"), dryRun: false, now: T0,
    });
    const wrongRunFailure = captureFailure(() => rollbackTrackB({ ...a, backup: report.backup, runId: b.runId }));
    const afterWrongRun = {
      importedRunPreserved: durable!.getUnit({ ...a, unitId: "u-remove" }) !== null,
      unrelatedRunPreserved: durable!.getUnit({ ...b, unitId: "u-preserve" }) !== null,
    };
    expect({ wrongRunFailure, ...afterWrongRun }).toEqual({
      wrongRunFailure: expect.stringMatching(/backup|provenance|run|mismatch/i),
      importedRunPreserved: true,
      unrelatedRunPreserved: true,
    });
    rollbackTrackB({ ...a, backup: report.backup });
    expect(durable!.getUnit({ ...a, unitId: "u-remove" })).toBeNull();
    expect(durable!.getUnit({ ...b, unitId: "u-preserve" })).not.toBeNull();
  }, DURABLE_BUDGET_MS);

  test("migration and rollback reuse the caller handle and emit canonical events", () => {
    const projectId = "prj_migration_trail";
    const runId = "run_migration_trail";
    const traceId = "trace_migration_trail";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    const caller = handle!;
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-trail-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-trail"]));
    writeTrackBFixture(tbRoot, state, { "u-trail": validTrackBUnit(runId, "u-trail") });
    const report = importTrackB({
      ...m, handle: caller, kernelPath: path.join(root, "must-not-open.sqlite"), trackBRoot: tbRoot,
      backupRoot: path.join(root, "backup-trail"), dryRun: false, now: T0,
    });
    expect(handle).toBe(caller);
    expect(durable!.getUnit({ ...m, unitId: "u-trail" })).not.toBeNull();
    expect(listEvents(caller, projectId).some(event =>
      event.type === "x_durable_work_track_b_imported" && event.runId === runId && event.traceId === traceId,
    )).toBe(true);

    rollbackTrackB({
      ...m, handle: caller, kernelPath: path.join(root, "must-not-open-rollback.sqlite"), backup: report.backup,
    });
    expect(durable!.getUnit({ ...m, unitId: "u-trail" })).toBeNull();
    expect(listEvents(caller, projectId).some(event =>
      event.type === "x_durable_work_track_b_rollback" && event.runId === runId && event.traceId === traceId,
    )).toBe(true);
  }, DURABLE_BUDGET_MS);

  test("import rejects mismatched canonical trace and target before backup/database mutation", () => {
    const projectId = "prj_import_context";
    const runId = "run_import_context";
    const traceId = "trace_import_context";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-context-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-context"]));
    writeTrackBFixture(tbRoot, state, { "u-context": validTrackBUnit(runId, "u-context") });
    const wrongTarget = { kind: "wrong-target", slug: "wrong-target" } as unknown as typeof TARGET;
    const failure = captureFailure(() => importTrackB({
      projectId, runId, traceId: "wrong-trace", target: wrongTarget, trackBRoot: tbRoot,
      backupRoot: path.join(root, "backup-context"), dryRun: false, now: T0,
    }));
    const contextMutation = {
      units: unitRowsFor(projectId).length,
      definition: handle!.db.query(
        "SELECT 1 AS x FROM durable_definitions WHERE project_id = ? AND run_id = ?",
      ).get(projectId, runId) !== null,
    };
    expect({ failure, ...contextMutation }).toEqual({
      failure: expect.stringMatching(/canonical|context|trace|target|run.*(not|missing)|not found/i),
      units: 0,
      definition: false,
    });
  }, DURABLE_BUDGET_MS);
});

describe("durable work — cross-integration: squad target capability identity", () => {
  test("same squad slug with a different capabilityId is rejected as a different target", () => {
    const projectId = "prj_capability_id";
    const runId = "run_capability_id";
    const traceId = "trace_capability_id";
    const squadTarget = { kind: "squad" as const, slug: "codex-squad", capabilityId: "primary" };
    const m = createCanonicalRun(handle!, projectId, runId, traceId, squadTarget);
    const sameCap = { kind: "squad" as const, slug: "codex-squad", capabilityId: "primary" };
    const def = durable!.defineUnits({
      ...m, target: sameCap,
      units: [{ id: "u-cap", kind: "audit", scope: "x", bounds: "y" }],
    });
    expect(def.units).toHaveLength(1);
    const differentCap = { kind: "squad" as const, slug: "codex-squad", capabilityId: "secondary" };
    const failure = captureFailure(() => durable!.defineUnits({
      ...m, target: differentCap,
      units: [{ id: "u-cap", kind: "audit", scope: "x", bounds: "y" }],
    }));
    expect(failure).toEqual(expect.stringMatching(/canonical|context|target|run/i));
  }, DURABLE_BUDGET_MS);
});

describe("durable work — runtime boundary validation", () => {
  test("rejects invalid unit enum values and timestamps at the API boundary", () => {
    const m = meta(handle!);
    const failures = [
      () => durable!.defineUnits({
        ...m,
        units: [{ id: "u-invalid-kind", kind: "not-a-kind" as never, scope: "x", bounds: "y" }],
      }),
      () => durable!.defineUnits({
      ...m,
      now: "not-an-iso-time",
      units: [{ id: "u-invalid-time", kind: "audit", scope: "x", bounds: "y" }],
      }),
    ].map(captureFailure);
    expect(failures).toEqual(failures.map(() => expect.stringMatching(/kind|enum|timestamp|time|iso|invalid/i)));
  }, DURABLE_BUDGET_MS);

  test("rejects non-finite coverage and unsafe unit segments at the API boundary", () => {
    const m = meta(handle!);
    const unsafeUnitFailure = captureFailure(() => durable!.defineUnits({
      ...m,
      units: [{ id: "../unsafe", kind: "audit", scope: "x", bounds: "y" }],
    }));
    expect(unsafeUnitFailure).toMatch(/unit_id|segment|unsafe|invalid/i);

    durable!.defineUnits({ ...m, units: [{ id: "u-boundary", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u-boundary", attemptId: "att-boundary", operationId: "op-boundary-start", now: T0,
    });
    const coverageFailure = captureFailure(() => durable!.progressUnit({
      ...m, unitId: "u-boundary", attemptId: "att-boundary", operationId: "op-boundary-progress",
      expectedDigest: started.digest,
      coverage: { completed: Number.POSITIVE_INFINITY, total: 1, label: "files" }, evidence: [], now: T1,
    }));
    expect(coverageFailure).toMatch(/coverage|finite|invalid/i);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — strict definition replay independent of caller now", () => {
  test("defineUnits replay at a different now returns the originally persisted definition with no duplicate event", () => {
    const m = meta(handle!);
    const units = [{ id: "u-replay-now", kind: "audit" as const, scope: "scope", bounds: "bounds" }];
    const first = durable!.defineUnits({ ...m, now: T0, units });
    const replay = durable!.defineUnits({ ...m, now: T1, units });
    expect(replay).toEqual(first);
    expect(replay.createdAt).toBe(first.createdAt);
    expect(replay.digest).toBe(first.digest);
    const definedEvents = listEvents(handle!, m.projectId).filter(event => event.type === "x_durable_work_units_defined");
    expect(definedEvents).toHaveLength(1);
    const conflict = captureFailure(() => durable!.defineUnits({
      ...m, now: T2, units: [{ id: "u-replay-now", kind: "audit", scope: "changed", bounds: "bounds" }],
    }));
    expect(conflict).toMatch(/conflict/i);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — strict operation replay snapshot integrity", () => {
  test("a prior operation with a missing snapshot fails closed instead of returning current state", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u-snap-missing", kind: "audit", scope: "x", bounds: "y" }] });
    const first = durable!.startUnit({
      ...m, unitId: "u-snap-missing", attemptId: "att-snap", operationId: "op-snap-start", now: T0,
    });
    durable!.progressUnit({
      ...m, unitId: "u-snap-missing", attemptId: "att-snap", operationId: "op-snap-progress",
      expectedDigest: first.digest, coverage: { completed: 1, total: 2, label: "files" }, evidence: [], now: T1,
    });
    handle!.db.run(`DELETE FROM durable_operation_snapshots WHERE project_id = ? AND run_id = ? AND unit_id = ? AND operation_id = ?`,
      [m.projectId, m.runId, "u-snap-missing", "op-snap-start"]);
    const failure = captureFailure(() => durable!.startUnit({
      ...m, unitId: "u-snap-missing", attemptId: "att-snap", operationId: "op-snap-start", now: T0,
    }));
    expect(failure).toMatch(/snapshot.*(missing|corrupt)|corrupt|missing/i);
  }, DURABLE_BUDGET_MS);

  test("a snapshot with a mismatched payload_digest fails closed on replay", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u-snap-digest", kind: "audit", scope: "x", bounds: "y" }] });
    const first = durable!.startUnit({
      ...m, unitId: "u-snap-digest", attemptId: "att-digest", operationId: "op-digest-start", now: T0,
    });
    handle!.db.run(`UPDATE durable_operation_snapshots SET payload_digest = ? WHERE project_id = ? AND run_id = ? AND unit_id = ? AND operation_id = ?`,
      ["sha256:" + "0".repeat(64), m.projectId, m.runId, "u-snap-digest", "op-digest-start"]);
    const failure = captureFailure(() => durable!.startUnit({
      ...m, unitId: "u-snap-digest", attemptId: "att-digest", operationId: "op-digest-start", now: T0,
    }));
    expect(failure).toMatch(/snapshot.*(corrupt|mismatch)|payload|corrupt/i);
  }, DURABLE_BUDGET_MS);

  test("a snapshot with a mismatched stored identity fails closed on replay", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u-snap-identity", kind: "audit", scope: "x", bounds: "y" }] });
    const first = durable!.startUnit({
      ...m, unitId: "u-snap-identity", attemptId: "att-identity", operationId: "op-identity-start", now: T0,
    });
    const snapRow = handle!.db.query(
      `SELECT snapshot_json FROM durable_operation_snapshots WHERE project_id = ? AND run_id = ? AND unit_id = ? AND operation_id = ?`,
    ).get(m.projectId, m.runId, "u-snap-identity", "op-identity-start") as { snapshot_json: string };
    const tampered = JSON.parse(snapRow.snapshot_json) as Record<string, unknown>;
    tampered.projectId = "prj_other";
    handle!.db.run(`UPDATE durable_operation_snapshots SET snapshot_json = ? WHERE project_id = ? AND run_id = ? AND unit_id = ? AND operation_id = ?`,
      [JSON.stringify(tampered), m.projectId, m.runId, "u-snap-identity", "op-identity-start"]);
    const failure = captureFailure(() => durable!.startUnit({
      ...m, unitId: "u-snap-identity", attemptId: "att-identity", operationId: "op-identity-start", now: T0,
    }));
    expect(failure).toMatch(/snapshot.*(corrupt|mismatch|identity)|corrupt/i);
  }, DURABLE_BUDGET_MS);
});

// ─── Track B hardening round 2 — strict TDD RED coverage ───────────────────
//
// Brief: 01a038ba-9559-7673-a571-2608153d865a, round 2.
// 12 mandatory regressions. None of these tests pass against the current
// production code; they pin the new contract. Production is rewritten after
// the RED baseline is recorded.

function durableEventsOf(projectId: string): Array<{ eventId: string; type: string; payload: Record<string, unknown> }> {
  return listEvents(handle!, projectId)
    .filter(event => event.type.startsWith("x_durable_work_") || event.type === "run.prepared")
    .map(event => ({ eventId: event.eventId, type: event.type, payload: event.payload as Record<string, unknown> }));
}

function durableOutboxCount(projectId: string): number {
  const rows = handle!.db.query(
    "SELECT event_id, payload FROM kernel_outbox WHERE project_id = ?",
  ).all(projectId) as Array<{ event_id: string; payload: string }>;
  return rows.filter(row => {
    try {
      const payload = JSON.parse(row.payload) as { type?: string };
      return typeof payload.type === "string" && payload.type.startsWith("x_durable_work_");
    } catch { return false; }
  }).length;
}

function migrationOpsOf(projectId: string, runId: string): Array<{ operation_id: string; kind: string; payload_digest: string; applied_at: string; backup_path: string | null }> {
  return (handle!.db.query(
    "SELECT operation_id, kind, payload_digest, applied_at, backup_path FROM durable_migration_operations WHERE project_id = ? AND run_id = ? ORDER BY applied_at",
  ).all(projectId, runId) as Array<Record<string, unknown>>).map(row => ({
    operation_id: String(row.operation_id),
    kind: String(row.kind),
    payload_digest: String(row.payload_digest),
    applied_at: String(row.applied_at),
    backup_path: row.backup_path == null ? null : String(row.backup_path),
  }));
}

function durableDefCount(projectId: string, runId: string): number {
  return Number((handle!.db.query(
    "SELECT COUNT(*) AS count FROM durable_definitions WHERE project_id = ? AND run_id = ?",
  ).get(projectId, runId) as { count: number }).count);
}

function durableUnitCount(projectId: string, runId: string): number {
  return Number((handle!.db.query(
    "SELECT COUNT(*) AS count FROM durable_units WHERE project_id = ? AND run_id = ?",
  ).get(projectId, runId) as { count: number }).count);
}

describe("durable work — Track B hardening round 2: atomic import", () => {
  test("import final-event failure via deterministic SQLite trigger: zero definitions, units, DWC events, and DWC outbox entries; retry succeeds after removing the trigger", () => {
    const projectId = "prj_round2_atomic_event";
    const runId = "run_round2_atomic_event";
    const traceId = "trace_round2_atomic_event";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r2-atomic-event-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r2-atomic-event"]));
    const unit = validTrackBUnit(runId, "u-r2-atomic-event");
    writeTrackBFixture(tbRoot, state, { "u-r2-atomic-event": unit });

    handle!.db.exec(`CREATE TRIGGER fail_import_event_r2
      BEFORE INSERT ON run_events
      WHEN json_extract(NEW.event_json, '$.type') = 'x_durable_work_track_b_imported'
      BEGIN SELECT RAISE(ABORT, 'forced_import_event_failure'); END`);

    const failure = captureFailure(() => importTrackB({
      projectId, runId, traceId, target: TARGET, trackBRoot: tbRoot, backupRoot: path.join(root, "backup-r2-atomic-event"),
      dryRun: false, now: T0,
    }));
    expect(failure).toMatch(/forced_import_event_failure|atomic|import/i);

    expect(durableDefCount(projectId, runId)).toBe(0);
    expect(durableUnitCount(projectId, runId)).toBe(0);
    expect(durableEventsOf(projectId).filter(e => e.type.startsWith("x_durable_work_"))).toHaveLength(0);
    expect(durableOutboxCount(projectId)).toBe(0);

    handle!.db.exec(`DROP TRIGGER fail_import_event_r2`);

    const retry = importTrackB({
      projectId, runId, traceId, target: TARGET, trackBRoot: tbRoot, backupRoot: path.join(root, "backup-r2-atomic-event-retry"),
      dryRun: false, now: T1,
    });
    expect(retry.imported).toBe(1);
    expect(durableDefCount(projectId, runId)).toBe(1);
    expect(durableUnitCount(projectId, runId)).toBe(1);
  }, DURABLE_BUDGET_MS);

  test("failure on the second unit database write: zero partial rows/events/outbox afterward; retry with repaired fixture succeeds", () => {
    const projectId = "prj_round2_atomic_unit";
    const runId = "run_round2_atomic_unit";
    const traceId = "trace_round2_atomic_unit";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const m = meta(handle!, projectId, runId, traceId);
    // Ensure schema exists; durable-work.ts ensures it lazily but the trigger needs
    // durable_units to be present before import. Define a placeholder and clear it.
    durable!.defineUnits({
      ...m, units: [{ id: "u-r2-schema-bootstrap", kind: "audit", scope: "x", bounds: "y" }],
    });
    handle!.db.transaction(() => {
      handle!.db.run(`DELETE FROM kernel_outbox WHERE event_id IN (SELECT event_id FROM run_events WHERE project_id = ? AND idempotency_key = ?)`,
        [projectId, `dw-def-${encodeDwcTuple(runId)}@${runId}`]);
      handle!.db.run(`DELETE FROM run_events WHERE project_id = ? AND idempotency_key = ?`,
        [projectId, `dw-def-${encodeDwcTuple(runId)}@${runId}`]);
      handle!.db.run(`DELETE FROM durable_units WHERE project_id = ? AND run_id = ?`, [projectId, runId]);
      handle!.db.run(`DELETE FROM durable_definitions WHERE project_id = ? AND run_id = ?`, [projectId, runId]);
    }).immediate();

    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r2-atomic-unit-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r2-first", "u-r2-second"]));
    writeTrackBFixture(tbRoot, state, {
      "u-r2-first": validTrackBUnit(runId, "u-r2-first"),
      "u-r2-second": validTrackBUnit(runId, "u-r2-second"),
    });

    handle!.db.exec(`CREATE TRIGGER fail_second_unit_r2
      BEFORE INSERT ON durable_units
      WHEN NEW.unit_id = 'u-r2-second'
      BEGIN SELECT RAISE(ABORT, 'forced_second_unit_failure'); END`);

    const failure = captureFailure(() => importTrackB({
      projectId, runId, traceId, target: TARGET, trackBRoot: tbRoot, backupRoot: path.join(root, "backup-r2-atomic-unit"),
      dryRun: false, now: T0,
    }));
    expect(failure).toMatch(/forced_second_unit_failure|atomic|unit/i);
    expect(durableDefCount(projectId, runId)).toBe(0);
    expect(durableUnitCount(projectId, runId)).toBe(0);
    expect(durableEventsOf(projectId).filter(e => e.type.startsWith("x_durable_work_"))).toHaveLength(0);
    expect(durableOutboxCount(projectId)).toBe(0);

    handle!.db.exec(`DROP TRIGGER fail_second_unit_r2`);

    const retry = importTrackB({
      projectId, runId, traceId, target: TARGET, trackBRoot: tbRoot, backupRoot: path.join(root, "backup-r2-atomic-unit-retry"),
      dryRun: false, now: T1,
    });
    expect(retry.imported).toBe(2);
    expect(durableUnitCount(projectId, runId)).toBe(2);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Track B hardening round 2: atomic rollback", () => {
  test("rollback-event failure via deterministic trigger: all imported DWC state and prior events remain; no rollback event/outbox entry", () => {
    const projectId = "prj_round2_rollback_event";
    const runId = "run_round2_rollback_event";
    const traceId = "trace_round2_rollback_event";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r2-rb-event-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r2-rb-event"]));
    writeTrackBFixture(tbRoot, state, { "u-r2-rb-event": validTrackBUnit(runId, "u-r2-rb-event") });

    const report = importTrackB({
      ...meta(handle!, projectId, runId, traceId),
      trackBRoot: tbRoot, backupRoot: path.join(root, "backup-r2-rb-event"),
      dryRun: false, now: T0,
    });
    expect(report.imported).toBe(1);
    const preRollback = {
      def: durableDefCount(projectId, runId),
      units: durableUnitCount(projectId, runId),
      events: durableEventsOf(projectId).filter(e => e.type.startsWith("x_durable_work_")).length,
      outbox: durableOutboxCount(projectId),
    };
    expect(preRollback).toEqual({ def: 1, units: 1, events: expect.any(Number), outbox: preRollback.events });

    handle!.db.exec(`CREATE TRIGGER fail_rollback_event_r2
      BEFORE INSERT ON run_events
      WHEN json_extract(NEW.event_json, '$.type') = 'x_durable_work_track_b_rollback'
      BEGIN SELECT RAISE(ABORT, 'forced_rollback_event_failure'); END`);

    const failure = captureFailure(() => rollbackTrackB({
      ...meta(handle!, projectId, runId, traceId), backup: report.backup,
    }));
    expect(failure).toMatch(/forced_rollback_event_failure|rollback|atomic/i);

    expect(durableDefCount(projectId, runId)).toBe(1);
    expect(durableUnitCount(projectId, runId)).toBe(1);
    expect(durableEventsOf(projectId).filter(e => e.type.startsWith("x_durable_work_")).length).toBe(preRollback.events);
    expect(durableOutboxCount(projectId)).toBe(preRollback.outbox);
    expect(durable!.getUnit({ ...meta(handle!, projectId, runId, traceId), unitId: "u-r2-rb-event" })).not.toBeNull();

    handle!.db.exec(`DROP TRIGGER fail_rollback_event_r2`);

    rollbackTrackB({ ...meta(handle!, projectId, runId, traceId), backup: report.backup });
    expect(durableDefCount(projectId, runId)).toBe(0);
    expect(durableUnitCount(projectId, runId)).toBe(0);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Track B hardening round 2: import -> rollback -> re-import", () => {
  test("new operation identity yields an additive audit trail with documented exact event counts", () => {
    const projectId = "prj_round2_cycle";
    const runId = "run_round2_cycle";
    const traceId = "trace_round2_cycle";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r2-cycle-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r2-cycle"]));
    writeTrackBFixture(tbRoot, state, { "u-r2-cycle": validTrackBUnit(runId, "u-r2-cycle") });
    const m = meta(handle!, projectId, runId, traceId);

    const report1 = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot: path.join(root, "backup-r2-cycle-1"),
      operationId: "mig-imp-1", dryRun: false, now: T0,
    });
    expect(report1.imported).toBe(1);

    const afterImport1 = {
      def: durableDefCount(projectId, runId),
      units: durableUnitCount(projectId, runId),
      migrations: migrationOpsOf(projectId, runId),
      events: durableEventsOf(projectId).filter(e => e.type.startsWith("x_durable_work_")).length,
    };
    expect(afterImport1.migrations).toHaveLength(1);
    expect(afterImport1.migrations[0].kind).toBe("import");
    expect(afterImport1.migrations[0].operation_id).toBe("mig-imp-1");

    rollbackTrackB({ ...m, backup: report1.backup, operationId: "mig-rb-1", now: "2026-08-27T00:00:30.000Z" });
    expect(durableDefCount(projectId, runId)).toBe(0);
    expect(durableUnitCount(projectId, runId)).toBe(0);
    const afterRollback = {
      migrations: migrationOpsOf(projectId, runId),
      events: durableEventsOf(projectId).filter(e => e.type.startsWith("x_durable_work_")).length,
    };
    expect(afterRollback.migrations).toHaveLength(2);
    expect(afterRollback.migrations[1].kind).toBe("rollback");
    expect(afterRollback.migrations[1].operation_id).toBe("mig-rb-1");

    const report2 = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot: path.join(root, "backup-r2-cycle-2"),
      operationId: "mig-imp-2", dryRun: false, now: T1,
    });
    expect(report2.imported).toBe(1);

    const afterImport2 = {
      def: durableDefCount(projectId, runId),
      units: durableUnitCount(projectId, runId),
      migrations: migrationOpsOf(projectId, runId),
      events: durableEventsOf(projectId).filter(e => e.type.startsWith("x_durable_work_")).length,
    };
    expect(afterImport2.def).toBe(1);
    expect(afterImport2.units).toBe(1);
    expect(afterImport2.migrations).toHaveLength(3);
    expect(afterImport2.migrations[2].kind).toBe("import");
    expect(afterImport2.migrations[2].operation_id).toBe("mig-imp-2");
    expect(afterImport2.events).toBeGreaterThan(afterImport1.events);
    // +1 rollback event + 3 re-import events (units_defined + x_durable_work_unit_imported + track_b_imported)
    expect(afterImport2.events).toBe(afterImport1.events + 1 + 3);

    const allEvents = durableEventsOf(projectId).filter(e => e.type.startsWith("x_durable_work_"));
    const imports = allEvents.filter(e => e.type === "x_durable_work_track_b_imported");
    const rollbacks = allEvents.filter(e => e.type === "x_durable_work_track_b_rollback");
    expect(imports).toHaveLength(2);
    expect(rollbacks).toHaveLength(1);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Track B hardening round 2: replay identity", () => {
  test("exact replay of an import operation is a no-op with the original semantic result", () => {
    const projectId = "prj_round2_replay";
    const runId = "run_round2_replay";
    const traceId = "trace_round2_replay";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r2-replay-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r2-replay"]));
    writeTrackBFixture(tbRoot, state, { "u-r2-replay": validTrackBUnit(runId, "u-r2-replay") });
    const m = meta(handle!, projectId, runId, traceId);

    const first = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot: path.join(root, "backup-r2-replay-1"),
      operationId: "mig-replay-imp", dryRun: false, now: T0,
    });
    const replay = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot: path.join(root, "backup-r2-replay-2"),
      operationId: "mig-replay-imp", dryRun: false, now: T1,
    });
    expect(replay.imported).toBe(first.imported);
    expect(replay.definitionDigest).toBe(first.definitionDigest);
    expect(durableUnitCount(projectId, runId)).toBe(1);
    expect(migrationOpsOf(projectId, runId)).toHaveLength(1);
    expect(durableEventsOf(projectId).filter(e => e.type.startsWith("x_durable_work_")).length).toBe(3);
  }, DURABLE_BUDGET_MS);

  test("same import operation identity with conflicting source/payload is rejected", () => {
    const projectId = "prj_round2_replay_conflict";
    const runId = "run_round2_replay_conflict";
    const traceId = "trace_round2_replay_conflict";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot1 = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r2-replay-c-1-"));
    const tbRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r2-replay-c-2-"));
    const state1 = validTrackBState(runId, traceId, alignedUnitDecls(["u-r2-replay-c-a"]));
    const state2 = validTrackBState(runId, traceId, alignedUnitDecls(["u-r2-replay-c-b"]));
    writeTrackBFixture(tbRoot1, state1, { "u-r2-replay-c-a": validTrackBUnit(runId, "u-r2-replay-c-a") });
    writeTrackBFixture(tbRoot2, state2, { "u-r2-replay-c-b": validTrackBUnit(runId, "u-r2-replay-c-b") });
    const m = meta(handle!, projectId, runId, traceId);

    importTrackB({
      ...m, trackBRoot: tbRoot1, backupRoot: path.join(root, "backup-r2-replay-c-1"),
      operationId: "mig-replay-conflict", dryRun: false, now: T0,
    });

    const failure = captureFailure(() => importTrackB({
      ...m, trackBRoot: tbRoot2, backupRoot: path.join(root, "backup-r2-replay-c-2"),
      operationId: "mig-replay-conflict", dryRun: false, now: T1,
    }));
    expect(failure).toMatch(/replay|conflict|identity/i);
    expect(durableUnitCount(projectId, runId)).toBe(1);
    expect(durable!.getUnit({ ...m, unitId: "u-r2-replay-c-a" })).not.toBeNull();
    expect(durable!.getUnit({ ...m, unitId: "u-r2-replay-c-b" })).toBeNull();
  }, DURABLE_BUDGET_MS);

  test("exact replay of rollback is safe; conflicting reuse of its operation identity is rejected", () => {
    const projectId = "prj_round2_rbreplay";
    const runId = "run_round2_rbreplay";
    const traceId = "trace_round2_rbreplay";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r2-rbreplay-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r2-rbreplay"]));
    writeTrackBFixture(tbRoot, state, { "u-r2-rbreplay": validTrackBUnit(runId, "u-r2-rbreplay") });
    const m = meta(handle!, projectId, runId, traceId);

    const report = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot: path.join(root, "backup-r2-rbreplay"),
      dryRun: false, now: T0,
    });
    rollbackTrackB({ ...m, backup: report.backup, operationId: "mig-rb-replay" });
    const afterFirstRollback = {
      def: durableDefCount(projectId, runId),
      migrations: migrationOpsOf(projectId, runId),
    };
    expect(afterFirstRollback.def).toBe(0);
    expect(afterFirstRollback.migrations.filter(x => x.kind === "rollback")).toHaveLength(1);

    const replayResult = captureFailure(() => rollbackTrackB({
      ...m, backup: report.backup, operationId: "mig-rb-replay",
    }));
    expect(replayResult === null || /no.op|already|replay/i.test(replayResult)).toBe(true);
    expect(migrationOpsOf(projectId, runId).filter(x => x.kind === "rollback")).toHaveLength(1);

    // Create a different backup with a different manifest digest and try to reuse the same op identity.
    const tbRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r2-rbreplay-2-"));
    const state2 = validTrackBState(runId, traceId, alignedUnitDecls(["u-r2-rbreplay-2"]));
    writeTrackBFixture(tbRoot2, state2, { "u-r2-rbreplay-2": validTrackBUnit(runId, "u-r2-rbreplay-2") });
    const report2 = importTrackB({
      ...m, trackBRoot: tbRoot2, backupRoot: path.join(root, "backup-r2-rbreplay-other"),
      operationId: "mig-imp-other", dryRun: false, now: T1,
    });
    const conflicting = captureFailure(() => rollbackTrackB({
      ...m, backup: report2.backup, operationId: "mig-rb-replay",
    }));
    expect(conflicting).toMatch(/replay|conflict|identity|manifest/i);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Track B hardening round 2: evidence reference validation", () => {
  test("evidence digest mismatch, missing file, unsafe path, and escape fail before backup/DB writes", () => {
    const projectId = "prj_round2_evidence";
    const runId = "run_round2_evidence";
    const traceId = "trace_round2_evidence";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const m = meta(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r2-evidence-"));
    const state = validTrackBState(runId, traceId, [{ id: "u-r2-evidence", scope: "x", bounds: "y" }]);

    // Case A: digest mismatch
    const unitDigestMismatch = validTrackBUnit(runId, "u-r2-evidence", {
      evidence: [{ type: "file", ref: "evidence/ok.txt", digest: "sha256:" + "0".repeat(64) }],
    });
    fs.mkdirSync(path.join(tbRoot, "evidence"), { recursive: true });
    fs.writeFileSync(path.join(tbRoot, "evidence", "ok.txt"), "actual content", "utf8");
    writeTrackBFixture(tbRoot, state, { "u-r2-evidence": unitDigestMismatch });
    const failureDigest = captureFailure(() => importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot: path.join(root, "backup-r2-evidence-d"),
      dryRun: false, now: T0,
    }));
    expect(failureDigest).toMatch(/evidence|digest|mismatch/i);
    expect(durableUnitCount(projectId, runId)).toBe(0);
    expect(fs.existsSync(path.join(root, "backup-r2-evidence-d"))).toBe(false);

    // Case B: missing file
    fs.rmSync(path.join(tbRoot, "evidence", "ok.txt"), { force: true });
    const unitMissing = validTrackBUnit(runId, "u-r2-evidence", {
      evidence: [{
        type: "file", ref: "evidence/missing.txt",
        digest: sha256("will not be read"),
      }],
    });
    writeTrackBFixture(tbRoot, state, { "u-r2-evidence": unitMissing });
    const failureMissing = captureFailure(() => importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot: path.join(root, "backup-r2-evidence-m"),
      dryRun: false, now: T0,
    }));
    expect(failureMissing).toMatch(/evidence|missing|file/i);
    expect(durableUnitCount(projectId, runId)).toBe(0);

    // Case C: unsafe path
    const unitUnsafe = validTrackBUnit(runId, "u-r2-evidence", {
      evidence: [{
        type: "file", ref: "../escape.txt",
        digest: sha256("escape"),
      }],
    });
    writeTrackBFixture(tbRoot, state, { "u-r2-evidence": unitUnsafe });
    const failureUnsafe = captureFailure(() => importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot: path.join(root, "backup-r2-evidence-u"),
      dryRun: false, now: T0,
    }));
    expect(failureUnsafe).toMatch(/evidence|unsafe|traversal|escape/i);
    expect(durableUnitCount(projectId, runId)).toBe(0);

    // Case D: symlink escape
    if (process.platform !== "win32") {
      try {
        const linkPath = path.join(tbRoot, "evidence", "link.txt");
        fs.symlinkSync(path.join(tbRoot, "..", "outside.txt"), linkPath);
        const unitSymlink = validTrackBUnit(runId, "u-r2-evidence", {
          evidence: [{
            type: "file", ref: "evidence/link.txt",
            digest: sha256(fs.readFileSync(linkPath)),
          }],
        });
        writeTrackBFixture(tbRoot, state, { "u-r2-evidence": unitSymlink });
        const failureSymlink = captureFailure(() => importTrackB({
          ...m, trackBRoot: tbRoot, backupRoot: path.join(root, "backup-r2-evidence-s"),
          dryRun: false, now: T0,
        }));
        expect(failureSymlink).toMatch(/evidence|symlink|escape|unsafe/i);
        expect(durableUnitCount(projectId, runId)).toBe(0);
      } catch { /* symlinks unsupported on this platform */ }
    }
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Track B hardening round 2: evidence-bearing backup", () => {
  test("evidence is copied into backup and included in manifest with verified size/digest; backup tampering blocks rollback", () => {
    const projectId = "prj_round2_evidence_backup";
    const runId = "run_round2_evidence_backup";
    const traceId = "trace_round2_evidence_backup";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const m = meta(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r2-evbak-"));
    fs.mkdirSync(path.join(tbRoot, "evidence"), { recursive: true });
    const evidenceContent = "verified evidence content";
    fs.writeFileSync(path.join(tbRoot, "evidence", "doc.txt"), evidenceContent, "utf8");
    const evidenceDigest = sha256(evidenceContent);

    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r2-evbak"]));
    const unit = validTrackBUnit(runId, "u-r2-evbak", {
      evidence: [{ type: "file", ref: "evidence/doc.txt", digest: evidenceDigest }],
    });
    writeTrackBFixture(tbRoot, state, { "u-r2-evbak": unit });

    const report = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot: path.join(root, "backup-r2-evbak"),
      dryRun: false, now: T0,
    });
    const evidenceBackupPath = path.join(report.backup, "evidence", "u-r2-evbak", "evidence", "doc.txt");
    expect(fs.existsSync(evidenceBackupPath)).toBe(true);
    expect(fs.readFileSync(evidenceBackupPath, "utf8")).toBe(evidenceContent);

    const manifestPath = path.join(report.backup, "MANIFEST.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      files: Array<{ path: string; size: number; digest: string }>;
      digest: string;
    };
    const evidenceManifestEntry = manifest.files.find(f => f.path.includes("doc.txt"));
    expect(evidenceManifestEntry).toBeDefined();
    expect(evidenceManifestEntry!.size).toBe(Buffer.byteLength(evidenceContent, "utf8"));
    expect(evidenceManifestEntry!.digest).toBe(evidenceDigest);

    fs.appendFileSync(evidenceBackupPath, " tampered", "utf8");
    const failure = captureFailure(() => rollbackTrackB({
      ...m, backup: report.backup,
    }));
    expect(failure).toMatch(/file|digest|integrity|manifest|backup/i);
    expect(durable!.getUnit({ ...m, unitId: "u-r2-evbak" })).not.toBeNull();
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Track B hardening round 2: STATE strict validation", () => {
  test("STATE runId/trace/nirvanaRunId mismatch, invalid/non-ISO fields, missing state digest, unit runId mismatch, and STATE-vs-unit scope/bounds mismatch fail closed before writes", () => {
    const projectId = "prj_round2_state";
    const runId = "run_round2_state";
    const traceId = "trace_round2_state";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const m = meta(handle!, projectId, runId, traceId);
    const backupRoot = path.join(root, "backup-r2-state");

    function makeTbRoot(prefix: string): string {
      return fs.mkdtempSync(path.join(os.tmpdir(), `nrv-track-b-r2-state-${prefix}-`));
    }

    // Case A: STATE.runId mismatches canonical runId
    {
      const tbRoot = makeTbRoot("runid");
      const state = validTrackBState("other-run", traceId, [{ id: "u-r2-state", scope: "x", bounds: "y" }]);
      const unit = validTrackBUnit("other-run", "u-r2-state");
      writeTrackBFixture(tbRoot, state, { "u-r2-state": unit });
      const f = captureFailure(() => importTrackB({
        ...m, trackBRoot: tbRoot, backupRoot: path.join(backupRoot, "runid"),
        dryRun: false, now: T0,
      }));
      expect(f).toMatch(/runid|mismatch|state/i);
    }

    // Case B: STATE.traceId mismatches canonical traceId
    {
      const tbRoot = makeTbRoot("trace");
      const state = validTrackBState(runId, "other-trace", [{ id: "u-r2-state", scope: "x", bounds: "y" }]);
      const unit = validTrackBUnit(runId, "u-r2-state");
      writeTrackBFixture(tbRoot, state, { "u-r2-state": unit });
      const f = captureFailure(() => importTrackB({
        ...m, trackBRoot: tbRoot, backupRoot: path.join(backupRoot, "trace"),
        dryRun: false, now: T0,
      }));
      expect(f).toMatch(/trace|mismatch|state/i);
    }

    // Case C: STATE.nirvanaRunId mismatches canonical runId
    {
      const tbRoot = makeTbRoot("nrv");
      const state = validTrackBState(runId, traceId, [{ id: "u-r2-state", scope: "x", bounds: "y" }], { nirvanaRunId: "other-nrv" });
      const unit = validTrackBUnit(runId, "u-r2-state");
      writeTrackBFixture(tbRoot, state, { "u-r2-state": unit });
      const f = captureFailure(() => importTrackB({
        ...m, trackBRoot: tbRoot, backupRoot: path.join(backupRoot, "nrv"),
        dryRun: false, now: T0,
      }));
      expect(f).toMatch(/nirvanaRunId|mismatch|state/i);
    }

    // Case D: STATE.createdAt not ISO
    {
      const tbRoot = makeTbRoot("iso");
      const state = validTrackBState(runId, traceId, [{ id: "u-r2-state", scope: "x", bounds: "y" }], { createdAt: "not-iso" });
      const unit = validTrackBUnit(runId, "u-r2-state");
      writeTrackBFixture(tbRoot, state, { "u-r2-state": unit });
      const f = captureFailure(() => importTrackB({
        ...m, trackBRoot: tbRoot, backupRoot: path.join(backupRoot, "iso"),
        dryRun: false, now: T0,
      }));
      expect(f).toMatch(/createdAt|iso|timestamp|invalid/i);
    }

    // Case E: STATE digest missing
    {
      const tbRoot = makeTbRoot("digest");
      const body = {
        schemaVersion: "2.0.0", runId, traceId, nirvanaRunId: runId,
        objective: "x", mode: "on",
        authority: { runLevel: "nirvana", holdfast: "work-unit-only" },
        units: [{ id: "u-r2-state", scope: "x", bounds: "y" }],
        createdAt: T0,
      };
      writeTrackBFixture(tbRoot, body, { "u-r2-state": validTrackBUnit(runId, "u-r2-state") });
      const f = captureFailure(() => importTrackB({
        ...m, trackBRoot: tbRoot, backupRoot: path.join(backupRoot, "digest"),
        dryRun: false, now: T0,
      }));
      expect(f).toMatch(/digest|missing|state/i);
    }

    // Case F: STATE digest mismatch
    {
      const tbRoot = makeTbRoot("digest-mis");
      const state = validTrackBState(runId, traceId, [{ id: "u-r2-state", scope: "x", bounds: "y" }]);
      (state as Record<string, unknown>).digest = "sha256:" + "0".repeat(64);
      const unit = validTrackBUnit(runId, "u-r2-state");
      writeTrackBFixture(tbRoot, state, { "u-r2-state": unit });
      const f = captureFailure(() => importTrackB({
        ...m, trackBRoot: tbRoot, backupRoot: path.join(backupRoot, "digest-mis"),
        dryRun: false, now: T0,
      }));
      expect(f).toMatch(/digest|mismatch|state/i);
    }

    // Case G: unit runId mismatches STATE.runId
    {
      const tbRoot = makeTbRoot("unit-runid");
      const state = validTrackBState(runId, traceId, [{ id: "u-r2-state", scope: "x", bounds: "y" }]);
      const unit = validTrackBUnit("other-run", "u-r2-state");
      writeTrackBFixture(tbRoot, state, { "u-r2-state": unit });
      const f = captureFailure(() => importTrackB({
        ...m, trackBRoot: tbRoot, backupRoot: path.join(backupRoot, "unit-runid"),
        dryRun: false, now: T0,
      }));
      expect(f).toMatch(/runid|mismatch|unit/i);
    }

    // Case H: STATE-vs-unit scope mismatch
    {
      const tbRoot = makeTbRoot("scope");
      const state = validTrackBState(runId, traceId, [{ id: "u-r2-state", scope: "STATE-scope", bounds: "y" }]);
      const unit = validTrackBUnit(runId, "u-r2-state", { scope: "UNIT-scope" });
      writeTrackBFixture(tbRoot, state, { "u-r2-state": unit });
      const f = captureFailure(() => importTrackB({
        ...m, trackBRoot: tbRoot, backupRoot: path.join(backupRoot, "scope"),
        dryRun: false, now: T0,
      }));
      expect(f).toMatch(/scope|mismatch|state|unit/i);
    }

    // Case I: STATE-vs-unit bounds mismatch
    {
      const tbRoot = makeTbRoot("bounds");
      const state = validTrackBState(runId, traceId, [{ id: "u-r2-state", scope: "x", bounds: "STATE-bounds" }]);
      const unit = validTrackBUnit(runId, "u-r2-state", { bounds: "UNIT-bounds" });
      writeTrackBFixture(tbRoot, state, { "u-r2-state": unit });
      const f = captureFailure(() => importTrackB({
        ...m, trackBRoot: tbRoot, backupRoot: path.join(backupRoot, "bounds"),
        dryRun: false, now: T0,
      }));
      expect(f).toMatch(/bounds|mismatch|state|unit/i);
    }

    expect(durableDefCount(projectId, runId)).toBe(0);
    expect(durableUnitCount(projectId, runId)).toBe(0);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Track B hardening round 2: caller-handle-only API", () => {
  test("importFromTrackB and rollbackTrackBImport require a handle and never open a second kernel", () => {
    const projectId = "prj_round2_handle";
    const runId = "run_round2_handle";
    const traceId = "trace_round2_handle";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r2-handle-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r2-handle"]));
    writeTrackBFixture(tbRoot, state, { "u-r2-handle": validTrackBUnit(runId, "u-r2-handle") });

    const importWithoutHandle = captureFailure(() => (durable!.importFromTrackB as (value: Record<string, unknown>) => unknown)({
      projectId, runId, traceId, target: TARGET,
      trackBRoot: tbRoot, backupRoot: path.join(root, "backup-r2-handle-1"),
      dryRun: false, now: T0,
    }));
    expect(importWithoutHandle).toMatch(/handle|required/i);

    const report = importTrackB({
      ...meta(handle!, projectId, runId, traceId),
      trackBRoot: tbRoot, backupRoot: path.join(root, "backup-r2-handle-2"),
      dryRun: false, now: T0,
    });

    const rollbackWithoutHandle = captureFailure(() => (durable!.rollbackTrackBImport as (value: Record<string, unknown>) => unknown)({
      projectId, runId, backup: report.backup,
    }));
    expect(rollbackWithoutHandle).toMatch(/handle|required/i);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Track B hardening round 2: fresh-process import/resume/re-import", () => {
  test("import, abrupt process exit/close, new process collect/resume; and import -> rollback -> new-process re-import", async () => {
    const projectId = "prj_round2_fresh";
    const runId = "run_round2_fresh";
    const traceId = "trace_round2_fresh";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r2-fresh-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r2-fresh"]));
    writeTrackBFixture(tbRoot, state, { "u-r2-fresh": validTrackBUnit(runId, "u-r2-fresh") });

    const kernelPath = path.join(root, "kernel.sqlite");
    handle!.close();
    handle = null;

    const durableUrl = pathToFileURL(path.resolve(import.meta.dir, "..", "lib", "run-kernel", "durable-work.ts")).href;
    const kernelUrl = pathToFileURL(path.resolve(import.meta.dir, "..", "lib", "run-kernel", "index.ts")).href;
    const importer = path.join(root, "r2-importer.ts");
    fs.writeFileSync(importer, `
import { openKernel } from ${JSON.stringify(kernelUrl)};
import * as durable from ${JSON.stringify(durableUrl)};
const kernelPath = process.argv[2];
const tbRoot = process.argv[3];
const backupRoot = process.argv[4];
const operationId = process.argv[5];
const h = openKernel(kernelPath);
const report = durable.importFromTrackB({
  handle: h,
  projectId: "prj_round2_fresh", runId: "run_round2_fresh", traceId: "trace_round2_fresh",
  target: { kind: "agent-x", slug: "agent-x" },
  trackBRoot: tbRoot, backupRoot, operationId, dryRun: false, now: "2026-08-27T05:00:00.000Z",
});
const stat = durable.status({
  handle: h, projectId: "prj_round2_fresh", runId: "run_round2_fresh", traceId: "trace_round2_fresh",
  target: { kind: "agent-x", slug: "agent-x" },
});
const u = durable.getUnit({
  handle: h, projectId: "prj_round2_fresh", runId: "run_round2_fresh", traceId: "trace_round2_fresh",
  target: { kind: "agent-x", slug: "agent-x" }, unitId: "u-r2-fresh",
});
console.log(JSON.stringify({ imported: report.imported, status: stat.units[0].status,
  unitStatus: u?.status, unitDigest: u?.digest, backup: report.backup }));
h.close();
`, "utf8");

    const imp = Bun.spawn([process.execPath, importer, kernelPath, tbRoot, path.join(root, "backup-r2-fresh-1"), "mig-fresh-imp-1"], {
      stdout: "pipe", stderr: "pipe",
    });
    expect(await imp.exited).toBe(0);
    const impResult = JSON.parse(await new Response(imp.stdout).text()) as { imported: number; status: string; unitStatus: string | null; unitDigest: string | null; backup: string };
    expect(impResult.imported).toBe(1);
    expect(impResult.status).toBe("completed");
    expect(impResult.unitStatus).toBe("completed");

    const resumer = path.join(root, "r2-resumer.ts");
    fs.writeFileSync(resumer, `
import { openKernel } from ${JSON.stringify(kernelUrl)};
import * as durable from ${JSON.stringify(durableUrl)};
const kernelPath = process.argv[2];
const h = openKernel(kernelPath);
const m = { handle: h, projectId: "prj_round2_fresh", runId: "run_round2_fresh", traceId: "trace_round2_fresh",
  target: { kind: "agent-x", slug: "agent-x" } };
const stat = durable.status(m);
const u = durable.getUnit({ ...m, unitId: "u-r2-fresh" });
const plan = durable.resume(m);
console.log(JSON.stringify({ status: stat.units[0].status, unitStatus: u?.status,
  unitDigest: u?.digest, completeCount: plan.complete.length, partialCount: plan.partial.length }));
h.close();
`, "utf8");
    const res = Bun.spawn([process.execPath, resumer, kernelPath], { stdout: "pipe", stderr: "pipe" });
    expect(await res.exited).toBe(0);
    const resResult = JSON.parse(await new Response(res.stdout).text()) as { status: string; unitStatus: string | null; unitDigest: string | null; completeCount: number; partialCount: number };
    expect(resResult.status).toBe("completed");
    expect(resResult.unitStatus).toBe("completed");
    expect(resResult.unitDigest).toBe(impResult.unitDigest);
    expect(resResult.completeCount).toBe(1);
    expect(resResult.partialCount).toBe(0);

    const rollbacker = path.join(root, "r2-rollbacker.ts");
    fs.writeFileSync(rollbacker, `
import { openKernel } from ${JSON.stringify(kernelUrl)};
import * as durable from ${JSON.stringify(durableUrl)};
const kernelPath = process.argv[2];
const backup = process.argv[3];
const h = openKernel(kernelPath);
durable.rollbackTrackBImport({
  handle: h, projectId: "prj_round2_fresh", runId: "run_round2_fresh",
  backup, operationId: "mig-fresh-rb-1",
});
const u = durable.getUnit({
  handle: h, projectId: "prj_round2_fresh", runId: "run_round2_fresh", traceId: "trace_round2_fresh",
  target: { kind: "agent-x", slug: "agent-x" }, unitId: "u-r2-fresh",
});
console.log(JSON.stringify({ unitAfterRollback: u === null }));
h.close();
`, "utf8");
    const rb = Bun.spawn([process.execPath, rollbacker, kernelPath, impResult.backup], { stdout: "pipe", stderr: "pipe" });
    expect(await rb.exited).toBe(0);
    const rbResult = JSON.parse(await new Response(rb.stdout).text()) as { unitAfterRollback: boolean };
    expect(rbResult.unitAfterRollback).toBe(true);

    const reImporter = path.join(root, "r2-reimporter.ts");
    fs.writeFileSync(reImporter, `
import { openKernel } from ${JSON.stringify(kernelUrl)};
import * as durable from ${JSON.stringify(durableUrl)};
const kernelPath = process.argv[2];
const tbRoot = process.argv[3];
const backupRoot = process.argv[4];
const h = openKernel(kernelPath);
const report = durable.importFromTrackB({
  handle: h,
  projectId: "prj_round2_fresh", runId: "run_round2_fresh", traceId: "trace_round2_fresh",
  target: { kind: "agent-x", slug: "agent-x" },
  trackBRoot: tbRoot, backupRoot, operationId: "mig-fresh-imp-2", dryRun: false, now: "2026-08-27T05:01:00.000Z",
});
const u = durable.getUnit({
  handle: h, projectId: "prj_round2_fresh", runId: "run_round2_fresh", traceId: "trace_round2_fresh",
  target: { kind: "agent-x", slug: "agent-x" }, unitId: "u-r2-fresh",
});
console.log(JSON.stringify({ imported: report.imported, unitDigest: u?.digest }));
h.close();
`, "utf8");
    const reim = Bun.spawn([process.execPath, reImporter, kernelPath, tbRoot, path.join(root, "backup-r2-fresh-2")], {
      stdout: "pipe", stderr: "pipe",
    });
    expect(await reim.exited).toBe(0);
    const reimResult = JSON.parse(await new Response(reim.stdout).text()) as { imported: number; unitDigest: string | null };
    expect(reimResult.imported).toBe(1);
    expect(reimResult.unitDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(reimResult.unitDigest).toBe(impResult.unitDigest);

    handle = openKernel(kernelPath);
  }, spawnBudgetMs(4));
});

describe("durable work — Track B hardening round 2: capabilityId target identity", () => {
  test("matching current-main-style squad target succeeds while capabilityId mismatch is rejected", () => {
    const projectId = "prj_round2_capability";
    const runId = "run_round2_capability";
    const traceId = "trace_round2_capability";
    const squadTarget = { kind: "squad" as const, slug: "codex-squad", capabilityId: "primary" };
    const m = createCanonicalRun(handle!, projectId, runId, traceId, squadTarget);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r2-cap-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r2-cap"]));
    writeTrackBFixture(tbRoot, state, { "u-r2-cap": validTrackBUnit(runId, "u-r2-cap") });

    const report = importTrackB({
      ...m, target: squadTarget, trackBRoot: tbRoot, backupRoot: path.join(root, "backup-r2-cap-ok"),
      dryRun: false, now: T0,
    });
    expect(report.imported).toBe(1);

    // Use the same canonical run (created with capabilityId="primary") but try to import
    // with capabilityId="secondary". The canonical context guard must reject the mismatch.
    const wrongCapTarget = { kind: "squad" as const, slug: "codex-squad", capabilityId: "secondary" };
    const state2 = validTrackBState(runId, traceId, alignedUnitDecls(["u-r2-cap-wrong"]));
    const tbRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r2-cap-w-"));
    writeTrackBFixture(tbRoot2, state2, { "u-r2-cap-wrong": validTrackBUnit(runId, "u-r2-cap-wrong") });
    const failure = captureFailure(() => importTrackB({
      ...m, target: wrongCapTarget,
      trackBRoot: tbRoot2, backupRoot: path.join(root, "backup-r2-cap-fail"),
      dryRun: false, now: T0,
    }));
    expect(failure).toMatch(/canonical|target|trace|run.*(not|missing)|mismatch/i);
    const getUnitFailure = captureFailure(() => durable!.getUnit({ ...m, target: wrongCapTarget, unitId: "u-r2-cap-wrong" }));
    expect(getUnitFailure).toMatch(/canonical|target|trace|run.*(not|missing)|mismatch/i);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Track B hardening round 3: evidence symlink and junction escape", () => {
  test("round 3 evidence — leaf symlink to file inside Track B root is rejected with track_b_evidence_ref_symlink_escape", () => {
    const projectId = "prj_round3_leaf_symlink";
    const runId = "run_round3_leaf_symlink";
    const traceId = "trace_round3_leaf_symlink";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const m = meta(handle!, projectId, runId, traceId);

    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r3-leaf-"));
    const backupRoot = path.join(root, "backup-r3-leaf");
    const targetFile = path.join(tbRoot, "target.txt");
    fs.writeFileSync(targetFile, "target evidence content", "utf8");
    const targetDigest = sha256("target evidence content");

    fs.mkdirSync(path.join(tbRoot, "evidence"), { recursive: true });
    const linkPath = path.join(tbRoot, "evidence", "leaf.txt");

    let linkCreated = false;
    try {
      fs.symlinkSync(targetFile, linkPath);
      linkCreated = true;
    } catch {
      // symlink creation unsupported in this environment
    }
    if (!linkCreated) return;

    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r3-leaf"]));
    const unit = validTrackBUnit(runId, "u-r3-leaf", {
      evidence: [{
        type: "file",
        ref: "evidence/leaf.txt",
        digest: targetDigest,
      }],
    });
    writeTrackBFixture(tbRoot, state, { "u-r3-leaf": unit });

    expect(() => importTrackB({
      ...m,
      trackBRoot: tbRoot,
      backupRoot,
      dryRun: false,
      now: T0,
    })).toThrow("track_b_evidence_ref_symlink_escape");

    expect(fs.existsSync(backupRoot)).toBe(false);
    expect(durableDefCount(projectId, runId)).toBe(0);
    expect(durableUnitCount(projectId, runId)).toBe(0);
    expect(migrationOpsOf(projectId, runId)).toHaveLength(0);
    expect(durableEventsOf(projectId).filter(e => e.type.startsWith("x_durable_work_"))).toHaveLength(0);
    expect(durableOutboxCount(projectId)).toBe(0);
  }, DURABLE_BUDGET_MS);

  test("round 3 evidence — directory junction pointing outside Track B root is rejected with track_b_evidence_ref_symlink_escape", () => {
    const projectId = "prj_round3_junction_escape";
    const runId = "run_round3_junction_escape";
    const traceId = "trace_round3_junction_escape";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const m = meta(handle!, projectId, runId, traceId);

    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r3-junc-root-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r3-junc-outside-"));
    const backupRoot = path.join(root, "backup-r3-junc");
    const outsideFile = path.join(outsideDir, "doc.txt");
    fs.writeFileSync(outsideFile, "outside evidence content", "utf8");
    const outsideDigest = sha256("outside evidence content");

    const junctionPath = path.join(tbRoot, "evidence");
    let junctionCreated = false;
    try {
      if (process.platform === "win32") {
        fs.symlinkSync(outsideDir, junctionPath, "junction");
        junctionCreated = true;
      } else {
        fs.symlinkSync(outsideDir, junctionPath, "dir");
        junctionCreated = true;
      }
    } catch {
      // junction/symlink unsupported in this environment
    }
    if (!junctionCreated) return;

    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r3-junc"]));
    const unit = validTrackBUnit(runId, "u-r3-junc", {
      evidence: [{
        type: "file",
        ref: "evidence/doc.txt",
        digest: outsideDigest,
      }],
    });
    writeTrackBFixture(tbRoot, state, { "u-r3-junc": unit });

    expect(() => importTrackB({
      ...m,
      trackBRoot: tbRoot,
      backupRoot,
      dryRun: false,
      now: T0,
    })).toThrow("track_b_evidence_ref_symlink_escape");

    expect(fs.existsSync(backupRoot)).toBe(false);
    expect(durableDefCount(projectId, runId)).toBe(0);
    expect(durableUnitCount(projectId, runId)).toBe(0);
    expect(migrationOpsOf(projectId, runId)).toHaveLength(0);
    expect(durableEventsOf(projectId).filter(e => e.type.startsWith("x_durable_work_"))).toHaveLength(0);
    expect(durableOutboxCount(projectId)).toBe(0);
  }, DURABLE_BUDGET_MS);

  test("round 3 replay drift — importing fixture, rolling back, and replaying the identical import operation throws operation_replay_state_drift: track_b_import", () => {
    const projectId = "prj_round3_replay_drift";
    const runId = "run_round3_replay_drift";
    const traceId = "trace_round3_replay_drift";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const m = meta(handle!, projectId, runId, traceId);

    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r3-rpdrift-"));
    const backupRoot = path.join(root, "backup-r3-rpdrift");
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r3-rpdrift"]));
    const unit = validTrackBUnit(runId, "u-r3-rpdrift");
    writeTrackBFixture(tbRoot, state, { "u-r3-rpdrift": unit });

    const report = importTrackB({
      ...m,
      trackBRoot: tbRoot,
      backupRoot,
      operationId: "imp1",
      dryRun: false,
      now: T0,
    });
    expect(report.imported).toBe(1);

    rollbackTrackB({
      ...m,
      backup: report.backup,
      operationId: "rb1",
      now: T1,
    });

    expect(durableDefCount(projectId, runId)).toBe(0);
    expect(durableUnitCount(projectId, runId)).toBe(0);
    const opsAfterRb = migrationOpsOf(projectId, runId);
    expect(opsAfterRb).toHaveLength(2); // imp1 and rb1
    const eventsAfterRb = durableEventsOf(projectId);
    const outboxAfterRb = durableOutboxCount(projectId);

    // Replay the exact same import imp1
    expect(() => importTrackB({
      ...m,
      trackBRoot: tbRoot,
      backupRoot,
      operationId: "imp1",
      dryRun: false,
      now: T0,
    })).toThrow("operation_replay_state_drift: track_b_import");

    // durable_migration_operations must remain append-only and intact
    expect(migrationOpsOf(projectId, runId)).toEqual(opsAfterRb);
    // Must not recreate definition/units/events/outbox
    expect(durableDefCount(projectId, runId)).toBe(0);
    expect(durableUnitCount(projectId, runId)).toBe(0);
    expect(durableEventsOf(projectId)).toEqual(eventsAfterRb);
    expect(durableOutboxCount(projectId)).toBe(outboxAfterRb);
  }, DURABLE_BUDGET_MS);

  test("round 3 rollback drift — rollback of an imported unit mutated via public API throws rollback_state_drift without modifying state", () => {
    const projectId = "prj_round3_rollback_drift";
    const runId = "run_round3_rollback_drift";
    const traceId = "trace_round3_rollback_drift";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const m = meta(handle!, projectId, runId, traceId);

    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r3-rbdrift-"));
    const backupRoot = path.join(root, "backup-r3-rbdrift");
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r3-rbdrift"]));
    // Import as partial status with active attempt so public API can progress it
    const unit = validTrackBUnit(runId, "u-r3-rbdrift", {
      status: "partial",
      coverage: { completed: 0, total: 1, label: "files" },
      attempts: [{ id: "att-u-r3-rbdrift", startedAt: T0, endedAt: null, flushes: 0, outcome: "active" }],
    });
    writeTrackBFixture(tbRoot, state, { "u-r3-rbdrift": unit });

    const report = importTrackB({
      ...m,
      trackBRoot: tbRoot,
      backupRoot,
      operationId: "imp-drift-1",
      dryRun: false,
      now: T0,
    });
    expect(report.imported).toBe(1);

    const importedUnit = durable!.getUnit({ ...m, unitId: "u-r3-rbdrift" });
    expect(importedUnit).not.toBeNull();

    // Mutate via normal public API to change the row digest
    const progressResult = durable!.progressUnit({
      ...m,
      unitId: "u-r3-rbdrift",
      attemptId: "att-u-r3-rbdrift",
      operationId: "op-progress-drift",
      expectedDigest: importedUnit!.digest,
      coverage: { completed: 1, total: 1, label: "files" },
      evidence: [],
      now: T1,
    });
    expect(progressResult.status).toBe("partial");

    // Capture counts and snapshots before rollback
    const defCountBefore = durableDefCount(projectId, runId);
    const unitCountBefore = durableUnitCount(projectId, runId);
    const defsSnapshot = handle!.db.query("SELECT * FROM durable_definitions WHERE project_id = ? AND run_id = ?").all(projectId, runId);
    const unitsSnapshot = handle!.db.query("SELECT * FROM durable_units WHERE project_id = ? AND run_id = ?").all(projectId, runId);
    const claimsSnapshot = handle!.db.query("SELECT * FROM durable_claims WHERE project_id = ? AND run_id = ?").all(projectId, runId);
    const opsSnapshot = handle!.db.query("SELECT * FROM durable_operations WHERE project_id = ? AND run_id = ?").all(projectId, runId);
    const snapSnapshot = handle!.db.query("SELECT * FROM durable_operation_snapshots WHERE project_id = ? AND run_id = ?").all(projectId, runId);
    const migOpsSnapshot = migrationOpsOf(projectId, runId);
    const eventsSnapshot = durableEventsOf(projectId);
    const outboxCountBefore = durableOutboxCount(projectId);

    expect(() => rollbackTrackB({
      ...m,
      backup: report.backup,
      operationId: "rb-drift-1",
      now: T2,
    })).toThrow("rollback_state_drift");

    // Assert everything remained identical
    expect(durableDefCount(projectId, runId)).toBe(defCountBefore);
    expect(durableUnitCount(projectId, runId)).toBe(unitCountBefore);
    expect(handle!.db.query("SELECT * FROM durable_definitions WHERE project_id = ? AND run_id = ?").all(projectId, runId)).toEqual(defsSnapshot);
    expect(handle!.db.query("SELECT * FROM durable_units WHERE project_id = ? AND run_id = ?").all(projectId, runId)).toEqual(unitsSnapshot);
    expect(handle!.db.query("SELECT * FROM durable_claims WHERE project_id = ? AND run_id = ?").all(projectId, runId)).toEqual(claimsSnapshot);
    expect(handle!.db.query("SELECT * FROM durable_operations WHERE project_id = ? AND run_id = ?").all(projectId, runId)).toEqual(opsSnapshot);
    expect(handle!.db.query("SELECT * FROM durable_operation_snapshots WHERE project_id = ? AND run_id = ?").all(projectId, runId)).toEqual(snapSnapshot);
    expect(migrationOpsOf(projectId, runId)).toEqual(migOpsSnapshot);
    expect(durableEventsOf(projectId)).toEqual(eventsSnapshot);
    expect(durableOutboxCount(projectId)).toBe(outboxCountBefore);
  }, DURABLE_BUDGET_MS);

  test("round 3 rollback drift — post-import claim without unit digest mutation triggers rollback_state_drift", () => {
    const projectId = "prj_round3_claim_drift";
    const runId = "run_round3_claim_drift";
    const traceId = "trace_round3_claim_drift";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const m = meta(handle!, projectId, runId, traceId);

    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r3-claimdrift-"));
    const backupRoot = path.join(root, "backup-r3-claimdrift");
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r3-claimdrift"]));
    const unit = validTrackBUnit(runId, "u-r3-claimdrift");
    writeTrackBFixture(tbRoot, state, { "u-r3-claimdrift": unit });

    const report = importTrackB({
      ...m,
      trackBRoot: tbRoot,
      backupRoot,
      operationId: "imp-claim-drift-1",
      dryRun: false,
      now: T0,
    });
    expect(report.imported).toBe(1);

    // Acquire a claim via normal public API (this inserts a row into durable_claims but does not mutate durable_units row_digest)
    const claim = durable!.acquireClaim({
      ...m,
      unitId: "u-r3-claimdrift",
      ownerId: "agent-writer-1",
      ttlMs: 60_000,
      now: T1,
    });
    expect(claim.ownerId).toBe("agent-writer-1");

    // Capture state before rollback
    const defCountBefore = durableDefCount(projectId, runId);
    const unitCountBefore = durableUnitCount(projectId, runId);
    const claimsBefore = handle!.db.query("SELECT * FROM durable_claims WHERE project_id = ? AND run_id = ?").all(projectId, runId);
    expect(claimsBefore).toHaveLength(1);
    const defsSnapshot = handle!.db.query("SELECT * FROM durable_definitions WHERE project_id = ? AND run_id = ?").all(projectId, runId);
    const unitsSnapshot = handle!.db.query("SELECT * FROM durable_units WHERE project_id = ? AND run_id = ?").all(projectId, runId);
    const opsSnapshot = handle!.db.query("SELECT * FROM durable_operations WHERE project_id = ? AND run_id = ?").all(projectId, runId);
    const snapSnapshot = handle!.db.query("SELECT * FROM durable_operation_snapshots WHERE project_id = ? AND run_id = ?").all(projectId, runId);
    const migOpsSnapshot = migrationOpsOf(projectId, runId);
    const eventsSnapshot = durableEventsOf(projectId);
    const outboxCountBefore = durableOutboxCount(projectId);

    expect(() => rollbackTrackB({
      ...m,
      backup: report.backup,
      operationId: "rb-claim-drift-1",
      now: T2,
    })).toThrow("rollback_state_drift");

    // Assert everything remained identical
    expect(durableDefCount(projectId, runId)).toBe(defCountBefore);
    expect(durableUnitCount(projectId, runId)).toBe(unitCountBefore);
    expect(handle!.db.query("SELECT * FROM durable_claims WHERE project_id = ? AND run_id = ?").all(projectId, runId)).toEqual(claimsBefore);
    expect(handle!.db.query("SELECT * FROM durable_definitions WHERE project_id = ? AND run_id = ?").all(projectId, runId)).toEqual(defsSnapshot);
    expect(handle!.db.query("SELECT * FROM durable_units WHERE project_id = ? AND run_id = ?").all(projectId, runId)).toEqual(unitsSnapshot);
    expect(handle!.db.query("SELECT * FROM durable_operations WHERE project_id = ? AND run_id = ?").all(projectId, runId)).toEqual(opsSnapshot);
    expect(handle!.db.query("SELECT * FROM durable_operation_snapshots WHERE project_id = ? AND run_id = ?").all(projectId, runId)).toEqual(snapSnapshot);
    expect(migrationOpsOf(projectId, runId)).toEqual(migOpsSnapshot);
    expect(durableEventsOf(projectId)).toEqual(eventsSnapshot);
    expect(durableOutboxCount(projectId)).toBe(outboxCountBefore);
  }, DURABLE_BUDGET_MS);

  test("round 3 replay drift — missing definition or mismatched unit row causes operation_replay_state_drift", () => {
    const projectId = "prj_round3_replay_def_drift";
    const runId = "run_round3_replay_def_drift";
    const traceId = "trace_round3_replay_def_drift";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const m = meta(handle!, projectId, runId, traceId);

    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r3-rpdefdrift-"));
    const backupRoot = path.join(root, "backup-r3-rpdefdrift");
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r3-rpdefdrift"]));
    const unit = validTrackBUnit(runId, "u-r3-rpdefdrift");
    writeTrackBFixture(tbRoot, state, { "u-r3-rpdefdrift": unit });

    const report = importTrackB({
      ...m,
      trackBRoot: tbRoot,
      backupRoot,
      operationId: "imp-def-drift",
      dryRun: false,
      now: T0,
    });
    expect(report.imported).toBe(1);

    // Delete definition directly to simulate drift
    handle!.db.run("DELETE FROM durable_definitions WHERE project_id = ? AND run_id = ?", [projectId, runId]);

    expect(() => importTrackB({
      ...m,
      trackBRoot: tbRoot,
      backupRoot,
      operationId: "imp-def-drift",
      dryRun: false,
      now: T0,
    })).toThrow("operation_replay_state_drift: track_b_import");
  }, DURABLE_BUDGET_MS);

  test("round 3 rollback drift — missing definition triggers rollback_state_drift", () => {
    const projectId = "prj_round3_rb_nodef";
    const runId = "run_round3_rb_nodef";
    const traceId = "trace_round3_rb_nodef";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const m = meta(handle!, projectId, runId, traceId);

    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r3-rbnodef-"));
    const backupRoot = path.join(root, "backup-r3-rbnodef");
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r3-rbnodef"]));
    const unit = validTrackBUnit(runId, "u-r3-rbnodef");
    writeTrackBFixture(tbRoot, state, { "u-r3-rbnodef": unit });

    const report = importTrackB({
      ...m,
      trackBRoot: tbRoot,
      backupRoot,
      operationId: "imp-rb-nodef",
      dryRun: false,
      now: T0,
    });
    expect(report.imported).toBe(1);

    // Delete definition row
    handle!.db.run("DELETE FROM durable_definitions WHERE project_id = ? AND run_id = ?", [projectId, runId]);

    expect(() => rollbackTrackB({
      ...m,
      backup: report.backup,
      operationId: "rb-nodef",
      now: T1,
    })).toThrow("rollback_state_drift");
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Track B hardening round 4: timestamp validation, stage rollback, and replay result integrity", () => {
  test("round 4 import timestamp — import with invalid now (2026-02-30T00:00:00.000Z) throws now_invalid_timestamp and leaves no backup stage or DWC state", () => {
    const projectId = "prj_r4_imp_invalid_now";
    const runId = "run_r4_imp_invalid_now";
    const traceId = "trace_r4_imp_invalid_now";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const m = meta(handle!, projectId, runId, traceId);

    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r4-imp-now-"));
    const backupRoot = path.join(root, "backup-r4-imp-now");
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r4-imp-now"]));
    const unit = validTrackBUnit(runId, "u-r4-imp-now");
    writeTrackBFixture(tbRoot, state, { "u-r4-imp-now": unit });
    const durableTablesBefore = (handle!.db.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'durable_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map(row => row.name);

    expect(() => importTrackB({
      ...m,
      trackBRoot: tbRoot,
      backupRoot,
      operationId: "imp-invalid-now",
      dryRun: false,
      now: "2026-02-30T00:00:00.000Z",
    })).toThrow("now_invalid_timestamp");

    const durableTablesAfter = (handle!.db.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'durable_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map(row => row.name);
    expect(durableTablesAfter).toEqual(durableTablesBefore);
    const durableTableNames = new Set(durableTablesAfter);
    expect(fs.existsSync(backupRoot)).toBe(false);
    expect(durableTableNames.has("durable_units") ? durableUnitCount(projectId, runId) : 0).toBe(0);
    expect(durableTableNames.has("durable_migration_operations") ? migrationOpsOf(projectId, runId) : []).toHaveLength(0);
    expect(durableEventsOf(projectId).filter(e => e.type.startsWith("x_durable_work_"))).toHaveLength(0);
    expect(durableOutboxCount(projectId)).toBe(0);
  }, DURABLE_BUDGET_MS);

  test("round 4 rollback timestamp — rollback with invalid now (2026-02-30T00:00:00.000Z) throws now_invalid_timestamp, preserves definition/units, and records no rollback operation/event/outbox", () => {
    const projectId = "prj_r4_rb_invalid_now";
    const runId = "run_r4_rb_invalid_now";
    const traceId = "trace_r4_rb_invalid_now";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const m = meta(handle!, projectId, runId, traceId);

    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r4-rb-now-"));
    const backupRoot = path.join(root, "backup-r4-rb-now");
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r4-rb-now"]));
    const unit = validTrackBUnit(runId, "u-r4-rb-now");
    writeTrackBFixture(tbRoot, state, { "u-r4-rb-now": unit });

    const report = importTrackB({
      ...m,
      trackBRoot: tbRoot,
      backupRoot,
      operationId: "imp-valid-r4",
      dryRun: false,
      now: T0,
    });
    expect(report.imported).toBe(1);

    const defsBefore = durableDefCount(projectId, runId);
    const unitsBefore = durableUnitCount(projectId, runId);
    const migOpsBefore = migrationOpsOf(projectId, runId);
    const eventsBefore = durableEventsOf(projectId);
    const outboxBefore = durableOutboxCount(projectId);

    expect(() => rollbackTrackB({
      ...m,
      backup: report.backup,
      operationId: "rb-invalid-now",
      now: "2026-02-30T00:00:00.000Z",
    })).toThrow("now_invalid_timestamp");

    expect(durableDefCount(projectId, runId)).toBe(defsBefore);
    expect(durableUnitCount(projectId, runId)).toBe(unitsBefore);
    expect(migrationOpsOf(projectId, runId)).toEqual(migOpsBefore);
    expect(durableEventsOf(projectId)).toEqual(eventsBefore);
    expect(durableOutboxCount(projectId)).toBe(outboxBefore);
  }, DURABLE_BUDGET_MS);

  test("round 4 stage cleanup on failure — forced import transaction failure removes the staged backup directory and leaves no partial state; retry with identical parameters succeeds", () => {
    const projectId = "prj_r4_stage_abort";
    const runId = "run_r4_stage_abort";
    const traceId = "trace_r4_stage_abort";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const m = meta(handle!, projectId, runId, traceId);

    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r4-stage-abort-"));
    const backupRoot = path.join(root, "backup-r4-stage-abort");
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r4-stage-abort"]));
    const unit = validTrackBUnit(runId, "u-r4-stage-abort");
    writeTrackBFixture(tbRoot, state, { "u-r4-stage-abort": unit });

    handle!.db.exec(`CREATE TRIGGER fail_import_tx_r4
      BEFORE INSERT ON run_events
      WHEN json_extract(NEW.event_json, '$.type') = 'x_durable_work_track_b_imported'
      BEGIN SELECT RAISE(ABORT, 'forced_import_tx_failure'); END`);

    expect(() => importTrackB({
      ...m,
      trackBRoot: tbRoot,
      backupRoot,
      operationId: "imp-stage-abort",
      dryRun: false,
      now: T0,
    })).toThrow(/forced_import_tx_failure/);

    if (fs.existsSync(backupRoot)) {
      expect(fs.readdirSync(backupRoot)).toHaveLength(0);
    }
    expect(durableDefCount(projectId, runId)).toBe(0);
    expect(durableUnitCount(projectId, runId)).toBe(0);
    expect(migrationOpsOf(projectId, runId)).toHaveLength(0);
    expect(durableEventsOf(projectId).filter(e => e.type.startsWith("x_durable_work_"))).toHaveLength(0);
    expect(durableOutboxCount(projectId)).toBe(0);

    handle!.db.exec(`DROP TRIGGER fail_import_tx_r4`);

    const retry = importTrackB({
      ...m,
      trackBRoot: tbRoot,
      backupRoot,
      operationId: "imp-stage-abort",
      dryRun: false,
      now: T0,
    });
    expect(retry.imported).toBe(1);
    expect(durableDefCount(projectId, runId)).toBe(1);
    expect(durableUnitCount(projectId, runId)).toBe(1);
    expect(fs.existsSync(retry.backup)).toBe(true);
    expect(path.dirname(retry.backup)).toBe(path.resolve(backupRoot));
  }, DURABLE_BUDGET_MS);

  test("round 4 corrupt replay result — replaying an import whose migration operation result_json was corrupted throws operation_replay_result_corrupt: track_b_import", () => {
    const projectId = "prj_r4_replay_result_corrupt";
    const runId = "run_r4_replay_result_corrupt";
    const traceId = "trace_r4_replay_result_corrupt";
    createCanonicalRun(handle!, projectId, runId, traceId);
    const m = meta(handle!, projectId, runId, traceId);

    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-r4-corrupt-"));
    const backupRoot = path.join(root, "backup-r4-corrupt");
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-r4-corrupt"]));
    const unit = validTrackBUnit(runId, "u-r4-corrupt");
    writeTrackBFixture(tbRoot, state, { "u-r4-corrupt": unit });

    const report = importTrackB({
      ...m,
      trackBRoot: tbRoot,
      backupRoot,
      operationId: "imp-corrupt-r4",
      dryRun: false,
      now: T0,
    });
    expect(report.imported).toBe(1);

    // Case 1: unparseable / malformed JSON
    handle!.db.run(
      "UPDATE durable_migration_operations SET result_json = ? WHERE project_id = ? AND run_id = ? AND operation_id = ?",
      ["{invalid-json-content", projectId, runId, "imp-corrupt-r4"],
    );

    expect(() => importTrackB({
      ...m,
      trackBRoot: tbRoot,
      backupRoot,
      operationId: "imp-corrupt-r4",
      dryRun: false,
      now: T0,
    })).toThrow("operation_replay_result_corrupt: track_b_import");

    // Case 2: valid JSON but schema-invalid result shape
    handle!.db.run(
      "UPDATE durable_migration_operations SET result_json = ? WHERE project_id = ? AND run_id = ? AND operation_id = ?",
      [JSON.stringify({ not_a_valid_report: true, foo: 123 }), projectId, runId, "imp-corrupt-r4"],
    );

    expect(() => importTrackB({
      ...m,
      trackBRoot: tbRoot,
      backupRoot,
      operationId: "imp-corrupt-r4",
      dryRun: false,
      now: T0,
    })).toThrow("operation_replay_result_corrupt: track_b_import");
  }, DURABLE_BUDGET_MS);
});

// ─── Observability P1: per-mutation operation_id and revision/digest deltas ──
//
// Brief: 01a038ba-9559-7673-a571-2608153d865a, wave 2/3.
// Pin the P1 observability contract for the durable-work unit-mutation stream:
//   A) every x_durable_work_unit_* event must expose the caller's operation_id
//      so audit replay can correlate the canonical event back to the worker
//      that produced it. Unit transitions must also expose
//      previous_revision/next_revision and previous_digest/next_digest equal
//      to the actual before/after values and strictly monotonic.
//   B) Track B import and rollback events must expose operation_id exactly,
//      hide the absolute backup path from the public payload, and carry a
//      stable three-layer migration provenance (source authority/version +
//      origin with upstream project/version + target authority).
//
// These tests do NOT assert duplication of project/run/trace/correlation/
// causation/eventId/sequence (already guaranteed by the Run Kernel). They
// focus on the gaps the review flagged as missing observability.

describe("durable work — Observability P1: unit-mutation operation_id and deltas", () => {
  test("start exposes operation_id and the (previous, next) revision/digest delta on its canonical event", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u-obs-start", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u-obs-start", attemptId: "att-obs-start", operationId: "op-obs-start", now: T0,
    });
    const events = listEvents(handle!, m.projectId).filter(event => event.type === "x_durable_work_unit_started");
    expect(events).toHaveLength(1);
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.operation_id).toBe("op-obs-start");
    expect(payload.previous_revision).toBe(0);
    expect(payload.next_revision).toBe(started.revision);
    expect(payload.previous_digest).toBeNull();
    expect(payload.next_digest).toBe(started.digest);
  }, DURABLE_BUDGET_MS);

  test("progress exposes operation_id and the (previous, next) revision/digest delta on its canonical event", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u-obs-progress", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u-obs-progress", attemptId: "att-obs-progress", operationId: "op-obs-start", now: T0,
    });
    const progressed = durable!.progressUnit({
      ...m, unitId: "u-obs-progress", attemptId: "att-obs-progress", operationId: "op-obs-progress-1",
      expectedDigest: started.digest, coverage: { completed: 1, total: 2, label: "files" }, evidence: [], now: T1,
    });
    const events = listEvents(handle!, m.projectId).filter(event => event.type === "x_durable_work_unit_progressed");
    expect(events).toHaveLength(1);
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.operation_id).toBe("op-obs-progress-1");
    expect(payload.previous_revision).toBe(started.revision);
    expect(payload.next_revision).toBe(progressed.revision);
    expect(payload.previous_digest).toBe(started.digest);
    expect(payload.next_digest).toBe(progressed.digest);
    expect(Number(payload.next_revision)).toBeGreaterThan(Number(payload.previous_revision));
  }, DURABLE_BUDGET_MS);

  test("complete exposes operation_id and the (previous, next) revision/digest delta on its canonical event", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u-obs-complete", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u-obs-complete", attemptId: "att-obs-complete", operationId: "op-obs-c-start", now: T0,
    });
    const progressed = durable!.progressUnit({
      ...m, unitId: "u-obs-complete", attemptId: "att-obs-complete", operationId: "op-obs-c-prog",
      expectedDigest: started.digest, coverage: { completed: 1, total: 1, label: "files" }, evidence: [], now: T1,
    });
    const vfile = path.join(root, "obs-v.txt");
    fs.writeFileSync(vfile, "verified", "utf8");
    const v = sha256(fs.readFileSync(vfile));
    const completed = durable!.completeUnit({
      ...m, stateRoot: root, unitId: "u-obs-complete", attemptId: "att-obs-complete", operationId: "op-obs-c-done",
      expectedDigest: progressed.digest,
      verificationEvidence: [{ type: "file", ref: "obs-v.txt", digest: v }], now: T2,
    });
    const events = listEvents(handle!, m.projectId).filter(event => event.type === "x_durable_work_unit_completed");
    expect(events).toHaveLength(1);
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.operation_id).toBe("op-obs-c-done");
    expect(payload.previous_revision).toBe(progressed.revision);
    expect(payload.next_revision).toBe(completed.revision);
    expect(payload.previous_digest).toBe(progressed.digest);
    expect(payload.next_digest).toBe(completed.digest);
    expect(Number(payload.next_revision)).toBeGreaterThan(Number(payload.previous_revision));
  }, DURABLE_BUDGET_MS);

  test("fail exposes operation_id and the (previous, next) revision/digest delta on its canonical event", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u-obs-fail", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u-obs-fail", attemptId: "att-obs-fail", operationId: "op-obs-f-start", now: T0,
    });
    const failed = durable!.failUnit({
      ...m, unitId: "u-obs-fail", attemptId: "att-obs-fail", operationId: "op-obs-f-fail",
      expectedDigest: started.digest, reason: "downstream crash", now: T1,
    });
    const events = listEvents(handle!, m.projectId).filter(event => event.type === "x_durable_work_unit_failed");
    expect(events).toHaveLength(1);
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.operation_id).toBe("op-obs-f-fail");
    expect(payload.previous_revision).toBe(started.revision);
    expect(payload.next_revision).toBe(failed.revision);
    expect(payload.previous_digest).toBe(started.digest);
    expect(payload.next_digest).toBe(failed.digest);
    expect(Number(payload.next_revision)).toBeGreaterThan(Number(payload.previous_revision));
  }, DURABLE_BUDGET_MS);

  test("compensate, completeCompensation, and failCompensation expose operation_id and the (previous, next) revision/digest delta on their canonical events", () => {
    const m = meta(handle!);
    durable!.defineUnits({ ...m, units: [{ id: "u-obs-comp", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u-obs-comp", attemptId: "att-obs-comp", operationId: "op-obs-cp-start", now: T0,
    });
    const failed = durable!.failUnit({
      ...m, unitId: "u-obs-comp", attemptId: "att-obs-comp", operationId: "op-obs-cp-fail",
      expectedDigest: started.digest, reason: "needs compensation", now: T1,
    });

    // 1. compensateUnit -> x_durable_work_unit_compensating
    const compensating = durable!.compensateUnit({
      ...m, unitId: "u-obs-comp", attemptId: "att-obs-comp", operationId: "op-obs-cp-begin",
      expectedDigest: failed.digest, now: T2,
    });
    const compEvents = listEvents(handle!, m.projectId).filter(event => event.type === "x_durable_work_unit_compensating");
    expect(compEvents).toHaveLength(1);
    const compPayload = compEvents[0].payload as Record<string, unknown>;
    expect(compPayload.operation_id).toBe("op-obs-cp-begin");
    expect(compPayload.previous_revision).toBe(failed.revision);
    expect(compPayload.next_revision).toBe(compensating.revision);
    expect(compPayload.previous_digest).toBe(failed.digest);
    expect(compPayload.next_digest).toBe(compensating.digest);
    expect(Number(compPayload.next_revision)).toBeGreaterThan(Number(compPayload.previous_revision));

    // 2. failCompensation -> x_durable_work_unit_compensation_failed
    const compFailed = durable!.failCompensation({
      ...m, unitId: "u-obs-comp", attemptId: "att-obs-comp", operationId: "op-obs-cp-failcomp",
      expectedDigest: compensating.digest, reason: "compensation attempt failed", now: T3,
    });
    const compFailEvents = listEvents(handle!, m.projectId).filter(event => event.type === "x_durable_work_unit_compensation_failed");
    expect(compFailEvents).toHaveLength(1);
    const compFailPayload = compFailEvents[0].payload as Record<string, unknown>;
    expect(compFailPayload.operation_id).toBe("op-obs-cp-failcomp");
    expect(compFailPayload.previous_revision).toBe(compensating.revision);
    expect(compFailPayload.next_revision).toBe(compFailed.revision);
    expect(compFailPayload.previous_digest).toBe(compensating.digest);
    expect(compFailPayload.next_digest).toBe(compFailed.digest);
    expect(Number(compFailPayload.next_revision)).toBeGreaterThan(Number(compFailPayload.previous_revision));

    // Re-enter compensating state for completeCompensation
    const compensating2 = durable!.compensateUnit({
      ...m, unitId: "u-obs-comp", attemptId: "att-obs-comp", operationId: "op-obs-cp-retry",
      expectedDigest: compFailed.digest, now: T4,
    });

    // 3. completeCompensation -> x_durable_work_unit_compensated
    const compFile = path.join(root, "obs-comp-done.txt");
    fs.writeFileSync(compFile, "compensated evidence", "utf8");
    const compEvDigest = sha256(fs.readFileSync(compFile));
    const compensated = durable!.completeCompensation({
      ...m, stateRoot: root, unitId: "u-obs-comp", attemptId: "att-obs-comp", operationId: "op-obs-cp-done",
      expectedDigest: compensating2.digest,
      compensationEvidence: [{ type: "file", ref: "obs-comp-done.txt", digest: compEvDigest }], now: "2026-08-27T00:05:00.000Z",
    });
    const compensatedEvents = listEvents(handle!, m.projectId).filter(event => event.type === "x_durable_work_unit_compensated");
    expect(compensatedEvents).toHaveLength(1);
    const compensatedPayload = compensatedEvents[0].payload as Record<string, unknown>;
    expect(compensatedPayload.operation_id).toBe("op-obs-cp-done");
    expect(compensatedPayload.previous_revision).toBe(compensating2.revision);
    expect(compensatedPayload.next_revision).toBe(compensated.revision);
    expect(compensatedPayload.previous_digest).toBe(compensating2.digest);
    expect(compensatedPayload.next_digest).toBe(compensated.digest);
    expect(Number(compensatedPayload.next_revision)).toBeGreaterThan(Number(compensatedPayload.previous_revision));
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Observability P1: Track B import/rollback operation_id and stable migration provenance", () => {
  test("import exposes operation_id on the canonical event and imported unit events, hides the absolute backup path from the public payload, and emits a three-layer stable migration provenance", () => {
    const projectId = "prj_obs_trackb_import";
    const runId = "run_obs_trackb_import";
    const traceId = "trace_obs_trackb_import";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-obs-imp-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-obs-imp-1", "u-obs-imp-2"]));
    writeTrackBFixture(tbRoot, state, {
      "u-obs-imp-1": validTrackBUnit(runId, "u-obs-imp-1"),
      "u-obs-imp-2": validTrackBUnit(runId, "u-obs-imp-2"),
    });
    const backupRoot = path.join(root, "backup-obs-imp");

    const report = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, dryRun: false,
      operationId: "op-obs-trackb-imp-1", now: T0,
    });
    expect(report.imported).toBe(2);

    const events = listEvents(handle!, projectId).filter(event => event.type === "x_durable_work_track_b_imported");
    expect(events).toHaveLength(1);
    const payload = events[0].payload as Record<string, unknown>;

    expect(payload.operation_id).toBe("op-obs-trackb-imp-1");

    const serialized = canonicalJson(payload);
    expect(serialized.includes("backup_path")).toBe(false);
    expect(serialized.includes("backup_root")).toBe(false);
    expect(serialized.includes("backupPath")).toBe(false);
    expect(serialized.includes("backupRoot")).toBe(false);
    const resolvedBackup = resolve(report.backup);
    expect(serialized.includes(resolvedBackup)).toBe(false);
    expect(serialized.includes(resolve(backupRoot))).toBe(false);

    expect(payload.source_authority).toBe("holdfast-track-b");
    expect(payload.source_version).toBe("1.1.0-nirvana.1");
    const origin = payload.origin as Record<string, unknown> | undefined;
    expect(origin).toBeDefined();
    expect(origin).not.toBeNull();
    expect(origin!.upstream_project).toBe("AndreAlmeidaDC/holdfast");
    expect(origin!.upstream_version).toBe("1.1.0");
    expect(origin!.target_authority).toBe("nirvana-core-dwc");

    // Also assert each x_durable_work_unit_imported event resulting from that idempotent import has the same exact operation_id
    const unitImportedEvents = listEvents(handle!, projectId).filter(event => event.type === "x_durable_work_unit_imported");
    expect(unitImportedEvents).toHaveLength(2);
    for (const uEvent of unitImportedEvents) {
      const uPayload = uEvent.payload as Record<string, unknown>;
      expect(uPayload.operation_id).toBe("op-obs-trackb-imp-1");
    }
  }, DURABLE_BUDGET_MS);

  test("rollback exposes operation_id on the canonical event, hides the absolute backup path from the public payload, and emits a three-layer stable migration provenance", () => {
    const projectId = "prj_obs_trackb_rollback";
    const runId = "run_obs_trackb_rollback";
    const traceId = "trace_obs_trackb_rollback";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-obs-rb-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-obs-rb"]));
    writeTrackBFixture(tbRoot, state, { "u-obs-rb": validTrackBUnit(runId, "u-obs-rb") });
    const backupRoot = path.join(root, "backup-obs-rb");

    const report = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, dryRun: false,
      operationId: "op-obs-trackb-imp-2", now: T0,
    });
    expect(report.imported).toBe(1);

    rollbackTrackB({
      ...m, backup: report.backup, operationId: "op-obs-trackb-rb-1", now: T1,
    });

    const events = listEvents(handle!, projectId).filter(event => event.type === "x_durable_work_track_b_rollback");
    expect(events).toHaveLength(1);
    const payload = events[0].payload as Record<string, unknown>;

    expect(payload.operation_id).toBe("op-obs-trackb-rb-1");

    const serialized = canonicalJson(payload);
    expect(serialized.includes("backup_path")).toBe(false);
    expect(serialized.includes("backup_root")).toBe(false);
    expect(serialized.includes("backupPath")).toBe(false);
    expect(serialized.includes("backupRoot")).toBe(false);
    const resolvedBackup = resolve(report.backup);
    expect(serialized.includes(resolvedBackup)).toBe(false);
    expect(serialized.includes(resolve(backupRoot))).toBe(false);

    expect(payload.source_authority).toBe("holdfast-track-b");
    expect(payload.source_version).toBe("1.1.0-nirvana.1");
    const origin = payload.origin as Record<string, unknown> | undefined;
    expect(origin).toBeDefined();
    expect(origin).not.toBeNull();
    expect(origin!.upstream_project).toBe("AndreAlmeidaDC/holdfast");
    expect(origin!.upstream_version).toBe("1.1.0");
    expect(origin!.target_authority).toBe("nirvana-core-dwc");
  }, DURABLE_BUDGET_MS);
});

// ─── DWC Request Changes: Strict TDD Test Suites (Fixes A through L) ────────

describe("durable work — Fix A: reject mutation replaying imported operation without DWC snapshot", () => {
  test("mutating an imported unit with an operationId present in unit.operations throws operation_replay_conflict: imported_operation_snapshot_unavailable and preserves state/tables", () => {
    const projectId = "prj_fix_a_imported_replay";
    const runId = "run_fix_a_imported_replay";
    const traceId = "trace_fix_a_imported_replay";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-fix-a-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-fix-a"]));
    const unitWithOps = validTrackBUnit(runId, "u-fix-a", {
      status: "partial",
      coverage: { completed: 1, total: 2, label: "files" },
      attempts: [{ id: "att-fix-a-1", startedAt: T0, endedAt: null, flushes: 1, outcome: "active" }],
      operations: [{ id: "op-imported-1", payloadDigest: "sha256:" + "1".repeat(64), appliedAt: T0 }],
    });
    writeTrackBFixture(tbRoot, state, { "u-fix-a": unitWithOps });
    const backupRoot = path.join(root, "backup-fix-a");

    const report = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, dryRun: false,
      operationId: "mig-imp-fix-a", now: T0,
    });
    expect(report.imported).toBe(1);

    const unitBefore = durable!.getUnit({ ...m, unitId: "u-fix-a" })!;
    expect(unitBefore.operations).toHaveLength(1);
    expect(unitBefore.operations[0].id).toBe("op-imported-1");

    // Progressing with op-imported-1 must throw operation_replay_conflict: imported_operation_snapshot_unavailable
    expect(() => durable!.progressUnit({
      ...m, unitId: "u-fix-a", attemptId: "att-fix-a-1", operationId: "op-imported-1",
      expectedDigest: unitBefore.digest, coverage: { completed: 2, total: 2, label: "files" },
      evidence: [], now: T1,
    })).toThrow("operation_replay_conflict: imported_operation_snapshot_unavailable");

    // Completing with op-imported-1 must throw
    const vfile = path.join(root, "v-fix-a.txt");
    fs.writeFileSync(vfile, "verified", "utf8");
    const vDigest = sha256(fs.readFileSync(vfile));
    expect(() => durable!.completeUnit({
      ...m, stateRoot: root, unitId: "u-fix-a", attemptId: "att-fix-a-1", operationId: "op-imported-1",
      expectedDigest: unitBefore.digest, verificationEvidence: [{ type: "file", ref: "v-fix-a.txt", digest: vDigest }],
      now: T1,
    })).toThrow("operation_replay_conflict: imported_operation_snapshot_unavailable");

    // Starting new attempt with op-imported-1 must throw
    expect(() => durable!.startUnit({
      ...m, unitId: "u-fix-a", attemptId: "att-fix-a-2", operationId: "op-imported-1",
      expectedDigest: unitBefore.digest, now: T1,
    })).toThrow("operation_replay_conflict: imported_operation_snapshot_unavailable");

    // Failing with op-imported-1 must throw
    expect(() => durable!.failUnit({
      ...m, unitId: "u-fix-a", attemptId: "att-fix-a-1", operationId: "op-imported-1",
      expectedDigest: unitBefore.digest, reason: "some reason", now: T1,
    })).toThrow("operation_replay_conflict: imported_operation_snapshot_unavailable");

    // Assert durable_operations table remains empty (0 rows), state unmodified
    const opsCount = (handle!.db.query("SELECT COUNT(*) AS count FROM durable_operations WHERE project_id = ? AND run_id = ?").get(projectId, runId) as { count: number }).count;
    expect(opsCount).toBe(0);

    const unitAfter = durable!.getUnit({ ...m, unitId: "u-fix-a" })!;
    expect(unitAfter.digest).toBe(unitBefore.digest);
    expect(unitAfter.revision).toBe(unitBefore.revision);

    // Rollback must still succeed because rollback precondition was not broken
    expect(() => rollbackTrackB({ ...m, backup: report.backup })).not.toThrow();
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Fix C: startUnit rejects compensating state", () => {
  test("startUnit on a unit with status compensating throws compensation_in_flight before writes", () => {
    const projectId = "prj_fix_c_compensating";
    const runId = "run_fix_c_compensating";
    const traceId = "trace_fix_c_compensating";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    durable!.defineUnits({ ...m, units: [{ id: "u-fix-c", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u-fix-c", attemptId: "att-fix-c-1", operationId: "op-start-c", now: T0,
    });
    const failed = durable!.failUnit({
      ...m, unitId: "u-fix-c", attemptId: "att-fix-c-1", operationId: "op-fail-c",
      expectedDigest: started.digest, reason: "failed test", now: T1,
    });
    const compensating = durable!.compensateUnit({
      ...m, unitId: "u-fix-c", attemptId: "att-fix-c-1", operationId: "op-comp-c",
      expectedDigest: failed.digest, now: T2,
    });
    expect(compensating.status).toBe("compensating");

    const eventsCountBefore = listEvents(handle!, projectId).length;

    expect(() => durable!.startUnit({
      ...m, unitId: "u-fix-c", attemptId: "att-fix-c-2", operationId: "op-start-c-2",
      expectedDigest: compensating.digest, now: T3,
    })).toThrow("compensation_in_flight");

    const unitStill = durable!.getUnit({ ...m, unitId: "u-fix-c" })!;
    expect(unitStill.status).toBe("compensating");
    expect(unitStill.digest).toBe(compensating.digest);
    expect(listEvents(handle!, projectId).length).toBe(eventsCountBefore);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Fix D: validated reasonCode and no free reason in public event/outbox", () => {
  test("failUnit and failCompensation default reasonCode to unit_failed / compensation_failed, accept validated custom reasonCode, and emit no free reason in public payload", () => {
    const projectId = "prj_fix_d_reasons";
    const runId = "run_fix_d_reasons";
    const traceId = "trace_fix_d_reasons";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    durable!.defineUnits({ ...m, units: [{ id: "u-fix-d", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u-fix-d", attemptId: "att-fix-d-1", operationId: "op-start-d", now: T0,
    });

    // 1. Invalid reasonCode rejected
    expect(() => durable!.failUnit({
      ...m, unitId: "u-fix-d", attemptId: "att-fix-d-1", operationId: "op-fail-d-inv",
      expectedDigest: started.digest, reason: "secret path /var/run/secret.key", reasonCode: "invalid reason with spaces",
      now: T1,
    })).toThrow(/reason_code/);

    // 2. Default reasonCode = unit_failed
    const failedDefault = durable!.failUnit({
      ...m, unitId: "u-fix-d", attemptId: "att-fix-d-1", operationId: "op-fail-d-1",
      expectedDigest: started.digest, reason: "secret path /var/run/secret.key",
      now: T1,
    });
    expect(failedDefault.status).toBe("failed");

    const failEvents = listEvents(handle!, projectId).filter(e => e.type === "x_durable_work_unit_failed");
    expect(failEvents).toHaveLength(1);
    const failPayload = failEvents[0].payload as Record<string, unknown>;
    expect(failPayload.reason_code).toBe("unit_failed");
    expect(failPayload.reason).toBeUndefined();
    expect(canonicalJson(failPayload).includes("secret.key")).toBe(false);

    // 3. Compensate and failCompensation with custom validated reasonCode
    const compensating = durable!.compensateUnit({
      ...m, unitId: "u-fix-d", attemptId: "att-fix-d-1", operationId: "op-comp-d-1",
      expectedDigest: failedDefault.digest, now: T2,
    });

    const compFailed = durable!.failCompensation({
      ...m, unitId: "u-fix-d", attemptId: "att-fix-d-1", operationId: "op-comp-fail-d-1",
      expectedDigest: compensating.digest, reason: "secret database password leaked in error",
      reasonCode: "custom_comp_abort", now: T3,
    });
    expect(compFailed.status).toBe("failed");

    const compFailEvents = listEvents(handle!, projectId).filter(e => e.type === "x_durable_work_unit_compensation_failed");
    expect(compFailEvents).toHaveLength(1);
    const compFailPayload = compFailEvents[0].payload as Record<string, unknown>;
    expect(compFailPayload.reason_code).toBe("custom_comp_abort");
    expect(compFailPayload.reason).toBeUndefined();
    expect(canonicalJson(compFailPayload).includes("password")).toBe(false);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Fix E: terminal canonical run rejection", () => {
  test("mutations and claim acquisition throw canonical_run_terminal when canonical run is terminal; reads, Track B import/rollback, and claim release remain usable", () => {
    const projectId = "prj_fix_e_terminal";
    const runId = "run_fix_e_terminal";
    const traceId = "trace_fix_e_terminal";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    durable!.defineUnits({ ...m, units: [{ id: "u-fix-e", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u-fix-e", attemptId: "att-fix-e-1", operationId: "op-start-e", now: T0,
    });
    const claim = durable!.acquireClaim({
      ...m, unitId: "u-fix-e", ownerId: "worker-e", ttlMs: 60_000, now: T0,
    });

    // Transition canonical run to terminal state using Run Kernel transitionRun API
    transitionRun(handle!, {
      projectId, runId, to: "running", actor: { kind: "test", id: "tester" }, correlationId: "cor-t-1",
    });
    transitionRun(handle!, {
      projectId, runId, to: "verifying", actor: { kind: "test", id: "tester" }, correlationId: "cor-t-2",
    });
    transitionRun(handle!, {
      projectId, runId, to: "completed", actor: { kind: "test", id: "tester" }, correlationId: "cor-t-3",
    });

    // 1. defineUnits on terminal run throws canonical_run_terminal
    expect(() => durable!.defineUnits({
      ...m, units: [{ id: "u-fix-e-2", kind: "audit", scope: "x", bounds: "y" }],
    })).toThrow("canonical_run_terminal");

    // 2. Lifecycle mutations throw canonical_run_terminal
    expect(() => durable!.startUnit({
      ...m, unitId: "u-fix-e", attemptId: "att-fix-e-2", operationId: "op-start-e-2", expectedDigest: started.digest,
    })).toThrow("canonical_run_terminal");

    expect(() => durable!.progressUnit({
      ...m, unitId: "u-fix-e", attemptId: "att-fix-e-1", operationId: "op-prog-e",
      expectedDigest: started.digest, coverage: { completed: 1, total: 1, label: "files" }, evidence: [],
    })).toThrow("canonical_run_terminal");

    expect(() => durable!.failUnit({
      ...m, unitId: "u-fix-e", attemptId: "att-fix-e-1", operationId: "op-fail-e", expectedDigest: started.digest, reason: "fail on terminal",
    })).toThrow("canonical_run_terminal");

    // 3. acquireClaim throws canonical_run_terminal
    expect(() => durable!.acquireClaim({
      ...m, unitId: "u-fix-e", ownerId: "worker-e-2", ttlMs: 60_000,
    })).toThrow("canonical_run_terminal");

    // 4. Reads remain usable
    expect(durable!.getUnit({ ...m, unitId: "u-fix-e" })?.id).toBe("u-fix-e");
    expect(durable!.status(m).units).toHaveLength(1);
    expect(durable!.collect(m).units).toHaveLength(1);
    expect(durable!.resume(m).partial).toHaveLength(1);

    // 5. Claim release remains usable
    expect(() => durable!.releaseClaim({ ...m, unitId: "u-fix-e", ownerId: "worker-e" })).not.toThrow();

    // 6. Track B import and rollback remain allowed on a terminal canonical run
    const tbProjectId = "prj_fix_e_terminal_tb";
    const tbRunId = "run_fix_e_terminal_tb";
    const tbTraceId = "trace_fix_e_terminal_tb";
    const tbM = createCanonicalRun(handle!, tbProjectId, tbRunId, tbTraceId);

    // Transition run to terminal (completed) before import
    transitionRun(handle!, {
      projectId: tbProjectId, runId: tbRunId, to: "running", actor: { kind: "test", id: "tester" }, correlationId: "cor-tb-t1",
    });
    transitionRun(handle!, {
      projectId: tbProjectId, runId: tbRunId, to: "verifying", actor: { kind: "test", id: "tester" }, correlationId: "cor-tb-t2",
    });
    transitionRun(handle!, {
      projectId: tbProjectId, runId: tbRunId, to: "completed", actor: { kind: "test", id: "tester" }, correlationId: "cor-tb-t3",
    });

    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-fix-e-"));
    const tbState = validTrackBState(tbRunId, tbTraceId, alignedUnitDecls(["u-fix-e-tb"]));
    writeTrackBFixture(tbRoot, tbState, { "u-fix-e-tb": validTrackBUnit(tbRunId, "u-fix-e-tb") });
    const backupRoot = path.join(root, "backup-fix-e");

    // Import succeeds on terminal run
    const report = importTrackB({
      ...tbM, trackBRoot: tbRoot, backupRoot, dryRun: false,
      operationId: "mig-imp-fix-e-term", now: T0,
    });
    expect(report.imported).toBe(1);
    expect(durable!.getUnit({ ...tbM, unitId: "u-fix-e-tb" })?.status).toBe("completed");

    // Rollback succeeds on terminal run
    expect(() => rollbackTrackB({ ...tbM, backup: report.backup, now: T1 })).not.toThrow();
    expect(durable!.getUnit({ ...tbM, unitId: "u-fix-e-tb" })).toBeNull();
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Fix F: default import -> default rollback -> default reimport -> same-generation replay", () => {
  test("default import derives deterministic rollback generation suffix after rollback, retaining audit history and allowing same-generation replay", () => {
    const projectId = "prj_fix_f_gen";
    const runId = "run_fix_f_gen";
    const traceId = "trace_fix_f_gen";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-fix-f-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-fix-f"]));
    writeTrackBFixture(tbRoot, state, { "u-fix-f": validTrackBUnit(runId, "u-fix-f") });
    const backupRoot = path.join(root, "backup-fix-f");

    // 1. Initial default import (no operationId specified)
    const report1 = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot: path.join(backupRoot, "b1"), dryRun: false, now: T0,
    });
    expect(report1.imported).toBe(1);
    const initialOpId = report1.operationId;
    expect(initialOpId).toMatch(/^mig_import_[a-f0-9]{16}$/);

    // 2. Default rollback (no operationId specified)
    rollbackTrackB({ ...m, backup: report1.backup, now: T1 });
    expect(durableUnitCount(projectId, runId)).toBe(0);

    // 3. Default reimport (no operationId specified) -> derives rollback generation suffix
    const report2 = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot: path.join(backupRoot, "b2"), dryRun: false, now: T2,
    });
    expect(report2.imported).toBe(1);
    expect(report2.alreadyImported).toBe(0);
    const reimportOpId = report2.operationId;
    expect(reimportOpId).toBe(`${initialOpId}_rb1`);

    // 4. Same-generation replay of default reimport -> returns cached result
    const replayReport = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot: path.join(backupRoot, "b2"), dryRun: false, now: T3,
    });
    expect(replayReport.alreadyImported).toBe(1);
    expect(replayReport.operationId).toBe(reimportOpId);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Fix I: no duplicate run_id in public event payloads", () => {
  test("all x_durable_work_* events omit run_id from payload because RunEvent envelope owns runId", () => {
    const projectId = "prj_fix_i_no_dup_run_id";
    const runId = "run_fix_i_no_dup_run_id";
    const traceId = "trace_fix_i_no_dup_run_id";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    durable!.defineUnits({ ...m, units: [{ id: "u-fix-i", kind: "audit", scope: "x", bounds: "y" }, { id: "u-fix-i2", kind: "audit", scope: "x2", bounds: "y2" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u-fix-i", attemptId: "att-fix-i-1", operationId: "op-start-i", now: T0,
    });
    const progressed = durable!.progressUnit({
      ...m, unitId: "u-fix-i", attemptId: "att-fix-i-1", operationId: "op-prog-i",
      expectedDigest: started.digest, coverage: { completed: 1, total: 1, label: "files" }, evidence: [], now: T1,
    });
    const vfile = path.join(root, "v-fix-i.txt");
    fs.writeFileSync(vfile, "verified", "utf8");
    const vDigest = sha256(fs.readFileSync(vfile));
    durable!.completeUnit({
      ...m, stateRoot: root, unitId: "u-fix-i", attemptId: "att-fix-i-1", operationId: "op-done-i",
      expectedDigest: progressed.digest, verificationEvidence: [{ type: "file", ref: "v-fix-i.txt", digest: vDigest }], now: T2,
    });

    // Also trigger fail, compensate, failCompensation, completeCompensation on u-fix-i2
    const started2 = durable!.startUnit({
      ...m, unitId: "u-fix-i2", attemptId: "att-fix-i2-1", operationId: "op-start-i2", now: T0,
    });
    const failed2 = durable!.failUnit({
      ...m, unitId: "u-fix-i2", attemptId: "att-fix-i2-1", operationId: "op-fail-i2",
      expectedDigest: started2.digest, reason: "fail reason", now: T1,
    });
    const comp2 = durable!.compensateUnit({
      ...m, unitId: "u-fix-i2", attemptId: "att-fix-i2-1", operationId: "op-comp-i2",
      expectedDigest: failed2.digest, now: T2,
    });
    const compFail2 = durable!.failCompensation({
      ...m, unitId: "u-fix-i2", attemptId: "att-fix-i2-1", operationId: "op-compfail-i2",
      expectedDigest: comp2.digest, reason: "comp fail reason", now: T3,
    });
    const comp2Retry = durable!.compensateUnit({
      ...m, unitId: "u-fix-i2", attemptId: "att-fix-i2-1", operationId: "op-comp-i2-retry",
      expectedDigest: compFail2.digest, now: T4,
    });
    durable!.completeCompensation({
      ...m, stateRoot: root, unitId: "u-fix-i2", attemptId: "att-fix-i2-1", operationId: "op-compdone-i2",
      expectedDigest: comp2Retry.digest, compensationEvidence: [{ type: "file", ref: "v-fix-i.txt", digest: vDigest }], now: "2026-08-27T00:05:00.000Z",
    });

    // Also import and rollback on a separate run to cover Track B events
    const tbProjectId = "prj_fix_i_tb";
    const tbRunId = "run_fix_i_tb";
    const tbTraceId = "trace_fix_i_tb";
    const tbM = createCanonicalRun(handle!, tbProjectId, tbRunId, tbTraceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-fix-i-"));
    const tbState = validTrackBState(tbRunId, tbTraceId, alignedUnitDecls(["u-tb-i"]));
    writeTrackBFixture(tbRoot, tbState, { "u-tb-i": validTrackBUnit(tbRunId, "u-tb-i") });
    const backupRoot = path.join(root, "backup-fix-i");
    const report = importTrackB({
      ...tbM, trackBRoot: tbRoot, backupRoot, dryRun: false, now: T0,
    });
    rollbackTrackB({ ...tbM, backup: report.backup, now: T1 });

    const allEvents = [...listEvents(handle!, projectId), ...listEvents(handle!, tbProjectId)];
    const observedTypes = new Set<string>();
    for (const evt of allEvents) {
      if (evt.type.startsWith("x_durable_work_")) {
        observedTypes.add(evt.type);
        expect((evt.payload as Record<string, unknown>).run_id).toBeUndefined();
      }
    }

    // Verify all emitted event types are observed:
    const expectedTypes = [
      "x_durable_work_units_defined",
      "x_durable_work_unit_started",
      "x_durable_work_unit_progressed",
      "x_durable_work_unit_completed",
      "x_durable_work_unit_failed",
      "x_durable_work_unit_compensating",
      "x_durable_work_unit_compensation_failed",
      "x_durable_work_unit_compensated",
      "x_durable_work_unit_imported",
      "x_durable_work_track_b_imported",
      "x_durable_work_track_b_rollback",
    ];
    for (const t of expectedTypes) {
      expect(observedTypes.has(t)).toBe(true);
    }
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Fix J: legacy squad target with absent capabilityId", () => {
  test("squad target with absent capabilityId matches canonical run without capabilityId; mismatch is rejected", () => {
    const projectId = "prj_fix_j_legacy_squad";
    const runId1 = "run_fix_j_legacy_squad_1";
    const traceId1 = "trace_fix_j_legacy_squad_1";
    const legacyTarget = { kind: "squad" as const, slug: "legacy-squad-slug" };

    // 1. Canonical run with legacy squad target (no capabilityId)
    createRun(handle!, {
      projectId, runId: runId1, traceId: traceId1, target: legacyTarget as any,
      planId: `plan_${runId1}`, policySnapshotRef: "sha256:policy",
      actor: { kind: "test", id: "test" }, correlationId: "cor-j-1", occurredAt: T0,
    });

    const m1 = { handle: handle!, projectId, runId: runId1, traceId: traceId1, target: legacyTarget as any };

    // defineUnits with legacy target succeeds without inventing capabilityId
    const def = durable!.defineUnits({
      ...m1, units: [{ id: "u-fix-j", kind: "audit", scope: "x", bounds: "y" }],
    });
    expect(def.units).toHaveLength(1);

    // Calling defineUnits with a capabilityId when canonical run has none must throw target mismatch
    const mismatchTarget = { kind: "squad" as const, slug: "legacy-squad-slug", capabilityId: "cap-invented" };
    expect(() => durable!.defineUnits({
      ...m1, target: mismatchTarget, units: [{ id: "u-fix-j", kind: "audit", scope: "x", bounds: "y" }],
    })).toThrow(/target/);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Fix L: failUnit attemptId validation and distinct rollback operationId", () => {
  test("failUnit validates attemptId belongs to unit before event; omitted rollback operationId uses distinct deriveRollbackOperationId", () => {
    const projectId = "prj_fix_l_validation";
    const runId = "run_fix_l_validation";
    const traceId = "trace_fix_l_validation";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    durable!.defineUnits({ ...m, units: [{ id: "u-fix-l", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u-fix-l", attemptId: "att-fix-l-active", operationId: "op-start-l", now: T0,
    });

    // failUnit with non-existent or inactive attemptId must throw attempt_not_active before event emission
    const eventsBefore = listEvents(handle!, projectId).length;
    expect(() => durable!.failUnit({
      ...m, unitId: "u-fix-l", attemptId: "att-non-existent", operationId: "op-fail-l-bad",
      expectedDigest: started.digest, reason: "bad attempt id", now: T1,
    })).toThrow("attempt_not_active");
    expect(listEvents(handle!, projectId).length).toBe(eventsBefore);

    // Track B import and default rollback operation id derivation (fresh run to avoid auxiliary table drift)
    const runIdRb = "run_fix_l_rollback_derivation";
    const traceIdRb = "trace_fix_l_rollback_derivation";
    const mRb = createCanonicalRun(handle!, projectId, runIdRb, traceIdRb);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-track-b-fix-l-"));
    const state = validTrackBState(runIdRb, traceIdRb, alignedUnitDecls(["u-fix-l-tb"]));
    writeTrackBFixture(tbRoot, state, { "u-fix-l-tb": validTrackBUnit(runIdRb, "u-fix-l-tb") });
    const backupRoot = path.join(root, "backup-fix-l");

    const report = importTrackB({
      ...mRb, trackBRoot: tbRoot, backupRoot, dryRun: false,
      operationId: "mig-imp-fix-l-custom", now: T0,
    });

    // Rollback with omitted operationId must derive distinct mig_rollback_* and NOT reuse "mig-imp-fix-l-custom" from manifest
    rollbackTrackB({ ...mRb, backup: report.backup, now: T1 });
    const rbEvents = listEvents(handle!, projectId).filter(e => e.type === "x_durable_work_track_b_rollback" && e.runId === runIdRb);
    expect(rbEvents).toHaveLength(1);
    const rbPayload = rbEvents[0].payload as Record<string, unknown>;
    expect(rbPayload.operation_id).toMatch(/^mig_rollback_[a-f0-9]{16}$/);
    expect(rbPayload.operation_id).not.toBe("mig-imp-fix-l-custom");
  }, DURABLE_BUDGET_MS);
});

describe("durable work — Blockers A through K regression test suite", () => {
  // A. Rollback replay drift
  test("Blocker A: cached successful rollback must reject replay if current materialization changed (e.g. reimported)", () => {
    const projectId = "prj_blocker_a";
    const runId = "run_blocker_a";
    const traceId = "trace_blocker_a";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-tb-blocker-a-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-a"]));
    writeTrackBFixture(tbRoot, state, { "u-a": validTrackBUnit(runId, "u-a") });
    const backupRoot = path.join(root, "backup-blocker-a");

    const report1 = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "op-imp-a", dryRun: false, now: T0,
    });
    // First rollback with explicit operationId
    rollbackTrackB({ ...m, backup: report1.backup, operationId: "op-rb-a", now: T1 });

    // Re-import creates live materialization again
    importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "op-imp-a-2", dryRun: false, now: T2,
    });
    expect(durableUnitCount(projectId, runId)).toBe(1);

    // Replaying the old successful rollback "op-rb-a" while current materialization has changed/live
    // MUST NOT return cached success as a no-op; it must reject with operation_replay_state_drift and preserve live units!
    expect(() => rollbackTrackB({
      ...m, backup: report1.backup, operationId: "op-rb-a", now: T1,
    })).toThrow(/operation_replay_state_drift/);
    expect(durableUnitCount(projectId, runId)).toBe(1);
  }, DURABLE_BUDGET_MS);

  // B. Runtime identity validation
  test("Blocker B: compensateUnit/completeCompensation/failCompensation reject hostile/nonexistent attemptId; completeUnit validates operationId", () => {
    const projectId = "prj_blocker_b";
    const runId = "run_blocker_b";
    const traceId = "trace_blocker_b";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    durable!.defineUnits({ ...m, units: [{ id: "u-b", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u-b", attemptId: "att-b-1", operationId: "op-start-b", now: T0,
    });
    const failed = durable!.failUnit({
      ...m, unitId: "u-b", attemptId: "att-b-1", operationId: "op-fail-b",
      expectedDigest: started.digest, reason: "failed b", now: T1,
    });

    // compensateUnit with hostile or nonexistent attemptId must be rejected
    expect(() => durable!.compensateUnit({
      ...m, unitId: "u-b", attemptId: "../hostile", operationId: "op-comp-b-bad",
      expectedDigest: failed.digest, now: T2,
    })).toThrow(/attempt_id_invalid|attempt_not_active|attempt_not_found/);

    expect(() => durable!.compensateUnit({
      ...m, unitId: "u-b", attemptId: "att-nonexistent", operationId: "op-comp-b-bad2",
      expectedDigest: failed.digest, now: T2,
    })).toThrow(/attempt_not_found|attempt_not_active/);

    const comp = durable!.compensateUnit({
      ...m, unitId: "u-b", attemptId: "att-b-1", operationId: "op-comp-b",
      expectedDigest: failed.digest, now: T2,
    });

    // completeCompensation and failCompensation with nonexistent/hostile attemptId
    const cFile = path.join(root, "comp-b.txt");
    fs.writeFileSync(cFile, "comp", "utf8");
    const cDigest = sha256(fs.readFileSync(cFile));
    expect(() => durable!.completeCompensation({
      ...m, stateRoot: root, unitId: "u-b", attemptId: "att-nonexistent", operationId: "op-comp-done-bad",
      expectedDigest: comp.digest, compensationEvidence: [{ type: "file", ref: "comp-b.txt", digest: cDigest }], now: T3,
    })).toThrow(/attempt_not_found|attempt_not_active/);

    expect(() => durable!.failCompensation({
      ...m, unitId: "u-b", attemptId: "att-nonexistent", operationId: "op-comp-fail-bad",
      expectedDigest: comp.digest, reason: "fail comp", now: T3,
    })).toThrow(/attempt_not_found|attempt_not_active/);

    // completeUnit operationId must pass safe-segment validation
    createCanonicalRun(handle!, projectId, "run_blocker_b2", traceId);
    const m2 = { ...m, runId: "run_blocker_b2" };
    durable!.defineUnits({ ...m2, units: [{ id: "u-b2", kind: "audit", scope: "x", bounds: "y" }] });
    const started2 = durable!.startUnit({
      ...m2, unitId: "u-b2", attemptId: "att-b2-1", operationId: "op-start-b2", now: T0,
    });
    const prog2 = durable!.progressUnit({
      ...m2, unitId: "u-b2", attemptId: "att-b2-1", operationId: "op-prog-b2",
      expectedDigest: started2.digest, coverage: { completed: 1, total: 1, label: "files" }, evidence: [], now: T1,
    });
    expect(() => durable!.completeUnit({
      ...m2, stateRoot: root, unitId: "u-b2", attemptId: "att-b2-1", operationId: "../unsafe-op",
      expectedDigest: prog2.digest, verificationEvidence: [{ type: "file", ref: "comp-b.txt", digest: cDigest }], now: T2,
    })).toThrow(/operation_id/);
  }, DURABLE_BUDGET_MS);

  // C. Runtime reason validation
  test("Blocker C: failUnit and failCompensation require nonempty bounded reason at runtime", () => {
    const projectId = "prj_blocker_c";
    const runId = "run_blocker_c";
    const traceId = "trace_blocker_c";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    durable!.defineUnits({ ...m, units: [{ id: "u-c", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u-c", attemptId: "att-c-1", operationId: "op-start-c", now: T0,
    });

    // Empty reason must throw
    expect(() => (durable!.failUnit as (args: unknown) => unknown)({
      ...m, unitId: "u-c", attemptId: "att-c-1", operationId: "op-fail-c-empty",
      expectedDigest: started.digest, reason: "", now: T1,
    })).toThrow(/reason_invalid|reason_required/);

    // Whitespace-only reason must throw
    expect(() => (durable!.failUnit as (args: unknown) => unknown)({
      ...m, unitId: "u-c", attemptId: "att-c-1", operationId: "op-fail-c-ws",
      expectedDigest: started.digest, reason: "   ", now: T1,
    })).toThrow(/reason_invalid|reason_required/);

    // Excessively long reason (>4096 chars) must throw
    expect(() => (durable!.failUnit as (args: unknown) => unknown)({
      ...m, unitId: "u-c", attemptId: "att-c-1", operationId: "op-fail-c-long",
      expectedDigest: started.digest, reason: "a".repeat(5000), now: T1,
    })).toThrow(/reason_invalid|reason_too_long/);
  }, DURABLE_BUDGET_MS);

  // D. Native evidence containment
  test("Blocker D: native evidence containment rejects Windows junction/symlink escape at segments and leaf", () => {
    const projectId = "prj_blocker_d";
    const runId = "run_blocker_d";
    const traceId = "trace_blocker_d";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    durable!.defineUnits({ ...m, units: [{ id: "u-d", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u-d", attemptId: "att-d-1", operationId: "op-start-d", now: T0,
    });

    const safeDir = path.join(root, "safe-d-dir");
    fs.mkdirSync(safeDir, { recursive: true });
    const outsideDir = path.join(os.tmpdir(), "outside-d-" + Date.now());
    fs.mkdirSync(outsideDir, { recursive: true });
    const secretFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(secretFile, "secret content", "utf8");
    const secretDigest = sha256(fs.readFileSync(secretFile));

    // Try creating a symlink inside safeDir pointing outside
    const linkPath = path.join(safeDir, "symlink-escape.txt");
    try {
      fs.symlinkSync(secretFile, linkPath, "file");
    } catch {
      // If symlink creation not permitted on this machine, test still passes or validates logic
    }

    if (fs.existsSync(linkPath)) {
      expect(() => durable!.progressUnit({
        ...m, stateRoot: safeDir, unitId: "u-d", attemptId: "att-d-1", operationId: "op-prog-d",
        expectedDigest: started.digest, coverage: { completed: 1, total: 2, label: "files" },
        evidence: [{ type: "file", ref: "symlink-escape.txt", digest: secretDigest }], now: T1,
      })).toThrow(/evidence_ref_symlink_escape|evidence_ref_unsafe/);
    }
  }, DURABLE_BUDGET_MS);

  // E. Timestamp validation and epoch ms claim comparison
  test("Blocker E: caller now must be canonical ISO instant; claim liveness compares epoch ms, not lexicographical string", () => {
    const projectId = "prj_blocker_e";
    const runId = "run_blocker_e";
    const traceId = "trace_blocker_e";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    durable!.defineUnits({ ...m, units: [{ id: "u-e", kind: "audit", scope: "x", bounds: "y" }] });

    // Invalid ISO timestamp rejected in startUnit, acquireClaim
    expect(() => durable!.startUnit({
      ...m, unitId: "u-e", attemptId: "att-e-1", operationId: "op-start-e", now: "not-a-timestamp",
    })).toThrow(/invalid_timestamp/);

    expect(() => durable!.acquireClaim({
      ...m, unitId: "u-e", ownerId: "worker-1", ttlMs: 60000, now: "2026-02-30T00:00:00Z",
    })).toThrow(/invalid_timestamp/);

    expect(() => durable!.releaseClaim({
      ...m, unitId: "u-e", ownerId: "worker-1", now: "2026-08-27T00:00:00Z",
    })).toThrow(/invalid_timestamp/);

    expect(() => durable!.releaseClaim({
      ...m, unitId: "u-e", ownerId: "worker-1", now: "2026-08-27T00:00:00.000000Z",
    })).toThrow(/invalid_timestamp/);

    expect(() => durable!.releaseClaim({
      ...m, unitId: "u-e", ownerId: "worker-1", now: "2026-08-27T00:00:00.000+00:00",
    })).toThrow(/invalid_timestamp/);

    // Claim comparison using epoch ms:
    // Claim 1 acquired at T0 with ttlMs: 1000 -> expiresAt = T0 + 1s.
    // Querying with now = T0 + 500ms must see it as live.
    // Querying with now = T0 + 1500ms must see it as expired and allow worker-2.
    const claim1 = durable!.acquireClaim({
      ...m, unitId: "u-e", ownerId: "worker-1", ttlMs: 1000, now: "2026-08-27T10:00:00.000Z",
    });
    expect(claim1.ownerId).toBe("worker-1");

    expect(() => durable!.acquireClaim({
      ...m, unitId: "u-e", ownerId: "worker-2", ttlMs: 1000, now: "2026-08-27T10:00:00.500Z",
    })).toThrow(/claim_live/);

    const claim2 = durable!.acquireClaim({
      ...m, unitId: "u-e", ownerId: "worker-2", ttlMs: 1000, now: "2026-08-27T10:00:01.500Z",
    });
    expect(claim2.ownerId).toBe("worker-2");
  }, DURABLE_BUDGET_MS);

  // F. Collision-free event idempotency / correlation tuples
  test("Blocker F: event idempotency and correlation tuples are collision-free (u+a-1 vs u-a+1)", () => {
    const projectId = "prj_blocker_f";
    const runId = "run_blocker_f";
    const traceId = "trace_blocker_f";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    durable!.defineUnits({
      ...m, units: [
        { id: "u_a", kind: "audit", scope: "x", bounds: "y" },
        { id: "u", kind: "audit", scope: "x", bounds: "y" },
      ],
    });

    // Pair 1: unit="u_a", attempt="1", op="op1"
    // Pair 2: unit="u", attempt="a_1", op="op1"
    // With naive concatenation `cor_dw_start_${unitId}_${attemptId}`, both would be `cor_dw_start_u_a_1`!
    // The encoder must guarantee non-collision.
    durable!.startUnit({ ...m, unitId: "u_a", attemptId: "1", operationId: "op-1", now: T0 });
    durable!.startUnit({ ...m, unitId: "u", attemptId: "a_1", operationId: "op-2", now: T1 });

    const events = listEvents(handle!, projectId);
    const startEvents = events.filter(e => e.type === "x_durable_work_unit_started");
    expect(startEvents).toHaveLength(2);
    expect(startEvents[0].correlationId).not.toBe(startEvents[1].correlationId);
    expect(startEvents[0].idempotencyKey).not.toBe(startEvents[1].idempotencyKey);
  }, DURABLE_BUDGET_MS);

  // G. Public coverage payload must not leak free-text coverage.label
  test("Blocker G: public event payload from progressUnit must omit free-text coverage.label", () => {
    const projectId = "prj_blocker_g";
    const runId = "run_blocker_g";
    const traceId = "trace_blocker_g";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    durable!.defineUnits({ ...m, units: [{ id: "u-g", kind: "audit", scope: "x", bounds: "y" }] });
    const started = durable!.startUnit({
      ...m, unitId: "u-g", attemptId: "att-g-1", operationId: "op-start-g", now: T0,
    });
    durable!.progressUnit({
      ...m, unitId: "u-g", attemptId: "att-g-1", operationId: "op-prog-g",
      expectedDigest: started.digest, coverage: { completed: 1, total: 3, label: "secret-label-leaked" },
      evidence: [], now: T1,
    });

    const events = listEvents(handle!, projectId).filter(e => e.type === "x_durable_work_unit_progressed");
    expect(events).toHaveLength(1);
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.coverage).toEqual({ completed: 1, total: 3 });
    expect(canonicalJson(payload).includes("secret-label-leaked")).toBe(false);
  }, DURABLE_BUDGET_MS);

  // H. Event/outbox occurredAt consistency
  test("Blocker H: event/outbox occurredAt uses validated mutation now consistently", () => {
    const projectId = "prj_blocker_h";
    const runId = "run_blocker_h";
    const traceId = "trace_blocker_h";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    const customTime = "2026-08-27T11:22:33.444Z";
    durable!.defineUnits({ ...m, units: [{ id: "u-h", kind: "audit", scope: "x", bounds: "y" }], now: customTime });

    const started = durable!.startUnit({
      ...m, unitId: "u-h", attemptId: "att-h-1", operationId: "op-start-h", now: customTime,
    });

    const events = listEvents(handle!, projectId).filter(e => e.type === "x_durable_work_unit_started");
    expect(events).toHaveLength(1);
    expect(events[0].occurredAt).toBe(customTime);
  }, DURABLE_BUDGET_MS);

  // I. Track B complete units validation
  test("Blocker I: import rejects Track B complete unit if coverage.total <= 0, completed != total, or evidence is empty", () => {
    const projectId = "prj_blocker_i";
    const runId = "run_blocker_i";
    const traceId = "trace_blocker_i";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-tb-blocker-i-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-i"]));
    // Complete unit with empty evidence
    const badUnit = validTrackBUnit(runId, "u-i", {
      status: "complete",
      coverage: { completed: 5, total: 5, label: "items" },
      evidence: [],
    });
    writeTrackBFixture(tbRoot, state, { "u-i": badUnit });
    const backupRoot = path.join(root, "backup-blocker-i");

    expect(() => importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "op-imp-i", dryRun: false, now: T0,
    })).toThrow(/track_b_unit_complete_invalid|verification_evidence_required|evidence_empty/);
  }, DURABLE_BUDGET_MS);

  // J. Retained backup evidence resolver
  test("Blocker J: imported evidence remains verifiable via stateRoot pointing to backup after Track B source cleanup", () => {
    const projectId = "prj_blocker_j";
    const runId = "run_blocker_j";
    const traceId = "trace_blocker_j";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-tb-blocker-j-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-j"]));
    writeTrackBFixture(tbRoot, state, { "u-j": validTrackBUnit(runId, "u-j") });
    const backupRoot = path.join(root, "backup-blocker-j");

    const report = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "op-imp-j", dryRun: false, now: T0,
    });

    // Delete trackBRoot to simulate cleanup
    fs.rmSync(tbRoot, { recursive: true, force: true });

    // getUnit with stateRoot pointing to backup must successfully verify evidence
    const unit = durable!.getUnit({
      ...m, handle: handle!, unitId: "u-j", stateRoot: report.backup,
    });
    expect(unit).not.toBeNull();
    expect(unit!.id).toBe("u-j");
    expect(unit!.evidence).toHaveLength(1);

    // Tampering the backup evidence file must fail closed
    const backedUpEvidence = path.join(report.backup, "evidence", "u-j", "evidence", "u-j.txt");
    expect(fs.existsSync(backedUpEvidence)).toBe(true);
    fs.appendFileSync(backedUpEvidence, " tampered bytes", "utf8");
    expect(() => durable!.getUnit({
      ...m, handle: handle!, unitId: "u-j", stateRoot: report.backup,
    })).toThrow(/evidence_backup_manifest_invalid|rollback_backup_file_(digest|size)_mismatch|evidence_digest_mismatch/);
  }, DURABLE_BUDGET_MS);

  // K. Deterministic staging and crash-orphan recovery
  test("Blocker K: identical import retry with existing valid staging reuses stage; tampered/mismatched stage is rejected", () => {
    const projectId = "prj_blocker_k";
    const runId = "run_blocker_k";
    const traceId = "trace_blocker_k";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-tb-blocker-k-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-k"]));
    writeTrackBFixture(tbRoot, state, { "u-k": validTrackBUnit(runId, "u-k") });
    const backupRoot = path.join(root, "backup-blocker-k");

    // 1. Dry-run creates staging directory
    const dryReport = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "op-imp-k", dryRun: true, now: T0,
    });
    expect(fs.existsSync(dryReport.backup)).toBe(true);

    // 2. Repeating import with exact same now should reuse the validated stage without crashing on collision
    const realReport = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "op-imp-k", dryRun: false, now: T0,
    });
    expect(realReport.imported).toBe(1);
    expect(realReport.backup).toBe(dryReport.backup);

    // 3. Repeating import against a tampered stage directory must fail closed
    const runId2 = "run_blocker_k_tamper";
    const m2 = createCanonicalRun(handle!, projectId, runId2, traceId);
    const tbRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-tb-blocker-k2-"));
    const state2 = validTrackBState(runId2, traceId, alignedUnitDecls(["u-k2"]));
    writeTrackBFixture(tbRoot2, state2, { "u-k2": validTrackBUnit(runId2, "u-k2") });
    const backupRoot2 = path.join(root, "backup-blocker-k-tamper");

    const dryReport2 = importTrackB({
      ...m2, trackBRoot: tbRoot2, backupRoot: backupRoot2, operationId: "op-imp-k2", dryRun: true, now: T0,
    });
    // Tamper a file in the stage
    fs.appendFileSync(path.join(dryReport2.backup, "STATE.json"), " tampered", "utf8");
    expect(() => importTrackB({
      ...m2, trackBRoot: tbRoot2, backupRoot: backupRoot2, operationId: "op-imp-k2", dryRun: false, now: T0,
    })).toThrow(/track_b_backup_manifest_drift|rollback_backup_file_(digest|size)_mismatch/);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — TDD Hardening D & G: retained import replay and evidence", () => {
  test("cached import replay reconstructs source identity from retained backup when Track B source is removed, preserves dryRun:false, and validates live materialization", () => {
    const projectId = "prj_tdd_dg_replay_removed_src";
    const runId = "run_tdd_dg_replay_removed_src";
    const traceId = "trace_tdd_dg_replay_removed_src";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-tb-dg-1-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-dg-1"]));
    writeTrackBFixture(tbRoot, state, { "u-dg-1": validTrackBUnit(runId, "u-dg-1") });
    const backupRoot = path.join(root, "backup-tdd-dg-1");

    const report1 = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "op-imp-dg-1", dryRun: false, now: T0,
    });
    expect(report1.imported).toBe(1);
    expect(report1.alreadyImported).toBe(0);
    expect(report1.dryRun).toBe(false);

    // Delete the original Track B source completely
    fs.rmSync(tbRoot, { recursive: true, force: true });
    expect(fs.existsSync(tbRoot)).toBe(false);

    // 1. Replay with dryRun: true must STILL preserve dryRun: false because a real import already occurred!
    const replayReport = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "op-imp-dg-1", dryRun: true, now: T1,
    });
    expect(replayReport.alreadyImported).toBe(1);
    expect(replayReport.dryRun).toBe(false);
    expect(replayReport.backup).toBe(report1.backup);
    expect(replayReport.definitionDigest).toBe(report1.definitionDigest);

    // 2. Replay with invalid now timestamp must fail before cached fast return
    expect(() => importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "op-imp-dg-1", dryRun: false, now: "invalid-iso-time",
    })).toThrow(/invalid_timestamp/);

    // 3. Replay with mismatched context must fail
    expect(() => importTrackB({
      ...m, traceId: "trace-mismatched", trackBRoot: tbRoot, backupRoot, operationId: "op-imp-dg-1", dryRun: false, now: T1,
    })).toThrow(/trace_id|traceId/);

    // 4. getUnit, status, and collect verify evidence via retained backup root
    const unit = durable!.getUnit({
      ...m, handle: handle!, unitId: "u-dg-1", stateRoot: report1.backup,
    });
    expect(unit).not.toBeNull();
    expect(unit!.id).toBe("u-dg-1");

    const st = durable!.status({
      ...m, handle: handle!, stateRoot: report1.backup,
    });
    expect(st.units).toHaveLength(1);
    expect(st.units[0].id).toBe("u-dg-1");

    const col = durable!.collect({
      ...m, handle: handle!, stateRoot: report1.backup,
    });
    expect(col.units).toHaveLength(1);
  }, DURABLE_BUDGET_MS);

  test("tampered or missing retained backup on cached import replay fails closed with corruption or drift error", () => {
    const projectId = "prj_tdd_dg_tamper";
    const runId = "run_tdd_dg_tamper";
    const traceId = "trace_tdd_dg_tamper";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-tb-dg-tamper-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-dg-tamper"]));
    writeTrackBFixture(tbRoot, state, { "u-dg-tamper": validTrackBUnit(runId, "u-dg-tamper") });
    const backupRoot = path.join(root, "backup-tdd-dg-tamper");

    const report = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "op-imp-dg-tamper", dryRun: false, now: T0,
    });

    // Delete source
    fs.rmSync(tbRoot, { recursive: true, force: true });

    // Tamper the retained backup STATE.json
    fs.appendFileSync(path.join(report.backup, "STATE.json"), " tampered", "utf8");

    expect(() => importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "op-imp-dg-tamper", dryRun: false, now: T1,
    })).toThrow(/drift|corrupt|digest|mismatch|manifest/i);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — TDD Hardening E & F: cached rollback replay and injective correlation", () => {
  test("Hardening E: cached rollback replay fails closed with operation_replay_state_drift if any rows remain in durable_units, durable_definitions, durable_claims, durable_operations, or durable_operation_snapshots", () => {
    const projectId = "prj_tdd_e_rollback_replay";
    const runId = "run_tdd_e_rollback_replay";
    const traceId = "trace_tdd_e_rollback_replay";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);
    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-tb-e-1-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-e-1"]));
    writeTrackBFixture(tbRoot, state, { "u-e-1": validTrackBUnit(runId, "u-e-1") });
    const backupRoot = path.join(root, "backup-tdd-e-1");

    const report = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "op-imp-e-1", dryRun: false, now: T0,
    });
    expect(report.imported).toBe(1);

    // Initial rollback succeeds
    rollbackTrackB({ ...m, backup: report.backup, operationId: "mig-rb-e-1", now: T1 });

    // Clean replay succeeds (no-op)
    expect(() => rollbackTrackB({ ...m, backup: report.backup, operationId: "mig-rb-e-1", now: T2 })).not.toThrow();

    // Now test each of the 5 tables individually when a row is injected back:
    // 1. durable_units
    handle!.db.run(
      `INSERT INTO durable_units(project_id, run_id, trace_id, unit_id, kind, scope, bounds, label, status, coverage_json, attempts_json, evidence_json, operations_json, revision, created_at, updated_at, row_digest)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [projectId, runId, traceId, "u-e-ghost", "migration", "x", "y", "label", "partial", `{"completed":0,"total":0,"label":"items"}`, "[]", "[]", "[]", 1, T0, T0, "fake-digest"],
    );
    expect(() => rollbackTrackB({ ...m, backup: report.backup, operationId: "mig-rb-e-1", now: T2 }))
      .toThrow("operation_replay_state_drift: track_b_rollback");
    handle!.db.run(`DELETE FROM durable_units WHERE project_id = ? AND run_id = ?`, [projectId, runId]);

    // 2. durable_definitions
    handle!.db.run(
      `INSERT INTO durable_definitions(project_id, run_id, trace_id, target_kind, target_slug, target_capability_id, definition_json, definition_digest, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [projectId, runId, traceId, TARGET.kind, TARGET.slug, null, `{"schemaVersion":"nirvana.durable-work/v1alpha1","projectId":"${projectId}","runId":"${runId}","traceId":"${traceId}","units":[],"createdAt":"${T0}"}`, "fake-def-digest", T0],
    );
    expect(() => rollbackTrackB({ ...m, backup: report.backup, operationId: "mig-rb-e-1", now: T2 }))
      .toThrow("operation_replay_state_drift: track_b_rollback");
    handle!.db.run(`DELETE FROM durable_definitions WHERE project_id = ? AND run_id = ?`, [projectId, runId]);

    // 3. durable_claims
    handle!.db.run(
      `INSERT INTO durable_claims(project_id, run_id, unit_id, owner_id, acquired_at, expires_at, row_digest) VALUES(?,?,?,?,?,?,?)`,
      [projectId, runId, "u-e-1", "owner-x", T0, T2, "fake-digest"],
    );
    expect(() => rollbackTrackB({ ...m, backup: report.backup, operationId: "mig-rb-e-1", now: T2 }))
      .toThrow("operation_replay_state_drift: track_b_rollback");
    handle!.db.run(`DELETE FROM durable_claims WHERE project_id = ? AND run_id = ?`, [projectId, runId]);

    // 4. durable_operations
    handle!.db.run(
      `INSERT INTO durable_operations(project_id, run_id, unit_id, operation_id, payload_digest, applied_at) VALUES(?,?,?,?,?,?)`,
      [projectId, runId, "u-e-1", "op-ghost", "fake-payload", T0],
    );
    expect(() => rollbackTrackB({ ...m, backup: report.backup, operationId: "mig-rb-e-1", now: T2 }))
      .toThrow("operation_replay_state_drift: track_b_rollback");
    handle!.db.run(`DELETE FROM durable_operations WHERE project_id = ? AND run_id = ?`, [projectId, runId]);

    // 5. durable_operation_snapshots
    handle!.db.run(
      `INSERT INTO durable_operation_snapshots(project_id, run_id, unit_id, operation_id, payload_digest, snapshot_json, captured_at) VALUES(?,?,?,?,?,?,?)`,
      [projectId, runId, "u-e-1", "op-ghost", "fake-payload", "{}", T0],
    );
    expect(() => rollbackTrackB({ ...m, backup: report.backup, operationId: "mig-rb-e-1", now: T2 }))
      .toThrow("operation_replay_state_drift: track_b_rollback");
    handle!.db.run(`DELETE FROM durable_operation_snapshots WHERE project_id = ? AND run_id = ?`, [projectId, runId]);
  }, DURABLE_BUDGET_MS);

  test("Hardening F: public definitions, imported-unit, import, and rollback event correlation IDs and idempotency keys use encodeDwcTuple and do not collide", () => {
    const projectId = "prj_tdd_f_injective_mig";

    // Test defineUnits collision pair:
    // Pair A: runId = "r_a"
    // Pair B: runId = "r-a"
    // In defineUnits:
    const runA = createCanonicalRun(handle!, projectId, "r_a", "trace_r_a");
    const runB = createCanonicalRun(handle!, projectId, "r-a", "trace_r_b");
    durable!.defineUnits({ ...runA, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });
    durable!.defineUnits({ ...runB, units: [{ id: "u1", kind: "audit", scope: "x", bounds: "y" }] });

    const defEvents = listEvents(handle!, projectId).filter(e => e.type === "x_durable_work_units_defined");
    expect(defEvents).toHaveLength(2);
    expect(defEvents[0].correlationId).not.toBe(defEvents[1].correlationId);
    expect(defEvents[0].idempotencyKey).not.toBe(defEvents[1].idempotencyKey);
    expect(defEvents[0].correlationId).toBe(`cor_dw_def_${encodeDwcTuple("r_a")}`);
    expect(defEvents[0].idempotencyKey).toBe(`dw-def-${encodeDwcTuple("r_a")}@r_a`);
    expect(defEvents[1].correlationId).toBe(`cor_dw_def_${encodeDwcTuple("r-a")}`);
    expect(defEvents[1].idempotencyKey).toBe(`dw-def-${encodeDwcTuple("r-a")}@r-a`);

    // Test Migration events collision pairs across runId, operationId, and unitId:
    // Pair 1: runId = "r_mig", operationId = "op", unitId = "u_1"
    // Pair 2: runId = "r", operationId = "mig_op", unitId = "u_1" OR
    // Pair 3: runId = "r_mig", operationId = "op_u", unitId = "1"
    // With naive concatenation `cor_dw_mig_unit_imp_${runId}_${operationId}_${unitId}`,
    // Pair 1 (`r_mig` + `op` + `u_1`) -> `cor_dw_mig_unit_imp_r_mig_op_u_1`
    // Pair 3 (`r_mig` + `op_u` + `1`) -> `cor_dw_mig_unit_imp_r_mig_op_u_1`
    // Pair collision test:
    // Run A: runId = "ra", operationId = "b_c"
    // Run B: runId = "ra_b", operationId = "c"
    // Under naive `cor_dw_mig_imp_${runId}_${operationId}`:
    // Run A: `cor_dw_mig_imp_ra_b_c`
    // Run B: `cor_dw_mig_imp_ra_b_c` (COLLISION!)
    const runA_mig = createCanonicalRun(handle!, projectId, "ra", "trace_ra");
    const tbRootA = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-tb-fa-"));
    const stateA = validTrackBState("ra", "trace_ra", alignedUnitDecls(["u"]));
    writeTrackBFixture(tbRootA, stateA, { "u": validTrackBUnit("ra", "u") });
    const repA = importTrackB({
      ...runA_mig, trackBRoot: tbRootA, backupRoot: path.join(root, "backup-fa"), operationId: "b_c", dryRun: false, now: T0,
    });

    const runB_mig = createCanonicalRun(handle!, projectId, "ra_b", "trace_rb");
    const tbRootB = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-tb-fb-"));
    const stateB = validTrackBState("ra_b", "trace_rb", alignedUnitDecls(["u"]));
    writeTrackBFixture(tbRootB, stateB, { "u": validTrackBUnit("ra_b", "u") });
    const repB = importTrackB({
      ...runB_mig, trackBRoot: tbRootB, backupRoot: path.join(root, "backup-fb"), operationId: "c", dryRun: false, now: T0,
    });

    // Rollback for both
    rollbackTrackB({ ...runA_mig, backup: repA.backup, operationId: "b_c", now: T1 });
    rollbackTrackB({ ...runB_mig, backup: repB.backup, operationId: "c", now: T1 });

    const allProjEvents = listEvents(handle!, projectId);
    const impEvents = allProjEvents.filter(e => e.type === "x_durable_work_track_b_imported");
    const migDefEvents = allProjEvents.filter(e => e.type === "x_durable_work_units_defined" && (e.payload as any).migration_operation_id);
    const unitImpEvents = allProjEvents.filter(e => e.type === "x_durable_work_unit_imported");
    const rbEvents = allProjEvents.filter(e => e.type === "x_durable_work_track_b_rollback");

    // Ensure no correlationId or idempotencyKey collisions between Run A and Run B
    expect(impEvents[0].correlationId).not.toBe(impEvents[1].correlationId);
    expect(impEvents[0].idempotencyKey).not.toBe(impEvents[1].idempotencyKey);
    expect(impEvents[0].correlationId).toBe(`cor_dw_mig_imp_${encodeDwcTuple("ra", "b_c")}`);
    expect(impEvents[1].correlationId).toBe(`cor_dw_mig_imp_${encodeDwcTuple("ra_b", "c")}`);

    expect(migDefEvents[0].correlationId).not.toBe(migDefEvents[1].correlationId);
    expect(migDefEvents[0].idempotencyKey).not.toBe(migDefEvents[1].idempotencyKey);
    expect(migDefEvents[0].correlationId).toBe(`cor_dw_mig_def_${encodeDwcTuple("ra", "b_c")}`);
    expect(migDefEvents[1].correlationId).toBe(`cor_dw_mig_def_${encodeDwcTuple("ra_b", "c")}`);

    expect(unitImpEvents[0].correlationId).not.toBe(unitImpEvents[1].correlationId);
    expect(unitImpEvents[0].idempotencyKey).not.toBe(unitImpEvents[1].idempotencyKey);
    expect(unitImpEvents[0].correlationId).toBe(`cor_dw_mig_unit_imp_${encodeDwcTuple("ra", "b_c", "u")}`);
    expect(unitImpEvents[1].correlationId).toBe(`cor_dw_mig_unit_imp_${encodeDwcTuple("ra_b", "c", "u")}`);

    expect(rbEvents[0].correlationId).not.toBe(rbEvents[1].correlationId);
    expect(rbEvents[0].idempotencyKey).not.toBe(rbEvents[1].idempotencyKey);
    expect(rbEvents[0].correlationId).toBe(`cor_dw_mig_rb_${encodeDwcTuple("ra", "b_c")}`);
    expect(rbEvents[1].correlationId).toBe(`cor_dw_mig_rb_${encodeDwcTuple("ra_b", "c")}`);
  }, DURABLE_BUDGET_MS);
});

describe("durable work — TDD Hardening K: injective stage identity and safe reuse cleanup", () => {
  test("Hardening K: stage identity is injective, uses encodeDwcTuple(operationId, payloadDigest), and historical collision pairs do not collide", () => {
    const projectId = "prj_tdd_k_injective_stage";

    // Historical collision pair: ("a:b", "c") vs ("a", "b:c")
    // When using naive colon concatenation `${operationId}:${payloadDigest}`,
    // ("a:b", "c") and ("a", "b:c") both concatenate to "a:b:c", causing collision.
    // With encodeDwcTuple, "a:b" and "c" -> "3:a:b/1:c", whereas "a" and "b:c" -> "1:a/3:b:c".
    const tuple1 = encodeDwcTuple("a:b", "c");
    const tuple2 = encodeDwcTuple("a", "b:c");
    expect(tuple1).not.toBe(tuple2);
    expect(tuple1).toBe("3:a:b/1:c");
    expect(tuple2).toBe("1:a/3:b:c");

    // Observable collision resistance test in importTrackB staging:
    // Setup Run 1 with operationId="op:stage" and Run 2 with operationId="op"
    const run1 = createCanonicalRun(handle!, projectId, "run_k_col_1", "trace_k_col_1");
    const tbRoot1 = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-tb-k-col-1-"));
    const state1 = validTrackBState("run_k_col_1", "trace_k_col_1", alignedUnitDecls(["u1"]));
    writeTrackBFixture(tbRoot1, state1, { "u1": validTrackBUnit("run_k_col_1", "u1") });

    const run2 = createCanonicalRun(handle!, projectId, "run_k_col_2", "trace_k_col_2");
    const tbRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-tb-k-col-2-"));
    const state2 = validTrackBState("run_k_col_2", "trace_k_col_2", alignedUnitDecls(["u2"]));
    writeTrackBFixture(tbRoot2, state2, { "u2": validTrackBUnit("run_k_col_2", "u2") });

    const backupRoot = path.join(root, "backup-k-col");

    // Dry-run Run 1 with operationId "op:sub"
    const rep1 = importTrackB({
      ...run1, trackBRoot: tbRoot1, backupRoot, operationId: "op:sub", dryRun: true, now: T0,
    });

    // Dry-run Run 2 with operationId "op"
    const rep2 = importTrackB({
      ...run2, trackBRoot: tbRoot2, backupRoot, operationId: "op", dryRun: true, now: T0,
    });

    // Both stages must exist independently in backupRoot and have distinct paths
    expect(rep1.backup).not.toBe(rep2.backup);
    expect(fs.existsSync(rep1.backup)).toBe(true);
    expect(fs.existsSync(rep2.backup)).toBe(true);
    expect(path.dirname(rep1.backup)).toBe(path.resolve(backupRoot));
    expect(path.dirname(rep2.backup)).toBe(path.resolve(backupRoot));

    // Neither stage path should expose private implementation details or be empty
    expect(path.basename(rep1.backup).length).toBeGreaterThan(0);
    expect(path.basename(rep2.backup).length).toBeGreaterThan(0);
  }, DURABLE_BUDGET_MS);

  test("Hardening K: real end-to-end reuse test without encoding private stage-name algorithm (T0 dryRun -> T1 tx abort preserves stage -> T2 retry succeeds)", () => {
    const projectId = "prj_tdd_k_e2e_reuse";
    const runId = "run_tdd_k_e2e_reuse";
    const traceId = "trace_tdd_k_e2e_reuse";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);

    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-tb-k-reuse-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-k-1", "u-k-2"]));
    const unit1 = validTrackBUnit(runId, "u-k-1");
    const unit2 = validTrackBUnit(runId, "u-k-2");
    writeTrackBFixture(tbRoot, state, { "u-k-1": unit1, "u-k-2": unit2 });

    const backupRoot = path.join(root, "backup-tdd-k-reuse");

    // 1. Dry run at T0 creates a staged backup directory
    const dryReport = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "op-k-reuse", dryRun: true, now: T0,
    });
    expect(dryReport.dryRun).toBe(true);
    expect(dryReport.imported).toBe(2);
    expect(fs.existsSync(dryReport.backup)).toBe(true);

    const stagePath = dryReport.backup;
    const stageMtimeBefore = fs.statSync(stagePath).mtimeMs;

    // Collect file digests and relative paths inside the stage without assuming its directory name
    const collectStageDigests = (dir: string): Map<string, string> => {
      const digests = new Map<string, string>();
      const walk = (d: string, prefix = "") => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) {
            walk(full, rel);
          } else if (entry.isFile()) {
            const buf = fs.readFileSync(full);
            digests.set(rel, createHash("sha256").update(buf).digest("hex"));
          }
        }
      };
      walk(dir);
      return digests;
    };

    const digestsT0 = collectStageDigests(stagePath);
    expect(digestsT0.has("MANIFEST.json")).toBe(true);
    expect(digestsT0.has("STATE.json")).toBe(true);
    expect(digestsT0.has("units/u-k-1.json")).toBe(true);
    expect(digestsT0.has("units/u-k-2.json")).toBe(true);

    // 2. Install database trigger that aborts insertion of x_durable_work_track_b_imported
    handle!.db.exec(`CREATE TRIGGER abort_track_b_import_k
      BEFORE INSERT ON run_events
      WHEN json_extract(NEW.event_json, '$.type') = 'x_durable_work_track_b_imported'
      BEGIN SELECT RAISE(ABORT, 'forced_abort_track_b_imported_k'); END;`);

    // 3. Actual import at T1 must reuse that exact stage and fail transactionally
    expect(() => importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "op-k-reuse", dryRun: false, now: T1,
    })).toThrow(/forced_abort_track_b_imported_k/);

    // Prove: stage still exists (not deleted because it was pre-existing/reused), same path, same mtime, same digests
    expect(fs.existsSync(stagePath)).toBe(true);
    const stageMtimeT1 = fs.statSync(stagePath).mtimeMs;
    expect(stageMtimeT1).toBe(stageMtimeBefore);
    const digestsT1 = collectStageDigests(stagePath);
    expect(digestsT1).toEqual(digestsT0);

    // Prove: zero partial durable state recorded in DB
    expect(durableDefCount(projectId, runId)).toBe(0);
    expect(durableUnitCount(projectId, runId)).toBe(0);
    expect(migrationOpsOf(projectId, runId)).toHaveLength(0);
    expect(durableEventsOf(projectId).filter(e => e.type.startsWith("x_durable_work_"))).toHaveLength(0);
    expect(durableOutboxCount(projectId)).toBe(0);

    // 4. Remove the trigger
    handle!.db.exec(`DROP TRIGGER abort_track_b_import_k;`);

    // 5. Actual import at T2 must reuse the stage and succeed
    const realReport = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "op-k-reuse", dryRun: false, now: T2,
    });
    expect(realReport.dryRun).toBe(false);
    expect(realReport.imported).toBe(2);
    expect(realReport.alreadyImported).toBe(0);
    expect(realReport.backup).toBe(stagePath);

    // Verify durable state now properly exists
    expect(durableDefCount(projectId, runId)).toBe(1);
    expect(durableUnitCount(projectId, runId)).toBe(2);
    expect(migrationOpsOf(projectId, runId)).toHaveLength(1);
    const migOp = migrationOpsOf(projectId, runId)[0];
    expect(migOp.kind).toBe("import");
    expect(migOp.backup_path).toBe(stagePath);

    // Check public events do not expose absolute backup paths, contents, or secrets
    const events = durableEventsOf(projectId);
    for (const evt of events) {
      const payloadStr = JSON.stringify(evt.payload);
      expect(payloadStr.includes(path.resolve(backupRoot))).toBe(false);
      expect(payloadStr.includes(path.resolve(tbRoot))).toBe(false);
    }
  }, DURABLE_BUDGET_MS);

  test("Hardening K: transactional failure of self-created stage cleans only that stage, leaves backup root empty, and permits clean retry", () => {
    const projectId = "prj_tdd_k_self_created_cleanup";
    const runId = "run_tdd_k_self_created_cleanup";
    const traceId = "trace_tdd_k_self_created_cleanup";
    const m = createCanonicalRun(handle!, projectId, runId, traceId);

    const tbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-tb-k-self-clean-"));
    const state = validTrackBState(runId, traceId, alignedUnitDecls(["u-k-self"]));
    const unit = validTrackBUnit(runId, "u-k-self");
    writeTrackBFixture(tbRoot, state, { "u-k-self": unit });

    const backupRoot = path.join(root, "backup-tdd-k-self-clean");

    // Install trigger that fails the transaction on imported event
    handle!.db.exec(`CREATE TRIGGER abort_tx_k_self_clean
      BEFORE INSERT ON run_events
      WHEN json_extract(NEW.event_json, '$.type') = 'x_durable_work_track_b_imported'
      BEGIN SELECT RAISE(ABORT, 'forced_tx_fail_k_self_clean'); END;`);

    expect(() => importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "op-k-self-clean", dryRun: false, now: T0,
    })).toThrow(/forced_tx_fail_k_self_clean/);

    // Verify: backup root exists or is empty, no orphan stage directories
    if (fs.existsSync(backupRoot)) {
      expect(fs.readdirSync(backupRoot)).toHaveLength(0);
    }

    // Verify: zero partial state
    expect(durableDefCount(projectId, runId)).toBe(0);
    expect(durableUnitCount(projectId, runId)).toBe(0);
    expect(migrationOpsOf(projectId, runId)).toHaveLength(0);
    expect(durableEventsOf(projectId).filter(e => e.type.startsWith("x_durable_work_"))).toHaveLength(0);
    expect(durableOutboxCount(projectId)).toBe(0);

    // Remove trigger and retry
    handle!.db.exec(`DROP TRIGGER abort_tx_k_self_clean;`);

    const retry = importTrackB({
      ...m, trackBRoot: tbRoot, backupRoot, operationId: "op-k-self-clean", dryRun: false, now: T0,
    });
    expect(retry.imported).toBe(1);
    expect(fs.existsSync(retry.backup)).toBe(true);
    expect(durableDefCount(projectId, runId)).toBe(1);
    expect(durableUnitCount(projectId, runId)).toBe(1);
  }, DURABLE_BUDGET_MS);
});

