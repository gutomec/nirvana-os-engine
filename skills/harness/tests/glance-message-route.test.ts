// glance-message-route.test.ts — a Glance Message resolves its target through the
// same cascade as the maestro: an explicit prefix wins, then the agentic router
// (business, then squad), then agent-x as the bottom. The receipt never waits for
// the router: a Message without a prefix is routed by the queue, as the first step
// of its item, and a `no_match` answers the chat instead of running agent-x. The
// router is injected, so nothing here calls an LLM or the network.
// Runs with: bun test skills/harness/tests
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgenticRouteDecision } from "../lib/agentic-router.ts";
import {
  AgentXCanaryQueue, ConversationService, MESSAGE_ROUTE_TIMEOUT_MS, createAgenticMessageRouter, createDispatchExecutionRunner,
  parseMessageTarget, parseMessageTargetSpec, resolveMessageTarget,
  type ExecutionStartInput, type GlanceExecutionRunner, type MessageCapabilityResolver, type MessageRouteInput, type MessageRouter, type MessageRoutingSettings,
} from "../lib/control-plane/index.ts";
import { getRun, listEvents, openKernel, type RunProjection } from "../lib/run-kernel/index.ts";
import { childState, shimRuntimeOnPath, waitUntil, writeFakeGlanceChild } from "./helpers/fake-glance-child.ts";
import { removeDir } from "./helpers/temp-dirs.ts";
import { KERNEL_BUDGET_MS } from "./helpers/test-budgets.ts";

const roots: string[] = [];
const queues: AgentXCanaryQueue[] = [];
const closers: Array<() => void> = [];
const servers: any[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  while (queues.length) queues.pop()!.shutdown();
  while (servers.length) { try { servers.pop().close(); } catch {} }
  while (closers.length) closers.pop()!();
  while (restores.length) restores.pop()!();
  delete process.env.NIRVANA_PROJECT_ROOT;
  while (roots.length) removeDir(roots.pop()!);
});

const AGENTIC: MessageRoutingSettings = { mode: "agentic", onRouterFailure: "cascade" };
const AGENT_X = { kind: "agent-x", slug: "agent-x" };

function decision(overrides: Partial<AgenticRouteDecision> = {}): AgenticRouteDecision {
  return { ok: true, kind: "decision", primary_business: null, mandatory_squads: [], optional_squads: [], suggested_mind_clones: [],
    candidates: [], rationale: "OBJECT=landing page, THEME=health.", runtime: null, warnings: [], cost_usd: 0.01, duration_ms: 5, ...overrides };
}

/** A router that answers with `answer` (a decision, a thrown error or a promise that never settles) and records its calls. */
function fakeRouter(answer: AgenticRouteDecision | Error | "hang") {
  const calls: MessageRouteInput[] = [];
  const router: MessageRouter = {
    route(input) {
      calls.push(input);
      if (answer === "hang") return new Promise<AgenticRouteDecision>(() => {});
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer);
    },
  };
  return { router, calls };
}

function auditSink() {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  return { events, sink: (event: string, payload: Record<string, unknown>) => { events.push({ event, payload }); },
    named: (event: string) => events.filter(item => item.event === event) };
}

/** The capability resolution seam, pinned: the real resolver reads the installed squads
 *  registry, and these tests must say the same thing on a laptop with 204 squads and on a
 *  CI box with none. It answers what the Message named, else the legacy id — which is what
 *  the queue stamped on every squad Run before the resolver existed. Its own ladder is
 *  proved in capability-resolver.test.ts. */
const CAPABILITY_SEAM: MessageCapabilityResolver = ({ explicit }) => explicit ?? "squad.execute";

function deps(router: MessageRouter | undefined, audit: ReturnType<typeof auditSink>, settings: MessageRoutingSettings = AGENTIC, timeoutMs?: number,
  resolveCapability: MessageCapabilityResolver = CAPABILITY_SEAM) {
  return { router, settings, audit: audit.sink, timeoutMs, resolveCapability, projectId: "prj_route", projectRoot: "/tmp/prj_route", traceId: "run_trace", messageId: "msg_route" };
}

/** A runner whose child exits at once without touching the Run: the queue then rolls the Run
 * back (`child_exited_without_terminal_state`), so a test sees the target the child was given. */
