import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { GauntletController } from "./controller.ts";
import { compileGauntletPlan } from "./compiler.ts";
import { listCandidateRevisions, listScorecards } from "./store.ts";
import type { EvaluationScorecard } from "./types.ts";
import {
  RunKernelCompatibilityFacade, appendEvent, getRun, saveArtifactRef, verifyArtifactRef,
  type ArtifactRef, type KernelHandle, type LegacyCompatibilityAdapter, type RunProjection, type TargetRef,
} from "../run-kernel/index.ts";
import { canonicalJson } from "../run-kernel/canonical-json.ts";

export interface AgentXCandidateResult {
  ok: boolean;
  sessionId: string | null;
  costUsd?: number | null;
  error?: string;
}

export interface AgentXGauntletEvaluator {
  target: TargetRef;
  evaluate(input: { projectId: string; runId: string; candidateRoot: string; artifactRefs: ArtifactRef[] }): EvaluationScorecard[];
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
  expectedCostUsd: number;
  producerTarget?: TargetRef;
  executionSnapshot?: Record<string, unknown>;
  executeCandidate(candidateRoot: string): AgentXCandidateResult;
  evaluator: AgentXGauntletEvaluator;
  afterCandidatePersisted?(): void;
  finalGate(input: { outputsRoot: string; sessionId: string | null }): { exitCode: 0 | 1 | 2 | 3; gateOutcome: string };
}

export class AgentXGauntletInterruption extends Error {}

export interface AgentXGauntletResult {
  run: RunProjection;
  exitCode: 0 | 1 | 2 | 3;
  sessionId: string | null;
  finalGateRan: boolean;
}

export function shouldRunAgentXGauntlet(input: {
  targetKind: "business" | "squad" | "agent-x";
  wantExec: boolean;
  resolvedMode: "standard" | "gauntlet";
  intensity: "light" | "balanced" | "exhaustive";
}): boolean {
  return input.targetKind === "agent-x" && input.wantExec && input.resolvedMode === "gauntlet" && input.intensity === "light";
}

