// orca-worker.ts — the Orca transport for a headless dispatch.
//
// `runHeadless` runs a seat, a squad or agent-x as an invisible child process:
// spawnSync, stdin prompt, JSON envelope back. Inside Orca the same dispatch
// can run as a WORKER instead — a visible terminal tab with the agent's own
// TUI, live status from Orca's hooks, a transcript the owner can open, and a
// completion report the engine waits for. This module is that transport.
//
// What it changes and what it does not (ADR-009):
//   - The prompt is the same one the headless runner would send (persona,
//     DNA, resource map, scope guard, autonomous directive). It travels by
//     reference: a file the worker is told to read, never through the TUI's
//     input, because a seat prompt is tens of kilobytes and Orca's inject
//     types the spec into the terminal.
//   - The result has the same shape (RunHeadlessResult). Verify, gate and
//     delivery happen in the coordinating `nrv` process exactly as before; the
//     worker's `--outcome succeeded` is an input to verify, never a verdict.
//   - Anything that fails BEFORE the task is injected returns null, and the
//     caller falls back to the headless child — same brief, same result shape,
//     nothing lost. Orca's orchestration is Experimental and off by default; a
//     nested worker is refused by depth; an unrecognized agent cannot receive
//     the preamble. Each of those is a fallback, not an error.
//
// Measured on Orca 1.4.198 (2026-09-09): run-create → task-create →
// terminal create (operator-started `claude --dangerously-skip-permissions`)
// → wait tui-idle → dispatch --inject → check --run --wait returned a
// worker_done with taskId, dispatchId, outcome, filesModified and reportPath;
// the file the brief asked for was on disk 18 seconds after inject. An
// operator-started terminal is reported `unsupervised` by Orca, which is
// correct: the engine owns its lifecycle, as it owns a child pid.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { contextWindowSetting, headlessClaudeEnv, LEDGER_DEFAULT_TIMEOUT_MS, SYNTHETIC_AGY_SID, type RunHeadlessOpts, type RunHeadlessResult, type Runtime } from "./host-agent-driver.ts"; // cycle is safe: used at call time only
import { agyConversationFor, claudeTranscriptUsage, codexSessionFor, findClaudeTranscript } from "./session-capture.ts";
import { estimateCostUsd } from "../../harness/lib/cost-estimator.ts";
import { childDepth, DEPTH_ENV, ROLE_ENV } from "./dispatch-depth.ts";
import { orcaJson, orcaFire, orcaWorkersActive, orcaWorkspaceSelector } from "./orca.ts";
import { isEffortLevel, resolvePinnedEffort, resolveSystemModel } from "./system-model.ts";
import { codexConfigPath } from "./codex-hooks.ts";
import { RUN_WORKSPACE_ENV } from "./run-workspace.ts";

/** Nirvana runtime → the agent id Orca recognizes in a terminal (the identity
 *  its hooks report, and what `dispatch --inject` needs to deliver a preamble).
 *  A runtime absent here has no Orca agent id and keeps the headless child. */
export const ORCA_AGENT_ID: Partial<Record<Runtime, string>> = {
  "claude-code": "claude",
  codex: "codex",
  "antigravity-cli": "antigravity",
  "kimi-cli": "kimi",
  "grok-cli": "grok",
  pi: "pi",
  opencode: "opencode",
};

/** One `check --wait` window. Long enough that a working seat is not polled
 *  every minute, short enough that a vanished terminal is noticed. */
const WAIT_WINDOW_MS = 15 * 60_000;
const TUI_READY_MS = 120_000;
/** `dispatch --inject` delivers the preamble into the TUI and waits for the
 *  agent to take it; a busy machine takes longer than an RPC. */
const INJECT_MS = 90_000;

/** What a first-run workspace trust dialog looks like on screen. Claude Code
 *  ("Accessing workspace … Is this a project you created or one you trust?"),
 *  Codex ("Do you trust the files in this folder?"), qwen-code ("Do you trust
 *  this folder?"). A TUI parked on one is idle to `terminal wait` and deaf to
 *  the injected preamble — measured: the inject call sat until its timeout. */
const TRUST_PROMPT = /Accessing workspace|trust (the files|this (folder|project|directory|workspace))|Is this a project you created|Do you trust/i;

/**
 * Pre-accept the workspace trust dialog for `cwd`, the way the runtime itself
 * records it, so the worker starts at its prompt. The engine is about to run
 * this agent in that directory with every permission bypassed (the headless
 * runner already does, without a dialog); recording trust for the same
 * directory is the same decision, made visible in the runtime's own file.
 * Best-effort: a runtime without a known record, or a file that cannot be
 * written, is left alone and the screen check below catches the dialog.
 *
 * Records, verified on the installed CLIs on 2026-09-09:
 *   claude-code  ~/.claude.json            projects["<cwd>"].hasTrustDialogAccepted = true
 *   codex        ~/.codex/config.toml      [projects."<cwd>"] trust_level = "trusted"
 *   qwen-code    ~/.qwen/trustedFolders.json  { "<cwd>": "TRUST_FOLDER" }
 */