function fakeRunner() {
  const starts: ExecutionStartInput[] = [];
  const runner: GlanceExecutionRunner = {
    available: () => true,
    start(input) { starts.push(input); return { pid: 1, argv: ["bun", "fake-dispatch.ts"], done: Promise.resolve({ exitCode: 0 }), kill() {} }; },
  };
  return { runner, starts };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-glance-route-")); roots.push(root);
  fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
  const kernel = openKernel(path.join(root, ".nirvana", "run-kernel.sqlite"));
  const conversations = new ConversationService(path.join(root, ".nirvana", "control-plane.sqlite"));
  closers.push(() => { kernel.close(); conversations.close(); });
  const conversation = conversations.create("prj_route", "Route", "cnv_route");
  const message = conversations.append({ conversationId: conversation.conversation_id, projectId: "prj_route", role: "user", content: "Produza a landing page da clínica", messageId: "msg_route" });
  const { runner, starts } = fakeRunner();
  const queue = (router: MessageRouter | undefined, audit: ReturnType<typeof auditSink>, settings: MessageRoutingSettings = AGENTIC) => {
    const instance = new AgentXCanaryQueue(kernel, conversations, undefined, runner, { router, audit: audit.sink, resolveCapability: CAPABILITY_SEAM, settingsFor: () => settings });
    queues.push(instance);
    return instance;
  };
  const submit = (instance: AgentXCanaryQueue, content = message.content, idempotencyKey = "route") =>
    instance.submit({ projectId: "prj_route", conversationId: conversation.conversation_id, messageId: message.message_id, brief: content, projectRoot: root, idempotencyKey });
  const run = (runId: string): RunProjection => getRun(kernel, "prj_route", runId)!;
  const events = (runId: string) => listEvents(kernel, "prj_route").filter(event => event.runId === runId);
  const settled = (runId: string) => waitUntil(() => run(runId).state !== "prepared", `run ${runId} to leave prepared`);
  const replies = () => conversations.messages(conversation.conversation_id).filter(item => item.role === "assistant");
  return { root, kernel, message, starts, queue, submit, run, events, settled, replies };
}

