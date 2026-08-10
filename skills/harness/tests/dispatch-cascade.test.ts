// dispatch-cascade.test.ts — the dispatch cascade in code (routing-360 Phase 4.1).
//
// Pins the Business → Squad → agent-x mapping over every agentic-router
// decision kind, the --strict-route behavior, the router-failure ladder
// (retry once → BM25 → agent-x, governed by routing.on_router_failure), and
// the agent-x rung (persona resolution + injected runWithCascade seam).
// Zero-token: every LLM surface is a seam.
// Runs with: bun test skills/harness/tests
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgenticRouteDecision } from "../lib/agentic-router.ts";
import {
  resolveDispatchPlan,
  planRouteWithFallback,
  resolveAgentXPromptPath,
  runAgentX,
} from "../lib/dispatch-cascade.ts";

function mkDecision(partial: Partial<AgenticRouteDecision>): AgenticRouteDecision {
  return {
    ok: true, kind: "decision", primary_business: null,
    mandatory_squads: [], optional_squads: [], suggested_mind_clones: [],
    candidates: [], rationale: "", runtime: null, warnings: [],
    cost_usd: null, duration_ms: 0,
    ...partial,
  };
}

type AuditCall = { event: string; payload: Record<string, any> };
function auditSpy(): { calls: AuditCall[]; fn: (event: string, payload: Record<string, any>) => void } {
  const calls: AuditCall[] = [];
  return { calls, fn: (event, payload) => calls.push({ event, payload }) };
}

describe("resolveDispatchPlan — decision kinds", () => {
  test("decision with primary_business → single business step, squads ride along", async () => {
    const plan = await resolveDispatchPlan(mkDecision({
      kind: "decision", primary_business: "brand-studio",
      mandatory_squads: ["brandcraft"], optional_squads: ["seo-squad"],
      suggested_mind_clones: ["some-clone"], rationale: "OBJECT=brand, THEME=none.",
    }));
    expect(plan.ok).toBe(true);
    expect(plan.steps).toEqual([{ kind: "business", slug: "brand-studio", reason: "OBJECT=brand, THEME=none." }]);
    expect(plan.mandatorySquads).toEqual(["brandcraft"]);
    expect(plan.optionalSquads).toEqual(["seo-squad"]);
    expect(plan.suggestedMindClones).toEqual(["some-clone"]);
    expect(plan.source).toBe("decision-business");
  });

  test("decision with squads only (primary null) → one squad step per mandatory squad", async () => {
    const plan = await resolveDispatchPlan(mkDecision({
      kind: "decision", primary_business: null, mandatory_squads: ["brandcraft", "pdf-squad"],
    }));
    expect(plan.ok).toBe(true);
    expect(plan.steps.map(s => ({ kind: s.kind, slug: s.slug }))).toEqual([
      { kind: "squad", slug: "brandcraft" },
      { kind: "squad", slug: "pdf-squad" },
    ]);
    expect(plan.source).toBe("decision-squads");
  });

  test("no_match → agent-x step (NO_MATCH changes WHO executes, never WHETHER)", async () => {
    const plan = await resolveDispatchPlan(mkDecision({
      kind: "no_match", rationale: "OBJECT=quantum sculpture, THEME=art. Nothing in the catalog.",
    }));
    expect(plan.ok).toBe(true);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].kind).toBe("agent-x");
    expect(plan.steps[0].reason).toContain("no_match");
    expect(plan.source).toBe("no-match");
  });

  test("empty decision (defensive) still bottoms out at agent-x, never a dead end", async () => {
    const plan = await resolveDispatchPlan(mkDecision({ kind: "decision" }));
    expect(plan.ok).toBe(true);
    expect(plan.steps[0].kind).toBe("agent-x");
  });

  test("explicit user target wins over any router decision", async () => {
    const plan = await resolveDispatchPlan(
      mkDecision({ kind: "decision", primary_business: "wrong-biz" }),
      { explicitTarget: { kind: "squad", slug: "user-named-squad" } },
    );
    expect(plan.steps).toEqual([{ kind: "squad", slug: "user-named-squad", reason: "explicit user target" }]);
    expect(plan.source).toBe("explicit");
  });
});