export function preTrustWorkspace(runtime: Runtime, cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const written: string[] = [];
  const dirs = new Set<string>([cwd]);
  try { dirs.add(fs.realpathSync(cwd)); } catch { /* not on disk: the raw form is all there is */ }
  const home = env.NIRVANA_HOME || env.HOME || env.USERPROFILE || os.homedir();
  try {
    if (runtime === "claude-code") {
      const cfgDir = env.CLAUDE_CONFIG_DIR;
      const file = cfgDir && fs.existsSync(path.join(cfgDir, ".claude.json")) ? path.join(cfgDir, ".claude.json") : path.join(home, ".claude.json");
      const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      doc.projects = doc.projects && typeof doc.projects === "object" ? doc.projects : {};
      let changed = false;
      for (const d of dirs) {
        const entry = doc.projects[d] && typeof doc.projects[d] === "object" ? doc.projects[d] : (doc.projects[d] = {});
        if (entry.hasTrustDialogAccepted !== true) { entry.hasTrustDialogAccepted = true; changed = true; }
      }
      if (changed) { fs.writeFileSync(file, JSON.stringify(doc, null, 2), "utf8"); written.push(file); }
    } else if (runtime === "codex") {
      const file = env.CODEX_HOME ? path.join(env.CODEX_HOME, "config.toml") : codexConfigPath();
      const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const missing = [...dirs].filter((d) => !text.includes(`[projects.${JSON.stringify(d)}]`));
      if (missing.length) {
        const block = missing.map((d) => `\n[projects.${JSON.stringify(d)}]\ntrust_level = "trusted"\n`).join("");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text + (text && !text.endsWith("\n") ? "\n" : "") + block, "utf8");
        written.push(file);
      }
    } else if (runtime === "qwen-code") {
      const file = path.join(home, ".qwen", "trustedFolders.json");
      const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      let changed = false;
      for (const d of dirs) if (doc[d] !== "TRUST_FOLDER") { doc[d] = "TRUST_FOLDER"; changed = true; }
      if (changed) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(doc, null, 2), "utf8"); written.push(file); }
    }
  } catch { /* best-effort: the screen check decides */ }
  return written;
}

function screenText(lines: unknown): string {
  return Array.isArray(lines) ? lines.map(String).join("\n") : typeof lines === "string" ? lines : "";
}

/** True when the terminal's screen shows a workspace trust dialog. */
export function screenShowsTrustPrompt(lines: unknown): boolean {
  return TRUST_PROMPT.test(screenText(lines));
}

/** A permission or plan-review question, as the TUIs word them. Matched only
 *  together with a choice line (DIALOG_CHOICE), so a transcript that merely
 *  mentions a plan or a permission is not a dialog. */
const PERMISSION_PROMPT = /Do you want to (?:proceed|allow|make this edit|run|create|apply|execute)|Allow (?:this|once|always)\b|Approve (?:this|the) (?:command|action|edit|change)|Permission required|wants to (?:run|use|execute|edit)/i;
const PLAN_REVIEW = /Would you like to proceed\?|Ready to code\?|approve (?:the|this) plan|exit plan mode/i;
const DIALOG_CHOICE = /^[\s│|]*(?:[❯›>▸●]\s*)?(?:\d+[.)]\s*)?(?:Yes|No|Allow|Approve|Deny|Reject|Trust|Always)\b/im;

export type ScreenDialog = "trust-prompt" | "permission-prompt" | "plan-review";

/** The dialog a worker's TUI is parked on, or null. */
export function screenDialog(lines: unknown): ScreenDialog | null {
  const text = screenText(lines);
  if (TRUST_PROMPT.test(text)) return "trust-prompt";
  if (!DIALOG_CHOICE.test(text)) return null;
  if (PLAN_REVIEW.test(text)) return "plan-review";
  if (PERMISSION_PROMPT.test(text)) return "permission-prompt";
  return null;
}

/** How long the screen is watched after the inject before the worker is
 *  trusted to have taken its task, and how often it is read. The 2026-10-15
 *  trust dialog was on screen within a second of the inject. */
function postInjectWindowMs(): number {
  const v = Number(process.env.NIRVANA_ORCA_POST_INJECT_MS);
  return Number.isFinite(v) && v >= 0 && process.env.NIRVANA_ORCA_POST_INJECT_MS !== "" && process.env.NIRVANA_ORCA_POST_INJECT_MS !== undefined ? v : 6_000;
}
const POST_INJECT_STEP_MS = 1_500;

/** The reply the engine gives a worker that asks: the zero-human doctrine,
 *  stated once. */
const ASK_REPLY = "Decide with professional defaults, record the assumption under an 'Assumptions' section of the main deliverable (titled in its language), and continue. No human is in this loop.";

export interface OrcaWorkerHooks {
  /** Test seam: canned `orca … --json` answers. */
  orcaJsonImpl?: typeof orcaJson;
  orcaFireImpl?: typeof orcaFire;
  activeImpl?: () => boolean;
  now?: () => number;
  /** Test seam: where the CLIs keep their sessions (HOME, CODEX_HOME, CLAUDE_CONFIG_DIR). */
  sessionEnv?: Record<string, string | undefined>;
  /** Test seam: the pause between screen reads after the inject. */
  sleep?: (ms: number) => void;
  /** Test seam: the stall thresholds (default: the execution.stall_* settings). */
  stallThresholds?: { silenceMs: number; noStartMs: number };
}

type StallGuard = typeof import("../../harness/lib/stall-guard.ts");
type Ledger = typeof import("../../harness/lib/run-ledger.ts");
function stallGuardModule(): StallGuard | null {
  try { return createRequire(import.meta.url)(path.join(import.meta.dir, "..", "..", "harness", "lib", "stall-guard.ts")) as StallGuard; }
  catch { return null; }
}
function ledgerModule(): Ledger | null {
  try { return createRequire(import.meta.url)(path.join(import.meta.dir, "..", "..", "harness", "lib", "run-ledger.ts")) as Ledger; }
  catch { return null; }
}

/**
 * The session id of a finished worker. The resumed or assigned one when the
 * engine gave it; for codex and agy, which choose their own, what their files
 * say (session-capture.ts): codex's session filed for the worker's folder since
 * it started, agy's last prompt from that folder. Null when nothing says.
 */