describe("resolveMessageTarget", () => {
  test("(a) an explicit prefix wins: the router is never asked and the decision is recorded as explicit", async () => {
    const audit = auditSink();
    const { router, calls } = fakeRouter(decision({ primary_business: "elsewhere" }));
    const business = await resolveMessageTarget("use business web-studio: landing page", deps(router, audit));
    expect(business.target).toEqual({ kind: "business", slug: "web-studio" });
    expect(business.route.source).toBe("explicit");
    expect(business.route.rationale).toContain("web-studio");
    const squad = await resolveMessageTarget("Use Squad brandcraft: manifesto", deps(router, audit));
    expect(squad.target).toEqual({ kind: "squad", slug: "brandcraft", capabilityId: "squad.execute" });
    expect(squad.route.source).toBe("explicit");
    expect(calls).toHaveLength(0);
    expect(audit.named("auto_route_selected")).toHaveLength(2);
    expect(audit.named("auto_route_selected")[0].payload).toMatchObject({ source: "explicit", target_kind: "business", target_slug: "web-studio", trace_id: "run_trace", message_id: "msg_route" });

    // The explicit prefix still resolves at submit time: the receipt carries target and route.
    const fx = fixture();
    const queue = fx.queue(router, auditSink());
    const receipt = await fx.submit(queue, "use business web-studio: landing page", "explicit");
    queue.shutdown();
    expect(receipt.queued).toBe(true);
    expect(receipt.capability).toBe("business.dispatch");
    expect(receipt.run.target).toEqual({ kind: "business", slug: "web-studio" });
    expect(receipt.run.route).toMatchObject({ source: "explicit" });
    expect(calls).toHaveLength(0);
    const prepared = fx.events(receipt.run.runId).find(event => event.type === "run.prepared")!;
    expect(prepared.payload).toMatchObject({ target: { kind: "business", slug: "web-studio" }, route: { source: "explicit" } });
  }, KERNEL_BUDGET_MS);

  test("(b) a decision with primary_business resolves a business Run: the receipt is immediate, the queue routes and starts the business child", async () => {
    const audit = auditSink();
    const { router, calls } = fakeRouter(decision({ primary_business: "web-studio", mandatory_squads: ["landing-lab"] }));
    const resolution = await resolveMessageTarget("Produza a landing page da clínica", deps(router, audit));
    expect(resolution.target).toEqual({ kind: "business", slug: "web-studio" });
    expect(resolution.route).toEqual({ source: "router", rationale: "OBJECT=landing page, THEME=health." });
    expect(calls).toEqual([{ brief: "Produza a landing page da clínica", projectId: "prj_route", projectRoot: "/tmp/prj_route", traceId: "run_trace" }]);
    expect(audit.named("auto_route_selected")[0].payload).toMatchObject({ source: "router", plan_source: "decision-business", target_kind: "business", target_slug: "web-studio",
      decision_kind: "decision", rationale: "OBJECT=landing page, THEME=health.", trace_id: "run_trace", cost_usd: 0.01, duration_ms: 5 });

    const fx = fixture();
    const queue = fx.queue(router, auditSink());
    const receipt = await fx.submit(queue);
    // The receipt never waits for the router: the Run is prepared on the cascade bottom, with no route yet.
    expect(receipt.queued).toBe(true);
    expect(receipt.run.state).toBe("prepared");
    expect(receipt.run.target).toEqual(AGENT_X);
    expect(receipt.run.route).toBeUndefined();
    expect(receipt.capability).toBe("agent-x.gauntlet.light");
    expect(receipt.message.run_id).toBe(receipt.run.runId);
    expect(calls).toHaveLength(1);
    const prepared = fx.events(receipt.run.runId).find(event => event.type === "run.prepared")!;
    expect(prepared.payload).toMatchObject({ target: AGENT_X });
    expect(prepared.payload).not.toHaveProperty("route");
    expect(prepared.traceId).toBe(receipt.run.runId);
    // The queue routes as the first step of the item and re-targets the Run before the child starts.
    await waitUntil(() => fx.starts.length === 1, "the business child to start");
    queue.shutdown();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ brief: "Produza a landing page da clínica", projectId: "prj_route", projectRoot: fx.root, traceId: receipt.run.runId });
    expect(fx.starts[0].target).toEqual({ kind: "business", slug: "web-studio" });
    const run = fx.run(receipt.run.runId);
    expect(run.target).toEqual({ kind: "business", slug: "web-studio" });
    expect(run.route).toEqual({ source: "router", rationale: "OBJECT=landing page, THEME=health." });
    const types = fx.events(receipt.run.runId).map(event => event.type);
    expect(types.slice(0, 3)).toEqual(["run.prepared", "x_run_route_resolved", "glance.child_started"]);
    const resolved = fx.events(receipt.run.runId).find(event => event.type === "x_run_route_resolved")!;
    expect(resolved.payload).toEqual({ target: { kind: "business", slug: "web-studio" }, route: { source: "router", rationale: "OBJECT=landing page, THEME=health." } });
    expect(resolved.traceId).toBe(receipt.run.runId);
    // The stored Run keeps its target: a retry with the same key never routes again.
    const again = fx.queue(fakeRouter(decision({ primary_business: "other" })).router, auditSink());
    const retry = await fx.submit(again);
    again.shutdown();
    expect(retry.run.runId).toBe(receipt.run.runId);
    expect(retry.run.target).toEqual({ kind: "business", slug: "web-studio" });
    expect(retry.capability).toBe("business.dispatch");
  }, KERNEL_BUDGET_MS);

  test("(c) a squad-only decision resolves a squad Run with squad.execute; several mandatory squads fall to agent-x", async () => {
    const audit = auditSink();
    const { router } = fakeRouter(decision({ mandatory_squads: ["brandcraft"], rationale: "OBJECT=branding PDF, THEME=none." }));
    const resolution = await resolveMessageTarget("Produza o PDF da marca", deps(router, audit));
    expect(resolution.target).toEqual({ kind: "squad", slug: "brandcraft", capabilityId: "squad.execute" });
    expect(resolution.route).toEqual({ source: "router", rationale: "OBJECT=branding PDF, THEME=none." });
    expect(audit.named("auto_route_selected")[0].payload).toMatchObject({ source: "router", plan_source: "decision-squads", target_kind: "squad", target_slug: "brandcraft" });

    const fx = fixture();
    const queue = fx.queue(router, auditSink());
    const receipt = await fx.submit(queue, "Produza o PDF da marca", "squad");
    expect(receipt.run.route).toBeUndefined();
    await waitUntil(() => fx.starts.length === 1, "the squad child to start");
    queue.shutdown();
    expect(fx.starts[0].target).toEqual({ kind: "squad", slug: "brandcraft", capabilityId: "squad.execute" });
    const run = fx.run(receipt.run.runId);
    expect(run.target).toEqual({ kind: "squad", slug: "brandcraft", capabilityId: "squad.execute" });
    expect(run.route!.source).toBe("router");

    const several = await resolveMessageTarget("Produza o PDF da marca", deps(fakeRouter(decision({ mandatory_squads: ["brandcraft", "doc-factory"] })).router, auditSink()));
    expect(several.target).toEqual(AGENT_X);
    expect(several.route.source).toBe("fallback");
    expect(several.refused).toBeUndefined();
    expect(several.route.rationale).toContain("brandcraft, doc-factory");
  }, KERNEL_BUDGET_MS);

  test("(d) no_match refuses the Run instead of running agent-x: the resolution names no dispatchable target and carries the router's answer", async () => {
    const audit = auditSink();
    const resolution = await resolveMessageTarget("Quais empresas eu tenho?", deps(fakeRouter(decision({ kind: "no_match", rationale: "OBJECT=unknown. Nothing delivers it." })).router, audit));
    expect(resolution.target).toEqual(AGENT_X);
    expect(resolution.route).toEqual({ source: "fallback", rationale: "router no_match: OBJECT=unknown. Nothing delivers it." });
    expect(resolution.refused).toBe("no_dispatchable_target");
    expect(resolution.answer).toBe("OBJECT=unknown. Nothing delivers it.");
    expect(audit.named("auto_route_selected")[0].payload).toMatchObject({ source: "fallback", plan_source: "no-match", target_kind: "agent-x", decision_kind: "no_match", refused: "no_dispatchable_target" });
  });

  test("(e) a router that throws or hangs falls to agent-x and agentic_route_failed carries the Message's trace", async () => {
    const thrown = auditSink();
    const failed = await resolveMessageTarget("Produza", deps(fakeRouter(new Error("digest exploded")).router, thrown));
    expect(failed.target).toEqual(AGENT_X);
    expect(failed.refused).toBeUndefined();
    expect(failed.route.source).toBe("fallback");
    expect(failed.route.rationale).toContain("digest exploded");
    expect(thrown.events.map(item => item.event)).toEqual(["agentic_route_failed", "auto_route_selected"]);
    expect(thrown.named("agentic_route_failed")[0].payload).toMatchObject({ error: "digest exploded", trace_id: "run_trace" });

    const hung = auditSink();
    const started = Date.now();
    const timedOut = await resolveMessageTarget("Produza", deps(fakeRouter("hang").router, hung, AGENTIC, 20));
    expect(Date.now() - started).toBeLessThan(MESSAGE_ROUTE_TIMEOUT_MS);
    expect(timedOut.target).toEqual(AGENT_X);
    expect(timedOut.route.rationale).toContain("timed out after 20 ms");
    expect(hung.named("agentic_route_failed")[0].payload).toMatchObject({ error: "router timed out after 20 ms", trace_id: "run_trace" });

    // A transport failure the router already recorded itself is not recorded twice.
    const recorded = auditSink();
    const transport = await resolveMessageTarget("Produza", deps(fakeRouter(decision({ ok: false, kind: "no_match", error: "router run failed" })).router, recorded));
    expect(transport.target).toEqual(AGENT_X);
    expect(transport.refused).toBeUndefined();
    expect(transport.route.rationale).toContain("router run failed");
    expect(recorded.events.map(item => item.event)).toEqual(["auto_route_selected"]);
  });

  test("(f) routing.mode=fast skips the router; routing.on_router_failure=fail refuses the Run instead of falling to agent-x", async () => {
    const fast = auditSink();
    const { router, calls } = fakeRouter(decision({ primary_business: "web-studio" }));
    const skipped = await resolveMessageTarget("Produza", deps(router, fast, { mode: "fast", onRouterFailure: "cascade" }));
    expect(skipped.target).toEqual(AGENT_X);
    expect(skipped.route.source).toBe("fallback");
    expect(skipped.route.rationale).toContain("routing.mode=fast");
    expect(calls).toHaveLength(0);
    expect(fast.named("auto_route_selected")[0].payload).toMatchObject({ source: "fallback", target_kind: "agent-x" });

    const none = await resolveMessageTarget("Produza", deps(undefined, auditSink()));
    expect(none.target).toEqual(AGENT_X);
    expect(none.route.rationale).toContain("no router");

    const strict = auditSink();
    const refused = await resolveMessageTarget("Produza", deps(fakeRouter(new Error("digest exploded")).router, strict, { mode: "agentic", onRouterFailure: "fail" }));
    expect(refused.target).toEqual(AGENT_X);
    expect(refused.refused).toBe("router_failed");
    expect(refused.route.rationale).toContain("routing.on_router_failure=fail");

    // The refusal happens in the queue, after the immediate receipt: the Run rolls back without a child and without an answer.
    const fx = fixture();
    const queue = fx.queue(fakeRouter(new Error("digest exploded")).router, auditSink(), { mode: "agentic", onRouterFailure: "fail" });
    const receipt = await fx.submit(queue, "Produza", "refused");
    expect(receipt.queued).toBe(true);
    expect(receipt.run.state).toBe("prepared");
    await fx.settled(receipt.run.runId);
    queue.shutdown();
    const run = fx.run(receipt.run.runId);
    expect(run.state).toBe("rolled_back");
    expect(run.route).toMatchObject({ source: "fallback" });
    expect(fx.starts).toHaveLength(0);
    expect(fx.replies()).toHaveLength(0);
    const transition = fx.events(run.runId).find(event => event.type === "run.transitioned")!;
    expect(transition.payload).toMatchObject({ to: "rolled_back", reason: "router_failed" });
  }, KERNEL_BUDGET_MS);

  test("an ambiguous decision auto-picks the top dispatchable candidate, as the maestro does off a TTY, and audits the pick", async () => {
    const audit = auditSink();
    const ambiguous = decision({ kind: "ambiguous", candidates: [{ target: "brandcraft", type: "squad", reason: "brand object" }, { target: "web-studio", type: "business", reason: "web object" }] });
    const resolution = await resolveMessageTarget("Produza a marca e o site", deps(fakeRouter(ambiguous).router, audit));
    expect(resolution.target).toEqual({ kind: "squad", slug: "brandcraft", capabilityId: "squad.execute" });
    expect(resolution.route.source).toBe("router");
    expect(audit.events.map(item => item.event)).toEqual(["x_route_ambiguous_autopicked", "auto_route_selected"]);
    expect(audit.named("x_route_ambiguous_autopicked")[0].payload).toMatchObject({ picked: "brandcraft", trace_id: "run_trace" });
    expect(audit.named("auto_route_selected")[0].payload).toMatchObject({ plan_source: "ambiguous-autopicked", decision_kind: "ambiguous" });
  });

  test("concurrent submits of the same Message share the Run, and the queue routes it once", async () => {
    const fx = fixture();
    const { router, calls } = fakeRouter(decision({ primary_business: "web-studio" }));
    const queue = fx.queue(router, auditSink());
    const [first, second] = await Promise.all([fx.submit(queue), fx.submit(queue)]);
    expect(second.run.runId).toBe(first.run.runId);
    expect(fx.events(first.run.runId).filter(event => event.type === "run.prepared")).toHaveLength(1);
    await waitUntil(() => fx.starts.length === 1, "the child to start");
    queue.shutdown();
    expect(calls).toHaveLength(1);
    expect(fx.events(first.run.runId).filter(event => event.type === "x_run_route_resolved")).toHaveLength(1);
  }, KERNEL_BUDGET_MS);
});

