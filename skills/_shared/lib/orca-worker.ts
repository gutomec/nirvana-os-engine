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
import type { RunHeadlessOpts, RunHeadlessResult, Runtime } from "./host-agent-driver.ts";
import { orcaJson, orcaFire, orcaWorkersActive, orcaWorkspaceSelector } from "./orca.ts";
import { resolveSystemModel } from "./system-model.ts";
import { codexConfigPath } from "./codex-hooks.ts";

/** Nirvana runtime → the agent id Orca recognizes in a terminal (the identity
 *  its hooks report, and what `dispatch --inject` needs to deliver a preamble).
 *  A runtime absent here has no Orca agent id and keeps the headless child. */
export const ORCA_AGENT_ID: Partial<Record<Runtime, string>> = {
  "claude-code": "claude",
  codex: "codex",
  "gemini-cli": "gemini",
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
 *  Codex ("Do you trust the files in this folder?"), Gemini ("Do you trust
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
 *   gemini-cli / qwen-code  ~/.gemini/trustedFolders.json  { "<cwd>": "TRUST_FOLDER" }
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
    } else if (runtime === "gemini-cli" || runtime === "qwen-code") {
      const file = path.join(home, runtime === "qwen-code" ? ".qwen" : ".gemini", "trustedFolders.json");
      const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      let changed = false;
      for (const d of dirs) if (doc[d] !== "TRUST_FOLDER") { doc[d] = "TRUST_FOLDER"; changed = true; }
      if (changed) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(doc, null, 2), "utf8"); written.push(file); }
    }
  } catch { /* best-effort: the screen check decides */ }
  return written;
}

/** True when the terminal's screen shows a workspace trust dialog. */
export function screenShowsTrustPrompt(lines: unknown): boolean {
  const text = Array.isArray(lines) ? lines.map(String).join("\n") : typeof lines === "string" ? lines : "";
  return TRUST_PROMPT.test(text);
}

/** The reply the engine gives a worker that asks: the zero-human doctrine,
 *  stated once. */
const ASK_REPLY = "Decide with professional defaults, record the assumption under a 'Premissas assumidas' (assumptions) section of the main deliverable, and continue. No human is in this loop.";

export interface OrcaWorkerHooks {
  /** Test seam: canned `orca … --json` answers. */
  orcaJsonImpl?: typeof orcaJson;
  orcaFireImpl?: typeof orcaFire;
  activeImpl?: () => boolean;
  now?: () => number;
}

/**
 * The interactive command for a runtime, as argv. Autonomy flags match the
 * headless runners' (audited against the installed CLIs on 2026-09-09:
 * `claude --dangerously-skip-permissions`, `codex
 * --dangerously-bypass-approvals-and-sandbox`, `gemini --approval-mode yolo`,
 * `agy --dangerously-skip-permissions`, `grok --always-approve`); `--safe`
 * (yolo false) drops them, and claude takes `--permission-mode acceptEdits`
 * like its headless twin. Null for a runtime Orca has no agent id for.
 */