export function workerSessionId(runtime: Runtime, session: WorkerSession, cwd: string, sinceMs: number, hooks: Pick<OrcaWorkerHooks, "sessionEnv"> = {}): string | null {
  if (session.resume) return session.resume;
  if (session.assign) return session.assign;
  const env = hooks.sessionEnv ?? process.env;
  if (runtime === "codex") return codexSessionFor(cwd, sinceMs, env);
  if (runtime === "antigravity-cli") return agyConversationFor(cwd, sinceMs, env);
  return null;
}

/** What an interactive claude worker spent, from its own transcript: the
 *  tokens of the turns written since it started, priced when the model has a
 *  price (cost-estimator.ts). The worker reports no cost of its own. */
function claudeWorkerCost(sessionId: string, sinceMs: number, hooks: Pick<OrcaWorkerHooks, "sessionEnv">): { costUsd: number | null; usage?: RunHeadlessResult["usage"]; model?: string } | null {
  try {
    const file = findClaudeTranscript(sessionId, hooks.sessionEnv ?? process.env);
    const read = file ? claudeTranscriptUsage(file, sinceMs) : null;
    if (!read) return null;
    const costUsd = estimateCostUsd("claude-code", read.model, { costUsd: null, usage: read.usage } as RunHeadlessResult);
    return { costUsd, usage: read.usage, ...(read.model ? { model: read.model } : {}) };
  } catch { return null; }
}

/** The session a worker continues (`resume`) or starts under an id the engine
 *  chose (`assign`). */
export interface WorkerSession { resume?: string; assign?: string }

/**
 * How each interactive CLI continues a session or starts one under a given id
 * (each `--help` read 2026-10-15: claude 2.1.301, codex 0.162.1, agy 1.3.5,
 * grok 1.0.52, pi 0.84.3; kimi from its sessions guide). `assign` is false
 * where the CLI picks its own id: the engine reads it back after the worker
 * finishes (session-capture.ts). opencode has neither, so a resume there runs
 * as the headless child.
 */
export const INTERACTIVE_SESSION: Partial<Record<Runtime, { resume: boolean; assign: boolean }>> = {
  "claude-code": { resume: true, assign: true },
  codex: { resume: true, assign: false },
  "antigravity-cli": { resume: true, assign: false },
  "grok-cli": { resume: true, assign: true },
  "kimi-cli": { resume: true, assign: true },
  pi: { resume: true, assign: true },
};

/**
 * The interactive command for a runtime, as argv. Autonomy flags match the
 * headless runners' (audited against the installed CLIs on 2026-09-09:
 * `claude --dangerously-skip-permissions`, `codex
 * --dangerously-bypass-approvals-and-sandbox`, `agy --dangerously-skip-permissions`, `grok --always-approve`); `--safe`
 * (yolo false) drops them, and claude takes `--permission-mode acceptEdits`
 * like its headless twin. Null for a runtime Orca has no agent id for.
 */
export function interactiveArgv(opts: Pick<RunHeadlessOpts, "runtime" | "yolo" | "model" | "effort" | "addDirs" | "claudeSettings"> & Partial<Pick<RunHeadlessOpts, "allowSubagents">>, session: WorkerSession = {}): string[] | null {
  if (!ORCA_AGENT_ID[opts.runtime]) return null;
  const { resume, assign } = session;
  const yolo = opts.yolo !== false;
  // The caller's value, else the user's pin, else nothing — a bare CLI uses the
  // model its own configuration names. `resolveSystemModel` answers a pin for
  // any runtime by design, so a Claude alias pinned while dispatching codex is
  // dropped here the way the headless adapter drops it, instead of reaching
  // `-m opus` and failing the run.
  let model: string | null = opts.model ?? null;
  if (!model) { try { model = resolveSystemModel(opts.runtime) ?? null; } catch { model = null; } }
  if (model && opts.runtime === "codex" && !/^(gpt|o[0-9]|codex)/i.test(model)) model = null;
  let effort: string | null = null;
  try {
    const wanted = (opts.effort ?? "").trim().toLowerCase() || resolvePinnedEffort() || "";
    // Only claude and codex have the concept; the others run at their own default.
    if (wanted && isEffortLevel(wanted) && (opts.runtime === "claude-code" || opts.runtime === "codex")) effort = wanted;
  } catch { effort = null; }
  const dirs = opts.addDirs ?? [];
  switch (opts.runtime) {
    case "claude-code": {
      const a = ["claude", ...(yolo ? ["--dangerously-skip-permissions"] : ["--permission-mode", "acceptEdits"])];
      if (resume) a.push("--resume", resume);
      else if (assign) a.push("--session-id", assign);
      if (model) a.push("--model", model);
      if (effort) a.push("--effort", effort);
      // The run's deny rules (run-workspace.ts): the same fence as headless.
      if (opts.claudeSettings) a.push("--settings", opts.claudeSettings);
      // The headless runner's rule: a dispatched worker does not open its own
      // agents (the runtime's subagent tool multiplies inside one child and
      // never passes through the engine's depth counter).
      // Workflow too: the dynamic-workflow tool can fan out to 1,000 agents.
      if (!opts.allowSubagents) a.push("--disallowedTools", "Task", "Agent", "Workflow");
      for (const d of dirs) a.push("--add-dir", d);
      return a;
    }
    case "codex": {
      // `codex resume <id>` takes the same options as `codex` itself.
      const a = ["codex", ...(resume ? ["resume", resume] : []), ...(yolo ? ["--dangerously-bypass-approvals-and-sandbox"] : [])];
      if (model) a.push("-m", model);
      if (effort) a.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
      // The context ceiling, as the headless runner passes it.
      const window = contextWindowSetting();
      if (window > 0) a.push("-c", `model_auto_compact_token_limit=${window}`);
      // The headless runner's rule: no subagents unless the caller orchestrates.
      if (!opts.allowSubagents) a.push("-c", "agents.enabled=false");
      for (const d of dirs) a.push("--add-dir", d);
      return a;
    }
    case "antigravity-cli": {
      // A placeholder id names no agy conversation: the most recent one of the
      // folder is the run's, as the headless runner resumes it.
      const cont = resume ? (resume.startsWith(SYNTHETIC_AGY_SID) ? ["--continue"] : ["--conversation", resume]) : [];
      return ["agy", ...(yolo ? ["--dangerously-skip-permissions"] : []), ...cont, ...(model ? ["--model", model] : [])];
    }
    case "grok-cli":
      return ["grok", ...(yolo ? ["--always-approve"] : []), ...(resume ? ["-r", resume] : assign ? ["--session-id", assign] : []), ...(model ? ["-m", model] : [])];
    case "kimi-cli":
      return ["kimi", ...((resume ?? assign) ? ["--session", (resume ?? assign)!] : []), ...(model ? ["-m", model] : [])];
    case "pi":
      // `--session-id` continues the session when it exists and creates it otherwise.
      return ["pi", ...((resume ?? assign) ? ["--session-id", (resume ?? assign)!] : []), ...(model ? ["--model", model] : [])];
    case "opencode":
      return resume ? null : ["opencode"];
    default:
      return null;
  }
}

