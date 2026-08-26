// dispatch-cascade.ts — the dispatch cascade IN CODE (routing-360 Phase 4.1).
//
// Business → Squad → agent-x, as a deterministic plan resolver over the
// agentic router's structured decision, instead of prose in SKILL.md that the
// maestro may or may not follow. Closes the SKILL.md:174 contract inversion:
// NO_MATCH used to exit 1; the contract says NO_MATCH changes WHO executes
// (agent-x, with the gap named), never WHETHER it executes.
//
// Mapping (resolveDispatchPlan):
//   explicit user target ......... wins, single step, no router consultation
//   kind=decision + business ..... business step (mandatory squads ride along)
//   kind=decision, squads only ... one squad step per mandatory squad
//   kind=no_match ................ agent-x step (the brief never stalls)
//   kind=ambiguous ............... TTY: numbered choice · non-TTY: top
//                                  candidate + x_route_ambiguous_autopicked ·
//                                  --strict-route: fail
//
// Router transport failure (ok:false) ladder (planRouteWithFallback):
//   retry once → fast BM25 route → agent-x with a loud warning.
//   Config routing.on_router_failure: "cascade" (default) | "fail".
//
// The agent-x rung itself (persona resolution + headless run + audit) also
// lives here — it is the bottom of the cascade.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgenticRouteDecision, RouteCandidate } from "./agentic-router.ts";
import type { Runtime } from "./host-agent-driver.ts";
import { runWithCascade } from "./cascade-runner.ts";
import type { RouterFailurePolicy } from "./harness-config.ts";
import { scopeGuard } from "../../_shared/lib/scope-guard.ts";

export type DispatchStepKind = "business" | "squad" | "agent-x";

export interface DispatchStep {
  kind: DispatchStepKind;
  /** business/squad slug; absent for agent-x. */
  slug?: string;
  /** capability entry point, when the router names one (future surface). */
  capability?: string;
  /** Why this step is in the plan — goes into logs and the audit trail. */
  reason: string;
}

export type DispatchPlanSource =
  | "explicit"
  | "decision-business"
  | "decision-squads"
  | "ambiguous-chosen"
  | "ambiguous-autopicked"
  | "no-match"
  | "router-failure-bm25"
  | "router-failure-agent-x";

export interface DispatchPlan {
  ok: boolean;
  steps: DispatchStep[];
  mandatorySquads: string[];
  optionalSquads: string[];
  suggestedMindClones: string[];
  rationale: string;
  source: DispatchPlanSource;
  error?: string;
}

