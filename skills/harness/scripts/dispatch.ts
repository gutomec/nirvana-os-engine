#!/usr/bin/env bun
// dispatch.ts — one-command end-to-end dispatch of a Nirvana target.
//
// Wraps brief-business.ts + employee-prompt.ts + the delivery pipeline
// (lib/delivery-pipeline.ts: verify → gate → deliver, fail-closed) so the
// user doesn't have to wire them manually. The dispatch cascade
// (lib/dispatch-cascade.ts) is in code: Business → Squad → agent-x — a
// NO_MATCH dispatches the generalist instead of exiting, a squad-only route
// actually DISPATCHES the squad (lib/squad-exec.ts), and the router-failure
// ladder (retry → BM25 → agent-x) keeps the brief from stalling.
//
// Usage:
//   nrv dispatch <business_slug> "<brief>"
//   nrv dispatch <business_slug> "<brief>" --manifest=paths.json --project=name --runtime=claude-code
//   nrv dispatch <business_slug> --brief-file=brief.md --manifest=paths.json
//
// Exit codes (routing-360 Phase 4 — BREAKING, see CHANGELOG):
//   0 = delivered (gate pass, or --force-deliver) · scaffold-only success
//   1 = run failed (routing / exec / verify failure)
//   2 = delivery WITHHELD — gate failed after the revision budget
//   3 = delivery INDETERMINATE — zero gateable artifacts, nothing judged
//   4 = invalid args (EXIT.INVALID_ARGS per SCRIPT_CONTRACT; was 2)

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { runHeadless, runtimeAvailable, AUTONOMOUS_DIRECTIVE, LEDGER_DEFAULT_TIMEOUT_MS, type Runtime } from "../lib/host-agent-driver.ts";
import { amplify } from "../lib/amplifier.ts";
import { proxyEnrichBrief } from "../lib/brief-proxy.ts";
import { resolveRoutingMode } from "../../_shared/lib/routing-mode.ts";
import { runTeam } from "../lib/team-orchestrator.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { agenticRoute } from "../lib/agentic-router.ts";
import { runWithCascade } from "../lib/cascade-runner.ts";
import { resolveCascadeRoot } from "../lib/cascade.ts";
import { loadRuntimeRules, decideRuntime, detectCurrentHost, formatRulesForDirective, type RuntimeDecision } from "../lib/runtime-rules.ts";
import { preflightReindex } from "../lib/preflight-index.ts";
import { maybeSweep } from "./supervisor.ts";
import * as runLedger from "../lib/run-ledger.ts";
import { loadHarnessConfig } from "../lib/harness-config.ts";
import { planRouteWithFallback, runAgentX, type DispatchPlan } from "../lib/dispatch-cascade.ts";
import { runSquadHeadless } from "../lib/squad-exec.ts";
import { runDelivery, type DeliveryResult } from "../lib/delivery-pipeline.ts";

// Back-compat re-exports: these helpers moved to lib/delivery-pipeline.ts in
// routing-360 Phase 4.2 (the pipeline is shared by all three dispatch paths).
export { nonStubText, runGateOnce, decideGateOutcome, type GateOutcome } from "../lib/delivery-pipeline.ts";

const requireCjs = createRequire(import.meta.url);
const auditLib = requireCjs("../lib/audit.js");

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  lime: "\x1b[38;5;154m",
};

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.findIndex(a => a === name || a.startsWith(`${name}=`));
  if (i === -1) return fallback;
  const a = process.argv[i];
  if (a.includes("=")) return a.split("=").slice(1).join("=");
  return process.argv[i + 1] || fallback;
}

// Extract positionals WITHOUT swallowing space-form flag values. A naive
// filter(!startsWith("--")) treats the "X" in "--project X" as a positional,
// which made "--project caso-bruno" leak its value as the inline brief and
// override --brief-file. Skip the token after each known value-flag.
const VALUE_FLAGS = new Set(["--project", "--runtime", "--manifest", "--brief-file", "--outputs-root", "--max-budget", "--timeout", "--max-revisions"]);
function extractPositional(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (!a.includes("=") && VALUE_FLAGS.has(a)) i++; // skip its space-form value
      continue;
    }
    out.push(a);
  }
  return out;
}
const positional = extractPositional(process.argv.slice(2));
// --auto: no business is named; the router picks the best one for the brief.
// In that mode the first positional is the brief itself.
const autoMode = process.argv.includes("--auto");
// Routing mode (agentic default | fast). Precedence: --mode > env > config.
const routingMode = resolveRoutingMode(arg("--mode"));
let slug = autoMode ? "" : positional[0];
const inlineBrief = autoMode ? positional[0] : positional[1];
const briefFile = arg("--brief-file");
const manifest = arg("--manifest");
const projectId = arg("--project");
const runtime = arg("--runtime", "claude-code");
// Was the --runtime flag GIVEN by the user? (arg() can't tell flag from default;
// an explicit flag ALWAYS beats the USE_* rules — a rule only beats the default.)
const runtimeFlagGiven = process.argv.some(a => a === "--runtime" || a.startsWith("--runtime="));
const outputsRoot = arg("--outputs-root");
const noColor = process.argv.includes("--no-color") || !process.stdout.isTTY;

function c(color: string, text: string): string {
  return noColor ? text : `${(ANSI as any)[color]}${text}${ANSI.reset}`;
}

// ── exec-mode flags ──────────────────────────────────────────────────────
function normRuntime(s: string): Runtime {
  const v = (s || "").toLowerCase();
  if (v === "claude" || v === "claude-code") return "claude-code";
  if (v === "codex") return "codex";
  if (v === "gemini" || v === "gemini-cli") return "gemini-cli";
  if (v === "agy" || v === "antigravity" || v === "antigravity-cli") return "antigravity-cli";
  if (v === "pi" || v === "pi-cli" || v === "pi-dev" || v === "pi-coding-agent") return "pi";
  return (s || "claude-code") as Runtime;
}
function resolveExecRuntime(): Runtime | null {
  const eq = process.argv.find(a => a.startsWith("--exec="));
  if (eq) return normRuntime(eq.split("=")[1]);
  if (process.argv.includes("--claude-code")) return "claude-code";
  if (process.argv.includes("--exec") || process.argv.includes("--run")) return normRuntime(runtime || "claude-code");
  return null;
}
const execRuntime = resolveExecRuntime();
const wantExec = execRuntime !== null;
const wantZip = process.argv.includes("--zip");
const wantPdf = process.argv.includes("--pdf");
// HTML report is the DEFAULT (skipped only in fast mode or with --no-html). --html
// stays as a no-op alias for compat. --offline-snapshot inlines the CDN assets.
const skipHtml = routingMode === "fast" || process.argv.includes("--no-html");
// --team: harness-driven multi-employee orchestration (director + chain) instead
// of single-shot. Each employee runs as its own audited claude -p with DNA.
const wantTeam = process.argv.includes("--team");
const autoBriefEq = process.argv.find(a => a.startsWith("--auto-brief="));
const autoBriefMode = autoBriefEq ? autoBriefEq.split("=")[1] : (process.argv.includes("--auto-brief") ? "inferred" : null);
const wantAutoBrief = autoBriefMode !== null;
// Default = full trust (Bash enabled, permissions skipped on every runtime)
// so the agent can delegate to colleagues and deliver with quality.
// --safe opts into the old restricted mode (allowlist + acceptEdits / workspace-write).
const safeMode = process.argv.includes("--safe");
const yolo = !safeMode;
const maxBudget = arg("--max-budget");
const timeoutMin = arg("--timeout");
const maxRevisions = parseInt(arg("--max-revisions") || "2", 10);
// --strict-route: an AMBIGUOUS route fails instead of auto-picking (Phase 4).
const strictRoute = process.argv.includes("--strict-route");
// --force-deliver: deliver despite a failed gate (delivered gate:"fail-forced").
const forceDeliver = process.argv.includes("--force-deliver");

