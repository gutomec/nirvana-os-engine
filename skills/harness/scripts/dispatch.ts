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
//   0 = delivered (gate pass, or --force-deliver)
//   1 = run failed (routing / exec / verify failure)
//   2 = delivery WITHHELD — gate failed after the revision budget
//   3 = delivery INDETERMINATE — nothing was judged: zero gateable artifacts,
//       or a scaffold-only run (no --exec) that dispatched nothing at all
//   4 = invalid args (EXIT.INVALID_ARGS per SCRIPT_CONTRACT; was 2)
//
// 0 means DELIVERED, and only that. A scaffold-only run prepares the prompt
// and stops — it delivers nothing and judges nothing — so it exits 3 on every
// path (business, squad-only, agent-x), never 0: `nrv dispatch … && publish`
// must not publish a run that never executed.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { runHeadless, runtimeAvailable, AUTONOMOUS_DIRECTIVE, LEDGER_DEFAULT_TIMEOUT_MS, type Runtime } from "../lib/host-agent-driver.ts";
import { listRuntimes } from "../../_shared/lib/host-agent-driver.ts";
import { amplify } from "../lib/amplifier.ts";
import { proxyEnrichBrief } from "../lib/brief-proxy.ts";
import { resolveRoutingMode } from "../../_shared/lib/routing-mode.ts";
import { runTeam } from "../lib/team-orchestrator.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { agenticRoute, type AgenticRouteDecision } from "../lib/agentic-router.ts";
import { runWithCascade } from "../lib/cascade-runner.ts";
import { resolveCascadeRoot, loadCascade, nextAfter } from "../lib/cascade.ts";
import { classify } from "../lib/quota-detector.ts";
import { isInCooldown, getCooldown, markCooldown } from "../lib/cooldown-registry.ts";
import { loadRuntimeRules, decideRuntime, detectCurrentHost, formatRulesForDirective, resolveDefaultRuntime, type RuntimeDecision } from "../lib/runtime-rules.ts";
import { preflightReindex } from "../lib/preflight-index.ts";
import { maybeSweep } from "./supervisor.ts";
import * as runLedger from "../lib/run-ledger.ts";
import { loadHarnessConfig } from "../lib/harness-config.ts";
import { planRouteWithFallback, resolveDispatchPlan, runAgentX, type DispatchPlan } from "../lib/dispatch-cascade.ts";
import { runSquadHeadless } from "../lib/squad-exec.ts";
import { runDelivery, deliverAfterRuntimeError, gateableFiles, runGateOnce, type DeliveryArgs, type DeliveryResult, type RuntimeErrorOutcome } from "../lib/delivery-pipeline.ts";
import { runBusinessPostGate } from "../lib/business-post-gate.ts";
import { parseExecutionOptions } from "../lib/gauntlet/execution-options.ts";
import { decideBusinessCanary, runBusinessCanaryWithRollback } from "../lib/gauntlet/business-canary.ts";
import { compileGauntletPlan } from "../lib/gauntlet/compiler.ts";
import {
  GAUNTLET_EVALUATION_SHARE, gauntletRoundBudget, revisionDefectsSection, runAgentXGauntlet, shouldRunAgentXGauntlet, shouldRunSquadGauntlet,
  type AgentXGauntletEvaluator, type AgentXRevisionRequest,
} from "../lib/gauntlet/agent-x-cutover.ts";
import { createDispatchEvaluator, describeTarget } from "../lib/gauntlet/evaluator-adapter.ts";
import { GAUNTLET_EVALUATOR_ENV, loadInstalledSquads, selectGauntletEvaluator } from "../lib/gauntlet/evaluator-selection.ts";
import type { GauntletPlan } from "../lib/gauntlet/types.ts";
import { RunAlreadyTerminalError, createHarnessLegacyAdapter, openKernel, type TargetRef } from "../lib/run-kernel/index.ts";
import { inertStandardPublication, openStandardPublication } from "../lib/run-kernel/standard-publication.ts";
import { freezeExecutionSnapshot } from "../lib/runtime-snapshot.ts";

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
const VALUE_FLAGS = new Set(["--project", "--runtime", "--manifest", "--brief-file", "--outputs-root", "--max-budget", "--timeout", "--max-revisions", "--execution-mode", "--gauntlet-intensity", "--business", "--squad", "--run-id"]);
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

// ── explicit target selection ──────────────────────────────────────────────
// --business <slug> · --squad <slug> · --agent-x name the target directly and
// never consult the router. They are mutually exclusive with each other and
// with --auto. Pure: the CLI flow turns an error into exit 4.
export type ExplicitTarget = { kind: "business" | "squad"; slug: string } | { kind: "agent-x" };
export function parseExplicitTarget(argv: string[]): { target: ExplicitTarget | null; error: string | null } {
  // undefined = flag absent · null = flag given without a slug · string = slug
  const value = (name: string): string | null | undefined => {
    const i = argv.findIndex(a => a === name || a.startsWith(`${name}=`));
    if (i === -1) return undefined;
    const v = argv[i].includes("=") ? argv[i].slice(name.length + 1) : argv[i + 1];
    return v && !v.startsWith("--") ? v : null;
  };
  const business = value("--business");
  const squad = value("--squad");
  const agentX = argv.includes("--agent-x");
  const auto = argv.includes("--auto");
  const given = [business !== undefined && "--business", squad !== undefined && "--squad", agentX && "--agent-x", auto && "--auto"]
    .filter((flag): flag is string => typeof flag === "string");
  if (given.length > 1) return { target: null, error: `${given.join(", ")} are mutually exclusive: name one target, or use --auto` };
  if (business === null) return { target: null, error: "--business requires a slug" };
  if (squad === null) return { target: null, error: "--squad requires a slug" };
  if (business) return { target: { kind: "business", slug: business }, error: null };
  if (squad) return { target: { kind: "squad", slug: squad }, error: null };
  if (agentX) return { target: { kind: "agent-x" }, error: null };
  return { target: null, error: null };
}

/** Canonical Run id of the Gauntlet canaries: `--run-id` when given (the Run was prepared
 * by a control plane such as Glance and is adopted), else `run_<project>` as before. */
export function canonicalRunIdFor(projectId: string, runIdFlag?: string): string {
  return runIdFlag || `run_${projectId.replace(/[^A-Za-z0-9-]/g, "-")}`;
}

// Decision placeholder for resolveDispatchPlan: an explicit target returns
// before any field of the decision is read, so the router never runs.
const NO_ROUTER_DECISION: AgenticRouteDecision = {
  ok: true, kind: "decision", primary_business: null, mandatory_squads: [], optional_squads: [],
  suggested_mind_clones: [], candidates: [], rationale: "", runtime: null, warnings: [], cost_usd: null, duration_ms: 0,
};

/** Dispatch plan for an explicit target: one step, source "explicit", no router. */
export async function explicitTargetPlan(target: ExplicitTarget): Promise<DispatchPlan> {
  if (target.kind === "agent-x") {
    return {
      ok: true, steps: [{ kind: "agent-x", reason: "explicit user target" }],
      mandatorySquads: [], optionalSquads: [], suggestedMindClones: [], rationale: "", source: "explicit",
    };
  }
  return resolveDispatchPlan(NO_ROUTER_DECISION, { explicitTarget: target });
}

const positional = extractPositional(process.argv.slice(2));
// --auto: no business is named; the router picks the best one for the brief.
// In that mode the first positional is the brief itself, as it is when an
// explicit --business / --squad / --agent-x flag names the target.
const autoMode = process.argv.includes("--auto");
const explicit = parseExplicitTarget(process.argv.slice(2));
const explicitTarget = explicit.target;
// Routing mode (agentic default | fast). Precedence: --mode > env > config.
const routingMode = resolveRoutingMode(arg("--mode"));
let slug = autoMode ? "" : explicitTarget ? (explicitTarget.kind === "business" ? explicitTarget.slug : "") : positional[0];
const inlineBrief = (autoMode || explicitTarget) ? positional[0] : positional[1];
const briefFile = arg("--brief-file");
const manifest = arg("--manifest");
const projectId = arg("--project");
// --run-id: adopt a Run another control plane already prepared (Glance) instead
// of deriving run_<project>. The Run lives in the project root's kernel (the
// root Glance serves: NIRVANA_PROJECT_ROOT, else the cwd), so with the flag the
// canaries open that kernel; without it each dispatch keeps its own under
// outputs/<pid>, byte-for-byte the previous behaviour.
const runIdFlag = arg("--run-id");
function canaryKernelPath(dispatchRoot: string): string {
  const root = runIdFlag ? path.resolve(process.env.NIRVANA_PROJECT_ROOT || process.cwd()) : dispatchRoot;
  return path.join(root, ".nirvana", "run-kernel.sqlite");
}
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
const maxRevisionsFlag = arg("--max-revisions");
// --strict-route: an AMBIGUOUS route fails instead of auto-picking (Phase 4).
const strictRoute = process.argv.includes("--strict-route");
// --force-deliver: deliver despite a failed gate (delivered gate:"fail-forced").
const forceDeliver = process.argv.includes("--force-deliver");
let executionOptions: ReturnType<typeof parseExecutionOptions>;
try {
  executionOptions = parseExecutionOptions(process.argv.slice(2));
} catch (error) {
  if (import.meta.main) console.error(`nrv dispatch: ${(error as Error).message}`);
  if (import.meta.main) process.exit(4);
  throw error;
}

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