export function interactiveArgv(opts: Pick<RunHeadlessOpts, "runtime" | "yolo" | "model" | "addDirs">): string[] | null {
  if (!ORCA_AGENT_ID[opts.runtime]) return null;
  const yolo = opts.yolo !== false;
  let model: string | null = opts.model ?? null;
  if (!model) { try { model = resolveSystemModel(opts.runtime) ?? null; } catch { model = null; } }
  const dirs = opts.addDirs ?? [];
  switch (opts.runtime) {
    case "claude-code": {
      const a = ["claude", ...(yolo ? ["--dangerously-skip-permissions"] : ["--permission-mode", "acceptEdits"])];
      if (model) a.push("--model", model);
      for (const d of dirs) a.push("--add-dir", d);
      return a;
    }
    case "codex": {
      const a = ["codex", ...(yolo ? ["--dangerously-bypass-approvals-and-sandbox"] : [])];
      if (model) a.push("-m", model);
      for (const d of dirs) a.push("--add-dir", d);
      return a;
    }
    case "gemini-cli":
      return ["gemini", "--approval-mode", yolo ? "yolo" : "auto_edit", ...(model ? ["-m", model] : [])];
    case "antigravity-cli":
      return ["agy", ...(yolo ? ["--dangerously-skip-permissions"] : []), ...(model ? ["--model", model] : [])];
    case "grok-cli":
      return ["grok", ...(yolo ? ["--always-approve"] : []), ...(model ? ["-m", model] : [])];
    case "kimi-cli":
      return ["kimi", ...(model ? ["-m", model] : [])];
    case "pi":
      return ["pi", ...(model ? ["--model", model] : [])];
    case "opencode":
      return ["opencode"];
    default:
      return null;
  }
}

/** The variables a worker must inherit for its `nrv` calls to land in the same
 *  project and trace as the coordinator: every NIRVANA_* plus the log roots.
 *  Orca's own pane variables are the terminal's, not ours to forward. */
export function forwardedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/^NIRVANA_/.test(k) || k === "HARNESS_LOGS_DIR" || k === "MAESTRO_LOGS_DIR") out[k] = v;
  }
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
 * RunHeadlessResult once a task was injected, whatever the outcome.
 */