// ── audit facade (routing-360 Phase 4.3, dispatch side) ───────────────────
// lib/audit.js emit() is the canonical writer (closed enum + open x_
// namespace). The facade fixes the historical SPLIT-ROOT bug: events emitted
// before the project dir exists land in the launch-cwd root; once the project
// dir is known, those buffered events are REPLAYED into the project root,
// flagged `replayed_from_global: true` and carrying their ORIGINAL ts so
// chain validators dedupe the two copies as one event.
export interface DispatchAudit {
  emit(event: string, payload: Record<string, any>): void;
  bindProjectRoot(dir: string): void;
}
export function createDispatchAudit(opts: {
  baseCwd?: string;
  emitImpl?: (event: string, payload: Record<string, any>, ctx?: Record<string, any>) => { event?: Record<string, any> } | void;
} = {}): DispatchAudit {
  const emitImpl = opts.emitImpl ?? ((e: string, p: Record<string, any>, ctx?: Record<string, any>) => auditLib.emit(e, p, ctx));
  const baseCwd = opts.baseCwd ?? process.cwd();
  let projectCwd: string | null = null;
  const buffered: Array<{ event: string; payload: Record<string, any>; ts: string | null }> = [];
  return {
    emit(event: string, payload: Record<string, any>): void {
      try {
        const res = emitImpl(event, payload, { cwd: projectCwd ?? baseCwd });
        if (!projectCwd) {
          const ts = (res && typeof res === "object" && res.event && typeof res.event.ts === "string") ? res.event.ts : null;
          buffered.push({ event, payload, ts });
        }
      } catch { /* non-fatal */ }
    },
    bindProjectRoot(dir: string): void {
      if (projectCwd) return;
      projectCwd = dir;
      try {
        const preRoot = harnessLogsDir({ cwd: baseCwd });
        const postRoot = harnessLogsDir({ cwd: dir });
        if (preRoot !== postRoot) {
          for (const b of buffered) {
            emitImpl(b.event, { ...b.payload, ...(b.ts ? { ts: b.ts } : {}), replayed_from_global: true }, { cwd: dir });
          }
        }
      } catch { /* non-fatal */ }
      buffered.length = 0;
    },
  };
}