if (explicit.error) {
  console.error(`nrv dispatch: ${explicit.error}`);
  process.exit(4);
}

// Named `emit` so check-audit-parity's literal emit-call scan sees every
// dispatch-side emission.
const dispatchAudit = createDispatchAudit();
const emit = (event: string, payload: Record<string, any>) => dispatchAudit.emit(event, payload);
if (executionOptions.requestedMode !== "standard") {
  emit("x_gauntlet_execution_requested", {
    requested_mode: executionOptions.requestedMode, resolved_mode: executionOptions.resolvedMode,
    intensity: executionOptions.intensity, reason: executionOptions.reason,
  });
}

if (!slug && !autoMode && !explicitTarget) {
  console.error("Usage: nrv dispatch <business_slug> \"<brief>\" [opts]");
  console.error("");
  console.error("  Opts:");
  console.error("    --brief-file=<path>     Brief in a file (alternative to inline)");
  console.error("    --manifest=<path>       deliverables.json (expected paths)");
  console.error("    --project=<id>          Custom project ID (default: auto)");
  console.error("    --outputs-root=<dir>    Where final artifacts are written");
  console.error("    --runtime=<name>        claude-code|codex|antigravity-cli|gemini-cli|kimi-cli|grok-cli|pi (default: claude-code)");
  console.error("");
  console.error("  Exec (autopilot):");
  console.error("    --auto                  no business named: the router picks the best one for the brief");
  console.error("    --business=<slug>       name the business explicitly (same as the positional slug)");
  console.error("    --squad=<slug>          name the squad explicitly: squad-only route, no router");
  console.error("    --agent-x               dispatch the generalist explicitly, no router");
  console.error("                            (--business, --squad, --agent-x and --auto are mutually exclusive)");
  console.error("    --exec[=runtime]        run the agent headless (without it, only scaffolds)");
  console.error("    --claude-code           shortcut for --exec=claude-code");
  console.error("    --auto-brief            enrich a thin brief and decide for the human");
  console.error("    --zip                   pack the deliverables into ./<project>.zip");
    console.error("    --pdf                   build relatorio-final.pdf via report-publisher (if the business has one)");
    console.error("    --html                  build relatorio-final.html from every markdown in the project (marked)");
  console.error("    --team                  real multi-employee orchestration (director + chain, each step audits)");
  console.error("    --execution-mode=<mode> standard|gauntlet|auto (default: standard)");
  console.error("    --gauntlet-intensity=<profile> light|balanced|exhaustive");
  console.error("    --run-id=<runId>        adopt a Run already prepared in the project kernel (Glance); default run_<project>");
  console.error("    --max-budget=<usd>      cost ceiling for the run (claude --max-budget-usd)");
  console.error("    --timeout=<min>         wall-clock ceiling for the run (default 24h; a real hang is caught by ~5 min of inactivity)");
  console.error("    --safe                  opt in to restricted mode (limited tools + sandbox); default = full trust");
  console.error("    --strict-route          an ambiguous route FAILS instead of auto-picking the top candidate");
  console.error("    --force-deliver         deliver even when the gate fails (delivered gate:\"fail-forced\")");
  console.error("");
  console.error("  Exit codes:");
  console.error("    0  delivered (gate passed, or --force-deliver)");
  console.error("    1  run failed (routing, execution or verification)");
  console.error("    2  delivery WITHHELD — gate failed after the revisions");
  console.error("    3  INDETERMINATE — nothing was judged: zero gateable artifacts,");
  console.error("       or scaffold without --exec (nothing dispatched, nothing delivered)");
  console.error("    4  invalid arguments");
  console.error("");
  console.error("Example:");
  // Example slugs and briefs are user-library DATA, kept in the user's language.
  console.error("  nrv dispatch brand-creative-studio \"Manifesto para produto X\"");  // i18n-user-facing
  console.error("  nrv run minha-marca \"caso de acidente\" --auto-brief --zip");      // i18n-user-facing
  process.exit(4);
}

