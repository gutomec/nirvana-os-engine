import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database, SQLiteError } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  RunKernelCompatibilityFacade,
  ExecutionScope,
  createHarnessLegacyAdapter,
  appendEvent,
  appendTranscriptMessage,
  createRun,
  getRun,
  legacyErrorFor,
  legacyStateFor,
  listEvents,
  openKernel,
  pendingOutboxCount,
  projectionSnapshot,
  publishOutbox,
  rebuildProjections,
  saveArtifactRef,
  transitionRun,
  verifyArtifactRef,
  type ArtifactRef,
  type KernelHandle,
} from "../lib/run-kernel/index.ts";
import { getRun as getLegacyRun, openLedger } from "../lib/run-ledger.ts";
import { KERNEL_BUDGET_MS } from "./helpers/test-budgets.ts";

const roots: string[] = [];
const handles: KernelHandle[] = [];

function fresh(): { handle: KernelHandle; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-kernel-"));
  roots.push(root);
  const handle = openKernel(path.join(root, "kernel.sqlite"));
  handles.push(handle);
  return { handle, root };
}

function runInput(projectId = "prj_a", runId = "run_a") {
  return {
    projectId, runId, traceId: `trace_${projectId}`, planId: "plan_1",
    target: { kind: "squad" as const, slug: "systems-atelier", capabilityId: "software.run-kernel.implement" },
    policySnapshotRef: "sha256:policy", actor: { kind: "squad", id: "systems-atelier" },
    correlationId: `cor_${projectId}`, occurredAt: "2026-08-25T12:00:00.000Z",
  };
}