export interface ResolvePlanOpts {
  /** User named the target directly — skips every other layer. */
  explicitTarget?: { kind: "business" | "squad"; slug: string };
  /** --strict-route: an ambiguous route FAILS instead of auto-picking. */
  strictRoute?: boolean;
  /** Interactive terminal available for the numbered-choice prompt. */
  isTTY?: boolean;
  /** TTY chooser seam: returns the index into candidates, or null to fall
   * back to the top candidate. Default implementation uses global prompt(). */
  choose?: (candidates: RouteCandidate[]) => Promise<number | null> | number | null;
  /** Audit emitter seam (event, payload). */
  audit?: (event: string, payload: Record<string, any>) => void;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

const noop = () => { /* no-op */ };

function planBase(source: DispatchPlanSource, d?: AgenticRouteDecision): Omit<DispatchPlan, "ok" | "steps"> {
  return {
    mandatorySquads: d?.mandatory_squads ?? [],
    optionalSquads: d?.optional_squads ?? [],
    suggestedMindClones: d?.suggested_mind_clones ?? [],
    rationale: d?.rationale ?? "",
    source,
  };
}

function defaultChoose(candidates: RouteCandidate[]): number | null {
  // Numbered TTY choice. prompt() is a Bun global; a non-numeric or
  // out-of-range answer falls back to the top candidate (never a dead end).
  try {
    const lines = candidates.map((c, i) => `  ${i + 1}. [${c.type}] ${c.target} — ${c.reason}`).join("\n");
    const answer = (globalThis as any).prompt?.(
      `Rota ambígua — escolha o alvo:\n${lines}\nNúmero [1-${candidates.length}] (Enter = 1):`);
    const n = parseInt(String(answer ?? "").trim(), 10);
    if (Number.isFinite(n) && n >= 1 && n <= candidates.length) return n - 1;
  } catch { /* fall back */ }
  return null;
}

/**
 * Map one agentic-router decision to a dispatch plan (Business → Squad →
 * agent-x). Pure except for the ambiguous TTY prompt and the audit seam.
 * A transport failure (decision.ok === false) is NOT handled here — use
 * planRouteWithFallback for the retry → BM25 → agent-x ladder.
 */
export async function resolveDispatchPlan(decision: AgenticRouteDecision, opts: ResolvePlanOpts = {}): Promise<DispatchPlan> {
  // Named `emit` so check-audit-parity's literal scan sees these events.
  const emit = opts.audit ?? noop;
  const log = opts.log ?? noop;

  // Layer 0 — the user named the target. The user is in command; skip the
  // router entirely (its decision is at most advisory context here).
  if (opts.explicitTarget) {
    const t = opts.explicitTarget;
    return {
      ok: true,
      steps: [{ kind: t.kind, slug: t.slug, reason: "explicit user target" }],
      ...planBase("explicit", decision),
    };
  }

  if (!decision.ok) {
    return { ok: false, steps: [], ...planBase("no-match"), error: decision.error || "router transport failure — use planRouteWithFallback" };
  }

  if (decision.kind === "decision") {
    if (decision.primary_business) {
      return {
        ok: true,
        steps: [{ kind: "business", slug: decision.primary_business, reason: decision.rationale || "router decision" }],
        ...planBase("decision-business", decision),
      };
    }
    if (decision.mandatory_squads.length) {
      return {
        ok: true,
        steps: decision.mandatory_squads.map(s => ({ kind: "squad" as const, slug: s, reason: decision.rationale || "squad-only router decision" })),
        ...planBase("decision-squads", decision),
      };
    }
    // Defensive: parseAndValidate downgrades empty decisions, but a hand-built
    // decision object could still land here. Bottom of the cascade.
    return {
      ok: true,
      steps: [{ kind: "agent-x", reason: "decision carried no actionable target — cascade bottom" }],
      ...planBase("no-match", decision),
    };
  }

  if (decision.kind === "no_match") {
    // Contract: NO_MATCH changes WHO executes, never WHETHER (SKILL.md
    // cascade step 3). The generalist runs with the gap named in its brief.
    return {
      ok: true,
      steps: [{ kind: "agent-x", reason: decision.rationale ? `router no_match: ${decision.rationale}` : "router no_match" }],
      ...planBase("no-match", decision),
    };
  }

  // kind === "ambiguous"
  const dispatchable = decision.candidates.filter(c => c.type === "business" || c.type === "squad");
  if (opts.strictRoute) {
    return {
      ok: false, steps: [], ...planBase("ambiguous-autopicked", decision),
      error: `ambiguous route (--strict-route): ${decision.candidates.map(c => c.target).join(", ") || "no candidates"}`,
    };
  }
  if (dispatchable.length === 0) {
    // Only mind-clone candidates (or none) — nothing dispatchable: agent-x.
    return {
      ok: true,
      steps: [{ kind: "agent-x", reason: "ambiguous route with no dispatchable candidate — cascade bottom" }],
      ...planBase("no-match", decision),
    };
  }

  let idx: number | null = null;
  let source: DispatchPlanSource = "ambiguous-autopicked";
  if (opts.isTTY) {
    const chooser = opts.choose ?? defaultChoose;
    idx = await chooser(dispatchable);
    if (idx != null && (idx < 0 || idx >= dispatchable.length)) idx = null;
    if (idx != null) source = "ambiguous-chosen";
  }
  if (idx == null) {
    idx = 0;
    if (source === "ambiguous-autopicked") {
      emit("x_route_ambiguous_autopicked", {
        picked: dispatchable[0].target,
        picked_type: dispatchable[0].type,
        candidates: decision.candidates,
        rationale: decision.rationale,
      });
      log(`ambiguous route — auto-picked top candidate: ${dispatchable[0].target} (${dispatchable[0].type})`);
    }
  }
  const chosen = dispatchable[idx];
  return {
    ok: true,
    steps: [{
      kind: chosen.type === "squad" ? "squad" : "business",
      slug: chosen.target,
      reason: source === "ambiguous-chosen" ? `ambiguous route — user chose ${chosen.target}` : `ambiguous route — auto-picked top candidate (${chosen.reason || "no reason given"})`,
    }],
    ...planBase(source, decision),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Router-failure ladder
// ─────────────────────────────────────────────────────────────────────

export interface PlanRouteOpts extends ResolvePlanOpts {
  /** Re-run the agentic router (the one retry). */
  routeOnce: () => Promise<AgenticRouteDecision> | AgenticRouteDecision;
  /** Fast BM25 business pick; null when BM25 cannot decide either. */
  fastRoute?: () => Promise<string | null> | string | null;
  /** Config routing.on_router_failure (default "cascade"). */
  onRouterFailure?: RouterFailurePolicy;
}

/**
 * Resolve a plan from a FIRST router decision, riding the failure ladder when
 * the router fails at the transport level: retry once → fast BM25 route →
 * agent-x with a loud warning. `on_router_failure: "fail"` short-circuits the
 * ladder after the retry.
 */
export async function planRouteWithFallback(first: AgenticRouteDecision, opts: PlanRouteOpts): Promise<DispatchPlan> {
  const emit = opts.audit ?? noop;
  const warn = opts.warn ?? ((m: string) => console.error(m));
  let decision = first;

  if (!decision.ok) {
    warn(`agentic router failed (${decision.error || "unknown"}) — retrying once`);
    emit("x_router_failure_retry", { error: decision.error ?? null });
    decision = await opts.routeOnce();
  }
  if (decision.ok) return resolveDispatchPlan(decision, opts);

  const policy: RouterFailurePolicy = opts.onRouterFailure ?? "cascade";
  if (policy === "fail") {
    emit("x_router_failure_fail_policy", { error: decision.error ?? null });
    return {
      ok: false, steps: [], ...planBase("router-failure-agent-x"),
      error: `agentic router failed twice (${decision.error || "unknown"}); routing.on_router_failure=fail`,
    };
  }

  // cascade: BM25 first…
  const bm25Slug = opts.fastRoute ? await opts.fastRoute() : null;
  if (bm25Slug) {
    warn(`agentic router failed twice — falling back to fast BM25 route: ${bm25Slug}`);
    emit("x_router_failure_cascade", { stage: "bm25", picked: bm25Slug, error: decision.error ?? null });
    return {
      ok: true,
      steps: [{ kind: "business", slug: bm25Slug, reason: "BM25 fallback after agentic router transport failure" }],
      ...planBase("router-failure-bm25"),
    };
  }

  // …then agent-x, loudly.
  warn("agentic router failed twice AND BM25 could not decide — dispatching agent-x (generalist fallback). Review the routing setup: this brief got NO specialist.");
  emit("x_router_failure_cascade", { stage: "agent-x", error: decision.error ?? null });
  return {
    ok: true,
    steps: [{ kind: "agent-x", reason: "router transport failure — cascade bottom (BM25 also undecided)" }],
    ...planBase("router-failure-agent-x"),
  };
}

// ─────────────────────────────────────────────────────────────────────
// agent-x — the bottom rung
// ─────────────────────────────────────────────────────────────────────

const AGENTS_DIR_DEFAULT = path.resolve(path.join(import.meta.dir, "..", "..", "_shared", "agents"));

function agentsDirCandidates(): string[] {
  const SKILLS = process.env.NIRVANA_SKILLS_DIR
    || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));
  return [AGENTS_DIR_DEFAULT, path.join(SKILLS, "_shared", "agents")];
}

/**
 * Resolve the agent-x persona file for a runtime. The dir ships
 * agent-x.<flavor>.md where flavor is the runtime without the -cli suffix
 * (claude-code, codex, gemini, antigravity, kimi, grok, pi). Fallback order:
 * exact flavor → agent-x.claude-code.md → first agent-x.*.md present.
 */
export function resolveAgentXPromptPath(runtime: Runtime, agentsDir?: string): string | null {
  const dirs = agentsDir ? [agentsDir] : agentsDirCandidates();
  const flavor = String(runtime).replace(/-cli$/, "");
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const exact = path.join(dir, `agent-x.${flavor}.md`);
    if (fs.existsSync(exact)) return exact;
    const fallback = path.join(dir, "agent-x.claude-code.md");
    if (fs.existsSync(fallback)) return fallback;
    const any = fs.readdirSync(dir).filter(f => /^agent-x\..+\.md$/.test(f)).sort()[0];
    if (any) return path.join(dir, any);
  }
  return null;
}