/** The variables a worker must inherit for its `nrv` calls to land in the same
 *  project and trace as the coordinator: every NIRVANA_* plus the log roots.
 *  Orca's own pane variables are the terminal's, not ours to forward. */
export function forwardedEnv(env: NodeJS.ProcessEnv = process.env, asRuntime?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/^NIRVANA_/.test(k) || k === "HARNESS_LOGS_DIR" || k === "MAESTRO_LOGS_DIR") {
      // The command line is visible (Orca titles and shell history): a variable
      // that carries a secret does not travel on it. NIRVANA_AUDIT_KEY is a
      // PATH to the key file, not the key, so it stays.
      if (/(?:SECRET|TOKEN|PASSWORD|API_?KEY)/i.test(k)) continue;
      out[k] = v;
    }
  }
  // The worker IS `asRuntime`, whatever this process is. Forwarding the
  // parent's own `NIRVANA_HOST_RUNTIME` would tell the worker it is the vendor
  // that launched it, and any `nrv` it runs would route back out of the
  // terminal the user is watching.
  if (asRuntime) out.NIRVANA_HOST_RUNTIME = asRuntime;
  return out;
}

/** What the worker is, for the role and depth rules its own dispatches answer
 *  to. Inheriting the parent's would make a squad worker look like the business
 *  that started it: unrestricted, and one level shallower than it is. The
 *  headless runner stamps the same two values on its child (driverSpawnSync). */
export function workerRoleEnv(opts: Pick<RunHeadlessOpts, "dispatchRole">, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { [DEPTH_ENV]: String(childDepth(env)) };
  if (opts.dispatchRole) out[ROLE_ENV] = opts.dispatchRole;
  return out;
}

function posixQuote(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'`; }
function psQuote(s: string): string { return `'${s.replace(/'/g, "''")}'`; }

/** The one-line command `terminal create --command` runs: enter the run's
 *  directory, pin the engine's environment, start the agent. POSIX shells on
 *  macOS and Linux; PowerShell on Windows, where Orca's terminals default to it. */
export function workerCommand(argv: string[], cwd: string, env: Record<string, string>, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const pins = Object.entries(env).map(([k, v]) => `$env:${k}=${psQuote(v)};`).join(" ");
    return `Set-Location -LiteralPath ${psQuote(cwd)}; ${pins} & ${argv.map(psQuote).join(" ")}`;
  }
  const pins = Object.entries(env).map(([k, v]) => `${k}=${posixQuote(v)}`).join(" ");
  return `cd ${posixQuote(cwd)} && ${pins ? `env ${pins} ` : ""}${argv.map(posixQuote).join(" ")}`;
}

/** The brief file the worker reads: the system directive and the prompt the
 *  headless runner would have sent, plus how to report. */
export function briefFileContent(opts: Pick<RunHeadlessOpts, "prompt" | "appendSystemPrompt" | "cwd">): string {
  return [
    "# Nirvana dispatch (Orca worker)",
    "",
    "These instructions are in English. What you DELIVER follows the language of the client brief below.",
    `Working directory: ${opts.cwd}`,
    "",
    ...(opts.appendSystemPrompt ? ["## System directive", "", opts.appendSystemPrompt, ""] : []),
    "## Brief",
    "",
    opts.prompt,
    "",
    "## Reporting (Orca)",
    "",
    "This terminal was started by the Nirvana engine as an Orca worker. When the brief is complete, send `worker_done` exactly as the Orca preamble at the start of this session instructs: `--outcome succeeded` when every deliverable is on disk, `--outcome failed` otherwise, and `--report-path` naming the main deliverable. The engine verifies the files itself afterwards; the report is a summary, not a verdict. If you send `orca orchestration ask`, the engine answers with its defaults policy, never a human.",
    "",
  ].join("\n");
}

type Audit = { emit: (event: string, payload: Record<string, unknown>, ctx?: Record<string, unknown>) => void };
let _audit: Audit | null | false = null;
function audit(): Audit | null {
  if (_audit === null) {
    try { _audit = createRequire(import.meta.url)(path.join(import.meta.dir, "..", "..", "harness", "lib", "audit.js")) as Audit; }
    catch { _audit = false; }
  }
  return _audit || null;
}