// ── CLI flow ───────────────────────────────────────────────────────────────
// Everything below runs only when executed as a script (`bun dispatch.ts …`).
// Importing this module (tests) gets the exported helpers with no side
// effects. Body intentionally kept at original indentation for a minimal diff.
if (import.meta.main) {

// Named `emit` so check-audit-parity's literal emit-call scan sees every
// dispatch-side emission.
const dispatchAudit = createDispatchAudit();
const emit = (event: string, payload: Record<string, any>) => dispatchAudit.emit(event, payload);

if (!slug && !autoMode) {
  console.error("Uso: nrv dispatch <business_slug> \"<brief>\" [opts]");
  console.error("");
  console.error("  Opts:");
  console.error("    --brief-file=<path>     Brief em arquivo (alternativa ao inline)");
  console.error("    --manifest=<path>       deliverables.json (paths esperados)");
  console.error("    --project=<id>          Project ID custom (default: auto)");
  console.error("    --outputs-root=<dir>    Onde artefatos finais devem ser escritos");
  console.error("    --runtime=<name>        claude-code|codex|antigravity-cli|gemini-cli|kimi-cli|grok-cli|pi (default: claude-code)");
  console.error("");
  console.error("  Exec (autopilot):");
  console.error("    --auto                  sem nomear a empresa: o roteador escolhe a melhor para o brief");
  console.error("    --exec[=runtime]        executa o agente headless (sem isso, só scaffolda)");
  console.error("    --claude-code           atalho para --exec=claude-code");
  console.error("    --auto-brief            enriquece brief magro e decide pelo humano");
  console.error("    --zip                   empacota os entregáveis em ./<project>.zip");
    console.error("    --pdf                   gera relatorio-final.pdf via report-publisher (se o business tiver)");
    console.error("    --html                  gera relatorio-final.html com todos os markdowns do projeto (marked)");
  console.error("    --team                  orquestração multi-employee real (diretor + cadeia, cada step audita)");
  console.error("    --max-budget=<usd>      teto de custo do run (claude --max-budget-usd)");
  console.error("    --timeout=<min>         teto de relógio do run (default 24h; travamento real é detectado por inatividade em ~5 min)");
  console.error("    --safe                  opt-in modo restrito (tools limitadas + sandbox); default = full trust");
  console.error("    --strict-route          rota ambígua FALHA em vez de auto-escolher o top candidato");
  console.error("    --force-deliver         entrega mesmo com gate reprovado (delivered gate:\"fail-forced\")");
  console.error("");
  console.error("Exemplo:");
  console.error("  nrv dispatch brand-creative-studio \"Manifesto para produto X\"");
  console.error("  nrv run minha-marca \"caso de acidente\" --auto-brief --zip");
  process.exit(4);
}

let brief = inlineBrief;
if (!brief && briefFile) {
  if (!fs.existsSync(briefFile)) {
    console.error(c("red", `ERRO: --brief-file não encontrado: ${briefFile}`));
    process.exit(4);
  }
  brief = fs.readFileSync(briefFile, "utf8");
}
if (!brief) {
  console.error(c("red", "ERRO: forneça brief inline ou --brief-file"));
  process.exit(4);
}

// Never route/dispatch against a stale corpus (routing-360 Phase 2.5);
// <50ms when fresh — mtime stats only.
preflightReindex();
// Never-stall guarantee (routing-360 Phase 4): recover forgotten runs lazily.
// <20ms when nothing pending; spawns a DETACHED background sweep otherwise.
maybeSweep();

// ── dispatch-ledger wiring (never-stall guarantee) ────────────────────────
// Ledger failures must never break a dispatch: every call goes through
// ledgerTry (stderr warn, run continues).
let ledgerHandle: runLedger.LedgerHandle | null = null;
let ledgerRunId: string | null = null;
function ledgerTry<T>(fn: () => T): T | null {
  try { return fn(); } catch (e) { console.error(`[run-ledger] ${(e as Error)?.message ?? e}`); return null; }
}

// Harness config (quality_gate.*, routing.on_router_failure) — Phase 4.
const harnessConfig = loadHarnessConfig();

// ── User USE_* rules (natural-language per-runtime routing) ────────────────
// Precedence: explicit flag (--exec=<rt> | --claude-code | --runtime given)
// > USE_* rule > default = the runtime the USER IS ALREADY USING (session
// host) > claude-code. The LLM_CASCADE still owns resilience (quota).
const runtimeRules = loadRuntimeRules(resolveCascadeRoot(process.cwd()));
const explicitRuntime: Runtime | null = (() => {
  const eq = process.argv.find(a => a.startsWith("--exec="));
  if (eq) return normRuntime(eq.split("=")[1]);
  if (process.argv.includes("--claude-code")) return "claude-code";
  if (runtimeFlagGiven) return normRuntime(runtime);
  return null;
})();
const hostDefault: Runtime = detectCurrentHost() ?? "claude-code";
let runtimeDecision: RuntimeDecision = decideRuntime({
  brief, explicitRuntime, defaultRuntime: hostDefault,
  rules: runtimeRules, mode: routingMode as "agentic" | "fast",
  available: runtimeAvailable,
});
if (runtimeDecision.source === "brief") {
  console.log(c("lime", "▶") + c("bold", ` Runtime citado no brief: "${runtimeDecision.mention}"`) + c("dim", ` → ${runtimeDecision.runtime}`));
  emit("routing_rule_applied", {
    project_id: projectId || null,
    rule_env_key: null, rule_text: runtimeDecision.mention ?? null,
    runtime: runtimeDecision.runtime, method: "brief-mention", score: null,
    vetoes: runtimeDecision.vetoes ?? null,
  });
} else if (runtimeDecision.source === "rule") {
  console.log(c("lime", "▶") + c("bold", ` Regra de runtime: ${runtimeDecision.rule!.envKey}`) + c("dim", ` → ${runtimeDecision.runtime} (${runtimeDecision.method}, score ${runtimeDecision.score?.toFixed(2)})`));
  emit("routing_rule_applied", {
    project_id: projectId || null,
    rule_env_key: runtimeDecision.rule!.envKey, rule_text: runtimeDecision.rule!.rule,
    runtime: runtimeDecision.runtime, method: runtimeDecision.method, score: runtimeDecision.score ?? null,
    vetoes: runtimeDecision.vetoes ?? null,
  });
} else if (runtimeDecision.vetoes?.length) {
  // NOT_USE_* vetoes changed/limited the choice with no winning positive rule.
  console.log(c("lime", "▶") + c("bold", ` Veto de runtime: ${runtimeDecision.vetoes.map(v => v.envKey).join(", ")}`) + c("dim", ` → seguindo em ${runtimeDecision.runtime}`));
  emit("routing_rule_vetoed", {
    project_id: projectId || null,
    vetoes: runtimeDecision.vetoes, runtime: runtimeDecision.runtime, source: runtimeDecision.source,
  });
} else if (runtimeRules.length && runtimeDecision.source === "default" && !explicitRuntime) {
  console.log(c("dim", `  regras USE_* presentes, sem match para este brief — seguindo no default (${runtimeDecision.runtime})`));
}
// Block appended to the AUTONOMOUS_DIRECTIVE: the maestro honors the rules when
// DELEGATING sub-tasks ("" when there are no rules = no-op).
const rulesDirective = formatRulesForDirective(runtimeRules);

// Fast BM25 business pick — used by --mode=fast AND as the router-failure
// fallback rung of the cascade ladder.
async function fastBm25Business(briefText: string): Promise<{ slug: string | null; signal: string }> {
  let picked: string | null = null;
  let signal = "";
  try {
    const router = requireCjs("../lib/router.js");
    const r = await router.route(briefText, { prefer: "business" });
    const s3 = (r && r.stage3) || {};
    signal = String(s3.signal || "");
    const m = (s3.target && s3.target.meta) || {};
    if (m.type === "business_route") picked = m.slug || null;
    else if (m.type === "business") picked = m.slug || m.business || null;
    else if (typeof m.business === "string") picked = m.business;
  } catch (e: any) {
    console.error(c("yellow", `  fast route error: ${e?.message || e}`));
  }
  return { slug: picked, signal };
}

// --auto: agentic routing → dispatch cascade (Business → Squad → agent-x).
// The router decision maps to a plan in lib/dispatch-cascade.ts; squad-only
// and agent-x routes are DEFERRED until after brief enrichment below (their
// executors receive the enriched brief), business routes flow into the
// existing brief-business scaffold path.
let autoMandatorySquads: string[] = [];
let pendingCascade:
  | { kind: "squad-only"; squads: string[]; plan: DispatchPlan }
  | { kind: "agent-x"; reason: string; plan: DispatchPlan }
  | null = null;
if (autoMode && routingMode === "fast") {
  // fast mode: BM25 business pick, zero-token. Honest fallback when BM25 can't
  // confidently choose a business (most businesses lack auto_routes yet).
  console.log(c("lime", "▶") + c("bold", " Auto-route — fast (BM25, zero-token)"));
  const fast = await fastBm25Business(brief);
  if (!fast.slug) {
    console.error(c("red", `✗ --auto (fast): BM25 não escolheu uma empresa com confiança (sinal ${fast.signal || "n/a"}; a maioria dos businesses ainda não tem auto_routes). Nomeie a empresa, ou use --mode=agentic.`));
    process.exit(1);
  }
  slug = fast.slug;
  console.log(c("lime", "  →") + c("bold", ` ${slug}`) + c("dim", ` (BM25 · signal ${fast.signal})`));
  emit("auto_route_selected", { project_id: projectId || null, business_slug: slug, method: "fast" });
} else if (autoMode) {
  // agentic (default): an LLM with Read+Bash+Grep inspects the brief AND the
  // registries and returns the structured routing contract. The user's
  // explicit asks are ALWAYS honored.
  console.log(c("lime", "▶") + c("bold", " Auto-route — agentic"));
  const rt = explicitRuntime || runtimeDecision.runtime;
  const routeOnce = () => agenticRoute({
    brief, runtime: rt, cwd: process.cwd(), projectId: projectId || null,
    maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
    timeoutMs: 5 * 60 * 1000,
    runtimeRules,
  });
  const decision = await routeOnce();
  // The agentic router READ the user's USE_* rules; if it suggested a runtime
  // and there is no explicit flag NOR a direct mention in the brief (which is
  // stronger than the LLM's suggestion), the semantic suggestion overrides the
  // BM25 match.
  if (decision.runtime && !explicitRuntime && runtimeDecision.source !== "brief" && runtimeAvailable(decision.runtime)) {
    const matched = runtimeRules.find(r => r.runtime === decision.runtime);
    runtimeDecision = { runtime: decision.runtime, source: "rule", rule: matched, method: "agentic" };
    console.log(c("lime", "  →") + c("bold", ` runtime pela regra do usuário: ${decision.runtime}`) + c("dim", " (agentic)"));
    emit("routing_rule_applied", {
      project_id: projectId || null,
      rule_env_key: matched?.envKey ?? null, rule_text: matched?.rule ?? null,
      runtime: decision.runtime, method: "agentic", score: null,
    });
  }

  // Dispatch cascade: decision → plan (retry → BM25 → agent-x on transport
  // failure; ambiguous → TTY choice or autopick; no_match → agent-x).
  const plan = await planRouteWithFallback(decision, {
    routeOnce,
    fastRoute: async () => (await fastBm25Business(brief)).slug,
    onRouterFailure: harnessConfig.routing.on_router_failure,
    strictRoute,
    isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY && !noColor,
    audit: (event, payload) => emit(event, { project_id: projectId || null, ...payload }),
    log: m => console.log(c("dim", `  ${m}`)),
    warn: m => console.error(c("yellow", `  ⚠ ${m}`)),
  });
  if (!plan.ok) {
    console.error(c("red", `✗ --auto: ${plan.error || "no dispatchable plan"}. Nomeie a empresa ou o squad.`));
    process.exit(1);
  }

  const step = plan.steps[0];
  if (step.kind === "business") {
    slug = step.slug!;
    autoMandatorySquads = plan.mandatorySquads;
    const cost = decision.cost_usd != null ? ` · $${decision.cost_usd.toFixed(4)}` : "";
    console.log(c("lime", "  →") + c("bold", ` ${slug}`) + c("dim", ` (${plan.source}${decision.ok ? ` · ${decision.duration_ms}ms${cost}` : ""})`));
    if (autoMandatorySquads.length) console.log(c("dim", `  mandatory squads: ${autoMandatorySquads.join(", ")}`));
    if (plan.optionalSquads.length) console.log(c("dim", `  optional squads: ${plan.optionalSquads.join(", ")}`));
    if (plan.rationale) console.log(c("dim", `  rationale: ${plan.rationale}`));
    emit("auto_route_selected", { project_id: projectId || null, business_slug: slug, method: "agentic", source: plan.source, mandatory_squads: autoMandatorySquads, optional_squads: plan.optionalSquads });
  } else if (step.kind === "squad") {
    const squads = plan.steps.filter(s => s.kind === "squad").map(s => s.slug!) as string[];
    console.log(c("lime", "  →") + c("bold", ` rota squad-only: ${squads.join(", ")}`) + c("dim", ` (${plan.source})`));
    if (plan.rationale) console.log(c("dim", `  rationale: ${plan.rationale}`));
    emit("auto_route_selected", { project_id: projectId || null, business_slug: null, method: "agentic", source: plan.source, squad_only: true, mandatory_squads: squads, optional_squads: plan.optionalSquads });
    pendingCascade = { kind: "squad-only", squads, plan };
  } else {
    console.log(c("yellow", "  →") + c("bold", " rota agent-x (generalista)") + c("dim", ` (${plan.source}: ${step.reason})`));
    emit("auto_route_selected", { project_id: projectId || null, business_slug: null, method: "agentic", source: plan.source, agent_x: true, reason: step.reason });
    pendingCascade = { kind: "agent-x", reason: step.reason, plan };
  }
}

// --auto-brief: deterministically enrich a thin brief so the headless agent can
// decide for the human. Inferred assumptions are appended to the brief and the
// agent surfaces them under "Premissas assumidas" in the output (correct later
// via `nrv revise`).
if (wantAutoBrief) {
  if (autoBriefMode === "proxy" || autoBriefMode === "llm") {
    // LLM "informed client" — interviews + answers on the human's behalf.
    const pr = proxyEnrichBrief(brief, slug, normRuntime(runtime || "claude-code"), {
      maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
    });
    if (pr.ok && pr.enriched) {
      brief = pr.enriched;
      console.log(c("dim", `  [auto-brief=proxy] briefing enriquecido por proxy (${pr.enriched.length} chars)`));
      emit("brief_proxy_enriched", { business_slug: slug, chars: pr.enriched.length });
    } else {
      console.error(c("yellow", `  [auto-brief=proxy] falhou (${pr.error}); caindo para inferência determinística`));
      try {
        const decision = amplify(brief, { mode: "inferred" });
        if (decision.action === "infer") brief = decision.inferred_brief;
      } catch { /* keep raw brief */ }
    }
  } else {
    try {
      const decision = amplify(brief, { mode: "inferred" });
      if (decision.action === "infer") {
        brief = decision.inferred_brief;
        console.log(c("dim", `  [auto-brief] ${decision.assumptions.length} premissa(s) inferida(s); brief enriquecido`));
        emit("brief_amplified", { business_slug: slug, mode: "inferred", assumptions: decision.assumptions.length, score: decision.score.total });
      } else if (decision.action === "skip") {
        console.log(c("dim", `  [auto-brief] brief já rico (score ${decision.score.total}); sem inferência`));
      }
    } catch (e: any) {
      console.error(c("yellow", `  [auto-brief] amplifier falhou (${e?.message || e}); usando brief original`));
    }
  }
}

const SKILLS = process.env.NIRVANA_SKILLS_DIR || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));
const briefBiz = path.join(SKILLS, "businesses/scripts/brief-business.ts");
const employeePrompt = path.join(SKILLS, "businesses/lib/employee-prompt.ts");
const gateScriptPath = path.join(SKILLS, "harness/scripts/quality-gate.ts");
const verifyScriptPath = path.join(SKILLS, "businesses/scripts/verify-deliverable.ts");