let brief = inlineBrief;
if (!brief && briefFile) {
  if (!fs.existsSync(briefFile)) {
    console.error(c("red", `ERROR: --brief-file not found: ${briefFile}`));
    process.exit(4);
  }
  brief = fs.readFileSync(briefFile, "utf8");
}
if (!brief) {
  console.error(c("red", "ERROR: pass an inline brief or --brief-file"));
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
// Revision budget: the flag wins, otherwise the config key that until now had
// no reader (quality_gate.max_revisions) — a hardcoded 2 here made the setting
// a lie for anyone who edited config.yaml.
const maxRevisions = maxRevisionsFlag ? parseInt(maxRevisionsFlag, 10) : harnessConfig.quality_gate.max_revisions;

/**
 * Per-business spend cap. `business.yaml → run_budget_usd` is documented in
 * SKILL.md Rule 4 and in references/02-budget.md, and until now NOTHING read
 * it: a user who set it believed the run was bounded and it was not. Read it
 * here so the tighter of (flag, business) binds. Only claude-code can enforce
 * a cap inside the CLI — runHeadless warns loudly on the others rather than
 * pretending.
 */
function businessRunBudget(businessSlug: string): number | null {
  try {
    const yml = path.join(os.homedir(), "businesses", businessSlug, "business.yaml");
    if (!fs.existsSync(yml)) return null;
    const m = fs.readFileSync(yml, "utf8").match(/^run_budget_usd:\s*([0-9]+(?:\.[0-9]+)?)/m);
    const v = m ? parseFloat(m[1]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;   // 0 / absent = unlimited, per Rule 4
  } catch { return null; }
}

/** Tighter of the --max-budget flag and the business's own run_budget_usd. */
function effectiveBudgetUsd(): number | undefined {
  const flag = maxBudget ? parseFloat(maxBudget) : null;
  const biz = typeof slug === "string" && slug ? businessRunBudget(slug) : null;
  const caps = [flag, biz].filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  return caps.length ? Math.min(...caps) : undefined;
}

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
// An unidentified host is a STATE THE SYSTEM DECLARES, never a silent
// synonym for one vendor. The old `?? "claude-code"` meant that whenever
// detection failed — which is every runtime that exports no session marker —
// the dispatch quietly walked away from the CLI the user was sitting in and
// spent another vendor's quota. Precedence (flag > brief > rules > host) was
// correct above this line and undone by one fallback.
const detectedHost = detectCurrentHost();
const envDefault = (process.env.NIRVANA_DEFAULT_RUNTIME || "").trim();
// Resolution order once detection fails: an explicit NIRVANA_DEFAULT_RUNTIME,
// then whatever is actually installed — chosen from the roster, never
// hardcoded to one vendor. The run always proceeds (a brief must not stall),
// but the choice is announced and audited instead of assumed.
const firstAvailable = (): Runtime | null =>
  (listRuntimes().map(r => r.name).find(n => runtimeAvailable(n)) ?? null);
const hostDefault: Runtime = resolveDefaultRuntime({ detectedHost, envDefault, normalize: normRuntime, firstAvailable }).runtime;
if (!detectedHost) {
  const how = envDefault ? `NIRVANA_DEFAULT_RUNTIME=${hostDefault}` : `first available on PATH: ${hostDefault}`;
  console.error(c("yellow", "⚠") + ` host runtime not identified — using ${how}.`
    + " Pin it with NIRVANA_DEFAULT_RUNTIME in .env, --runtime, or by naming it in the brief.");
  emit("x_host_runtime_undetected", { used: hostDefault, from: envDefault ? "env" : "path-scan", cwd: process.cwd() });
}
let runtimeDecision: RuntimeDecision = decideRuntime({
  brief, explicitRuntime, defaultRuntime: hostDefault,
  rules: runtimeRules, mode: routingMode as "agentic" | "fast",
  available: runtimeAvailable,
});
if (runtimeDecision.source === "brief") {
  console.log(c("lime", "▶") + c("bold", ` Runtime named in the brief: "${runtimeDecision.mention}"`) + c("dim", ` → ${runtimeDecision.runtime}`));
  emit("routing_rule_applied", {
    project_id: projectId || null,
    rule_env_key: null, rule_text: runtimeDecision.mention ?? null,
    runtime: runtimeDecision.runtime, method: "brief-mention", score: null,
    vetoes: runtimeDecision.vetoes ?? null,
  });
} else if (runtimeDecision.source === "rule") {
  console.log(c("lime", "▶") + c("bold", ` Runtime rule: ${runtimeDecision.rule!.envKey}`) + c("dim", ` → ${runtimeDecision.runtime} (${runtimeDecision.method}, score ${runtimeDecision.score?.toFixed(2)})`));
  emit("routing_rule_applied", {
    project_id: projectId || null,
    rule_env_key: runtimeDecision.rule!.envKey, rule_text: runtimeDecision.rule!.rule,
    runtime: runtimeDecision.runtime, method: runtimeDecision.method, score: runtimeDecision.score ?? null,
    vetoes: runtimeDecision.vetoes ?? null,
  });
} else if (runtimeDecision.vetoes?.length) {
  // NOT_USE_* vetoes changed/limited the choice with no winning positive rule.
  console.log(c("lime", "▶") + c("bold", ` Runtime veto: ${runtimeDecision.vetoes.map(v => v.envKey).join(", ")}`) + c("dim", ` → continuing on ${runtimeDecision.runtime}`));
  emit("routing_rule_vetoed", {
    project_id: projectId || null,
    vetoes: runtimeDecision.vetoes, runtime: runtimeDecision.runtime, source: runtimeDecision.source,
  });
} else if (runtimeRules.length && runtimeDecision.source === "default" && !explicitRuntime) {
  console.log(c("dim", `  USE_* rules present, none matched this brief — staying on the default (${runtimeDecision.runtime})`));
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
/**
 * Corpus language mix, for the fast-mode notice. Best-effort and cached by the
 * process: a warning must never cost the dispatch it is warning about.
 */
let _mixCache: { enPct: number; ptPct: number; minorityPct: number } | null | undefined;
function corpusLanguageMix(): { enPct: number; ptPct: number; minorityPct: number } | null {
  if (_mixCache !== undefined) return _mixCache;
  try {
    const { corpusMix } = require("../../_shared/lib/corpus-language.ts");
    const registries = require("../lib/registry-loader.js").loadAll();
    const m = corpusMix(registries);
    _mixCache = m ? { enPct: m.enPct, ptPct: m.ptPct, minorityPct: m.minorityPct } : null;
  } catch { _mixCache = null; }
  return _mixCache;
}

let pendingCascade:
  | { kind: "squad-only"; squads: string[]; plan: DispatchPlan }
  | { kind: "agent-x"; reason: string; plan: DispatchPlan }
  | null = null;
if (autoMode && routingMode === "fast") {
  // fast mode: BM25 business pick, zero-token. Honest fallback when BM25 can't
  // confidently choose a business (most businesses lack auto_routes yet).
  console.log(c("lime", "▶") + c("bold", " Auto-route — fast (BM25, zero-token)"));
  // Say what the cheap path costs, when it costs it.
  //
  // BM25 matches tokens, so a brief and an entity written in different languages
  // share none and never meet. The agentic default does not have this problem —
  // it reads and reasons — but fast is lexical by definition, and on a corpus
  // written in more than one language the user's language quietly decides the
  // answer. Measured on 20 held-out paraphrase pairs: 25% of them reach the same
  // destination in Portuguese and in English.
  //
  // Printed only when the corpus is actually mixed, so a single-language library
  // never sees a warning that does not apply to it.
  const mix = corpusLanguageMix();
  if (mix && mix.minorityPct >= 15) {
    console.log(c("yellow", "  ⚠") + c("dim", ` fast is lexical: this library is ${mix.enPct}% English / ${mix.ptPct}% Portuguese,`));
    console.log(c("dim", `     so a brief written in one of them can miss entities declared in the other.`));
    console.log(c("dim", `     --mode=agentic reads instead of matching, and does not care which language you use.`));
  }
  const fast = await fastBm25Business(brief);
  if (!fast.slug) {
    console.error(c("red", `✗ --auto (fast): BM25 did not confidently pick a business (signal ${fast.signal || "n/a"}; most businesses still have no auto_routes). Name the business, or use --mode=agentic.`));
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
  // The router runs on a runtime like any other work, so it can land on one that
  // is down. Picking the runtime PER ATTEMPT (rather than closing over a single
  // choice) is what makes the ladder's "retry once" land somewhere healthy: on a
  // dead runtime the router otherwise fails twice and the brief falls through to
  // agent-x with no specialist — routing quality lost to an unrelated outage.
  const routerRoot = resolveCascadeRoot(process.cwd());
  const routeOnce = async () => {
    let runtime = rt;
    if (isInCooldown(routerRoot, runtime)) {
      const alt = nextAfter(routerRoot, loadCascade(routerRoot), runtime)?.runtime;
      if (alt && alt !== runtime) {
        console.error(c("yellow", `  ⚠ ${runtime} unavailable (${getCooldown(routerRoot, runtime)?.reason || "cooldown"}) — routing via ${alt}`));
        runtime = alt;
      }
    }
    const d = await agenticRoute({
      brief, runtime, cwd: process.cwd(), projectId: projectId || null,
      maxBudgetUsd: effectiveBudgetUsd(),
      timeoutMs: 5 * 60 * 1000,
      runtimeRules,
    });
    if (!d.ok) {
      // Transport failure. When the CAUSE is the runtime itself (retired tier,
      // spent quota) cool it down, so the retry above — and any agent-x dispatch
      // that follows — stop hammering a CLI that cannot answer. The live incident
      // hit one dead runtime three times in a single run for exactly this reason.
      const verdict = classify(runtime, { ok: false, exitCode: 1, error: d.error ?? "" });
      if (verdict.kind === "auth_failed" || verdict.kind === "quota_exhausted") {
        const authFailed = verdict.kind === "auth_failed";
        markCooldown(routerRoot, runtime, authFailed ? 15 * 60 : verdict.ttlSec, verdict.hint, authFailed ? "auth" : verdict.window);
        emit(authFailed ? "runtime_auth_failed" : "runtime_quota_exhausted",
          { project_id: projectId || null, runtime, hint: verdict.hint });
      }
    }
    return d;
  };
  const decision = await routeOnce();
  // The agentic router READ the user's USE_* rules; if it suggested a runtime
  // and there is no explicit flag NOR a direct mention in the brief (which is
  // stronger than the LLM's suggestion), the semantic suggestion overrides the
  // BM25 match.
  if (decision.runtime && !explicitRuntime && runtimeDecision.source !== "brief" && runtimeAvailable(decision.runtime)) {
    const matched = runtimeRules.find(r => r.runtime === decision.runtime);
    runtimeDecision = { runtime: decision.runtime, source: "rule", rule: matched, method: "agentic" };
    console.log(c("lime", "  →") + c("bold", ` runtime from the user rule: ${decision.runtime}`) + c("dim", " (agentic)"));
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
    console.error(c("red", `✗ --auto: ${plan.error || "no dispatchable plan"}. Name the business or the squad.`));
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
    console.log(c("lime", "  →") + c("bold", ` squad-only route: ${squads.join(", ")}`) + c("dim", ` (${plan.source})`));
    if (plan.rationale) console.log(c("dim", `  rationale: ${plan.rationale}`));
    emit("auto_route_selected", { project_id: projectId || null, business_slug: null, method: "agentic", source: plan.source, squad_only: true, mandatory_squads: squads, optional_squads: plan.optionalSquads });
    pendingCascade = { kind: "squad-only", squads, plan };
  } else {
    console.log(c("yellow", "  →") + c("bold", " agent-x route (generalist)") + c("dim", ` (${plan.source}: ${step.reason})`));
    emit("auto_route_selected", { project_id: projectId || null, business_slug: null, method: "agentic", source: plan.source, agent_x: true, reason: step.reason });
    pendingCascade = { kind: "agent-x", reason: step.reason, plan };
  }
} else if (explicitTarget && explicitTarget.kind !== "business") {
  // --squad / --agent-x: the user named the target, so the plan is resolved
  // without the router (dispatch-cascade layer 0) and flows into the same
  // squad-only / agent-x branches the --auto route uses.
  const plan = await explicitTargetPlan(explicitTarget);
  const step = plan.steps[0];
  if (step.kind === "squad") {
    console.log(c("lime", "▶") + c("bold", ` Explicit target — squad ${step.slug}`) + c("dim", " (no router)"));
    pendingCascade = { kind: "squad-only", squads: [step.slug!], plan };
  } else {
    console.log(c("lime", "▶") + c("bold", " Explicit target — agent-x") + c("dim", " (no router)"));
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
      maxBudgetUsd: effectiveBudgetUsd(),
    });
    if (pr.ok && pr.enriched) {
      brief = pr.enriched;
      console.log(c("dim", `  [auto-brief=proxy] brief enriched by proxy (${pr.enriched.length} chars)`));
      emit("brief_proxy_enriched", { business_slug: slug, chars: pr.enriched.length });
    } else {
      console.error(c("yellow", `  [auto-brief=proxy] failed (${pr.error}); falling back to deterministic inference`));
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
        console.log(c("dim", `  [auto-brief] ${decision.assumptions.length} assumption(s) inferred; brief enriched`));
        emit("brief_amplified", { business_slug: slug, mode: "inferred", assumptions: decision.assumptions.length, score: decision.score.total });
      } else if (decision.action === "skip") {
        console.log(c("dim", `  [auto-brief] brief already rich (score ${decision.score.total}); no inference`));
      }
    } catch (e: any) {
      console.error(c("yellow", `  [auto-brief] amplifier failed (${e?.message || e}); using the original brief`));
    }
  }
}

const SKILLS = process.env.NIRVANA_SKILLS_DIR || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));
const briefBiz = path.join(SKILLS, "businesses/scripts/brief-business.ts");
const employeePrompt = path.join(SKILLS, "businesses/lib/employee-prompt.ts");
const gateScriptPath = path.join(SKILLS, "harness/scripts/quality-gate.ts");
const verifyScriptPath = path.join(SKILLS, "businesses/scripts/verify-deliverable.ts");

