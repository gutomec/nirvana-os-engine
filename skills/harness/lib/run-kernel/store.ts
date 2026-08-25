import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { assertTransition } from "./lifecycle.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { ArtifactRef, CanonicalRunState, RunEvent, RunProjection, TargetRef, TranscriptMessage } from "./types.ts";

export interface KernelHandle {
  db: Database;
  path: string;
  close(): void;
}

export interface CreateRunInput {
  projectId: string;
  runId?: string;
  traceId: string;
  conversationId?: string;
  parentRunId?: string;
  planId: string;
  target: TargetRef;
  policySnapshotRef: string;
  actor: { kind: string; id: string };
  correlationId: string;
  idempotencyKey?: string;
  occurredAt?: string;
}

export interface TransitionInput {
  projectId: string;
  runId: string;
  to: CanonicalRunState;
  actor: { kind: string; id: string };
  correlationId: string;
  causationId?: string;
  idempotencyKey?: string;
  occurredAt?: string;
  payload?: Record<string, unknown>;
}

export interface AppendEventInput {
  eventId?: string;
  projectId: string;
  runId: string;
  traceId: string;
  type: string;
  actor: { kind: string; id: string };
  correlationId: string;
  causationId?: string;
  idempotencyKey?: string;
  transcriptMessageId?: string;
  occurredAt?: string;
  payload?: Record<string, unknown>;
}

