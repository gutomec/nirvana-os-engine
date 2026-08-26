import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { GauntletController } from "./controller.ts";
import { compileGauntletPlan } from "./compiler.ts";
import { listCandidateRevisions, listScorecards } from "./store.ts";
import type { CandidateRevision, EvaluationScorecard, GauntletIntensity, GauntletPlan, GauntletProjection } from "./types.ts";
import {
  RunKernelCompatibilityFacade, appendEvent, getRun, saveArtifactRef, verifyArtifactRef,
  type ArtifactRef, type CanonicalRunState, type KernelHandle, type LegacyCompatibilityAdapter, type RunProjection, type TargetRef,
} from "../run-kernel/index.ts";
import { canonicalJson } from "../run-kernel/canonical-json.ts";
import { scopeGuard } from "../../../_shared/lib/scope-guard.ts";

export interface AgentXCandidateResult {
  ok: boolean;
  sessionId: string | null;
  costUsd?: number | null;
  error?: string;
}

export interface AgentXCandidateContext {
  candidateId: string;
  revision: number;
  round: number;
}

export interface AgentXRevisionDefects {
  failedDimensions: string[];
  revisionRequests: EvaluationScorecard["revisionRequests"];
  evaluationIds: string[];
}

export interface AgentXRevisionRequest extends AgentXCandidateContext {
  /** Where the revision is written; it starts as a copy of the previous revision. */
  candidateRoot: string;
  previousRoot: string;
  previousRevisionId: string;
  defects: AgentXRevisionDefects;
}

export interface AgentXGauntletEvaluationInput extends AgentXCandidateContext {
  projectId: string;
  runId: string;
  revisionId: string;
  candidateRoot: string;
  artifactRefs: ArtifactRef[];
  /** Plan metadata (`evaluator_only` holdout); the cutover provides no physical isolation. */
  holdout: boolean;
}

export interface AgentXGauntletEvaluator {
  target: TargetRef;
  evaluate(input: AgentXGauntletEvaluationInput): EvaluationScorecard[];
}

export interface AgentXGauntletInput {
  kernel: KernelHandle;
  legacy?: LegacyCompatibilityAdapter;
  projectId: string;
  runId: string;
  traceId: string;
  brief: string;
  projectRoot: string;
  outputsRoot: string;
  /** Cost reserved per round: the per-candidate estimate times `candidateStrategy.count`. */
  expectedCostUsd: number;
  intensity?: GauntletIntensity;
  producerTarget?: TargetRef;
  executionSnapshot?: Record<string, unknown>;
  executeCandidate(candidateRoot: string, context: AgentXCandidateContext): AgentXCandidateResult;
  /** Produces the next revision of one candidate from its evaluated defects. Without it a
   * `revising` Gauntlet is withheld with reason `revision_unavailable`. */
  reviseCandidate?(request: AgentXRevisionRequest): AgentXCandidateResult;
  evaluator: AgentXGauntletEvaluator;
  afterCandidatePersisted?(candidate: CandidateRevision): void;
  afterRevisionRequested?(): void;
  finalGate(input: { outputsRoot: string; sessionId: string | null }): { exitCode: 0 | 1 | 2 | 3; gateOutcome: string };
}

export class AgentXGauntletInterruption extends Error {}

export interface AgentXGauntletResult {
  run: RunProjection;
  gauntlet: GauntletProjection;
  exitCode: 0 | 1 | 2 | 3;
  sessionId: string | null;
  finalGateRan: boolean;
}

export function shouldRunAgentXGauntlet(input: {
  targetKind: "business" | "squad" | "agent-x";
  wantExec: boolean;
  resolvedMode: "standard" | "gauntlet";
}): boolean {
  return input.targetKind === "agent-x" && input.wantExec && input.resolvedMode === "gauntlet";
}

export function shouldRunSquadGauntlet(input: {
  squadCount: number;
  wantExec: boolean;
  resolvedMode: "standard" | "gauntlet";
}): boolean {
  return input.squadCount === 1 && input.wantExec && input.resolvedMode === "gauntlet";
}

/** Splits the plan budget evenly across rounds and candidates so every round stays affordable;
 * the caller's `maxBudgetUsd` only lowers the per-candidate share. */
export function gauntletRoundBudget(plan: GauntletPlan, maxBudgetUsd?: number): { candidateBudgetUsd: number; roundBudgetUsd: number } {
  const share = plan.budget.maxCostUsd / (plan.candidateStrategy.count * plan.stop.maxRounds);
  const candidateBudgetUsd = Math.min(maxBudgetUsd ?? share, share);
  return { candidateBudgetUsd, roundBudgetUsd: Math.min(candidateBudgetUsd * plan.candidateStrategy.count, plan.budget.maxCostUsd) };
}

