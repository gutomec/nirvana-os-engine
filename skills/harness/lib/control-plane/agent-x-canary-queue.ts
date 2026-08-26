import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { runAgentXGauntlet, type AgentXCandidateResult, type AgentXGauntletEvaluator } from "../gauntlet/agent-x-cutover.ts";
import {
  TERMINAL_RUN_STATES, appendEvent, createRun, getRun, listEvents, listRuns, transitionRun,
  type CanonicalRunState, type KernelHandle, type RunProjection, type TargetRef,
} from "../run-kernel/index.ts";
import type { ConversationService, Message } from "./conversation-service.ts";
import { glanceRunDir, signalProcessGroup, type GlanceExecutionRunner, type StartedExecution } from "./execution-runner.ts";

export interface GlanceAgentXCanaryAdapter {
  available(): boolean;
  execute(input: { brief: string; candidateRoot: string; signal: AbortSignal }): AgentXCandidateResult;
  evaluator: AgentXGauntletEvaluator;
  finalGate(input: { outputsRoot: string; sessionId: string | null }): { exitCode: 0 | 1 | 2 | 3; gateOutcome: string };
}

export type CanaryCapability = "agent-x.gauntlet.light" | "business.dispatch" | "squad.dispatch";
export interface CanaryReceipt { run: RunProjection; message: Message; queued: boolean; capability: CanaryCapability }

export interface CanaryRecoveryResult {
  enqueued: string[];
  reattached: string[];
  redispatched: string[];
  skipped: Array<{ runId: string; reason: string }>;
}

const CANARY_POLICY = "gauntlet-light-canary";
const ACTOR = { kind: "control-plane", id: "glance" };
// States a child process can leave a Run in while it works; each one accepts `failed`.
const EXECUTING_STATES: ReadonlySet<CanonicalRunState> = new Set(["running", "waiting", "verifying", "revising"]);
const CANCELLABLE_STATES: ReadonlySet<CanonicalRunState> = new Set(["running", "waiting", "revising"]);
const REATTACH_POLL_MS = 200;

/** Explicit target at the head of a Message: `use business <slug>:` or `use squad <slug>:`
 * (keyword case-insensitive, slug `[a-z0-9-]+`). Any other text is the agent-x canary. */
export function parseMessageTarget(content: string): TargetRef {
  const match = content.match(/^\s*use\s+(business|squad)\s+([a-z0-9-]+)\s*:/i);
  if (!match) return { kind: "agent-x", slug: "agent-x" };
  const slug = match[2].toLowerCase();
  return match[1].toLowerCase() === "business" ? { kind: "business", slug } : { kind: "squad", slug, capabilityId: "squad.execute" };
}

