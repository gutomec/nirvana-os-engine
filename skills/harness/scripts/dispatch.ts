#!/usr/bin/env bun
// dispatch.ts — one-command end-to-end dispatch of a Nirvana target.
//
// Wraps brief-business.ts + the solo business worker + the delivery pipeline
// (lib/delivery-pipeline.ts: verify → gate → deliver, fail-closed) so the
// user doesn't have to wire them manually. The dispatch cascade
// (lib/dispatch-cascade.ts) is in code: Business → Squad → agent-x — a
// NO_MATCH dispatches the generalist instead of exiting, a squad-only route
// actually DISPATCHES the squad (lib/squad-exec.ts), and the router-failure
// ladder (retry → BM25 → agent-x) keeps the brief from stalling.
//
// Usage:
//   nrv dispatch <business_slug> "<brief>" --exec
//   nrv dispatch <business_slug> --brief-file=brief.md --manifest=paths.json --project=name --exec
//   nrv dispatch --squad <slug>[:<capability>] | --agent-x | --auto  "<brief>" --exec
//
// Without --exec the command refuses (exit 4) before it creates anything and
// prints the same command with --exec. --scaffold-only prepares the run folder
// and the prompt without running them (exit 3).
//
// Every input is checked before the first side effect (folder, audit event,
// ledger row): runtime names and availability, the target's existence, the
// brief file, numeric flags, --project, and whether this caller's role may
// dispatch at all.
//
// Exit codes (routing-360 Phase 4 — BREAKING, see CHANGELOG):
//   0 = delivered, possibly with reservations (gate pass, accepted, or --force-deliver)
//   1 = run failed (routing / exec / verify failure)
//   2 = delivery WITHHELD — gate failed after the revision budget
//   3 = delivery INDETERMINATE — nothing was judged: zero gateable artifacts,
//       or a --scaffold-only run that dispatched nothing at all
//   4 = invalid input, or refused before anything ran (no --exec, role, depth)
//
// 0 means DELIVERED, and only that. A scaffold-only run prepares the prompt
// and stops — it delivers nothing and judges nothing — so it exits 3 on every
// path (business, squad-only, agent-x), never 0: `nrv dispatch … && publish`
// must not publish a run that never executed.

import { isSafeId, runFolderId } from "../../_shared/lib/run-id.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { runHeadless, runtimeAvailable, AUTONOMOUS_DIRECTIVE, LEDGER_DEFAULT_TIMEOUT_MS, type Runtime } from "../lib/host-agent-driver.ts";
import { listRuntimes } from "../../_shared/lib/host-agent-driver.ts";
import { amplify } from "../lib/amplifier.ts";
import { proxyEnrichBrief } from "../lib/brief-proxy.ts";
import { resolveRoutingMode, routingModeOrigin } from "../../_shared/lib/routing-mode.ts";
import { creditSoloRun, namedSquadsIn, prepareBusinessSolo, runBusinessSolo } from "../lib/business-solo.ts";
import { runSoloReviewStage, type ReviewPolicy } from "../lib/solo-review.ts";
import { resolveEntityDir } from "../../_shared/lib/entity-resource-map.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { globalStoreDir, outputsBaseDir } from "../../_shared/lib/project-root.js";
import { nestedOutputsBase, runFolderOf } from "../../_shared/lib/run-workspace.ts";
import { briefExcerpt } from "../../_shared/lib/brief-excerpt.ts";
import { agenticRoute, type AgenticRouteDecision } from "../lib/agentic-router.ts";
import { cardsRoute, withDoneWhen } from "../lib/cards-router.ts";
import { runWithCascade } from "../lib/cascade-runner.ts";
import { resolveCascadeRoot, loadCascade, nextAfter } from "../lib/cascade.ts";
import { classify } from "../lib/quota-detector.ts";
import { isInCooldown, getCooldown, markCooldown } from "../lib/cooldown-registry.ts";
import { canonicalRuntimeName, loadRuntimeRules, decideRuntime, detectSessionHost, formatRulesForDirective, matchedVetoes, resolveDefaultRuntime, unavailableRuntimeMessage, type RuntimeDecision, type RuntimeRule } from "../lib/runtime-rules.ts";
import { DEFAULT_MAX_DEPTH, mayDispatch, refusalMessage, roleMayDispatch, roleRefusalMessage, type DispatchRole } from "../../_shared/lib/dispatch-depth.ts";
import { enumerate, outputsDir, resolveScope } from "../../_shared/lib/scope.ts";
import { paths as nirvanaPaths } from "../../_shared/lib/bun-helpers.ts";
import { briefProblems, parseWorkBrief } from "../lib/work-brief.ts";
import { preflightReindex } from "../lib/preflight-index.ts";
import { maybeSweep } from "./supervisor.ts";
import * as runLedger from "../lib/run-ledger.ts";
import { loadHarnessConfig } from "../lib/harness-config.ts";
import { describeSettingSource, resolveSetting, settingsEnvForChild } from "../../_shared/lib/settings.ts";
import { planRouteWithFallback, resolveDispatchPlan, runAgentX, type DispatchPlan } from "../lib/dispatch-cascade.ts";
import { runSquadHeadless } from "../lib/squad-exec.ts";
import { writeWorkerSession } from "../lib/run-session.ts";
import { parseSquadTarget, resolveSquadCapability } from "../lib/capability-resolver.ts";
import { parseMessageTargetSpec } from "../lib/control-plane/agent-x-canary-queue.ts";
import { runDelivery, deliverAfterRuntimeError, gateableFiles, producesForRubric, runGateOnce, type DeliveryArgs, type DeliveryResult, type RuntimeErrorOutcome } from "../lib/delivery-pipeline.ts";
import { runBusinessPostGate } from "../lib/business-post-gate.ts";
import { parseExecutionOptions } from "../lib/gauntlet/execution-options.ts";
import { decideBusinessCanary, runBusinessCanaryWithRollback } from "../lib/gauntlet/business-canary.ts";
import { compileGauntletPlan } from "../lib/gauntlet/compiler.ts";
import {
  GAUNTLET_EVALUATION_FLOOR_USD, GAUNTLET_EVALUATION_SHARE, gauntletRoundBudget, revisionDefectsSection, rollbackGauntletBeforeProducer,
  runAgentXGauntlet, shouldRunAgentXGauntlet, shouldRunSquadGauntlet, type AgentXGauntletEvaluator, type AgentXRevisionRequest, type GauntletRoundBudget,
} from "../lib/gauntlet/agent-x-cutover.ts";
import { EVALUATION_REQUEST_FILE, SCORECARD_FILE, type EvaluationRequest } from "../lib/gauntlet/evaluation-contract.ts";
import { createDispatchEvaluator, describeTarget } from "../lib/gauntlet/evaluator-adapter.ts";
import { CONFORMANCE_CAPABILITY, GAUNTLET_EVALUATOR_ENV, loadInstalledSquads, selectGauntletEvaluator } from "../lib/gauntlet/evaluator-selection.ts";
import { REQUIREMENTS_MAX, briefConformance, profileScore, requirementsFor, type CapabilityContract } from "../lib/gauntlet/success-requirements.ts";
import { readAcceptance } from "../../businesses/lib/acceptance.ts";
import { JUDGE_X_TARGET, judgeXAvailability, judgeXOutcome, runJudgeX } from "../lib/gauntlet/judge-x.ts";
import type { GauntletPlan, SuccessRequirement } from "../lib/gauntlet/types.ts";
import { RunAlreadyTerminalError, createHarnessLegacyAdapter, openKernel, type TargetRef } from "../lib/run-kernel/index.ts";
import { inertStandardPublication, openStandardPublication } from "../lib/run-kernel/standard-publication.ts";
import { freezeExecutionSnapshot } from "../lib/runtime-snapshot.ts";
import * as runBudget from "../lib/run-budget.ts";

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
const VALUE_FLAGS = new Set(["--project", "--runtime", "--manifest", "--brief-file", "--outputs-root", "--max-budget", "--timeout", "--max-revisions", "--execution-mode", "--gauntlet-intensity", "--business", "--squad", "--run-id", "--mode", "--scope", "-s"]);
/** Flags that take no value. With VALUE_FLAGS, everything this command reads
 *  (`--scope`/`-s` is read by the scope resolver). */
const BOOLEAN_FLAGS = new Set(["--auto", "--agent-x", "--judge-x", "--exec", "--run", "--claude-code", "--scaffold-only", "--zip", "--pdf", "--html",
  "--offline-snapshot", "--auto-brief", "--safe", "--strict-route", "--force-deliver", "--review", "--no-review", "--no-judge", "--no-color", "--help", "-h"]);