// Shared delivery-pipeline invocation for all three cascade paths.
function deliver(opts: {
  pid: string; slugOrNull: string | null; targetKind: "business" | "squad" | "agent-x";
  rt: Runtime; oroot: string; projDir: string; projectRoot: string;
  sessionId: string | null; withManifest: boolean;
  afterGate?: Parameters<typeof runDelivery>[0]["afterGate"];
  onSession?: (sid: string) => void;
}): DeliveryResult {
  return runDelivery({
    brief: brief!,
    outputsRoot: opts.oroot,
    manifest: opts.withManifest ? (manifest ?? null) : null,
    pid: opts.pid,
    slug: opts.slugOrNull,
    targetKind: opts.targetKind,
    runtime: opts.rt,
    projectDir: opts.projDir,
    projectRoot: opts.projectRoot,
    workingDir: process.cwd(),
    sessionId: opts.sessionId,
    maxRevisions,
    maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
    timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
    yolo,
    rulesDirective,
    forceDeliver,
    config: harnessConfig,
    ledger: ledgerRunId ? { handle: ledgerHandle!, runId: ledgerRunId } : null,
    audit: emit,
    afterGate: opts.afterGate,
    onSession: opts.onSession,
    verifyScript: verifyScriptPath,
    gateScript: gateScriptPath,
    log: (l) => console.log(c("dim", l)),
    warn: (l) => console.error(c("yellow", l)),
  });
}

function printDeliverySummary(res: DeliveryResult, pid: string, oroot: string, zipPath: string | null): void {
  console.log("");
  if (res.exitCode === 0) {
    console.log(c("green", "✓ Autopilot completo."));
  } else if (res.exitCode === 2) {
    console.log(c("yellow", "⚠ Entrega RETIDA — quality gate reprovou após as revisões (exit 2)."));
    console.log(c("dim", "  Os artefatos ficam no disco; nada foi marcado como entregue."));
  } else if (res.exitCode === 3) {
    console.log(c("yellow", "⚠ Entrega INDETERMINADA — nenhum artefato gateável foi produzido (exit 3)."));
  } else {
    console.log(c("red", "✗ Entrega falhou."));
  }
  console.log(c("dim", `  Project ID:   ${pid}`));
  console.log(c("dim", `  Deliverables: ${oroot}`));
  if (zipPath) console.log(c("dim", `  Zip:          ${zipPath}`));
  console.log("");
  console.log(c("cyan", "  Pedir alterações (mantém a sessão):"));
  console.log("    " + c("yellow", `nrv revise ${pid} "<mudança>"`));
  if (res.exitCode === 2) {
    console.log(c("cyan", "  Entregar mesmo assim (consciente):"));
    console.log("    " + c("yellow", "re-rode com --force-deliver"));
  }
  console.log(c("cyan", "  Limpar todo o scaffold:"));
  console.log("    " + c("yellow", `nrv clean ${pid}`));
  console.log("");
}