export function shouldRunSquadGauntlet(input: {
  squadCount: number;
  wantExec: boolean;
  resolvedMode: "standard" | "gauntlet";
  intensity: "light" | "balanced" | "exhaustive";
}): boolean {
  return input.squadCount === 1 && input.wantExec && input.resolvedMode === "gauntlet" && input.intensity === "light";
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

function artifactRefs(input: AgentXGauntletInput, candidateRoot: string): ArtifactRef[] {
  const producer = input.producerTarget ?? { kind: "agent-x" as const, slug: "agent-x" as const };
  return filesUnder(candidateRoot).map((filePath, index) => {
    const content = fs.readFileSync(filePath);
    const relative = path.relative(candidateRoot, filePath);
    return {
      schemaVersion: "nirvana.artifact-ref/v1alpha1", projectId: input.projectId, runId: input.runId,
      artifactId: `art_${createHash("sha256").update(relative).digest("hex").slice(0, 20)}`,
      revisionId: `arv_${createHash("sha256").update(`${input.runId}:${relative}:1`).digest("hex").slice(0, 24)}`,
      revision: 1, role: "candidate", mediaType: mediaType(filePath), bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"), publishedUri: pathToFileURL(filePath).href,
      classification: "internal", producer: { targetKind: producer.kind, targetSlug: producer.slug,
        ...(producer.kind === "squad" ? { capabilityId: producer.capabilityId } : {}) },
    };
  });
}

function publishCandidate(candidateRoot: string, outputsRoot: string): void {
  for (const source of filesUnder(candidateRoot)) {
    const relative = path.relative(candidateRoot, source);
    const destination = path.join(outputsRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const sourceDigest = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
    if (fs.existsSync(destination) && createHash("sha256").update(fs.readFileSync(destination)).digest("hex") === sourceDigest) continue;
    const temporary = `${destination}.nrv-${randomUUID()}.tmp`;
    fs.copyFileSync(source, temporary);
    fs.renameSync(temporary, destination);
  }
}

function terminalForGate(gate: { exitCode: 0 | 1 | 2 | 3; gateOutcome: string }): "completed" | "delivered_with_reservations" | "withheld" | "failed" {
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
  appendEvent(input.kernel, { projectId: input.projectId, runId: input.runId, traceId: input.traceId,
    type: "runtime.selection_snapshot", actor, correlationId,
    idempotencyKey: `agent-x-gauntlet:${input.runId}:execution-snapshot`, payload: { ref: policySnapshotRef, snapshot } });
  try {
    const controller = new GauntletController(input.kernel, { projectId: input.projectId, runId: input.runId, traceId: input.traceId, actor, correlationId });
    let gauntlet = controller.begin(compileGauntletPlan({ brief: input.brief, intensity: "light" }));
    if (gauntlet.state === "ready") gauntlet = controller.beginRound(input.expectedCostUsd);
    if (gauntlet.state === "stopped" && gauntlet.decision === "withheld") {
      run = facade.transition({ projectId: input.projectId, runId: input.runId, to: "rolled_back", actor, correlationId,
        idempotencyKey: `agent-x-gauntlet:${input.runId}:rolled-back-before-candidate`, payload: { reason: gauntlet.stopReason } });
      return { run, exitCode: 1, sessionId: null, finalGateRan: false };
    }
    if (run.state === "prepared") run = facade.transition({ projectId: input.projectId, runId: input.runId, to: "running", actor, correlationId,
      idempotencyKey: `agent-x-gauntlet:${input.runId}:running` });

    const candidateRoot = path.join(input.projectRoot, ".nirvana", "gauntlet", input.runId, "candidates", "can_1", "rev_1");
    fs.mkdirSync(candidateRoot, { recursive: true });
    let sessionId: string | null = null;
    let revisions = listCandidateRevisions(input.kernel, input.projectId, input.runId);
    if (!revisions.length) {
      const result = input.executeCandidate(candidateRoot);
      sessionId = result.sessionId;
      if (!result.ok) {
        run = facade.transition({ projectId: input.projectId, runId: input.runId, to: "failed", actor, correlationId,
          idempotencyKey: `agent-x-gauntlet:${input.runId}:candidate-failed`, payload: { error: result.error ?? "candidate execution failed" } });
        return { run, exitCode: 1, sessionId, finalGateRan: false };
      }
      const refs = artifactRefs(input, candidateRoot);
      if (!refs.length) {
        run = facade.transition({ projectId: input.projectId, runId: input.runId, to: "failed", actor, correlationId,
          idempotencyKey: `agent-x-gauntlet:${input.runId}:empty-candidate` });
        return { run, exitCode: 1, sessionId, finalGateRan: false };
      }
      for (const ref of refs) { verifyArtifactRef(ref, candidateRoot); saveArtifactRef(input.kernel, ref); }
      controller.addCandidate({ candidateId: "can_1", revision: 1, revisionId: `crv_${input.runId}_1`,
        artifactRefs: refs.map(ref => ref.revisionId), producer, causalEvaluationIds: [], createdAt: new Date().toISOString() });
      input.afterCandidatePersisted?.();
      revisions = listCandidateRevisions(input.kernel, input.projectId, input.runId);
    }

    let scorecards = listScorecards(input.kernel, input.projectId, input.runId);
    if (!scorecards.length) {
      const refs = filesUnder(candidateRoot).length ? artifactRefs(input, candidateRoot) : [];
      scorecards = input.evaluator.evaluate({ projectId: input.projectId, runId: input.runId, candidateRoot, artifactRefs: refs });
    }
    gauntlet = controller.resume().state === "stopped" ? controller.resume() : controller.evaluateRound(scorecards);
    if (gauntlet.decision === "withheld" || gauntlet.stopReason !== "success") {
      run = facade.transition({ projectId: input.projectId, runId: input.runId, to: "verifying", actor, correlationId,
        idempotencyKey: `agent-x-gauntlet:${input.runId}:verifying` });
      run = facade.transition({ projectId: input.projectId, runId: input.runId, to: "withheld", actor, correlationId,
        idempotencyKey: `agent-x-gauntlet:${input.runId}:withheld`, payload: { reason: gauntlet.stopReason } });
      return { run, exitCode: 2, sessionId, finalGateRan: false };
    }

    publishCandidate(candidateRoot, input.outputsRoot);
    run = getRun(input.kernel, input.projectId, input.runId)!;
    if (run.state === "running") run = facade.transition({ projectId: input.projectId, runId: input.runId, to: "verifying", actor, correlationId,
      idempotencyKey: `agent-x-gauntlet:${input.runId}:verifying` });
    const gate = input.finalGate({ outputsRoot: input.outputsRoot, sessionId });
    run = facade.transition({ projectId: input.projectId, runId: input.runId, to: terminalForGate(gate), actor, correlationId,
      idempotencyKey: `agent-x-gauntlet:${input.runId}:terminal`, payload: { exitCode: gate.exitCode, gateOutcome: gate.gateOutcome } });
    return { run, exitCode: gate.exitCode, sessionId, finalGateRan: true };
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