function emit(event: string, payload: Record<string, unknown>, cwd: string): void {
  try {
    audit()?.emit(event, payload, {
      trace_id: process.env.NIRVANA_TRACE_ID || undefined,
      project_id: process.env.NIRVANA_PROJECT_ID || undefined,
      cwd,
    });
  } catch { /* the transport never fails on audit */ }
}

interface Message { id: string; type: string; subject?: string; body?: string; payload?: string | Record<string, unknown>; from_handle?: string }

function parsePayload(m: Message): Record<string, unknown> {
  if (!m.payload) return {};
  if (typeof m.payload === "object") return m.payload;
  try { return JSON.parse(m.payload); } catch { return {}; }
}

/**
 * Run `opts` as an Orca worker. Returns null when the transport does not apply
 * or could not start (the caller then runs the headless child); returns a
 * RunHeadlessResult once the worker took its task, whatever the outcome.
 *
 * "Took its task" is checked: for a few seconds after the inject the screen is
 * read again, and a trust, permission or plan-review dialog, or a prompt left
 * sitting unsent, closes the terminal and returns null, so the same run goes
 * to the headless child (2026-10-15: agy drew its trust dialog 0.3 s after the
 * inject and waited 94 minutes for an Enter).
 *
 * The wait ends on the worker's report, on a vanished terminal, on an explicit
 * --timeout, or on a silence budget (execution.stall_timeout_min and
 * execution.stall_no_start_min, the stall guard's settings): no message, no
 * Orca heartbeat, no file written under the run's folders, no hook-recorded
 * tool activity and no live child run since the inject for that long ends it
 * as stalled. The 7-day ledger backstop no longer applies here.
 */