describe("resolveDispatchPlan — ambiguous", () => {
  const ambiguous = mkDecision({
    kind: "ambiguous",
    candidates: [
      { target: "web-studio", type: "business", reason: "delivers landing pages" },
      { target: "brandcraft", type: "squad", reason: "brand assets" },
    ],
    rationale: "OBJECT=landing, THEME=brand. Two routes fit.",
  });

  test("non-TTY → top candidate + x_route_ambiguous_autopicked audit", async () => {
    const spy = auditSpy();
    const plan = await resolveDispatchPlan(ambiguous, { isTTY: false, audit: spy.fn });
    expect(plan.ok).toBe(true);
    expect(plan.steps[0]).toMatchObject({ kind: "business", slug: "web-studio" });
    expect(plan.source).toBe("ambiguous-autopicked");
    const ev = spy.calls.find(x => x.event === "x_route_ambiguous_autopicked");
    expect(ev).toBeTruthy();
    expect(ev!.payload.picked).toBe("web-studio");
    expect(ev!.payload.candidates).toHaveLength(2);
  });

  test("TTY with injected chooser → chosen candidate, no autopick event", async () => {
    const spy = auditSpy();
    const plan = await resolveDispatchPlan(ambiguous, {
      isTTY: true, choose: () => 1, audit: spy.fn,
    });
    expect(plan.steps[0]).toMatchObject({ kind: "squad", slug: "brandcraft" });
    expect(plan.source).toBe("ambiguous-chosen");
    expect(spy.calls.find(x => x.event === "x_route_ambiguous_autopicked")).toBeUndefined();
  });

  test("TTY chooser returning null falls back to top candidate + autopick event", async () => {
    const spy = auditSpy();
    const plan = await resolveDispatchPlan(ambiguous, { isTTY: true, choose: () => null, audit: spy.fn });
    expect(plan.steps[0].slug).toBe("web-studio");
    expect(spy.calls.some(x => x.event === "x_route_ambiguous_autopicked")).toBe(true);
  });

  test("--strict-route fails an ambiguous route instead of auto-picking", async () => {
    const plan = await resolveDispatchPlan(ambiguous, { strictRoute: true });
    expect(plan.ok).toBe(false);
    expect(plan.steps).toHaveLength(0);
    expect(plan.error).toContain("--strict-route");
    expect(plan.error).toContain("web-studio");
  });

  test("ambiguous with only mind-clone candidates → agent-x (clones are not executors)", async () => {
    const plan = await resolveDispatchPlan(mkDecision({
      kind: "ambiguous",
      candidates: [{ target: "some-clone", type: "mind_clone", reason: "voice" }],
    }));
    expect(plan.ok).toBe(true);
    expect(plan.steps[0].kind).toBe("agent-x");
  });
});

describe("planRouteWithFallback — router-failure ladder", () => {
  const okDecision = mkDecision({ kind: "decision", primary_business: "recovered-biz" });
  const failed = mkDecision({ ok: false, kind: "no_match", error: "runtime crashed" });

  test("transport failure → retry once; retry decides → plan from the retry", async () => {
    let retries = 0;
    const plan = await planRouteWithFallback(failed, {
      routeOnce: () => { retries++; return okDecision; },
      warn: () => {},
    });
    expect(retries).toBe(1);
    expect(plan.ok).toBe(true);
    expect(plan.steps[0]).toMatchObject({ kind: "business", slug: "recovered-biz" });
  });

  test("first decision ok → no retry at all", async () => {
    let retries = 0;
    const plan = await planRouteWithFallback(okDecision, {
      routeOnce: () => { retries++; return okDecision; },
    });
    expect(retries).toBe(0);
    expect(plan.steps[0].slug).toBe("recovered-biz");
  });

  test("retry also fails → BM25 fallback business step (router-failure-bm25)", async () => {
    const spy = auditSpy();
    const plan = await planRouteWithFallback(failed, {
      routeOnce: () => failed,
      fastRoute: () => "bm25-biz",
      audit: spy.fn, warn: () => {},
    });
    expect(plan.ok).toBe(true);
    expect(plan.steps[0]).toMatchObject({ kind: "business", slug: "bm25-biz" });
    expect(plan.source).toBe("router-failure-bm25");
    expect(spy.calls.some(x => x.event === "x_router_failure_cascade" && x.payload.stage === "bm25")).toBe(true);
  });

  test("retry fails AND BM25 undecided → agent-x, loudly (router-failure-agent-x)", async () => {
    const spy = auditSpy();
    const warns: string[] = [];
    const plan = await planRouteWithFallback(failed, {
      routeOnce: () => failed,
      fastRoute: () => null,
      audit: spy.fn, warn: m => warns.push(m),
    });
    expect(plan.ok).toBe(true);
    expect(plan.steps[0].kind).toBe("agent-x");
    expect(plan.source).toBe("router-failure-agent-x");
    expect(spy.calls.some(x => x.event === "x_router_failure_cascade" && x.payload.stage === "agent-x")).toBe(true);
    expect(warns.join(" ")).toContain("NO specialist");
  });

  test('routing.on_router_failure: "fail" short-circuits the ladder after the retry', async () => {
    const plan = await planRouteWithFallback(failed, {
      routeOnce: () => failed,
      fastRoute: () => "should-not-be-used",
      onRouterFailure: "fail",
      warn: () => {},
    });
    expect(plan.ok).toBe(false);
    expect(plan.error).toContain("on_router_failure=fail");
    expect(plan.steps).toHaveLength(0);
  });
});