// Frozen runtime, provider and model decision of one canary Run: the broker answers
// from the provider catalogs on disk (lib/runtime-snapshot.ts); without a descriptor
// the snapshot is the previous literal and nothing changes. Broker errors are
// explained here and end the Run before the producer inside runAgentXGauntlet
// (RT-002): no silent switch, no legacy fallback.
function frozenExecutionSnapshot(pid: string, rt: Runtime, targetKind: "business" | "squad" | "agent-x") {
  const snapshot = freezeExecutionSnapshot({ runtimeId: rt, runtimeSource: runtimeDecision.source,
    projectRoot: path.resolve(process.env.NIRVANA_PROJECT_ROOT || process.cwd()) });
  if (snapshot.errors?.length) {
    console.error(c("red", `✗ runtime '${rt}' is incompatible with the provider catalog; the Run ends before the producer:`));
    for (const error of snapshot.errors) console.error(c("red", `    ${error}`));
    emit("x_runtime_incompatible", { trace_id: pid, project_id: pid, target_kind: targetKind, runtime: rt,
      runtime_source: runtimeDecision.source, errors: snapshot.errors, rejected: snapshot.rejected ?? [], catalog_dirs: snapshot.catalog?.dirs ?? [] });
  } else {
    for (const warning of snapshot.warnings ?? []) console.error(c("yellow", `⚠ ${warning}`));
  }
  return snapshot;
}

// Heuristic Gauntlet evaluator: the offline quality gate, echoing the candidate and revision
// ids the cutover assigns, with a graded score (share of gateable files that pass) so the
// controller can measure progress between revisions. Signed by a nominal target that is not
// installed anywhere; it is the last rung of the selection ladder below.
function heuristicGauntletEvaluator(env: Record<string, string>): AgentXGauntletEvaluator {
  const target = { kind: "squad" as const, slug: "harness-quality-gate", capabilityId: "quality.specification_conformance" };
  return {
    target,
    evaluate({ candidateId, revisionId, candidateRoot, artifactRefs }) {
      const files = gateableFiles(candidateRoot, new Set());
      const gate = files.length ? runGateOnce(files, { gateScript: gateScriptPath, offline: true, env }) : { pass: false, fails: [] };
      return [{ evaluationId: `evl_${revisionId}`, candidateId, revisionId,
        gauntletId: "brief-conformance", rubricVersion: "harness-quality-gate/v1", verdict: gate.pass ? "pass" : "revise",
        dimensions: [{ id: "brief-conformance", score: files.length ? (files.length - gate.fails.length) / files.length : 0,
          confidence: 1, blocking: true, passed: gate.pass, evidenceRefs: artifactRefs.map(ref => ref.revisionId) }], regressions: [],
        revisionRequests: gate.pass ? [] : [{ requirementId: "brief-conformance",
          evidenceRefs: gate.fails.map(failure => pathToFileURL(failure.file).href) }], evaluator: target,
        costUsd: 0, createdAt: new Date().toISOString() }];
    },
  };
}

// Gauntlet evaluator and round budget shared by the three canaries. The target comes from
// lib/gauntlet/evaluator-selection.ts (NIRVANA_GAUNTLET_EVALUATOR, else an installed squad
// declaring quality.specification_conformance, else agent-x when the producer is not agent-x,
// else the heuristic); every fallback and the final choice are audited. A variable that cannot
// be honoured ends the dispatch with exit 4 before any producer runs. A real evaluator runs
// through lib/gauntlet/evaluator-adapter.ts and its estimated cost is part of the round reserve.
function gauntletEvaluatorFor(args: { pid: string; producer: TargetRef; plan: GauntletPlan; projectRoot: string; rt: Runtime;
  heuristicEnv: Record<string, string> }): { evaluator: AgentXGauntletEvaluator; budget: ReturnType<typeof gauntletRoundBudget> } {
  let selection: ReturnType<typeof selectGauntletEvaluator>;
  try {
    selection = selectGauntletEvaluator({ envValue: process.env[GAUNTLET_EVALUATOR_ENV], producer: args.producer, installed: loadInstalledSquads() });
  } catch (error) {
    console.error(c("red", `✗ Gauntlet evaluator: ${(error as Error).message}`));
    process.exit(4);
  }
  const evaluatorLabel = selection.kind === "heuristic" ? "heuristic" : describeTarget(selection.target);
  for (const fallback of selection.fallbacks) {
    emit("x_gauntlet_evaluator_fallback", { trace_id: args.pid, project_id: args.pid, from: fallback.from, reason: fallback.reason,
      producer: describeTarget(args.producer) });
  }
  emit("x_gauntlet_evaluator_selected", { trace_id: args.pid, project_id: args.pid, evaluator: evaluatorLabel, source: selection.source,
    target: selection.kind === "heuristic" ? null : selection.target, producer: describeTarget(args.producer),
    evaluation_share: selection.kind === "heuristic" ? 0 : GAUNTLET_EVALUATION_SHARE });
  console.log(c("dim", `  Gauntlet evaluator: ${evaluatorLabel} (${selection.source})`));
  if (selection.kind === "heuristic") {
    return { evaluator: heuristicGauntletEvaluator(args.heuristicEnv), budget: gauntletRoundBudget(args.plan, effectiveBudgetUsd()) };
  }
  const budget = gauntletRoundBudget(args.plan, effectiveBudgetUsd(), GAUNTLET_EVALUATION_SHARE);
  const evaluator = createDispatchEvaluator({ target: selection.target, producer: args.producer, plan: args.plan, brief: brief!,
    projectRoot: args.projectRoot, projectId: args.pid, runtime: args.rt, budgetUsd: budget.evaluationBudgetUsd,
    timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined, audit: emit });
  return { evaluator, budget };
}

// Revision brief: the original brief plus the deterministic defects section. It is written
// beside the candidate's revision directories, never inside one, so it is not an artifact.
function writeRevisionBrief(brief: string, request: AgentXRevisionRequest): { text: string; file: string } {
  const text = `${brief}\n\n${revisionDefectsSection(request)}\n`;
  const file = path.join(path.dirname(request.candidateRoot), `brief-revision-${request.revision}.md`);
  fs.writeFileSync(file, text, "utf8");
  return { text, file };
}

// Shared delivery-pipeline invocation for all three cascade paths.
interface DeliverOpts {
  pid: string; slugOrNull: string | null; targetKind: "business" | "squad" | "agent-x";
  rt: Runtime; oroot: string; projDir: string; projectRoot: string;
  sessionId: string | null; withManifest: boolean;
  afterGate?: Parameters<typeof runDelivery>[0]["afterGate"];
  onSession?: (sid: string) => void;
}

function deliveryArgs(opts: DeliverOpts): DeliveryArgs {
  return {
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
    maxBudgetUsd: effectiveBudgetUsd(),
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
  };
}

function deliver(opts: DeliverOpts): DeliveryResult {
  return runDelivery(deliveryArgs(opts));
}

/** A dispatched run came back not-ok. If it left artifacts behind they are
 * judged through the same pipeline (the runtime error stays on the record);
 * with nothing on disk the caller's failure path stands. */
function deliverAfterError(opts: DeliverOpts, runtimeError: string, errorContext: Record<string, any>): RuntimeErrorOutcome {
  return deliverAfterRuntimeError({ ...deliveryArgs(opts), runtimeError, errorContext });
}

