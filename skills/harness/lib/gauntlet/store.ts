import { canonicalJson } from "../run-kernel/canonical-json.ts";
import { appendEvent, type KernelHandle } from "../run-kernel/store.ts";
import type { CandidateRevision, EvaluationScorecard, GauntletPlan, GauntletProjection } from "./types.ts";

export interface GauntletContext {
  projectId: string;
  runId: string;
  traceId: string;
  actor: { kind: string; id: string };
  correlationId: string;
}

export function initializeGauntletStore(handle: KernelHandle): void {
  handle.db.exec(`CREATE TABLE IF NOT EXISTS gauntlet_runs (
      project_id TEXT NOT NULL, run_id TEXT NOT NULL, projection_json TEXT NOT NULL,
      version INTEGER NOT NULL, PRIMARY KEY(project_id, run_id)
    );
    CREATE TABLE IF NOT EXISTS gauntlet_candidates (
      project_id TEXT NOT NULL, run_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
      revision INTEGER NOT NULL, revision_id TEXT NOT NULL UNIQUE, candidate_json TEXT NOT NULL,
      PRIMARY KEY(project_id, run_id, candidate_id, revision)
    );
    CREATE TABLE IF NOT EXISTS gauntlet_evaluations (
      project_id TEXT NOT NULL, run_id TEXT NOT NULL, evaluation_id TEXT NOT NULL,
      scorecard_json TEXT NOT NULL, PRIMARY KEY(project_id, run_id, evaluation_id)
    );`);
}

export function getGauntlet(handle: KernelHandle, projectId: string, runId: string): GauntletProjection | null {
  const row = handle.db.query("SELECT projection_json FROM gauntlet_runs WHERE project_id = ? AND run_id = ?")
    .get(projectId, runId) as { projection_json: string } | null;
  return row ? JSON.parse(row.projection_json) as GauntletProjection : null;
}

export function beginGauntlet(handle: KernelHandle, context: GauntletContext, plan: GauntletPlan, startedAt = new Date().toISOString()): GauntletProjection {
  initializeGauntletStore(handle);
  const existing = getGauntlet(handle, context.projectId, context.runId);
  if (existing) {
    if (canonicalJson(existing.plan) !== canonicalJson(plan)) throw new Error("gauntlet: run already has a different plan");
    return existing;
  }
  const projection: GauntletProjection = {
    projectId: context.projectId, runId: context.runId, traceId: context.traceId, plan,
    state: plan.successContract.humanRequired ? "stopped" : "ready", round: 0, spentUsd: 0,
    startedAt, bestScore: 0, flatRounds: 0,
    ...(plan.successContract.humanRequired ? { stopReason: "human_required" as const, decision: "withheld" as const } : {}),
    reservations: [], version: 1,
  };
  handle.db.transaction(() => {
    handle.db.run("INSERT INTO gauntlet_runs(project_id, run_id, projection_json, version) VALUES (?, ?, ?, ?)",
      [context.projectId, context.runId, canonicalJson(projection), projection.version]);
    appendEvent(handle, { ...context, type: "gauntlet.plan_compiled", idempotencyKey: `gauntlet:${context.runId}:plan`, occurredAt: startedAt,
      payload: { plan, state: projection.state, stopReason: projection.stopReason ?? null } });
  }).immediate();
  return projection;
}

export function updateGauntlet(handle: KernelHandle, context: GauntletContext, next: GauntletProjection, event: {
  type: string; idempotencyKey: string; payload?: Record<string, unknown>; occurredAt?: string;
}): GauntletProjection {
  const current = getGauntlet(handle, context.projectId, context.runId);
  if (!current) throw new Error("gauntlet: run has not been initialized");
  const priorEvent = handle.db.query("SELECT event_json FROM run_events WHERE project_id = ? AND idempotency_key = ?")
    .get(context.projectId, event.idempotencyKey) as { event_json: string } | null;
  if (priorEvent) return current;
  if (next.version !== current.version + 1) throw new Error(`gauntlet: expected version ${current.version + 1}`);
  handle.db.transaction(() => {
    const result = handle.db.run("UPDATE gauntlet_runs SET projection_json = ?, version = ? WHERE project_id = ? AND run_id = ? AND version = ?",
      [canonicalJson(next), next.version, context.projectId, context.runId, current.version]);
    if (result.changes !== 1) throw new Error("gauntlet: concurrent projection update");
    appendEvent(handle, { ...context, type: event.type, idempotencyKey: event.idempotencyKey, occurredAt: event.occurredAt,
      payload: { version: next.version, ...(event.payload ?? {}) } });
  }).immediate();
  return next;
}

