// durable-work.ts — typed durable work units as a sibling of the canonical Run Kernel.
//
// Why a sibling, not a second supervisor: Track A (the Run Kernel) is the only
// run-level authority in the engine. This module extends it with typed work
// units that can be partitioned, started, progressed, completed, claimed,
// status-read, collected, resumed, and migrated from Track B — without
// duplicating its substrate, lifecycle, audit, outbox or HANDOFF paths.
//
// The module reuses:
//   - the kernel's `bun:sqlite` connection (WAL, busy_timeout=5000,
//     synchronous=FULL, foreign_keys=ON; immediate transactions);
//   - `canonicalJson` for digest computation and stored payloads;
//   - `appendEvent` to fan out x_durable_work_* events into the canonical
//     run_events journal so run ledger, audit, outbox and HANDOFF carry
//     the unit context automatically;
//   - the ArtifactRef SHA-256 contract for evidence digest verification.
//
// The module never owns the run lifecycle, never replaces the run ledger,
// and never brands the engine surface with a third-party subsystem name.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, statSync, copyFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson } from "./canonical-json.ts";
import { TERMINAL_RUN_STATES } from "./lifecycle.ts";
import { appendEvent, getRun, type KernelHandle } from "./store.ts";
import type { TargetRef } from "./types.ts";

// ── schema version ──────────────────────────────────────────────────────

export const DURABLE_SCHEMA_VERSION = "nirvana.durable-work/v1alpha1" as const;
export const DURABLE_KIND = "durable_work" as const;
export type DurableUnitKind = "audit" | "build" | "research" | "migration" | "generic";
const DURABLE_UNIT_KINDS: ReadonlySet<DurableUnitKind> = new Set(["audit", "build", "research", "migration", "generic"]);
export type DurableUnitStatus = "pending" | "partial" | "completed" | "failed" | "compensating" | "compensated";

const TERMINAL_STATUSES: ReadonlySet<DurableUnitStatus> = new Set(["completed", "compensated"]);

// ── unit declaration ────────────────────────────────────────────────────

export interface DurableUnitDefinition {
  id: string;
  kind: DurableUnitKind;
  scope: string;
  bounds: string;
  /** Optional human label; not used as a key. */
  label?: string;
}

export interface DurableRunContext {
  projectId: string;
  runId: string;
  traceId: string;
  target: TargetRef;
}

export interface DefineUnitsInput extends DurableRunContext {
  units: DurableUnitDefinition[];
  now?: string;
  actor?: { kind: string; id: string };
}

export interface DefinedUnits {
  schemaVersion: typeof DURABLE_SCHEMA_VERSION;
  projectId: string;
  runId: string;
  traceId: string;
  units: DurableUnitDefinition[];
  createdAt: string;
  digest: string;
}

function assertSegment(value: string, label: string): void {
  if (!value || typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) || basename(value) !== value) {
    throw new Error(`${label}_invalid`);
  }
}

function assertEligibleFailedAttempt(attempts: Attempt[], attemptId: string): void {
  const attempt = attempts.find(a => a.id === attemptId);
  if (!attempt) throw new Error("attempt_not_found");
  if (attempt.outcome !== "failed") throw new Error("attempt_not_failed");
  const failedAttempts = attempts.filter(a => a.outcome === "failed");
  const latestFailed = failedAttempts[failedAttempts.length - 1];
  if (!latestFailed || latestFailed.id !== attemptId) throw new Error("attempt_not_eligible");
}

function assertReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("reason_required");
  }
  if (value.length > 4096) {
    throw new Error("reason_too_long");
  }
  return value;
}

function encodeDwcTuple(...segments: string[]): string {
  return segments.map(s => `${s.length}:${s}`).join("/");
}

function nowOr(input: string | undefined, fallback: () => string = () => new Date().toISOString()): string {
  if (input !== undefined) {
    assertIsoTimestamp(input, "now");
    return input;
  }
  return fallback();
}

function isIsoTimestamp(value: string): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(value);
  if (!match) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function assertIsoTimestamp(value: string, label: string): void {
  if (!isIsoTimestamp(value)) throw new Error(`${label}_invalid_timestamp`);
}

function assertUnitKind(kind: unknown): asserts kind is DurableUnitKind {
  if (typeof kind !== "string" || !DURABLE_UNIT_KINDS.has(kind as DurableUnitKind)) {
    throw new Error("unit_kind_invalid");
  }
}

function actorOf(input: { kind?: string; id?: string } | undefined): { kind: string; id: string } {
  return { kind: input?.kind ?? "durable-work", id: input?.id ?? "durable-work" };
}

// ── stored row shape ────────────────────────────────────────────────────

export interface UnitCoverage {
  completed: number;
  total: number;
  label: string;
}

export interface EvidenceRef {
  type: string;
  ref: string;
  digest: string; // sha256:<hex>
}

interface Attempt {
  id: string;
  startedAt: string;
  endedAt: string | null;
  flushes: number;
  outcome: "active" | "interrupted" | "completed" | "failed";
}

interface AppliedOperation {
  id: string;
  payloadDigest: string;
  appliedAt: string;
}

export interface DurableUnitRow {
  schemaVersion: typeof DURABLE_SCHEMA_VERSION;
  projectId: string;
  runId: string;
  traceId: string;
  id: string;
  kind: DurableUnitKind;
  scope: string;
  bounds: string;
  label: string;
  status: DurableUnitStatus;
  coverage: UnitCoverage;
  attempts: Attempt[];
  evidence: EvidenceRef[];
  operations: AppliedOperation[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Previous digest for tamper detection; this row's own digest is computed
   *  from the row body and re-verified on every read. */
  digest: string;
}

export interface Claim {
  projectId: string;
  unitId: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
  digest: string;
}

// ── table initialization (idempotent) ───────────────────────────────────

function ensureTables(handle: KernelHandle): void {
  const db = handle.db;
  db.exec(`CREATE TABLE IF NOT EXISTS durable_definitions (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_slug TEXT NOT NULL,
    target_capability_id TEXT,
    definition_json TEXT NOT NULL,
    definition_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, run_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS durable_units (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    bounds TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    coverage_json TEXT NOT NULL,
    attempts_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    operations_json TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    row_digest TEXT NOT NULL,
    PRIMARY KEY(project_id, run_id, unit_id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_durable_units_status ON durable_units(project_id, run_id, status)`);
  db.exec(`CREATE TABLE IF NOT EXISTS durable_operations (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY(project_id, run_id, unit_id, operation_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS durable_claims (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    row_digest TEXT NOT NULL,
    PRIMARY KEY(project_id, run_id, unit_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS durable_operation_snapshots (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    PRIMARY KEY(project_id, run_id, unit_id, operation_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS durable_migration_operations (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    backup_path TEXT,
    manifest_digest TEXT,
    applied_at TEXT NOT NULL,
    result_json TEXT,
    PRIMARY KEY(project_id, run_id, operation_id, kind)
  )`);
}

function assertImportedOpCollision(current: DurableUnitRow, operationId: string): void {
  if (current.operations.some(op => op.id === operationId)) {
    throw new Error("operation_replay_conflict: imported_operation_snapshot_unavailable");
  }
}

function targetEqual(a: TargetRef, b: TargetRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "squad") {
    const aSquad = a as { kind: "squad"; slug: string; capabilityId?: string };
    const bSquad = b as { kind: "squad"; slug: string; capabilityId?: string };
    if (aSquad.slug !== bSquad.slug) return false;
    const aCap = aSquad.capabilityId ?? null;
    const bCap = bSquad.capabilityId ?? null;
    return aCap === bCap;
  }
  return a.slug === (b as { slug: string }).slug;
}

function assertCanonicalContext(handle: KernelHandle, ctx: DurableRunContext, options: { allowTerminal?: boolean } = {}): void {
  const run = getRun(handle, ctx.projectId, ctx.runId);
  if (!run) throw new Error(`durable_work: canonical run not found for project '${ctx.projectId}' run '${ctx.runId}'`);
  if (run.traceId !== ctx.traceId) throw new Error(`durable_work: canonical trace_id mismatch for run '${ctx.runId}' (expected '${run.traceId}', got '${ctx.traceId}')`);
  if (!targetEqual(run.target, ctx.target)) throw new Error(`durable_work: canonical target mismatch for run '${ctx.runId}'`);
  if (!options.allowTerminal && TERMINAL_RUN_STATES.has(run.state)) {
    throw new Error("canonical_run_terminal");
  }
}

// ── digest helpers ──────────────────────────────────────────────────────

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rowDigest(row: Omit<DurableUnitRow, "digest">): string {
  return "sha256:" + sha256Hex(canonicalJson(row));
}

// The digest must cover a digest-free body. `DurableUnitRow` carries the row's
// own `digest` for tamper detection on read, so spreading a full row (which
// includes `digest`) into a `rowDigest({ ...row, ... })` call hashes the
// previous digest into the next one. `readUnitRow` reconstructs a body WITHOUT
// `digest` and re-hashes it, so a digest computed from a body that STILL
// included the old `digest` never matches the stored value → `state_corrupt`
// on every read-back after the first mutation. This helper returns a body
// with `digest` removed, so the writer and the reader hash the exact same
// bytes regardless of what object they started from.
function bodyOf(row: DurableUnitRow): Omit<DurableUnitRow, "digest"> {
  const { digest: _digest, ...body } = row;
  return body;
}

function claimDigest(claim: Omit<Claim, "digest">): string {
  return "sha256:" + sha256Hex(canonicalJson(claim));
}

function definitionDigest(def: Omit<DefinedUnits, "digest">): string {
  return "sha256:" + sha256Hex(canonicalJson(def));
}

function evidenceKey(item: EvidenceRef): string {
  return `${item.type}\u0001${item.ref}\u0001${item.digest}`;
}

function payloadDigest(payload: Record<string, unknown>): string {
  return "sha256:" + sha256Hex(canonicalJson(payload));
}

// ── evidence verification ───────────────────────────────────────────────

function assertNoSymlinkSegments(root: string, abs: string, error: string): void {
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(error);
  let current = root;
  for (const segment of rel.split(/[\\/]/)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(error);
    } catch (e) {
      if ((e as Error).message === error) throw e;
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error("evidence_file_missing");
      throw e;
    }
  }
}

function validateEvidence(stateRoot: string | undefined, evidence: EvidenceRef[], backupUnitId?: string): void {
  if (!stateRoot) throw new Error("state_root_required_for_evidence");
  const root = resolve(stateRoot);
  for (const item of evidence) {
    if (!item.type || !item.ref || !/^sha256:[a-f0-9]{64}$/.test(item.digest)) throw new Error("evidence_invalid");
    if (isAbsolute(item.ref) || item.ref.includes("\\") || item.ref.split("/").some(s => s === ".." || s === "")) {
      throw new Error("evidence_ref_unsafe");
    }
    const direct = resolve(root, ...item.ref.split("/"));
    const backup = backupUnitId ? resolve(root, "evidence", backupUnitId, ...item.ref.split("/")) : direct;
    const abs = existsSync(direct) ? direct : (backupUnitId && existsSync(backup) ? backup : direct);
    const initialRel = relative(root, abs);
    if (!initialRel || initialRel.startsWith("..") || isAbsolute(initialRel)) throw new Error("evidence_ref_unsafe");
    if (!existsSync(abs)) throw new Error("evidence_file_missing");
    assertNoSymlinkSegments(root, abs, "evidence_ref_symlink_escape");

    let rootReal: string;
    let fileReal: string;
    try {
      rootReal = realpathSync(root);
      fileReal = realpathSync(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error("evidence_file_missing");
      throw e;
    }

    const rel = relative(rootReal, fileReal);
    if (!rel || rel.startsWith("..") || rel.split(/[\\/]/).some(seg => seg === "..") || isAbsolute(rel)) {
      throw new Error("evidence_ref_symlink_escape");
    }

    const st = statSync(fileReal);
    if (!st.isFile()) throw new Error("evidence_not_regular_file");
    const actual = "sha256:" + sha256Hex(readFileSync(fileReal));
    if (actual !== item.digest) throw new Error("evidence_digest_mismatch");
  }
}

function validateRetainedMigrationBackup(
  handle: KernelHandle,
  projectId: string,
  runId: string,
  stateRoot: string,
  unitId: string,
): boolean {
  const root = resolve(stateRoot);
  const rows = handle.db.query(
    `SELECT backup_path, manifest_digest FROM durable_migration_operations
     WHERE project_id = ? AND run_id = ? AND kind = 'import' AND backup_path IS NOT NULL
     ORDER BY applied_at DESC`,
  ).all(projectId, runId) as Array<{ backup_path: string; manifest_digest: string | null }>;
  for (const row of rows) {
    if (resolve(row.backup_path) !== root) continue;
    const manifestPath = join(root, "MANIFEST.json");
    if (!existsSync(manifestPath)) throw new Error("evidence_file_missing");
    let manifest: BackupManifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest; }
    catch { throw new Error("evidence_backup_manifest_invalid"); }
    validateBackupManifest(manifest, { projectId, runId });
    if (row.manifest_digest !== manifest.digest) throw new Error("evidence_backup_manifest_invalid");
    verifyBackupFiles(root, manifest);
    const hasUnitEvidence = manifest.files.some(file => file.path.startsWith(`evidence/${unitId}/`));
    if (!hasUnitEvidence) throw new Error("evidence_file_missing");
    return true;
  }
  return false;
}

// ── read paths ──────────────────────────────────────────────────────────