describe("the Message names a capability", () => {
  test("`use squad <slug>:<capabilityId>:` parses to slug and capability; a bare slug parses to neither", () => {
    expect(parseMessageTargetSpec("use squad brandcraft:branding.brand.audit: audite a marca"))
      .toEqual({ target: { kind: "squad", slug: "brandcraft", capabilityId: "branding.brand.audit" }, capabilityId: "branding.brand.audit" });
    expect(parseMessageTargetSpec("USE SQUAD Doc-Factory:Docs.Report.Create: relatório"))
      .toEqual({ target: { kind: "squad", slug: "doc-factory", capabilityId: "docs.report.create" }, capabilityId: "docs.report.create" });
    // Without a capability the parse is exactly what it always was.
    expect(parseMessageTargetSpec("use squad brandcraft: manifesto"))
      .toEqual({ target: { kind: "squad", slug: "brandcraft", capabilityId: "squad.execute" }, capabilityId: null });
    expect(parseMessageTarget("use squad brandcraft:branding.brand.audit: audite")).toEqual({ kind: "squad", slug: "brandcraft", capabilityId: "branding.brand.audit" });
    // A business prefix takes no capability, and a colon inside the brief is not a grammar.
    expect(parseMessageTargetSpec("use business web-studio: landing").capabilityId).toBeNull();
    expect(parseMessageTarget("faça o seguinte: um relatório")).toEqual(AGENT_X);
  });

  test("the named capability reaches the Run, and the router path resolves one instead of the literal", async () => {
    const audit = auditSink();
    const { router, calls } = fakeRouter(decision({ mandatory_squads: ["brandcraft"] }));
    const named = await resolveMessageTarget("use squad brandcraft:branding.brand.audit: audite a marca", deps(router, audit));
    expect(named.target).toEqual({ kind: "squad", slug: "brandcraft", capabilityId: "branding.brand.audit" });
    expect(named.route.source).toBe("explicit");
    expect(calls).toHaveLength(0);

    // The router names a squad, not a capability: the resolver picks one from the brief.
    const seen: Array<{ slug: string; explicit: string | null }> = [];
    const routed = await resolveMessageTarget("Produza o PDF da marca", deps(router, audit, AGENTIC, undefined,
      ({ slug, explicit }) => { seen.push({ slug, explicit }); return "branding.pdf_document.create"; }));
    expect(routed.target).toEqual({ kind: "squad", slug: "brandcraft", capabilityId: "branding.pdf_document.create" });
    expect(routed.route.source).toBe("router");
    expect(seen).toEqual([{ slug: "brandcraft", explicit: null }]);
  });

  test("the child is started on the capability the Message named", async () => {
    const fx = fixture();
    const queue = fx.queue(fakeRouter(decision()).router, auditSink());
    const receipt = await fx.submit(queue, "use squad brandcraft:branding.brand.audit: audite a marca", "named-capability");
    expect(receipt.run.target).toEqual({ kind: "squad", slug: "brandcraft", capabilityId: "branding.brand.audit" });
    await waitUntil(() => fx.starts.length === 1, "the squad child to start");
    queue.shutdown();
    expect(fx.starts[0].target).toEqual({ kind: "squad", slug: "brandcraft", capabilityId: "branding.brand.audit" });
  }, KERNEL_BUDGET_MS);
});

