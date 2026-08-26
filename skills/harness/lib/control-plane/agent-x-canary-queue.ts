import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { resolveSetting } from "../../../_shared/lib/settings.ts";
import type { AgenticRouteDecision } from "../agentic-router.ts";
import { resolveDispatchPlan, type DispatchPlan } from "../dispatch-cascade.ts";
import { runAgentXGauntlet, type AgentXCandidateResult, type AgentXGauntletEvaluator } from "../gauntlet/agent-x-cutover.ts";
import {
  TERMINAL_RUN_STATES, appendEvent, createRun, getRun, listEvents, listRuns, transitionRun,
  type CanonicalRunState, type KernelHandle, type RunProjection, type RunRoute, type TargetRef,
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
 * (keyword case-insensitive, slug `[a-z0-9-]+`). Any other text names no target: agent-x here,
 * and `resolveMessageTarget` then asks the router before the Run is prepared. */
export function parseMessageTarget(content: string): TargetRef {
  const match = content.match(/^\s*use\s+(business|squad)\s+([a-z0-9-]+)\s*:/i);
  if (!match) return AGENT_X_TARGET;
  const slug = match[2].toLowerCase();
  return match[1].toLowerCase() === "business" ? { kind: "business", slug } : { kind: "squad", slug, capabilityId: "squad.execute" };
}

export function canaryCapabilityFor(target: TargetRef): CanaryCapability {
  return target.kind === "agent-x" ? "agent-x.gauntlet.light" : `${target.kind}.dispatch`;
}

// ── Message target: the maestro's cascade (explicit → business → squad → agent-x) from a Message ──

export interface MessageRouteInput { brief: string; projectId: string; projectRoot: string; traceId: string }
/** The agentic router as the queue sees it: `agenticRoute` composed by the server
 * (`createAgenticMessageRouter`), a fake in tests. Nothing else ranks a Message. */
export interface MessageRouter { route(input: MessageRouteInput): Promise<AgenticRouteDecision> }
export interface MessageRoutingSettings { mode: "agentic" | "fast"; onRouterFailure: "cascade" | "fail" }
export type MessageRouteAudit = (event: string, payload: Record<string, unknown>) => void;
export interface MessageRoutingOptions {
  router?: MessageRouter;
  /** Ceiling of one routing call; default MESSAGE_ROUTE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Audit sink; default lib/audit.js with the Message's trace and project. */
  audit?: MessageRouteAudit;
  /** `routing.mode` and `routing.on_router_failure` for a project; default resolveSetting. */
  settingsFor?: (projectRoot: string) => MessageRoutingSettings;
}
export interface MessageRoutingDeps extends Omit<MessageRoutingOptions, "settingsFor"> {
  settings: MessageRoutingSettings;
  projectId: string;
  projectRoot: string;
  traceId: string;
  messageId?: string;
}
export interface MessageTargetResolution {
  target: TargetRef;
  route: RunRoute;
  /** `routing.on_router_failure=fail` and the router failed: the Run is prepared and rolled back, never executed. */
  refused?: "router_failed";
}

/** Ceiling of one routing call from a Message. No settings key configures the router's timeout
 * yet; the dispatch waits five minutes, the Glance answers a chat and waits two. */
export const MESSAGE_ROUTE_TIMEOUT_MS = 120_000;
const AGENT_X_TARGET: TargetRef = { kind: "agent-x", slug: "agent-x" };

export function routingSettingsFor(projectRoot: string): MessageRoutingSettings {
  return { mode: resolveSetting("routing.mode", { projectRoot }).value, onRouterFailure: resolveSetting("routing.on_router_failure", { projectRoot }).value };
}

function defaultRouteAudit(deps: Pick<MessageRoutingDeps, "projectId" | "projectRoot" | "traceId">): MessageRouteAudit {
  const audit = createRequire(import.meta.url)("../audit.js") as { emit(event: string, payload: Record<string, unknown>, ctx: Record<string, unknown>): void };
  return (event, payload) => {
    try { audit.emit(event, { ...payload, actor: "glance" }, { cwd: deps.projectRoot, project_id: deps.projectId, trace_id: deps.traceId }); }
    catch { /* the audit never blocks a Message */ }
  };
}

async function routeWithin(router: MessageRouter, input: MessageRouteInput, timeoutMs: number): Promise<{ decision?: AgenticRouteDecision; error?: string; durationMs: number }> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`router timed out after ${timeoutMs} ms`)), timeoutMs); });
  try { return { decision: await Promise.race([Promise.resolve().then(() => router.route(input)), timeout]), durationMs: Date.now() - started }; }
  catch (error) { return { error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started }; }
  finally { clearTimeout(timer); }
}