function readUnitRow(handle: KernelHandle, projectId: string, runId: string, unitId: string): DurableUnitRow {
  const row = handle.db.query(`SELECT * FROM durable_units WHERE project_id = ? AND run_id = ? AND unit_id = ?`)
    .get(projectId, runId, unitId) as Record<string, unknown> | null;
  if (!row) throw new Error(`durable_work: unit '${unitId}' not found in run '${runId}' of project '${projectId}'`);
  const attempts = JSON.parse(String(row.attempts_json)) as Attempt[];
  const evidence = JSON.parse(String(row.evidence_json)) as EvidenceRef[];
  const operations = JSON.parse(String(row.operations_json)) as AppliedOperation[];
  const coverage = JSON.parse(String(row.coverage_json)) as UnitCoverage;
  const body: Omit<DurableUnitRow, "digest"> = {
    schemaVersion: DURABLE_SCHEMA_VERSION,
    projectId: String(row.project_id), runId: String(row.run_id), traceId: String(row.trace_id),
    id: String(row.unit_id), kind: String(row.kind) as DurableUnitKind,
    scope: String(row.scope), bounds: String(row.bounds), label: String(row.label ?? ""),
    status: String(row.status) as DurableUnitStatus, coverage, attempts, evidence, operations,
    revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
  const expected = String(row.row_digest);
  const actual = rowDigest(body);
  if (expected !== actual) throw new Error("durable_work: state_corrupt");
  return { ...body, digest: expected };
}

function readDefinition(handle: KernelHandle, projectId: string, runId: string): DefinedUnits {
  const row = handle.db.query(`SELECT * FROM durable_definitions WHERE project_id = ? AND run_id = ?`)
    .get(projectId, runId) as Record<string, unknown> | null;
  if (!row) throw new Error(`durable_work: definition not found for run '${runId}' in project '${projectId}'`);
  const body = JSON.parse(String(row.definition_json)) as Omit<DefinedUnits, "digest">;
  const expected = String(row.definition_digest);
  if (expected !== definitionDigest(body)) throw new Error("durable_work: definition_corrupt");
  return { ...body, digest: expected };
}

function readClaim(handle: KernelHandle, projectId: string, runId: string, unitId: string): Claim | null {
  const row = handle.db.query(`SELECT * FROM durable_claims WHERE project_id = ? AND run_id = ? AND unit_id = ?`)
    .get(projectId, runId, unitId) as Record<string, unknown> | null;
  if (!row) return null;
  const body: Omit<Claim, "digest"> = {
    projectId: String(row.project_id), unitId: String(row.unit_id), ownerId: String(row.owner_id),
    acquiredAt: String(row.acquired_at), expiresAt: String(row.expires_at),
  };
  if (String(row.row_digest) !== claimDigest(body)) throw new Error("claim_malformed");
  if (!body.ownerId || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(body.ownerId)) throw new Error("claim_malformed");
  if (!isIsoTimestamp(body.acquiredAt) || !isIsoTimestamp(body.expiresAt)) throw new Error("claim_malformed");
  if (Date.parse(body.expiresAt) <= Date.parse(body.acquiredAt)) throw new Error("claim_malformed");
  return { ...body, digest: String(row.row_digest) };
}

// ── write paths (all inside a single immediate transaction) ────────────

function persistUnitRow(handle: KernelHandle, row: DurableUnitRow): void {
  const db = handle.db;
  db.run(`INSERT INTO durable_units(project_id, run_id, trace_id, unit_id, kind, scope, bounds, label,
      status, coverage_json, attempts_json, evidence_json, operations_json, revision, created_at, updated_at, row_digest)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(project_id, run_id, unit_id) DO UPDATE SET
      trace_id = excluded.trace_id, kind = excluded.kind,
      scope = excluded.scope, bounds = excluded.bounds, label = excluded.label,
      status = excluded.status, coverage_json = excluded.coverage_json,
      attempts_json = excluded.attempts_json, evidence_json = excluded.evidence_json,
      operations_json = excluded.operations_json, revision = excluded.revision,
      updated_at = excluded.updated_at, row_digest = excluded.row_digest`,
    [
      row.projectId, row.runId, row.traceId, row.id, row.kind, row.scope, row.bounds, row.label,
      row.status, canonicalJson(row.coverage), canonicalJson(row.attempts),
      canonicalJson(row.evidence), canonicalJson(row.operations),
      row.revision, row.createdAt, row.updatedAt, row.digest,
    ]);
}

function recordOperation(handle: KernelHandle, projectId: string, runId: string, unitId: string, op: AppliedOperation): void {
  handle.db.run(`INSERT OR IGNORE INTO durable_operations(project_id, run_id, unit_id, operation_id, payload_digest, applied_at)
    VALUES (?,?,?,?,?,?)`, [projectId, runId, unitId, op.id, op.payloadDigest, op.appliedAt]);
}

function findPriorOperation(handle: KernelHandle, projectId: string, runId: string, unitId: string, opId: string): AppliedOperation | null {
  const row = handle.db.query(`SELECT * FROM durable_operations WHERE project_id = ? AND run_id = ? AND unit_id = ? AND operation_id = ?`)
    .get(projectId, runId, unitId, opId) as Record<string, unknown> | null;
  if (!row) return null;
  return { id: String(row.operation_id), payloadDigest: String(row.payload_digest), appliedAt: String(row.applied_at) };
}

function captureOperationSnapshot(handle: KernelHandle, projectId: string, runId: string, unitId: string, op: AppliedOperation, row: DurableUnitRow): void {
  handle.db.run(`INSERT OR IGNORE INTO durable_operation_snapshots(project_id, run_id, unit_id, operation_id, payload_digest, snapshot_json, captured_at)
    VALUES (?,?,?,?,?,?,?)`, [projectId, runId, unitId, op.id, op.payloadDigest, canonicalJson(row), op.appliedAt]);
}

function readOperationSnapshot(handle: KernelHandle, projectId: string, runId: string, unitId: string, opId: string, expectedPayloadDigest: string): DurableUnitRow {
  const row = handle.db.query(`SELECT * FROM durable_operation_snapshots WHERE project_id = ? AND run_id = ? AND unit_id = ? AND operation_id = ?`)
    .get(projectId, runId, unitId, opId) as Record<string, unknown> | null;
  if (!row) throw new Error("durable_work: snapshot_missing");
  let snap: DurableUnitRow;
  try { snap = JSON.parse(String(row.snapshot_json)) as DurableUnitRow; }
  catch { throw new Error("durable_work: snapshot_corrupt"); }
  if (snap.digest !== rowDigest(bodyOf(snap))) throw new Error("durable_work: snapshot_corrupt");
  if (snap.projectId !== projectId || snap.runId !== runId || snap.id !== unitId) throw new Error("durable_work: snapshot_corrupt");
  if (String(row.payload_digest) !== expectedPayloadDigest) throw new Error("durable_work: snapshot_corrupt");
  if (!snap.operations.some(op => op.id === opId && op.payloadDigest === expectedPayloadDigest)) throw new Error("durable_work: snapshot_corrupt");
  return snap;
}

function emitRunEvent(handle: KernelHandle, ctx: DurableRunContext, type: string, payload: Record<string, unknown>, correlationId: string, idempotencyKey: string, occurredAt?: string): void {
  appendEvent(handle, {
    projectId: ctx.projectId, runId: ctx.runId, traceId: ctx.traceId, type,
    actor: { kind: "durable-work", id: ctx.runId }, correlationId,
    idempotencyKey: `${idempotencyKey}@${ctx.runId}`,
    payload,
    ...(occurredAt ? { occurredAt } : {}),
  });
}

// ── public API ──────────────────────────────────────────────────────────

export function defineUnits(input: DefineUnitsInput & { handle: KernelHandle }): DefinedUnits {
  ensureTables(input.handle);
  assertSegment(input.runId, "run_id");
  if (!input.traceId) throw new Error("durable_work: trace_id_required");
  const ctx: DurableRunContext = { projectId: input.projectId, runId: input.runId, traceId: input.traceId, target: input.target };
  assertCanonicalContext(input.handle, ctx);
  if (input.units.length === 0) throw new Error("durable_work: units_empty");
  if (input.now !== undefined) assertIsoTimestamp(input.now, "now");
  const ids = new Set<string>();
  const units = input.units.map(unit => {
    assertSegment(unit.id, "unit_id");
    if (ids.has(unit.id)) throw new Error("unit_id_duplicate");
    ids.add(unit.id);
    assertUnitKind(unit.kind);
    if (!unit.scope || !unit.bounds) throw new Error("unit_definition_invalid");
    return { ...unit };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const createdAt = nowOr(input.now);
  const body: Omit<DefinedUnits, "digest"> = {
    schemaVersion: DURABLE_SCHEMA_VERSION, projectId: input.projectId, runId: input.runId, traceId: input.traceId,
    units, createdAt,
  };
  const digest = definitionDigest(body);
  const targetKind = input.target.kind;
  const targetSlug = input.target.slug;
  const targetCapability = input.target.kind === "squad" ? ((input.target as { capabilityId?: string }).capabilityId ?? null) : null;
  // One immediate transaction: definition row + canonical run event + outbox. A trigger
  // failure on `run_events` (e.g. the atomicity test's forced abort) rolls the definition back.
  return input.handle.db.transaction(() => {
    const existing = input.handle.db.query(
      `SELECT definition_digest
       FROM durable_definitions WHERE project_id = ? AND run_id = ?`,
    ).get(input.projectId, input.runId) as { definition_digest: string } | null;
    if (existing) {
      // Semantic replay: the same units declared at a different `now` must return the
      // originally persisted definition (original createdAt/digest), not conflict. Compare
      // the normalized semantic units, ignoring the caller-supplied `createdAt`.
      const stored = readDefinition(input.handle, input.projectId, input.runId);
      const semanticEqual = stored.units.length === units.length
        && stored.units.every((u, i) =>
          u.id === units[i].id && u.kind === units[i].kind
          && u.scope === units[i].scope && u.bounds === units[i].bounds
          && (u.label ?? "") === (units[i].label ?? ""));
      if (semanticEqual) return stored;
      throw new Error(`durable_work: definition conflict for run '${input.runId}' in project '${input.projectId}'`);
    }
    input.handle.db.run(
      `INSERT INTO durable_definitions(project_id, run_id, trace_id, target_kind, target_slug, target_capability_id,
         definition_json, definition_digest, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [input.projectId, input.runId, input.traceId, targetKind, targetSlug, targetCapability,
        canonicalJson(body), digest, createdAt],
    );
    appendEvent(input.handle, {
      projectId: input.projectId, runId: input.runId, traceId: input.traceId,
      type: "x_durable_work_units_defined",
      actor: { kind: "durable-work", id: input.runId },
      correlationId: `cor_dw_def_${encodeDwcTuple(input.runId)}`, idempotencyKey: `dw-def-${encodeDwcTuple(input.runId)}@${input.runId}`,
      occurredAt: createdAt,
      payload: { definition_digest: digest, unit_ids: units.map(u => u.id) },
    });
    return { ...body, digest } as DefinedUnits;
  }).immediate();
}

export interface StartUnitInput extends DurableRunContext {
  handle: KernelHandle;
  unitId: string;
  attemptId: string;
  operationId: string;
  expectedDigest?: string;
  now?: string;
}

export function startUnit(input: StartUnitInput): DurableUnitRow {
  ensureTables(input.handle);
  assertSegment(input.attemptId, "attempt_id");
  assertSegment(input.operationId, "operation_id");
  const ctx: DurableRunContext = { projectId: input.projectId, runId: input.runId, traceId: input.traceId, target: input.target };
  assertCanonicalContext(input.handle, ctx);
  const def = readDefinition(input.handle, input.projectId, input.runId);
  const unitDef = def.units.find(u => u.id === input.unitId);
  if (!unitDef) throw new Error("unit_not_declared");

  const payloadDigestValue = payloadDigest({ kind: "start", unitId: input.unitId, attemptId: input.attemptId });
  const now = nowOr(input.now);
  return input.handle.db.transaction(() => {
    const prior = findPriorOperation(input.handle, input.projectId, input.runId, input.unitId, input.operationId);
    if (prior) {
      if (prior.payloadDigest !== payloadDigestValue) throw new Error("operation_replay_conflict");
      return readOperationSnapshot(input.handle, input.projectId, input.runId, input.unitId, input.operationId, payloadDigestValue);
    }
    const existing = input.handle.db.query(`SELECT 1 AS x FROM durable_units WHERE project_id = ? AND run_id = ? AND unit_id = ?`)
      .get(input.projectId, input.runId, input.unitId) as { x: number } | null;
    if (existing) {
      const current = readUnitRow(input.handle, input.projectId, input.runId, input.unitId);
      assertImportedOpCollision(current, input.operationId);
      if (input.expectedDigest && input.expectedDigest !== current.digest) throw new Error("digest_conflict");
      if (current.status === "completed" || current.status === "compensated") {
        throw new Error("unit_already_terminal");
      }
      if (current.status === "compensating") {
        throw new Error("compensation_in_flight");
      }
      if (current.attempts.some(a => a.id === input.attemptId)) throw new Error("attempt_id_conflict");
      const attempts: Attempt[] = current.attempts.map(a => a.outcome === "active"
        ? { ...a, endedAt: now, outcome: "interrupted" as const }
        : a).concat([{ id: input.attemptId, startedAt: now, endedAt: null, flushes: 0, outcome: "active" }]);
      const operations = current.operations.concat([{ id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now }]);
      const nextStatus: DurableUnitStatus = "partial";
      const next: DurableUnitRow = {
        ...current, status: nextStatus, attempts, operations,
        revision: current.revision + 1, updatedAt: now,
        digest: rowDigest(bodyOf({ ...current, status: nextStatus, attempts, operations, revision: current.revision + 1, updatedAt: now })),
      };
      persistUnitRow(input.handle, next);
      recordOperation(input.handle, input.projectId, input.runId, input.unitId, { id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now });
      captureOperationSnapshot(input.handle, input.projectId, input.runId, input.unitId, { id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now }, next);
      emitRunEvent(input.handle, ctx, "x_durable_work_unit_started", {
        unit_id: input.unitId, attempt_id: input.attemptId,
        operation_id: input.operationId,
        previous_revision: current.revision, next_revision: next.revision,
        previous_digest: current.digest, next_digest: next.digest,
      }, `cor_dw_start_${encodeDwcTuple(input.unitId, input.attemptId)}`, `dw-start-${encodeDwcTuple(input.unitId, input.attemptId)}`, now);
      return next;
    }
    const row: Omit<DurableUnitRow, "digest"> = {
      schemaVersion: DURABLE_SCHEMA_VERSION, projectId: input.projectId, runId: input.runId, traceId: input.traceId,
      id: input.unitId, kind: unitDef.kind, scope: unitDef.scope, bounds: unitDef.bounds, label: unitDef.label ?? "",
      status: "partial", coverage: { completed: 0, total: 0, label: "items" },
      attempts: [{ id: input.attemptId, startedAt: now, endedAt: null, flushes: 0, outcome: "active" }],
      evidence: [], operations: [{ id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now }],
      revision: 1, createdAt: now, updatedAt: now,
    };
    const next: DurableUnitRow = { ...row, digest: rowDigest(row) };
    persistUnitRow(input.handle, next);
    recordOperation(input.handle, input.projectId, input.runId, input.unitId, { id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now });
    captureOperationSnapshot(input.handle, input.projectId, input.runId, input.unitId, { id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now }, next);
    emitRunEvent(input.handle, ctx, "x_durable_work_unit_started", {
      unit_id: input.unitId, attempt_id: input.attemptId,
      operation_id: input.operationId,
      previous_revision: 0, next_revision: 1,
      previous_digest: null, next_digest: next.digest,
    }, `cor_dw_start_${encodeDwcTuple(input.unitId, input.attemptId)}`, `dw-start-${encodeDwcTuple(input.unitId, input.attemptId)}`, now);
    return next;
  }).immediate();
}

export interface ProgressUnitInput extends DurableRunContext {
  handle: KernelHandle;
  unitId: string;
  attemptId: string;
  operationId: string;
  expectedDigest: string;
  coverage: UnitCoverage;
  evidence: EvidenceRef[];
  stateRoot?: string;
  now?: string;
}

export function progressUnit(input: ProgressUnitInput): DurableUnitRow {
  ensureTables(input.handle);
  assertSegment(input.attemptId, "attempt_id");
  assertSegment(input.operationId, "operation_id");
  if (input.evidence.length > 0) validateEvidence(input.stateRoot, input.evidence);
  if (!Number.isFinite(input.coverage.completed) || !Number.isFinite(input.coverage.total)
    || !Number.isInteger(input.coverage.completed) || !Number.isInteger(input.coverage.total)
    || input.coverage.completed < 0 || input.coverage.total < input.coverage.completed || !input.coverage.label) {
    throw new Error("coverage_invalid");
  }
  const ctx: DurableRunContext = { projectId: input.projectId, runId: input.runId, traceId: input.traceId, target: input.target };
  assertCanonicalContext(input.handle, ctx);
  const payloadDigestValue = payloadDigest({
    kind: "progress", unitId: input.unitId, attemptId: input.attemptId,
    coverage: input.coverage, evidence: input.evidence,
  });
  const now = nowOr(input.now);
  return input.handle.db.transaction(() => {
    const prior = findPriorOperation(input.handle, input.projectId, input.runId, input.unitId, input.operationId);
    if (prior) {
      if (prior.payloadDigest !== payloadDigestValue) throw new Error("operation_replay_conflict");
      return readOperationSnapshot(input.handle, input.projectId, input.runId, input.unitId, input.operationId, payloadDigestValue);
    }
    const current = readUnitRow(input.handle, input.projectId, input.runId, input.unitId);
    assertImportedOpCollision(current, input.operationId);
    if (current.digest !== input.expectedDigest) throw new Error("digest_conflict");
    if (current.status !== "partial") throw new Error("unit_not_partial");
    const attemptIndex = current.attempts.findIndex(a => a.id === input.attemptId && a.outcome === "active" && a.endedAt === null);
    if (attemptIndex < 0) throw new Error("attempt_not_active");
    const attempts = current.attempts.map((a, i) => i === attemptIndex ? { ...a, flushes: a.flushes + 1 } : a);
    const seenKeys = new Set(current.evidence.map(evidenceKey));
    const evidence: EvidenceRef[] = [...current.evidence];
    for (const item of input.evidence) {
      const k = evidenceKey(item);
      if (!seenKeys.has(k)) { evidence.push(item); seenKeys.add(k); }
    }
    evidence.sort((a, b) => evidenceKey(a).localeCompare(evidenceKey(b)));
    if (current.coverage.total > 0 && input.coverage.total !== current.coverage.total) throw new Error("coverage_total_changed");
    if (input.coverage.completed < current.coverage.completed) throw new Error("coverage_regressed");
    const operations = current.operations.concat([{ id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now }]);
    const next: DurableUnitRow = {
      ...current, coverage: { ...input.coverage }, attempts, evidence, operations,
      revision: current.revision + 1, updatedAt: now,
      digest: rowDigest(bodyOf({ ...current, coverage: { ...input.coverage }, attempts, evidence, operations,
        revision: current.revision + 1, updatedAt: now })),
    };
    persistUnitRow(input.handle, next);
    recordOperation(input.handle, input.projectId, input.runId, input.unitId, { id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now });
    captureOperationSnapshot(input.handle, input.projectId, input.runId, input.unitId, { id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now }, next);
    emitRunEvent(input.handle, ctx, "x_durable_work_unit_progressed", {
      unit_id: input.unitId, attempt_id: input.attemptId,
      operation_id: input.operationId,
      previous_revision: current.revision, next_revision: next.revision,
      previous_digest: current.digest, next_digest: next.digest,
      coverage: { completed: input.coverage.completed, total: input.coverage.total },
      evidence_count: evidence.length,
    }, `cor_dw_prog_${encodeDwcTuple(input.unitId, input.attemptId, input.operationId)}`, `dw-prog-${encodeDwcTuple(input.unitId, input.attemptId, input.operationId)}`, now);
    return next;
  }).immediate();
}

export interface CompleteUnitInput extends DurableRunContext {
  handle: KernelHandle;
  unitId: string;
  attemptId: string;
  operationId: string;
  expectedDigest: string;
  verificationEvidence: EvidenceRef[];
  stateRoot?: string;
  now?: string;
}

export function completeUnit(input: CompleteUnitInput): DurableUnitRow {
  ensureTables(input.handle);
  assertSegment(input.operationId, "operation_id");
  assertSegment(input.attemptId, "attempt_id");
  if (input.verificationEvidence.length === 0) throw new Error("verification_evidence_required");
  validateEvidence(input.stateRoot, input.verificationEvidence);
  const ctx: DurableRunContext = { projectId: input.projectId, runId: input.runId, traceId: input.traceId, target: input.target };
  assertCanonicalContext(input.handle, ctx);
  const payloadDigestValue = payloadDigest({
    kind: "complete", unitId: input.unitId, attemptId: input.attemptId,
    verificationEvidence: input.verificationEvidence,
  });
  const now = nowOr(input.now);
  return input.handle.db.transaction(() => {
    const prior = findPriorOperation(input.handle, input.projectId, input.runId, input.unitId, input.operationId);
    if (prior) {
      if (prior.payloadDigest !== payloadDigestValue) throw new Error("operation_replay_conflict");
      return readOperationSnapshot(input.handle, input.projectId, input.runId, input.unitId, input.operationId, payloadDigestValue);
    }
    const current = readUnitRow(input.handle, input.projectId, input.runId, input.unitId);
    assertImportedOpCollision(current, input.operationId);
    if (current.digest !== input.expectedDigest) throw new Error("digest_conflict");
    if (current.status !== "partial") throw new Error("unit_not_partial");
    if (current.coverage.total <= 0 || current.coverage.completed !== current.coverage.total) throw new Error("coverage_incomplete");
    const attemptIndex = current.attempts.findIndex(a => a.id === input.attemptId && a.outcome === "active" && a.endedAt === null);
    if (attemptIndex < 0) throw new Error("attempt_not_active");
    const attempts = current.attempts.map((a, i) => i === attemptIndex ? { ...a, endedAt: now, outcome: "completed" as const } : a);
    const seenKeys = new Set(current.evidence.map(evidenceKey));
    const evidence: EvidenceRef[] = [...current.evidence];
    for (const item of input.verificationEvidence) {
      const k = evidenceKey(item);
      if (!seenKeys.has(k)) { evidence.push(item); seenKeys.add(k); }
    }
    evidence.sort((a, b) => evidenceKey(a).localeCompare(evidenceKey(b)));
    const operations = current.operations.concat([{ id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now }]);
    const next: DurableUnitRow = {
      ...current, status: "completed", attempts, evidence, operations,
      revision: current.revision + 1, updatedAt: now,
      digest: rowDigest(bodyOf({ ...current, status: "completed", attempts, evidence, operations,
        revision: current.revision + 1, updatedAt: now })),
    };
    persistUnitRow(input.handle, next);
    recordOperation(input.handle, input.projectId, input.runId, input.unitId, { id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now });
    captureOperationSnapshot(input.handle, input.projectId, input.runId, input.unitId, { id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now }, next);
    emitRunEvent(input.handle, ctx, "x_durable_work_unit_completed", {
      unit_id: input.unitId, attempt_id: input.attemptId,
      operation_id: input.operationId,
      previous_revision: current.revision, next_revision: next.revision,
      previous_digest: current.digest, next_digest: next.digest,
      verification_evidence_count: input.verificationEvidence.length,
    }, `cor_dw_done_${encodeDwcTuple(input.unitId, input.attemptId, input.operationId)}`, `dw-done-${encodeDwcTuple(input.unitId, input.attemptId, input.operationId)}`, now);
    return next;
  }).immediate();
}

export interface FailUnitInput extends DurableRunContext {
  handle: KernelHandle;
  unitId: string;
  attemptId: string;
  operationId: string;
  expectedDigest: string;
  reason: string;
  reasonCode?: string;
  now?: string;
}

export function failUnit(input: FailUnitInput): DurableUnitRow {
  ensureTables(input.handle);
  assertSegment(input.operationId, "operation_id");
  assertSegment(input.attemptId, "attempt_id");
  const reason = assertReason(input.reason);
  const reasonCode = input.reasonCode ?? "unit_failed";
  assertSegment(reasonCode, "reason_code");
  const ctx: DurableRunContext = { projectId: input.projectId, runId: input.runId, traceId: input.traceId, target: input.target };
  assertCanonicalContext(input.handle, ctx);
  const payloadDigestValue = payloadDigest({ kind: "fail", unitId: input.unitId, attemptId: input.attemptId, reasonCode, reason });
  const now = nowOr(input.now);
  return input.handle.db.transaction(() => {
    const prior = findPriorOperation(input.handle, input.projectId, input.runId, input.unitId, input.operationId);
    if (prior) {
      if (prior.payloadDigest !== payloadDigestValue) throw new Error("operation_replay_conflict");
      return readOperationSnapshot(input.handle, input.projectId, input.runId, input.unitId, input.operationId, payloadDigestValue);
    }
    const current = readUnitRow(input.handle, input.projectId, input.runId, input.unitId);
    assertImportedOpCollision(current, input.operationId);
    if (current.digest !== input.expectedDigest) throw new Error("digest_conflict");
    if (TERMINAL_STATUSES.has(current.status)) throw new Error("unit_already_terminal");
    const attemptIndex = current.attempts.findIndex(a => a.id === input.attemptId && a.outcome === "active" && a.endedAt === null);
    if (attemptIndex < 0) throw new Error("attempt_not_active");
    const attempts = current.attempts.map((a, i) => i === attemptIndex ? { ...a, endedAt: now, outcome: "failed" as const } : a);
    const operations = current.operations.concat([{ id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now }]);
    const next: DurableUnitRow = {
      ...current, status: "failed", attempts, operations,
      revision: current.revision + 1, updatedAt: now,
      digest: rowDigest(bodyOf({ ...current, status: "failed", attempts, operations, revision: current.revision + 1, updatedAt: now })),
    };
    persistUnitRow(input.handle, next);
    recordOperation(input.handle, input.projectId, input.runId, input.unitId, { id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now });
    captureOperationSnapshot(input.handle, input.projectId, input.runId, input.unitId, { id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now }, next);
    emitRunEvent(input.handle, ctx, "x_durable_work_unit_failed", {
      unit_id: input.unitId, attempt_id: input.attemptId,
      operation_id: input.operationId,
      previous_revision: current.revision, next_revision: next.revision,
      previous_digest: current.digest, next_digest: next.digest,
      reason_code: reasonCode,
    }, `cor_dw_fail_${encodeDwcTuple(input.unitId, input.attemptId, input.operationId)}`, `dw-fail-${encodeDwcTuple(input.unitId, input.attemptId, input.operationId)}`, now);
    return next;
  }).immediate();
}

export interface CompensateUnitInput extends DurableRunContext {
  handle: KernelHandle;
  unitId: string;
  attemptId: string;
  operationId: string;
  expectedDigest: string;
  /** A failed unit moves to `compensating` here. Call `completeCompensation` with verified
   *  evidence to reach `compensated`. If this call throws (e.g. tampered evidence) the unit
   *  stays `failed` — the operator can retry. */
  now?: string;
}

export function compensateUnit(input: CompensateUnitInput): DurableUnitRow {
  ensureTables(input.handle);
  assertSegment(input.operationId, "operation_id");
  assertSegment(input.attemptId, "attempt_id");
  const ctx: DurableRunContext = { projectId: input.projectId, runId: input.runId, traceId: input.traceId, target: input.target };
  assertCanonicalContext(input.handle, ctx);
  const payloadDigestValue = payloadDigest({ kind: "compensate", unitId: input.unitId, attemptId: input.attemptId });
  const now = nowOr(input.now);
  return input.handle.db.transaction(() => {
    const prior = findPriorOperation(input.handle, input.projectId, input.runId, input.unitId, input.operationId);
    if (prior) {
      if (prior.payloadDigest !== payloadDigestValue) throw new Error("operation_replay_conflict");
      return readOperationSnapshot(input.handle, input.projectId, input.runId, input.unitId, input.operationId, payloadDigestValue);
    }
    const current = readUnitRow(input.handle, input.projectId, input.runId, input.unitId);
    assertImportedOpCollision(current, input.operationId);
    if (current.digest !== input.expectedDigest) throw new Error("digest_conflict");
    if (current.status !== "failed") throw new Error("compensation_requires_failed");
    assertEligibleFailedAttempt(current.attempts, input.attemptId);
    const operations = current.operations.concat([{ id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now }]);
    const next: DurableUnitRow = {
      ...current, status: "compensating", operations,
      revision: current.revision + 1, updatedAt: now,
      digest: rowDigest(bodyOf({ ...current, status: "compensating", operations, revision: current.revision + 1, updatedAt: now })),
    };
    persistUnitRow(input.handle, next);
    recordOperation(input.handle, input.projectId, input.runId, input.unitId, { id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now });
    captureOperationSnapshot(input.handle, input.projectId, input.runId, input.unitId, { id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now }, next);
    emitRunEvent(input.handle, ctx, "x_durable_work_unit_compensating", {
      unit_id: input.unitId, attempt_id: input.attemptId,
      operation_id: input.operationId,
      previous_revision: current.revision, next_revision: next.revision,
      previous_digest: current.digest, next_digest: next.digest,
    }, `cor_dw_comp_${encodeDwcTuple(input.unitId, input.attemptId, input.operationId)}`, `dw-comp-${encodeDwcTuple(input.unitId, input.attemptId, input.operationId)}`, now);
    return next;
  }).immediate();
}

export interface CompleteCompensationInput extends DurableRunContext {
  handle: KernelHandle;
  unitId: string;
  attemptId: string;
  operationId: string;
  expectedDigest: string;
  compensationEvidence: EvidenceRef[];
  stateRoot?: string;
  now?: string;
}

export function completeCompensation(input: CompleteCompensationInput): DurableUnitRow {
  ensureTables(input.handle);
  if (input.compensationEvidence.length === 0) throw new Error("compensation_evidence_required");
  validateEvidence(input.stateRoot, input.compensationEvidence);
  assertSegment(input.operationId, "operation_id");
  assertSegment(input.attemptId, "attempt_id");
  const ctx: DurableRunContext = { projectId: input.projectId, runId: input.runId, traceId: input.traceId, target: input.target };
  assertCanonicalContext(input.handle, ctx);
  const payloadDigestValue = payloadDigest({
    kind: "complete_compensation", unitId: input.unitId, attemptId: input.attemptId, compensationEvidence: input.compensationEvidence,
  });
  const now = nowOr(input.now);
  return input.handle.db.transaction(() => {
    const prior = findPriorOperation(input.handle, input.projectId, input.runId, input.unitId, input.operationId);
    if (prior) {
      if (prior.payloadDigest !== payloadDigestValue) throw new Error("operation_replay_conflict");
      return readOperationSnapshot(input.handle, input.projectId, input.runId, input.unitId, input.operationId, payloadDigestValue);
    }
    const current = readUnitRow(input.handle, input.projectId, input.runId, input.unitId);
    assertImportedOpCollision(current, input.operationId);
    if (current.digest !== input.expectedDigest) throw new Error("digest_conflict");
    if (current.status !== "compensating") throw new Error("compensation_requires_compensating");
    assertEligibleFailedAttempt(current.attempts, input.attemptId);
    const seenKeys = new Set(current.evidence.map(evidenceKey));
    const evidence: EvidenceRef[] = [...current.evidence];
    for (const item of input.compensationEvidence) {
      const k = evidenceKey(item);
      if (!seenKeys.has(k)) { evidence.push(item); seenKeys.add(k); }
    }
    evidence.sort((a, b) => evidenceKey(a).localeCompare(evidenceKey(b)));
    const operations = current.operations.concat([{ id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now }]);
    const next: DurableUnitRow = {
      ...current, status: "compensated", evidence, operations,
      revision: current.revision + 1, updatedAt: now,
      digest: rowDigest(bodyOf({ ...current, status: "compensated", evidence, operations, revision: current.revision + 1, updatedAt: now })),
    };
    persistUnitRow(input.handle, next);
    recordOperation(input.handle, input.projectId, input.runId, input.unitId, { id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now });
    captureOperationSnapshot(input.handle, input.projectId, input.runId, input.unitId, { id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now }, next);
    emitRunEvent(input.handle, ctx, "x_durable_work_unit_compensated", {
      unit_id: input.unitId, attempt_id: input.attemptId,
      operation_id: input.operationId,
      previous_revision: current.revision, next_revision: next.revision,
      previous_digest: current.digest, next_digest: next.digest,
    }, `cor_dw_compd_${encodeDwcTuple(input.unitId, input.attemptId, input.operationId)}`, `dw-compd-${encodeDwcTuple(input.unitId, input.attemptId, input.operationId)}`, now);
    return next;
  }).immediate();
}

export interface FailCompensationInput extends DurableRunContext {
  handle: KernelHandle;
  unitId: string;
  attemptId: string;
  operationId: string;
  expectedDigest: string;
  reason: string;
  reasonCode?: string;
  now?: string;
}

export function failCompensation(input: FailCompensationInput): DurableUnitRow {
  ensureTables(input.handle);
  assertSegment(input.operationId, "operation_id");
  assertSegment(input.attemptId, "attempt_id");
  const reason = assertReason(input.reason);
  const reasonCode = input.reasonCode ?? "compensation_failed";
  assertSegment(reasonCode, "reason_code");
  const ctx: DurableRunContext = { projectId: input.projectId, runId: input.runId, traceId: input.traceId, target: input.target };
  assertCanonicalContext(input.handle, ctx);
  const payloadDigestValue = payloadDigest({ kind: "fail_compensation", unitId: input.unitId, attemptId: input.attemptId, reasonCode, reason });
  const now = nowOr(input.now);
  return input.handle.db.transaction(() => {
    const prior = findPriorOperation(input.handle, input.projectId, input.runId, input.unitId, input.operationId);
    if (prior) {
      if (prior.payloadDigest !== payloadDigestValue) throw new Error("operation_replay_conflict");
      return readOperationSnapshot(input.handle, input.projectId, input.runId, input.unitId, input.operationId, payloadDigestValue);
    }
    const current = readUnitRow(input.handle, input.projectId, input.runId, input.unitId);
    assertImportedOpCollision(current, input.operationId);
    if (current.digest !== input.expectedDigest) throw new Error("digest_conflict");
    if (current.status !== "compensating") throw new Error("fail_compensation_requires_compensating");
    assertEligibleFailedAttempt(current.attempts, input.attemptId);
    const operations = current.operations.concat([{ id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now }]);
    const next: DurableUnitRow = {
      ...current, status: "failed", operations,
      revision: current.revision + 1, updatedAt: now,
      digest: rowDigest(bodyOf({ ...current, status: "failed", operations, revision: current.revision + 1, updatedAt: now })),
    };
    persistUnitRow(input.handle, next);
    recordOperation(input.handle, input.projectId, input.runId, input.unitId, { id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now });
    captureOperationSnapshot(input.handle, input.projectId, input.runId, input.unitId, { id: input.operationId, payloadDigest: payloadDigestValue, appliedAt: now }, next);
    emitRunEvent(input.handle, ctx, "x_durable_work_unit_compensation_failed", {
      unit_id: input.unitId, attempt_id: input.attemptId,
      operation_id: input.operationId,
      previous_revision: current.revision, next_revision: next.revision,
      previous_digest: current.digest, next_digest: next.digest,
      reason_code: reasonCode,
    }, `cor_dw_compf_${encodeDwcTuple(input.unitId, input.attemptId, input.operationId)}`, `dw-compf-${encodeDwcTuple(input.unitId, input.attemptId, input.operationId)}`, now);
    return next;
  }).immediate();
}

export function getUnit(input: DurableRunContext & { handle: KernelHandle; unitId: string; stateRoot?: string }): DurableUnitRow | null {
  ensureTables(input.handle);
  assertCanonicalContext(input.handle, { projectId: input.projectId, runId: input.runId, traceId: input.traceId, target: input.target }, { allowTerminal: true });
  const exists = input.handle.db.query(`SELECT 1 AS x FROM durable_units WHERE project_id = ? AND run_id = ? AND unit_id = ?`)
    .get(input.projectId, input.runId, input.unitId) as { x: number } | null;
  if (!exists) return null;
  const row = readUnitRow(input.handle, input.projectId, input.runId, input.unitId);
  if (input.stateRoot !== undefined && row.evidence.length > 0) {
    const retained = validateRetainedMigrationBackup(input.handle, input.projectId, input.runId, input.stateRoot, input.unitId);
    validateEvidence(input.stateRoot, row.evidence, retained ? input.unitId : undefined);
  }
  return row;
}

export interface StatusInput extends DurableRunContext {
  handle: KernelHandle;
  stateRoot?: string;
}
export interface UnitStatusSummary {
  id: string;
  status: DurableUnitStatus | "pending";
  coverage: UnitCoverage | null;
  digest: string | null;
  revision: number;
}
export interface RunStatus {
  runId: string;
  projectId: string;
  traceId: string;
  units: UnitStatusSummary[];
  definitionDigest: string;
}
export function status(input: StatusInput): RunStatus {
  ensureTables(input.handle);
  assertCanonicalContext(input.handle, { projectId: input.projectId, runId: input.runId, traceId: input.traceId, target: input.target }, { allowTerminal: true });
  const def = readDefinition(input.handle, input.projectId, input.runId);
  const units: UnitStatusSummary[] = [];
  for (const u of def.units) {
    const row = input.handle.db.query(`SELECT row_digest, status, coverage_json, revision FROM durable_units WHERE project_id = ? AND run_id = ? AND unit_id = ?`)
      .get(input.projectId, input.runId, u.id) as Record<string, unknown> | null;
    if (!row) {
      units.push({ id: u.id, status: "pending", coverage: null, digest: null, revision: 0 });
      continue;
    }
    const unit = readUnitRow(input.handle, input.projectId, input.runId, u.id);
    if (input.stateRoot !== undefined && unit.evidence.length > 0) {
      const retained = validateRetainedMigrationBackup(input.handle, input.projectId, input.runId, input.stateRoot, unit.id);
      validateEvidence(input.stateRoot, unit.evidence, retained ? unit.id : undefined);
    }
    units.push({ id: u.id, status: unit.status, coverage: unit.coverage, digest: unit.digest, revision: unit.revision });
  }
  return { runId: input.runId, projectId: input.projectId, traceId: input.traceId, units, definitionDigest: def.digest };
}

export interface ResumePlan {
  partial: DurableUnitDefinition[];
  pending: DurableUnitDefinition[];
  complete: DurableUnitDefinition[];
  failed: DurableUnitDefinition[];
  compensating: DurableUnitDefinition[];
  compensated: DurableUnitDefinition[];
}
export function resume(input: StatusInput): ResumePlan {
  ensureTables(input.handle);
  assertCanonicalContext(input.handle, { projectId: input.projectId, runId: input.runId, traceId: input.traceId, target: input.target }, { allowTerminal: true });
  const def = readDefinition(input.handle, input.projectId, input.runId);
  const stat = status(input);
  const lookup = (status: string): DurableUnitDefinition[] => stat.units
    .filter(u => u.status === status)
    .map(u => def.units.find(d => d.id === u.id)!)
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    partial: lookup("partial"), pending: lookup("pending"), complete: lookup("completed"),
    failed: lookup("failed"), compensating: lookup("compensating"), compensated: lookup("compensated"),
  };
}

export interface CollectedRun {
  schemaVersion: typeof DURABLE_SCHEMA_VERSION;
  runId: string;
  projectId: string;
  traceId: string;
  units: Array<Record<string, unknown>>;
  definitionDigest: string;
  digest: string;
}
export function collect(input: StatusInput): CollectedRun {
  ensureTables(input.handle);
  assertCanonicalContext(input.handle, { projectId: input.projectId, runId: input.runId, traceId: input.traceId, target: input.target }, { allowTerminal: true });
  const def = readDefinition(input.handle, input.projectId, input.runId);
  const stat = status(input);
  const units = stat.units.map(u => {
    if (u.status === "pending") {
      return { id: u.id, status: "pending", coverage: null, attempts: 0, evidence: [], unitDigest: null, revision: 0 };
    }
    const unit = readUnitRow(input.handle, input.projectId, input.runId, u.id);
    if (input.stateRoot !== undefined && unit.evidence.length > 0) {
      const retained = validateRetainedMigrationBackup(input.handle, input.projectId, input.runId, input.stateRoot, unit.id);
      validateEvidence(input.stateRoot, unit.evidence, retained ? unit.id : undefined);
    }
    return {
      id: unit.id, status: unit.status, coverage: unit.coverage, attempts: unit.attempts.length,
      evidence: unit.evidence, unitDigest: unit.digest, revision: unit.revision,
    };
  });
  const body: Omit<CollectedRun, "digest"> = {
    schemaVersion: DURABLE_SCHEMA_VERSION, runId: input.runId, projectId: input.projectId, traceId: input.traceId,
    units, definitionDigest: def.digest,
  };
  const digest = "sha256:" + sha256Hex(canonicalJson(body));
  return { ...body, digest };
}

// ── claims ──────────────────────────────────────────────────────────────

export interface AcquireClaimInput extends DurableRunContext {
  handle: KernelHandle;
  unitId: string;
  ownerId: string;
  ttlMs: number;
  now?: string;
}
export function acquireClaim(input: AcquireClaimInput): Claim {
  ensureTables(input.handle);
  assertCanonicalContext(input.handle, { projectId: input.projectId, runId: input.runId, traceId: input.traceId, target: input.target });
  if (!input.ownerId || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(input.ownerId)) throw new Error("claim_owner_invalid");
  if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0) throw new Error("claim_ttl_invalid");
  const def = readDefinition(input.handle, input.projectId, input.runId);
  if (!def.units.some(u => u.id === input.unitId)) throw new Error("unit_not_declared");
  const now = nowOr(input.now);
  const nowMs = Date.parse(now);
  return input.handle.db.transaction(() => {
    let existing: Claim | null = null;
    try { existing = readClaim(input.handle, input.projectId, input.runId, input.unitId); }
    catch (e) { if ((e as Error).message === "claim_malformed") throw e; existing = null; }
    if (existing) {
      const expiresMs = Date.parse(existing.expiresAt);
      const live = expiresMs > nowMs;
      if (live && existing.ownerId !== input.ownerId) {
        throw new Error(`claim_live: held by '${existing.ownerId}' until ${existing.expiresAt}`);
      }
    }
    const acquiredAt = now;
    const expiresAt = new Date(nowMs + input.ttlMs).toISOString();
    const body: Omit<Claim, "digest"> = {
      projectId: input.projectId, unitId: input.unitId, ownerId: input.ownerId, acquiredAt, expiresAt,
    };
    const digest = claimDigest(body);
    input.handle.db.run(`INSERT INTO durable_claims(project_id, run_id, unit_id, owner_id, acquired_at, expires_at, row_digest)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(project_id, run_id, unit_id) DO UPDATE SET
        owner_id = excluded.owner_id, acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at, row_digest = excluded.row_digest`,
      [input.projectId, input.runId, input.unitId, input.ownerId, acquiredAt, expiresAt, digest]);
    return { ...body, digest };
  }).immediate();
}

export interface ReleaseClaimInput extends DurableRunContext {
  handle: KernelHandle;
  unitId: string;
  ownerId: string;
  now?: string;
}
export function releaseClaim(input: ReleaseClaimInput): void {
  ensureTables(input.handle);
  if (input.now !== undefined) assertIsoTimestamp(input.now, "now");
  assertCanonicalContext(input.handle, { projectId: input.projectId, runId: input.runId, traceId: input.traceId, target: input.target }, { allowTerminal: true });
  input.handle.db.transaction(() => {
    const existing = readClaim(input.handle, input.projectId, input.runId, input.unitId);
    if (!existing) return;
    if (existing.ownerId !== input.ownerId) throw new Error(`claim_wrong_owner: held by '${existing.ownerId}'`);
    input.handle.db.run(`DELETE FROM durable_claims WHERE project_id = ? AND run_id = ? AND unit_id = ?`,
      [input.projectId, input.runId, input.unitId]);
  }).immediate();
}

// ── Track B migration (opt-in, backup-first, dry-run aware) ────────────
//
// The migration adapter imports work-unit state produced by the upstream Holdfast
// track B subsystem into the canonical DWC tables owned by the Run Kernel. It
// does not own a second supervisor, ledger, audit system or migration kernel:
// every durable write goes through the caller-supplied `KernelHandle`, and the
// canonical run identity is verified against the existing run projection before
// any mutation. The migration is one immediate transaction per import or
// rollback, so a partial failure leaves zero DWC rows and zero canonical events
// (the audit log remains append-only; rollback preserves prior import events).
//
// Holdfast attribution — Holdfast by Andre Almeida,
// https://github.com/AndreAlmeidaDC/holdfast, MIT; upstream version 1.1.0
// commit 6e4f09dbad22bca93918aeb6efcbb0c0aaddd494; adaptation version
// 1.1.0-nirvana.1; upstream ZIP digest sha256:
// d7ab1bed6bc8a1d98c1547774e60ba524adca60e76d8dae51848ce100b1605f8.

const HOLDFAST_ATTRIBUTION = Object.freeze({
  component: "holdfast",
  upstreamVersion: "1.1.0",
  upstreamCommit: "6e4f09dbad22bca93918aeb6efcbb0c0aaddd494",
  adaptationVersion: "1.1.0-nirvana.1",
  upstreamUrl: "https://github.com/AndreAlmeidaDC/holdfast",
  author: "Andre Almeida",
  license: "MIT",
  upstreamZipSha256: "d7ab1bed6bc8a1d98c1547774e60ba524adca60e76d8dae51848ce100b1605f8",
});

const TRACK_B_UNIT_STATUSES: ReadonlySet<"partial" | "complete" | "failed"> = new Set(["partial", "complete", "failed"]);
const TRACK_B_ATTEMPT_OUTCOMES: ReadonlySet<"active" | "interrupted" | "completed" | "failed"> = new Set(["active", "interrupted", "completed", "failed"]);

export interface ImportFromTrackBInput {
  /** Required: the caller-supplied canonical kernel handle. The migration never opens a second kernel. */
  handle: KernelHandle;
  projectId: string;
  runId: string;
  traceId: string;
  target: TargetRef;
  trackBRoot: string;
  backupRoot: string;
  /** Optional explicit migration operation identity. When absent, derived deterministically from the Track B state digest. */
  operationId?: string;
  /** When true, only inspect and report; do not mutate the kernel or the backup. Default false. */
  dryRun?: boolean;
  /** Optional explicit deterministic timestamp for the canonical migration events. When absent, the wall clock is captured at call time. */
  now?: string;
}

export interface ImportReport {
  imported: number;
  alreadyImported: number;
  backup: string;
  dryRun: boolean;
  definitionDigest: string;
  operationId: string;
}

interface BackupManifestFile {
  path: string;
  size: number;
  digest: string;
}

interface BackupManifest {
  schemaVersion: "nirvana.durable-work.backup/v1alpha1";
  projectId: string;
  runId: string;
  traceId: string;
  target: TargetRef;
  trackBRoot: string;
  backupRoot: string;
  createdAt: string;
  /** Migration operation identity that produced this backup. */
  operationId: string;
  files: BackupManifestFile[];
  holdfastAttribution: typeof HOLDFAST_ATTRIBUTION;
  digest: string;
}

interface TrackBStateShape {
  schemaVersion: string;
  runId: string;
  traceId: string;
  nirvanaRunId: string;
  objective: string;
  units: { id: string; scope: string; bounds: string }[];
  createdAt: string;
  /** SHA-256 of the canonical JSON of every other STATE field. */
  stateDigest: string;
}

interface TrackBUnitJson {
  schemaVersion: string;
  runId: string;
  id: string;
  scope: string;
  bounds: string;
  status: "partial" | "complete" | "failed";
  coverage: UnitCoverage;
  attempts: Attempt[];
  evidence: EvidenceRef[];
  operations: AppliedOperation[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  digest: string;
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteInteger(value) && value >= 0;
}

function parseTrackBStateRaw(raw: Record<string, unknown>): TrackBStateShape {
  if (raw === null || typeof raw !== "object") throw new Error("track_b_state_shape_invalid: not_object");
  if (raw.schemaVersion !== "2.0.0") throw new Error("track_b_state_shape_invalid: schema_version_mismatch");
  const runId = typeof raw.runId === "string" ? raw.runId : "";
  if (!runId) throw new Error("track_b_state_runId_missing");
  try { assertSegment(runId, "track_b_state_runId"); }
  catch { throw new Error("track_b_state_runId_invalid"); }
  const traceId = typeof raw.traceId === "string" ? raw.traceId : "";
  if (!traceId) throw new Error("track_b_state_traceId_missing");
  const nirvanaRunId = typeof raw.nirvanaRunId === "string" ? raw.nirvanaRunId : "";
  if (!nirvanaRunId) throw new Error("track_b_state_nirvanaRunId_missing");
  try { assertSegment(nirvanaRunId, "track_b_state_nirvanaRunId"); }
  catch { throw new Error("track_b_state_nirvanaRunId_invalid"); }
  const objective = typeof raw.objective === "string" ? raw.objective : "";
  if (!objective) throw new Error("track_b_state_objective_missing");
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : "";
  if (!isIsoTimestamp(createdAt)) throw new Error("track_b_state_createdAt_invalid");
  if (!Array.isArray(raw.units)) throw new Error("track_b_state_shape_invalid: units_not_array");
  const seenIds = new Set<string>();
  const units = (raw.units as Array<Record<string, unknown>>).map((u, index) => {
    if (u === null || typeof u !== "object") throw new Error(`track_b_state_unit_shape_invalid: index ${index}`);
    const id = typeof u.id === "string" ? u.id : "";
    const scope = typeof u.scope === "string" ? u.scope : "";
    const bounds = typeof u.bounds === "string" ? u.bounds : "";
    if (!id || !scope || !bounds) throw new Error(`track_b_state_unit_shape_invalid: index ${index}`);
    try { assertSegment(id, "track_b_state_unit_id"); }
    catch { throw new Error(`track_b_state_unit_shape_invalid: id '${id}'`); }
    if (seenIds.has(id)) throw new Error(`track_b_state_duplicate_unit_identity: '${id}'`);
    seenIds.add(id);
    return { id, scope, bounds };
  });
  const stateDigest = typeof raw.digest === "string" ? raw.digest : "";
  if (!/^sha256:[a-f0-9]{64}$/.test(stateDigest)) throw new Error("track_b_state_digest_invalid");
  return {
    schemaVersion: "2.0.0",
    runId, traceId, nirvanaRunId, objective, units, createdAt, stateDigest,
  };
}

function verifyStateDigest(raw: Record<string, unknown>, shape: TrackBStateShape): void {
  const { digest: storedDigest, ...body } = raw;
  const recomputed = "sha256:" + sha256Hex(canonicalJson(body));
  if (recomputed !== shape.stateDigest || recomputed !== storedDigest) {
    throw new Error("track_b_state_digest_mismatch");
  }
}

function isSafeEvidenceRef(ref: string): boolean {
  if (!ref) return false;
  if (isAbsolute(ref)) return false;
  if (ref.includes("\\")) return false;
  const parts = ref.split("/");
  if (parts.some(s => s === "" || s === "." || s === "..")) return false;
  return true;
}

function verifyEvidenceFile(trackBRoot: string, item: EvidenceRef): void {
  if (!item.type || !item.ref || !/^sha256:[a-f0-9]{64}$/.test(item.digest)) {
    throw new Error("track_b_evidence_invalid");
  }
  if (!isSafeEvidenceRef(item.ref)) throw new Error("track_b_evidence_ref_unsafe");
  const abs = resolve(trackBRoot, ...item.ref.split("/"));
  const initialRel = relative(trackBRoot, abs);
  if (!initialRel || initialRel.startsWith("..") || isAbsolute(initialRel)) throw new Error("track_b_evidence_ref_unsafe");
  if (!existsSync(abs)) throw new Error("track_b_evidence_file_missing");

  // On platforms where lstatSync is available, reject leaf symlinks to avoid escape:
  try {
    const lst = lstatSync(abs);
    if (lst.isSymbolicLink()) throw new Error("track_b_evidence_ref_symlink_escape");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error("track_b_evidence_file_missing");
    throw e;
  }

  let rootReal: string;
  let fileReal: string;
  try {
    rootReal = realpathSync(trackBRoot);
    fileReal = realpathSync(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error("track_b_evidence_file_missing");
    throw e;
  }

  const rel = relative(rootReal, fileReal);
  if (!rel || rel.startsWith("..") || rel.split(/[\\/]/).some(seg => seg === "..") || isAbsolute(rel)) {
    throw new Error("track_b_evidence_ref_symlink_escape");
  }

  const st = statSync(fileReal);
  if (!st.isFile()) throw new Error("track_b_evidence_not_regular_file");

  const actual = "sha256:" + sha256Hex(readFileSync(fileReal));
  if (actual !== item.digest) throw new Error("track_b_evidence_digest_mismatch");
}

function safePathUnder(root: string, segments: string[]): string {
  let abs = resolve(root);
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") throw new Error("track_b_path_segment_unsafe");
    if (seg.includes("\\") || seg.includes("\0")) throw new Error("track_b_path_segment_unsafe");
    abs = resolve(abs, seg);
  }
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("track_b_path_escape");
  return abs;
}

function parseAndValidateTrackBUnit(unitPath: string, expectedId: string): TrackBUnitJson {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(readFileSync(unitPath, "utf8")) as Record<string, unknown>; }
  catch { throw new Error(`track_b_unit_unreadable: '${expectedId}'`); }
  if (raw === null || typeof raw !== "object") throw new Error(`track_b_unit_shape_invalid: '${expectedId}'`);
  if (raw.schemaVersion !== "2.0.0") throw new Error(`track_b_unit_schema_invalid: '${expectedId}'`);
  if (typeof raw.id !== "string" || raw.id !== expectedId) {
    throw new Error(`track_b_unit_id_mismatch: file '${expectedId}' declares id '${String(raw.id)}'`);
  }
  try { assertSegment(raw.id, "track_b_unit_id"); }
  catch { throw new Error(`track_b_unit_id_unsafe: '${expectedId}'`); }
  if (typeof raw.runId !== "string" || !raw.runId) throw new Error(`track_b_unit_run_id_invalid: '${expectedId}'`);
  if (typeof raw.scope !== "string" || !raw.scope) throw new Error(`track_b_unit_scope_invalid: '${expectedId}'`);
  if (typeof raw.bounds !== "string" || !raw.bounds) throw new Error(`track_b_unit_bounds_invalid: '${expectedId}'`);
  if (typeof raw.status !== "string" || !TRACK_B_UNIT_STATUSES.has(raw.status as "partial" | "complete" | "failed")) {
    throw new Error(`track_b_unit_status_invalid: '${expectedId}' status '${String(raw.status)}'`);
  }
  if (raw.status === "complete") {
    const cov = raw.coverage as { completed?: number; total?: number } | undefined;
    if (!cov || !isNonNegativeInteger(cov.completed) || !isNonNegativeInteger(cov.total)
      || cov.total <= 0 || cov.completed !== cov.total) {
      throw new Error(`track_b_unit_complete_invalid: '${expectedId}' coverage incomplete`);
    }
    const ev = raw.evidence as unknown[];
    if (!Array.isArray(ev) || ev.length === 0) {
      throw new Error(`track_b_unit_complete_invalid: '${expectedId}' verification_evidence_required`);
    }
    const atts = Array.isArray(raw.attempts) ? (raw.attempts as Array<Record<string, unknown>>) : [];
    if (atts.length === 0) {
      throw new Error(`track_b_unit_complete_invalid: '${expectedId}' attempts_required`);
    }
    if (atts.some(a => a.outcome === "active" || a.endedAt === null)) {
      throw new Error(`track_b_unit_complete_invalid: '${expectedId}' active_attempt_forbidden`);
    }
    const lastAttempt = atts[atts.length - 1];
    if (lastAttempt.outcome !== "completed") {
      throw new Error(`track_b_unit_complete_invalid: '${expectedId}' last_attempt_not_completed`);
    }
    if (typeof lastAttempt.endedAt !== "string" || !isIsoTimestamp(lastAttempt.endedAt)) {
      throw new Error(`track_b_unit_complete_invalid: '${expectedId}' last_attempt_endedAt_invalid`);
    }
  }
  if (!isNonNegativeInteger(raw.revision) || raw.revision <= 0) {
    throw new Error(`track_b_unit_revision_invalid: '${expectedId}' revision '${String(raw.revision)}'`);
  }
  if (typeof raw.createdAt !== "string" || !isIsoTimestamp(raw.createdAt)) {
    throw new Error(`track_b_unit_timestamp_invalid: '${expectedId}' createdAt '${String(raw.createdAt)}'`);
  }
  if (typeof raw.updatedAt !== "string" || !isIsoTimestamp(raw.updatedAt)) {
    throw new Error(`track_b_unit_timestamp_invalid: '${expectedId}' updatedAt '${String(raw.updatedAt)}'`);
  }
  const coverage = raw.coverage as Record<string, unknown> | undefined;
  if (coverage === undefined || coverage === null || typeof coverage !== "object") {
    throw new Error(`track_b_unit_coverage_invalid: '${expectedId}'`);
  }
  if (!isNonNegativeInteger(coverage.completed) || !isNonNegativeInteger(coverage.total)
    || (coverage.total as number) < (coverage.completed as number)
    || typeof coverage.label !== "string" || !coverage.label) {
    throw new Error(`track_b_unit_coverage_invalid: '${expectedId}'`);
  }
  const attempts = Array.isArray(raw.attempts) ? raw.attempts : null;
  if (attempts === null) throw new Error(`track_b_unit_attempts_invalid: '${expectedId}'`);
  for (const a of attempts) {
    if (a === null || typeof a !== "object") throw new Error(`track_b_unit_attempt_shape_invalid: '${expectedId}'`);
    try { assertSegment(String((a as { id?: unknown }).id ?? ""), "track_b_unit_attempt_id"); }
    catch { throw new Error(`track_b_unit_attempt_id_unsafe: '${expectedId}'`); }
    if (typeof (a as { startedAt?: unknown }).startedAt !== "string"
      || !isIsoTimestamp((a as { startedAt: string }).startedAt)) {
      throw new Error(`track_b_unit_attempt_timestamp_invalid: '${expectedId}'`);
    }
    const endedAt = (a as { endedAt?: unknown }).endedAt;
    if (endedAt !== null && (typeof endedAt !== "string" || !isIsoTimestamp(endedAt))) {
      throw new Error(`track_b_unit_attempt_timestamp_invalid: '${expectedId}'`);
    }
    if (!isNonNegativeInteger((a as { flushes?: unknown }).flushes)) {
      throw new Error(`track_b_unit_attempt_flushes_invalid: '${expectedId}'`);
    }
    if (typeof (a as { outcome?: unknown }).outcome !== "string"
      || !TRACK_B_ATTEMPT_OUTCOMES.has((a as { outcome: string }).outcome as "active" | "interrupted" | "completed" | "failed")) {
      throw new Error(`track_b_unit_attempt_outcome_invalid: '${expectedId}'`);
    }
  }
  const evidence = Array.isArray(raw.evidence) ? raw.evidence : null;
  if (evidence === null) throw new Error(`track_b_unit_evidence_invalid: '${expectedId}'`);
  for (const item of evidence) {
    if (item === null || typeof item !== "object") throw new Error(`track_b_unit_evidence_invalid: '${expectedId}'`);
    const type = (item as { type?: unknown }).type;
    const ref = (item as { ref?: unknown }).ref;
    const digest = (item as { digest?: unknown }).digest;
    if (typeof type !== "string" || !type) throw new Error(`track_b_unit_evidence_invalid: '${expectedId}'`);
    if (typeof ref !== "string" || !ref) throw new Error(`track_b_unit_evidence_invalid: '${expectedId}'`);
    if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`track_b_unit_evidence_digest_invalid: '${expectedId}'`);
    }
  }
  const operations = Array.isArray(raw.operations) ? raw.operations : null;
  if (operations === null) throw new Error(`track_b_unit_operations_invalid: '${expectedId}'`);
  const opIds = new Set<string>();
  for (const op of operations) {
    if (op === null || typeof op !== "object") throw new Error(`track_b_unit_operation_shape_invalid: '${expectedId}'`);
    const opId = String((op as { id?: unknown }).id ?? "");
    if (!opId) throw new Error(`track_b_unit_operation_id_invalid: '${expectedId}'`);
    if (opIds.has(opId)) throw new Error(`track_b_unit_operation_duplicate_identity: '${expectedId}' op '${opId}'`);
    opIds.add(opId);
    const payloadDigest = (op as { payloadDigest?: unknown }).payloadDigest;
    if (typeof payloadDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(payloadDigest)) {
      throw new Error(`track_b_unit_operation_payload_digest_invalid: '${expectedId}'`);
    }
    if (typeof (op as { appliedAt?: unknown }).appliedAt !== "string"
      || !isIsoTimestamp((op as { appliedAt: string }).appliedAt)) {
      throw new Error(`track_b_unit_operation_timestamp_invalid: '${expectedId}'`);
    }
  }
  if (typeof raw.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(raw.digest)) {
    throw new Error(`track_b_unit_digest_invalid: '${expectedId}'`);
  }
  // Verify the stored digest matches the body — a tampered unit must fail closed.
  const { digest: storedDigest, ...unitBody } = raw;
  const recomputedDigest = "sha256:" + sha256Hex(canonicalJson(unitBody));
  if (recomputedDigest !== storedDigest) {
    throw new Error(`track_b_unit_digest_mismatch: '${expectedId}'`);
  }
  return raw as unknown as TrackBUnitJson;
}

function backupManifestDigest(body: Omit<BackupManifest, "digest">): string {
  return "sha256:" + sha256Hex(canonicalJson(body));
}

function writeBackupFileAtomic(targetPath: string, bytes: Buffer | string): void {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  if (typeof bytes === "string") writeFileSync(tmpPath, bytes, "utf8");
  else writeFileSync(tmpPath, bytes);
  try {
    renameSync(tmpPath, targetPath);
  } catch (error) {
    try { unlinkIfExists(tmpPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

function unlinkIfExists(path: string): void {
  try { unlinkSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
}

function buildBackupManifest(args: {
  backupDir: string;
  trackBRoot: string;
  projectId: string;
  runId: string;
  traceId: string;
  target: TargetRef;
  now: string;
  operationId: string;
  stateBytes: Buffer;
  unitBytes: Array<{ id: string; bytes: Buffer }>;
  evidenceBytes: Array<{ unitId: string; ref: string; bytes: Buffer }>;
}): BackupManifest {
  const { backupDir, trackBRoot, projectId, runId, traceId, target, now, operationId,
    stateBytes, unitBytes, evidenceBytes } = args;
  const files: BackupManifestFile[] = [];
  files.push({ path: "STATE.json", size: stateBytes.length, digest: "sha256:" + sha256Hex(stateBytes) });
  for (const u of unitBytes) {
    files.push({ path: `units/${u.id}.json`, size: u.bytes.length, digest: "sha256:" + sha256Hex(u.bytes) });
  }
  for (const e of evidenceBytes) {
    const path = `evidence/${e.unitId}/${e.ref}`;
    files.push({ path, size: e.bytes.length, digest: "sha256:" + sha256Hex(e.bytes) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const body: Omit<BackupManifest, "digest"> = {
    schemaVersion: "nirvana.durable-work.backup/v1alpha1",
    projectId, runId, traceId, target,
    trackBRoot, backupRoot: backupDir, createdAt: now,
    operationId,
    files, holdfastAttribution: HOLDFAST_ATTRIBUTION,
  };
  return { ...body, digest: backupManifestDigest(body) };
}

function validateBackupManifest(manifest: BackupManifest, expected: { projectId: string; runId: string; traceId?: string; target?: TargetRef }): void {
  if (!manifest || typeof manifest !== "object") throw new Error("rollback_backup_manifest_malformed");
  if (manifest.schemaVersion !== "nirvana.durable-work.backup/v1alpha1") throw new Error("rollback_backup_manifest_schema_invalid");
  if (typeof manifest.projectId !== "string" || manifest.projectId !== expected.projectId) {
    throw new Error("rollback_backup_provenance_mismatch: projectId");
  }
  if (typeof manifest.runId !== "string" || manifest.runId !== expected.runId) {
    throw new Error("rollback_backup_provenance_mismatch: runId");
  }
  if (expected.traceId !== undefined && manifest.traceId !== expected.traceId) {
    throw new Error("rollback_backup_provenance_mismatch: traceId");
  }
  if (expected.target !== undefined && !targetEqual(manifest.target, expected.target)) {
    throw new Error("rollback_backup_provenance_mismatch: target");
  }
  if (!Array.isArray(manifest.files)) throw new Error("rollback_backup_manifest_files_invalid");
  const { digest: _digest, ...rest } = manifest;
  const expectedDigest = backupManifestDigest(rest);
  if (manifest.digest !== expectedDigest) throw new Error("rollback_backup_manifest_digest_mismatch");
  if (!Array.isArray(rest.files)) throw new Error("rollback_backup_manifest_files_invalid");
  if (typeof manifest.operationId !== "string" || !manifest.operationId) {
    throw new Error("rollback_backup_manifest_operation_id_invalid");
  }
}

function verifyBackupFiles(backupDir: string, manifest: BackupManifest): void {
  for (const file of manifest.files) {
    if (typeof file.path !== "string" || !file.path) throw new Error("rollback_backup_file_path_invalid");
    if (isAbsolute(file.path) || file.path.includes("\\") || file.path.split("/").some(s => s === ".." || s === "")) {
      throw new Error("rollback_backup_file_path_unsafe");
    }
    const filePath = join(backupDir, ...file.path.split("/"));
    const rel = relative(backupDir, filePath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("rollback_backup_file_path_unsafe");
    if (!existsSync(filePath)) throw new Error(`rollback_backup_file_missing: '${file.path}'`);
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error(`rollback_backup_file_not_regular: '${file.path}'`);
    if (stat.size !== file.size) throw new Error(`rollback_backup_file_size_mismatch: '${file.path}'`);
    const actualDigest = "sha256:" + sha256Hex(readFileSync(filePath));
    if (actualDigest !== file.digest) throw new Error(`rollback_backup_file_digest_mismatch: '${file.path}'`);
  }
}

function deriveStageName(operationId: string, payloadDigest: string): string {
  return `stage-${sha256Hex(encodeDwcTuple(operationId, payloadDigest)).slice(0, 16)}`;
}

function validateReusableStage(
  backupDir: string,
  manifest: BackupManifest,
  expectedStamp: string,
): void {
  const stamp = basename(backupDir);
  if (stamp !== expectedStamp) {
    throw new Error("track_b_backup_stage_name_mismatch");
  }
  const manifestPath = join(backupDir, "MANIFEST.json");
  if (!existsSync(manifestPath)) throw new Error("track_b_backup_stage_incomplete");
  let onDisk: BackupManifest;
  try { onDisk = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest; }
  catch { throw new Error("track_b_backup_manifest_invalid"); }
  validateBackupManifest(onDisk, { projectId: manifest.projectId, runId: manifest.runId, traceId: manifest.traceId, target: manifest.target });
  if (onDisk.operationId !== manifest.operationId || resolve(onDisk.backupRoot) !== resolve(manifest.backupRoot) || resolve(onDisk.trackBRoot) !== resolve(manifest.trackBRoot)) {
    throw new Error("track_b_backup_manifest_drift");
  }
  if (onDisk.files.length !== manifest.files.length) throw new Error("track_b_backup_manifest_drift");
  for (let i = 0; i < onDisk.files.length; i++) {
    const f1 = onDisk.files[i];
    const f2 = manifest.files[i];
    if (f1.path !== f2.path || f1.digest !== f2.digest || f1.size !== f2.size) {
      throw new Error("track_b_backup_manifest_drift");
    }
  }
  verifyBackupFiles(backupDir, onDisk);
}

function readTrackBUnits(trackBRoot: string, tbState: TrackBStateShape): Map<string, TrackBUnitJson> {
  const unitsDir = join(trackBRoot, "units");
  const result = new Map<string, TrackBUnitJson>();
  const declared = new Set(tbState.units.map(u => u.id));
  if (existsSync(unitsDir)) {
    const seenFiles = new Set<string>();
    for (const entry of readdirSync(unitsDir)) {
      if (!entry.endsWith(".json")) continue;
      const expectedId = entry.replace(/\.json$/, "");
      seenFiles.add(expectedId);
      if (!declared.has(expectedId)) {
        throw new Error(`track_b_unit_unexpected_file: '${entry}'`);
      }
    }
  }
  for (const u of tbState.units) {
    const tbUnitPath = join(unitsDir, `${u.id}.json`);
    if (!existsSync(tbUnitPath)) throw new Error(`track_b_unit_missing: '${u.id}'`);
    const unit = parseAndValidateTrackBUnit(tbUnitPath, u.id);
    result.set(u.id, unit);
  }
  return result;
}

function deriveImportOperationId(handle: KernelHandle, projectId: string, runId: string, stateDigest: string): string {
  const base = `mig_import_${stateDigest.slice("sha256:".length, "sha256:".length + 16)}`;
  const row = handle.db.query(
    `SELECT COUNT(*) AS count FROM durable_migration_operations WHERE project_id = ? AND run_id = ? AND kind = 'rollback'`,
  ).get(projectId, runId) as { count: number } | null;
  const count = row?.count ?? 0;
  return count > 0 ? `${base}_rb${count}` : base;
}

function verifyImportMaterialization(
  handle: KernelHandle,
  projectId: string,
  runId: string,
  expectedTraceId: string,
  expectedTarget: TargetRef,
  expectedDefDigest: string,
  unitMap: Map<string, TrackBUnitJson>,
): void {
  const drift = () => new Error("operation_replay_state_drift: track_b_import");

  const defRow = handle.db.query(
    `SELECT trace_id, target_kind, target_slug, target_capability_id, definition_json, definition_digest
     FROM durable_definitions WHERE project_id = ? AND run_id = ?`,
  ).get(projectId, runId) as {
    trace_id: string; target_kind: string; target_slug: string;
    target_capability_id: string | null; definition_json: string; definition_digest: string;
  } | null;
  if (!defRow) throw drift();
  if (defRow.trace_id !== expectedTraceId) throw drift();
  if (defRow.target_kind !== expectedTarget.kind || defRow.target_slug !== expectedTarget.slug) throw drift();
  if (expectedTarget.kind === "squad") {
    const expectedCap = (expectedTarget as { capabilityId?: string }).capabilityId ?? null;
    if ((defRow.target_capability_id ?? null) !== expectedCap) throw drift();
  } else if (defRow.target_capability_id !== null) {
    throw drift();
  }

  let parsedDef: Omit<DefinedUnits, "digest">;
  try { parsedDef = JSON.parse(defRow.definition_json) as Omit<DefinedUnits, "digest">; }
  catch { throw drift(); }
  if (!parsedDef || typeof parsedDef !== "object" || !Array.isArray(parsedDef.units)) throw drift();
  const recomputedDefDigest = definitionDigest(parsedDef);
  if (defRow.definition_digest !== recomputedDefDigest || recomputedDefDigest !== expectedDefDigest) throw drift();
  if (parsedDef.schemaVersion !== DURABLE_SCHEMA_VERSION) throw drift();
  if (parsedDef.projectId !== projectId || parsedDef.runId !== runId || parsedDef.traceId !== expectedTraceId) throw drift();
  const defUnitsById = new Map(parsedDef.units.map(u => [u.id, u]));
  for (const [id, tb] of unitMap.entries()) {
    const du = defUnitsById.get(id);
    if (!du) throw drift();
    if (du.kind !== "migration" || du.scope !== tb.scope || du.bounds !== tb.bounds) throw drift();
  }
  if (parsedDef.units.length !== unitMap.size) throw drift();

  const unitRows = handle.db.query(
    `SELECT unit_id, row_digest FROM durable_units WHERE project_id = ? AND run_id = ?`,
  ).all(projectId, runId) as Array<{ unit_id: string; row_digest: string }>;

  if (unitRows.length !== unitMap.size) {
    throw drift();
  }

  const rowMap = new Map(unitRows.map(r => [r.unit_id, r.row_digest]));
  for (const [id, tb] of unitMap.entries()) {
    const actualDigest = rowMap.get(id);
    if (!actualDigest) throw drift();

    const status: DurableUnitStatus = tb.status === "complete" ? "completed" : tb.status === "failed" ? "failed" : "partial";
    const expectedBody: Omit<DurableUnitRow, "digest"> = {
      schemaVersion: DURABLE_SCHEMA_VERSION,
      projectId,
      runId,
      traceId: defRow.trace_id,
      id: tb.id,
      kind: "migration",
      scope: tb.scope,
      bounds: tb.bounds,
      label: tb.id,
      status,
      coverage: tb.coverage,
      attempts: tb.attempts,
      evidence: tb.evidence,
      operations: tb.operations,
      revision: tb.revision,
      createdAt: tb.createdAt,
      updatedAt: tb.updatedAt,
    };
    const expectedDigest = rowDigest(expectedBody);
    if (actualDigest !== expectedDigest) {
      throw drift();
    }
  }
}

function verifyRollbackStatePreconditions(
  handle: KernelHandle,
  projectId: string,
  runId: string,
  backupDir: string,
  manifest: BackupManifest,
): void {
  const drift = () => new Error("rollback_state_drift");

  // Pin the verified directory: the manifest's recorded backup root must be exactly
  // the caller-resolved directory being rolled back from.
  if (resolve(manifest.backupRoot) !== resolve(backupDir)) throw drift();

  // The STATE.json must live in this backup and agree with the manifest provenance.
  const statePath = join(backupDir, "STATE.json");
  if (!existsSync(statePath)) throw new Error("rollback_backup_file_missing");
  let rawState: Record<string, unknown>;
  try { rawState = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>; }
  catch { throw drift(); }
  let tbState: TrackBStateShape;
  try {
    tbState = parseTrackBStateRaw(rawState);
    verifyStateDigest(rawState, tbState);
  } catch { throw drift(); }
  if (tbState.runId !== manifest.runId || tbState.traceId !== manifest.traceId) throw drift();

  // Reconstruct the exact definition the import flow must have persisted.
  const unitsFile = manifest.files.filter(f => f.path.startsWith("units/") && f.path.endsWith(".json"));
  const expectedUnitIds = unitsFile.map(f => f.path.replace(/^units\//, "").replace(/\.json$/, ""));
  if (tbState.units.length !== expectedUnitIds.length
    || !tbState.units.every(u => expectedUnitIds.includes(u.id))) {
    throw drift();
  }
  const units: DurableUnitDefinition[] = tbState.units.map(u => ({
    id: u.id, kind: "migration" as const, scope: u.scope, bounds: u.bounds,
  }));
  const expectedDefBody: Omit<DefinedUnits, "digest"> = {
    schemaVersion: DURABLE_SCHEMA_VERSION, projectId, runId, traceId: manifest.traceId,
    units, createdAt: manifest.createdAt,
  };
  const expectedDefDigest = definitionDigest(expectedDefBody);

  const defRow = handle.db.query(
    `SELECT trace_id, target_kind, target_slug, target_capability_id, definition_json, definition_digest
     FROM durable_definitions WHERE project_id = ? AND run_id = ?`,
  ).get(projectId, runId) as {
    trace_id: string; target_kind: string; target_slug: string;
    target_capability_id: string | null; definition_json: string; definition_digest: string;
  } | null;
  if (!defRow) throw drift();
  if (defRow.trace_id !== manifest.traceId) throw drift();
  if (defRow.target_kind !== manifest.target.kind || defRow.target_slug !== manifest.target.slug) throw drift();
  if (manifest.target.kind === "squad") {
    const cap = (manifest.target as { capabilityId?: string }).capabilityId ?? null;
    if ((defRow.target_capability_id ?? null) !== cap) throw drift();
  } else if (defRow.target_capability_id !== null) {
    throw drift();
  }

  let parsedDef: Omit<DefinedUnits, "digest">;
  try { parsedDef = JSON.parse(defRow.definition_json) as Omit<DefinedUnits, "digest">; }
  catch { throw drift(); }
  if (!parsedDef || typeof parsedDef !== "object") throw drift();
  const recomputedDefDigest = definitionDigest(parsedDef);
  if (defRow.definition_digest !== recomputedDefDigest || recomputedDefDigest !== expectedDefDigest) throw drift();

  // Post-import state in any auxiliary table means the run drifted past the snapshot.
  for (const table of ["durable_claims", "durable_operations", "durable_operation_snapshots"]) {
    const row = handle.db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ? AND run_id = ?`)
      .get(projectId, runId) as { n: number };
    if (row.n > 0) throw drift();
  }

  const unitRows = handle.db.query(
    `SELECT unit_id, row_digest FROM durable_units WHERE project_id = ? AND run_id = ?`,
  ).all(projectId, runId) as Array<{ unit_id: string; row_digest: string }>;

  for (const uId of expectedUnitIds) {
    const row = unitRows.find(r => r.unit_id === uId);
    if (!row) {
      throw drift();
    }
    const unitJsonPath = join(backupDir, "units", `${uId}.json`);
    if (!existsSync(unitJsonPath)) throw new Error("rollback_backup_file_missing");
    let tb: TrackBUnitJson;
    try { tb = parseAndValidateTrackBUnit(unitJsonPath, uId); }
    catch { throw drift(); }
    const status: DurableUnitStatus = tb.status === "complete" ? "completed" : tb.status === "failed" ? "failed" : "partial";
    const expectedBody: Omit<DurableUnitRow, "digest"> = {
      schemaVersion: DURABLE_SCHEMA_VERSION,
      projectId,
      runId,
      traceId: manifest.traceId,
      id: tb.id,
      kind: "migration",
      scope: tb.scope,
      bounds: tb.bounds,
      label: tb.id,
      status,
      coverage: tb.coverage,
      attempts: tb.attempts,
      evidence: tb.evidence,
      operations: tb.operations,
      revision: tb.revision,
      createdAt: tb.createdAt,
      updatedAt: tb.updatedAt,
    };
    const expectedDigest = rowDigest(expectedBody);
    if (row.row_digest !== expectedDigest) {
      throw drift();
    }
  }

  if (unitRows.length !== expectedUnitIds.length) {
    throw drift();
  }
}

function deriveRollbackOperationId(manifestDigest: string): string {
  return `mig_rollback_${manifestDigest.slice("sha256:".length, "sha256:".length + 16)}`;
}

function lookupMigrationOperation(handle: KernelHandle, projectId: string, runId: string, operationId: string, kind: "import" | "rollback"): { payload_digest: string; result_json: string | null } | null {
  return handle.db.query(
    `SELECT payload_digest, result_json FROM durable_migration_operations WHERE project_id = ? AND run_id = ? AND operation_id = ? AND kind = ?`,
  ).get(projectId, runId, operationId, kind) as { payload_digest: string; result_json: string | null } | null;
}

function parseCachedImportReport(resultJson: string): ImportReport {
  try {
    const raw = JSON.parse(resultJson) as Record<string, unknown>;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)
      || !isNonNegativeInteger(raw.imported)
      || !isNonNegativeInteger(raw.alreadyImported)
      || typeof raw.backup !== "string" || !raw.backup
      || typeof raw.dryRun !== "boolean"
      || typeof raw.definitionDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(raw.definitionDigest)
      || typeof raw.operationId !== "string" || !raw.operationId) {
      throw new Error("invalid_import_report");
    }
    return raw as unknown as ImportReport;
  } catch {
    throw new Error("operation_replay_result_corrupt: track_b_import");
  }
}

function removeCreatedBackupStage(backupRoot: string, backupDir: string): void {
  const rootPath = resolve(backupRoot);
  const stagePath = resolve(backupDir);
  if (dirname(stagePath) !== rootPath) return;
  try {
    const stage = lstatSync(stagePath);
    if (!stage.isDirectory() || stage.isSymbolicLink()) return;
    rmSync(stagePath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function copyBackupFileAtomic(srcPath: string, destPath: string): void {
  const tmpPath = `${destPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    copyFileSync(srcPath, tmpPath);
    renameSync(tmpPath, destPath);
  } catch (e) {
    try { unlinkIfExists(tmpPath); } catch { /* best-effort cleanup */ }
    throw e;
  }
}

function copyEvidenceToBackup(trackBRoot: string, backupDir: string, unitId: string, ref: string): BackupManifestFile {
  const srcAbs = resolve(trackBRoot, ...ref.split("/"));
  const backupRel = `evidence/${unitId}/${ref}`;
  const backupAbs = safePathUnder(backupDir, backupRel.split("/"));
  mkdirSync(dirname(backupAbs), { recursive: true });
  copyBackupFileAtomic(srcAbs, backupAbs);
  const bytes = readFileSync(backupAbs);
  return { path: backupRel, size: bytes.length, digest: "sha256:" + sha256Hex(bytes) };
}

export function importFromTrackB(input: ImportFromTrackBInput): ImportReport {
  if (!input.handle) throw new Error("durable_work: handle_required");
  if (input.now !== undefined) assertIsoTimestamp(input.now, "now");

  const handle = input.handle;
  ensureTables(handle);

  // Canonical-run guard — required by the Run Kernel contract before any mutation or cached replay.
  assertCanonicalContext(handle, {
    projectId: input.projectId, runId: input.runId, traceId: input.traceId, target: input.target,
  }, { allowTerminal: true });

  // Replay pre-check: if this operationId was already recorded, validate retained backup & materialization
  if (input.operationId) {
    const priorOp = lookupMigrationOperation(handle, input.projectId, input.runId, input.operationId, "import");
    if (priorOp && priorOp.result_json) {
      const cachedReport = parseCachedImportReport(priorOp.result_json);
      // Validate the retained backup referenced by cached report
      const backupDir = resolve(cachedReport.backup);
      const manifestPath = join(backupDir, "MANIFEST.json");
      if (!existsSync(manifestPath)) throw new Error("evidence_backup_manifest_invalid");
      let manifest: BackupManifest;
      try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest; }
      catch { throw new Error("evidence_backup_manifest_invalid"); }
      validateBackupManifest(manifest, { projectId: input.projectId, runId: input.runId, traceId: input.traceId, target: input.target });
      verifyBackupFiles(backupDir, manifest);

      // Reconstruct units from backup to verify materialization
      const backupStatePath = join(backupDir, "STATE.json");
      if (!existsSync(backupStatePath)) throw new Error("track_b_state_missing");
      const rawStateRaw = readFileSync(backupStatePath);
      let rawState: Record<string, unknown>;
      try { rawState = JSON.parse(rawStateRaw.toString("utf8")) as Record<string, unknown>; }
      catch { throw new Error("track_b_state_malformed"); }
      const tbState = parseTrackBStateRaw(rawState);
      verifyStateDigest(rawState, tbState);
      const unitMap = readTrackBUnits(backupDir, tbState);

      const payloadBody = {
        kind: "import",
        trackBRoot: resolve(input.trackBRoot),
        projectId: input.projectId,
        runId: input.runId,
        traceId: input.traceId,
        target: input.target,
        stateDigest: tbState.stateDigest,
        unitDigests: [...unitMap.values()].map(u => u.digest).sort(),
      };
      const payloadDigest = "sha256:" + sha256Hex(canonicalJson(payloadBody));
      if (priorOp.payload_digest !== payloadDigest) throw new Error("operation_replay_conflict: track_b_import");

      verifyImportMaterialization(handle, input.projectId, input.runId, input.traceId, input.target, cachedReport.definitionDigest, unitMap);
      return { ...cachedReport, alreadyImported: 1, dryRun: false };
    }
  }

  const trackBRoot = resolve(input.trackBRoot);
  const backupRoot = resolve(input.backupRoot);
  const statePath = join(trackBRoot, "STATE.json");
  if (!existsSync(statePath)) throw new Error("track_b_state_missing");

  // Strict STATE validation, including STATE-vs-canonical provenance.
  const rawStateRaw = readFileSync(statePath);
  let rawState: Record<string, unknown>;
  try { rawState = JSON.parse(rawStateRaw.toString("utf8")) as Record<string, unknown>; }
  catch { throw new Error("track_b_state_malformed"); }
  const tbState = parseTrackBStateRaw(rawState);
  verifyStateDigest(rawState, tbState);

  if (tbState.runId !== input.runId) throw new Error("track_b_state_runId_mismatch");
  if (tbState.traceId !== input.traceId) throw new Error("track_b_state_traceId_mismatch");
  if (tbState.nirvanaRunId !== input.runId) throw new Error("track_b_state_nirvanaRunId_mismatch");

  // Validate every unit, including STATE-vs-unit runId/scope/bounds agreement.
  const unitMap = readTrackBUnits(trackBRoot, tbState);
  if (unitMap.size === 0) throw new Error("track_b_state_units_empty");
  for (const u of tbState.units) {
    const tb = unitMap.get(u.id);
    if (!tb) throw new Error(`track_b_unit_missing: '${u.id}'`);
    if (tb.runId !== tbState.runId) throw new Error(`track_b_unit_runId_mismatch: '${u.id}'`);
    if (tb.scope !== u.scope) throw new Error(`track_b_unit_scope_mismatch: '${u.id}'`);
    if (tb.bounds !== u.bounds) throw new Error(`track_b_unit_bounds_mismatch: '${u.id}'`);
  }

  // Verify every evidence reference against actual bytes (fail closed before backup/DB writes).
  for (const [unitId, tb] of unitMap.entries()) {
    for (const item of tb.evidence) {
      verifyEvidenceFile(trackBRoot, item);
    }
  }

  const operationId = input.operationId ?? deriveImportOperationId(handle, input.projectId, input.runId, tbState.stateDigest);
  const now = input.now ?? new Date().toISOString();

  // Compute the migration payload digest; the unit digest list makes a replay of an
  // identical source snapshot produce the same digest, while a tampered or different
  // source produces a different one (rejected as operation_replay_conflict). The
  // payload deliberately excludes the wall-clock `now` and the backup path so a
  // same-source replay is idempotent regardless of the caller's timestamp or where
  // the backup is staged.
  const payloadBody = {
    kind: "import",
    trackBRoot,
    projectId: input.projectId,
    runId: input.runId,
    traceId: input.traceId,
    target: input.target,
    stateDigest: tbState.stateDigest,
    unitDigests: [...unitMap.values()].map(u => u.digest).sort(),
  };
  const payloadDigest = "sha256:" + sha256Hex(canonicalJson(payloadBody));

  // Replay pre-check: same operation identity + same payload digest → cached result, no writes.
  const priorOp = lookupMigrationOperation(handle, input.projectId, input.runId, operationId, "import");
  if (priorOp) {
    if (priorOp.payload_digest !== payloadDigest) throw new Error("operation_replay_conflict: track_b_import");
    if (!priorOp.result_json) throw new Error("operation_replay_missing_result: track_b_import");
    const cachedReport = parseCachedImportReport(priorOp.result_json);
    verifyImportMaterialization(handle, input.projectId, input.runId, input.traceId, input.target, cachedReport.definitionDigest, unitMap);
    return { ...cachedReport, alreadyImported: 1, dryRun: false };
  }

  // Incomplete legacy state: a definition row exists for this run but no migration
  // operation can be reconstructed. Fail closed: do not silently overwrite, do not
  // return a misleading alreadyImported result.
  const legacyDef = handle.db.query(
    `SELECT definition_digest FROM durable_definitions WHERE project_id = ? AND run_id = ?`,
  ).get(input.projectId, input.runId) as { definition_digest: string } | null;
  if (legacyDef) {
    throw new Error("durable_work: incomplete_legacy_state: definition_exists_without_migration_operation");
  }

  // Build the backup with STATE, units, and every referenced evidence file.
  // The stage name is derived from encodeDwcTuple(operationId, payloadDigest).
  // When a stage directory already exists (e.g. from dry-run or orphan retry),
  // validate every file matches the expected manifest before reusing it.
  const stamp = deriveStageName(operationId, payloadDigest);
  const backupDir = join(backupRoot, stamp);
  const manifest: BackupManifest = buildBackupManifest({
    backupDir, trackBRoot,
    projectId: input.projectId, runId: input.runId, traceId: input.traceId, target: input.target,
    now, operationId,
    stateBytes: rawStateRaw,
    unitBytes: [...unitMap.values()].map(u => ({ id: u.id, bytes: readFileSync(join(trackBRoot, "units", `${u.id}.json`)) })),
    evidenceBytes: [...unitMap.entries()].flatMap(([unitId, tb]) => tb.evidence.map(item => ({
      unitId, ref: item.ref, bytes: readFileSync(resolve(trackBRoot, ...item.ref.split("/"))),
    }))),
  });

  let stageCreated = false;
  try {
    if (existsSync(backupDir)) {
      // Deterministic crash-orphan or dry-run reuse: validate every byte matches
      // the expected manifest before trusting the existing stage.
      validateReusableStage(backupDir, manifest, stamp);
    } else {
      mkdirSync(backupRoot, { recursive: true });
      try {
        mkdirSync(backupDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          validateReusableStage(backupDir, manifest, stamp);
        } else {
          throw error;
        }
      }
      stageCreated = true;
      mkdirSync(join(backupDir, "units"), { recursive: true });

      copyBackupFileAtomic(statePath, join(backupDir, "STATE.json"));
      const unitBytes: Array<{ id: string; bytes: Buffer }> = [];
      for (const u of tbState.units) {
        const srcPath = join(trackBRoot, "units", `${u.id}.json`);
        const destPath = join(backupDir, "units", `${u.id}.json`);
        copyBackupFileAtomic(srcPath, destPath);
        unitBytes.push({ id: u.id, bytes: readFileSync(destPath) });
      }
      const evidenceBytes: Array<{ unitId: string; ref: string; bytes: Buffer }> = [];
      for (const [unitId, tb] of unitMap.entries()) {
        for (const item of tb.evidence) {
          const entry = copyEvidenceToBackup(trackBRoot, backupDir, unitId, item.ref);
          evidenceBytes.push({ unitId, ref: item.ref, bytes: readFileSync(join(backupDir, ...entry.path.split("/"))) });
        }
      }

      writeBackupFileAtomic(join(backupDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2));
    }

    if (input.dryRun) {
      const units: DurableUnitDefinition[] = tbState.units.map(u => ({
        id: u.id, kind: "migration" as const, scope: u.scope, bounds: u.bounds,
      }));
      const body: Omit<DefinedUnits, "digest"> = {
        schemaVersion: DURABLE_SCHEMA_VERSION, projectId: input.projectId, runId: input.runId, traceId: input.traceId,
        units, createdAt: now,
      };
      return { imported: units.length, alreadyImported: 0, backup: backupDir, dryRun: true, definitionDigest: definitionDigest(body), operationId };
    }

    // One immediate transaction wraps migration operation + definition row + unit rows +
    // canonical events + outbox. A failure on any step rolls back the entire effect.
    const report = handle.db.transaction(() => {
      // Defensive re-check inside the transaction (race against another writer).
      const prior = lookupMigrationOperation(handle, input.projectId, input.runId, operationId, "import");
      if (prior) {
        if (prior.payload_digest !== payloadDigest) throw new Error("operation_replay_conflict: track_b_import");
        if (!prior.result_json) throw new Error("operation_replay_missing_result: track_b_import");
        const cachedReport = parseCachedImportReport(prior.result_json);
        verifyImportMaterialization(handle, input.projectId, input.runId, input.traceId, input.target, cachedReport.definitionDigest, unitMap);
        return { ...cachedReport, alreadyImported: 1, dryRun: false };
      }

      const units: DurableUnitDefinition[] = tbState.units.map(u => ({
        id: u.id, kind: "migration" as const, scope: u.scope, bounds: u.bounds,
      }));
      const body: Omit<DefinedUnits, "digest"> = {
        schemaVersion: DURABLE_SCHEMA_VERSION, projectId: input.projectId, runId: input.runId, traceId: input.traceId,
        units, createdAt: now,
      };
      const defDigest = definitionDigest(body);
      const targetKind = input.target.kind;
      const targetSlug = input.target.slug;
      const targetCapability = input.target.kind === "squad" ? ((input.target as { capabilityId?: string }).capabilityId ?? null) : null;

      handle.db.run(
        `INSERT INTO durable_definitions(project_id, run_id, trace_id, target_kind, target_slug, target_capability_id,
           definition_json, definition_digest, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [input.projectId, input.runId, input.traceId, targetKind, targetSlug, targetCapability,
          canonicalJson(body), defDigest, now],
      );

      for (const u of units) {
        const tb = unitMap.get(u.id)!;
        const status: DurableUnitStatus = tb.status === "complete" ? "completed" : tb.status === "failed" ? "failed" : "partial";
        const rowBody: Omit<DurableUnitRow, "digest"> = {
          schemaVersion: DURABLE_SCHEMA_VERSION, projectId: input.projectId, runId: input.runId, traceId: input.traceId,
          id: u.id, kind: u.kind, scope: u.scope, bounds: u.bounds, label: u.id,
          status, coverage: tb.coverage, attempts: tb.attempts, evidence: tb.evidence, operations: tb.operations,
          revision: tb.revision, createdAt: tb.createdAt, updatedAt: tb.updatedAt,
        };
        const next: DurableUnitRow = { ...rowBody, digest: rowDigest(rowBody) };
        persistUnitRow(handle, next);
        appendEvent(handle, {
          projectId: input.projectId, runId: input.runId, traceId: input.traceId,
          type: "x_durable_work_unit_imported",
          actor: { kind: "track-b-migration", id: operationId },
          correlationId: `cor_dw_mig_unit_imp_${encodeDwcTuple(input.runId, operationId, u.id)}`,
          idempotencyKey: `dw-mig-unit-imp-${encodeDwcTuple(input.runId, operationId, u.id)}@${input.runId}`,
          occurredAt: now,
          payload: {
            unit_id: u.id,
            operation_id: operationId,
            migration_operation_id: operationId,
            source_authority: "holdfast-track-b",
            source_version: "1.1.0-nirvana.1",
            origin: {
              upstream_project: "AndreAlmeidaDC/holdfast",
              upstream_version: "1.1.0",
              target_authority: "nirvana-core-dwc",
            },
            unit_digest: next.digest,
            revision: next.revision,
          },
        });
      }

      const migrationResult: ImportReport = {
        imported: units.length,
        alreadyImported: 0,
        backup: backupDir,
        dryRun: false,
        definitionDigest: defDigest,
        operationId,
      };
      handle.db.run(
        `INSERT INTO durable_migration_operations(project_id, run_id, operation_id, kind, payload_digest, backup_path, manifest_digest, applied_at, result_json)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [input.projectId, input.runId, operationId, "import", payloadDigest, backupDir, manifest.digest, now,
          canonicalJson(migrationResult)],
      );

      appendEvent(handle, {
        projectId: input.projectId, runId: input.runId, traceId: input.traceId,
        type: "x_durable_work_units_defined",
        actor: { kind: "track-b-migration", id: operationId },
        correlationId: `cor_dw_mig_def_${encodeDwcTuple(input.runId, operationId)}`,
        idempotencyKey: `dw-mig-def-${encodeDwcTuple(input.runId, operationId)}@${input.runId}`,
        occurredAt: now,
        payload: { definition_digest: defDigest, unit_ids: units.map(u => u.id), migration_operation_id: operationId },
      });

      appendEvent(handle, {
        projectId: input.projectId, runId: input.runId, traceId: input.traceId,
        type: "x_durable_work_track_b_imported",
        actor: { kind: "track-b-migration", id: operationId },
        correlationId: `cor_dw_mig_imp_${encodeDwcTuple(input.runId, operationId)}`,
        idempotencyKey: `dw-mig-imp-${encodeDwcTuple(input.runId, operationId)}@${input.runId}`,
        occurredAt: now,
        payload: {
          definition_digest: defDigest,
          unit_count: units.length,
          operation_id: operationId,
          migration_operation_id: operationId,
          manifest_digest: manifest.digest,
          payload_digest: payloadDigest,
          source_authority: "holdfast-track-b",
          source_version: "1.1.0-nirvana.1",
          origin: {
            upstream_project: "AndreAlmeidaDC/holdfast",
            upstream_version: "1.1.0",
            target_authority: "nirvana-core-dwc",
          },
        },
      });

      return migrationResult;
    }).immediate();

    return report;
  } catch (error) {
    if (stageCreated) {
      try { removeCreatedBackupStage(backupRoot, backupDir); } catch { /* preserve the original failure */ }
    }
    throw error;
  }
}

export interface RollbackTrackBInput {
  /** Required: the caller-supplied canonical kernel handle. The rollback never opens a second kernel. */
  handle: KernelHandle;
  projectId: string;
  runId: string;
  /** Optional rollback operation identity. When absent, derived deterministically from the backup manifest digest. */
  operationId?: string;
  backup: string;
  /** Optional explicit deterministic timestamp for the canonical rollback event. */
  now?: string;
}

export function rollbackTrackBImport(input: RollbackTrackBInput): void {
  if (!input.handle) throw new Error("durable_work: handle_required");
  if (input.now !== undefined) assertIsoTimestamp(input.now, "now");

  const backupDir = resolve(input.backup);
  const manifestPath = join(backupDir, "MANIFEST.json");
  if (!existsSync(manifestPath)) throw new Error("rollback_backup_manifest_missing");
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  } catch { throw new Error("rollback_backup_manifest_malformed"); }
  validateBackupManifest(manifest, {
    projectId: input.projectId, runId: input.runId,
  });
  verifyBackupFiles(backupDir, manifest);

  const handle = input.handle;
  ensureTables(handle);

  // Canonical context guard, against the manifest's recorded traceId / target.
  assertCanonicalContext(handle, {
    projectId: input.projectId, runId: input.runId,
    traceId: manifest.traceId, target: manifest.target,
  }, { allowTerminal: true });

  const operationId = input.operationId ?? deriveRollbackOperationId(manifest.digest);
  const now = input.now ?? new Date().toISOString();

  const payloadBody = {
    kind: "rollback",
    backup: backupDir,
    manifestDigest: manifest.digest,
    projectId: input.projectId,
    runId: input.runId,
  };
  const payloadDigest = "sha256:" + sha256Hex(canonicalJson(payloadBody));

  // Atomic transaction: migration operation + run-scoped delete + canonical event.
  // A trigger that aborts the rollback event rolls back the entire effect,
  // preserving the prior import's DWC state and audit history.
  handle.db.transaction(() => {
    const prior = lookupMigrationOperation(handle, input.projectId, input.runId, operationId, "rollback");
    if (prior) {
      if (prior.payload_digest !== payloadDigest) throw new Error("operation_replay_conflict: track_b_rollback");
      // Replay must verify the post-state is still the rolled-back state; if the
      // run was reimported after this cached rollback, or if any auxiliary durable
      // rows remain/drifted, a silent no-op would be a state-drift/replay conflict.
      const liveUnits = (handle.db.query(
        `SELECT COUNT(*) AS n FROM durable_units WHERE project_id = ? AND run_id = ?`,
      ).get(input.projectId, input.runId) as { n: number }).n;
      const liveDef = (handle.db.query(
        `SELECT COUNT(*) AS n FROM durable_definitions WHERE project_id = ? AND run_id = ?`,
      ).get(input.projectId, input.runId) as { n: number }).n;
      const liveClaims = (handle.db.query(
        `SELECT COUNT(*) AS n FROM durable_claims WHERE project_id = ? AND run_id = ?`,
      ).get(input.projectId, input.runId) as { n: number }).n;
      const liveOps = (handle.db.query(
        `SELECT COUNT(*) AS n FROM durable_operations WHERE project_id = ? AND run_id = ?`,
      ).get(input.projectId, input.runId) as { n: number }).n;
      const liveSnaps = (handle.db.query(
        `SELECT COUNT(*) AS n FROM durable_operation_snapshots WHERE project_id = ? AND run_id = ?`,
      ).get(input.projectId, input.runId) as { n: number }).n;
      if (liveUnits > 0 || liveDef > 0 || liveClaims > 0 || liveOps > 0 || liveSnaps > 0) {
        throw new Error("operation_replay_state_drift: track_b_rollback");
      }
      // Same rollback, same backup → no-op.
      return;
    }

    verifyRollbackStatePreconditions(handle, input.projectId, input.runId, backupDir, manifest);

    handle.db.run(`DELETE FROM durable_units WHERE project_id = ? AND run_id = ?`, [input.projectId, input.runId]);
    handle.db.run(`DELETE FROM durable_definitions WHERE project_id = ? AND run_id = ?`, [input.projectId, input.runId]);
    handle.db.run(`DELETE FROM durable_claims WHERE project_id = ? AND run_id = ?`, [input.projectId, input.runId]);
    handle.db.run(`DELETE FROM durable_operations WHERE project_id = ? AND run_id = ?`, [input.projectId, input.runId]);
    handle.db.run(`DELETE FROM durable_operation_snapshots WHERE project_id = ? AND run_id = ?`, [input.projectId, input.runId]);

    handle.db.run(
      `INSERT INTO durable_migration_operations(project_id, run_id, operation_id, kind, payload_digest, backup_path, manifest_digest, applied_at, result_json)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [input.projectId, input.runId, operationId, "rollback", payloadDigest, backupDir, manifest.digest, now, null],
    );

    appendEvent(handle, {
      projectId: input.projectId, runId: input.runId, traceId: manifest.traceId,
      type: "x_durable_work_track_b_rollback",
      actor: { kind: "track-b-migration", id: operationId },
      correlationId: `cor_dw_mig_rb_${encodeDwcTuple(input.runId, operationId)}`,
      idempotencyKey: `dw-mig-rb-${encodeDwcTuple(input.runId, operationId)}@${input.runId}`,
      occurredAt: now,
      payload: {
        manifest_digest: manifest.digest,
        operation_id: operationId,
        migration_operation_id: operationId,
        payload_digest: payloadDigest,
        source_authority: "holdfast-track-b",
        source_version: "1.1.0-nirvana.1",
        origin: {
          upstream_project: "AndreAlmeidaDC/holdfast",
          upstream_version: "1.1.0",
          target_authority: "nirvana-core-dwc",
        },
      },
    });
  }).immediate();
}