afterEach(() => {
  while (handles.length) {
    try { handles.pop()!.close(); } catch { /* already closed */ }
  }
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("canonical lifecycle and journal", () => {
  test("assigns monotonic project sequence and preserves causal links", () => {
    const { handle } = fresh();
    createRun(handle, runInput());
    const running = transitionRun(handle, {
      projectId: "prj_a", runId: "run_a", to: "running", actor: { kind: "kernel", id: "test" },
      correlationId: "cor_prj_a", causationId: listEvents(handle, "prj_a")[0].eventId,
      occurredAt: "2026-08-25T12:00:01.000Z",
    });
    expect(running.state).toBe("running");
    const events = listEvents(handle, "prj_a");
    expect(events.map(event => event.sequence)).toEqual([1, 2]);
    expect(events[1].causationId).toBe(events[0].eventId);

    createRun(handle, runInput("prj_b", "run_b"));
    expect(listEvents(handle, "prj_b")[0].sequence).toBe(1);
    expect(() => appendEvent(handle, {
      projectId: "prj_b", runId: "run_b", traceId: "trace_prj_b", type: "cross-project.invalid",
      actor: { kind: "kernel", id: "test" }, correlationId: "cor", causationId: events[0].eventId,
    })).toThrow(/cannot cross project/);
  }, KERNEL_BUDGET_MS);

  test("rejects invalid and terminal transitions", () => {
    const { handle } = fresh();
    createRun(handle, runInput());
    expect(() => transitionRun(handle, { projectId: "prj_a", runId: "run_a", to: "completed", actor: { kind: "kernel", id: "test" }, correlationId: "cor" }))
      .toThrow(/illegal transition prepared -> completed/);
    transitionRun(handle, { projectId: "prj_a", runId: "run_a", to: "rolled_back", actor: { kind: "kernel", id: "test" }, correlationId: "cor" });
    expect(() => transitionRun(handle, { projectId: "prj_a", runId: "run_a", to: "running", actor: { kind: "kernel", id: "test" }, correlationId: "cor" }))
      .toThrow(/illegal transition rolled_back -> running/);
  }, KERNEL_BUDGET_MS);

  test("replays duplicate identities once and rejects divergent payloads", () => {
    const { handle } = fresh();
    const base = {
      eventId: "evt_fixed", projectId: "prj_a", runId: "run_a", traceId: "trace_a", type: "cost.recorded",
      actor: { kind: "kernel", id: "test" }, correlationId: "cor", idempotencyKey: "cost-1",
      occurredAt: "2026-08-25T12:00:00.000Z", payload: { usd: 1 },
    };
    const first = appendEvent(handle, base);
    const duplicate = appendEvent(handle, base);
    expect(duplicate).toEqual(first);
    expect(listEvents(handle, "prj_a")).toHaveLength(1);
    expect(() => appendEvent(handle, { ...base, payload: { usd: 2 } })).toThrow(/identity conflict/);
  }, KERNEL_BUDGET_MS);

  test("retries run creation and transition commands by idempotency key", () => {
    const { handle } = fresh();
    const created = createRun(handle, { ...runInput(), occurredAt: undefined, idempotencyKey: "create-1" });
    expect(createRun(handle, { ...runInput(), occurredAt: undefined, idempotencyKey: "create-1" })).toEqual(created);
    const transition = { projectId: "prj_a", runId: "run_a", to: "running" as const, actor: { kind: "kernel", id: "test" }, correlationId: "cor", idempotencyKey: "transition-1" };
    const running = transitionRun(handle, transition);
    expect(transitionRun(handle, transition)).toEqual(running);
    expect(listEvents(handle, "prj_a")).toHaveLength(2);
  }, KERNEL_BUDGET_MS);

  test("rebuild produces the same deterministic projection snapshot", () => {
    const { handle } = fresh();
    createRun(handle, runInput());
    transitionRun(handle, { projectId: "prj_a", runId: "run_a", to: "running", actor: { kind: "kernel", id: "test" }, correlationId: "cor", occurredAt: "2026-08-25T12:00:01.000Z" });
    transitionRun(handle, { projectId: "prj_a", runId: "run_a", to: "verifying", actor: { kind: "kernel", id: "test" }, correlationId: "cor", occurredAt: "2026-08-25T12:00:02.000Z" });
    const before = projectionSnapshot(handle, "prj_a");
    rebuildProjections(handle, "prj_a");
    expect(projectionSnapshot(handle, "prj_a")).toBe(before);
  }, KERNEL_BUDGET_MS);

  test("x_run_route_resolved re-targets a prepared run in the projection, refuses a run past prepared, and replays", () => {
    const { handle } = fresh();
    createRun(handle, { ...runInput(), target: { kind: "agent-x", slug: "agent-x" } });
    const actor = { kind: "control-plane", id: "glance" };
    const resolved = { target: { kind: "business" as const, slug: "web-studio" }, route: { source: "router" as const, rationale: "OBJECT=site." } };
    appendEvent(handle, { projectId: "prj_a", runId: "run_a", traceId: "trace_prj_a", type: "x_run_route_resolved", actor, correlationId: "cor",
      idempotencyKey: "x_run_route_resolved:run_a", occurredAt: "2026-08-25T12:00:01.000Z", payload: resolved });
    expect(getRun(handle, "prj_a", "run_a")).toMatchObject({ ...resolved, state: "prepared", version: 2, lastSequence: 2, updatedAt: "2026-08-25T12:00:01.000Z" });
    transitionRun(handle, { projectId: "prj_a", runId: "run_a", to: "running", actor, correlationId: "cor", occurredAt: "2026-08-25T12:00:02.000Z" });
    expect(() => appendEvent(handle, { projectId: "prj_a", runId: "run_a", traceId: "trace_prj_a", type: "x_run_route_resolved", actor, correlationId: "cor",
      payload: { target: { kind: "squad", slug: "other", capabilityId: "squad.execute" }, route: { source: "router", rationale: "late" } } })).toThrow(/a route resolves a prepared run, found running/);
    expect(getRun(handle, "prj_a", "run_a")).toMatchObject({ ...resolved, state: "running", version: 3 });
    const before = projectionSnapshot(handle, "prj_a");
    rebuildProjections(handle, "prj_a");
    expect(projectionSnapshot(handle, "prj_a")).toBe(before);
  }, KERNEL_BUDGET_MS);

  test("isolates runs and event cursors by project", () => {
    const { handle } = fresh();
    createRun(handle, runInput("prj_a", "run_same"));
    createRun(handle, runInput("prj_b", "run_same"));
    transitionRun(handle, { projectId: "prj_a", runId: "run_same", to: "running", actor: { kind: "kernel", id: "test" }, correlationId: "cor" });
    expect(getRun(handle, "prj_a", "run_same")?.state).toBe("running");
    expect(getRun(handle, "prj_b", "run_same")?.state).toBe("prepared");
    expect(listEvents(handle, "prj_a", 1)).toHaveLength(1);
    expect(listEvents(handle, "prj_b", 1)).toHaveLength(0);
  }, KERNEL_BUDGET_MS);
});

describe("durable outbox and transcript", () => {
  test("recovers a pending event after a simulated publisher failure", async () => {
    const { handle } = fresh();
    createRun(handle, runInput());
    expect(pendingOutboxCount(handle)).toBe(1);
    await expect(publishOutbox(handle, () => { throw new Error("simulated crash"); })).rejects.toThrow("simulated crash");
    expect(pendingOutboxCount(handle)).toBe(1);
    const received = new Set<string>();
    expect(await publishOutbox(handle, event => { received.add(event.eventId); })).toBe(1);
    expect(received.size).toBe(1);
    expect(pendingOutboxCount(handle)).toBe(0);
    expect(await publishOutbox(handle, () => { throw new Error("must not republish"); })).toBe(0);
  }, KERNEL_BUDGET_MS);

  test("stores the visible transcript separately and links it by ID", () => {
    const { handle } = fresh();
    createRun(handle, runInput());
    appendTranscriptMessage(handle, { messageId: "msg_1", projectId: "prj_a", runId: "run_a", role: "assistant", content: "Resultado visível.", createdAt: "2026-08-25T12:00:01.000Z" });
    const event = appendEvent(handle, { projectId: "prj_a", runId: "run_a", traceId: "trace_prj_a", type: "transcript.linked", actor: { kind: "kernel", id: "test" }, correlationId: "cor", transcriptMessageId: "msg_1" });
    expect(event.transcriptMessageId).toBe("msg_1");
    const columns = handle.db.query("PRAGMA table_info(transcript_messages)").all() as { name: string }[];
    expect(columns.map(column => column.name)).toEqual(["message_id", "project_id", "run_id", "role", "content", "created_at"]);
  }, KERNEL_BUDGET_MS);
});

describe("execution scopes", () => {
  test("child authority can restrict but never widen a parent denial", async () => {
    const parent = new ExecutionScope("run", { filesystem: "allow", process: "deny", network: "deny", secrets: "allow", host: "deny" });
    const child = parent.child("agent", { filesystem: "deny", process: "allow", network: "allow", secrets: "allow", host: "allow" });
    expect(child.policy).toEqual({ filesystem: "deny", process: "deny", network: "deny", secrets: "allow", host: "deny" });
    const order: string[] = [];
    child.owns(() => { order.push("first"); });
    child.owns(() => { order.push("second"); });
    await child.dispose();
    await child.dispose();
    expect(order).toEqual(["second", "first"]);
    expect(() => child.owns(() => {})).toThrow(/disposed/);
  });
});

describe("ArtifactRef and compatibility facade", () => {
  test("verifies immutable artifact metadata and detects later changes", () => {
    const { handle, root } = fresh();
    const artifactPath = path.join(root, "report.md");
    fs.writeFileSync(artifactPath, "conteúdo íntegro", "utf8");
    const content = fs.readFileSync(artifactPath);
    const ref: ArtifactRef = {
      schemaVersion: "nirvana.artifact-ref/v1alpha1", projectId: "prj_a", runId: "run_a",
      artifactId: "art_report", revisionId: "arv_report_001", revision: 1, role: "deliverable",
      mediaType: "text/markdown", bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"), publishedUri: pathToFileURL(artifactPath).href,
      classification: "internal", producer: { targetKind: "squad", targetSlug: "systems-atelier", capabilityId: "software.run-kernel.implement" },
    };
    verifyArtifactRef(ref, root);
    saveArtifactRef(handle, ref);
    saveArtifactRef(handle, ref);
    expect(() => saveArtifactRef(handle, { ...ref, bytes: ref.bytes + 1 })).toThrow(/revision conflict/);
    fs.appendFileSync(artifactPath, " alterado", "utf8");
    expect(() => verifyArtifactRef(ref, root)).toThrow(/byte count mismatch/);
  }, KERNEL_BUDGET_MS);

  test("rejects artifacts outside the authorized workspace", () => {
    const { root } = fresh();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-outside-"));
    roots.push(outsideRoot);
    const outside = path.join(outsideRoot, "secret.txt");
    fs.writeFileSync(outside, "secret", "utf8");
    const content = fs.readFileSync(outside);
    expect(() => verifyArtifactRef({
      schemaVersion: "nirvana.artifact-ref/v1alpha1", projectId: "prj_a", runId: "run_a",
      artifactId: "art_secret", revisionId: "arv_secret_001", revision: 1, role: "deliverable",
      mediaType: "text/plain", bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex"),
      publishedUri: pathToFileURL(outside).href, classification: "internal",
      producer: { targetKind: "agent-x", targetSlug: "agent-x" },
    }, root)).toThrow(/escapes/);
  }, KERNEL_BUDGET_MS);

  test("dual-writes through an opt-in legacy adapter without changing canonical semantics", () => {
    const { handle } = fresh();
    const calls: string[] = [];
    const facade = new RunKernelCompatibilityFacade(handle, {
      openRun: run => calls.push(`open:${legacyStateFor(run.state)}`),
      transitionRun: (_run, state) => calls.push(`transition:${state}`),
    });
    facade.create(runInput());
    facade.transition({ projectId: "prj_a", runId: "run_a", to: "running", actor: { kind: "kernel", id: "test" }, correlationId: "cor" });
    facade.transition({ projectId: "prj_a", runId: "run_a", to: "verifying", actor: { kind: "kernel", id: "test" }, correlationId: "cor" });
    facade.transition({ projectId: "prj_a", runId: "run_a", to: "delivered_with_reservations", actor: { kind: "kernel", id: "test" }, correlationId: "cor" });
    expect(calls).toEqual(["open:dispatched", "transition:running", "transition:verifying", "transition:delivered"]);
    expect(getRun(handle, "prj_a", "run_a")?.state).toBe("delivered_with_reservations");
  }, KERNEL_BUDGET_MS);

  test("opens and updates the existing ledger while preserving its schema and audit projection", async () => {
    const { handle, root } = fresh();
    const previousLogs = process.env.HARNESS_LOGS_DIR;
    const previousState = process.env.NIRVANA_STATE_DB;
    process.env.HARNESS_LOGS_DIR = path.join(root, "logs");
    process.env.NIRVANA_STATE_DB = path.join(root, "state.sqlite");
    const ledger = openLedger(path.join(root, "legacy-ledger.sqlite"));
    try {
      const facade = new RunKernelCompatibilityFacade(handle, createHarnessLegacyAdapter({ ledger, auditCwd: root }));
      facade.create(runInput());
      facade.transition({ projectId: "prj_a", runId: "run_a", to: "running", actor: { kind: "kernel", id: "test" }, correlationId: "cor" });
      facade.transition({ projectId: "prj_a", runId: "run_a", to: "verifying", actor: { kind: "kernel", id: "test" }, correlationId: "cor" });
      facade.transition({ projectId: "prj_a", runId: "run_a", to: "completed", actor: { kind: "kernel", id: "test" }, correlationId: "cor" });
      expect(await facade.publishPending()).toBe(4);
      expect(getLegacyRun(ledger, "run_a")?.state).toBe("delivered");
      expect(getRun(handle, "prj_a", "run_a")?.state).toBe("completed");
      const columns = ledger.db.query("PRAGMA table_info(runs)").all() as { name: string }[];
      expect(columns.map(column => column.name)).toContain("lease_expires_at");
      const auditFiles = fs.readdirSync(path.join(root, "logs"), { recursive: true })
        .filter(entry => String(entry).endsWith("audit.jsonl"));
      expect(auditFiles.length).toBeGreaterThan(0);
    } finally {
      ledger.close();
      process.env.HARNESS_LOGS_DIR = previousLogs ?? PRELOAD_LOGS_DIR;
      if (previousState === undefined) delete process.env.NIRVANA_STATE_DB; else process.env.NIRVANA_STATE_DB = previousState;
    }
  }, KERNEL_BUDGET_MS);

  test("projects every canonical failure as a legacy `failed` row whose last_error is the transition's error, else its reason", () => {
    const { handle, root } = fresh();
    const previousLogs = process.env.HARNESS_LOGS_DIR;
    const previousState = process.env.NIRVANA_STATE_DB;
    process.env.HARNESS_LOGS_DIR = path.join(root, "logs");
    process.env.NIRVANA_STATE_DB = path.join(root, "state.sqlite");
    const ledger = openLedger(path.join(root, "legacy-ledger.sqlite"));
    const actor = { kind: "kernel", id: "test" };
    try {
      const facade = new RunKernelCompatibilityFacade(handle, createHarnessLegacyAdapter({ ledger, auditCwd: root }));
      facade.create(runInput("prj_a", "run_failed"));
      facade.transition({ projectId: "prj_a", runId: "run_failed", to: "running", actor, correlationId: "cor" });
      facade.transition({ projectId: "prj_a", runId: "run_failed", to: "failed", actor, correlationId: "cor", payload: { error: "runtime crashed" } });
      expect(getLegacyRun(ledger, "run_failed")).toMatchObject({ state: "failed", last_error: "runtime crashed", meta: { canonical_state: "failed" } });
      // A rollback before the producer names its reason and the errors behind it.
      facade.create(runInput("prj_a", "run_rolled_back"));
      facade.transition({ projectId: "prj_a", runId: "run_rolled_back", to: "rolled_back", actor, correlationId: "cor",
        payload: { reason: "evaluator_unavailable", errors: ["no judge-x persona for runtime 'qwen-code'"] } });
      expect(getLegacyRun(ledger, "run_rolled_back")).toMatchObject({ state: "failed", last_error: "evaluator_unavailable: no judge-x persona for runtime 'qwen-code'",
        meta: { canonical_state: "rolled_back" } });
      expect(legacyErrorFor("rolled_back", { reason: "max_cost" })).toBe("max_cost");
      expect(legacyErrorFor("cancelled")).toBe("cancelled");
      expect(legacyErrorFor("failed", { error: "", reason: "runtime_incompatible", errors: ["model unknown", 42] })).toBe("runtime_incompatible: model unknown");
    } finally {
      ledger.close();
      process.env.HARNESS_LOGS_DIR = previousLogs ?? PRELOAD_LOGS_DIR;
      if (previousState === undefined) delete process.env.NIRVANA_STATE_DB; else process.env.NIRVANA_STATE_DB = previousState;
    }
  }, KERNEL_BUDGET_MS);
});

describe("two processes writing one kernel", () => {
  // The Glance server and the dispatch child it spawns append to the same run-kernel.sqlite.
  // A transaction that begins deferred takes its read snapshot first and only then asks for the
  // write lock; SQLite answers that upgrade with SQLITE_BUSY at once, without consulting the busy
  // handler, whenever another connection wrote in between. Every kernel write therefore begins
  // immediate, so it waits on busy_timeout like any other writer instead of failing.
  test("a child hammering appendEvent never makes the parent's writes fail with SQLITE_BUSY", async () => {
    const { handle, root } = fresh();
    const kernelPath = handle.path;
    createRun(handle, { ...runInput("prj_busy", "run_parent"), occurredAt: undefined });
    const store = pathToFileURL(path.resolve(import.meta.dir, "..", "lib", "run-kernel", "store.ts")).href;
    const writer = path.join(root, "writer.ts");
    fs.writeFileSync(writer, `
import { appendEvent, createRun, openKernel } from ${JSON.stringify(store)};

/** The isolated root the test preload created. Captured before any test
 *  mutates the env, so a teardown restores isolation instead of removing it. */
const PRELOAD_LOGS_DIR = process.env.HARNESS_LOGS_DIR!;
const kernel = openKernel(process.argv[2]);
const actor = { kind: "test", id: "child" };
createRun(kernel, { projectId: "prj_busy", runId: "run_child", traceId: "trace_child", planId: "plan_child",
  target: { kind: "agent-x", slug: "agent-x" }, policySnapshotRef: "test", actor, correlationId: "cor_child" });
const deadline = Date.now() + Number(process.argv[3]);
let count = 0;
while (Date.now() < deadline) {
  appendEvent(kernel, { projectId: "prj_busy", runId: "run_child", traceId: "trace_child", type: "test.child_write", actor, correlationId: "cor_child", payload: { count } });
  count += 1;
}
kernel.close();
console.log(count);
`, "utf8");
    const child = Bun.spawn([process.execPath, writer, kernelPath, "1500"], { stdout: "pipe", stderr: "pipe" });
    const deadline = Date.now() + 10_000;
    while (!listEvents(handle, "prj_busy").some(event => event.type === "test.child_write")) {
      if (Date.now() > deadline) throw new Error("the child never started writing");
      await Bun.sleep(5);
    }
    const actor = { kind: "test", id: "parent" };
    let parentWrites = 0;
    const until = Date.now() + 1_000;
    while (Date.now() < until) {
      appendEvent(handle, { projectId: "prj_busy", runId: "run_parent", traceId: "trace_prj_busy", type: "test.parent_write", actor, correlationId: "cor_prj_busy", payload: { parentWrites } });
      parentWrites += 1;
    }
    transitionRun(handle, { projectId: "prj_busy", runId: "run_parent", to: "running", actor, correlationId: "cor_prj_busy" });
    expect(await child.exited).toBe(0);
    const childWrites = Number((await new Response(child.stdout).text()).trim());
    expect(parentWrites).toBeGreaterThan(0);
    expect(childWrites).toBeGreaterThan(0);
    const events = listEvents(handle, "prj_busy");
    expect(events).toHaveLength(parentWrites + childWrites + 3);
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(getRun(handle, "prj_busy", "run_parent")?.state).toBe("running");
  }, 30000);
});

describe("opening a kernel", () => {
  // openKernel opens the Database and only then runs initialize (the journal pragmas and the
  // schema). On Windows, PRAGMA journal_mode = WAL right after a child process died failed with
  // SQLITE_IOERR_TRUNCATE, and the handle left open kept the file locked: every rmSync on that
  // directory cascaded into EBUSY during teardown (run 32929139083). A file that is not a SQLite
  // database provokes the same shape deterministically: SQLite reads nothing at open, so
  // new Database() succeeds and the first pragma fails with SQLITE_NOTADB.
  test("closes the database and rethrows the original error when initialize fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-kernel-"));
    roots.push(root);
    const kernelPath = path.join(root, "kernel.sqlite");
    fs.writeFileSync(kernelPath, "not a sqlite database\n", "utf8");
    // Unlinking an open file succeeds on POSIX, so rmSync below only proves the fix on Windows;
    // the spy makes a leaked handle visible on every OS.
    const close = spyOn(Database.prototype, "close");
    try {
      let thrown: unknown;
      try { openKernel(kernelPath); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(SQLiteError);
      expect((thrown as SQLiteError).code).toBe("SQLITE_NOTADB");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
    fs.rmSync(kernelPath);
    const reopened = openKernel(kernelPath);
    handles.push(reopened);
    createRun(reopened, runInput());
    expect(getRun(reopened, "prj_a", "run_a")?.state).toBe("prepared");
  }, KERNEL_BUDGET_MS);
});