/** Deterministic section appended to the original brief when a candidate is revised. */
export function revisionDefectsSection(request: AgentXRevisionRequest): string {
  return [
    "## Defeitos a corrigir",
    "",
    `Esta é a revisão ${request.revision} do candidate ${request.candidateId} (rodada ${request.round}).`,
    `Leia a revisão anterior em ${request.previousRoot} e escreva a revisão completa em ${request.candidateRoot}.`,
    "Corrija somente os defeitos listados e preserve tudo o que já foi aprovado.",
    scopeGuard("pt-BR"),
    "",
    `Dimensões reprovadas: ${request.defects.failedDimensions.join(", ")}`,
    `Avaliações causais: ${request.defects.evaluationIds.join(", ")}`,
    "",
    "Requisitos a revisar:",
    ...request.defects.revisionRequests.map(item => `- ${item.requirementId}: ${item.evidenceRefs.join(", ") || "sem evidência anexada"}`),
  ].join("\n");
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (entry.isFile()) files.push(filePath);
    }
  };
  if (fs.existsSync(root)) visit(root);
  return files;
}

function mediaType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return ({ ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".html": "text/html",
    ".yaml": "application/yaml", ".yml": "application/yaml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".pdf": "application/pdf" } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function candidateRootFor(input: AgentXGauntletInput, candidateId: string, revision: number): string {
  return path.join(input.projectRoot, ".nirvana", "gauntlet", input.runId, "candidates", candidateId, `rev_${revision}`);
}

function revisionIdFor(runId: string, candidateId: string, revision: number): string {
  return `crv_${runId}_${candidateId}_${revision}`;
}

function artifactRefs(input: AgentXGauntletInput, candidateRoot: string, candidateId: string, revision: number): ArtifactRef[] {
  const producer = input.producerTarget ?? { kind: "agent-x" as const, slug: "agent-x" as const };
  return filesUnder(candidateRoot).map(filePath => {
    const content = fs.readFileSync(filePath);
    const relative = path.relative(candidateRoot, filePath);
    // Artifact identity is scoped to the Run: two Runs of one project (a Glance kernel holds
    // many) may both produce can_1/result.md, and artifact_refs is unique per (project, artifact, revision).
    return {
      schemaVersion: "nirvana.artifact-ref/v1alpha1", projectId: input.projectId, runId: input.runId,
      artifactId: `art_${createHash("sha256").update(`${input.runId}:${candidateId}:${relative}`).digest("hex").slice(0, 20)}`,
      revisionId: `arv_${createHash("sha256").update(`${input.runId}:${candidateId}:${relative}:${revision}`).digest("hex").slice(0, 24)}`,
      revision, role: "candidate", mediaType: mediaType(filePath), bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"), publishedUri: pathToFileURL(filePath).href,
      classification: "internal", producer: { targetKind: producer.kind, targetSlug: producer.slug,
        ...(producer.kind === "squad" ? { capabilityId: producer.capabilityId } : {}) },
    };
  });
}

/** Resumable per-file copy: identical files are skipped, others land through a temporary file and rename. */
function copyTree(sourceRoot: string, destinationRoot: string): void {
  for (const source of filesUnder(sourceRoot)) {
    const relative = path.relative(sourceRoot, source);
    const destination = path.join(destinationRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const sourceDigest = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
    if (fs.existsSync(destination) && createHash("sha256").update(fs.readFileSync(destination)).digest("hex") === sourceDigest) continue;
    const temporary = `${destination}.nrv-${randomUUID()}.tmp`;
    fs.copyFileSync(source, temporary);
    fs.renameSync(temporary, destination);
  }
}

function defectsFor(scorecards: EvaluationScorecard[]): AgentXRevisionDefects {
  return {
    failedDimensions: [...new Set(scorecards.flatMap(scorecard => scorecard.dimensions.filter(dimension => !dimension.passed).map(dimension => dimension.id)))],
    revisionRequests: scorecards.flatMap(scorecard => scorecard.revisionRequests),
    evaluationIds: scorecards.map(scorecard => scorecard.evaluationId),
  };
}

/** Terminal Run state for a final gate result; shared with the standard-mode publication. */
export function terminalForGate(gate: { exitCode: 0 | 1 | 2 | 3; gateOutcome: string }): "completed" | "delivered_with_reservations" | "withheld" | "failed" {
  if (gate.exitCode === 0) return gate.gateOutcome === "pass" ? "completed" : "delivered_with_reservations";
  if (gate.exitCode === 2 || gate.exitCode === 3) return "withheld";
  return "failed";
}

export function runAgentXGauntlet(input: AgentXGauntletInput): AgentXGauntletResult {
  const producer = input.producerTarget ?? { kind: "agent-x" as const, slug: "agent-x" as const };
  const actor = { kind: "kernel", id: "agent-x-gauntlet-cutover" };
  const correlationId = `cor_${input.runId}`;
  const facade = new RunKernelCompatibilityFacade(input.kernel, input.legacy);
  const snapshot = input.executionSnapshot ?? { runtime: { selection: "active", resolved: false },
    model: { selection: "runtime-default", resolved: false } };
  const policySnapshotRef = `snapshot_${createHash("sha256").update(canonicalJson(snapshot)).digest("hex").slice(0, 24)}`;
  let run = getRun(input.kernel, input.projectId, input.runId) ?? facade.create({ projectId: input.projectId, runId: input.runId, traceId: input.traceId,
    planId: `plan_${input.runId}`, target: producer, policySnapshotRef,
    actor, correlationId, idempotencyKey: `agent-x-gauntlet:${input.runId}:create` });
  // An adopted Run (prepared elsewhere, e.g. by Glance with --run-id) keeps the trace it was
  // prepared with, so every event of one Run shares one trace; a fresh Run uses the caller's.
  const traceId = run.traceId;
  appendEvent(input.kernel, { projectId: input.projectId, runId: input.runId, traceId,
    type: "runtime.selection_snapshot", actor, correlationId,
    idempotencyKey: `agent-x-gauntlet:${input.runId}:execution-snapshot`, payload: { ref: policySnapshotRef, snapshot } });
  const transition = (to: CanonicalRunState, key: string, payload?: Record<string, unknown>): RunProjection =>
    facade.transition({ projectId: input.projectId, runId: input.runId, to, actor, correlationId,
      idempotencyKey: `agent-x-gauntlet:${input.runId}:${key}`, ...(payload ? { payload } : {}) });
  const sessions = new Map<string, string>();
  let sessionId: string | null = null;
  try {
    const controller = new GauntletController(input.kernel, { projectId: input.projectId, runId: input.runId, traceId, actor, correlationId });
    const plan = compileGauntletPlan({ brief: input.brief, intensity: input.intensity ?? "light" });
    const candidateIds = Array.from({ length: plan.candidateStrategy.count }, (_, index) => `can_${index + 1}`);
    const holdout = plan.gauntlets.some(gauntlet => gauntlet.holdout.enabled);
    let gauntlet = controller.begin(plan);
    // RT-002: a frozen snapshot carrying the broker's `errors` (runtime, provider or
    // model incompatible) ends the Run here, before any producer, with the reasons in
    // the journal. Nothing is switched silently and the legacy executor never runs.
    const incompatibility = Array.isArray((snapshot as { errors?: unknown }).errors) ? (snapshot as { errors: string[] }).errors : [];
    if (incompatibility.length) {
      gauntlet = controller.fail(`runtime incompatible: ${incompatibility.join(" ")}`);
      run = transition("rolled_back", "rolled-back-runtime-incompatible", { reason: "runtime_incompatible", errors: incompatibility });
      return { run, gauntlet, exitCode: 1, sessionId: null, finalGateRan: false };
    }
    let withheldReason: string | undefined;
    const fail = (reason: string, key: string, failedSessionId: string | null): AgentXGauntletResult => {
      gauntlet = controller.fail(reason);
      run = transition("failed", key, { error: reason });
      return { run, gauntlet, exitCode: 1, sessionId: failedSessionId, finalGateRan: false };
    };

    while (gauntlet.state !== "stopped") {
      if (gauntlet.state === "revising") {
        if (!input.reviseCandidate) {
          withheldReason = "revision_unavailable";
          gauntlet = controller.fail(withheldReason);
          break;
        }
        gauntlet = controller.markRegressionTesting();
      }
      if (gauntlet.state !== "producing") gauntlet = controller.beginRound(input.expectedCostUsd);
      if (gauntlet.state === "stopped") break;
      if (run.state === "prepared") run = transition("running", "running");
      const round = gauntlet.round;

      const revisions = listCandidateRevisions(input.kernel, input.projectId, input.runId);
      for (const candidateId of candidateIds) {
        const revisionId = revisionIdFor(input.runId, candidateId, round);
        if (revisions.some(revision => revision.revisionId === revisionId)) continue;
        const candidateRoot = candidateRootFor(input, candidateId, round);
        fs.mkdirSync(candidateRoot, { recursive: true });
        const context = { candidateId, revision: round, round };
        let lineage: Pick<CandidateRevision, "parentRevisionId" | "causalEvaluationIds" | "hypothesis"> = { causalEvaluationIds: [] };
        let result: AgentXCandidateResult = { ok: true, sessionId: null };
        if (round === 1) {
          result = input.executeCandidate(candidateRoot, context);
        } else {
          const previousRevisionId = revisionIdFor(input.runId, candidateId, round - 1);
          const previousRoot = candidateRootFor(input, candidateId, round - 1);
          const previousRoundIds = new Set(candidateIds.map(id => revisionIdFor(input.runId, id, round - 1)));
          const scorecards = listScorecards(input.kernel, input.projectId, input.runId);
          const own = scorecards.filter(scorecard => scorecard.revisionId === previousRevisionId);
          const causal = own.length ? own : scorecards.filter(scorecard => previousRoundIds.has(scorecard.revisionId));
          const defects = defectsFor(own);
          copyTree(previousRoot, candidateRoot);
          if (defects.failedDimensions.length) {
            result = input.reviseCandidate!({ ...context, candidateRoot, previousRoot, previousRevisionId, defects });
          }
          lineage = { parentRevisionId: previousRevisionId, causalEvaluationIds: causal.map(scorecard => scorecard.evaluationId),
            hypothesis: defects.failedDimensions.length
              ? `Fix ${defects.failedDimensions.join(", ")} reported by ${defects.evaluationIds.join(", ")}`
              : `Carry ${candidateId} forward: no defects reported by ${causal.map(scorecard => scorecard.evaluationId).join(", ")}` };
        }
        if (result.sessionId) { sessions.set(candidateId, result.sessionId); sessionId = result.sessionId; }
        if (!result.ok) return fail(result.error ?? "candidate execution failed", "candidate-failed", result.sessionId);
        const refs = artifactRefs(input, candidateRoot, candidateId, round);
        if (!refs.length) return fail("candidate produced no artifacts", "empty-candidate", result.sessionId);
        for (const ref of refs) { verifyArtifactRef(ref, candidateRoot); saveArtifactRef(input.kernel, ref); }
        const candidate = controller.addCandidate({ candidateId, revision: round, revisionId, artifactRefs: refs.map(ref => ref.revisionId),
          producer, ...lineage, createdAt: new Date().toISOString() });
        input.afterCandidatePersisted?.(candidate);
      }

      const persisted = listScorecards(input.kernel, input.projectId, input.runId);
      const scorecards: EvaluationScorecard[] = [];
      for (const candidateId of candidateIds) {
        const revisionId = revisionIdFor(input.runId, candidateId, round);
        const existing = persisted.filter(scorecard => scorecard.revisionId === revisionId);
        if (existing.length) { scorecards.push(...existing); continue; }
        const candidateRoot = candidateRootFor(input, candidateId, round);
        scorecards.push(...input.evaluator.evaluate({ projectId: input.projectId, runId: input.runId, candidateId, revision: round, round,
          revisionId, candidateRoot, artifactRefs: artifactRefs(input, candidateRoot, candidateId, round), holdout }));
      }
      gauntlet = controller.evaluateRound(scorecards);
      if (gauntlet.state === "revising") input.afterRevisionRequested?.();
    }

    if (gauntlet.round === 0) {
      run = transition("rolled_back", "rolled-back-before-candidate", { reason: gauntlet.stopReason });
      return { run, gauntlet, exitCode: 1, sessionId: null, finalGateRan: false };
    }
    if (gauntlet.stopReason !== "success") {
      run = transition("verifying", "verifying");
      run = transition("withheld", "withheld", { reason: withheldReason ?? gauntlet.stopReason });
      return { run, gauntlet, exitCode: 2, sessionId, finalGateRan: false };
    }

    const selected = listCandidateRevisions(input.kernel, input.projectId, input.runId).find(revision => revision.revisionId === gauntlet.selectedRevisionId);
    if (!selected) throw new Error(`gauntlet: selected revision '${gauntlet.selectedRevisionId}' not found`);
    copyTree(candidateRootFor(input, selected.candidateId, selected.revision), input.outputsRoot);
    const selectedSessionId = sessions.get(selected.candidateId) ?? sessionId;
    if (run.state === "running") run = transition("verifying", "verifying");
    const gate = input.finalGate({ outputsRoot: input.outputsRoot, sessionId: selectedSessionId });
    run = transition(terminalForGate(gate), "terminal", { exitCode: gate.exitCode, gateOutcome: gate.gateOutcome });
    return { run, gauntlet, exitCode: gate.exitCode, sessionId: selectedSessionId, finalGateRan: true };
  } catch (error) {
    if (error instanceof AgentXGauntletInterruption) throw error;
    run = getRun(input.kernel, input.projectId, input.runId)!;
    if (run.state === "prepared") facade.transition({ projectId: input.projectId, runId: input.runId, to: "rolled_back", actor, correlationId,
      idempotencyKey: `agent-x-gauntlet:${input.runId}:rolled-back`, payload: { error: String((error as Error).message) } });
    else if (run.state === "running" || run.state === "waiting" || run.state === "revising" || run.state === "verifying") {
      facade.transition({ projectId: input.projectId, runId: input.runId, to: "failed", actor, correlationId,
        idempotencyKey: `agent-x-gauntlet:${input.runId}:failed`, payload: { error: String((error as Error).message) } });
    }
    throw error;
  }
}