// ── SQUAD-ONLY ROUTE — dispatch the squad(s) for real (Phase 4.1) ─────────
// Pre-Phase-4 this printed shell instructions and exited 0 WITHOUT
// dispatching. Now: scaffold via brief-squad.ts (validates the manifest,
// emits brief_received + dispatch_squad), then — in exec mode — run each
// squad through squad-exec and the shared delivery pipeline.
if (pendingCascade?.kind === "squad-only") {
  const squads = pendingCascade.squads;
  const rt = runtimeDecision.runtime;
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const pid = projectId || `proj-${ts}-${squads[0]}`;
  const briefSquadScript = path.join(SKILLS, "squads/scripts/brief-squad.ts");

  console.log(c("lime", "▶") + c("bold", ` Squad-only — scaffold (${squads.length} squad(s))`));
  let projDir: string | null = null;
  for (const sq of squads) {
    const r = spawnSync("bun", [briefSquadScript, sq, brief, "--project", pid], { encoding: "utf8" });
    if (r.status !== 0) {
      console.error(c("red", `✗ brief-squad falhou para '${sq}':`));
      console.error(r.stdout || r.stderr);
      process.exit(1);
    }
    const dir = r.stdout.match(/Project dir:\s+(\S+)/)?.[1];
    if (!projDir && dir) projDir = dir;
    console.log(c("dim", `  ✓ ${sq} scaffolded`));
  }
  if (!projDir) {
    console.error(c("red", "✗ não consegui parsear o Project dir do brief-squad"));
    process.exit(1);
  }
  const projectRoot = path.resolve(projDir, "..", "..");   // <outputs>/<pid>
  dispatchAudit.bindProjectRoot(projDir);

  if (!wantExec) {
    console.log("");
    console.log(c("cyan", "  Scaffold pronto (sem --exec). Para executar:"));
    console.log("    " + c("yellow", `nrv dispatch --auto "${brief.slice(0, 60)}…" --exec`));
    console.log("    " + c("yellow", `# ou manualmente: bun ${briefSquadScript} <squad> "<brief>"`));
    console.log("");
    console.log(c("green", "✓ Ready. Project ID: " + pid));
    process.exit(0);
  }

  if (!runtimeAvailable(rt)) {
    console.error(c("red", `✗ runtime '${rt}' não está no PATH. Instale-o ou use --runtime=claude-code.`));
    emit("agent_exec_failed", { trace_id: pid, project_id: pid, squad_slug: squads[0], runtime: rt, reason: "runtime not on PATH" });
    process.exit(1);
  }
  const oroot = outputsRoot || path.join(projectRoot, "deliverables");
  fs.mkdirSync(oroot, { recursive: true });
  ledgerTry(() => {
    ledgerHandle = runLedger.openLedger();
    const row = runLedger.openRun(ledgerHandle, {
      traceId: pid, projectId: pid, targetSlug: squads.join(","), targetKind: "squad",
      runtime: rt, childPid: process.pid,
      meta: { project_dir: projDir, project_root: projectRoot, outputs_root: oroot, mode: "squad-only" },
    });
    ledgerRunId = row.run_id;
  });
  if (ledgerRunId) ledgerTry(() => runLedger.markState(ledgerHandle!, ledgerRunId!, "running", { childPid: process.pid }));

  console.log(c("lime", "▶") + c("bold", ` Squad-only — exec headless (${rt})`));
  let lastSession: string | null = null;
  for (const sq of squads) {
    const outDir = squads.length > 1 ? path.join(oroot, sq) : oroot;
    const r = runSquadHeadless({
      squadSlug: sq, brief, projectId: pid, projectDir: projDir, projectRoot,
      outputsDir: outDir, runtime: rt, businessSlug: null, mode: "squad-only",
      maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
      timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
      rulesDirective, autonomousDirective: AUTONOMOUS_DIRECTIVE,
      ...(ledgerRunId ? { ledger: { runId: ledgerRunId, watchDir: outDir } } : {}),
    });
    if (!r.ok) {
      console.error(c("red", `✗ squad '${sq}' falhou: ${r.error}`));
      emit("agent_exec_failed", { trace_id: pid, project_id: pid, squad_slug: sq, runtime: rt, error: r.error });
      if (ledgerRunId) ledgerTry(() => runLedger.markState(ledgerHandle!, ledgerRunId!, "failed", { error: `squad ${sq}: ${r.error}` }));
      process.exit(1);
    }
    lastSession = r.sessionId ?? lastSession;
    console.log(c("dim", `  · ${sq}: ${r.durationMs}ms${r.costUsd != null ? ` · $${r.costUsd.toFixed(4)}` : ""}`));
  }
  if (ledgerRunId && lastSession) ledgerTry(() => runLedger.recordSession(ledgerHandle!, ledgerRunId!, lastSession));

  console.log(c("lime", "▶") + c("bold", " Delivery pipeline — verify → gate → deliver"));
  const res = deliver({
    pid, slugOrNull: null, targetKind: "squad", rt, oroot,
    projDir, projectRoot, sessionId: lastSession, withManifest: false,
  });
  printDeliverySummary(res, pid, oroot, null);
  process.exit(res.exitCode);
}

// ── AGENT-X ROUTE — the cascade bottom delivers (Phase 4.1) ───────────────
// NO_MATCH (and unresolvable router failures) used to exit 1 — a contract
// inversion of SKILL.md's cascade step 3. Now the generalist runs with the
// gap named, and its output goes through the SAME delivery pipeline.
if (pendingCascade?.kind === "agent-x") {
  const rt = runtimeDecision.runtime;
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const pid = projectId || `proj-${ts}-agent-x`;
  const base = path.join(process.cwd(), "outputs", pid);
  const projDir = path.join(base, "agent-x");
  fs.mkdirSync(projDir, { recursive: true });
  const briefPath = path.join(base, "brief-enriched.md");
  fs.writeFileSync(briefPath, brief, "utf8");
  dispatchAudit.bindProjectRoot(projDir);
  emit("brief_received", { trace_id: pid, project_id: pid, target: "agent-x", brief_chars: brief.length });

  if (!wantExec) {
    console.log("");
    console.log(c("cyan", "  Scaffold agent-x pronto (sem --exec). Brief enriquecido em:"));
    console.log("    " + c("yellow", briefPath));
    console.log(c("cyan", "  Para executar:"));
    console.log("    " + c("yellow", `nrv dispatch --auto "<brief>" --exec`));
    console.log("");
    console.log(c("green", "✓ Ready. Project ID: " + pid));
    process.exit(0);
  }

  if (!runtimeAvailable(rt)) {
    console.error(c("red", `✗ runtime '${rt}' não está no PATH. Instale-o ou use --runtime=claude-code.`));
    emit("agent_exec_failed", { trace_id: pid, project_id: pid, employee: "agent-x", runtime: rt, reason: "runtime not on PATH" });
    process.exit(1);
  }
  const oroot = outputsRoot || path.join(base, "deliverables");
  fs.mkdirSync(oroot, { recursive: true });
  ledgerTry(() => {
    ledgerHandle = runLedger.openLedger();
    const row = runLedger.openRun(ledgerHandle, {
      traceId: pid, projectId: pid, targetSlug: "agent-x", targetKind: "agent-x",
      runtime: rt, childPid: process.pid,
      meta: { project_dir: projDir, project_root: base, outputs_root: oroot, mode: "agent-x" },
    });
    ledgerRunId = row.run_id;
  });
  if (ledgerRunId) ledgerTry(() => runLedger.markState(ledgerHandle!, ledgerRunId!, "running", { childPid: process.pid }));

  console.log(c("lime", "▶") + c("bold", ` Agent-x — exec headless (${rt})`));
  const r = runAgentX({
    brief, briefPath, runtime: rt, projectId: pid,
    projectDir: projDir, projectRoot: base, outputsRoot: oroot,
    reason: pendingCascade.reason,
    appendSystemPrompt: AUTONOMOUS_DIRECTIVE + rulesDirective,
    maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
    timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
    yolo,
    ...(ledgerRunId ? { ledger: { runId: ledgerRunId, watchDir: oroot } } : {}),
    audit: emit,
  });
  if (!r.ok) {
    console.error(c("red", `✗ agent-x falhou (exit ${r.exitCode}): ${r.error || r.stderr || "unknown"}`));
    emit("agent_exec_failed", { trace_id: pid, project_id: pid, employee: "agent-x", runtime: rt, exit_code: r.exitCode, error: r.error || r.stderr });
    if (ledgerRunId) ledgerTry(() => runLedger.markState(ledgerHandle!, ledgerRunId!, "failed", { error: r.error || r.stderr || `exit ${r.exitCode}` }));
    process.exit(1);
  }
  console.log(c("dim", `  session: ${r.sessionId || "(none)"} · ${r.durationMs}ms${r.costUsd != null ? ` · $${r.costUsd.toFixed(4)}` : ""}`));
  if (ledgerRunId) ledgerTry(() => runLedger.recordSession(ledgerHandle!, ledgerRunId!, r.sessionId));

  console.log(c("lime", "▶") + c("bold", " Delivery pipeline — verify → gate → deliver"));
  const res = deliver({
    pid, slugOrNull: null, targetKind: "agent-x", rt, oroot,
    projDir, projectRoot: base, sessionId: r.sessionId, withManifest: false,
  });
  printDeliverySummary(res, pid, oroot, null);
  process.exit(res.exitCode);
}

