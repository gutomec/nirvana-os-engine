// glance-message-route.test.ts — a Glance Message resolves its target through the
// same cascade as the maestro: an explicit prefix wins, then the agentic router
// (business, then squad), then agent-x as the bottom. The router is injected, so
// nothing here calls an LLM or the network. Runs with: bun test skills/harness/tests
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgenticRouteDecision } from "../lib/agentic-router.ts";
import {
  AgentXCanaryQueue, ConversationService, MESSAGE_ROUTE_TIMEOUT_MS, createDispatchExecutionRunner, resolveMessageTarget,
  type GlanceAgentXCanaryAdapter, type MessageRouteInput, type MessageRouter, type MessageRoutingSettings,
} from "../lib/control-plane/index.ts";
import { getRun, listEvents, openKernel } from "../lib/run-kernel/index.ts";
import { childState, shimRuntimeOnPath, writeFakeGlanceChild } from "./helpers/fake-glance-child.ts";
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

function deps(router: MessageRouter | undefined, audit: ReturnType<typeof auditSink>, settings: MessageRoutingSettings = AGENTIC, timeoutMs?: number) {
  return { router, settings, audit: audit.sink, timeoutMs, projectId: "prj_route", projectRoot: "/tmp/prj_route", traceId: "run_trace", messageId: "msg_route" };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-glance-route-")); roots.push(root);
  fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
  const kernel = openKernel(path.join(root, ".nirvana", "run-kernel.sqlite"));
  const conversations = new ConversationService(path.join(root, ".nirvana", "control-plane.sqlite"));
  closers.push(() => { kernel.close(); conversations.close(); });
  const conversation = conversations.create("prj_route", "Route", "cnv_route");
  const message = conversations.append({ conversationId: conversation.conversation_id, projectId: "prj_route", role: "user", content: "Produza a landing page da clínica", messageId: "msg_route" });
  // The queue never drains in these tests: shutdown() right after submit clears the scheduled drain.
  const adapter = { available: () => true } as unknown as GlanceAgentXCanaryAdapter;
  const queue = (router: MessageRouter | undefined, audit: ReturnType<typeof auditSink>, settings: MessageRoutingSettings = AGENTIC) => {
    const instance = new AgentXCanaryQueue(kernel, conversations, adapter, undefined, { router, audit: audit.sink, settingsFor: () => settings });
    queues.push(instance);
    return instance;
  };
  const submit = (instance: AgentXCanaryQueue, content = message.content, idempotencyKey = "route") =>
    instance.submit({ projectId: "prj_route", conversationId: conversation.conversation_id, messageId: message.message_id, brief: content, projectRoot: root, idempotencyKey });
  return { root, kernel, message, queue, submit };
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
  });

  test("(b) a decision with primary_business prepares a business Run with capability business.dispatch", async () => {
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
    queue.shutdown();
    expect(receipt.queued).toBe(true);
    expect(receipt.capability).toBe("business.dispatch");
    expect(receipt.run.target).toEqual({ kind: "business", slug: "web-studio" });
    expect(receipt.run.route).toEqual({ source: "router", rationale: "OBJECT=landing page, THEME=health." });
    expect(receipt.message.run_id).toBe(receipt.run.runId);
    const prepared = listEvents(fx.kernel, "prj_route").find(event => event.runId === receipt.run.runId && event.type === "run.prepared")!;
    expect(prepared.payload).toMatchObject({ target: { kind: "business", slug: "web-studio" }, route: { source: "router" } });
    expect(prepared.traceId).toBe(receipt.run.runId);
    // The stored Run keeps its target: a retry with the same key never routes again.
    const again = fx.queue(fakeRouter(decision({ primary_business: "other" })).router, auditSink());
    const retry = await fx.submit(again);
    again.shutdown();
    expect(retry.run.runId).toBe(receipt.run.runId);
    expect(retry.run.target).toEqual({ kind: "business", slug: "web-studio" });
  }, KERNEL_BUDGET_MS);

  test("(c) a squad-only decision prepares a squad Run with squad.execute; several mandatory squads fall to agent-x", async () => {
    const audit = auditSink();
    const { router } = fakeRouter(decision({ mandatory_squads: ["brandcraft"], rationale: "OBJECT=branding PDF, THEME=none." }));
    const resolution = await resolveMessageTarget("Produza o PDF da marca", deps(router, audit));
    expect(resolution.target).toEqual({ kind: "squad", slug: "brandcraft", capabilityId: "squad.execute" });
    expect(resolution.route).toEqual({ source: "router", rationale: "OBJECT=branding PDF, THEME=none." });
    expect(audit.named("auto_route_selected")[0].payload).toMatchObject({ source: "router", plan_source: "decision-squads", target_kind: "squad", target_slug: "brandcraft" });

    const fx = fixture();
    const queue = fx.queue(router, auditSink());
    const receipt = await fx.submit(queue, "Produza o PDF da marca", "squad");
    queue.shutdown();
    expect(receipt.capability).toBe("squad.dispatch");
    expect(receipt.run.target).toEqual({ kind: "squad", slug: "brandcraft", capabilityId: "squad.execute" });
    expect(receipt.run.route.source).toBe("router");

    const several = await resolveMessageTarget("Produza o PDF da marca", deps(fakeRouter(decision({ mandatory_squads: ["brandcraft", "doc-factory"] })).router, auditSink()));
    expect(several.target).toEqual(AGENT_X);
    expect(several.route.source).toBe("fallback");
    expect(several.route.rationale).toContain("brandcraft, doc-factory");
  }, KERNEL_BUDGET_MS);

  test("(d) no_match keeps the Message on agent-x, recorded as fallback with the router's reason", async () => {
    const audit = auditSink();
    const resolution = await resolveMessageTarget("Faça algo que nada cobre", deps(fakeRouter(decision({ kind: "no_match", rationale: "OBJECT=unknown. Nothing delivers it." })).router, audit));
    expect(resolution.target).toEqual(AGENT_X);
    expect(resolution.route).toEqual({ source: "fallback", rationale: "router no_match: OBJECT=unknown. Nothing delivers it." });
    expect(audit.named("auto_route_selected")[0].payload).toMatchObject({ source: "fallback", plan_source: "no-match", target_kind: "agent-x", decision_kind: "no_match" });
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

    const fx = fixture();
    const receipt = await fx.submit(fx.queue(fakeRouter(new Error("digest exploded")).router, auditSink(), { mode: "agentic", onRouterFailure: "fail" }), "Produza", "refused");
    expect(receipt.queued).toBe(false);
    expect(receipt.run.state).toBe("rolled_back");
    const run = getRun(fx.kernel, "prj_route", receipt.run.runId)!;
    expect(run.route).toMatchObject({ source: "fallback" });
    const transition = listEvents(fx.kernel, "prj_route").find(event => event.runId === run.runId && event.type === "run.transitioned")!;
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

  test("concurrent submits of the same Message route once and share the Run", async () => {
    const fx = fixture();
    const { router, calls } = fakeRouter(decision({ primary_business: "web-studio" }));
    const queue = fx.queue(router, auditSink());
    const [first, second] = await Promise.all([fx.submit(queue), fx.submit(queue)]);
    queue.shutdown();
    expect(calls).toHaveLength(1);
    expect(second.run.runId).toBe(first.run.runId);
    expect(listEvents(fx.kernel, "prj_route").filter(event => event.type === "run.prepared")).toHaveLength(1);
  }, KERNEL_BUDGET_MS);
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
      body: JSON.stringify({ project_id: project.project_id, role: "user", content: "Produza a landing page da clínica" }) });
    expect(response.status).toBe(202);
    const receipt = await response.json() as any;
    expect(receipt.capability).toBe("business.dispatch");
    expect(receipt.run.target).toEqual({ kind: "business", slug: "web-studio" });
    expect(receipt.run.route).toEqual({ source: "router", rationale: "OBJECT=landing page, THEME=health." });
    expect(calls[0]).toMatchObject({ brief: "Produza a landing page da clínica", projectId: project.project_id, projectRoot: root, traceId: receipt.run.runId });
    const deadline = Date.now() + 15_000;
    let run: any;
    for (;;) {
      run = await fetch(`${base}/api/v1/runs/${receipt.run.runId}?project_id=${project.project_id}`).then(r => r.json());
      if (run.state === "completed") break;
      if (Date.now() > deadline) throw new Error(`run stayed ${run.state}`);
      await Bun.sleep(10);
    }
    expect(run.route.source).toBe("router");
    expect(childState(stateRoot, receipt.run.runId).argv().argv.slice(0, 2)).toEqual(["--business", "web-studio"]);
    // The decision is in the project's audit with the Message's trace, where the cockpit reads.
    const today = new Date().toISOString().slice(0, 10);
    const audit = fs.readFileSync(path.join(root, ".nirvana", "logs", "harness", today, "audit.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    const selected = audit.filter(event => event.event === "auto_route_selected");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ actor: "glance", trace_id: receipt.run.runId, project_id: project.project_id, source: "router", business_slug: "web-studio", target_kind: "business" });
  }, KERNEL_BUDGET_MS);
});