function initialize(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS kernel_schema (version INTEGER NOT NULL);
    INSERT INTO kernel_schema(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM kernel_schema);
    CREATE TABLE IF NOT EXISTS project_sequences (
      project_id TEXT PRIMARY KEY,
      last_sequence INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS run_events (
      event_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      idempotency_key TEXT,
      event_json TEXT NOT NULL,
      UNIQUE(project_id, sequence),
      UNIQUE(project_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_kernel_events_run ON run_events(project_id, run_id, sequence);
    CREATE TABLE IF NOT EXISTS run_projections (
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      projection_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      last_sequence INTEGER NOT NULL,
      PRIMARY KEY(project_id, run_id)
    );
    CREATE TABLE IF NOT EXISTS kernel_outbox (
      event_id TEXT PRIMARY KEY REFERENCES run_events(event_id),
      project_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      payload TEXT NOT NULL,
      published_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_kernel_outbox_pending ON kernel_outbox(published_at, project_id, sequence);
    CREATE TABLE IF NOT EXISTS transcript_messages (
      message_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, run_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS artifact_refs (
      revision_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      ref_json TEXT NOT NULL,
      UNIQUE(project_id, artifact_id, revision)
    );`);
}

export function openKernel(dbPath: string): KernelHandle {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  initialize(db);
  return { db, path: dbPath, close: () => db.close() };
}

function parseEvent(row: { event_json: string } | null): RunEvent | null {
  return row ? JSON.parse(row.event_json) as RunEvent : null;
}

function existingByIdentity(handle: KernelHandle, input: AppendEventInput, eventId: string): RunEvent | null {
  const byId = parseEvent(handle.db.query("SELECT event_json FROM run_events WHERE event_id = ?").get(eventId) as { event_json: string } | null);
  if (byId) return byId;
  if (!input.idempotencyKey) return null;
  return parseEvent(handle.db.query("SELECT event_json FROM run_events WHERE project_id = ? AND idempotency_key = ?")
    .get(input.projectId, input.idempotencyKey) as { event_json: string } | null);
}

function comparableEvent(event: RunEvent): Record<string, unknown> {
  const { sequence: _sequence, recordedAt: _recordedAt, ...comparable } = event;
  return comparable;
}

export function appendEvent(handle: KernelHandle, input: AppendEventInput): RunEvent {
  const prior = input.eventId
    ? parseEvent(handle.db.query("SELECT event_json FROM run_events WHERE event_id = ?").get(input.eventId) as { event_json: string } | null)
    : input.idempotencyKey
      ? parseEvent(handle.db.query("SELECT event_json FROM run_events WHERE project_id = ? AND idempotency_key = ?")
        .get(input.projectId, input.idempotencyKey) as { event_json: string } | null)
      : null;
  const eventId = input.eventId ?? prior?.eventId ?? `evt_${randomUUID()}`;
  const occurredAt = input.occurredAt ?? prior?.occurredAt ?? new Date().toISOString();
  const candidate = {
    schemaVersion: "nirvana.event/v1alpha1" as const,
    eventId, projectId: input.projectId, runId: input.runId, traceId: input.traceId,
    type: input.type, occurredAt, actor: input.actor, correlationId: input.correlationId,
    ...(input.causationId ? { causationId: input.causationId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.transcriptMessageId ? { transcriptMessageId: input.transcriptMessageId } : {}),
    payload: input.payload ?? {},
  };

  return handle.db.transaction(() => {
    const existing = existingByIdentity(handle, input, eventId);
    if (existing) {
      if (canonicalJson(comparableEvent(existing)) !== canonicalJson(candidate)) {
        throw new Error(`run-kernel: event identity conflict for '${existing.eventId}'`);
      }
      return existing;
    }
    if (candidate.causationId) {
      const cause = handle.db.query("SELECT project_id FROM run_events WHERE event_id = ?").get(candidate.causationId) as { project_id: string } | null;
      if (!cause) throw new Error(`run-kernel: causation event '${candidate.causationId}' not found`);
      if (cause.project_id !== candidate.projectId) throw new Error("run-kernel: causation cannot cross project boundaries");
    }
    if (candidate.transcriptMessageId) {
      const message = handle.db.query("SELECT project_id, run_id FROM transcript_messages WHERE message_id = ?")
        .get(candidate.transcriptMessageId) as { project_id: string; run_id: string } | null;
      if (!message || message.project_id !== candidate.projectId || message.run_id !== candidate.runId) {
        throw new Error(`run-kernel: transcript message '${candidate.transcriptMessageId}' is outside the event run`);
      }
    }
    handle.db.run("INSERT INTO project_sequences(project_id, last_sequence) VALUES (?, 0) ON CONFLICT(project_id) DO NOTHING", [input.projectId]);
    const sequenceRow = handle.db.query("UPDATE project_sequences SET last_sequence = last_sequence + 1 WHERE project_id = ? RETURNING last_sequence")
      .get(input.projectId) as { last_sequence: number };
    const event: RunEvent = { ...candidate, sequence: sequenceRow.last_sequence, recordedAt: new Date().toISOString() };
    const serialized = canonicalJson(event);
    handle.db.run("INSERT INTO run_events(event_id, project_id, run_id, sequence, idempotency_key, event_json) VALUES (?, ?, ?, ?, ?, ?)",
      [event.eventId, event.projectId, event.runId, event.sequence, event.idempotencyKey ?? null, serialized]);
    handle.db.run("INSERT INTO kernel_outbox(event_id, project_id, sequence, payload) VALUES (?, ?, ?, ?)",
      [event.eventId, event.projectId, event.sequence, serialized]);
    applyEventToProjection(handle, event);
    return event;
  })();
}

function applyEventToProjection(handle: KernelHandle, event: RunEvent): void {
  if (event.type === "run.prepared") {
    const payload = event.payload as unknown as Omit<RunProjection, "schemaVersion" | "state" | "version" | "lastSequence" | "updatedAt">;
    const projection: RunProjection = {
      ...payload, schemaVersion: "nirvana.run/v1alpha1", state: "prepared",
      updatedAt: event.occurredAt, version: 1, lastSequence: event.sequence,
    };
    handle.db.run("INSERT INTO run_projections(project_id, run_id, projection_json, version, last_sequence) VALUES (?, ?, ?, ?, ?)",
      [event.projectId, event.runId, canonicalJson(projection), 1, event.sequence]);
    return;
  }
  if (event.type === "run.transitioned") {
    const current = getRun(handle, event.projectId, event.runId);
    if (!current) throw new Error(`run-kernel: run '${event.runId}' not found`);
    const { from, to } = event.payload as { from: CanonicalRunState; to: CanonicalRunState };
    if (current.state !== from) throw new Error(`run-kernel: transition expected ${from}, found ${current.state}`);
    assertTransition(from, to);
    const projection = { ...current, state: to, updatedAt: event.occurredAt, version: current.version + 1, lastSequence: event.sequence };
    handle.db.run("UPDATE run_projections SET projection_json = ?, version = ?, last_sequence = ? WHERE project_id = ? AND run_id = ?",
      [canonicalJson(projection), projection.version, event.sequence, event.projectId, event.runId]);
  }
}

export function createRun(handle: KernelHandle, input: CreateRunInput): RunProjection {
  const prior = input.idempotencyKey
    ? parseEvent(handle.db.query("SELECT event_json FROM run_events WHERE project_id = ? AND idempotency_key = ?")
      .get(input.projectId, input.idempotencyKey) as { event_json: string } | null)
    : null;
  const runId = input.runId ?? prior?.runId ?? `run_${randomUUID()}`;
  const priorCreatedAt = (prior?.payload as { createdAt?: string } | undefined)?.createdAt;
  const createdAt = input.occurredAt ?? priorCreatedAt ?? new Date().toISOString();
  appendEvent(handle, {
    projectId: input.projectId, runId, traceId: input.traceId, type: "run.prepared",
    actor: input.actor, correlationId: input.correlationId, idempotencyKey: input.idempotencyKey,
    occurredAt: createdAt,
    payload: {
      projectId: input.projectId, ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      runId, traceId: input.traceId, ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      planId: input.planId, target: input.target, policySnapshotRef: input.policySnapshotRef, createdAt,
    },
  });
  return getRun(handle, input.projectId, runId)!;
}

export function transitionRun(handle: KernelHandle, input: TransitionInput): RunProjection {
  if (input.idempotencyKey) {
    const prior = handle.db.query("SELECT event_json FROM run_events WHERE project_id = ? AND idempotency_key = ?")
      .get(input.projectId, input.idempotencyKey) as { event_json: string } | null;
    if (prior) {
      const event = JSON.parse(prior.event_json) as RunEvent;
      const requested = { from: (event.payload as { from?: CanonicalRunState }).from, to: input.to, ...(input.payload ?? {}) };
      if (event.runId !== input.runId || event.type !== "run.transitioned" || canonicalJson(event.payload) !== canonicalJson(requested)) {
        throw new Error(`run-kernel: event identity conflict for '${event.eventId}'`);
      }
      return getRun(handle, input.projectId, input.runId)!;
    }
  }
  const current = getRun(handle, input.projectId, input.runId);
  if (!current) throw new Error(`run-kernel: run '${input.runId}' not found in project '${input.projectId}'`);
  assertTransition(current.state, input.to);
  appendEvent(handle, {
    projectId: input.projectId, runId: input.runId, traceId: current.traceId, type: "run.transitioned",
    actor: input.actor, correlationId: input.correlationId, causationId: input.causationId,
    idempotencyKey: input.idempotencyKey, occurredAt: input.occurredAt,
    payload: { from: current.state, to: input.to, ...(input.payload ?? {}) },
  });
  return getRun(handle, input.projectId, input.runId)!;
}

export function getRun(handle: KernelHandle, projectId: string, runId: string): RunProjection | null {
  const row = handle.db.query("SELECT projection_json FROM run_projections WHERE project_id = ? AND run_id = ?")
    .get(projectId, runId) as { projection_json: string } | null;
  return row ? JSON.parse(row.projection_json) as RunProjection : null;
}

export function listEvents(handle: KernelHandle, projectId: string, afterSequence = 0): RunEvent[] {
  return (handle.db.query("SELECT event_json FROM run_events WHERE project_id = ? AND sequence > ? ORDER BY sequence")
    .all(projectId, afterSequence) as { event_json: string }[]).map(row => JSON.parse(row.event_json));
}

export function rebuildProjections(handle: KernelHandle, projectId: string): void {
  handle.db.transaction(() => {
    handle.db.run("DELETE FROM run_projections WHERE project_id = ?", [projectId]);
    for (const event of listEvents(handle, projectId)) applyEventToProjection(handle, event);
  })();
}

export function projectionSnapshot(handle: KernelHandle, projectId: string): string {
  const projections = (handle.db.query("SELECT projection_json FROM run_projections WHERE project_id = ? ORDER BY run_id")
    .all(projectId) as { projection_json: string }[]).map(row => JSON.parse(row.projection_json));
  return canonicalJson(projections);
}

export function appendTranscriptMessage(handle: KernelHandle, message: TranscriptMessage): void {
  handle.db.run("INSERT INTO transcript_messages(message_id, project_id, run_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [message.messageId, message.projectId, message.runId, message.role, message.content, message.createdAt]);
}

export function saveArtifactRef(handle: KernelHandle, ref: ArtifactRef): void {
  const serialized = canonicalJson(ref);
  const existing = handle.db.query("SELECT ref_json FROM artifact_refs WHERE revision_id = ?").get(ref.revisionId) as { ref_json: string } | null;
  if (existing) {
    if (existing.ref_json !== serialized) throw new Error(`run-kernel: artifact revision conflict for '${ref.revisionId}'`);
    return;
  }
  handle.db.run("INSERT INTO artifact_refs(revision_id, project_id, run_id, artifact_id, revision, ref_json) VALUES (?, ?, ?, ?, ?, ?)",
    [ref.revisionId, ref.projectId, ref.runId, ref.artifactId, ref.revision, serialized]);
}

export async function publishOutbox(handle: KernelHandle, publish: (event: RunEvent) => Promise<void> | void, limit = 100): Promise<number> {
  const rows = handle.db.query("SELECT event_id, payload FROM kernel_outbox WHERE published_at IS NULL ORDER BY project_id, sequence LIMIT ?")
    .all(limit) as { event_id: string; payload: string }[];
  let published = 0;
  for (const row of rows) {
    try {
      await publish(JSON.parse(row.payload) as RunEvent);
      handle.db.run("UPDATE kernel_outbox SET published_at = ?, attempts = attempts + 1, last_error = NULL WHERE event_id = ? AND published_at IS NULL",
        [new Date().toISOString(), row.event_id]);
      published += 1;
    } catch (error) {
      handle.db.run("UPDATE kernel_outbox SET attempts = attempts + 1, last_error = ? WHERE event_id = ?",
        [String((error as Error)?.message ?? error), row.event_id]);
      throw error;
    }
  }
  return published;
}

export function pendingOutboxCount(handle: KernelHandle): number {
  return Number((handle.db.query("SELECT COUNT(*) AS count FROM kernel_outbox WHERE published_at IS NULL").get() as { count: number }).count);
}