if (!fs.existsSync(briefBiz)) {
  console.error(c("red", `ERRO: brief-business.ts não encontrado em ${briefBiz}`));
  console.error("Rode `nrv install --bootstrap` para reinstalar o Nirvana.");
  process.exit(1);
}

// Step 1 — brief-business
console.log(c("lime", "▶") + c("bold", " Step 1/4 — brief-business.ts"));
const args = [briefBiz, slug, brief];
if (projectId) args.push("--project", projectId);
if (manifest) args.push("--manifest", manifest);
const r1 = spawnSync("bun", args, { encoding: "utf8" });
if (r1.status !== 0) {
  console.error(c("red", "✗ brief-business failed:"));
  console.error(r1.stdout || r1.stderr);
  process.exit(1);
}
console.log(r1.stdout);

// Parse the output to extract Project ID + Intake + Project Dir
const stdout = r1.stdout;
const pid = stdout.match(/Project ID:\s+(\S+)/)?.[1];
const intake = stdout.match(/Intake:\s+(\S+)/)?.[1];
const projDir = stdout.match(/Project dir:\s+(\S+)/)?.[1];
if (!pid || !intake || !projDir) {
  console.error(c("red", "✗ Não consegui parsear output do brief-business"));
  process.exit(1);
}

// Step 2 — build employee prompt
console.log(c("lime", "▶") + c("bold", ` Step 2/4 — buildEmployeePrompt (${intake}@${slug})`));
// brief-business writes brief.md at the project root (parent of businesses/<slug>/), not inside the business subdir
const projectRoot = path.resolve(projDir, "..", "..");
// In exec mode the agent writes deliverables here (a clean subfolder export
// includes but the scaffold dirs handoffs/tickets/employees are excluded).
const execOutputsRoot = outputsRoot || (wantExec ? path.join(projDir, "deliverables") : undefined);
if (execOutputsRoot && wantExec) fs.mkdirSync(execOutputsRoot, { recursive: true });
const tmpBriefFile = path.join(projectRoot, "brief.md");
if (!fs.existsSync(tmpBriefFile)) {
  console.error(c("red", `✗ brief.md not found at ${tmpBriefFile}`));
  process.exit(1);
}
const buildArgs = [employeePrompt, slug, intake, projDir, tmpBriefFile];
if (execOutputsRoot) buildArgs.push(execOutputsRoot);
const r2 = spawnSync("bun", buildArgs, { encoding: "utf8" });
if (r2.status !== 0) {
  console.error(c("red", "✗ employee-prompt failed:"));
  console.error(r2.stderr);
  process.exit(1);
}

const outputPath = path.join(projDir, "agent-prompt.md");
fs.writeFileSync(outputPath, r2.stdout);

const promptSize = r2.stdout.length;
const dnaCount = (r2.stdout.match(/^--- MIND-CLONE:/gm) || []).length;
console.log(c("dim", `  Prompt: ${promptSize.toLocaleString()} chars · ${dnaCount} mind-clones injected`));
console.log(c("dim", `  Saved to: ${outputPath}`));

// Step 3 — dispatch_business audit event. From here on we know projDir:
// bind the audit facade to the project root (pre-projDir events are replayed
// there, flagged replayed_from_global — the split-root fix).
dispatchAudit.bindProjectRoot(projDir);
// Dispatch ledger — open the run BEFORE exec, so a crash anywhere between
// here and delivery leaves a non-terminal row the supervisor can recover.
// Scaffold-only mode opens nothing (there is no execution to supervise).
if (wantExec) {
  ledgerTry(() => {
    ledgerHandle = runLedger.openLedger();
    const row = runLedger.openRun(ledgerHandle, {
      traceId: pid, projectId: pid, targetSlug: slug, targetKind: "business",
      runtime: runtimeDecision.runtime, childPid: process.pid,
      // Team runs have no heartbeat sidecar (steps run inside the
      // orchestrator), so their initial lease covers the whole run budget.
      initialLeaseSec: wantTeam
        ? Math.floor(((timeoutMin ? parseInt(timeoutMin, 10) * 60_000 : LEDGER_DEFAULT_TIMEOUT_MS) + 5 * 60_000) / 1000)
        : 900,
      meta: {
        project_dir: projDir, project_root: projectRoot,
        outputs_root: execOutputsRoot ?? null,
        prompt_path: outputPath, brief_path: tmpBriefFile,
        mode: wantTeam ? "team" : "single",
      },
    });
    ledgerRunId = row.run_id;
  });
}
console.log(c("lime", "▶") + c("bold", " Step 3/4 — emit dispatch_business audit"));
emit("dispatch_business", {
  trace_id: pid,
  project_id: pid,
  business_slug: slug,
  employee: intake,
  // Honest mode: this standalone script either scaffolds only, or shells out to
  // a headless child runtime via --exec. The TRUE in-process subagent path is
  // the maestro calling the runtime's native subagent (Agent tool / codex
  // [agents] / antigravity dynamic subagents) — documented in the adapters,
  // NOT this script. So never claim "subagent-inline" here.
  mode: wantExec ? "headless-subprocess" : "scaffold-only",
  runtime: runtimeDecision.runtime,
  runtime_source: runtimeDecision.source,
  dna_files_injected: dnaCount,
  prompt_size_chars: promptSize,
});
console.log(c("dim", `  ✓ dispatch_business written to ${path.join(harnessLogsDir({ cwd: projDir }), new Date().toISOString().slice(0, 10))}/audit.jsonl`));