export function saveCandidateRevision(handle: KernelHandle, context: GauntletContext, candidate: CandidateRevision): CandidateRevision {
  initializeGauntletStore(handle);
  const serialized = canonicalJson(candidate);
  const existing = handle.db.query("SELECT candidate_json FROM gauntlet_candidates WHERE revision_id = ?")
    .get(candidate.revisionId) as { candidate_json: string } | null;
  if (existing) {
    if (existing.candidate_json !== serialized) throw new Error(`gauntlet: candidate revision conflict for '${candidate.revisionId}'`);
    return JSON.parse(existing.candidate_json) as CandidateRevision;
  }
  const previous = candidate.revision > 1
    ? handle.db.query("SELECT candidate_json FROM gauntlet_candidates WHERE project_id = ? AND run_id = ? AND candidate_id = ? AND revision = ?")
      .get(context.projectId, context.runId, candidate.candidateId, candidate.revision - 1) as { candidate_json: string } | null
    : null;
  if (candidate.revision > 1 && !previous) throw new Error("gauntlet: candidate revisions must be contiguous");
  if (candidate.revision > 1 && (!candidate.parentRevisionId || !candidate.causalEvaluationIds.length || !candidate.hypothesis)) {
    throw new Error("gauntlet: revision requires parent, causal evaluations, and an improvement hypothesis");
  }
  handle.db.transaction(() => {
    handle.db.run("INSERT INTO gauntlet_candidates(project_id, run_id, candidate_id, revision, revision_id, candidate_json) VALUES (?, ?, ?, ?, ?, ?)",
      [context.projectId, context.runId, candidate.candidateId, candidate.revision, candidate.revisionId, serialized]);
    appendEvent(handle, { ...context, type: candidate.revision === 1 ? "gauntlet.candidate_created" : "gauntlet.candidate_revised",
      idempotencyKey: `gauntlet:${context.runId}:candidate:${candidate.revisionId}`, occurredAt: candidate.createdAt,
      payload: { candidateId: candidate.candidateId, revisionId: candidate.revisionId, revision: candidate.revision,
        producer: candidate.producer, artifactRefs: candidate.artifactRefs, causalEvaluationIds: candidate.causalEvaluationIds,
        parentRevisionId: candidate.parentRevisionId ?? null, hypothesis: candidate.hypothesis ?? null } });
  }).immediate();
  return candidate;
}

export function saveScorecard(handle: KernelHandle, context: GauntletContext, scorecard: EvaluationScorecard): EvaluationScorecard {
  initializeGauntletStore(handle);
  const serialized = canonicalJson(scorecard);
  const existing = handle.db.query("SELECT scorecard_json FROM gauntlet_evaluations WHERE project_id = ? AND run_id = ? AND evaluation_id = ?")
    .get(context.projectId, context.runId, scorecard.evaluationId) as { scorecard_json: string } | null;
  if (existing) {
    if (existing.scorecard_json !== serialized) throw new Error(`gauntlet: evaluation conflict for '${scorecard.evaluationId}'`);
    return JSON.parse(existing.scorecard_json) as EvaluationScorecard;
  }
  handle.db.transaction(() => {
    handle.db.run("INSERT INTO gauntlet_evaluations(project_id, run_id, evaluation_id, scorecard_json) VALUES (?, ?, ?, ?)",
      [context.projectId, context.runId, scorecard.evaluationId, serialized]);
    appendEvent(handle, { ...context, type: "gauntlet.evaluation_recorded",
      idempotencyKey: `gauntlet:${context.runId}:evaluation:${scorecard.evaluationId}`, occurredAt: scorecard.createdAt,
      payload: scorecard as unknown as Record<string, unknown> });
  }).immediate();
  return scorecard;
}

export function listCandidateRevisions(handle: KernelHandle, projectId: string, runId: string): CandidateRevision[] {
  initializeGauntletStore(handle);
  return (handle.db.query("SELECT candidate_json FROM gauntlet_candidates WHERE project_id = ? AND run_id = ? ORDER BY candidate_id, revision")
    .all(projectId, runId) as { candidate_json: string }[]).map(row => JSON.parse(row.candidate_json));
}

export function listScorecards(handle: KernelHandle, projectId: string, runId: string): EvaluationScorecard[] {
  initializeGauntletStore(handle);
  return (handle.db.query("SELECT scorecard_json FROM gauntlet_evaluations WHERE project_id = ? AND run_id = ? ORDER BY evaluation_id")
    .all(projectId, runId) as { scorecard_json: string }[]).map(row => JSON.parse(row.scorecard_json));
}