export interface RunAgentXArgs {
  brief: string;
  /** Path of the enriched brief file the persona is told to read. */
  briefPath: string;
  runtime: Runtime;
  projectId: string;
  projectDir: string;
  projectRoot: string;
  outputsRoot: string;
  /** Why the cascade bottomed out — goes into the prompt and the audit. */
  reason: string;
  appendSystemPrompt?: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  yolo?: boolean;
  ledger?: { runId: string; watchDir?: string };
  audit: (event: string, payload: Record<string, any>) => void;
  agentsDir?: string;
  /** Test seam: canned cascade runner (zero-token tests). */
  runWithCascadeImpl?: typeof runWithCascade;
}

export interface AgentXResult {
  ok: boolean;
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number;
  exitCode?: number;
  error?: string;
  stderr?: string;
  promptPath: string | null;
  finalRuntime: Runtime;
}

/** Dispatch the generalist fallback: persona from _shared/agents +
 * the enriched brief, run through the LLM cascade. Emits dispatch_agent_x
 * (closed-enum event) + agent_executed. */
export function runAgentX(args: RunAgentXArgs): AgentXResult {
  const emit = args.audit;
  const promptPath = resolveAgentXPromptPath(args.runtime, args.agentsDir);
  const persona = promptPath ? fs.readFileSync(promptPath, "utf8") : [
    "# Agent-X — autonomous generalist (persona file missing)",
    "You are the bottom of the harness dispatch cascade. Execute the brief end",
    "to end, autonomously, with professional defaults. Never ask a human.",
  ].join("\n");

  const prompt = [
    persona,
    "",
    "============================================================",
    "# DISPATCH (agent-x fallback)",
    `- trace_id: ${args.projectId}`,
    `- project_dir: ${args.projectDir}`,
    `- output_path: ${args.outputsRoot}`,
    `- enriched brief file: ${args.briefPath}`,
    `- cascade reason: ${args.reason}`,
    "",
    "## Enriched brief",
    args.brief,
    "",
    "## Output",
    `Write every final deliverable as a file under: ${args.outputsRoot}`,
    "Do not print a summary of what you would do — deliver files. Record",
    'assumptions under "## Premissas assumidas" in the main deliverable.',
    scopeGuard("en"),
  ].join("\n");

  emit("dispatch_agent_x", {
    trace_id: args.projectId, project_id: args.projectId,
    runtime: args.runtime, persona_file: promptPath,
    reason: args.reason, outputs_root: args.outputsRoot,
  });

  const cascadeImpl = args.runWithCascadeImpl ?? runWithCascade;
  const res = cascadeImpl({
    runtime: args.runtime, prompt, cwd: args.projectDir, addDirs: [args.projectRoot],
    appendSystemPrompt: args.appendSystemPrompt,
    maxBudgetUsd: args.maxBudgetUsd, timeoutMs: args.timeoutMs, yolo: args.yolo,
    brief: args.brief, projectRoot: args.projectRoot, outputsRoot: args.outputsRoot,
    taskHint: "agent-x fallback (cascade bottom)",
    projectId: args.projectId,
    ...(args.ledger ? { ledger: { runId: args.ledger.runId, watchDir: args.ledger.watchDir ?? args.outputsRoot } } : {}),
  });

  emit("agent_executed", {
    trace_id: args.projectId, project_id: args.projectId,
    employee: "agent-x", runtime: res.finalRuntime, session_id: res.sessionId,
    cost_usd: res.costUsd, duration_ms: res.durationMs, mode: "agent-x",
    handoffs: res.handoffs.length ? res.handoffs : undefined,
  });

  return {
    ok: res.ok, sessionId: res.sessionId, costUsd: res.costUsd, durationMs: res.durationMs,
    exitCode: res.exitCode, error: res.error, stderr: res.stderr,
    promptPath, finalRuntime: res.finalRuntime,
  };
}