/** The target of a Message, by the same cascade the maestro applies: an explicit prefix wins;
 * otherwise the router decides (business, then exactly one squad) through `resolveDispatchPlan`,
 * the mapping the dispatch uses; agent-x is the bottom (no_match, several squads, router failure,
 * timeout, `routing.mode=fast`, no router). Every resolution is one `auto_route_selected` with the
 * Message's trace; a router that throws or times out is one `agentic_route_failed` as well. */
export async function resolveMessageTarget(content: string, deps: MessageRoutingDeps): Promise<MessageTargetResolution> {
  const audit = deps.audit ?? defaultRouteAudit(deps);
  const record = (resolution: MessageTargetResolution, plan?: DispatchPlan, decision?: AgenticRouteDecision): MessageTargetResolution => {
    audit("auto_route_selected", {
      trace_id: deps.traceId, message_id: deps.messageId ?? null, method: resolution.route.source === "explicit" ? "explicit" : "agentic",
      source: resolution.route.source, ...(plan ? { plan_source: plan.source } : {}),
      target_kind: resolution.target.kind, target_slug: resolution.target.slug,
      business_slug: resolution.target.kind === "business" ? resolution.target.slug : null,
      ...(resolution.target.kind === "squad" ? { squad_slug: resolution.target.slug } : {}),
      rationale: resolution.route.rationale,
      ...(decision ? { decision_kind: decision.kind, cost_usd: decision.cost_usd, duration_ms: decision.duration_ms } : {}),
      ...(resolution.refused ? { refused: resolution.refused } : {}),
    });
    return resolution;
  };
  const fallback = (rationale: string): MessageTargetResolution => ({ target: AGENT_X_TARGET, route: { source: "fallback", rationale } });

  const explicit = parseMessageTarget(content);
  if (explicit.kind !== "agent-x") return record({ target: explicit, route: { source: "explicit", rationale: `the Message names ${explicit.kind} ${explicit.slug}` } });
  if (deps.settings.mode === "fast") return record(fallback("routing.mode=fast: the Glance composes only the agentic router, so the Message stays on agent-x"));
  if (!deps.router) return record(fallback("no router configured on this server; the Message stays on agent-x"));

  const timeoutMs = deps.timeoutMs ?? MESSAGE_ROUTE_TIMEOUT_MS;
  const outcome = await routeWithin(deps.router, { brief: content, projectId: deps.projectId, projectRoot: deps.projectRoot, traceId: deps.traceId }, timeoutMs);
  // A transport failure the router returned is already its own `agentic_route_failed`; a throw or a timeout is not.
  if (!outcome.decision) audit("agentic_route_failed", { trace_id: deps.traceId, message_id: deps.messageId ?? null, error: outcome.error, duration_ms: outcome.durationMs });
  if (!outcome.decision || !outcome.decision.ok) {
    const error = outcome.error ?? outcome.decision?.error ?? "router run failed";
    if (deps.settings.onRouterFailure === "fail") return record({ ...fallback(`router failed (${error}); routing.on_router_failure=fail refuses the Run`), refused: "router_failed" }, undefined, outcome.decision);
    return record(fallback(`router failed (${error}); routing.on_router_failure=cascade keeps the Message on agent-x`), undefined, outcome.decision);
  }

  const decision = outcome.decision;
  const plan = await resolveDispatchPlan(decision, { isTTY: false, audit: (event, payload) => audit(event, { ...payload, trace_id: deps.traceId, message_id: deps.messageId ?? null }) });
  const step = plan.steps[0];
  const squads = plan.steps.filter(item => item.kind === "squad").map(item => item.slug!);
  if (step?.kind === "business" && step.slug) return record({ target: { kind: "business", slug: step.slug }, route: { source: "router", rationale: step.reason } }, plan, decision);
  if (step?.kind === "squad" && squads.length === 1) return record({ target: { kind: "squad", slug: squads[0], capabilityId: "squad.execute" }, route: { source: "router", rationale: step.reason } }, plan, decision);
  if (step?.kind === "squad") return record(fallback(`the router named ${squads.length} squads (${squads.join(", ")}); one Glance Run executes one target, so the Message stays on agent-x`), plan, decision);
  return record(fallback(step?.reason ?? plan.error ?? "the router named no dispatchable target"), plan, decision);
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
  private readonly resolving = new Map<string, Promise<CanaryReceipt>>();
  private active: QueueItem | null = null;
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  constructor(private readonly kernel: KernelHandle, private readonly conversations: ConversationService,
    private readonly adapter?: GlanceAgentXCanaryAdapter, private readonly runner?: GlanceExecutionRunner,
    private readonly routing: MessageRoutingOptions = {}) {}

  /** Routes the Message (unless a Run for this key exists), prepares the Run and queues it. The same
   * Message submitted twice while its routing is in flight shares one resolution and one Run. */
  submit(input: { projectId: string; conversationId: string; messageId: string; brief: string; projectRoot: string; idempotencyKey: string }): Promise<CanaryReceipt> {
    const runId = `run_${createHash("sha256").update(`${input.projectId}:${input.idempotencyKey}`).digest("hex").slice(0, 24)}`;
    const inflight = this.resolving.get(runId);
    if (inflight) return inflight;
    const receipt = this.prepare(input, runId).finally(() => this.resolving.delete(runId));
    this.resolving.set(runId, receipt);
    return receipt;
  }

  private async prepare(input: { projectId: string; conversationId: string; messageId: string; brief: string; projectRoot: string; idempotencyKey: string }, runId: string): Promise<CanaryReceipt> {
    const traceId = runId;
    // A Run already prepared for this key keeps its target: one Message is routed once.
    const existing = getRun(this.kernel, input.projectId, runId);
    const resolution = existing ? null : await resolveMessageTarget(input.brief, {
      router: this.routing.router, timeoutMs: this.routing.timeoutMs, audit: this.routing.audit,
      settings: (this.routing.settingsFor ?? routingSettingsFor)(input.projectRoot),
      projectId: input.projectId, projectRoot: input.projectRoot, traceId, messageId: input.messageId });
    const target = existing?.target ?? resolution!.target;
    const capability = canaryCapabilityFor(target);
    let run = createRun(this.kernel, { projectId: input.projectId, runId, traceId, conversationId: input.conversationId,
      planId: `plan_${runId}`, target, route: existing?.route ?? resolution?.route, policySnapshotRef: CANARY_POLICY,
      actor: ACTOR, correlationId: `cor_${runId}`, idempotencyKey: `glance-canary:${input.idempotencyKey}` });
    const message = this.conversations.linkRun(input.messageId, input.projectId, runId);
    if (run.state !== "prepared" || this.active?.runId === runId || this.pending.some(item => item.runId === runId)) {
      return { run, message, queued: run.state === "prepared", capability };
    }
    if (resolution?.refused) {
      run = transitionRun(this.kernel, { projectId: input.projectId, runId, to: "rolled_back", actor: ACTOR,
        correlationId: `cor_${runId}`, idempotencyKey: `glance-canary:${runId}:router-failed`, payload: { reason: resolution.refused } });
      return { run, message, queued: false, capability };
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