describe("the receipt and the queue", () => {
  test("the receipt never waits for the router: a router that answers after 2 s resolves in the queue, and the Run shows the target once it did", async () => {
    const fx = fixture();
    const calls: MessageRouteInput[] = [];
    let answeredAt = 0;
    const slow: MessageRouter = { async route(input) { calls.push(input); await Bun.sleep(2_000); answeredAt = Date.now(); return decision({ primary_business: "web-studio" }); } };
    const queue = fx.queue(slow, auditSink());
    const started = Date.now();
    const receipt = await fx.submit(queue);
    const receivedAt = Date.now();
    // Two fsync-bound writes (the Run, the link) are the whole cost of the receipt: milliseconds
    // here, more on the slowest CI runner (see helpers/test-budgets.ts), never the router's 2 s.
    expect(receivedAt - started).toBeLessThan(1_000);
    expect(calls).toHaveLength(0);
    expect(receipt.queued).toBe(true);
    expect(receipt.run.state).toBe("prepared");
    expect(receipt.run.target).toEqual(AGENT_X);
    expect(receipt.run.route).toBeUndefined();
    expect(fx.run(receipt.run.runId).route).toBeUndefined();
    await waitUntil(() => calls.length === 1, "the queue to ask the router");
    expect(fx.run(receipt.run.runId)).toMatchObject({ state: "prepared", target: AGENT_X });
    await waitUntil(() => fx.run(receipt.run.runId).route !== undefined, "the route to resolve");
    expect(answeredAt).toBeGreaterThan(receivedAt);
    expect(fx.run(receipt.run.runId).target).toEqual({ kind: "business", slug: "web-studio" });
    expect(fx.run(receipt.run.runId).route).toEqual({ source: "router", rationale: "OBJECT=landing page, THEME=health." });
    await waitUntil(() => fx.starts.length === 1, "the child to start");
    queue.shutdown();
    expect(fx.starts[0].target).toEqual({ kind: "business", slug: "web-studio" });
  }, KERNEL_BUDGET_MS);

  test("a no_match Message never starts a child: the Run rolls back as no_dispatchable_target and the chat gets the router's answer", async () => {
    const fx = fixture();
    const audit = auditSink();
    const rationale = "OBJECT=one-line listing of the user's own businesses for marketing and ads (a registry lookup). Nothing in the catalog delivers it.";
    const queue = fx.queue(fakeRouter(decision({ kind: "no_match", rationale })).router, audit);
    const receipt = await fx.submit(queue, "Quais empresas eu tenho para marketing e ads? Responda em uma linha.", "question");
    expect(receipt.queued).toBe(true);
    await fx.settled(receipt.run.runId);
    queue.shutdown();
    expect(fx.starts).toHaveLength(0);
    const run = fx.run(receipt.run.runId);
    expect(run.state).toBe("rolled_back");
    expect(run.target).toEqual(AGENT_X);
    expect(run.route).toEqual({ source: "fallback", rationale: `router no_match: ${rationale}` });
    const types = fx.events(run.runId).map(event => event.type);
    expect(types).toEqual(["run.prepared", "x_run_route_resolved", "run.transitioned"]);
    const transition = fx.events(run.runId).find(event => event.type === "run.transitioned")!;
    expect(transition.payload).toMatchObject({ from: "prepared", to: "rolled_back", reason: "no_dispatchable_target" });
    const replies = fx.replies();
    expect(replies).toHaveLength(1);
    expect(replies[0].run_id).toBe(run.runId);
    expect(replies[0].content).toContain(rationale);
    expect(replies[0].content).toContain("use business <slug>:");
    expect(replies[0].sequence).toBeGreaterThan(fx.message.sequence);
    expect(audit.named("auto_route_selected")[0].payload).toMatchObject({ trace_id: run.runId, message_id: fx.message.message_id, decision_kind: "no_match", refused: "no_dispatchable_target" });
    // A retry with the same key finds the settled Run and never routes again.
    const again = fx.queue(fakeRouter(decision({ primary_business: "web-studio" })).router, auditSink());
    const retry = await fx.submit(again, "Quais empresas eu tenho para marketing e ads? Responda em uma linha.", "question");
    again.shutdown();
    expect(retry.queued).toBe(false);
    expect(retry.run.state).toBe("rolled_back");
    expect(fx.replies()).toHaveLength(1);
  }, KERNEL_BUDGET_MS);

  test("a cancel while the router is deciding aborts the routing, rolls the Run back and starts no child", async () => {
    const fx = fixture();
    const audit = auditSink();
    // The router ignores the abort and never settles: the queue must not wait for it.
    const { router, calls } = fakeRouter("hang");
    const queue = fx.queue(router, audit);
    const receipt = await fx.submit(queue);
    await waitUntil(() => calls.length === 1, "the queue to ask the router");
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].signal!.aborted).toBe(false);
    expect(queue.cancel("prj_route", receipt.run.runId)).toEqual({ accepted: true, state: "prepared" });
    expect(calls[0].signal!.aborted).toBe(true);
    await fx.settled(receipt.run.runId);
    queue.shutdown();
    const run = fx.run(receipt.run.runId);
    expect(run.state).toBe("rolled_back");
    expect(run.route).toBeUndefined();
    const transition = fx.events(run.runId).find(event => event.type === "run.transitioned")!;
    expect(transition.payload).toMatchObject({ from: "prepared", to: "rolled_back", reason: "cancelled_before_execution" });
    expect(fx.events(run.runId).map(event => event.type)).toEqual(["run.prepared", "run.transitioned"]);
    expect(fx.starts).toHaveLength(0);
    expect(fx.replies()).toHaveLength(0);
    // Nothing was selected, so nothing was audited as a selection or a failure.
    expect(audit.events).toHaveLength(0);
  }, KERNEL_BUDGET_MS);

  test("the Worker-backed router refuses a Message whose signal is already aborted, without starting a Worker", async () => {
    const controller = new AbortController();
    controller.abort();
    const router = createAgenticMessageRouter({ runtime: "claude-code" });
    await expect(router.route({ brief: "Produza", projectId: "prj_route", projectRoot: "/tmp/prj_route", traceId: "run_trace", signal: controller.signal }))
      .rejects.toThrow("message route cancelled");
  });
});