function printDeliverySummary(res: DeliveryResult, pid: string, oroot: string, zipPath: string | null, runtimeErrored = false): void {
  console.log("");
  if (runtimeErrored) {
    console.log(c("yellow", "⚠ The runtime reported an error at the end of the run — the artifacts that already existed were verified and judged anyway."));
  }
  if (res.exitCode === 0) {
    console.log(c("green", "✓ Autopilot complete."));
  } else if (res.exitCode === 2) {
    console.log(c("yellow", "⚠ Delivery WITHHELD — the quality gate failed after the revisions (exit 2)."));
    console.log(c("dim", "  The artifacts stay on disk; nothing was marked as delivered."));
  } else if (res.exitCode === 3) {
    console.log(c("yellow", "⚠ Delivery INDETERMINATE — no gateable artifact was produced (exit 3)."));
  } else {
    console.log(c("red", "✗ Delivery failed."));
  }
  console.log(c("dim", `  Project ID:   ${pid}`));
  console.log(c("dim", `  Deliverables: ${oroot}`));
  if (zipPath) console.log(c("dim", `  Zip:          ${zipPath}`));
  console.log("");
  console.log(c("cyan", "  Ask for changes (keeps the session):"));
  console.log("    " + c("yellow", `nrv revise ${pid} "<change>"`));
  if (res.exitCode === 2) {
    console.log(c("cyan", "  Deliver anyway (eyes open):"));
    console.log("    " + c("yellow", "re-run with --force-deliver"));
  }
  console.log(c("cyan", "  Clear the whole scaffold:"));
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
      console.error(c("red", `✗ brief-squad failed for '${sq}':`));
      console.error(r.stdout || r.stderr);
      process.exit(1);
    }
    const dir = r.stdout.match(/Project dir:\s+(\S+)/)?.[1];
    if (!projDir && dir) projDir = dir;
    console.log(c("dim", `  ✓ ${sq} scaffolded`));
  }
  if (!projDir) {
    console.error(c("red", "✗ could not parse the Project dir from brief-squad"));
    process.exit(1);
  }
  const projectRoot = path.resolve(projDir, "..", "..");   // <outputs>/<pid>
  dispatchAudit.bindProjectRoot(projDir);

  if (!wantExec) {
    console.log("");
    console.log(c("cyan", "  Scaffold ready (no --exec). To run it:"));
    console.log("    " + c("yellow", `nrv dispatch --auto "${brief.slice(0, 60)}…" --exec`));
    console.log("    " + c("yellow", `# or manually: bun ${briefSquadScript} <squad> "<brief>"`));
    console.log("");
    console.log(c("green", "✓ Scaffold ready. Project ID: " + pid));
    console.log(c("dim", "  (exit 3 — nothing dispatched, nothing judged; delivery only with --exec)"));
    process.exit(3);
  }

  if (!runtimeAvailable(rt)) {
    console.error(c("red", `✗ runtime '${rt}' is not on the PATH. Install it or use --runtime=claude-code.`));
    emit("agent_exec_failed", { trace_id: pid, project_id: pid, squad_slug: squads[0], runtime: rt, reason: "runtime not on PATH" });
    process.exit(1);
  }
  const oroot = outputsRoot || path.join(projectRoot, "deliverables");
  fs.mkdirSync(oroot, { recursive: true });
  const capabilityId = pendingCascade.plan.steps.find(step => step.kind === "squad" && step.slug === squads[0])?.capability || "squad.execute";
  if (shouldRunSquadGauntlet({ squadCount: squads.length, wantExec, resolvedMode: executionOptions.resolvedMode })) {
    const squad = squads[0];
    const producerTarget = { kind: "squad" as const, slug: squad, capabilityId };
    const canonicalRunId = canonicalRunIdFor(pid, runIdFlag);
    const { evaluator, budget } = gauntletEvaluatorFor({ pid, producer: producerTarget, plan: compileGauntletPlan({ brief, intensity: executionOptions.intensity }),
      projectRoot, rt, heuristicEnv: { NIRVANA_TRACE_ID: pid, NIRVANA_PROJECT_ID: pid } });
    const kernel = openKernel(canaryKernelPath(projectRoot));
    const legacy = runLedger.openLedger();
    let finalDelivery: DeliveryResult | null = null;
    // One producer for the first candidate and for every revision: same squad, same runtime.
    const produce = (candidateRoot: string, candidateBrief: string) => {
      const candidate = runSquadHeadless({ squadSlug: squad, brief: candidateBrief, projectId: pid, projectDir: projDir, projectRoot,
        outputsDir: candidateRoot, runtime: rt, businessSlug: null, mode: "squad-only",
        maxBudgetUsd: budget.candidateBudgetUsd, timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
        rulesDirective, autonomousDirective: AUTONOMOUS_DIRECTIVE,
        ledger: { runId: canonicalRunId, watchDir: candidateRoot } });
      if (candidate.sessionId) runLedger.recordSession(legacy, canonicalRunId, candidate.sessionId);
      return { ok: candidate.ok, sessionId: candidate.sessionId, costUsd: candidate.costUsd, error: candidate.error };
    };
    const executionSnapshot = frozenExecutionSnapshot(pid, rt, "squad");
    try {
      const result = runAgentXGauntlet({
        kernel, legacy: createHarnessLegacyAdapter({ ledger: legacy, auditCwd: projDir }), producerTarget,
        projectId: pid, runId: canonicalRunId, traceId: pid, brief, projectRoot, outputsRoot: oroot,
        intensity: executionOptions.intensity, executionSnapshot, audit: emit,
        expectedCostUsd: budget.roundBudgetUsd,
        executeCandidate: candidateRoot => produce(candidateRoot, brief),
        reviseCandidate: request => produce(request.candidateRoot, writeRevisionBrief(brief, request).text),
        evaluator,
        finalGate({ sessionId }) {
          finalDelivery = runDelivery({ ...deliveryArgs({ pid, slugOrNull: null, targetKind: "squad", rt, oroot,
            projDir, projectRoot, sessionId, withManifest: false }), ledger: null, maxRevisions: 0 });
          return { exitCode: finalDelivery.exitCode, gateOutcome: finalDelivery.gateOutcome };
        },
      });
      if (finalDelivery) printDeliverySummary(finalDelivery, pid, oroot, null);
      else console.error(c("yellow", `⚠ Gauntlet stopped before the final gate (${result.run.state}: ${result.gauntlet.stopReason}).`));
      kernel.close(); legacy.close();
      process.exit(result.exitCode);
    } catch (error) {
      kernel.close(); legacy.close();
      console.error(c("red", `✗ squad Gauntlet failed: ${(error as Error).message}`));
      process.exit(1);
    }
  }
  // Standard mode publishes the same canonical Run the Gauntlet canary would (dual-write through
  // lib/run-kernel/standard-publication.ts, fail-open); a chain of squads publishes under its first squad.
  const publication = openStandardPublication({ kernelPath: canaryKernelPath(projectRoot), projectId: pid, runId: canonicalRunIdFor(pid, runIdFlag),
    traceId: pid, target: { kind: "squad", slug: squads[0], capabilityId }, snapshot: frozenExecutionSnapshot(pid, rt, "squad"),
    audit: emit, warn: line => console.error(c("yellow", line)) });
  if (publication.incompatible || publication.collided) process.exit(1);
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
  publication.start();
  let lastSession: string | null = null;
  let squadError: string | null = null;
  let failedSquad: string | null = null;
  for (const sq of squads) {
    const outDir = squads.length > 1 ? path.join(oroot, sq) : oroot;
    const r = runSquadHeadless({
      squadSlug: sq, brief, projectId: pid, projectDir: projDir, projectRoot,
      outputsDir: outDir, runtime: rt, businessSlug: null, mode: "squad-only",
      maxBudgetUsd: effectiveBudgetUsd(),
      timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
      rulesDirective, autonomousDirective: AUTONOMOUS_DIRECTIVE,
      ...(ledgerRunId ? { ledger: { runId: ledgerRunId, watchDir: outDir } } : {}),
    });
    lastSession = r.sessionId ?? lastSession;
    if (!r.ok) {
      // Stop the chain, but do NOT abandon what is already on disk — the
      // delivery pipeline below decides (see deliverAfterRuntimeError).
      console.error(c("red", `✗ squad '${sq}' failed: ${r.error}`));
      emit("agent_exec_failed", { trace_id: pid, project_id: pid, squad_slug: sq, runtime: rt, error: r.error });
      squadError = `squad ${sq}: ${r.error}`;
      failedSquad = sq;
      break;
    }
    console.log(c("dim", `  · ${sq}: ${r.durationMs}ms${r.costUsd != null ? ` · $${r.costUsd.toFixed(4)}` : ""}`));
  }
  if (ledgerRunId && lastSession) ledgerTry(() => runLedger.recordSession(ledgerHandle!, ledgerRunId!, lastSession));

  const squadDeliverOpts = {
    pid, slugOrNull: null, targetKind: "squad" as const, rt, oroot,
    projDir, projectRoot, sessionId: lastSession, withManifest: false,
  };
  publication.verify();
  if (squadError) {
    const outcome = deliverAfterError(squadDeliverOpts, squadError, { squad_slug: failedSquad });
    publication.finish({ exitCode: outcome.exitCode, gateOutcome: outcome.result?.gateOutcome ?? "indeterminate", error: squadError }, oroot);
    if (!outcome.judged) {
      console.error(c("red", `✗ nothing was produced in ${oroot} — nothing to judge.`));
      process.exit(1);
    }
    printDeliverySummary(outcome.result!, pid, oroot, null, true);
    process.exit(outcome.exitCode);
  }

  console.log(c("lime", "▶") + c("bold", " Delivery pipeline — verify → gate → deliver"));
  const res = deliver(squadDeliverOpts);
  publication.finish({ exitCode: res.exitCode, gateOutcome: res.gateOutcome }, oroot);
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
    console.log(c("cyan", "  agent-x scaffold ready (no --exec). Enriched brief at:"));
    console.log("    " + c("yellow", briefPath));
    console.log(c("cyan", "  To run it:"));
    console.log("    " + c("yellow", `nrv dispatch --auto "<brief>" --exec`));
    console.log("");
    console.log(c("green", "✓ Scaffold ready. Project ID: " + pid));
    console.log(c("dim", "  (exit 3 — nothing dispatched, nothing judged; delivery only with --exec)"));
    process.exit(3);
  }

  if (!runtimeAvailable(rt)) {
    console.error(c("red", `✗ runtime '${rt}' is not on the PATH. Install it or use --runtime=claude-code.`));
    emit("agent_exec_failed", { trace_id: pid, project_id: pid, employee: "agent-x", runtime: rt, reason: "runtime not on PATH" });
    process.exit(1);
  }
  const oroot = outputsRoot || path.join(base, "deliverables");
  fs.mkdirSync(oroot, { recursive: true });
  if (shouldRunAgentXGauntlet({ targetKind: "agent-x", wantExec, resolvedMode: executionOptions.resolvedMode })) {
    const canonicalRunId = canonicalRunIdFor(pid, runIdFlag);
    const { evaluator, budget } = gauntletEvaluatorFor({ pid, producer: { kind: "agent-x", slug: "agent-x" },
      plan: compileGauntletPlan({ brief, intensity: executionOptions.intensity }), projectRoot: base, rt,
      heuristicEnv: { NIRVANA_TRACE_ID: pid, NIRVANA_PROJECT_ID: pid } });
    const kernel = openKernel(canaryKernelPath(base));
    const legacy = runLedger.openLedger();
    let finalDelivery: DeliveryResult | null = null;
    // One producer for the first candidate and for every revision: same persona, same runtime.
    const produce = (candidateRoot: string, candidateBrief: string, candidateBriefPath: string) => {
      const candidate = runAgentX({ brief: candidateBrief, briefPath: candidateBriefPath, runtime: rt, projectId: pid, projectDir: projDir,
        projectRoot: base, outputsRoot: candidateRoot, reason: pendingCascade.reason, appendSystemPrompt: AUTONOMOUS_DIRECTIVE + rulesDirective,
        maxBudgetUsd: budget.candidateBudgetUsd, timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
        yolo, ledger: { runId: canonicalRunId, watchDir: candidateRoot }, audit: emit });
      if (candidate.sessionId) runLedger.recordSession(legacy, canonicalRunId, candidate.sessionId);
      if (!candidate.ok) emit("agent_exec_failed", { trace_id: pid, project_id: pid, employee: "agent-x", runtime: rt,
        exit_code: candidate.exitCode, error: candidate.error || candidate.stderr });
      return { ok: candidate.ok, sessionId: candidate.sessionId, costUsd: candidate.costUsd,
        error: candidate.error || candidate.stderr || undefined };
    };
    const executionSnapshot = frozenExecutionSnapshot(pid, rt, "agent-x");
    try {
      const result = runAgentXGauntlet({
        kernel, legacy: createHarnessLegacyAdapter({ ledger: legacy, auditCwd: projDir }),
        projectId: pid, runId: canonicalRunId, traceId: pid, brief, projectRoot: base, outputsRoot: oroot,
        intensity: executionOptions.intensity, executionSnapshot, audit: emit,
        expectedCostUsd: budget.roundBudgetUsd,
        executeCandidate: candidateRoot => produce(candidateRoot, brief, briefPath),
        reviseCandidate(request) {
          const revision = writeRevisionBrief(brief, request);
          return produce(request.candidateRoot, revision.text, revision.file);
        },
        evaluator,
        finalGate({ sessionId }) {
          finalDelivery = runDelivery({ ...deliveryArgs({ pid, slugOrNull: null, targetKind: "agent-x", rt, oroot,
            projDir, projectRoot: base, sessionId, withManifest: false }), ledger: null, maxRevisions: 0 });
          return { exitCode: finalDelivery.exitCode, gateOutcome: finalDelivery.gateOutcome };
        },
      });
      if (finalDelivery) printDeliverySummary(finalDelivery, pid, oroot, null);
      else console.error(c("yellow", `⚠ Gauntlet stopped before the final gate (${result.run.state}: ${result.gauntlet.stopReason}).`));
      kernel.close(); legacy.close();
      process.exit(result.exitCode);
    } catch (error) {
      kernel.close(); legacy.close();
      console.error(c("red", `✗ agent-x Gauntlet failed: ${(error as Error).message}`));
      process.exit(1);
    }
  }
  // Standard mode publishes the same canonical Run the Gauntlet canary would (dual-write, fail-open).
  const publication = openStandardPublication({ kernelPath: canaryKernelPath(base), projectId: pid, runId: canonicalRunIdFor(pid, runIdFlag),
    traceId: pid, target: { kind: "agent-x", slug: "agent-x" }, snapshot: frozenExecutionSnapshot(pid, rt, "agent-x"),
    audit: emit, warn: line => console.error(c("yellow", line)) });
  if (publication.incompatible || publication.collided) process.exit(1);
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
  publication.start();
  const r = runAgentX({
    brief, briefPath, runtime: rt, projectId: pid,
    projectDir: projDir, projectRoot: base, outputsRoot: oroot,
    reason: pendingCascade.reason,
    appendSystemPrompt: AUTONOMOUS_DIRECTIVE + rulesDirective,
    maxBudgetUsd: effectiveBudgetUsd(),
    timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
    yolo,
    ...(ledgerRunId ? { ledger: { runId: ledgerRunId, watchDir: oroot } } : {}),
    audit: emit,
  });
  if (ledgerRunId) ledgerTry(() => runLedger.recordSession(ledgerHandle!, ledgerRunId!, r.sessionId));
  const agentXDeliverOpts = {
    pid, slugOrNull: null, targetKind: "agent-x" as const, rt, oroot,
    projDir, projectRoot: base, sessionId: r.sessionId, withManifest: false,
  };
  publication.verify();
  if (!r.ok) {
    console.error(c("red", `✗ agent-x failed (exit ${r.exitCode}): ${r.error || r.stderr || "unknown"}`));
    emit("agent_exec_failed", { trace_id: pid, project_id: pid, employee: "agent-x", runtime: rt, exit_code: r.exitCode, error: r.error || r.stderr });
    const runtimeError = r.error || r.stderr || `exit ${r.exitCode}`;
    const outcome = deliverAfterError(agentXDeliverOpts, runtimeError, { employee: "agent-x" });
    publication.finish({ exitCode: outcome.exitCode, gateOutcome: outcome.result?.gateOutcome ?? "indeterminate", error: runtimeError }, oroot);
    if (!outcome.judged) {
      console.error(c("red", `✗ nothing was produced in ${oroot} — nothing to judge.`));
      process.exit(1);
    }
    printDeliverySummary(outcome.result!, pid, oroot, null, true);
    process.exit(outcome.exitCode);
  }
  console.log(c("dim", `  session: ${r.sessionId || "(none)"} · ${r.durationMs}ms${r.costUsd != null ? ` · $${r.costUsd.toFixed(4)}` : ""}`));

  console.log(c("lime", "▶") + c("bold", " Delivery pipeline — verify → gate → deliver"));
  const res = deliver(agentXDeliverOpts);
  publication.finish({ exitCode: res.exitCode, gateOutcome: res.gateOutcome }, oroot);
  printDeliverySummary(res, pid, oroot, null);
  process.exit(res.exitCode);
}