// ── EXEC MODE — actually run the runtime headless, then verify+gate+deliver ─
if (wantExec) {
  // Final runtime: the flag > USE_* rule > current host decision (already computed).
  const rt = runtimeDecision.runtime;
  const oroot = execOutputsRoot as string;

  console.log("");
  console.log(c("lime", "▶") + c("bold", ` Step 4/7 — exec ${wantTeam ? "team-chain" : "headless"} (${rt})`));
  if (!runtimeAvailable(rt)) {
    console.error(c("red", `✗ runtime '${rt}' não está no PATH. Instale-o ou use --runtime=claude-code.`));
    emit("agent_exec_failed", { trace_id: pid, project_id: pid, business_slug: slug, runtime: rt, reason: "runtime not on PATH" });
    if (ledgerRunId) ledgerTry(() => runLedger.markState(ledgerHandle!, ledgerRunId!, "failed", { error: "runtime not on PATH" }));
    process.exit(1);
  }
  if (ledgerRunId) ledgerTry(() => runLedger.markState(ledgerHandle!, ledgerRunId!, "running", { childPid: process.pid }));

  // res = unified result shape consumed by the delivery pipeline below.
  let res: { ok: boolean; sessionId: string | null; durationMs: number; costUsd: number | null; exitCode?: number; error?: string; stderr?: string };

  if (wantTeam) {
    const tr = runTeam({
      slug, brief, projectId: pid, projectDir: projDir, projectRoot, outputsRoot: oroot,
      runtime: rt, intakeEmployee: intake,
      mandatorySquads: autoMandatorySquads,
      maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
      timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
      rulesDirective,
    });
    if (!tr.ok) {
      console.error(c("red", `✗ team falhou: ${tr.error}`));
      emit("agent_exec_failed", { trace_id: pid, project_id: pid, business_slug: slug, runtime: rt, mode: "team", error: tr.error });
      if (ledgerRunId) ledgerTry(() => runLedger.markState(ledgerHandle!, ledgerRunId!, "failed", { error: `team failed: ${tr.error}` }));
      process.exit(1);
    }
    console.log(c("green", `  ✓ time orquestrado: ${tr.chain.length} steps`));
    for (const s of tr.steps) {
      console.log(c("dim", `    · ${s.employee}: ${s.durationMs}ms${s.costUsd != null ? ` · $${s.costUsd.toFixed(4)}` : ""}`));
    }
    console.log(c("dim", `  total: ${tr.totalDurationMs}ms · $${tr.totalCostUsd.toFixed(4)}`));
    res = { ok: true, sessionId: tr.lastSessionId, durationMs: tr.totalDurationMs, costUsd: tr.totalCostUsd };
  } else {
    const agentPrompt = fs.readFileSync(outputPath, "utf8");
    // runWithCascade falls through to plain runHeadless when LLM_CASCADE is not set
    // in the project .env, so non-cascade users see no behavioral change.
    res = runWithCascade({
      runtime: rt,
      prompt: agentPrompt,
      cwd: projDir,
      addDirs: [projectRoot],
      appendSystemPrompt: AUTONOMOUS_DIRECTIVE + rulesDirective,
      maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
      timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
      yolo,
      brief, projectRoot, outputsRoot: oroot,
      taskHint: `single-shot dispatch · ${slug}/${intake}`,
      projectId: pid,
      // Ledger heartbeat: the sidecar renews the lease while the child shows
      // activity (stdout/stderr growth or output-dir mtime advance).
      ...(ledgerRunId ? { ledger: { runId: ledgerRunId, watchDir: oroot } } : {}),
    });
    if (!res.ok) {
      console.error(c("red", `✗ exec falhou (exit ${res.exitCode}): ${res.error || res.stderr || "unknown"}`));
      emit("agent_exec_failed", { trace_id: pid, project_id: pid, business_slug: slug, runtime: rt, exit_code: res.exitCode, error: res.error || res.stderr });
      if (ledgerRunId) ledgerTry(() => runLedger.markState(ledgerHandle!, ledgerRunId!, "failed", { error: res.error || res.stderr || `exit ${res.exitCode}` }));
      process.exit(1);
    }
    console.log(c("dim", `  session: ${res.sessionId || "(none)"} · ${res.durationMs}ms${res.costUsd != null ? ` · $${res.costUsd.toFixed(4)}` : ""}`));
  }

  // session.json — lets `nrv revise` resume the same conversation and `nrv clean` find everything.
  const sessionFile = path.join(projDir, "session.json");
  const sessionData: Record<string, any> = {
    project_id: pid, business_slug: slug, employee: intake, runtime: rt,
    session_id: res.sessionId, project_dir: projDir, project_root: projectRoot,
    outputs_root: oroot, zip_path: null, created_at: new Date().toISOString(),
  };
  fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
  // Session id into the ledger so the supervisor can resume this conversation.
  if (ledgerRunId) ledgerTry(() => runLedger.recordSession(ledgerHandle!, ledgerRunId!, res.sessionId ?? null));
  // In team mode each step emitted its own agent_executed; skip the parent-level
  // emit to avoid double counting. In single-shot mode, audit the parent run.
  if (!wantTeam) {
    emit("agent_executed", { trace_id: pid, project_id: pid, business_slug: slug, employee: intake, runtime: rt, session_id: res.sessionId, cost_usd: res.costUsd, duration_ms: res.durationMs });
  }

  // Advance HANDOFF to complete (one-shot autopilot).
  try {
    const { updateHandoffPhase } = requireCjs(path.join(SKILLS, "_shared", "lib", "handoff.js"));
    updateHandoffPhase(projDir, "complete", { lastTaskCompleted: "headless exec", decisions: [`autopilot run via ${rt}`] });
  } catch { /* non-fatal */ }

  // Steps 5-7 — delivery pipeline (verify → gate → deliver), fail-closed.
  // Extracted to lib/delivery-pipeline.ts (Phase 4.2); PDF/HTML/zip run in
  // the afterGate hook, ONLY when delivery actually proceeds.
  console.log(c("lime", "▶") + c("bold", " Steps 5-7 — delivery pipeline (verify → gate → deliver)"));
  let zipPathOut: string | null = null;

  const afterGate = (): { zipPath: string | null } => {
    // Step 6.5 — optional PDF report. The report-publisher employee (LLM, no
    // shell) writes relatorio/resumo-executivo.md + relatorio/order.json; the
    // harness then runs build-report-pdf.ts to produce relatorio-final.pdf
    // inside deliverables/ (so it lands in the --deliverables-only zip).
    if (wantPdf) {
      // Build script: the business's own (if it ships one) else the shared harness
      // script. Publisher: the business's report-publisher employee (if any) else a
      // generic inline publisher prompt. So --pdf works for ANY business.
      const bizHome = path.join(os.homedir(), "businesses", slug);
      const bizBuild = path.join(bizHome, "scripts", "build-report-pdf.ts");
      const buildScript = fs.existsSync(bizBuild) ? bizBuild : path.join(SKILLS, "harness/scripts/build-report-pdf.ts");
      const pubEmployee = path.join(bizHome, "employees", "report-publisher.md");
      const hasPublisher = fs.existsSync(pubEmployee);
      if (!fs.existsSync(buildScript)) {
        console.log(c("yellow", `  ⚠ --pdf: build-report-pdf.ts não encontrado; pulando PDF`));
      } else {
        console.log(c("lime", "▶") + c("bold", ` Step 6.5 — relatório PDF (${hasPublisher ? "report-publisher" : "publisher genérico"})`));
        const relatorioDir = path.join(projDir, "relatorio");
        fs.mkdirSync(relatorioDir, { recursive: true });
        const summaryPath = path.join(relatorioDir, "resumo-executivo.md");
        const orderPath = path.join(relatorioDir, "order.json");
        const pubBrief = [
          "Você é o publicador do relatório final. Compile a entrega.",
          `Leia TODOS os arquivos .md em: ${oroot}`,
          "",
          "Escreva EXATAMENTE dois arquivos (use a ferramenta Write, não rode shell):",
          `1. ${summaryPath} — resumo executivo fiel (markdown), que vai na capa do PDF.`,
          `2. ${orderPath} — JSON: {"title": "...", "subtitle": "...", "client": "...", "summary_file": "${summaryPath}", "order": ["arquivo1.md", "arquivo2.md", ...]}`,
          "   - order = nomes dos .md em " + oroot + " na sequência ideal (resposta direta primeiro, depois análise, base e anexos).",
          "Não invente conclusão nem fonte. Apenas sintetize e ordene.",
        ].join("\n");
        const pubBriefFile = path.join(relatorioDir, ".publisher-brief.md");
        fs.writeFileSync(pubBriefFile, pubBrief);

        // Prompt: DNA-injected employee persona if the business has one, else the
        // self-contained generic brief above.
        let pubPrompt = pubBrief;
        if (hasPublisher) {
          const ep = spawnSync("bun", [employeePrompt, slug, "report-publisher", projDir, pubBriefFile, relatorioDir], { encoding: "utf8" });
          if (ep.status === 0 && ep.stdout) pubPrompt = ep.stdout;
          else console.error(c("yellow", `  ⚠ prompt do report-publisher falhou; usando publisher genérico`));
        }
        {
          const pubRes = runHeadless({
            runtime: rt, prompt: pubPrompt, cwd: projDir, addDirs: [projectRoot],
            appendSystemPrompt: AUTONOMOUS_DIRECTIVE + rulesDirective,
            maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
            timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined, yolo,
          });
          emit("report_publisher_ran", { trace_id: pid, project_id: pid, business_slug: slug, ok: pubRes.ok, publisher: hasPublisher ? "employee" : "generic" });

          // Assemble the PDF into deliverables/ so the zip includes it.
          const pdfOut = path.join(oroot, "relatorio-final.pdf");
          const pdfArgs = [buildScript, "--deliverables", oroot, "--output", pdfOut];
          if (fs.existsSync(summaryPath)) pdfArgs.push("--summary", summaryPath);
          let title = `Relatório — ${pid}`, subtitle = "", clientName = "", brand = slug;
          if (fs.existsSync(orderPath)) {
            try {
              const meta = JSON.parse(fs.readFileSync(orderPath, "utf8"));
              if (Array.isArray(meta.order) && meta.order.length) pdfArgs.push("--order", meta.order.join(","));
              if (meta.title) title = meta.title;
              if (meta.subtitle) subtitle = meta.subtitle;
              if (meta.client) clientName = meta.client;
              if (meta.brand) brand = meta.brand;
            } catch { /* use defaults */ }
          }
          pdfArgs.push("--title", title, "--brand", brand);
          if (subtitle) pdfArgs.push("--subtitle", subtitle);
          if (clientName) pdfArgs.push("--client", clientName);
          const pdf = spawnSync("bun", pdfArgs, { encoding: "utf8" });
          if (pdf.status === 0 && fs.existsSync(pdfOut)) {
            console.log(c("green", `  ✓ PDF: ${pdfOut} (${(fs.statSync(pdfOut).size / 1024).toFixed(1)} KB)`));
            emit("report_pdf_generated", { trace_id: pid, project_id: pid, business_slug: slug, output: pdfOut });
          } else {
            console.error(c("yellow", `  ⚠ build-report-pdf falhou: ${(pdf.stdout || "") + (pdf.stderr || "")}`));
          }
        }
      }
    }

    // Step 6.6 — HTML report (DEFAULT; skipped only in fast mode or with --no-html).
    // Renders every project markdown into an Apple-style HTML. Lands in deliverables/
    // so the --zip bundle picks it up. --offline-snapshot produces a 100% offline copy.
    if (!skipHtml) {
      console.log(c("lime", "▶") + c("bold", " Step 6.6 — relatório HTML"));
      const htmlBuild = path.join(SKILLS, "harness/scripts/build-report-html.ts");
      const htmlOut = path.join(oroot, "relatorio-final.html");
      const htmlArgs = [htmlBuild, "--project", projDir, "--output", htmlOut, "--title", `Relatório — ${slug}`];
      if (process.argv.includes("--offline-snapshot")) htmlArgs.push("--offline-snapshot");
      const h = spawnSync("bun", htmlArgs, { encoding: "utf8", stdio: "inherit" });
      if (h.status === 0) emit("report_html_generated", { trace_id: pid, project_id: pid, business_slug: slug, output: htmlOut });
      else console.error(c("yellow", `  ⚠ build-report-html falhou (rc=${h.status})`));
    } else if (routingMode === "fast") {
      emit("report_skipped_fast", { trace_id: pid, project_id: pid, business_slug: slug });
    }

    // Step 7 — export .zip
    let zipPath: string | null = null;
    if (wantZip) {
      console.log(c("lime", "▶") + c("bold", " Step 7/7 — export .zip"));
      const exportScript = path.join(SKILLS, "harness/scripts/export.ts");
      const out = path.resolve(`./${pid}.zip`);
      const z = spawnSync("bun", [exportScript, pid, "--format=zip", "--deliverables-only", `--output=${out}`], { encoding: "utf8", stdio: "inherit" });
      if (z.status === 0) {
        zipPath = out;
        sessionData.zip_path = out;
        fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
      } else {
        console.error(c("yellow", "  ⚠ export falhou (entregáveis estão na pasta do projeto)"));
      }
    }
    zipPathOut = zipPath;
    return { zipPath };
  };

  const delivery = deliver({
    pid, slugOrNull: slug, targetKind: "business", rt, oroot,
    projDir, projectRoot, sessionId: res.sessionId, withManifest: true,
    afterGate,
    onSession: (sid) => {
      res.sessionId = sid;
      sessionData.session_id = sid;
      fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
    },
  });

  printDeliverySummary(delivery, pid, oroot, zipPathOut);
  // Fail-closed exit contract: 0 delivered · 2 withheld (gate fail) ·
  // 3 indeterminate (nothing gateable) · 1 verify/exec failure.
  process.exit(delivery.exitCode);
}

// Step 4 — actionable next step
console.log("");
console.log(c("lime", "▶") + c("bold", " Step 4/4 — next steps"));
console.log("");
console.log(c("cyan", "  Copie o prompt completo e cole no seu runtime:"));
console.log("");
console.log("    " + c("yellow", `cat ${outputPath} | pbcopy        # macOS`));
console.log("    " + c("yellow", `cat ${outputPath} | xclip         # Linux`));
console.log("    " + c("yellow", `type ${outputPath} | clip         # Windows`));
console.log("");
console.log(c("cyan", "  Ou abra o cockpit:"));
console.log("    " + c("yellow", `nrv glance --allow-actions`));
console.log("");
console.log(c("cyan", "  Para validar quando terminar:"));
console.log("    " + c("yellow", `bun ~/.nirvana/skills/businesses/scripts/verify-deliverable.ts ${pid} ${slug}`));
console.log("    " + c("yellow", `bun ~/.nirvana/skills/harness/scripts/validate-chain.ts ${pid} --strict`));
console.log("");
console.log(c("green", "✓ Ready. Project ID: " + pid));

process.exit(0);

} // end if (import.meta.main) — CLI flow guard