export function runOrcaWorker(opts: RunHeadlessOpts, hooks: OrcaWorkerHooks = {}): RunHeadlessResult | null {
  const active = hooks.activeImpl ?? orcaWorkersActive;
  if (!active()) return null;
  if (!ORCA_AGENT_ID[opts.runtime]) return null;
  // The worker continues the session it was given, or starts one under an id
  // the engine chose, so `nrv revise` can continue it later. A runtime that can
  // do neither interactively runs a resume as the headless child.
  const caps = INTERACTIVE_SESSION[opts.runtime];
  if (opts.sessionId && !caps?.resume) {
    emit("x_orca_transport_fallback", { stage: "resume", reason: `${opts.runtime} cannot resume a session in an interactive worker`, runtime: opts.runtime, label: opts.label ?? null }, opts.cwd);
    return null;
  }
  const session: WorkerSession = opts.sessionId ? { resume: opts.sessionId } : caps?.assign ? { assign: randomUUID() } : {};
  const argv = interactiveArgv(opts, session);
  if (!argv) return null;
  // An interactive worker cannot honour an answer-only call (it needs its tools
  // to report worker_done) nor an explicit tool allowlist. Running those as a
  // worker would hand a decision step an unrestricted agent, so the headless
  // child, which can say `--tools ""`, keeps them.
  if (opts.noTools || opts.allowedTools !== undefined) {
    emit("x_orca_transport_fallback", { stage: "restrictions", reason: "answer-only or tool-restricted call cannot be honoured by an interactive worker", runtime: opts.runtime, label: opts.label ?? null }, opts.cwd);
    return null;
  }
  const call = hooks.orcaJsonImpl ?? orcaJson;
  const fire = hooks.orcaFireImpl ?? orcaFire;
  const now = hooks.now ?? Date.now;
  const sleep = hooks.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  const started = now();
  // The wall clock, for the files a CLI writes (`now` is a test seam).
  const wallStarted = Date.now();
  // An explicit --timeout stays a wall clock; the ledger's 7-day backstop is
  // not one here: the silence budget below is what ends a hung worker.
  const deadline = typeof opts.timeoutMs === "number" && opts.timeoutMs < LEDGER_DEFAULT_TIMEOUT_MS ? started + opts.timeoutMs : null;
  const label = (opts.label ?? `${opts.runtime} worker`).slice(0, 80);
  const agent = ORCA_AGENT_ID[opts.runtime]!;
  const cwd = opts.cwd;
  const fallback = (stage: string, reason: string, extra: Record<string, unknown> = {}): null => {
    emit("x_orca_transport_fallback", { stage, reason, runtime: opts.runtime, label, ...extra }, cwd);
    return null;
  };

  // The run's ledger row, when the dispatch has one: the terminal is recorded
  // on it (so `nrv run-track stop` and the stall guard can close it), and the
  // silence budget reads the run's folders, hooks and child runs from it.
  const ledger = opts.ledger?.runId ? ledgerModule() : null;
  let handle: ReturnType<Ledger["openLedger"]> | null = null;
  try { handle = ledger ? ledger.openLedger(opts.ledger!.dbPath) : null; } catch { handle = null; }
  const runRow = () => { try { return handle && ledger ? ledger.getRun(handle, opts.ledger!.runId) : null; } catch { return null; } };
  const recordWorker = (record: Record<string, unknown> | null) => {
    if (!handle || !ledger) return;
    try { ledger.patchMeta(handle, opts.ledger!.runId, { orca_worker: record }); } catch { /* the ledger never decides the transport */ }
  };

  // 1. The brief, by reference.
  let dir: string;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-orca-")); }
  catch (e) { return fallback("brief", (e as Error)?.message ?? String(e)); }
  const briefFile = path.join(dir, "brief.md");
  fs.writeFileSync(briefFile, briefFileContent(opts), "utf8");

  // 2. One Run per dispatch: its mailbox is ours alone, so a worker_done can
  //    never be consumed by a sibling dispatch waiting on another Run.
  const run = call<any>(["orchestration", "run-create", "--objective", `nirvana · ${label}`], { timeoutMs: 20_000 });
  if (!run.ok) return fallback("run-create", run.error?.code ?? run.error?.message ?? "unknown");
  const runId: string = run.result?.run?.id;
  if (!runId) return fallback("run-create", "no run id in answer");

  // 3. The task: a pointer to the brief, never the brief.
  const spec = `Read the file ${briefFile} and execute every instruction in it. It is your complete brief; the Orca preamble above says how to report worker_done.`;
  const task = call<any>(["orchestration", "task-create", "--run", runId, "--spec", spec, "--task-title", label], { timeoutMs: 20_000 });
  if (!task.ok) return fallback("task-create", task.error?.code ?? task.error?.message ?? "unknown");
  const taskId: string = task.result?.task?.id;
  if (!taskId) return fallback("task-create", "no task id in answer");
  const failTask = () => fire(["orchestration", "task-update", "--run", runId, "--id", taskId, "--status", "failed"]);

  // 4. The worker terminal: operator-started, so the engine owns its lifecycle
  //    and the autonomy flags are ours, not Orca's per-agent defaults. The
  //    workspace is trusted first, so the TUI opens at its prompt.
  const trusted = preTrustWorkspace(opts.runtime, cwd);
  // A confined worker carries its run folder, as the headless child does
  // (driverSpawnSync), so what it dispatches nests inside its run.
  const workerEnv = { ...forwardedEnv(process.env, opts.runtime), ...workerRoleEnv(opts), ...(opts.env ?? {}) };
  if (opts.runtime === "claude-code") {
    // Same environment the headless claude child gets: no background tasks that
    // die with the session, and the configured context ceiling. A value the
    // user set in their own environment is kept.
    const seeded: Record<string, string | undefined> = {
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    };
    for (const [k, v] of Object.entries(headlessClaudeEnv(seeded, { denySubagents: !opts.allowSubagents }))) if (v !== undefined) workerEnv[k] = v;
  }
  if (opts.workspace) workerEnv[RUN_WORKSPACE_ENV] = cwd;
  const command = workerCommand(argv, cwd, workerEnv);
  // The terminal starts in the run folder (cwd); the worktree Orca files it
  // under is the project's, which is the caller's own cwd when the driver
  // moved the worker into its workspace.
  const term = call<any>(["terminal", "create", "--worktree", orcaWorkspaceSelector(opts.hostCwd ?? cwd), "--title", `${label} · ${agent}`, "--command", command], { timeoutMs: 30_000 });
  if (!term.ok) { failTask(); return fallback("terminal-create", term.error?.code ?? term.error?.message ?? "unknown"); }
  const handleId: string = term.result?.terminal?.handle;
  if (!handleId) { failTask(); return fallback("terminal-create", "no terminal handle in answer"); }
  recordWorker({ terminal: handleId, run_id: runId, task_id: taskId, dispatch_id: null, agent, opened_at: new Date(wallStarted).toISOString() });
  let terminalClosed = false;
  const closeTerminal = () => {
    fire(["terminal", "close", "--terminal", handleId]);
    terminalClosed = true;
  };
  // A terminal the engine closes before the worker took its task leaves no
  // trace on the ledger: the run continues as the headless child.
  const abandonTerminal = () => { closeTerminal(); failTask(); recordWorker(null); };

  // 5. The TUI must be at its prompt before the preamble is typed into it —
  //    and "idle" is not "at its prompt": a trust dialog is idle too.
  const ready = call<any>(["terminal", "wait", "--terminal", handleId, "--for", "tui-idle", "--timeout-ms", String(TUI_READY_MS)], { timeoutMs: TUI_READY_MS + 15_000 });
  if (!ready.ok || ready.result?.wait?.satisfied !== true) {
    abandonTerminal();
    return fallback("tui-idle", ready.ok ? "agent did not reach its prompt" : (ready.error?.code ?? ready.error?.message ?? "unknown"));
  }
  const screen = call<any>(["terminal", "read", "--terminal", handleId, "--limit", "80"], { timeoutMs: 20_000 });
  if (screen.ok && screenShowsTrustPrompt(screen.result?.terminal?.tail)) {
    abandonTerminal();
    return fallback("trust-prompt", `the ${agent} TUI asked to trust ${cwd}${trusted.length ? "" : " (no trust record known for this runtime)"}`);
  }

  // 6. Inject.
  const disp = call<any>(["orchestration", "dispatch", "--run", runId, "--task", taskId, "--to", handleId, "--inject"], { timeoutMs: INJECT_MS });
  if (!disp.ok) {
    abandonTerminal();
    return fallback("inject", disp.error?.code ?? disp.error?.message ?? "unknown");
  }
  const dispatchId: string = disp.result?.dispatch?.id ?? "";

  // 6b. Did the worker take it? A TUI can come up after the inject returned
  //     and draw a dialog over the preamble it never read. Read the screen a
  //     few times: a dialog, or a prompt still sitting unsent on a screen that
  //     never moves, sends the run to the headless child. Same brief, and the
  //     headless runner applies the session rules it always applies.
  {
    const windowMs = postInjectWindowMs();
    const reads: string[] = [];
    let dialog: ScreenDialog | null = null;
    for (let waited = 0; ; waited += POST_INJECT_STEP_MS) {
      const r = call<any>(["terminal", "read", "--terminal", handleId, "--limit", "80"], { timeoutMs: 20_000 });
      if (r.ok) {
        const tail = r.result?.terminal?.tail;
        dialog = screenDialog(tail);
        if (dialog) break;
        reads.push(screenText(tail));
      }
      if (waited + POST_INJECT_STEP_MS > windowMs) break;
      sleep(POST_INJECT_STEP_MS);
    }
    const lastLines = (reads[reads.length - 1] ?? "").trim().split("\n").slice(-6).join("\n");
    const unsent = !dialog && reads.length >= 2 && reads.every((t) => t === reads[0]) && lastLines.includes(briefFile);
    if (dialog || unsent) {
      abandonTerminal();
      return fallback(dialog ?? "prompt-not-accepted", dialog
        ? `the ${agent} TUI showed a ${dialog.replace("-", " ")} after the task was injected; the run continues as the headless child`
        : `the ${agent} TUI left the task unsent on a screen that did not move for ${Math.round(windowMs / 1000)}s; the run continues as the headless child`,
        { after_inject: true, dispatch_id: dispatchId || null, terminal_handle: handleId });
    }
  }
  // From here on the worker owns the brief and this function returns a result, never null.
  recordWorker({ terminal: handleId, run_id: runId, task_id: taskId, dispatch_id: dispatchId || null, agent, opened_at: new Date(wallStarted).toISOString() });
  emit("x_orca_worker_started", { run_id: runId, task_id: taskId, dispatch_id: dispatchId, terminal_handle: handleId, agent, runtime: opts.runtime, label, brief_file: briefFile, trust_recorded_in: trusted }, cwd);

  // 7. Wait for worker_done, answering questions on the way, within the
  //    silence budget.
  const guard = stallGuardModule();
  const thresholds = hooks.stallThresholds ?? guard?.resolveStallThresholds() ?? { silenceMs: 0, noStartMs: 0 };
  const injectedAt = now();
  let lastSignAt = injectedAt;
  let everActive = false;
  /** Every sign of life since the inject the engine can see from here. */
  const noteSign = (at: number) => {
    if (!(at > lastSignAt) || at > now() + 60_000) return;
    lastSignAt = at;
    everActive = true;
  };
  const lookWide = () => {
    if (!guard) return;
    const row = runRow();
    const t = now();
    const wide = guard.latestWideActivity(handle, row, guard.runFolders(row, [cwd]), t, Math.max(t - lastSignAt, 1_000));
    if (wide) noteSign(wide.at);
  };
  /** ms left before the silence budget runs out (Infinity when it is off). */
  const budgetLeft = () => {
    const t = now();
    const left: number[] = [];
    if (thresholds.silenceMs > 0) left.push(lastSignAt + thresholds.silenceMs - t);
    if (!everActive && thresholds.noStartMs > 0) left.push(injectedAt + thresholds.noStartMs - t);
    return left.length ? Math.min(...left) : Number.POSITIVE_INFINITY;
  };

  const warnings: string[] = [`orca: worker terminal ${handleId} (dispatch ${dispatchId || "?"})`];
  let outcome: "succeeded" | "failed" | null = null;
  let body = "";
  let subject = "";
  let reportPath: string | null = null;
  let filesModified: string[] = [];
  let error: string | undefined;
  let pendingAck: string | null = null;
  let timedOut = false;
  let stalled: Record<string, any> | null = null;
  const sidecarStall = () => {
    const row = runRow();
    return guard && row ? guard.confirmedStallOf(row, wallStarted - 1_000) as Record<string, any> | null : null;
  };
  const stallNow = (): boolean => {
    lookWide();
    if (budgetLeft() > 0) return false;
    const verdict = guard?.stallVerdict({ startedAt: injectedAt, lastActivityAt: lastSignAt, everActive, now: now(), thresholds });
    if (!verdict) return false;
    const signals = { orca_dispatch: dispatchId || null, orca_terminal: handleId, last_sign_at: new Date(lastSignAt).toISOString(), ever_active: everActive };
    const confirmed = handle && guard ? guard.confirmStall(handle, opts.ledger!.runId, verdict, { decidedBy: "orca-wait", signals }) : null;
    const recorded: Record<string, any> | null = confirmed ? guard!.confirmedStallOf(confirmed) as Record<string, any> | null : null;
    stalled = recorded ?? { confirmed_at: new Date().toISOString(), ...verdict, decided_by: "orca-wait", worker_pid: null, runtime: opts.runtime, signals };
    error = `stalled: ${guard!.stallReason(verdict)}`; outcome = "failed";
    return true;
  };
  for (;;) {
    const untilDeadline = deadline === null ? Number.POSITIVE_INFINITY : deadline - now();
    if (untilDeadline <= 0) { error = `orca worker did not report within ${Math.round((opts.timeoutMs ?? 0) / 60_000)} min`; outcome = "failed"; timedOut = true; break; }
    if (budgetLeft() <= 0 && stallNow()) break;
    const remaining = Math.max(1_000, Math.min(WAIT_WINDOW_MS, untilDeadline, budgetLeft()));
    const args = ["orchestration", "check", "--run", runId, "--wait", "--types", "worker_done,escalation,question", "--timeout-ms", String(remaining)];
    if (pendingAck) args.push("--ack", pendingAck);
    const batch = call<any>(args, { timeoutMs: remaining + 30_000 });
    pendingAck = null;
    if (!batch.ok) {
      // The stall guard ended the wait (it ends the `check` the dispatcher is
      // blocked on), or the app went away, or the Run with it: the worker may
      // still be typing, but nothing can carry its report back. Fail honestly.
      const s = sidecarStall();
      if (s) { stalled = s; error = `stalled: ${guard!.stallReason(s as never)}`; outcome = "failed"; break; }
      error = `orca check failed: ${batch.error?.code ?? batch.error?.message ?? "unknown"}`; outcome = "failed"; break;
    }
    const messages: Message[] = Array.isArray(batch.result?.messages) ? batch.result.messages : [];
    pendingAck = batch.result?.deliveryId ?? null;
    if (messages.length) noteSign(now());
    for (const m of messages) {
      const payload = parsePayload(m);
      if (m.type === "question") {
        fire(["orchestration", "reply", "--id", m.id, "--body", ASK_REPLY]);
        warnings.push(`orca: worker asked "${(m.body ?? m.subject ?? "").replace(/\s+/g, " ").slice(0, 120)}" — answered with the defaults policy`);
        continue;
      }
      if (m.type === "escalation") {
        warnings.push(`orca: worker escalated: ${(m.subject ?? "").slice(0, 120)}`);
        continue;
      }
      if (m.type === "worker_done" && (!dispatchId || payload.dispatchId === dispatchId || payload.taskId === taskId)) {
        outcome = payload.outcome === "succeeded" ? "succeeded" : "failed";
        body = m.body ?? "";
        subject = m.subject ?? "";
        reportPath = typeof payload.reportPath === "string" ? payload.reportPath : null;
        filesModified = Array.isArray(payload.filesModified) ? payload.filesModified.map(String) : [];
      }
    }
    if (outcome) { if (pendingAck) fire(["orchestration", "check", "--run", runId, "--ack", pendingAck]); break; }
    if (messages.length === 0) {
      // A quiet window is a checkpoint, not a failure — unless the terminal is
      // gone, or nothing at all has moved for the silence budget.
      const show = call<any>(["orchestration", "worker-show", "--dispatch", dispatchId], { timeoutMs: 20_000 });
      const status = show.result?.dispatch?.status;
      const connected = show.result?.terminal?.connected;
      if (show.ok && (status === "failed" || connected === false)) {
        error = status === "failed" ? "orca marked the dispatch failed" : "worker terminal is gone"; outcome = "failed"; break;
      }
      // Orca's own record of the worker checking in.
      const beat = show.result?.dispatch?.lastHeartbeatAt ?? show.result?.dispatch?.last_heartbeat_at ?? show.result?.worker?.lastHeartbeatAt ?? null;
      const beatMs = typeof beat === "number" ? beat : typeof beat === "string" ? Date.parse(beat) : NaN;
      if (Number.isFinite(beatMs)) noteSign(beatMs);
      const s = sidecarStall();
      if (s) { stalled = s; error = `stalled: ${guard!.stallReason(s as never)}`; outcome = "failed"; break; }
    }
  }

  // 8. The transcript, archived beside the brief so the receipt can cite it.
  let transcriptFile: string | null = null;
  if (dispatchId) {
    const read = call<any>(["orchestration", "worker-read", "--dispatch", dispatchId, "--limit", "500"], { timeoutMs: 30_000 });
    if (read.ok && read.result) {
      transcriptFile = path.join(dir, "transcript.json");
      try { fs.writeFileSync(transcriptFile, JSON.stringify(read.result, null, 2), "utf8"); warnings.push(`orca: transcript at ${transcriptFile}`); }
      catch { transcriptFile = null; }
    }
  }
  const durationMs = now() - started;
  const ok = outcome === "succeeded";
  // The worker's session: the one it continued, the id it was started with,
  // or the one its CLI filed for this folder since it started.
  const sessionId = workerSessionId(opts.runtime, session, cwd, wallStarted, hooks);
  const cost = opts.runtime === "claude-code" && sessionId ? claudeWorkerCost(sessionId, wallStarted, hooks) : null;
  emit("x_orca_worker_done", { run_id: runId, task_id: taskId, dispatch_id: dispatchId, outcome, duration_ms: durationMs, files_modified: filesModified, report_path: reportPath, transcript: transcriptFile, session_id: sessionId, error: error ?? null, stalled: stalled ? true : undefined }, cwd);

  // 9. A finished worker's tab is closed; a failed one stays for inspection.
  // A worker that timed out or stalled is closed whatever else is set: left
  // open, the agent keeps running and spending after the engine has given up
  // on it. The transcript was archived above, so nothing is lost by closing.
  if (timedOut || stalled) {
    closeTerminal(); failTask();
    warnings.push(`orca: terminal ${handleId} closed after the ${stalled ? "stall" : "timeout"} (transcript kept)`);
  } else if (process.env.NIRVANA_ORCA_KEEP_WORKERS === "1" || !ok) {
    warnings.push(`orca: terminal ${handleId} left open${ok ? " (NIRVANA_ORCA_KEEP_WORKERS=1)" : " for inspection"}`);
  } else {
    closeTerminal();
  }
  if (terminalClosed && handle && ledger) {
    try { ledger.patchMeta(handle, opts.ledger!.runId, { orca_worker: { ...(runRow()?.meta?.orca_worker as object ?? {}), closed_at: new Date().toISOString() } }); } catch { /* bookkeeping only */ }
  }

  const result = [subject && `${subject}`, body, reportPath && `Report: ${reportPath}`].filter(Boolean).join("\n");
  return {
    ok, runtime: opts.runtime, sessionId, result, costUsd: cost?.costUsd ?? null, costUnavailable: true,
    ...(cost?.costUsd != null ? { costEstimated: true } : {}),
    ...(cost?.usage ? { usage: cost.usage } : {}),
    ...(cost?.model ? { model: cost.model } : {}),
    exitCode: ok ? 0 : 1, stderr: "", durationMs, warnings,
    ...(stalled ? { stalled: stalled as NonNullable<RunHeadlessResult["stalled"]> } : {}),
    ...(ok ? {} : { error: error ?? (body ? `worker reported failure: ${body.slice(0, 300)}` : "worker reported failure") }),
  };
}