/** Flags whose `=<value>` form is read as well as the bare one. */
const OPTIONAL_VALUE_FLAGS = new Set(["--exec", "--auto-brief"]);
function extractPositional(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") || a === "-h" || a === "-s") {
      if (!a.includes("=") && VALUE_FLAGS.has(a)) i++; // skip its space-form value
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Warnings for flags this command does not read and for positionals beyond the
 *  ones it uses. Pure; the caller prints them. An unread flag used to vanish in
 *  silence, and an extra positional did too: `--exec codex` read `codex` as an
 *  argument and nobody was told. */
export function argvWarnings(argv: string[], positionalsUsed: number): string[] {
  const unknown = argv.filter((a) => {
    if (!a.startsWith("-") || a === "-") return false;
    const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (a.includes("=")) return !(VALUE_FLAGS.has(name) || OPTIONAL_VALUE_FLAGS.has(name));
    return !(VALUE_FLAGS.has(name) || BOOLEAN_FLAGS.has(name));
  });
  const extra = extractPositional(argv).slice(positionalsUsed);
  return [
    ...(unknown.length ? [`unknown flag(s) ignored: ${unknown.join(" ")}`] : []),
    ...(extra.length ? [`extra argument(s) ignored: ${extra.map(quoteArg).join(" ")}`] : []),
  ];
}

export { isSafeId } from "../../_shared/lib/run-id.ts";

/** One argument of a command line that pastes into a POSIX shell, PowerShell
 *  and cmd alike: bare when it is plain, otherwise in double quotes (cmd knows
 *  no single quotes), an inner quote written \" and backslashes doubled only
 *  where they precede a quote, so a Windows path keeps its separators. */
export function quoteArg(a: string): string {
  if (a && !/[\s"'`$&|;<>()^%!*?{}[\]#~,]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** The command a user reruns: `nrv dispatch` with these arguments, `--scaffold-only`
 *  dropped and `--exec` added once. Built from argv so nothing the user typed is lost
 *  or truncated. */
export function rerunWithExec(argv: string[]): string {
  const kept = argv.filter((a) => a !== "--scaffold-only");
  const execs = kept.some((a) => a === "--exec" || a.startsWith("--exec=") || a === "--run" || a === "--claude-code");
  return ["nrv", "dispatch", ...kept, ...(execs ? [] : ["--exec"])].map(quoteArg).join(" ");
}

/** The --brief-file contents, or why they cannot be used. Decided from the
 *  file's stat and the error CODE, never from an OS-specific message, so a
 *  Windows path (backslashes, spaces, a drive letter) is read the same way. */
export function readBriefFile(file: string): { text: string } | { error: string } {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { error: code === "ENOENT" || code === "ENOTDIR" ? `--brief-file not found: ${file}` : `--brief-file cannot be read: ${file} (${code ?? "error"})` };
  }
  if (stat.isDirectory()) return { error: `--brief-file is a directory, not a file: ${file}` };
  let text: string;
  try { text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""); }
  catch (error) { return { error: `--brief-file cannot be read: ${file} (${(error as NodeJS.ErrnoException).code ?? "error"})` }; }
  if (!text.trim()) return { error: `--brief-file is empty: ${file}` };
  return { text };
}

/** Whether the runtime the --auto router suggested may replace the one already
 *  decided. Only when the user wrote a USE_* rule for it and no NOT_USE_* rule
 *  that matches this brief vetoes it: the router is a planner, and without a rule
 *  its preference is a guess about whose quota to spend. */
export function routerRuntimeAllowed(suggested: string | null | undefined, brief: string, rules: RuntimeRule[]):
  { allowed: true; rule: RuntimeRule } | { allowed: false; reason: string } {
  if (!suggested) return { allowed: false, reason: "no runtime suggested" };
  const rule = rules.find((r) => !r.negate && r.runtime === suggested);
  if (!rule) return { allowed: false, reason: `no USE_* rule names ${suggested}` };
  const veto = matchedVetoes(brief, rules).find((v) => v.rule.runtime === suggested);
  if (veto) return { allowed: false, reason: `${veto.rule.envKey} vetoes ${suggested} for this brief` };
  return { allowed: true, rule };
}

// ── explicit target selection ──────────────────────────────────────────────
// --business <slug> · --squad <slug>[:<capabilityId>] · --agent-x name the
// target directly and never consult the router. They are mutually exclusive
// with each other and with --auto. --judge-x is the engine's Gauntlet judge
// (lib/gauntlet/judge-x.ts): the evaluator adapter spawns it on an evaluation
// brief; it never enters the cascade. Pure: the CLI flow turns an error into
// exit 4. The squad grammar is the one `evaluator-selection.ts` already parses
// out of NIRVANA_GAUNTLET_EVALUATOR=squad:<slug>[:<capabilityId>].
export type ExplicitTarget = { kind: "business" | "squad"; slug: string; capabilityId?: string } | { kind: "agent-x" } | { kind: "judge-x" };
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
  const judgeX = argv.includes("--judge-x");
  const auto = argv.includes("--auto");
  const given = [business !== undefined && "--business", squad !== undefined && "--squad", agentX && "--agent-x", judgeX && "--judge-x", auto && "--auto"]
    .filter((flag): flag is string => typeof flag === "string");
  if (given.length > 1) return { target: null, error: `${given.join(", ")} are mutually exclusive: name one target, or use --auto` };
  if (business === null) return { target: null, error: "--business requires a slug" };
  if (squad === null) return { target: null, error: "--squad requires a slug" };
  if (business) return { target: { kind: "business", slug: business }, error: null };
  if (squad) {
    const parsed = parseSquadTarget(squad);
    if (!parsed) return { target: null, error: `--squad expects <slug>[:<capabilityId>], got '${squad}'` };
    return { target: { kind: "squad", slug: parsed.slug, ...(parsed.capabilityId ? { capabilityId: parsed.capabilityId } : {}) }, error: null };
  }
  if (agentX) return { target: { kind: "agent-x" }, error: null };
  if (judgeX) return { target: { kind: "judge-x" }, error: null };
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

/** Dispatch plan for an explicit cascade target: one step, source "explicit", no router. */
export async function explicitTargetPlan(target: Exclude<ExplicitTarget, { kind: "judge-x" }>): Promise<DispatchPlan> {
  if (target.kind === "agent-x") {
    return {
      ok: true, steps: [{ kind: "agent-x", reason: "explicit user target" }],
      mandatorySquads: [], optionalSquads: [], suggestedMindClones: [], rationale: "", source: "explicit",
    };
  }
  return resolveDispatchPlan(NO_ROUTER_DECISION, { explicitTarget: target });
}

/** The target a brief names at its head, when the installed registry knows it.
 *
 * `use squad <slug>[:<capabilityId>]:` and `use business <slug>:` are the grammar
 * the Glance already reads on a Message (parseMessageTargetSpec). Under --auto the
 * router honored that phrasing only because its prompt tells it to, so a brief that
 * named its target still paid a whole agentic routing run to be sent where it said.
 * A slug the registry does not know returns null and the router decides, as before. */
export function installedBriefTarget(text: string, loadRegistries: () => { squads: Record<string, unknown>; businesses: Record<string, unknown> } = defaultRegistries):
  { kind: "business" | "squad"; slug: string; capabilityId?: string } | null {
  const spec = parseMessageTargetSpec(text || "");
  const t = spec.target;
  if (t.kind !== "squad" && t.kind !== "business") return null;
  let known: Record<string, unknown> = {};
  try {
    const r = loadRegistries();
    known = (t.kind === "squad" ? r.squads : r.businesses) ?? {};
  } catch { return null; }
  if (!Object.prototype.hasOwnProperty.call(known, t.slug)) return null;
  return { kind: t.kind, slug: t.slug, ...(spec.capabilityId ? { capabilityId: spec.capabilityId } : {}) };
}

function defaultRegistries(): { squads: Record<string, unknown>; businesses: Record<string, unknown> } {
  const loader = require("../lib/registry-loader.js");
  return { squads: loader.loadSquads().registry.squads ?? {}, businesses: loader.loadBusinesses().registry.businesses ?? {} };
}

// ── the one answer to "which project is this?" ────────────────────────────
// NIRVANA_PROJECT_ROOT when the caller named it, else the invocation cwd walked
// up to its marker — the rule _shared/lib/paths.js gives every other consumer
// (supervisor, config, multi-target, runtime-snapshot). run-ledger owns the TS
// half of it and memoizes the walk.
//
// It is NEVER derived from the outputs root. This file used to answer twice:
// from the environment on one line and by `resolve(projDir, "..", "..")` on two
// others. With an outputs root outside the project tree the arithmetic climbed
// out of the project (as far as $HOME), so ONE trace wrote its dispatch events
// under the project, its scaffold events under `<outputs>/<pid>` and its
// `gate_passed` under `~/.harness-logs` — three files, an unauditable chain, and
// a child runtime told its project was the user's home directory.
//
// Where a path still has to be scaffold-shaped (brief.md, the dispatch kernel,
// the Gauntlet workspace) the variable is called `scaffoldRoot` and says so.
//
// Outside any project the engine's store is the state root: HOME stands in, so
// every `<root>/.nirvana/…` path (the dispatch kernel, the run budget) is the
// store itself, HOME is never read as a project by the log and state resolvers,
// and the run's outputs go to `<store>/outputs/<pid>` (OUTPUTS_BASE) — the same
// place scope.ts and the squad output resolver use. This used to be the cwd, so
// a dispatch launched from any folder planted `outputs/` and `.nirvana/` in it.
const DECLARED_PROJECT_ROOT = runLedger.resolveProjectRoot();
const PROJECT_ROOT = DECLARED_PROJECT_ROOT ?? path.dirname(globalStoreDir());
// A dispatch a confined worker starts itself (an employee's `nrv dispatch --squad`)
// belongs to the worker's run: its scaffold nests under that run folder, so the
// worker and whatever follows it in that run can read what it delivers
// (run-workspace.ts nestedOutputsBase). From the operator this is null and the
// outputs base is the project's (or the store's), as before.
const NESTED_OUTPUTS_BASE = nestedOutputsBase(DECLARED_PROJECT_ROOT);
const OUTPUTS_BASE = NESTED_OUTPUTS_BASE ?? outputsBaseDir(DECLARED_PROJECT_ROOT);

const positional = extractPositional(process.argv.slice(2));
// --auto: no business is named; the router picks the best one for the brief.
// In that mode the first positional is the brief itself, as it is when an
// explicit --business / --squad / --agent-x flag names the target.
const autoMode = process.argv.includes("--auto");
const explicit = parseExplicitTarget(process.argv.slice(2));
const explicitTarget = explicit.target;
// Routing mode. Precedence: --mode > env > config.
const routingMode = resolveRoutingMode(arg("--mode"));
let slug = autoMode ? "" : explicitTarget ? (explicitTarget.kind === "business" ? explicitTarget.slug : "") : positional[0];
const inlineBrief = (autoMode || explicitTarget) ? positional[0] : positional[1];
const briefFile = arg("--brief-file");
const manifest = arg("--manifest");
const projectId = arg("--project");
// --run-id: the Run's id instead of the derived run_<project>: adopted when a
// control plane prepared it (Glance), created when it does not exist yet (one
// per multi-target node attempt).
const runIdFlag = arg("--run-id");
// ONE kernel per project, with the flag or without it: the project root's, the
// same file Glance serves (glance/server.ts), multi-target compiles into and the
// canary queue sweeps for orphans.
//
// This used to answer `<scaffold>/.nirvana/run-kernel.sqlite` when --run-id was
// absent, to keep the pre-kernel behaviour byte-for-byte. The price was the whole
// normal case: every dispatch without the flag published its Run into a database
// nothing else opens. On 27/08/2026 the owner had two dispatches alive and the
// cockpit read `0 running` over three STALE cards while the log panel of the same
// screen streamed their events — one screen, two paths, and the list read the
// empty one. The Run is a project-level record; the scaffold is a draft directory
// (`nrv clean <pid>` deletes it), and a record does not belong inside a draft.
const KERNEL_PATH = path.join(PROJECT_ROOT, ".nirvana", "run-kernel.sqlite");
// No default here: which runtime runs the work is decided once, further down,
// by the session-aware resolution. A literal fallback made `--runtime` with no
// value mean one vendor.
const runtime = arg("--runtime");
// Was the --runtime flag GIVEN by the user? (an explicit flag ALWAYS beats the
// USE_* rules — a rule only beats the default.)
const runtimeFlagGiven = process.argv.some(a => a === "--runtime" || a.startsWith("--runtime="));
const outputsRoot = arg("--outputs-root");
const noColor = process.argv.includes("--no-color") || !process.stdout.isTTY;

function c(color: string, text: string): string {
  return noColor ? text : `${(ANSI as any)[color]}${text}${ANSI.reset}`;
}

// Inherited, not chosen: say so. The keyword router is not advertised to agents
// any more — not in the help, not in the protocol, not in a worker's prompt. That
// makes silence dangerous in one direction: a machine carrying `routing.mode:
// fast` in a config file would route by score forever while the agent driving
// it has never heard the mode exists and cannot name what it is seeing. So the
// mode is silent when it is chosen for a run, and loud when it is inherited.
if (routingMode === "fast" && routingModeOrigin(arg("--mode")) !== "flag") {
  const from = routingModeOrigin(arg("--mode"));
  console.error(c("yellow", `  ⚠ routing.mode is 'fast' on this machine${from === "env" ? " (from NIRVANA_ROUTING_MODE)" : " (from a config file)"}.`));
  console.error(c("yellow", "    Targets are being picked by keyword match instead of by reading the entities, and this run did not ask for that."));
  console.error(c("yellow", `    Clear it with: nrv config unset routing.mode${from === "env" ? "  — and unset NIRVANA_ROUTING_MODE in your shell" : ""}`));
}

// ── exec-mode flags ──────────────────────────────────────────────────────
/** One alias table, shared with USE_* and NIRVANA_HOST_RUNTIME. This used to be
 *  a private ladder that knew five of the nine runtimes, so `--exec=kimi` and
 *  `--exec=grok` fell through to the pass-through branch and reached the driver
 *  as the literal word the user typed — "unknown runtime 'grok'" — while an
 *  empty value answered with one vendor's name. */
const normRuntime = (s: string): Runtime => canonicalRuntimeName(s);
/** Whether the caller asked to EXECUTE, not which runtime to execute in. It
 *  used to answer with a runtime and default a bare `--exec` to one vendor; the
 *  value was never read (only its nullness was), so the literal was a landmine
 *  waiting for the first reader who trusted it. Which runtime runs the work is
 *  decided once, further down, by the session-aware resolution. */
function wantsExec(): boolean {
  return process.argv.some(a => a.startsWith("--exec=")) || process.argv.includes("--exec")
    || process.argv.includes("--run") || process.argv.includes("--claude-code");
}
const wantExec = wantsExec();
// The one way to prepare a run without running it: folder and prompt, exit 3.
// Without it and without --exec the command refuses before creating anything.
const scaffoldOnly = process.argv.includes("--scaffold-only");
const wantHelp = process.argv.slice(2).some(a => a === "--help" || a === "-h");
const wantZip = process.argv.includes("--zip");
const wantPdf = process.argv.includes("--pdf");
// HTML report is the DEFAULT (skipped only in fast mode or with --no-html). --html
// stays as a no-op alias for compat. --offline-snapshot inlines the CDN assets.
// The HTML report is produced ON REQUEST, never by default. It used to run on
// every delivery, and on a customer VPS it shipped 81 KB that held none of the
// delivered work and all of the run's instrumentation. A deliverable nobody
// asked for is a deliverable nobody checks.
const wantHtml = process.argv.includes("--html") && routingMode !== "fast";
const skipHtml = !wantHtml;
const autoBriefEq = process.argv.find(a => a.startsWith("--auto-brief="));
const autoBriefMode = autoBriefEq ? autoBriefEq.split("=")[1] : (process.argv.includes("--auto-brief") ? "inferred" : null);
const wantAutoBrief = autoBriefMode !== null;
// Default = autonomy (Bash enabled; claude in auto mode, the other runtimes skip approvals)
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

// A business runs as ONE agent that plays its seats itself and opens nothing
// (lib/business-solo.ts); the review that may follow is decided by a rule
// (lib/solo-review.ts). `--review` asks for one, `--no-review` declines it.
const reviewAsked = process.argv.includes("--review");
const reviewDeclined = process.argv.includes("--no-review");

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

/** Usage, on stdout for --help and on stderr when the command cannot run. */
function printUsage(write: (line: string) => void): void {
  const runtimes = listRuntimes().map(r => r.name).join("|");
  const sessionHost = detectSessionHost();
  [
    "Usage: nrv dispatch <business_slug> \"<brief>\" --exec [opts]",
    "       nrv dispatch --squad=<slug>[:<capability>] | --agent-x | --auto  \"<brief>\" --exec [opts]",
    "",
    "  Target (name one, or use --auto; they are mutually exclusive):",
    "    <business_slug>         the business, as the first positional",
    "    --business=<slug>       the business, named by flag",
    "    --squad=<slug>[:<capability>]  a squad, with the capability id `nrv find` printed when one fits; no router",
    "    --agent-x               the generalist; no router",
    "    --auto                  no target named: the router picks one for the brief (first positional = the brief)",
    "    --judge-x               the engine's Gauntlet judge on an evaluation brief (the evaluator adapter's child)",
    "",
    "  Run:",
    "    --exec[=<runtime>]      run it: execute, verify, gate, deliver. Without --exec the command refuses",
    "    --scaffold-only         prepare the run folder and the prompt without running them (exit 3)",
    `    --runtime=<name>        ${runtimes} (default: ${sessionHost ? `${sessionHost}, ` : ""}the runtime of this session)`,
    "    --claude-code           shortcut for --exec=claude-code",
    "    --brief-file=<path>     the brief in a file (alternative to an inline brief)",
    "    --manifest=<path>       deliverables.json, the expected paths (business only)",
    "    --project=<id>          project id, a plain name and never a path (default: generated)",
    "    --outputs-root=<dir>    where the deliverables are written",
    "    --mode=<mode>           how --auto routes: agentic|cards (default: routing.mode)",
    "    --auto-brief            enrich a thin brief and decide for the human",
    "    --review | --no-review  ask for the delivery review, or decline it (business only; review.policy decides otherwise)",
    "    --zip | --pdf | --html  pack the deliverables / build final-report.pdf / final-report.html (business only)",
    "    --execution-mode=<mode> standard|gauntlet|auto (default: standard)",
    "    --gauntlet-intensity=<profile> light|balanced|exhaustive",
    "    --run-id=<runId>        the Run's id in the project kernel: adopted when prepared (Glance), created otherwise (multi-target nodes); default run_<project>",
    "    --max-budget=<usd>      cost ceiling for the run (claude --max-budget-usd)",
    "    --timeout=<min>         wall-clock ceiling for the run (default 24h; a real hang is caught by ~5 min of inactivity)",
    "    --max-revisions=<n>     automatic revisions after a failed gate (default: quality_gate.max_revisions)",
    "    --safe                  opt in to restricted mode (limited tools + sandbox); default = full trust",
    "    --no-judge              skip the LLM judge for this run; the offline heuristic gate still runs",
    "    --strict-route          an ambiguous route FAILS instead of auto-picking the top candidate",
    "    --force-deliver         deliver even when the gate fails (delivered gate:\"fail-forced\")",
    "    -h, --help              this text",
    "",
    "  Exit codes:",
    "    0  delivered, or delivered with reservations (<outputs>/_STATUS.json says which)",
    "    1  run failed (routing, execution or verification)",
    "    2  delivery WITHHELD: the gate failed after the revisions",
    "    3  INDETERMINATE: nothing was judged (zero gateable artifacts, or --scaffold-only)",
    "    4  invalid input, or refused before anything ran (no --exec, role, depth)",
    "",
    "Examples:",
    "  nrv dispatch brand-creative-studio \"Brand manifesto for product X\" --exec",
    "  nrv dispatch --squad=copy-squad --brief-file=brief.md --exec",
    "  nrv run my-brand \"car accident case\" --auto-brief --zip",
  ].forEach(write);
}

if (wantHelp) {
  printUsage(line => console.log(line));
  process.exit(0);
}

if (explicit.error) {
  console.error(`nrv dispatch: ${explicit.error}`);
  process.exit(4);
}

if (!slug && !autoMode && !explicitTarget) {
  printUsage(line => console.error(line));
  process.exit(4);
}

// ── input validation ───────────────────────────────────────────────────────
// Everything a dispatch can be wrong about is checked here, before the first
// side effect: an input that cannot run creates no folder, writes no audit
// event, opens no ledger row and calls no runtime. Each refusal is exit 4.
function refuse(message: string): never {
  console.error(c("red", `✗ nrv dispatch: ${message}`));
  process.exit(4);
}
const cliArgs = process.argv.slice(2);
// Who may dispatch what (_shared/lib/dispatch-depth.ts), first: it is about the
// caller, not the input. The driver refuses the spawn as well; refusing here
// means a worker that tries gets the rule before a folder, a ledger row or a
// router call exists.
const targetRole: DispatchRole | null = explicitTarget?.kind === "squad" ? "squad"
  : explicitTarget?.kind === "agent-x" ? "agent-x"
  : explicitTarget?.kind === "judge-x" ? "planner"
  : (!autoMode && slug) ? "solo" : null;
if (!roleMayDispatch(targetRole)) refuse(roleRefusalMessage(targetRole));
const maxDispatchDepth = (() => {
  try { const v = Number(resolveSetting("execution.max_dispatch_depth").value); return Number.isFinite(v) ? v : DEFAULT_MAX_DEPTH; }
  catch { return DEFAULT_MAX_DEPTH; }
})();
if (!mayDispatch(maxDispatchDepth)) refuse(refusalMessage(maxDispatchDepth));
for (const warning of argvWarnings(cliArgs, (autoMode || explicitTarget) ? 1 : 2)) console.error(c("yellow", `⚠ ${warning}`));
for (const [i, a] of cliArgs.entries()) {
  const eq = a.indexOf("=");
  if (eq > 0 && VALUE_FLAGS.has(a.slice(0, eq)) && eq === a.length - 1) refuse(`${a.slice(0, eq)} requires a value`);
  if (VALUE_FLAGS.has(a) && a !== "--business" && a !== "--squad" && (cliArgs[i + 1] === undefined || cliArgs[i + 1].startsWith("--"))) {
    refuse(`${a} requires a value`);
  }
}
if (wantExec && scaffoldOnly) refuse("--exec and --scaffold-only are mutually exclusive: run it, or only prepare it");
if (cliArgs.some(a => a === "--mode" || a.startsWith("--mode=")) && !["agentic", "cards", "fast"].includes((arg("--mode") ?? "").trim().toLowerCase())) {
  // The keyword mode is accepted but not offered (fast-is-not-advertised.test.ts).
  refuse(`--mode expects agentic or cards (got '${arg("--mode") ?? ""}')`);
}
for (const [flag, value, valid, expects] of [
  ["--max-budget", maxBudget, (v: string) => v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0, "an amount in USD, 0 or more"],
  ["--timeout", timeoutMin, (v: string) => /^\d+$/.test(v) && Number(v) > 0, "whole minutes, 1 or more"],
  ["--max-revisions", maxRevisionsFlag, (v: string) => /^\d+$/.test(v), "a whole number, 0 or more"],
] as const) {
  if (value !== undefined && !valid(value)) refuse(`${flag} expects ${expects} (got '${value}')`);
}
if (projectId !== undefined && !isSafeId(projectId)) {
  refuse(`--project must be a plain id (letters, digits, '.', '_', '-'), never a path: '${projectId}'`);
}
if (manifest) {
  let isFile = false;
  try { isFile = fs.statSync(manifest).isFile(); } catch { isFile = false; }
  if (!isFile) refuse(`--manifest is not a readable file: ${manifest}`);
}

let brief = inlineBrief;
// The brief file's own text, when the run's brief is that file unchanged: the
// worker then reads the file itself, so a decision appended to it mid-run
// (`nrv brief decide`) still reaches it.
let briefFileText: string | null = null;
if (briefFile) {
  const read = readBriefFile(briefFile);
  if ("error" in read) refuse(read.error);
  briefFileText = read.text;
  if (brief) console.error(c("yellow", `⚠ both an inline brief and --brief-file were given: the inline brief is used, ${briefFile} is not`));
  else brief = read.text;
}
if (!brief) refuse("pass an inline brief or --brief-file");
if (briefFileText !== null && brief === briefFileText && explicitTarget?.kind !== "judge-x") {
  const problems = briefProblems(parseWorkBrief(brief));
  if (problems.length) console.error(c("yellow", `⚠ ${briefFile}: ${problems.join("; ")} (\`nrv brief template\` shows the six sections)`));
}

// Runtime names, wherever they come from: a name the roster does not know used
// to reach the driver as the literal word the user typed.
const knownRuntimes = listRuntimes().map(r => r.name);
const defaultRuntimeSetting = resolveSetting("execution.default_runtime");
const execEq = cliArgs.find(a => a.startsWith("--exec="))?.slice("--exec=".length).trim() ?? "";
for (const [value, origin] of [
  [runtimeFlagGiven ? (runtime ?? "") : "", "--runtime"],
  [execEq, "--exec="],
  [String(defaultRuntimeSetting.value ?? "").trim(), `execution.default_runtime, ${describeSettingSource(defaultRuntimeSetting)}`],
  // hermes is a host that delegates but does not execute: a valid value here.
  [/^hermes$/i.test((process.env.NIRVANA_HOST_RUNTIME ?? "").trim()) ? "" : (process.env.NIRVANA_HOST_RUNTIME ?? "").trim(), "NIRVANA_HOST_RUNTIME"],
] as const) {
  if (value && !knownRuntimes.includes(canonicalRuntimeName(value))) refuse(`unknown runtime '${value}' (${origin}). Valid: ${knownRuntimes.join(", ")}`);
}

// The named target exists. Resolved the way the prep scripts resolve it, so
// this check and theirs cannot disagree; a missing target is an input error.
const namedEntity = explicitTarget?.kind === "squad" ? { kind: "squads" as const, noun: "squad", slug: explicitTarget.slug }
  : (!autoMode && slug) ? { kind: "businesses" as const, noun: "business", slug } : null;
if (namedEntity) {
  if (!isSafeId(namedEntity.slug)) refuse(`'${namedEntity.slug}' is not a ${namedEntity.noun} slug (letters, digits, '.', '_', '-')`);
  const hit = enumerate(resolveScope(), namedEntity.kind).find(e => e.slug === namedEntity.slug && !e.overridden);
  const dir = hit?.dir ?? path.join(namedEntity.kind === "squads" ? nirvanaPaths.SQUADS_DIR : nirvanaPaths.BUSINESSES_DIR, namedEntity.slug);
  let installed = false;
  try { installed = fs.statSync(dir).isDirectory(); } catch { installed = false; }
  if (!installed) refuse(`${namedEntity.noun} '${namedEntity.slug}' is not installed (\`nrv list-${namedEntity.kind}\` lists them)`);
}

// Owner decision: a dispatch runs, or it does not start. Without --exec it used
// to leave a prepared folder behind and exit 3, and an orchestrator that forgot
// the flag believed it had dispatched. --scaffold-only is the one way to ask for
// the folder and the prompt alone.
if (!wantExec && !scaffoldOnly) {
  console.error(c("red", "✗ nrv dispatch runs the work only with --exec. Nothing was started and nothing was created."));
  console.error(c("cyan", "  Run it:"));
  console.error("    " + c("yellow", rerunWithExec(cliArgs)));
  console.error(c("dim", "  (--scaffold-only prepares the run folder and the prompt without running them.)"));
  process.exit(4);
}

// ── User USE_* rules (natural-language per-runtime routing) ────────────────
// Precedence: explicit flag (--exec=<rt> | --claude-code | --runtime given)
// > brief mention > USE_* rule > default = the runtime the USER IS ALREADY
// USING (session host). The LLM_CASCADE still owns resilience (quota).
const runtimeRules = loadRuntimeRules(resolveCascadeRoot(process.cwd()));
const explicitRuntime: Runtime | null = (() => {
  if (execEq) return normRuntime(execEq);
  if (process.argv.includes("--claude-code")) return "claude-code";
  if (runtimeFlagGiven && runtime) return normRuntime(runtime);
  return null;
})();
// An unidentified host is a STATE THE SYSTEM DECLARES, never a silent
// synonym for one vendor: env markers first, then the process tree, since a
// host that exports no marker is still this process's ancestor
// (NRV_HOST_ANCESTRY=0 switches the walk off; the test preload does).
const detectedHost = detectSessionHost();
// The execution.default_runtime setting: NIRVANA_DEFAULT_RUNTIME, else the project or global config.
const envDefault = String(defaultRuntimeSetting.value ?? "").trim();
// Resolution order once detection fails: an explicit execution.default_runtime,
// then whatever is actually installed — chosen from the roster, never
// hardcoded to one vendor. The choice is announced and audited below.
const firstAvailable = (): Runtime | null =>
  (listRuntimes().map(r => r.name).find(n => runtimeAvailable(n)) ?? null);
const hostDefault: Runtime = resolveDefaultRuntime({ detectedHost, envDefault, normalize: normRuntime, firstAvailable }).runtime;
let runtimeDecision: RuntimeDecision = decideRuntime({
  brief, explicitRuntime, defaultRuntime: hostDefault,
  rules: runtimeRules, mode: routingMode as "agentic" | "fast",
  available: runtimeAvailable,
});
const installedRuntimes = (): Runtime[] => listRuntimes().map((r) => r.name).filter(runtimeAvailable);
// A runtime the caller NAMED (flag or brief) and this machine does not have:
// refuse, and say what is installed. Serving the run from another vendor
// behind their back is the defect the resolution order above exists to prevent.
if (runtimeDecision.unavailable) {
  console.error(c("red", "✗") + " " + unavailableRuntimeMessage({ runtime: runtimeDecision.runtime, installed: installedRuntimes() }));
  process.exit(4);
}
// Whatever the source, the runtime that will run the work (or the --auto
// router) has to be here. Checked once, before anything exists.
if ((wantExec || (autoMode && routingMode !== "fast")) && !runtimeAvailable(runtimeDecision.runtime)) {
  const installed = installedRuntimes();
  refuse(`runtime '${runtimeDecision.runtime}' (${runtimeDecision.source === "default" ? (detectedHost ? "this session" : envDefault ? "execution.default_runtime" : "the default") : runtimeDecision.source}) is not installed on this machine. `
    + `Installed: ${installed.length ? `${installed.join(", ")}. Install it, or pass --runtime with one of those` : "none. Install a supported runtime"} (\`nrv doctor\` shows which runtimes work).`);
}

// ── an explicit --project that already holds a run ─────────────────────────
// Generated ids are unique; an explicit --project is reused on purpose (a Glance
// chat, a re-dispatch after a failure), and its folder is the earlier run's. A
// run still working there is refused before anything exists: two workers in one
// folder overwrite each other. A run that ended without a decision (failed,
// stalled, or a worker gone with its lease expired) is superseded once this run
// opens its own row: left open, the supervisor could resume it into the folder
// this run is using (a run failed on quota, `nrv clean` moved its folder, the
// project was re-dispatched on another runtime, and the old row stayed active).
// A dispatch with --run-id is coordinated by a control plane (Glance, a
// multi-target plan running a wave of nodes under one project id) that owns the
// concurrency of its own runs, and is left out.
const priorRuns: runLedger.RunRow[] = (() => {
  if (!projectId || runIdFlag) return [];
  try { return runLedger.findNonTerminal(runLedger.openLedger()).filter(row => row.project_id === projectId); }
  catch (e) {
    console.error(c("dim", `  (run ledger unavailable: ${(e as Error)?.message ?? e}; earlier runs of --project ${projectId} were not checked)`));
    return [];
  }
})();
const workingRun = priorRuns.find(row => runLedger.WORKING_STATES.has(row.state) && runLedger.stillWorking(row));
if (workingRun) refuse(`run ${workingRun.run_id} is still working in this project; wait for it or pick another --project`);

/** This dispatcher beside the worker the sidecar records: `nrv run-track stop`
 *  ends both, so the dispatcher does not take a killed worker for a failure
 *  and carry on to the gate. The start time tells a reused pid from this one. */
function dispatcherMeta(): Record<string, unknown> {
  return { dispatcher_pid: process.pid, dispatcher_started_at: runLedger.processStartedAt(process.pid) };
}

/** Abandons what an earlier dispatch into this --project left open. Called
 *  once this run's own row is open, and never for a run that did not start. */
function supersedePriorRuns(newRunId: string): void {
  if (!priorRuns.length) return;
  const closed: string[] = [];
  try {
    const handle = runLedger.openLedger();
    for (const prior of priorRuns) {
      const row = runLedger.getRun(handle, prior.run_id);
      // Re-read: it may have ended, or been picked up again, since the check above.
      if (!row || row.run_id === newRunId || runLedger.isTerminal(row.state)) continue;
      if (runLedger.WORKING_STATES.has(row.state) && runLedger.stillWorking(row)) continue;
      runLedger.abandon(handle, row.run_id, `superseded by ${newRunId}`);
      closed.push(row.run_id);
    }
  } catch (e) { console.error(`[run-ledger] ${(e as Error)?.message ?? e}`); }
  if (closed.length) console.error(c("yellow", `⚠ --project ${projectId}: earlier run(s) ${closed.join(", ")} abandoned, superseded by ${newRunId}.`));
}

/** A runtime the user chose (flag, or named in the brief) is pinned: its run
 *  never hands off to another vendor, quota failure included. Read at call
 *  time, since the --auto router may still replace a default with a rule. */
const runtimePinned = (): boolean => runtimeDecision.source === "flag" || runtimeDecision.source === "brief";
/** The cascade runner every dispatched worker goes through, with the pin applied.
 *  Passed through the libraries' cascade seam until they take `pinned` themselves. */
const pinnedCascade: typeof runWithCascade = (cascadeArgs) => runWithCascade({ ...cascadeArgs, pinned: cascadeArgs.pinned || runtimePinned() });

// ── side effects start here ─────────────────────────────────────────────────

// Say where the work will land before any of it does. Outside a project that
// is the engine's store, and the line names the command that makes one.
console.log(c("dim", DECLARED_PROJECT_ROOT
  ? `  project: ${DECLARED_PROJECT_ROOT} · outputs under ${OUTPUTS_BASE}`
  : `  no Nirvana project here (no .nirvana/project.yaml; \`nrv init\` makes one) · outputs under ${OUTPUTS_BASE}`));

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

// Never route/dispatch against a stale corpus (routing-360 Phase 2.5);
// <50ms when fresh — mtime stats only.
preflightReindex();
// Never-stall guarantee (routing-360 Phase 4): recover forgotten runs lazily.
// <20ms when nothing pending; spawns a DETACHED background sweep otherwise.
// Not while this --project holds runs this dispatch is about to supersede: the
// sweep could resume one into the folder this run is taking. The sweep on the
// way out runs after they are abandoned.
if (!priorRuns.length) maybeSweep();
// Second trigger: the session that ran this dispatch and waited on it is the
// supervisor too. A dispatch can run for tens of minutes; reconciling again
// on the way out — no timer, just "control is about to return" — catches
// whatever else went stale while this one was busy. Still rate-limited by
// maybeSweep's own 5-minute floor, so a short dispatch pays nothing extra.
process.on("exit", () => { try { maybeSweep(); } catch { /* never block exit */ } });

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
// --no-judge: this run keeps only the offline heuristic gate, whatever the
// config says. `quality_gate.judge_enabled: false` does the same for good.
if (process.argv.includes("--no-judge")) harnessConfig.quality_gate.judge_enabled = "false";
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

/** Where this run's spend is accounted. `--outputs-root` when the caller gave
 *  one (serve always does), otherwise whatever path computed the run's root
 *  most recently. One dispatch is one process, so this is run state. */
let _runBudgetRoot: string | null = null;
// An explicit --outputs-root wins (serve always gives one), then the FIRST root
// any path computed. First and not last on purpose: the budget belongs to the
// run, and a nested child — a Gauntlet candidate, an evaluation — must charge
// the run that pays for it rather than opening an account of its own.
// Keyed by the whole root, not its basename: every generated root ends in
// `deliverables`, so the basename alone gave every run of a project one account.
function runBudgetKey(): string {
  const root = outputsRoot ?? _runBudgetRoot;
  if (!root) return "run";
  const abs = path.resolve(root);
  return `${path.basename(abs)}-${createHash("sha1").update(abs).digest("hex").slice(0, 12)}`;
}
function setRunBudgetRoot(dir: string): void { if (_runBudgetRoot === null) _runBudgetRoot = dir; }

/** The ceiling the OWNER named: the tighter of --max-budget and the business's
 *  own run_budget_usd, or nothing at all. Never a number of the engine's own. */
function ownerCeilingUsd(): number | undefined {
  const flag = maxBudget ? parseFloat(maxBudget) : null;
  const biz = typeof slug === "string" && slug ? businessRunBudget(slug) : null;
  const caps = [flag, biz].filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  return caps.length ? Math.min(...caps) : undefined;
}

/**
 * What the NEXT child may spend.
 *
 * The ceiling is for the run, not for each child. Passing the full number to
 * every child gave each its own ceiling: a run capped at $2 spent $4.90 on a
 * customer VPS. This reads what the run has already spent and offers
 * the remainder. With no ceiling it returns undefined, which is the normal case.
 */
function effectiveBudgetUsd(): number | undefined {
  const ceiling = ownerCeilingUsd();
  if (ceiling === undefined) return undefined;
  return runBudget.remaining(runBudget.open(PROJECT_ROOT, runBudgetKey(), ceiling));
}

/** Records what a child cost, so the next one is offered what is left. */
function chargeRunBudget(costUsd: number | null | undefined): void {
  const ceiling = ownerCeilingUsd();
  if (ceiling === undefined) return;
  const key = runBudgetKey();
  runBudget.charge(PROJECT_ROOT, key, runBudget.open(PROJECT_ROOT, key, ceiling), costUsd);
}

/** True when the owner's ceiling is spent. Checked BEFORE a child starts:
 *  a run stopped after the overage has already paid for it. */
function runBudgetExhausted(): boolean {
  const ceiling = ownerCeilingUsd();
  if (ceiling === undefined) return false;
  return runBudget.exhausted(runBudget.open(PROJECT_ROOT, runBudgetKey(), ceiling));
}

// ── the runtime decided above, announced and audited ───────────────────────
// The choice was made before any side effect; from here on it is said out loud.
if (!detectedHost) {
  const how = envDefault ? `execution.default_runtime=${hostDefault} (${describeSettingSource(defaultRuntimeSetting)})` : `first available on PATH: ${hostDefault}`;
  console.error(c("yellow", "⚠") + ` host runtime not identified — using ${how}.`
    + " Pin it with NIRVANA_DEFAULT_RUNTIME in .env, nrv config set execution.default_runtime <runtime>, --runtime, or by naming it in the brief.");
  emit("x_host_runtime_undetected", { used: hostDefault, from: envDefault ? defaultRuntimeSetting.source : "path-scan", cwd: process.cwd() });
}
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
// Read only by a business session, which lists them beside the mandatory ones.
let autoOptionalSquads: string[] = [];
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
  | { kind: "judge-x" }
  | null = null;
// A brief that opens by naming an installed squad or business goes there with
// no router, exactly as --squad / --business would send it.
const briefTarget = autoMode ? installedBriefTarget(brief ?? "") : null;
if (briefTarget) {
  emit("x_explicit_target_short_circuit", {
    project_id: projectId || null, target_kind: briefTarget.kind, target_slug: briefTarget.slug,
    capability_id: briefTarget.capabilityId ?? null,
  });
  if (briefTarget.kind === "business") {
    slug = briefTarget.slug;
    console.log(c("lime", "▶") + c("bold", ` Target named in the brief — business ${slug}`) + c("dim", " (no router)"));
    emit("auto_route_selected", { project_id: projectId || null, business_slug: slug, method: "explicit-in-brief" });
  } else {
    const plan = await explicitTargetPlan(briefTarget);
    const step = plan.steps[0];
    console.log(c("lime", "▶") + c("bold", ` Target named in the brief — squad ${step.slug}`) + c("dim", " (no router)"));
    pendingCascade = { kind: "squad-only", squads: [step.slug!], plan };
  }
} else if (autoMode && routingMode === "fast") {
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
  // explicit asks are ALWAYS honored. cards: one tool-less call over the
  // compiled cards, answering the same contract (lib/cards-router.ts).
  console.log(c("lime", "▶") + c("bold", ` Auto-route — ${routingMode}`));
  const rt = explicitRuntime || runtimeDecision.runtime;
  // The router runs on a runtime like any other work, so it can land on one that
  // is down. Picking the runtime PER ATTEMPT (rather than closing over a single
  // choice) is what makes the ladder's "retry once" land somewhere healthy: on a
  // dead runtime the router otherwise fails twice and the brief falls through to
  // agent-x with no specialist — routing quality lost to an unrelated outage.
  const routerRoot = resolveCascadeRoot(process.cwd());
  // The cards router's done states, from the call the plan was built on.
  let routedDone: string[] = [];
  const routeOnce = async () => {
    let runtime = rt;
    // A runtime the user chose is pinned: the router waits for it rather than
    // spending another vendor's quota.
    if (!runtimePinned() && isInCooldown(routerRoot, runtime)) {
      const alt = nextAfter(routerRoot, loadCascade(routerRoot), runtime)?.runtime;
      if (alt && alt !== runtime) {
        console.error(c("yellow", `  ⚠ ${runtime} unavailable (${getCooldown(routerRoot, runtime)?.reason || "cooldown"}) — routing via ${alt}`));
        runtime = alt;
      }
    }
    const d = routingMode === "cards"
      ? await cardsRoute({
        brief, runtime, cwd: process.cwd(), projectId: projectId || null,
        maxBudgetUsd: effectiveBudgetUsd(),
        timeoutMs: resolveSetting("routing.timeout_ms").value,
      })
      : await agenticRoute({
        brief, runtime, cwd: process.cwd(), projectId: projectId || null,
        maxBudgetUsd: effectiveBudgetUsd(),
        timeoutMs: resolveSetting("routing.timeout_ms").value,
        runtimeRules,
      });
    routedDone = d.ok && "done" in d ? d.done : [];
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
  // BM25 match — but only for a runtime a USE_* rule names and no matching
  // NOT_USE_* vetoes. Without that rule the router's preference is a guess.
  const routed = decision.runtime && decision.runtime !== runtimeDecision.runtime && !explicitRuntime && runtimeDecision.source !== "brief"
    ? routerRuntimeAllowed(decision.runtime, brief, runtimeRules) : null;
  if (routed?.allowed && decision.runtime && runtimeAvailable(decision.runtime)) {
    runtimeDecision = { runtime: decision.runtime, source: "rule", rule: routed.rule, method: "agentic" };
    console.log(c("lime", "  →") + c("bold", ` runtime from the user rule: ${decision.runtime}`) + c("dim", ` (agentic, ${routed.rule.envKey})`));
    emit("routing_rule_applied", {
      project_id: projectId || null,
      rule_env_key: routed.rule.envKey, rule_text: routed.rule.rule,
      runtime: decision.runtime, method: "agentic", score: null,
    });
  } else if (routed) {
    const why = routed.allowed ? `${decision.runtime} is not installed` : routed.reason;
    console.log(c("dim", `  router suggested ${decision.runtime}; staying on ${runtimeDecision.runtime} (${why})`));
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

  // Whatever runs next (business, squad or agent-x) and the judge after it
  // read `brief`, so the router's done states ride in it.
  if (routedDone.length) {
    brief = withDoneWhen(brief, routedDone);
    console.log(c("dim", `  done when: ${routedDone.length} state(s) added to the brief`));
  }

  const step = plan.steps[0];
  if (step.kind === "business") {
    slug = step.slug!;
    autoMandatorySquads = plan.mandatorySquads;
    autoOptionalSquads = plan.optionalSquads;
    const cost = decision.cost_usd != null ? ` · $${decision.cost_usd.toFixed(4)}` : "";
    console.log(c("lime", "  →") + c("bold", ` ${slug}`) + c("dim", ` (${plan.source}${decision.ok ? ` · ${decision.duration_ms}ms${cost}` : ""})`));
    if (autoMandatorySquads.length) console.log(c("dim", `  mandatory squads: ${autoMandatorySquads.join(", ")}`));
    if (plan.optionalSquads.length) console.log(c("dim", `  optional squads: ${plan.optionalSquads.join(", ")}`));
    if (plan.rationale) console.log(c("dim", `  rationale: ${plan.rationale}`));
    emit("auto_route_selected", { project_id: projectId || null, business_slug: slug, method: routingMode, source: plan.source, mandatory_squads: autoMandatorySquads, optional_squads: plan.optionalSquads });
  } else if (step.kind === "squad") {
    const squads = plan.steps.filter(s => s.kind === "squad").map(s => s.slug!) as string[];
    console.log(c("lime", "  →") + c("bold", ` squad-only route: ${squads.join(", ")}`) + c("dim", ` (${plan.source})`));
    if (plan.rationale) console.log(c("dim", `  rationale: ${plan.rationale}`));
    emit("auto_route_selected", { project_id: projectId || null, business_slug: null, method: routingMode, source: plan.source, squad_only: true, mandatory_squads: squads, optional_squads: plan.optionalSquads });
    pendingCascade = { kind: "squad-only", squads, plan };
  } else {
    console.log(c("yellow", "  →") + c("bold", " agent-x route (generalist)") + c("dim", ` (${plan.source}: ${step.reason})`));
    emit("auto_route_selected", { project_id: projectId || null, business_slug: null, method: routingMode, source: plan.source, agent_x: true, reason: step.reason });
    pendingCascade = { kind: "agent-x", reason: step.reason, plan };
  }
} else if (explicitTarget?.kind === "judge-x") {
  // --judge-x: the evaluator adapter's child. No plan, no cascade: the judge route below.
  console.log(c("lime", "▶") + c("bold", " Explicit target — judge-x") + c("dim", " (Gauntlet judge, no router)"));
  pendingCascade = { kind: "judge-x" };
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
// agent surfaces them under an "Assumptions" heading in the output (correct later
// via `nrv revise`).
if (wantAutoBrief) {
  if (autoBriefMode === "proxy" || autoBriefMode === "llm") {
    // LLM "informed client" — interviews + answers on the human's behalf.
    // The runtime already decided for this run (session > brief > rule > default),
    // not a literal: enriching the brief on a vendor the user is not signed into
    // is the same defect as dispatching on one.
    const pr = proxyEnrichBrief(brief, slug, runtimeDecision.runtime, {
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
const gateScriptPath = path.join(SKILLS, "harness/scripts/quality-gate.ts");
const verifyScriptPath = path.join(SKILLS, "businesses/scripts/verify-deliverable.ts");

// The prep scripts (brief-squad / brief-business) open an agentic ledger row for an agent that
// orchestrates in-session. This dispatch tracks its own run (the scripted row in standard mode,
// the canonical Run's row in a Gauntlet canary), so it tells them not to: the agentic row had no
// owner here, survived every scripted dispatch as `running` and was escalated to a human as
// stalled once its 30-minute lease expired (smoke-judge-squad, 2026-08-26).
// They also get the effective settings as the variables they read (settings.ts
// settingsEnvForChild: routing.mode, execution.dna_injection, ...), so the project's
// and the user's config hold in the prep scripts and in the employee prompt alike.
const prepScriptEnv = { ...process.env, ...settingsEnvForChild(), NIRVANA_DISPATCH_TRACKS_RUN: "1" };
// The scaffolders (brief-squad, brief-business) place the run where scope.ts
// outputsDir says; a nested dispatch tells them the parent run's folder.
if (NESTED_OUTPUTS_BASE) (prepScriptEnv as Record<string, string>).NIRVANA_OUTPUTS_DIR = NESTED_OUTPUTS_BASE;

// Frozen runtime, provider and model decision of one canary Run: the broker answers
// from the provider catalogs on disk (lib/runtime-snapshot.ts); without a descriptor
// the snapshot is the previous literal and nothing changes. Broker errors are
// explained here and end the Run before the producer inside runAgentXGauntlet
// (RT-002): no silent switch, no legacy fallback.
function frozenExecutionSnapshot(pid: string, rt: Runtime, targetKind: "business" | "squad" | "agent-x") {
  const snapshot = freezeExecutionSnapshot({ runtimeId: rt, runtimeSource: runtimeDecision.source, projectRoot: PROJECT_ROOT });
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
      const gate = files.length
        ? runGateOnce(files, { gateScript: gateScriptPath, offline: true,
            // Same reason as the delivery pipeline's gateEnv: the gate child must not
            // re-derive the project from the candidate it is judging.
            env: { HARNESS_LOGS_DIR: harnessLogsDir({ cwd: PROJECT_ROOT }), ...env } })
        : { pass: false, fails: [] };
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

// ── The judge's contract ────────────────────────────────────────────────────
//
// `compileGauntletPlan` runs TWICE per Gauntlet — here, to size the evaluator's
// budget, and inside `runAgentXGauntlet` — and the scorecard is validated against
// the plan the second one built. The two must therefore receive the SAME array,
// or `validateScorecardFile` rejects every dimension as "not in the success
// contract". `gauntletRequirements()` is computed once per canary and handed to
// both; the tests pin the resulting `planId` on both sides.
//
// `gauntlet.requirements_source` gates where the array comes from:
//   brief       (default) exactly the single `brief-conformance` the compiler
//               builds on its own — the same array, so the same plan id.
//   capability  `brief-conformance` + the target's declared acceptance contract
//               (lib/gauntlet/success-requirements.ts), with the workflow's
//               `success_indicators` and the invoked task's `## Acceptance
//               Criteria` as the fallbacks below it.
const requirementsSourceSetting = resolveSetting("gauntlet.requirements_source");

/** The capability record the registry kept for `<slug>:<capabilityId>`, and the squad's directory. */
function squadCapabilityRecord(slug: string, capabilityId: string): { squadDir: string | null; capability: (CapabilityContract & { produces?: string[] }) | null } {
  try {
    const registry = require("../lib/registry-loader.js").loadSquads().registry;
    const manifestPath = registry?.squads?.[slug]?.manifest_path;
    const squadDir = typeof manifestPath === "string" && manifestPath ? path.dirname(manifestPath) : null;
    const providers = registry?.capabilities?.[capabilityId];
    const capability = (Array.isArray(providers) ? providers : []).find((entry: any) => entry?.squad === slug) ?? null;
    return { squadDir, capability: capability ? { id: capabilityId, ...capability } : null };
  } catch { return { squadDir: null, capability: null }; }
}

/** The judge's contract for one dispatch, audited so the scorecard's dimensions can be traced to what declared them. */
function gauntletRequirements(projectId: string, producer: TargetRef,
  contract: { squadDir?: string | null; capability?: CapabilityContract | null; requirements?: SuccessRequirement[] } = {}): SuccessRequirement[] {
  const intensity = executionOptions.intensity;
  if (requirementsSourceSetting.value !== "capability") return [briefConformance(intensity)];
  // A business declares its contract per role (businesses/lib/acceptance.ts), so its
  // requirements arrive already built; a squad's come from the resolved capability.
  const resolved = contract.requirements?.length
    ? { requirements: [briefConformance(intensity), ...contract.requirements].slice(0, REQUIREMENTS_MAX), origin: "acceptance" as const,
        truncated: Math.max(0, contract.requirements.length + 1 - REQUIREMENTS_MAX) }
    : requirementsFor({ squadDir: contract.squadDir, capability: contract.capability, intensity });
  emit("x_gauntlet_requirements_resolved", { trace_id: projectId, project_id: projectId, producer: describeTarget(producer),
    origin: resolved.origin, requirements: resolved.requirements.map(item => item.id), truncated: resolved.truncated,
    source: describeSettingSource(requirementsSourceSetting) });
  return resolved.requirements;
}

/** The business's directory and `produces[]`, from the registry `nrv index` maintains. */
function businessRecord(slug: string): { bizDir: string | null; produces: string[] } {
  try {
    const registry = require("../lib/registry-loader.js").loadBusinesses().registry;
    const entry = registry?.businesses?.[slug];
    const manifestPath = entry?.manifest_path;
    return {
      bizDir: typeof manifestPath === "string" && manifestPath ? path.dirname(manifestPath) : null,
      produces: Array.isArray(entry?.produces) ? entry.produces : [],
    };
  } catch { return { bizDir: null, produces: [] }; }
}

/** `produces[]` the judge's rubric selector receives, behind `delivery.produces_to_rubric`
 *  (lib/delivery-pipeline.ts owns the rule; here we only read the target's declaration). */
function producesForDelivery(read: () => string[]): string[] | undefined {
  const enabled = resolveSetting("delivery.produces_to_rubric").value === true;
  let declared: string[] = [];
  try { declared = read(); } catch { declared = []; }
  const slugs = producesForRubric(declared, enabled);
  return slugs.length ? slugs : undefined;
}

// Gauntlet evaluator and round budget shared by the three canaries. The target comes from
// lib/gauntlet/evaluator-selection.ts (NIRVANA_GAUNTLET_EVALUATOR, else an installed squad
// declaring quality.specification_conformance, else judge-x for any producer); every fallback
// and the final choice are audited. The judgement is agentic by policy: the offline heuristic
// runs only by explicit opt-in (NIRVANA_GAUNTLET_EVALUATOR=heuristic, audited as
// x_gauntlet_evaluator_heuristic_opt_in). A variable that cannot be honoured ends the dispatch
// with exit 4 before any producer runs. With no agentic evaluator available (no judge-x persona
// for the runtime, CLI off the PATH) the Gauntlet does not start: x_gauntlet_evaluator_unavailable,
// the Run rolled back as `evaluator_unavailable` and exit 4. A real evaluator runs through
// lib/gauntlet/evaluator-adapter.ts with the evaluation budget (share or floor) as its cap; a
// slice the floor consumes entirely rolls the Run back as `max_cost` before the producer.
function gauntletEvaluatorFor(args: { pid: string; producer: TargetRef; plan: GauntletPlan; projectRoot: string; workspaceRoot: string; rt: Runtime;
  kernelPath: string; runId: string; heuristicEnv: Record<string, string> }): { evaluator: AgentXGauntletEvaluator; budget: GauntletRoundBudget } {
  const judge = judgeXAvailability(args.rt);
  // The gauntlet.evaluator setting: the variable, else the project or global config.
  const gauntletEvaluatorSetting = resolveSetting("gauntlet.evaluator");
  let selection: ReturnType<typeof selectGauntletEvaluator>;
  try {
    selection = selectGauntletEvaluator({ envValue: gauntletEvaluatorSetting.value || undefined, producer: args.producer, installed: loadInstalledSquads(), judge });
  } catch (error) {
    console.error(c("red", `✗ Gauntlet evaluator: ${(error as Error).message}`));
    process.exit(4);
  }
  for (const fallback of selection.fallbacks) {
    emit("x_gauntlet_evaluator_fallback", { trace_id: args.pid, project_id: args.pid, from: fallback.from, reason: fallback.reason,
      ...(fallback.detail ? { detail: fallback.detail } : {}), producer: describeTarget(args.producer) });
  }
  // The legacy adapter closes the Run's run-ledger row as `failed` with the reason, the way the
  // canaries close it on every other exit; without it the ledger never heard of the attempt.
  const rollback = (reason: "evaluator_unavailable" | "max_cost", errors: string[]): void => {
    const kernel = openKernel(args.kernelPath);
    const ledger = runLedger.openLedger();
    try {
      rollbackGauntletBeforeProducer({ kernel, legacy: createHarnessLegacyAdapter({ ledger, auditCwd: args.projectRoot }),
        projectId: args.pid, runId: args.runId, traceId: args.pid, producer: args.producer, plan: args.plan, reason, errors });
    } finally { kernel.close(); ledger.close(); }
  };
  if (selection.kind === "unavailable") {
    emit("x_gauntlet_evaluator_unavailable", { trace_id: args.pid, project_id: args.pid, producer: describeTarget(args.producer), runtime: args.rt,
      reason: selection.reason, run_id: args.runId });
    console.error(c("red", `✗ Gauntlet evaluator: no agentic evaluator is available (${selection.reason}); the Gauntlet does not start.`));
    console.error(c("dim", `  Install a squad declaring ${CONFORMANCE_CAPABILITY} and run nrv index, use a runtime with a judge-x persona,`));
    console.error(c("dim", `  or opt into the offline heuristic explicitly with ${GAUNTLET_EVALUATOR_ENV}=heuristic.`));
    rollback("evaluator_unavailable", [selection.reason]);
    process.exit(4);
  }
  const evaluatorLabel = selection.kind === "heuristic" ? "heuristic" : describeTarget(selection.target);
  emit("x_gauntlet_evaluator_selected", { trace_id: args.pid, project_id: args.pid, evaluator: evaluatorLabel, source: selection.source,
    target: selection.kind === "heuristic" ? null : selection.target, producer: describeTarget(args.producer),
    evaluation_share: selection.kind === "heuristic" ? 0 : GAUNTLET_EVALUATION_SHARE,
    evaluation_floor_usd: selection.kind === "heuristic" ? 0 : GAUNTLET_EVALUATION_FLOOR_USD });
  console.log(c("dim", `  Gauntlet evaluator: ${evaluatorLabel} (${selection.source})`));
  if (selection.kind === "heuristic") {
    emit("x_gauntlet_evaluator_heuristic_opt_in", { trace_id: args.pid, project_id: args.pid, producer: describeTarget(args.producer),
      env_value: gauntletEvaluatorSetting.value || null, source: describeSettingSource(gauntletEvaluatorSetting) });
    console.log(c("yellow", `  ⚠ offline heuristic by explicit opt-in (gauntlet.evaluator=heuristic via ${describeSettingSource(gauntletEvaluatorSetting)}): the round is scored by the quality gate, not judged`));
    return { evaluator: heuristicGauntletEvaluator(args.heuristicEnv), budget: gauntletRoundBudget(args.plan, effectiveBudgetUsd()) };
  }
  const budget = gauntletRoundBudget(args.plan, effectiveBudgetUsd(), GAUNTLET_EVALUATION_SHARE);
  if (budget.insufficient) {
    const account = `plan ceiling USD ${args.plan.budget.maxCostUsd} / (${args.plan.candidateStrategy.count} candidate(s) × ${args.plan.stop.maxRounds} round(s))`
      + `${effectiveBudgetUsd() !== undefined ? `, --max-budget USD ${effectiveBudgetUsd()}` : ""} = USD ${budget.candidateBudgetUsd + budget.evaluationBudgetUsd} per candidate; `
      + `the evaluation takes USD ${budget.evaluationBudgetUsd} (${GAUNTLET_EVALUATION_SHARE * 100}% or the USD ${GAUNTLET_EVALUATION_FLOOR_USD} floor) and leaves the producer nothing`;
    emit("x_gauntlet_budget_insufficient", { trace_id: args.pid, project_id: args.pid, producer: describeTarget(args.producer), evaluator: evaluatorLabel,
      plan_max_cost_usd: args.plan.budget.maxCostUsd, max_budget_usd: effectiveBudgetUsd() ?? null, candidate_budget_usd: budget.candidateBudgetUsd,
      evaluation_budget_usd: budget.evaluationBudgetUsd, evaluation_floor_usd: GAUNTLET_EVALUATION_FLOOR_USD, run_id: args.runId });
    console.error(c("red", `✗ Gauntlet budget: ${account}. The Gauntlet does not start (max_cost before the producer).`));
    rollback("max_cost", [account]);
    process.exit(1);
  }
  const evaluator = createDispatchEvaluator({ target: selection.target, producer: args.producer, plan: args.plan, brief: brief!,
    projectRoot: args.projectRoot, workspaceRoot: args.workspaceRoot, projectId: args.pid, runtime: args.rt, budgetUsd: budget.evaluationBudgetUsd,
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
  /** `produces[]` of the dispatched target, for the judge's rubric selector; see producesForRubric. */
  produces?: string[];
  /** The business's roles promise files through `acceptance[]` — a completeness proof like a manifest. */
  acceptancePromisesPaths?: boolean;
  afterGate?: Parameters<typeof runDelivery>[0]["afterGate"];
  onSession?: (sid: string) => void;
  /** Blocking criteria the solo review left unconfirmed: serious for the gate. */
  reviewBlockingMissed?: string[];
}

function deliveryArgs(opts: DeliverOpts): DeliveryArgs {
  return {
    brief: brief!,
    outputsRoot: opts.oroot,
    manifest: opts.withManifest ? (manifest ?? null) : null,
    pid: opts.pid,
    slug: opts.slugOrNull,
    targetKind: opts.targetKind,
    produces: opts.produces,
    acceptancePromisesPaths: opts.acceptancePromisesPaths,
    runtime: opts.rt,
    projectDir: opts.projDir,
    projectRoot: opts.projectRoot,
    workingDir: PROJECT_ROOT,
    sessionId: opts.sessionId,
    maxRevisions,
    maxBudgetUsd: effectiveBudgetUsd(),
    timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
    yolo,
    // A revision continues the producing run, so it carries that run's stamp:
    // `squad` (squad-exec), `agent-x` (runAgentX) or `solo`, the one agent that
    // is the whole business (business-solo.ts).
    producerRole: opts.targetKind === "business" ? "solo" as const : opts.targetKind,
    rulesDirective,
    forceDeliver,
    config: harnessConfig,
    ledger: ledgerRunId ? { handle: ledgerHandle!, runId: ledgerRunId } : null,
    audit: emit,
    afterGate: opts.afterGate,
    onSession: opts.onSession,
    reviewBlockingMissed: opts.reviewBlockingMissed,
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
 * with nothing on disk the caller's failure path stands. The completeness
 * ceiling binds: the gate judges the quality of the files that exist, never
 * whether a crashed run wrote all of them, so without a verified manifest the
 * best outcome is withheld, not a full pass. */
function deliverAfterError(opts: DeliverOpts, runtimeError: string, errorContext: Record<string, any>): RuntimeErrorOutcome {
  return deliverAfterRuntimeError({ ...deliveryArgs(opts), runtimeError, errorContext,
    completenessCeiling: { reason: `the runtime errored before the run finished (${runtimeError.slice(0, 200)})` } });
}

type DeliveryState = "delivered" | "delivered_with_reservations" | "withheld" | "indeterminate" | "failed";

/** What the delivery pipeline decided, in its own words: `state` from the
 *  result (and `_STATUS.json`, which carries the reasons), derived from the exit
 *  code and the gate when an older pipeline did not say. */
function deliveryStatus(res: DeliveryResult, oroot: string): { state: DeliveryState; serious: string[]; reservations: string | null } {
  let status: { state?: DeliveryState; serious?: unknown; reservations?: unknown } = {};
  try { status = JSON.parse(fs.readFileSync(path.join(oroot, "_STATUS.json"), "utf8")); } catch { status = {}; }
  const reservationsFile = path.join(oroot, "_QA-RESERVATIONS.md");
  const state: DeliveryState = (res as DeliveryResult & { state?: DeliveryState }).state ?? status.state
    ?? (res.exitCode === 0 ? (res.gateOutcome === "fail-accepted" ? "delivered_with_reservations" : "delivered")
      : res.exitCode === 2 ? "withheld" : res.exitCode === 3 ? "indeterminate" : "failed");
  return {
    state,
    serious: Array.isArray(status.serious) ? status.serious.map(String) : [],
    reservations: typeof status.reservations === "string" ? status.reservations : fs.existsSync(reservationsFile) ? reservationsFile : null,
  };
}

function printDeliverySummary(res: DeliveryResult, pid: string, oroot: string, zipPath: string | null, runtimeErrored = false): void {
  console.log("");
  if (runtimeErrored) {
    console.log(c("yellow", "⚠ The runtime reported an error at the end of the run — the artifacts that already existed were verified and judged anyway."));
  }
  const status = deliveryStatus(res, oroot);
  if (status.state === "delivered") {
    console.log(c("green", "✓ Autopilot complete: delivered."));
  } else if (status.state === "delivered_with_reservations") {
    console.log(c("yellow", `⚠ Delivered with reservations: ${status.reservations ?? "see _SUMMARY.md"}`));
  } else if (status.state === "withheld") {
    console.log(c("yellow", `⚠ Withheld (exit ${res.exitCode}): ${status.serious.length ? status.serious.join("; ") : res.ceilingApplied ?? "the quality gate failed after the revisions"}.`));
    console.log(c("dim", "  The artifacts stay on disk; nothing was marked as delivered."));
  } else if (status.state === "indeterminate") {
    console.log(c("yellow", `⚠ Indeterminate (exit ${res.exitCode}): nothing gateable was produced, so nothing was judged.`));
  } else {
    console.log(c("red", `✗ Delivery failed (exit ${res.exitCode}).`));
  }
  console.log(c("dim", `  Project ID:   ${pid}`));
  console.log(c("dim", `  Deliverables: ${oroot}`));
  console.log(c("dim", `  Status:       ${path.join(oroot, "_STATUS.json")}`));
  if (zipPath) console.log(c("dim", `  Zip:          ${zipPath}`));
  console.log("");
  console.log(c("cyan", "  Ask for changes (keeps the session):"));
  console.log("    " + c("yellow", `nrv revise ${pid} "<change>"`));
  if (status.state === "withheld" && !res.ceilingApplied) {
    console.log(c("cyan", "  Deliver anyway (eyes open):"));
    console.log("    " + c("yellow", "re-run with --force-deliver"));
  }
  console.log(c("cyan", "  Clear the whole scaffold:"));
  console.log("    " + c("yellow", `nrv clean ${pid}`));
  console.log("");
}

/** The run's project id. An explicit --project is reused on purpose (a Glance
 *  chat, a multi-target node). A generated one is CLAIMED by creating its
 *  folder: two dispatches of the same target started in the same second used
 *  to share one folder, and now the second takes the next free suffix. */
function claimProjectId(base: string, root: string = OUTPUTS_BASE): string {
  fs.mkdirSync(root, { recursive: true });
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    try { fs.mkdirSync(path.join(root, id)); return id; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}
/** Where the prep scripts (brief-business, brief-squad) place a run: scope.ts
 *  outputsDir, which also honours NIRVANA_OUTPUTS_DIR. Their id is claimed there. */
const prepOutputsBase = (): string => NESTED_OUTPUTS_BASE ?? outputsDir(resolveScope());
/** Removes a claimed run folder a failed prep step left empty (rmdir refuses a non-empty one). */
function releaseProjectId(pid: string, root: string): void {
  if (projectId) return;
  try { fs.rmdirSync(path.join(root, pid)); } catch { /* not empty, or already gone */ }
}

/** Flags that only a business run reads, named when they reach a squad or the generalist. */
function warnBusinessOnlyFlags(target: string): void {
  const given = ["--html", "--pdf", "--zip", "--review", "--no-review", "--manifest"].filter((f) => cliArgs.some((a) => a === f || a.startsWith(`${f}=`)));
  if (given.length) console.error(c("yellow", `⚠ ${given.join(" ")} only apply to a business run; ignored for ${target}.`));
}

/** The next step a --scaffold-only run prints: the same command, run. */
function printScaffoldNextStep(pid: string, prepared: string): void {
  console.log("");
  console.log(c("cyan", `  Nothing ran. ${prepared} To run it, repeat the command with --exec:`));
  console.log("    " + c("yellow", rerunWithExec(cliArgs)));
  console.log("");
  console.log(c("green", "✓ Scaffold ready. Project ID: " + pid));
  console.log(c("dim", "  (exit 3: nothing dispatched, nothing judged; delivery only with --exec)"));
}

// ── SQUAD-ONLY ROUTE — dispatch the squad(s) for real (Phase 4.1) ─────────
// Pre-Phase-4 this printed shell instructions and exited 0 WITHOUT
// dispatching. Now: scaffold via brief-squad.ts (validates the manifest, and
// emits brief_received + dispatch_squad ITSELF — grep this file for
// `dispatch_squad` and you find only this comment, which is why it says whose
// event it is), then — in exec mode — run each squad through squad-exec, which
// emits the richer dispatch_squad (capability_id, mode, outputs_dir), and the
// shared delivery pipeline.
if (pendingCascade?.kind === "squad-only") {
  const squads = pendingCascade.squads;
  const rt = runtimeDecision.runtime;
  warnBusinessOnlyFlags(`squad ${squads.join(", ")}`);
  const pid = projectId || claimProjectId(runFolderId(squads[0]), prepOutputsBase());
  const briefSquadScript = path.join(SKILLS, "squads", "scripts", "brief-squad.ts");

  console.log(c("lime", "▶") + c("bold", ` Squad-only — scaffold (${squads.length} squad(s))`));
  let projDir: string | null = null;
  for (const sq of squads) {
    const r = spawnSync("bun", [briefSquadScript, sq, brief, "--project", pid], { windowsHide: true, encoding: "utf8", env: prepScriptEnv });
    if (r.status !== 0) {
      console.error(c("red", `✗ brief-squad failed for '${sq}':`));
      console.error(r.stdout || r.stderr);
      if (!projDir) releaseProjectId(pid, prepOutputsBase());
      process.exit(r.status === 4 ? 4 : 1);
    }
    const dir = r.stdout.match(/^\s*Project dir:\s+(.+?)\s*$/m)?.[1];
    if (!projDir && dir) projDir = dir;
    console.log(c("dim", `  ✓ ${sq} scaffolded`));
  }
  if (!projDir) {
    console.error(c("red", "✗ could not parse the Project dir from brief-squad"));
    process.exit(1);
  }
  // brief-squad scaffolds at <outputs>/<pid>/squads/<slug>; its two parents are the
  // run's WORKSPACE (brief.md, the dispatch kernel, the Gauntlet scratch), never the
  // project — deriving one from the other is the defect this cut closed.
  const scaffoldRoot = path.resolve(projDir, "..", "..");
  const projectRoot = PROJECT_ROOT;
  dispatchAudit.bindProjectRoot(projectRoot);

  if (scaffoldOnly) {
    printScaffoldNextStep(pid, `The brief is at ${path.join(scaffoldRoot, "brief.md")}.`);
    process.exit(3);
  }

  const oroot = outputsRoot || path.join(scaffoldRoot, "deliverables");
  setRunBudgetRoot(oroot);
  fs.mkdirSync(oroot, { recursive: true });
  // The capability each squad of the route actually runs (lib/capability-resolver.ts):
  // the id the user named, the squad's only capability, the best one for this brief
  // inside the squad, or `squad.execute` for a v4 squad that declares none. Before
  // this the literal `squad.execute` was stamped on the Run, on every artifact ref
  // and on the prompt-less squad — provenance for an entry point nothing declared.
  const capabilityFor = (sq: string) => resolveSquadCapability({
    slug: sq, brief,
    explicit: pendingCascade.plan.steps.find(step => step.kind === "squad" && step.slug === sq)?.capability ?? null,
    audit: emit, auditContext: { trace_id: pid, project_id: pid },
  }).capabilityId;
  const capabilityById = new Map(squads.map(sq => [sq, capabilityFor(sq)]));
  const capabilityId = capabilityById.get(squads[0])!;
  // The capability the resolver chose is what declares the acceptance contract the judge
  // reads and the `produces` slugs its rubric selector matches on.
  const squadContract = squadCapabilityRecord(squads[0], capabilityId);
  const squadProduces = producesForDelivery(() => squadContract.capability?.produces ?? []);
  if (shouldRunSquadGauntlet({ squadCount: squads.length, wantExec, resolvedMode: executionOptions.resolvedMode })) {
    const squad = squads[0];
    const producerTarget = { kind: "squad" as const, slug: squad, capabilityId };
    const canonicalRunId = canonicalRunIdFor(pid, runIdFlag);
    const requirements = gauntletRequirements(pid, producerTarget, squadContract);
    const { evaluator, budget } = gauntletEvaluatorFor({ pid, producer: producerTarget,
      plan: compileGauntletPlan({ brief, intensity: executionOptions.intensity, requirements }),
      projectRoot, workspaceRoot: scaffoldRoot, rt, kernelPath: KERNEL_PATH, runId: canonicalRunId,
      heuristicEnv: { NIRVANA_TRACE_ID: pid, NIRVANA_PROJECT_ID: pid } });
    const kernel = openKernel(KERNEL_PATH);
    const legacy = runLedger.openLedger();
    let finalDelivery: DeliveryResult | null = null;
    // The runtime each candidate session finished on: the final session.json names it.
    const sessionRuntimes = new Map<string, Runtime>();
    // One producer for the first candidate and for every revision: same squad, same runtime.
    const produce = (candidateRoot: string, candidateBrief: string) => {
      supersedePriorRuns(canonicalRunId);
      const candidate = runSquadHeadless({ squadSlug: squad, brief: candidateBrief, projectId: pid, projectDir: projDir, projectRoot,
        outputsDir: candidateRoot, runtime: rt, capabilityId,
        maxBudgetUsd: budget.candidateBudgetUsd, timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
        rulesDirective, autonomousDirective: AUTONOMOUS_DIRECTIVE, runWithCascadeImpl: pinnedCascade,
        ledger: { runId: canonicalRunId, watchDir: candidateRoot } });
      if (candidate.sessionId) runLedger.recordSession(legacy, canonicalRunId, candidate.sessionId);
      if (candidate.sessionId) sessionRuntimes.set(candidate.sessionId, candidate.finalRuntime);
      return { ok: candidate.ok, sessionId: candidate.sessionId, costUsd: candidate.costUsd, error: candidate.error };
    };
    const executionSnapshot = frozenExecutionSnapshot(pid, rt, "squad");
    try {
      const result = runAgentXGauntlet({
        kernel, legacy: createHarnessLegacyAdapter({ ledger: legacy, auditCwd: projectRoot }), producerTarget,
        projectId: pid, runId: canonicalRunId, traceId: pid, brief, projectRoot, workspaceRoot: scaffoldRoot, outputsRoot: oroot,
        intensity: executionOptions.intensity, requirements, executionSnapshot, audit: emit,
        expectedCostUsd: budget.roundBudgetUsd,
        executeCandidate: candidateRoot => produce(candidateRoot, brief),
        reviseCandidate: request => produce(request.candidateRoot, writeRevisionBrief(brief, request).text),
        evaluator,
        finalGate({ sessionId }) {
          writeWorkerSession({ projectId: pid, kind: "squad", slug: squad, runtime: (sessionId && sessionRuntimes.get(sessionId)) || rt,
            sessionId, projectDir: projDir, projectRoot, outputsRoot: oroot, workspace: runFolderOf(projDir, projectRoot) });
          finalDelivery = runDelivery({ ...deliveryArgs({ pid, slugOrNull: null, targetKind: "squad", rt, oroot,
            projDir, projectRoot, sessionId, withManifest: false, produces: squadProduces }), ledger: null, maxRevisions: 0 });
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
  // lib/run-kernel/standard-publication.ts, fail-open); a route of several squads publishes under its first squad.
  const publication = openStandardPublication({ kernelPath: KERNEL_PATH, projectId: pid, runId: canonicalRunIdFor(pid, runIdFlag),
    traceId: pid, target: { kind: "squad", slug: squads[0], capabilityId }, snapshot: frozenExecutionSnapshot(pid, rt, "squad"),
    audit: emit, warn: line => console.error(c("yellow", line)) });
  if (publication.incompatible || publication.collided) process.exit(1);
  ledgerTry(() => {
    ledgerHandle = runLedger.openLedger();
    const row = runLedger.openRun(ledgerHandle, {
      traceId: pid, projectId: pid, targetSlug: squads.join(","), targetKind: "squad",
      runtime: rt,
      meta: { ...dispatcherMeta(), project_dir: projDir, project_root: projectRoot, scaffold_root: scaffoldRoot,
        brief_path: path.join(scaffoldRoot, "brief.md"), outputs_root: oroot, mode: "squad-only",
        runtime_source: runtimeDecision.source, dispatch_role: "squad" },
    });
    ledgerRunId = row.run_id;
  });
  // No childPid here: the heartbeat sidecar (spawned inside runHeadless, once
  // the runner below actually calls spawnSync) discovers the real CLI child
  // and records it — see run-ledger.ts recordChildPid. Writing process.pid
  // (this dispatcher, about to block inside spawnSync) here is exactly the
  // bug this cut fixes: the supervisor would SIGTERM the orchestrator itself.
  if (ledgerRunId) ledgerTry(() => runLedger.markState(ledgerHandle!, ledgerRunId!, "running"));
  supersedePriorRuns(ledgerRunId ?? publication.runId);

  console.log(c("lime", "▶") + c("bold", ` Squad-only — exec headless (${rt})`));
  publication.start();
  let lastSession: string | null = null;
  let squadError: string | null = null;
  let failedSquad: string | null = null;
  // session.json per squad that ran, beside its scaffold: `nrv revise` continues
  // that squad's own conversation, on the runtime that finished it.
  let lastSquadSession: ReturnType<typeof writeWorkerSession> | null = null;
  let lastRuntime: Runtime = rt;
  for (const sq of squads) {
    const outDir = squads.length > 1 ? path.join(oroot, sq) : oroot;
    const r = runSquadHeadless({
      squadSlug: sq, brief, projectId: pid, projectDir: projDir, projectRoot,
      outputsDir: outDir, runtime: rt,
      capabilityId: capabilityById.get(sq),
      maxBudgetUsd: effectiveBudgetUsd(),
      timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
      rulesDirective, autonomousDirective: AUTONOMOUS_DIRECTIVE, runWithCascadeImpl: pinnedCascade,
      ...(ledgerRunId ? { ledger: { runId: ledgerRunId, watchDir: outDir } } : {}),
    });
    lastSession = r.sessionId ?? lastSession;
    const written = writeWorkerSession({ projectId: pid, kind: "squad", slug: sq, runtime: r.finalRuntime, sessionId: r.sessionId,
      projectDir: path.join(scaffoldRoot, "squads", sq), projectRoot, outputsRoot: outDir,
      workspace: runFolderOf(projDir, projectRoot) });
    // The delivery's corrections resume the last session, on its own runtime.
    if (r.sessionId) { lastRuntime = r.finalRuntime; lastSquadSession = written; }
    if (!r.ok) {
      // Stop the route, but do NOT abandon what is already on disk — the
      // delivery pipeline below decides (see deliverAfterRuntimeError).
      console.error(c("red", `✗ squad '${sq}' failed: ${r.error}`));
      emit("agent_exec_failed", { trace_id: pid, project_id: pid, squad_slug: sq, runtime: rt, error: r.error });
      squadError = `squad ${sq}: ${r.error}`;
      failedSquad = sq;
      break;
    }
    console.log(c("dim", `  · ${sq}: ${r.durationMs}ms${r.costUsd != null ? ` · ${r.costUsd.toFixed(4)}` : ""}`));
    chargeRunBudget(r.costUsd);
  }
  if (ledgerRunId && lastSession) ledgerTry(() => runLedger.recordSession(ledgerHandle!, ledgerRunId!, lastSession));

  const squadDeliverOpts = {
    pid, slugOrNull: null, targetKind: "squad" as const, rt: lastRuntime, oroot,
    projDir, projectRoot, sessionId: lastSession, withManifest: false, produces: squadProduces,
    onSession: (sid: string) => {
      if (!lastSquadSession) return;
      lastSquadSession.data.session_id = sid;
      fs.writeFileSync(lastSquadSession.file, JSON.stringify(lastSquadSession.data, null, 2));
    },
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

// ── JUDGE-X ROUTE — the engine's Gauntlet judge, the evaluator adapter's child ──
// No cascade, no nested Gauntlet, no delivery gate over content: the only artifact
// is scorecard.json, validated here against the evaluation request the adapter wrote
// beside the outputs root. The canonical Run ends `completed` only with a valid
// scorecard; otherwise `withheld`, and a spent cap is named `budget_exhausted`.
if (pendingCascade?.kind === "judge-x") {
  const rt = runtimeDecision.runtime;
  const pid = projectId || claimProjectId(runFolderId("judge-x"));
  const scaffoldRoot = path.join(OUTPUTS_BASE, pid);
  const projDir = path.join(scaffoldRoot, "judge-x");
  fs.mkdirSync(projDir, { recursive: true });
  dispatchAudit.bindProjectRoot(PROJECT_ROOT);
  emit("brief_received", { trace_id: pid, project_id: pid, target: "judge-x", brief_excerpt: briefExcerpt(brief), brief_chars: brief.length });

  if (scaffoldOnly) {
    console.log(c("cyan", "  judge-x runs only with --exec: nothing was judged."));
    console.log(c("green", "✓ Scaffold ready. Project ID: " + pid));
    console.log(c("dim", "  (exit 3 — nothing dispatched, nothing judged)"));
    process.exit(3);
  }
  const oroot = outputsRoot || path.join(scaffoldRoot, "deliverables");
  setRunBudgetRoot(oroot);
  fs.mkdirSync(oroot, { recursive: true });
  const requestFile = path.join(path.dirname(oroot), EVALUATION_REQUEST_FILE);
  let request: EvaluationRequest;
  try { request = JSON.parse(fs.readFileSync(requestFile, "utf8")) as EvaluationRequest; }
  catch (error) {
    console.error(c("red", `✗ judge-x needs ${EVALUATION_REQUEST_FILE} beside its outputs root (${requestFile}): ${(error as Error).message}`));
    console.error(c("dim", "  The Gauntlet evaluator adapter writes it; judge-x is not a producer and takes no free-form brief."));
    process.exit(4);
  }
  const judge = judgeXAvailability(rt);
  if (!judge.available) {
    console.error(c("red", `✗ judge-x: ${judge.reason}`));
    emit("agent_exec_failed", { trace_id: pid, project_id: pid, employee: "judge-x", runtime: rt, reason: judge.reason });
    process.exit(1);
  }
  const scorecardPath = path.join(oroot, SCORECARD_FILE);
  const publication = openStandardPublication({ kernelPath: KERNEL_PATH, projectId: pid, runId: canonicalRunIdFor(pid, runIdFlag),
    traceId: pid, target: JUDGE_X_TARGET, snapshot: frozenExecutionSnapshot(pid, rt, "agent-x"),
    audit: emit, warn: line => console.error(c("yellow", line)) });
  if (publication.incompatible) process.exit(1);

  console.log(c("lime", "▶") + c("bold", ` Judge-x — exec headless (${rt})`));
  supersedePriorRuns(publication.runId);
  publication.start();
  const maxBudgetUsd = effectiveBudgetUsd();
  const r = runJudgeX({ brief, runtime: rt, projectId: pid, projectDir: projDir, projectRoot: PROJECT_ROOT, outputsRoot: oroot, scorecardPath,
    candidateRoot: request.candidateRoot, maxBudgetUsd, timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined, yolo, audit: emit,
    runWithCascadeImpl: pinnedCascade });
  console.log(c("dim", `  session: ${r.sessionId || "(none)"} · ${r.durationMs}ms${r.costUsd != null ? ` · ${r.costUsd.toFixed(4)}` : ""} · prompt ${r.promptChars} chars`));
  chargeRunBudget(r.costUsd);
  publication.verify();
  const outcome = judgeXOutcome({ scorecardPath, requirements: request.requirements, run: r, maxBudgetUsd });
  if (outcome.exitCode === 0) {
    emit("verify_passed", { trace_id: pid, project_id: pid, business_slug: null, files: 1, scorecard: scorecardPath, verdict: outcome.scorecard.verdict });
    publication.finish({ exitCode: 0, gateOutcome: "pass" }, oroot);
    console.log(c("green", `✓ judge-x wrote a valid ${SCORECARD_FILE} (verdict ${outcome.scorecard.verdict}).`));
    process.exit(0);
  }
  if (!r.ok) emit("agent_exec_failed", { trace_id: pid, project_id: pid, employee: "judge-x", runtime: rt, exit_code: r.exitCode,
    error: r.error || r.stderr, ...(r.budgetExhausted ? { budget_exhausted: true, max_budget_usd: maxBudgetUsd ?? null } : {}) });
  emit("verify_failed", { trace_id: pid, project_id: pid, business_slug: null, reason: outcome.reason });
  publication.finish({ exitCode: 2, gateOutcome: "fail", error: outcome.reason }, oroot);
  console.error(c("yellow", `⚠ judge-x withheld: ${outcome.reason}`));
  process.exit(2);
}

// ── AGENT-X ROUTE — the cascade bottom delivers (Phase 4.1) ───────────────
// NO_MATCH (and unresolvable router failures) used to exit 1 — a contract
// inversion of SKILL.md's cascade step 3. Now the generalist runs with the
// gap named, and its output goes through the SAME delivery pipeline.
if (pendingCascade?.kind === "agent-x") {
  const rt = runtimeDecision.runtime;
  warnBusinessOnlyFlags("agent-x");
  const pid = projectId || claimProjectId(runFolderId("agent-x"));
  const scaffoldRoot = path.join(OUTPUTS_BASE, pid);
  const projDir = path.join(scaffoldRoot, "agent-x");
  fs.mkdirSync(projDir, { recursive: true });
  const briefPath = path.join(scaffoldRoot, "brief-enriched.md");
  fs.writeFileSync(briefPath, brief, "utf8");
  dispatchAudit.bindProjectRoot(PROJECT_ROOT);
  emit("brief_received", { trace_id: pid, project_id: pid, target: "agent-x", brief_excerpt: briefExcerpt(brief), brief_chars: brief.length });

  if (scaffoldOnly) {
    printScaffoldNextStep(pid, `The brief is at ${briefPath}.`);
    process.exit(3);
  }

  const oroot = outputsRoot || path.join(scaffoldRoot, "deliverables");
  setRunBudgetRoot(oroot);
  fs.mkdirSync(oroot, { recursive: true });
  if (shouldRunAgentXGauntlet({ targetKind: "agent-x", wantExec, resolvedMode: executionOptions.resolvedMode })) {
    const canonicalRunId = canonicalRunIdFor(pid, runIdFlag);
    // agent-x declares no capability, so its contract is `brief-conformance` under either
    // setting — the array still travels to both compile sites, which is what keeps them equal.
    const requirements = gauntletRequirements(pid, { kind: "agent-x", slug: "agent-x" });
    const { evaluator, budget } = gauntletEvaluatorFor({ pid, producer: { kind: "agent-x", slug: "agent-x" },
      plan: compileGauntletPlan({ brief, intensity: executionOptions.intensity, requirements }),
      projectRoot: PROJECT_ROOT, workspaceRoot: scaffoldRoot, rt,
      kernelPath: KERNEL_PATH, runId: canonicalRunId, heuristicEnv: { NIRVANA_TRACE_ID: pid, NIRVANA_PROJECT_ID: pid } });
    const kernel = openKernel(KERNEL_PATH);
    const legacy = runLedger.openLedger();
    let finalDelivery: DeliveryResult | null = null;
    // The runtime each candidate session finished on: the final session.json names it.
    const sessionRuntimes = new Map<string, Runtime>();
    // One producer for the first candidate and for every revision: same persona, same runtime.
    const produce = (candidateRoot: string, candidateBrief: string, candidateBriefPath: string) => {
      supersedePriorRuns(canonicalRunId);
      const candidate = runAgentX({ brief: candidateBrief, briefPath: candidateBriefPath, runtime: rt, projectId: pid, projectDir: projDir,
        projectRoot: PROJECT_ROOT, outputsRoot: candidateRoot, reason: pendingCascade.reason, appendSystemPrompt: AUTONOMOUS_DIRECTIVE + rulesDirective,
        maxBudgetUsd: budget.candidateBudgetUsd, timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
        yolo, ledger: { runId: canonicalRunId, watchDir: candidateRoot }, audit: emit, runWithCascadeImpl: pinnedCascade });
      if (candidate.sessionId) runLedger.recordSession(legacy, canonicalRunId, candidate.sessionId);
      if (candidate.sessionId) sessionRuntimes.set(candidate.sessionId, candidate.finalRuntime);
      if (!candidate.ok) emit("agent_exec_failed", { trace_id: pid, project_id: pid, employee: "agent-x", runtime: rt,
        exit_code: candidate.exitCode, error: candidate.error || candidate.stderr });
      return { ok: candidate.ok, sessionId: candidate.sessionId, costUsd: candidate.costUsd,
        error: candidate.error || candidate.stderr || undefined };
    };
    const executionSnapshot = frozenExecutionSnapshot(pid, rt, "agent-x");
    try {
      const result = runAgentXGauntlet({
        kernel, legacy: createHarnessLegacyAdapter({ ledger: legacy, auditCwd: PROJECT_ROOT }),
        projectId: pid, runId: canonicalRunId, traceId: pid, brief, projectRoot: PROJECT_ROOT, workspaceRoot: scaffoldRoot, outputsRoot: oroot,
        intensity: executionOptions.intensity, requirements, executionSnapshot, audit: emit,
        expectedCostUsd: budget.roundBudgetUsd,
        executeCandidate: candidateRoot => produce(candidateRoot, brief, briefPath),
        reviseCandidate(request) {
          const revision = writeRevisionBrief(brief, request);
          return produce(request.candidateRoot, revision.text, revision.file);
        },
        evaluator,
        finalGate({ sessionId }) {
          writeWorkerSession({ projectId: pid, kind: "agent-x", slug: "agent-x", runtime: (sessionId && sessionRuntimes.get(sessionId)) || rt,
            sessionId, projectDir: projDir, projectRoot: PROJECT_ROOT, outputsRoot: oroot, workspace: runFolderOf(projDir, PROJECT_ROOT) });
          finalDelivery = runDelivery({ ...deliveryArgs({ pid, slugOrNull: null, targetKind: "agent-x", rt, oroot,
            projDir, projectRoot: PROJECT_ROOT, sessionId, withManifest: false }), ledger: null, maxRevisions: 0 });
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
  const publication = openStandardPublication({ kernelPath: KERNEL_PATH, projectId: pid, runId: canonicalRunIdFor(pid, runIdFlag),
    traceId: pid, target: { kind: "agent-x", slug: "agent-x" }, snapshot: frozenExecutionSnapshot(pid, rt, "agent-x"),
    audit: emit, warn: line => console.error(c("yellow", line)) });
  if (publication.incompatible || publication.collided) process.exit(1);
  ledgerTry(() => {
    ledgerHandle = runLedger.openLedger();
    const row = runLedger.openRun(ledgerHandle, {
      traceId: pid, projectId: pid, targetSlug: "agent-x", targetKind: "agent-x",
      runtime: rt,
      meta: { ...dispatcherMeta(), project_dir: projDir, project_root: PROJECT_ROOT, scaffold_root: scaffoldRoot,
        brief_path: briefPath, outputs_root: oroot, mode: "agent-x",
        runtime_source: runtimeDecision.source, dispatch_role: "agent-x" },
    });
    ledgerRunId = row.run_id;
  });
  // No childPid here: the heartbeat sidecar (spawned inside runHeadless, once
  // the runner below actually calls spawnSync) discovers the real CLI child
  // and records it — see run-ledger.ts recordChildPid. Writing process.pid
  // (this dispatcher, about to block inside spawnSync) here is exactly the
  // bug this cut fixes: the supervisor would SIGTERM the orchestrator itself.
  if (ledgerRunId) ledgerTry(() => runLedger.markState(ledgerHandle!, ledgerRunId!, "running"));
  supersedePriorRuns(ledgerRunId ?? publication.runId);

  console.log(c("lime", "▶") + c("bold", ` Agent-x — exec headless (${rt})`));
  publication.start();
  const r = runAgentX({
    brief, briefPath, runtime: rt, projectId: pid,
    projectDir: projDir, projectRoot: PROJECT_ROOT, outputsRoot: oroot,
    reason: pendingCascade.reason,
    appendSystemPrompt: AUTONOMOUS_DIRECTIVE + rulesDirective,
    maxBudgetUsd: effectiveBudgetUsd(),
    timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
    yolo,
    ...(ledgerRunId ? { ledger: { runId: ledgerRunId, watchDir: oroot } } : {}),
    audit: emit, runWithCascadeImpl: pinnedCascade,
  });
  if (ledgerRunId) ledgerTry(() => runLedger.recordSession(ledgerHandle!, ledgerRunId!, r.sessionId));
  // session.json beside the run's plumbing: `nrv revise` continues this
  // conversation, on the runtime that finished it.
  const agentXSession = writeWorkerSession({ projectId: pid, kind: "agent-x", slug: "agent-x", runtime: r.finalRuntime,
    sessionId: r.sessionId, projectDir: projDir, projectRoot: PROJECT_ROOT, outputsRoot: oroot, workspace: runFolderOf(projDir, PROJECT_ROOT) });
  const agentXDeliverOpts = {
    pid, slugOrNull: null, targetKind: "agent-x" as const, rt: r.finalRuntime, oroot,
    projDir, projectRoot: PROJECT_ROOT, sessionId: r.sessionId, withManifest: false,
    onSession: (sid: string) => {
      agentXSession.data.session_id = sid;
      fs.writeFileSync(agentXSession.file, JSON.stringify(agentXSession.data, null, 2));
    },
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
  console.log(c("dim", `  session: ${r.sessionId || "(none)"} · ${r.durationMs}ms${r.costUsd != null ? ` · ${r.costUsd.toFixed(4)}` : ""}`));
  chargeRunBudget(r.costUsd);

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
const pid = projectId || claimProjectId(runFolderId(slug), prepOutputsBase());
const args = [briefBiz, slug, brief, "--project", pid];
if (manifest) args.push("--manifest", manifest);
const r1 = spawnSync("bun", args, { windowsHide: true, encoding: "utf8", env: prepScriptEnv });
if (r1.status !== 0) {
  console.error(c("red", "✗ brief-business failed:"));
  console.error(r1.stdout || r1.stderr);
  releaseProjectId(pid, prepOutputsBase());
  process.exit(r1.status === 4 ? 4 : 1);
}
console.log(r1.stdout);

// The run folder brief-business made. Read to the end of the line: a path with
// a space in it (a Windows user folder) is still one path.
const projDir = r1.stdout.match(/^\s*Project dir:\s+(.+?)\s*$/m)?.[1];
if (!projDir) {
  console.error(c("red", "✗ Could not parse brief-business output"));
  process.exit(1);
}

// The business's own contract: its roles' `acceptance[]` (Business Protocol 2.0 §11)
// becomes the judge's requirements, and the manifest's `produces[]` the rubric selector's
// input. Both are gated — `gauntlet.requirements_source` and `delivery.produces_to_rubric`.
// Every role counts: one agent plays them all (business-solo.ts), and verify-deliverable
// reads the same set.
const businessEntry = businessRecord(slug);
const businessAcceptance = businessEntry.bizDir
  ? readAcceptance(businessEntry.bizDir, null, { minimumScore: profileScore(executionOptions.intensity) })
  : { requirements: [], entries: [], paths: [] };
const businessProduces = producesForDelivery(() => businessEntry.produces);

// Step 2 — the run's folders, and the one prompt a scaffold-only run hands over
console.log(c("lime", "▶") + c("bold", ` Step 2/4 — prepare the run (${slug})`));
// brief-business writes brief.md at the WORKSPACE root (parent of businesses/<slug>/), not
// inside the business subdir. That root is the scaffold's, never the project's — see PROJECT_ROOT.
const scaffoldRoot = path.resolve(projDir, "..", "..");
const projectRoot = PROJECT_ROOT;
// The run's own folder: where the worker starts, fenced off from the runs
// beside it (run-workspace.ts).
const runWorkspace = runFolderOf(projDir, projectRoot) ?? undefined;
// In exec mode the agent writes deliverables here (a clean subfolder export
// includes but the scaffold dirs handoffs/tickets/employees are excluded).
const execOutputsRoot = outputsRoot || (wantExec ? path.join(projDir, "deliverables") : undefined);
if (execOutputsRoot && wantExec) fs.mkdirSync(execOutputsRoot, { recursive: true });
const businessCanaryDecision = decideBusinessCanary({ businessSlug: slug, wantExec,
  requestedMode: executionOptions.requestedMode, resolvedMode: executionOptions.resolvedMode,
  // The gauntlet.business_allowlist and gauntlet.business_kill_switch settings (variables, else config).
  intensity: executionOptions.intensity, allowlist: resolveSetting("gauntlet.business_allowlist").value,
  killSwitch: resolveSetting("gauntlet.business_kill_switch").value ? "1" : undefined });
const tmpBriefFile = path.join(scaffoldRoot, "brief.md");
if (!fs.existsSync(tmpBriefFile)) {
  console.error(c("red", `✗ brief.md not found at ${tmpBriefFile}`));
  process.exit(1);
}
// The brief FILE the worker reads (it reads the file, not the text handed to
// it). The --brief-file itself while the run's brief is that file unchanged, so
// a decision appended to it mid-run (`nrv brief decide`) reaches the worker.
// When something enriched it (--auto-brief, the router's done states) the final
// text is written into the run folder and the worker reads that copy, which
// points back at the original for later decisions: the enrichment used to stay
// in this process while the worker read the file without it. With an inline
// brief, undefined: prepareBusinessSolo writes the run's brief.md itself.
const workerBriefFile: string | undefined = (() => {
  if (inlineBrief || !briefFile) return undefined;
  if (brief === briefFileText) return path.resolve(briefFile);
  const copy = path.join(projDir, "brief.md");
  fs.writeFileSync(copy, `${brief.trimEnd()}\n\n> Source brief: ${path.resolve(briefFile)}. A decision the user makes while you work is appended there; read its Decisions section at every phase.\n`, "utf8");
  console.log(c("dim", `  brief enriched for this run: ${copy}`));
  return copy;
})();
const bizDir = businessEntry.bizDir ?? resolveEntityDir("businesses", slug, projDir);
const briefSquads = (() => { try { return namedSquadsIn(brief, Object.keys(defaultRegistries().squads)); } catch { return []; } })();
/** The solo worker's inputs for one outputs root; the run, the scaffold and the gauntlet producer share them. */
const soloArgs = (oroot: string, briefFileForRun?: string) => ({
  slug, bizDir, brief, ...(briefFileForRun ? { briefFile: briefFileForRun } : {}),
  projectId: pid, projectDir: projDir, projectRoot, outputsRoot: oroot, runtime: runtimeDecision.runtime,
  mandatorySquads: autoMandatorySquads, optionalSquads: autoOptionalSquads, briefSquads, rulesDirective,
});
const outputPath = path.join(projDir, "agent-prompt.md");
let promptSize = 0;
// Scaffold-only hands the user the one prompt a run would execute: the solo worker's.
if (scaffoldOnly) {
  const prep = prepareBusinessSolo(soloArgs(path.join(projDir, "deliverables"), workerBriefFile));
  fs.writeFileSync(outputPath, prep.prompt);
  promptSize = prep.prompt.length;
  console.log(c("dim", `  Prompt: ${promptSize.toLocaleString()} chars · saved to ${outputPath}`));
}

// Step 3 — dispatch_business audit event. Bind the audit facade to the project
// (pre-scaffold events are replayed there, flagged replayed_from_global — the
// split-root fix). The bind takes the PROJECT, never the scaffold: the scaffold
// grows its own `.nirvana/` for the dispatch kernel, so a walk-up anchored there
// reads it as a project of its own and the trace ends up in two files.
dispatchAudit.bindProjectRoot(projectRoot);
// Dispatch ledger — open the run BEFORE exec, so a crash anywhere between
// here and delivery leaves a non-terminal row the supervisor can recover.
// Scaffold-only mode opens nothing (there is no execution to supervise).
if (wantExec && !businessCanaryDecision.enabled) {
  ledgerTry(() => {
    ledgerHandle = runLedger.openLedger();
    const row = runLedger.openRun(ledgerHandle, {
      traceId: pid, projectId: pid, targetSlug: slug, targetKind: "business",
      runtime: runtimeDecision.runtime,
      initialLeaseSec: 900,
      meta: {
        ...dispatcherMeta(),
        project_dir: projDir, project_root: projectRoot, scaffold_root: scaffoldRoot,
        outputs_root: execOutputsRoot ?? null,
        prompt_path: path.join(projDir, "solo-prompt.md"), brief_path: workerBriefFile ?? path.join(projDir, "brief.md"),
        mode: "solo", runtime_source: runtimeDecision.source, dispatch_role: "solo",
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
  // The business is dispatched, not a seat: the seats the worker played are
  // credited from what it declares (x_seat_credited), never from this event.
  business_mode: "solo",
  // Honest mode: this standalone script either scaffolds only, or shells out to
  // a headless child runtime via --exec. The TRUE in-process subagent path is
  // the maestro calling the runtime's native subagent (Agent tool / codex
  // [agents] / antigravity dynamic subagents) — documented in the adapters,
  // NOT this script. So never claim "subagent-inline" here.
  mode: wantExec ? "headless-subprocess" : "scaffold-only",
  runtime: runtimeDecision.runtime,
  runtime_source: runtimeDecision.source,
  ...(promptSize ? { prompt_size_chars: promptSize } : {}),
});
if (executionOptions.requestedMode === "gauntlet") {
  emit(businessCanaryDecision.enabled ? "x_business_gauntlet_selected" : "x_business_gauntlet_bypassed", {
    trace_id: pid, project_id: pid, business_slug: slug, reason: businessCanaryDecision.reason,
    requested_mode: executionOptions.requestedMode, intensity: executionOptions.intensity,
  });
}
console.log(c("dim", `  ✓ dispatch_business written to ${path.join(harnessLogsDir({ cwd: projectRoot }), new Date().toISOString().slice(0, 10))}/audit.jsonl`));

// ── EXEC MODE — actually run the runtime headless, then verify+gate+deliver ─
if (wantExec) {
  // Final runtime: the flag > USE_* rule > current host decision (already
  // computed, and checked installed before anything was created).
  const rt = runtimeDecision.runtime;
  const oroot = execOutputsRoot as string;
  setRunBudgetRoot(oroot);

  console.log("");
  console.log(c("lime", "▶") + c("bold", ` Step 4/7 — exec business-solo (${rt})`));
  if (businessCanaryDecision.enabled) {
    const canonicalRunId = canonicalRunIdFor(pid, runIdFlag);
      const requirements = gauntletRequirements(pid, { kind: "business", slug }, { requirements: businessAcceptance.requirements });
    const { evaluator, budget } = gauntletEvaluatorFor({ pid, producer: { kind: "business", slug },
      plan: compileGauntletPlan({ brief, intensity: executionOptions.intensity, requirements }), projectRoot, workspaceRoot: scaffoldRoot, rt,
      kernelPath: KERNEL_PATH, runId: canonicalRunId, heuristicEnv: { NIRVANA_TRACE_ID: pid, NIRVANA_PROJECT_ID: pid, NIRVANA_BUSINESS_SLUG: slug } });
    const kernel = openKernel(KERNEL_PATH);
    const canaryLedger = runLedger.openLedger();
    let finalDelivery: DeliveryResult | null = null;
    let canarySessionId: string | null = null;
    // One producer for the first candidate and for every revision: the solo
    // worker, its prompt rebuilt per candidate root so every candidate and
    // revision writes into its own isolated directory, never into `oroot`.
    const produce = (candidateRoot: string, briefFile: string, candidateBrief: string) => {
      supersedePriorRuns(canonicalRunId);
      const prep = prepareBusinessSolo(soloArgs(candidateRoot, briefFile));
      attempt.markProductionStarted();
      const candidate = runWithCascade({ dispatchRole: "solo", runtime: rt, pinned: runtimePinned(), prompt: prep.prompt, ...prep.launch,
        maxBudgetUsd: budget.candidateBudgetUsd, timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
        yolo, brief: candidateBrief, projectRoot, outputsRoot: candidateRoot, taskHint: `business Gauntlet canary · ${slug}`,
        projectId: pid, ledger: { runId: canonicalRunId, watchDir: candidateRoot } });
      canarySessionId = candidate.sessionId;
      // A candidate credits the seats and clones it declares, as a standard solo run does.
      creditSoloRun({ emit, projectId: pid, projectDir: projDir, slug, runtime: candidate.finalRuntime, seats: prep.seats, voices: prep.voices });
      if (candidate.sessionId) runLedger.recordSession(canaryLedger, canonicalRunId, candidate.sessionId);
      return { ok: candidate.ok, sessionId: candidate.sessionId, costUsd: candidate.costUsd,
        error: candidate.error || candidate.stderr || undefined };
    };
    const executionSnapshot = frozenExecutionSnapshot(pid, rt, "business");
    const attempt = {
      markProductionStarted() {},
      run() {
        return runAgentXGauntlet({
          kernel, legacy: createHarnessLegacyAdapter({ ledger: canaryLedger, auditCwd: projectRoot }),
          producerTarget: { kind: "business", slug }, projectId: pid, runId: canonicalRunId, traceId: pid,
          brief, projectRoot, workspaceRoot: scaffoldRoot, outputsRoot: oroot, expectedCostUsd: budget.roundBudgetUsd, intensity: executionOptions.intensity,
          requirements, executionSnapshot, audit: emit,
          executeCandidate: candidateRoot => produce(candidateRoot, workerBriefFile ?? tmpBriefFile, brief),
          reviseCandidate(request) {
            const revision = writeRevisionBrief(brief, request);
            return produce(request.candidateRoot, revision.file, revision.text);
          },
          evaluator,
          finalGate({ sessionId }) {
            const sessionFile = path.join(projDir, "session.json");
            const sessionData: Record<string, any> = { project_id: pid, business_slug: slug, runtime: rt,
              session_id: sessionId, project_dir: projDir, project_root: projectRoot, outputs_root: oroot,
              workspace: runWorkspace ?? null,
              zip_path: null, created_at: new Date().toISOString(), manifest: manifest ?? null };
            fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
            const afterGate = () => runBusinessPostGate({ projectId: pid, businessSlug: slug, runtime: rt,
              projectDir: projDir, projectRoot, outputsRoot: oroot, skillsRoot: SKILLS,
              sessionFile, sessionData, rulesDirective, maxBudgetUsd: budget.candidateBudgetUsd,
              timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined, yolo, wantPdf, skipHtml,
              offlineSnapshot: process.argv.includes("--offline-snapshot"), routingMode, wantZip, emit,
              log: message => console.log(c("lime", message)), warn: message => console.error(c("yellow", message)) });
            finalDelivery = runDelivery({ ...deliveryArgs({ pid, slugOrNull: slug, targetKind: "business", rt, oroot,
              projDir, projectRoot, sessionId, withManifest: true, afterGate, produces: businessProduces,
              acceptancePromisesPaths: businessAcceptance.paths.length > 0 }), ledger: null, maxRevisions: 0,
              // The Gauntlet's evaluator already scored the criteria on the candidate; the
              // claims check only applies when the worker's _CLAIMS.json reached this root.
              claimsCheck: fs.existsSync(path.join(oroot, "_CLAIMS.json")) });
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
          runtime: rt, meta: { ...dispatcherMeta(), project_dir: projDir, project_root: projectRoot, scaffold_root: scaffoldRoot,
            outputs_root: oroot, prompt_path: outputPath, brief_path: workerBriefFile ?? tmpBriefFile, mode: "single",
            runtime_source: runtimeDecision.source, dispatch_role: "solo" } });
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
    : openStandardPublication({ kernelPath: KERNEL_PATH, projectId: pid, runId: canonicalRunIdFor(pid, runIdFlag), traceId: pid,
      target: { kind: "business", slug }, snapshot: frozenExecutionSnapshot(pid, rt, "business"), audit: emit, warn: line => console.error(c("yellow", line)) });
  if (publication.incompatible || publication.collided) {
    const error = publication.collided ? `run ${publication.runId} is already terminal` : "runtime incompatible with the provider catalog";
    if (ledgerRunId) ledgerTry(() => runLedger.markState(ledgerHandle!, ledgerRunId!, "failed", { error }));
    process.exit(1);
  }
  supersedePriorRuns(ledgerRunId ?? publication.runId);
  // No childPid here: the heartbeat sidecar (spawned inside runHeadless, once
  // the runner below actually calls spawnSync) discovers the real CLI child
  // and records it — see run-ledger.ts recordChildPid. Writing process.pid
  // (this dispatcher, about to block inside spawnSync) here is exactly the
  // bug this cut fixes: the supervisor would SIGTERM the orchestrator itself.
  if (ledgerRunId) ledgerTry(() => runLedger.markState(ledgerHandle!, ledgerRunId!, "running"));
  publication.start();

  let res!: { ok: boolean; sessionId: string | null; durationMs: number; costUsd: number | null; exitCode?: number; error?: string; stderr?: string };
  // Set when the runtime returned an error verdict. The run is NOT abandoned
  // here: whatever landed on disk still goes through verify → gate below
  // (deliverAfterRuntimeError), which needs the afterGate hook defined further
  // down — so the decision is deferred instead of exiting on the spot.
  let runtimeError: string | null = null;

  // ONE agent is the whole business (lib/business-solo.ts).
  const sr = runBusinessSolo({
    ...soloArgs(oroot, workerBriefFile),
    runtime: rt, maxBudgetUsd: effectiveBudgetUsd(),
    timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
    yolo, ledgerRunId, emit, runWithCascadeImpl: pinnedCascade,
  });
  res = sr;
  chargeRunBudget(sr.costUsd);
  // The runtime that actually finished the work: after a quota handoff it is
  // not `rt`, and revisions, the post-gate steps and `nrv revise` continue there.
  const finalRt = sr.finalRuntime;
  console.log(c("dim", `  seats played: ${sr.seatsPlayed.length ? sr.seatsPlayed.join(", ") : "none declared"}`));
  let reviewBlockingMissed: string[] = [];
  if (!sr.ok) {
    console.error(c("red", `✗ business failed (exit ${sr.exitCode}): ${sr.error || sr.stderr || "unknown"}`));
    emit("agent_exec_failed", { trace_id: pid, project_id: pid, business_slug: slug, runtime: rt, mode: "business-solo", exit_code: sr.exitCode, error: sr.error || sr.stderr });
    runtimeError = sr.error || sr.stderr || `exit ${sr.exitCode}`;
  } else {
    console.log(c("dim", `  session: ${sr.sessionId || "(none)"} · ${sr.durationMs}ms${sr.costUsd != null ? ` · $${sr.costUsd.toFixed(4)}` : ""}`));
    // Review as an exception: a rule decides, one reviewer for the whole
    // delivery, corrections in the worker's own session, then the normal
    // delivery pipeline below (verify → gate → deliver) as for any run.
    const review = runSoloReviewStage({
      maxBudgetUsd: effectiveBudgetUsd(), rulesDirective,
      ...(ledgerRunId ? { ledger: { runId: ledgerRunId, watchDir: oroot } } : {}),
      business: slug, bizDir, briefFile: sr.briefFile, outputsRoot: oroot, projectRoot,
      worker: { runtime: sr.finalRuntime, sessionId: sr.sessionId, launch: sr.launch },
      policy: resolveSetting("review.policy").value as ReviewPolicy,
      runtimePref: resolveSetting("review.runtime").value as "other" | "same",
      maxRounds: Number(resolveSetting("review.max_rounds").value),
      userAsked: reviewAsked, userDeclined: reviewDeclined, yolo,
      timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
      emit: (event, payload) => emit(event, { trace_id: pid, project_id: pid, ...payload }),
      log: message => console.log(c("dim", message)),
    });
    if (review.reservations) console.error(c("yellow", `  ⚠ review left reservations: ${review.reservations}`));
    reviewBlockingMissed = review.blockingMissed ?? [];
  }

  // session.json — lets `nrv revise` resume the same conversation and `nrv clean` find everything.
  const sessionFile = path.join(projDir, "session.json");
  const sessionData: Record<string, any> = {
    project_id: pid, business_slug: slug, runtime: sr.finalRuntime,
    session_id: res.sessionId, project_dir: projDir, project_root: projectRoot,
    outputs_root: oroot, zip_path: null, created_at: new Date().toISOString(),
    // Where the session was started: `nrv revise` resumes from the same folder,
    // since claude and gemini keep a session under its working directory.
    workspace: runWorkspace ?? null,
    // The manifest travels with the session: without it `nrv revise` loses the
    // one completeness proof the system has (promised paths vs disk truth) and
    // silently downgrades to the scan fallback on every revision.
    manifest: manifest ?? null,
  };
  fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
  // Session id into the ledger so the supervisor can resume this conversation.
  if (ledgerRunId) ledgerTry(() => runLedger.recordSession(ledgerHandle!, ledgerRunId!, res.sessionId ?? null));

  // Advance HANDOFF to complete (one-shot autopilot). An errored run advances
  // only once its artifacts actually enter the delivery pipeline (below): a run
  // that produced nothing at all stays where it stopped.
  const advanceHandoff = () => {
    try {
      const { updateHandoffPhase } = requireCjs(path.join(SKILLS, "_shared", "lib", "handoff.js"));
      updateHandoffPhase(projDir, "complete", {
        lastTaskCompleted: runtimeError ? "headless exec (runtime error; artifacts judged anyway)" : "headless exec",
        decisions: [`autopilot run via ${finalRt}`],
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
      projectId: pid, businessSlug: slug, runtime: finalRt, projectDir: projDir, projectRoot,
      outputsRoot: oroot, skillsRoot: SKILLS,
      sessionFile, sessionData, rulesDirective, maxBudgetUsd: effectiveBudgetUsd(),
      timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
      yolo, wantPdf, skipHtml, offlineSnapshot: process.argv.includes("--offline-snapshot"),
      routingMode, wantZip, emit,
      ...(ledgerRunId ? { ledger: { runId: ledgerRunId, watchDir: oroot } } : {}),
      log: message => console.log(c("lime", message)),
      warn: message => console.error(c("yellow", message)),
    });
    zipPathOut = result.zipPath;
    return result;
  };

  const bizDeliverOpts = {
    pid, slugOrNull: slug, targetKind: "business" as const, rt: finalRt, oroot,
    projDir, projectRoot, sessionId: res.sessionId, withManifest: true,
    afterGate, produces: businessProduces, acceptancePromisesPaths: businessAcceptance.paths.length > 0,
    reviewBlockingMissed,
    onSession: (sid: string) => {
      res.sessionId = sid;
      sessionData.session_id = sid;
      fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
    },
  };
  let delivery: DeliveryResult;
  publication.verify();
  if (runtimeError) {
    const outcome = deliverAfterError(bizDeliverOpts, runtimeError, { mode: "solo" });
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

// Step 4 — actionable next step (--scaffold-only)
console.log("");
console.log(c("lime", "▶") + c("bold", " Step 4/4 — next steps"));
// An orchestrator that prepared a run reads this block next. Its next step is
// to run the business, never to paste the prompt into itself and produce the
// work: the exec line comes first.
printScaffoldNextStep(pid, `The prompt is at ${outputPath}.`);
console.log("");
console.log(c("cyan", "  To run it by hand in a runtime instead, paste the whole prompt:"));
console.log("    " + c("yellow", `cat ${quoteArg(outputPath)} | pbcopy        # macOS`));
console.log("    " + c("yellow", `cat ${quoteArg(outputPath)} | xclip -selection clipboard   # Linux`));
console.log("    " + c("yellow", `type ${quoteArg(outputPath)} | clip         # Windows (cmd)`));
console.log("    " + c("yellow", `Get-Content ${quoteArg(outputPath)} | Set-Clipboard   # Windows (PowerShell)`));
console.log(c("cyan", "  Then check what it wrote:"));
console.log("    " + c("yellow", `bun ${quoteArg(path.join(SKILLS, "businesses", "scripts", "verify-deliverable.ts"))} ${pid} ${slug}`));

// Scaffold-only: nothing executed, nothing judged, nothing delivered → 3.
process.exit(3);

} // end if (import.meta.main) — CLI flow guard