export function canaryCapabilityFor(target: TargetRef): CanaryCapability {
  return target.kind === "agent-x" ? "agent-x.gauntlet.light" : `${target.kind}.dispatch`;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

// start: a prepared Run waiting for its first child. redispatch: a Run left mid-flight by a
// child that died; a new child adopts it. reattach: a Run whose child from a previous server
// process is still alive; polled until it exits, never spawned again.
type QueueMode = "start" | "redispatch" | "reattach";
interface QueueItem {
  projectId: string; runId: string; traceId: string; brief: string; projectRoot: string; target: TargetRef;
  controller: AbortController; mode: QueueMode; attempt: number; pid: number | null; child: StartedExecution | null; cancelRequested: boolean;
}

export class AgentXCanaryQueue {
  private readonly pending: QueueItem[] = [];
  private active: QueueItem | null = null;
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  constructor(private readonly kernel: KernelHandle, private readonly conversations: ConversationService,
    private readonly adapter?: GlanceAgentXCanaryAdapter, private readonly runner?: GlanceExecutionRunner) {}

  submit(input: { projectId: string; conversationId: string; messageId: string; brief: string; projectRoot: string; idempotencyKey: string }): CanaryReceipt {
    const runId = `run_${createHash("sha256").update(`${input.projectId}:${input.idempotencyKey}`).digest("hex").slice(0, 24)}`;
    const traceId = runId;
    const target = parseMessageTarget(input.brief);
    const capability = canaryCapabilityFor(target);
    let run = createRun(this.kernel, { projectId: input.projectId, runId, traceId, conversationId: input.conversationId,
      planId: `plan_${runId}`, target, policySnapshotRef: CANARY_POLICY,
      actor: ACTOR, correlationId: `cor_${runId}`, idempotencyKey: `glance-canary:${input.idempotencyKey}` });
    const message = this.conversations.linkRun(input.messageId, input.projectId, runId);
    if (run.state !== "prepared" || this.active?.runId === runId || this.pending.some(item => item.runId === runId)) {
      return { run, message, queued: run.state === "prepared", capability };
    }
    if (!this.executionAvailable()) {
      run = transitionRun(this.kernel, { projectId: input.projectId, runId, to: "rolled_back", actor: ACTOR,
        correlationId: `cor_${runId}`, idempotencyKey: `glance-canary:${runId}:capability-missing`, payload: { reason: "capability_unavailable", capability } });
      return { run, message, queued: false, capability };
    }
    this.pending.push(this.item({ projectId: input.projectId, runId, traceId, brief: input.brief, projectRoot: input.projectRoot, target, mode: "start" }));
    this.schedule();
    return { run, message, queued: true, capability };
  }

  recover(projectId: string, projectRoot: string): CanaryRecoveryResult {
    const result: CanaryRecoveryResult = { enqueued: [], reattached: [], redispatched: [], skipped: [] };
    for (const run of listRuns(this.kernel, projectId)) {
      if (run.policySnapshotRef !== CANARY_POLICY) {
        result.skipped.push({ runId: run.runId, reason: "not_canary" });
        continue;
      }
      if (this.active?.runId === run.runId || this.pending.some(item => item.runId === run.runId)) continue;
      if (run.state !== "prepared") {
        const recovered = this.runner ? this.recoverChild(run, projectRoot) : null;
        if (recovered === "reattach") { result.reattached.push(run.runId); continue; }
        if (recovered === "redispatch") { result.redispatched.push(run.runId); continue; }
        this.skipRecovery(result, run, `state_${run.state}`);
        continue;
      }
      const message = this.conversations.messageForRun(projectId, run.runId);
      if (!message || message.conversation_id !== run.conversationId) {
        this.skipRecovery(result, run, "message_link_missing");
        continue;
      }
      if (!this.executionAvailable()) {
        this.skipRecovery(result, run, "capability_unavailable");
        continue;
      }
      this.recoveryEvent(run, "canary.recovery_enqueued", { reason: "restart_prepared_run" });
      this.pending.push(this.item({ projectId, runId: run.runId, traceId: run.traceId, brief: message.content, projectRoot, target: run.target, mode: "start" }));
      result.enqueued.push(run.runId);
    }
    if (this.pending.length) this.schedule();
    return result;
  }

  /** One Run may be skipped for a different reason on each restart (`capability_unavailable`, then
   * `state_completed`), so the reason is part of the event identity: the same reason twice is one
   * event, a new reason is a new event, never an identity conflict inside `recover()`. */
  private skipRecovery(result: CanaryRecoveryResult, run: RunProjection, reason: string): void {
    this.recoveryEvent(run, "canary.recovery_skipped", { reason }, `:${reason}`);
    result.skipped.push({ runId: run.runId, reason });
  }

  /** Stops scheduling and detaches from any child still running: a stopped queue never
   * touches the kernel again, so a restarted server can recover the Run on its own. */
  shutdown(): void {
    this.stopped = true;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
  }

  cancel(projectId: string, runId: string): { accepted: boolean; state: string } {
    const index = this.pending.findIndex(item => item.projectId === projectId && item.runId === runId);
    if (index >= 0) {
      const item = this.pending[index];
      if (item.mode === "start") {
        this.pending.splice(index, 1); item.controller.abort();
        const run = transitionRun(this.kernel, { projectId, runId, to: "rolled_back", actor: ACTOR, correlationId: `cor_${runId}`,
          idempotencyKey: `glance-canary:${runId}:cancelled-queued`, payload: { reason: "cancelled_before_execution" } });
        return { accepted: true, state: run.state };
      }
      // A recovered item: the child from the previous server is killed when still alive; a dead
      // one has nothing to wait for, so the Run settles now instead of being redispatched.
      this.requestCancel(item);
      if (item.mode === "redispatch") { this.pending.splice(index, 1); this.settleCancelled(item); }
      return { accepted: true, state: getRun(this.kernel, projectId, runId)?.state || "unknown" };
    }
    if (this.active?.projectId === projectId && this.active.runId === runId) {
      if (this.runner) this.requestCancel(this.active);
      else this.active.controller.abort();
      return { accepted: true, state: getRun(this.kernel, projectId, runId)?.state || "unknown" };
    }
    return { accepted: false, state: getRun(this.kernel, projectId, runId)?.state || "not_found" };
  }

  private executionAvailable(): boolean {
    return this.runner ? this.runner.available() : !!this.adapter?.available();
  }

  private item(fields: Pick<QueueItem, "projectId" | "runId" | "traceId" | "brief" | "projectRoot" | "target" | "mode"> & Partial<QueueItem>): QueueItem {
    return { controller: new AbortController(), attempt: 0, pid: null, child: null, cancelRequested: false, ...fields };
  }

  private async drain(): Promise<void> {
    this.scheduled = null;
    if (this.active || this.stopped || (!this.runner && !this.adapter)) return;
    const item = this.pending.shift();
    if (!item) return;
    const run = getRun(this.kernel, item.projectId, item.runId);
    if (!run || (item.mode === "start" ? run.state !== "prepared" : TERMINAL_RUN_STATES.has(run.state))) {
      this.schedule();
      return;
    }
    this.active = item;
    try {
      if (this.runner) await (item.mode === "reattach" ? this.reattach(item) : this.runChild(item));
      else this.runInProcess(item);
    } catch { /* the kernel already holds an honest terminal state */ }
    finally { this.active = null; this.schedule(); }
  }

  private runInProcess(item: QueueItem): void {
    const outputsRoot = path.join(item.projectRoot, ".nirvana", "outputs", item.runId);
    fs.mkdirSync(outputsRoot, { recursive: true });
    runAgentXGauntlet({ kernel: this.kernel, projectId: item.projectId, runId: item.runId, traceId: item.traceId,
      brief: item.brief, projectRoot: item.projectRoot, outputsRoot, expectedCostUsd: 5,
      executeCandidate: candidateRoot => item.controller.signal.aborted
        ? { ok: false, sessionId: null, error: "cancelled" }
        : this.adapter!.execute({ brief: item.brief, candidateRoot, signal: item.controller.signal }),
      evaluator: this.adapter!.evaluator, finalGate: this.adapter!.finalGate });
  }

  private async runChild(item: QueueItem): Promise<void> {
    if (item.cancelRequested) { this.settleCancelled(item); return; }
    const runDir = glanceRunDir(item.projectRoot, item.runId);
    fs.mkdirSync(runDir, { recursive: true });
    const briefFile = path.join(runDir, "brief.md");
    fs.writeFileSync(briefFile, item.brief, "utf8");
    item.attempt = this.childAttempts(item) + 1;
    const child = this.runner!.start({ projectRoot: item.projectRoot, projectId: item.projectId, runId: item.runId, briefFile, target: item.target, intensity: "light" });
    item.child = child; item.pid = child.pid;
    const argv = [path.basename(child.argv[1] ?? ""), ...child.argv.slice(2).map(part => part.startsWith(item.projectRoot) ? path.relative(item.projectRoot, part) : part)];
    this.childEvent(item, "glance.child_started", { pid: child.pid, attempt: item.attempt, argv });
    const { exitCode } = await child.done;
    item.child = null;
    if (this.stopped) return;
    this.childEvent(item, "glance.child_exited", { pid: child.pid, attempt: item.attempt, exitCode });
    this.settleAfterExit(item, exitCode);
  }

  private async reattach(item: QueueItem): Promise<void> {
    while (!this.stopped) {
      const run = getRun(this.kernel, item.projectId, item.runId);
      const alive = item.pid !== null && pidAlive(item.pid);
      if (!alive || (run && TERMINAL_RUN_STATES.has(run.state))) {
        this.childEvent(item, "glance.child_exited", { pid: item.pid, attempt: item.attempt, exitCode: null, reattached: true });
        this.settleAfterExit(item, null);
        return;
      }
      await Bun.sleep(REATTACH_POLL_MS);
    }
  }

  /** A Run left mid-flight by a child of a previous server process. Alive pid: reattach and
   * wait; dead pid: a new child adopts the same runId (the cutover resumes without repeating
   * side effects); no child event at all: not recoverable here. */
  private recoverChild(run: RunProjection, projectRoot: string): QueueMode | null {
    if (!EXECUTING_STATES.has(run.state) && run.state !== "cancelling") return null;
    const started = this.lastChildStart(run);
    if (!started) return null;
    const message = this.conversations.messageForRun(run.projectId, run.runId);
    const base = { projectId: run.projectId, runId: run.runId, traceId: run.traceId, brief: message?.content ?? "", projectRoot,
      target: run.target, attempt: started.attempt, pid: started.pid, cancelRequested: run.state === "cancelling" };
    if (pidAlive(started.pid)) {
      this.recoveryEvent(run, "canary.recovery_reattached", { pid: started.pid, attempt: started.attempt }, `:${started.attempt}`);
      this.pending.push(this.item({ ...base, mode: "reattach" }));
      return "reattach";
    }
    if (run.state === "cancelling") {
      this.settleCancelled(this.item({ ...base, mode: "redispatch" }));
      return null;
    }
    if (!message) return null;
    this.recoveryEvent(run, "canary.recovery_redispatched", { pid: started.pid, attempt: started.attempt, reason: "child_pid_dead" }, `:${started.attempt}`);
    this.pending.push(this.item({ ...base, mode: "redispatch" }));
    return "redispatch";
  }

  private runEvents(item: Pick<QueueItem, "projectId" | "runId">) {
    return listEvents(this.kernel, item.projectId).filter(event => event.runId === item.runId);
  }

  private childAttempts(item: Pick<QueueItem, "projectId" | "runId">): number {
    return this.runEvents(item).filter(event => event.type === "glance.child_started").length;
  }

  /** The last child started for the Run whose exit this queue never observed. */
  private lastChildStart(run: RunProjection): { pid: number; attempt: number } | null {
    let started: { pid: number; attempt: number } | null = null;
    for (const event of this.runEvents(run)) {
      const payload = event.payload as { pid?: number; attempt?: number };
      if (event.type === "glance.child_started" && typeof payload.pid === "number") started = { pid: payload.pid, attempt: Number(payload.attempt) || 1 };
      else if (event.type === "glance.child_exited" && started && payload.attempt === started.attempt) started = null;
    }
    return started;
  }

  private requestCancel(item: QueueItem): void {
    item.cancelRequested = true; item.controller.abort();
    if (item.child) {
      item.child.kill();
      this.childEvent(item, "glance.child_killed", { pid: item.pid, attempt: item.attempt, signal: "SIGTERM" });
    } else if (item.pid !== null && pidAlive(item.pid)) {
      // A child from a previous server process leads its own group as well (see execution-runner.ts).
      signalProcessGroup(item.pid);
      this.childEvent(item, "glance.child_killed", { pid: item.pid, attempt: item.attempt, signal: "SIGTERM" });
    }
    const run = getRun(this.kernel, item.projectId, item.runId);
    if (run && CANCELLABLE_STATES.has(run.state)) this.transition(item, "cancelling", "cancelling", { reason: "cancelled_by_user" });
  }

  private settleAfterExit(item: QueueItem, exitCode: number | null): void {
    const run = getRun(this.kernel, item.projectId, item.runId);
    if (!run || TERMINAL_RUN_STATES.has(run.state)) return;
    if (item.cancelRequested) { this.settleCancelled(item); return; }
    const payload = { reason: "child_exited_without_terminal_state", exitCode, pid: item.pid, attempt: item.attempt };
    this.transition(item, run.state === "prepared" ? "rolled_back" : "failed", `${item.attempt}:exit-without-terminal`, payload);
  }

  private settleCancelled(item: QueueItem): void {
    let run = getRun(this.kernel, item.projectId, item.runId);
    if (!run || TERMINAL_RUN_STATES.has(run.state)) return;
    if (run.state === "prepared") { this.transition(item, "rolled_back", "cancelled-queued", { reason: "cancelled_before_execution" }); return; }
    if (CANCELLABLE_STATES.has(run.state)) run = this.transition(item, "cancelling", "cancelling", { reason: "cancelled_by_user" });
    if (run.state === "cancelling") this.transition(item, "cancelled", "cancelled", { reason: "cancelled_by_user" });
    else if (run.state === "verifying") this.transition(item, "failed", "cancelled-while-verifying", { reason: "cancelled_by_user" });
  }

  private transition(item: Pick<QueueItem, "projectId" | "runId">, to: CanonicalRunState, key: string, payload: Record<string, unknown>): RunProjection {
    return transitionRun(this.kernel, { projectId: item.projectId, runId: item.runId, to, actor: ACTOR, correlationId: `cor_${item.runId}`,
      idempotencyKey: `glance-canary:${item.runId}:${key}`, payload });
  }

  private childEvent(item: QueueItem, type: string, payload: Record<string, unknown>): void {
    appendEvent(this.kernel, { projectId: item.projectId, runId: item.runId, traceId: item.traceId, type, actor: ACTOR,
      correlationId: `cor_${item.runId}`, idempotencyKey: `${type}:${item.runId}:${item.attempt}`, payload });
  }

  private schedule(): void {
    if (this.scheduled || this.active || this.stopped || !this.pending.length) return;
    this.scheduled = setTimeout(() => void this.drain(), 10);
  }

  private recoveryEvent(run: RunProjection, type: string, payload: Record<string, unknown>, keySuffix = ""): void {
    appendEvent(this.kernel, { projectId: run.projectId, runId: run.runId, traceId: run.traceId, type,
      actor: { kind: "control-plane", id: "glance-recovery" }, correlationId: `cor_${run.runId}`,
      idempotencyKey: `${type}:${run.runId}${keySuffix}`, payload });
  }
}