describe("resolveAgentXPromptPath — persona survey", () => {
  test("real shipped dir: every runtime resolves to an existing agent-x file", () => {
    for (const rt of ["claude-code", "codex", "gemini-cli", "antigravity-cli", "kimi-cli", "grok-cli", "pi"] as const) {
      const p = resolveAgentXPromptPath(rt);
      expect(p).toBeTruthy();
      expect(fs.existsSync(p!)).toBe(true);
      expect(path.basename(p!)).toMatch(/^agent-x\..+\.md$/);
    }
  });

  test("-cli suffix is stripped (gemini-cli → agent-x.gemini.md)", () => {
    const p = resolveAgentXPromptPath("gemini-cli");
    expect(path.basename(p!)).toBe("agent-x.gemini.md");
  });

  test("unknown flavor in a fixture dir falls back to agent-x.claude-code.md", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-agentx-"));
    try {
      fs.writeFileSync(path.join(tmp, "agent-x.claude-code.md"), "# fallback persona");
      const p = resolveAgentXPromptPath("codex", tmp);
      expect(path.basename(p!)).toBe("agent-x.claude-code.md");
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test("empty dir → null", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-agentx-empty-"));
    try {
      expect(resolveAgentXPromptPath("claude-code", tmp)).toBeNull();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe("runAgentX — the cascade bottom (injected runWithCascade seam)", () => {
  test("builds persona+brief prompt, emits dispatch_agent_x + agent_executed", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-agentx-run-"));
    try {
      const agentsDir = path.join(tmp, "agents");
      fs.mkdirSync(agentsDir);
      fs.writeFileSync(path.join(agentsDir, "agent-x.claude-code.md"), "# PERSONA-MARKER agent-x");
      const projDir = path.join(tmp, "proj");
      const oroot = path.join(tmp, "out");
      fs.mkdirSync(projDir, { recursive: true });
      const briefPath = path.join(tmp, "brief-enriched.md");
      fs.writeFileSync(briefPath, "the brief");

      const spy = auditSpy();
      const seen: any[] = [];
      const r = runAgentX({
        brief: "Deliver the impossible artifact.",
        briefPath,
        runtime: "claude-code",
        projectId: "proj-test-ax",
        projectDir: projDir,
        projectRoot: tmp,
        outputsRoot: oroot,
        reason: "router no_match: nothing fits",
        agentsDir,
        audit: spy.fn,
        runWithCascadeImpl: ((opts: any) => {
          seen.push(opts);
          return {
            ok: true, runtime: opts.runtime, sessionId: "sess-ax-1", result: "",
            costUsd: 0.01, exitCode: 0, stderr: "", durationMs: 42,
            handoffs: [], finalRuntime: opts.runtime,
          };
        }) as any,
      });

      expect(r.ok).toBe(true);
      expect(r.sessionId).toBe("sess-ax-1");
      expect(r.promptPath).toBe(path.join(agentsDir, "agent-x.claude-code.md"));
      expect(seen).toHaveLength(1);
      expect(seen[0].prompt).toContain("PERSONA-MARKER");
      expect(seen[0].prompt).toContain("Deliver the impossible artifact.");
      expect(seen[0].prompt).toContain(oroot);
      expect(seen[0].prompt).toContain("router no_match: nothing fits");
      const dx = spy.calls.find(x => x.event === "dispatch_agent_x");
      expect(dx).toBeTruthy();
      expect(dx!.payload.trace_id).toBe("proj-test-ax");
      expect(dx!.payload.persona_file).toContain("agent-x.claude-code.md");
      const ax = spy.calls.find(x => x.event === "agent_executed");
      expect(ax).toBeTruthy();
      expect(ax!.payload.employee).toBe("agent-x");
      expect(ax!.payload.mode).toBe("agent-x");
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test("missing persona dir still runs (built-in minimal persona), promptPath null", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-agentx-nop-"));
    try {
      const spy = auditSpy();
      const seen: any[] = [];
      const r = runAgentX({
        brief: "b", briefPath: path.join(tmp, "b.md"), runtime: "claude-code",
        projectId: "p", projectDir: tmp, projectRoot: tmp, outputsRoot: path.join(tmp, "o"),
        reason: "r", agentsDir: path.join(tmp, "no-such-dir"), audit: spy.fn,
        runWithCascadeImpl: ((opts: any) => {
          seen.push(opts);
          return { ok: true, runtime: opts.runtime, sessionId: null, result: "", costUsd: null, exitCode: 0, stderr: "", durationMs: 1, handoffs: [], finalRuntime: opts.runtime };
        }) as any,
      });
      expect(r.ok).toBe(true);
      expect(r.promptPath).toBeNull();
      expect(seen[0].prompt).toContain("autonomous generalist");
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
