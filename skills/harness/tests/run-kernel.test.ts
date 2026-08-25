import { afterEach, describe, expect, test } from "bun:test";
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
  });

  test("rejects invalid and terminal transitions", () => {
    const { handle } = fresh();
    createRun(handle, runInput());
    expect(() => transitionRun(handle, { projectId: "prj_a", runId: "run_a", to: "completed", actor: { kind: "kernel", id: "test" }, correlationId: "cor" }))
      .toThrow(/illegal transition prepared -> completed/);
    transitionRun(handle, { projectId: "prj_a", runId: "run_a", to: "rolled_back", actor: { kind: "kernel", id: "test" }, correlationId: "cor" });
    expect(() => transitionRun(handle, { projectId: "prj_a", runId: "run_a", to: "running", actor: { kind: "kernel", id: "test" }, correlationId: "cor" }))
      .toThrow(/illegal transition rolled_back -> running/);
  });

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
  });

  test("retries run creation and transition commands by idempotency key", () => {
    const { handle } = fresh();
    const created = createRun(handle, { ...runInput(), occurredAt: undefined, idempotencyKey: "create-1" });
    expect(createRun(handle, { ...runInput(), occurredAt: undefined, idempotencyKey: "create-1" })).toEqual(created);
    const transition = { projectId: "prj_a", runId: "run_a", to: "running" as const, actor: { kind: "kernel", id: "test" }, correlationId: "cor", idempotencyKey: "transition-1" };
    const running = transitionRun(handle, transition);
    expect(transitionRun(handle, transition)).toEqual(running);
    expect(listEvents(handle, "prj_a")).toHaveLength(2);
  });

  test("rebuild produces the same deterministic projection snapshot", () => {
    const { handle } = fresh();
    createRun(handle, runInput());
    transitionRun(handle, { projectId: "prj_a", runId: "run_a", to: "running", actor: { kind: "kernel", id: "test" }, correlationId: "cor", occurredAt: "2026-08-25T12:00:01.000Z" });
    transitionRun(handle, { projectId: "prj_a", runId: "run_a", to: "verifying", actor: { kind: "kernel", id: "test" }, correlationId: "cor", occurredAt: "2026-08-25T12:00:02.000Z" });
    const before = projectionSnapshot(handle, "prj_a");
    rebuildProjections(handle, "prj_a");
    expect(projectionSnapshot(handle, "prj_a")).toBe(before);
  });

  test("isolates runs and event cursors by project", () => {
    const { handle } = fresh();
    createRun(handle, runInput("prj_a", "run_same"));
    createRun(handle, runInput("prj_b", "run_same"));
    transitionRun(handle, { projectId: "prj_a", runId: "run_same", to: "running", actor: { kind: "kernel", id: "test" }, correlationId: "cor" });
    expect(getRun(handle, "prj_a", "run_same")?.state).toBe("running");
    expect(getRun(handle, "prj_b", "run_same")?.state).toBe("prepared");
    expect(listEvents(handle, "prj_a", 1)).toHaveLength(1);
    expect(listEvents(handle, "prj_b", 1)).toHaveLength(0);
  });
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
  });

  test("stores the visible transcript separately and links it by ID", () => {
    const { handle } = fresh();
    createRun(handle, runInput());
    appendTranscriptMessage(handle, { messageId: "msg_1", projectId: "prj_a", runId: "run_a", role: "assistant", content: "Resultado visível.", createdAt: "2026-08-25T12:00:01.000Z" });
    const event = appendEvent(handle, { projectId: "prj_a", runId: "run_a", traceId: "trace_prj_a", type: "transcript.linked", actor: { kind: "kernel", id: "test" }, correlationId: "cor", transcriptMessageId: "msg_1" });
    expect(event.transcriptMessageId).toBe("msg_1");
    const columns = handle.db.query("PRAGMA table_info(transcript_messages)").all() as { name: string }[];
    expect(columns.map(column => column.name)).toEqual(["message_id", "project_id", "run_id", "role", "content", "created_at"]);
  });
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
  });

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
  });

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
  });

  test("opens and updates the existing ledger while preserving its schema and audit projection", () => {
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
      expect(getLegacyRun(ledger, "run_a")?.state).toBe("delivered");
      expect(getRun(handle, "prj_a", "run_a")?.state).toBe("completed");
      const columns = ledger.db.query("PRAGMA table_info(runs)").all() as { name: string }[];
      expect(columns.map(column => column.name)).toContain("lease_expires_at");
      const auditFiles = fs.readdirSync(path.join(root, "logs"), { recursive: true })
        .filter(entry => String(entry).endsWith("audit.jsonl"));
      expect(auditFiles.length).toBeGreaterThan(0);
    } finally {
      ledger.close();
      if (previousLogs === undefined) delete process.env.HARNESS_LOGS_DIR; else process.env.HARNESS_LOGS_DIR = previousLogs;
      if (previousState === undefined) delete process.env.NIRVANA_STATE_DB; else process.env.NIRVANA_STATE_DB = previousState;
    }
  });
});