export function runOrcaWorker(opts: RunHeadlessOpts, hooks: OrcaWorkerHooks = {}): RunHeadlessResult | null {
  const active = hooks.activeImpl ?? orcaWorkersActive;
  if (!active()) return null;
  const argv = interactiveArgv(opts);
  if (!argv) return null;
  const call = hooks.orcaJsonImpl ?? orcaJson;
  const fire = hooks.orcaFireImpl ?? orcaFire;
  const now = hooks.now ?? Date.now;
  const started = now();
  const deadline = typeof opts.timeoutMs === "number" ? started + opts.timeoutMs : null;
  const label = (opts.label ?? `${opts.runtime} worker`).slice(0, 80);
  const agent = ORCA_AGENT_ID[opts.runtime]!;
  const cwd = opts.cwd;
  const fallback = (stage: string, reason: string): null => {
    emit("x_orca_transport_fallback", { stage, reason, runtime: opts.runtime, label }, cwd);
    return null;
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
  const command = workerCommand(argv, cwd, forwardedEnv());
  const term = call<any>(["terminal", "create", "--worktree", orcaWorkspaceSelector(cwd), "--title", `${label} · ${agent}`, "--command", command], { timeoutMs: 30_000 });
  if (!term.ok) { failTask(); return fallback("terminal-create", term.error?.code ?? term.error?.message ?? "unknown"); }
  const handle: string = term.result?.terminal?.handle;
  if (!handle) { failTask(); return fallback("terminal-create", "no terminal handle in answer"); }
  const closeTerminal = () => fire(["terminal", "close", "--terminal", handle]);

  // 5. The TUI must be at its prompt before the preamble is typed into it —
  //    and "idle" is not "at its prompt": a trust dialog is idle too.
  const ready = call<any>(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", String(TUI_READY_MS)], { timeoutMs: TUI_READY_MS + 15_000 });
  if (!ready.ok || ready.result?.wait?.satisfied !== true) {
    closeTerminal(); failTask();
    return fallback("tui-idle", ready.ok ? "agent did not reach its prompt" : (ready.error?.code ?? ready.error?.message ?? "unknown"));
  }
  const screen = call<any>(["terminal", "read", "--terminal", handle, "--limit", "80"], { timeoutMs: 20_000 });
  if (screen.ok && screenShowsTrustPrompt(screen.result?.terminal?.tail)) {
    closeTerminal(); failTask();
    return fallback("trust-prompt", `the ${agent} TUI asked to trust ${cwd}${trusted.length ? "" : " (no trust record known for this runtime)"}`);
  }

  // 6. Inject. From here on the worker owns the brief and this function
  //    returns a result, never null.
  const disp = call<any>(["orchestration", "dispatch", "--run", runId, "--task", taskId, "--to", handle, "--inject"], { timeoutMs: INJECT_MS });
  if (!disp.ok) {
    closeTerminal(); failTask();
    return fallback("inject", disp.error?.code ?? disp.error?.message ?? "unknown");
  }
  const dispatchId: string = disp.result?.dispatch?.id ?? "";
  emit("x_orca_worker_started", { run_id: runId, task_id: taskId, dispatch_id: dispatchId, terminal_handle: handle, agent, runtime: opts.runtime, label, brief_file: briefFile, trust_recorded_in: trusted }, cwd);

  // 7. Wait for worker_done, answering questions on the way.
  const warnings: string[] = [`orca: worker terminal ${handle} (dispatch ${dispatchId || "?"})`];
  let outcome: "succeeded" | "failed" | null = null;
  let body = "";
  let subject = "";
  let reportPath: string | null = null;
  let filesModified: string[] = [];
  let error: string | undefined;
  let pendingAck: string | null = null;
  for (;;) {
    const remaining = deadline === null ? WAIT_WINDOW_MS : Math.min(WAIT_WINDOW_MS, deadline - now());
    if (remaining <= 0) { error = `orca worker did not report within ${Math.round((opts.timeoutMs ?? 0) / 60_000)} min`; outcome = "failed"; break; }
    const args = ["orchestration", "check", "--run", runId, "--wait", "--types", "worker_done,escalation,question", "--timeout-ms", String(remaining)];
    if (pendingAck) args.push("--ack", pendingAck);
    const batch = call<any>(args, { timeoutMs: remaining + 30_000 });
    pendingAck = null;
    if (!batch.ok) {
      // The app went away, or the Run with it: the worker may still be typing,
      // but nothing can carry its report back. Fail honestly.
      error = `orca check failed: ${batch.error?.code ?? batch.error?.message ?? "unknown"}`; outcome = "failed"; break;
    }
    const messages: Message[] = Array.isArray(batch.result?.messages) ? batch.result.messages : [];
    pendingAck = batch.result?.deliveryId ?? null;
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
      // A quiet window is a checkpoint, not a failure — unless the terminal is gone.
      const show = call<any>(["orchestration", "worker-show", "--dispatch", dispatchId], { timeoutMs: 20_000 });
      const status = show.result?.dispatch?.status;
      const connected = show.result?.terminal?.connected;
      if (show.ok && (status === "failed" || connected === false)) {
        error = status === "failed" ? "orca marked the dispatch failed" : "worker terminal is gone"; outcome = "failed"; break;
      }
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
  emit("x_orca_worker_done", { run_id: runId, task_id: taskId, dispatch_id: dispatchId, outcome, duration_ms: durationMs, files_modified: filesModified, report_path: reportPath, transcript: transcriptFile, error: error ?? null }, cwd);

  // 9. A finished worker's tab is closed; a failed one stays for inspection.
  const keep = process.env.NIRVANA_ORCA_KEEP_WORKERS === "1" || !ok;
  if (keep) warnings.push(`orca: terminal ${handle} left open${ok ? " (NIRVANA_ORCA_KEEP_WORKERS=1)" : " for inspection"}`);
  else closeTerminal();

  const result = [subject && `${subject}`, body, reportPath && `Report: ${reportPath}`].filter(Boolean).join("\n");
  return {
    ok, runtime: opts.runtime, sessionId: null, result, costUsd: null, costUnavailable: true,
    exitCode: ok ? 0 : 1, stderr: "", durationMs, warnings,
    ...(ok ? {} : { error: error ?? (body ? `worker reported failure: ${body.slice(0, 300)}` : "worker reported failure") }),
  };
}
