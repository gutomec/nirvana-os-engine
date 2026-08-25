import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { runAgentXGauntlet, type AgentXCandidateResult, type AgentXGauntletEvaluator } from "../gauntlet/agent-x-cutover.ts";
import { createRun, getRun, transitionRun, type KernelHandle, type RunProjection } from "../run-kernel/index.ts";
import type { ConversationService, Message } from "./conversation-service.ts";

export interface GlanceAgentXCanaryAdapter {
  available(): boolean;
  execute(input: { brief: string; candidateRoot: string; signal: AbortSignal }): AgentXCandidateResult;
  evaluator: AgentXGauntletEvaluator;
  finalGate(input: { outputsRoot: string; sessionId: string | null }): { exitCode: 0 | 1 | 2 | 3; gateOutcome: string };
}

export interface CanaryReceipt { run: RunProjection; message: Message; queued: boolean; capability: "agent-x.gauntlet.light" }

interface QueueItem { projectId: string; runId: string; traceId: string; brief: string; projectRoot: string; controller: AbortController }

export class AgentXCanaryQueue {
  private readonly pending: QueueItem[] = [];
  private active: QueueItem | null = null;
  constructor(private readonly kernel: KernelHandle, private readonly conversations: ConversationService, private readonly adapter?: GlanceAgentXCanaryAdapter) {}

  submit(input: { projectId: string; conversationId: string; messageId: string; brief: string; projectRoot: string; idempotencyKey: string }): CanaryReceipt {
    const runId = `run_${createHash("sha256").update(`${input.projectId}:${input.idempotencyKey}`).digest("hex").slice(0, 24)}`;
    const traceId = runId;
    let run = createRun(this.kernel, { projectId: input.projectId, runId, traceId, conversationId: input.conversationId,
      planId: `plan_${runId}`, target: { kind: "agent-x", slug: "agent-x" }, policySnapshotRef: "gauntlet-light-canary",
      actor: { kind: "control-plane", id: "glance" }, correlationId: `cor_${runId}`, idempotencyKey: `glance-canary:${input.idempotencyKey}` });
    const message = this.conversations.linkRun(input.messageId, input.projectId, runId);
    if (run.state !== "prepared" || this.active?.runId === runId || this.pending.some(item => item.runId === runId)) {
      return { run, message, queued: run.state === "prepared", capability: "agent-x.gauntlet.light" };
    }
    if (!this.adapter?.available()) {
      run = transitionRun(this.kernel, { projectId: input.projectId, runId, to: "rolled_back", actor: { kind: "control-plane", id: "glance" },
        correlationId: `cor_${runId}`, idempotencyKey: `glance-canary:${runId}:capability-missing`, payload: { reason: "capability_unavailable", capability: "agent-x.gauntlet.light" } });
      return { run, message, queued: false, capability: "agent-x.gauntlet.light" };
    }
    this.pending.push({ projectId: input.projectId, runId, traceId, brief: input.brief, projectRoot: input.projectRoot, controller: new AbortController() });
    setTimeout(() => void this.drain(), 10);
    return { run, message, queued: true, capability: "agent-x.gauntlet.light" };
  }

  cancel(projectId: string, runId: string): { accepted: boolean; state: string } {
    const index = this.pending.findIndex(item => item.projectId === projectId && item.runId === runId);
    if (index >= 0) {
      const [item] = this.pending.splice(index, 1); item.controller.abort();
      const run = transitionRun(this.kernel, { projectId, runId, to: "rolled_back", actor: { kind: "control-plane", id: "glance" }, correlationId: `cor_${runId}`,
        idempotencyKey: `glance-canary:${runId}:cancelled-queued`, payload: { reason: "cancelled_before_execution" } });
      return { accepted: true, state: run.state };
    }
    if (this.active?.projectId === projectId && this.active.runId === runId) {
      this.active.controller.abort();
      return { accepted: true, state: getRun(this.kernel, projectId, runId)?.state || "unknown" };
    }
    return { accepted: false, state: getRun(this.kernel, projectId, runId)?.state || "not_found" };
  }

  private async drain(): Promise<void> {
    if (this.active || !this.adapter) return;
    const item = this.pending.shift();
    if (!item) return;
    this.active = item;
    const outputsRoot = path.join(item.projectRoot, ".nirvana", "outputs", item.runId);
    fs.mkdirSync(outputsRoot, { recursive: true });
    try {
      runAgentXGauntlet({ kernel: this.kernel, projectId: item.projectId, runId: item.runId, traceId: item.traceId,
        brief: item.brief, projectRoot: item.projectRoot, outputsRoot, expectedCostUsd: 5,
        executeCandidate: candidateRoot => item.controller.signal.aborted
          ? { ok: false, sessionId: null, error: "cancelled" }
          : this.adapter!.execute({ brief: item.brief, candidateRoot, signal: item.controller.signal }),
        evaluator: this.adapter.evaluator, finalGate: this.adapter.finalGate });
    } catch { /* runAgentXGauntlet records an honest terminal state */ }
    finally { this.active = null; setTimeout(() => void this.drain(), 10); }
  }
}