if (!fs.existsSync(briefBiz)) {
  console.error(c("red", `ERROR: brief-business.ts not found at ${briefBiz}`));
  console.error("Run `nrv install --bootstrap` to reinstall Nirvana.");
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
  console.error(c("red", "✗ Could not parse brief-business output"));
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
const businessCanaryDecision = decideBusinessCanary({ businessSlug: slug, wantExec, teamMode: wantTeam,
  requestedMode: executionOptions.requestedMode, resolvedMode: executionOptions.resolvedMode,
  intensity: executionOptions.intensity, allowlist: process.env.NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST,
  killSwitch: process.env.NIRVANA_BUSINESS_GAUNTLET_KILL_SWITCH });
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
if (wantExec && !businessCanaryDecision.enabled) {
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
if (executionOptions.requestedMode === "gauntlet") {
  emit(businessCanaryDecision.enabled ? "x_business_gauntlet_selected" : "x_business_gauntlet_bypassed", {
    trace_id: pid, project_id: pid, business_slug: slug, reason: businessCanaryDecision.reason,
    requested_mode: executionOptions.requestedMode, intensity: executionOptions.intensity,
  });
}
console.log(c("dim", `  ✓ dispatch_business written to ${path.join(harnessLogsDir({ cwd: projDir }), new Date().toISOString().slice(0, 10))}/audit.jsonl`));

// ── EXEC MODE — actually run the runtime headless, then verify+gate+deliver ─
if (wantExec) {
  // Final runtime: the flag > USE_* rule > current host decision (already computed).
  const rt = runtimeDecision.runtime;
  const oroot = execOutputsRoot as string;

  console.log("");
  console.log(c("lime", "▶") + c("bold", ` Step 4/7 — exec ${wantTeam ? "team-chain" : "headless"} (${rt})`));
  if (!runtimeAvailable(rt)) {
    console.error(c("red", `✗ runtime '${rt}' is not on the PATH. Install it or use --runtime=claude-code.`));
    emit("agent_exec_failed", { trace_id: pid, project_id: pid, business_slug: slug, runtime: rt, reason: "runtime not on PATH" });
    if (ledgerRunId) ledgerTry(() => runLedger.markState(ledgerHandle!, ledgerRunId!, "failed", { error: "runtime not on PATH" }));
    process.exit(1);
  }
  if (businessCanaryDecision.enabled) {
    const canonicalRunId = canonicalRunIdFor(pid, runIdFlag);
    const { evaluator, budget } = gauntletEvaluatorFor({ pid, producer: { kind: "business", slug },
      plan: compileGauntletPlan({ brief, intensity: executionOptions.intensity }), projectRoot, rt,
      heuristicEnv: { NIRVANA_TRACE_ID: pid, NIRVANA_PROJECT_ID: pid, NIRVANA_BUSINESS_SLUG: slug } });
    const kernel = openKernel(canaryKernelPath(projectRoot));
    const canaryLedger = runLedger.openLedger();
    let finalDelivery: DeliveryResult | null = null;
    let canarySessionId: string | null = null;
    // The employee prompt embeds `outputs_root`, so it is rebuilt per candidate root: every
    // candidate and revision writes into its own isolated directory, never into `oroot`.
    const employeePromptFor = (briefFile: string, candidateRoot: string): string => {
      const built = spawnSync("bun", [employeePrompt, slug, intake, projDir, briefFile, candidateRoot], { encoding: "utf8" });
      if (built.status !== 0) throw new Error(`employee-prompt failed: ${built.stderr}`);
      return built.stdout;
    };
    // One producer for the first candidate and for every revision: same employee, same runtime.
    const produce = (candidateRoot: string, briefFile: string, candidateBrief: string) => {
      const prompt = employeePromptFor(briefFile, candidateRoot);
      attempt.markProductionStarted();
      const candidate = runWithCascade({ runtime: rt, prompt, cwd: projDir,
        addDirs: [projectRoot], appendSystemPrompt: AUTONOMOUS_DIRECTIVE + rulesDirective,
        maxBudgetUsd: budget.candidateBudgetUsd, timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
        yolo, brief: candidateBrief, projectRoot, outputsRoot: candidateRoot, taskHint: `business Gauntlet canary · ${slug}/${intake}`,
        projectId: pid, ledger: { runId: canonicalRunId, watchDir: candidateRoot } });
      canarySessionId = candidate.sessionId;
      if (candidate.sessionId) runLedger.recordSession(canaryLedger, canonicalRunId, candidate.sessionId);
      return { ok: candidate.ok, sessionId: candidate.sessionId, costUsd: candidate.costUsd,
        error: candidate.error || candidate.stderr || undefined };
    };
    const executionSnapshot = frozenExecutionSnapshot(pid, rt, "business");
    const attempt = {
      markProductionStarted() {},
      run() {
        return runAgentXGauntlet({
          kernel, legacy: createHarnessLegacyAdapter({ ledger: canaryLedger, auditCwd: projDir }),
          producerTarget: { kind: "business", slug }, projectId: pid, runId: canonicalRunId, traceId: pid,
          brief, projectRoot, outputsRoot: oroot, expectedCostUsd: budget.roundBudgetUsd, intensity: executionOptions.intensity,
          executionSnapshot, audit: emit,
          executeCandidate: candidateRoot => produce(candidateRoot, tmpBriefFile, brief),
          reviseCandidate(request) {
            const revision = writeRevisionBrief(brief, request);
            return produce(request.candidateRoot, revision.file, revision.text);
          },
          evaluator,
          finalGate({ sessionId }) {
            const sessionFile = path.join(projDir, "session.json");
            const sessionData: Record<string, any> = { project_id: pid, business_slug: slug, employee: intake, runtime: rt,
              session_id: sessionId, project_dir: projDir, project_root: projectRoot, outputs_root: oroot,
              zip_path: null, created_at: new Date().toISOString(), manifest: manifest ?? null };
            fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
            const afterGate = () => runBusinessPostGate({ projectId: pid, businessSlug: slug, runtime: rt,
              projectDir: projDir, projectRoot, outputsRoot: oroot, skillsRoot: SKILLS, employeePromptScript: employeePrompt,
              sessionFile, sessionData, rulesDirective, maxBudgetUsd: budget.candidateBudgetUsd,
              timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined, yolo, wantPdf, skipHtml,
              offlineSnapshot: process.argv.includes("--offline-snapshot"), routingMode, wantZip, emit,
              log: message => console.log(c("lime", message)), warn: message => console.error(c("yellow", message)) });
            finalDelivery = runDelivery({ ...deliveryArgs({ pid, slugOrNull: slug, targetKind: "business", rt, oroot,
              projDir, projectRoot, sessionId, withManifest: true, afterGate }), ledger: null, maxRevisions: 0 });
            return { exitCode: finalDelivery.exitCode, gateOutcome: finalDelivery.gateOutcome };
          },
        });
      },
      shouldRollback(result: ReturnType<typeof runAgentXGauntlet>) {
        // RT-002: an incompatible runtime ends the Run with the explanation; it never
        // falls back to the legacy executor.
        return !result.finalGateRan && result.run.state === "rolled_back" && !executionSnapshot.errors?.length;
      },
    };
    try {
      const outcome = runBusinessCanaryWithRollback({ attempt,
        runLegacy: () => ({ fallback: true as const }),
        emit: (event, payload) => emit(event, { trace_id: pid, project_id: pid, business_slug: slug, ...payload }) });
      kernel.close(); canaryLedger.close();
      if (!("fallback" in outcome)) {
        if (finalDelivery) printDeliverySummary(finalDelivery, pid, oroot, finalDelivery.zipPath);
        else console.error(c("yellow", `⚠ Business Gauntlet stopped before the final gate (${outcome.run.state}: ${outcome.gauntlet.stopReason}).`));
        process.exit(outcome.exitCode);
      }
      ledgerTry(() => {
        ledgerHandle = runLedger.openLedger();
        const row = runLedger.openRun(ledgerHandle, { traceId: pid, projectId: pid, targetSlug: slug, targetKind: "business",
          runtime: rt, childPid: process.pid, meta: { project_dir: projDir, project_root: projectRoot,
            outputs_root: oroot, prompt_path: outputPath, brief_path: tmpBriefFile, mode: "single" } });
        ledgerRunId = row.run_id;
      });
    } catch (error) {
      kernel.close(); canaryLedger.close();
      console.error(c("red", error instanceof RunAlreadyTerminalError
        ? `✗ Business Gauntlet refused: ${error.message}`
        : `✗ Business Gauntlet failed after production started: ${(error as Error).message}`));
      process.exit(1);
    }
  }
  // Standard mode publishes the canonical Run (dual-write, fail-open). After a canary rollback the
  // kernel already holds this Run's terminal state, so the legacy fallback publishes nothing new.
  const publication = businessCanaryDecision.enabled ? inertStandardPublication(canonicalRunIdFor(pid, runIdFlag))
    : openStandardPublication({ kernelPath: canaryKernelPath(projectRoot), projectId: pid, runId: canonicalRunIdFor(pid, runIdFlag), traceId: pid,
      target: { kind: "business", slug }, snapshot: frozenExecutionSnapshot(pid, rt, "business"), audit: emit, warn: line => console.error(c("yellow", line)) });
  if (publication.incompatible || publication.collided) {
    const error = publication.collided ? `run ${publication.runId} is already terminal` : "runtime incompatible with the provider catalog";
    if (ledgerRunId) ledgerTry(() => runLedger.markState(ledgerHandle!, ledgerRunId!, "failed", { error }));
    process.exit(1);
  }
  if (ledgerRunId) ledgerTry(() => runLedger.markState(ledgerHandle!, ledgerRunId!, "running", { childPid: process.pid }));
  publication.start();

  // res = unified result shape consumed by the delivery pipeline below.
  let res: { ok: boolean; sessionId: string | null; durationMs: number; costUsd: number | null; exitCode?: number; error?: string; stderr?: string };
  // Set when the runtime returned an error verdict. The run is NOT abandoned
  // here: whatever landed on disk still goes through verify → gate below
  // (deliverAfterRuntimeError), which needs the afterGate hook defined further
  // down — so the decision is deferred instead of exiting on the spot.
  let runtimeError: string | null = null;

  if (wantTeam) {
    const tr = runTeam({
      slug, brief, projectId: pid, projectDir: projDir, projectRoot, outputsRoot: oroot,
      runtime: rt, intakeEmployee: intake,
      mandatorySquads: autoMandatorySquads,
      maxBudgetUsd: effectiveBudgetUsd(),
      timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
      rulesDirective,
    });
    if (!tr.ok) {
      console.error(c("red", `✗ team failed: ${tr.error}`));
      emit("agent_exec_failed", { trace_id: pid, project_id: pid, business_slug: slug, runtime: rt, mode: "team", error: tr.error });
      runtimeError = `team failed: ${tr.error}`;
    } else {
      console.log(c("green", `  ✓ team orchestrated: ${tr.chain.length} steps`));
      for (const s of tr.steps) {
        console.log(c("dim", `    · ${s.employee}: ${s.durationMs}ms${s.costUsd != null ? ` · $${s.costUsd.toFixed(4)}` : ""}`));
      }
      console.log(c("dim", `  total: ${tr.totalDurationMs}ms · $${tr.totalCostUsd.toFixed(4)}`));
    }
    res = { ok: tr.ok, sessionId: tr.lastSessionId, durationMs: tr.totalDurationMs, costUsd: tr.totalCostUsd };
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
      maxBudgetUsd: effectiveBudgetUsd(),
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
      console.error(c("red", `✗ exec failed (exit ${res.exitCode}): ${res.error || res.stderr || "unknown"}`));
      emit("agent_exec_failed", { trace_id: pid, project_id: pid, business_slug: slug, runtime: rt, exit_code: res.exitCode, error: res.error || res.stderr });
      runtimeError = res.error || res.stderr || `exit ${res.exitCode}`;
    } else {
      console.log(c("dim", `  session: ${res.sessionId || "(none)"} · ${res.durationMs}ms${res.costUsd != null ? ` · $${res.costUsd.toFixed(4)}` : ""}`));
    }
  }

  // session.json — lets `nrv revise` resume the same conversation and `nrv clean` find everything.
  const sessionFile = path.join(projDir, "session.json");
  const sessionData: Record<string, any> = {
    project_id: pid, business_slug: slug, employee: intake, runtime: rt,
    session_id: res.sessionId, project_dir: projDir, project_root: projectRoot,
    outputs_root: oroot, zip_path: null, created_at: new Date().toISOString(),
    // The manifest travels with the session: without it `nrv revise` loses the
    // one completeness proof the system has (promised paths vs disk truth) and
    // silently downgrades to the scan fallback on every revision.
    manifest: manifest ?? null,
  };
  fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
  // Session id into the ledger so the supervisor can resume this conversation.
  if (ledgerRunId) ledgerTry(() => runLedger.recordSession(ledgerHandle!, ledgerRunId!, res.sessionId ?? null));
  // In team mode each step emitted its own agent_executed; skip the parent-level
  // emit to avoid double counting. In single-shot mode, audit the parent run.
  // An errored run already emitted agent_exec_failed — claiming agent_executed
  // on top of it would put two contradictory verdicts in the same chain.
  if (!wantTeam && !runtimeError) {
    emit("agent_executed", { trace_id: pid, project_id: pid, business_slug: slug, employee: intake, runtime: rt, session_id: res.sessionId, cost_usd: res.costUsd, duration_ms: res.durationMs });
  }

  // Advance HANDOFF to complete (one-shot autopilot). An errored run advances
  // only once its artifacts actually enter the delivery pipeline (below): a run
  // that produced nothing at all stays where it stopped.
  const advanceHandoff = () => {
    try {
      const { updateHandoffPhase } = requireCjs(path.join(SKILLS, "_shared", "lib", "handoff.js"));
      updateHandoffPhase(projDir, "complete", {
        lastTaskCompleted: runtimeError ? "headless exec (runtime error; artifacts judged anyway)" : "headless exec",
        decisions: [`autopilot run via ${rt}`],
      });
    } catch { /* non-fatal */ }
  };
  if (!runtimeError) advanceHandoff();

  // Steps 5-7 — delivery pipeline (verify → gate → deliver), fail-closed.
  // Extracted to lib/delivery-pipeline.ts (Phase 4.2); PDF/HTML/zip run in
  // the afterGate hook, ONLY when delivery actually proceeds.
  console.log(c("lime", "▶") + c("bold", " Steps 5-7 — delivery pipeline (verify → gate → deliver)"));
  let zipPathOut: string | null = null;

  const afterGate = (): { zipPath: string | null } => {
    const result = runBusinessPostGate({
      projectId: pid, businessSlug: slug, runtime: rt, projectDir: projDir, projectRoot,
      outputsRoot: oroot, skillsRoot: SKILLS, employeePromptScript: employeePrompt,
      sessionFile, sessionData, rulesDirective, maxBudgetUsd: effectiveBudgetUsd(),
      timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
      yolo, wantPdf, skipHtml, offlineSnapshot: process.argv.includes("--offline-snapshot"),
      routingMode, wantZip, emit,
      log: message => console.log(c("lime", message)),
      warn: message => console.error(c("yellow", message)),
    });
    zipPathOut = result.zipPath;
    return result;
  };

  const bizDeliverOpts = {
    pid, slugOrNull: slug, targetKind: "business" as const, rt, oroot,
    projDir, projectRoot, sessionId: res.sessionId, withManifest: true,
    afterGate,
    onSession: (sid: string) => {
      res.sessionId = sid;
      sessionData.session_id = sid;
      fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
    },
  };
  let delivery: DeliveryResult;
  publication.verify();
  if (runtimeError) {
    const outcome = deliverAfterError(bizDeliverOpts, runtimeError, { employee: intake, mode: wantTeam ? "team" : "single" });
    publication.finish({ exitCode: outcome.exitCode, gateOutcome: outcome.result?.gateOutcome ?? "indeterminate", error: runtimeError }, oroot);
    if (!outcome.judged) {
      console.error(c("red", `✗ nothing was produced in ${oroot} — nothing to judge.`));
      process.exit(1);
    }
    delivery = outcome.result!;
    advanceHandoff();
  } else {
    delivery = deliver(bizDeliverOpts);
    publication.finish({ exitCode: delivery.exitCode, gateOutcome: delivery.gateOutcome }, oroot);
  }

  printDeliverySummary(delivery, pid, oroot, zipPathOut, !!runtimeError);
  // Fail-closed exit contract: 0 delivered · 2 withheld (gate fail) ·
  // 3 indeterminate (nothing gateable) · 1 verify/exec failure.
  process.exit(delivery.exitCode);
}

// Step 4 — actionable next step
console.log("");
console.log(c("lime", "▶") + c("bold", " Step 4/4 — next steps"));
console.log("");
console.log(c("cyan", "  Copy the whole prompt and paste it into your runtime:"));
console.log("");
console.log("    " + c("yellow", `cat ${outputPath} | pbcopy        # macOS`));
console.log("    " + c("yellow", `cat ${outputPath} | xclip         # Linux`));
console.log("    " + c("yellow", `type ${outputPath} | clip         # Windows`));
console.log("");
console.log(c("cyan", "  Or open the cockpit:"));
console.log("    " + c("yellow", `nrv glance --allow-actions`));
console.log("");
console.log(c("cyan", "  To validate when it is done:"));
console.log("    " + c("yellow", `bun ~/.nirvana/skills/businesses/scripts/verify-deliverable.ts ${pid} ${slug}`));
console.log("    " + c("yellow", `bun ~/.nirvana/skills/harness/scripts/validate-chain.ts ${pid} --strict`));
console.log("");
console.log(c("green", "✓ Scaffold ready. Project ID: " + pid));
console.log(c("dim", "  (exit 3 — nothing dispatched, nothing judged; delivery only with --exec)"));

// Scaffold-only: nothing executed, nothing judged, nothing delivered → 3.
process.exit(3);

} // end if (import.meta.main) — CLI flow guard