describe("Glance server", () => {
  test("a Message without a prefix reaches the business the injected router names, and the standard child runs it to a terminal state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-glance-route-server-")); roots.push(root);
    process.env.NIRVANA_PROJECT_ROOT = root;
    // The server's audit lands in the project's harness log unless the caller pinned HARNESS_LOGS_DIR.
    const previousLogs = process.env.HARNESS_LOGS_DIR;
    delete process.env.HARNESS_LOGS_DIR;
    restores.push(() => { if (previousLogs !== undefined) process.env.HARNESS_LOGS_DIR = previousLogs; });
    fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-glance-route-state-")); roots.push(stateRoot);
    restores.push(shimRuntimeOnPath(stateRoot, "claude"));
    const runner = createDispatchExecutionRunner({ dispatchScriptPath: writeFakeGlanceChild(path.join(stateRoot, "helpers")),
      env: { NIRVANA_HOST_RUNTIME: "claude-code", FAKE_CHILD_STATE_DIR: stateRoot } });
    const { ProjectService } = await import("../lib/control-plane/project-service.ts");
    const project = new ProjectService().create({ projectRoot: root });
    const { startServer } = await import("../lib/glance/server.ts");
    const { router, calls } = fakeRouter(decision({ primary_business: "web-studio" }));
    const server = await startServer({ port: 0, open: false, idleMin: 60, allowActions: true, theme: "apple", executionRunner: runner, messageRouter: router });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const headers = (key: string) => ({ "content-type": "application/json", origin: base, "idempotency-key": key });
    const conversation = await fetch(`${base}/api/v1/projects/${project.project_id}/conversations`, { method: "POST", headers: headers("conversation"), body: "{}" }).then(r => r.json()) as any;
    const response = await fetch(`${base}/api/v1/conversations/${conversation.conversation_id}/messages`, { method: "POST", headers: headers("routed"),
      body: JSON.stringify({ project_id: project.project_id, role: "user", content: "Produza a landing page da clínica", mode: "run" }) });
    expect(response.status).toBe(202);
    const receipt = await response.json() as any;
    // The 202 comes back before the router is asked; the projection gains target and route once the queue resolved them.
    expect(receipt.run.state).toBe("prepared");
    expect(receipt.run.target).toEqual(AGENT_X);
    expect(receipt.run.route).toBeUndefined();
    const deadline = Date.now() + 15_000;
    let run: any;
    for (;;) {
      run = await fetch(`${base}/api/v1/runs/${receipt.run.runId}?project_id=${project.project_id}`).then(r => r.json());
      if (run.state === "completed") break;
      if (Date.now() > deadline) throw new Error(`run stayed ${run.state}`);
      await Bun.sleep(10);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ brief: "Produza a landing page da clínica", projectId: project.project_id, projectRoot: root, traceId: receipt.run.runId });
    expect(run.target).toEqual({ kind: "business", slug: "web-studio" });
    expect(run.route).toEqual({ source: "router", rationale: "OBJECT=landing page, THEME=health." });
    expect(childState(stateRoot, receipt.run.runId).argv().argv.slice(0, 2)).toEqual(["--business", "web-studio"]);
    const events = await fetch(`${base}/api/v1/projects/${project.project_id}/events`).then(r => r.json()) as any;
    const types = events.events.filter((event: any) => event.runId === receipt.run.runId).map((event: any) => event.type);
    expect(types.slice(0, 3)).toEqual(["run.prepared", "x_run_route_resolved", "glance.child_started"]);
    // The decision is in the project's audit with the Message's trace, where the cockpit reads.
    const today = new Date().toISOString().slice(0, 10);
    const audit = fs.readFileSync(path.join(root, ".nirvana", "logs", "harness", today, "audit.jsonl"), "utf8").split("\n").filter(Boolean).map(line => parseAuditLine(line));
    const selected = audit.filter(event => event.event === "auto_route_selected");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ actor: "glance", trace_id: receipt.run.runId, project_id: project.project_id, source: "router", business_slug: "web-studio", target_kind: "business" });
  }, KERNEL_BUDGET_MS);
});
