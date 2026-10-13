/**
 * activate-recovery.ts — what `nrv activate` does AFTER its install pass,
 * chosen by who is running it.
 *
 * The install pass never changes here. Before this, a failed activation ended
 * with the activator's JSON and an exit code, and the reader had to dig the
 * cause and the fix out of it. Most readers are agents (the user talks to
 * Claude Code, Codex, agy…, and the agent runs `nrv`); some are people at a
 * terminal; some are cron jobs and CI. Each gets what it can act on:
 *
 *   agent       a delimited block with one entry per failure: squad, kind,
 *               name, the useful lines of the error, the exact command to fix
 *               or retry, and whether the fix needs the user's permission.
 *               `--json` carries the same data. Never a prompt.
 *   automation  the same as an agent. Never a prompt.
 *   human       a plain summary, then an offer to hand the failures to an
 *               installed agent runtime (headless, scoped to exactly these
 *               failures), followed by a re-check of those squads.
 *
 * Unsure means agent/automation: a prompt nobody can answer hangs a run, a
 * block nobody needed costs a few lines.
 *
 * Everything with a side effect (asking, dispatching, re-checking, probing
 * PATH) is injected, so the flow is tested without a terminal or a model.
 */
import * as path from "node:path";
import type { Runtime } from "../../_shared/lib/host-agent-driver.ts";

export type Caller = "agent" | "human" | "automation";

export interface CallerInfo {
  caller: Caller;
  /** The runtime hosting this session, when one was identified. */
  sessionRuntime: Runtime | null;
}

/**
 * Who runs this command. An agent is identified by the session markers the
 * engine already reads for routing (runtime-rules.ts); a human needs BOTH
 * stdin and stdout on a terminal, no agent marker and no CI flag; anything
 * else is automation. `sessionHost` is the engine's own resolver, passed in so
 * this file holds no second list of markers.
 */
export function detectCaller(input: {
  env: NodeJS.ProcessEnv;
  stdinTTY: boolean | undefined;
  stdoutTTY: boolean | undefined;
  sessionHost: (env: NodeJS.ProcessEnv) => Runtime | null;
}): CallerInfo {
  let sessionRuntime: Runtime | null = null;
  try { sessionRuntime = input.sessionHost(input.env); } catch { sessionRuntime = null; }
  if (sessionRuntime) return { caller: "agent", sessionRuntime };
  // A dispatched child carries the depth counter even when no vendor marker
  // reached it: it is an agent whatever its terminal looks like.
  if (input.env.NIRVANA_DISPATCH_DEPTH) return { caller: "agent", sessionRuntime: null };
  const ci = (input.env.CI ?? "").trim().toLowerCase();
  if (ci && ci !== "0" && ci !== "false") return { caller: "automation", sessionRuntime: null };
  if (input.stdinTTY === true && input.stdoutTTY === true) return { caller: "human", sessionRuntime: null };
  return { caller: "automation", sessionRuntime: null };
}

/** `--fix-with-agent` → true (pick one), `--fix-with-agent=<rt>` → "<rt>", absent → null. */
export function parseFixWithAgent(flags: string[]): string | true | null {
  for (const f of flags) {
    if (f === "--fix-with-agent") return true;
    if (f.startsWith("--fix-with-agent=")) {
      const v = f.slice("--fix-with-agent=".length).trim();
      return v ? v : true;
    }
  }
  return null;
}

// ── what failed ─────────────────────────────────────────────────────────────

export type Severity = "failure" | "confirmation" | "warning";

export interface ActivationIssue {
  squad: string;
  severity: Severity;
  /** system | python | node | subapp | service | custom_node | model | env_var | mcp | post_install | admission | squad | activation */
  kind: string;
  name: string;
  status: string;
  /** The useful lines of the error, never the whole log. */
  error: string;
  /** The exact command that fixes it, when it is known. */
  fix: string | null;
  /** Re-runs the deterministic check for this squad after the fix. */
  retry: string;
  needs_permission: boolean;
  permission_reason: string | null;
  /** False when only the user can resolve it (a secret, a consent, the squad's own source). */
  agent_fixable: boolean;
}

export interface SquadOutcome {
  slug: string;
  dir: string | null;
  exitCode: number;
  /** The activator's JSON result, when it printed one. */
  result: Record<string, any> | null;
  /** Lines the admission gate printed when it refused the squad. */
  gateLines?: string[];
  /** Captured stderr, for the cases with no JSON to read. */
  stderr?: string;
}

/**
 * The activator prints its result as indented JSON at the end of stdout,
 * possibly after install logs (--verbose). The last block that parses wins.
 */
export function parseActivatorJson(stdout: string): Record<string, any> | null {
  const text = stdout || "";
  const starts: number[] = [];
  if (text.startsWith("{")) starts.push(0);
  for (let i = text.indexOf("\n{"); i >= 0; i = text.indexOf("\n{", i + 1)) starts.push(i + 1);
  for (let k = starts.length - 1; k >= 0; k--) {
    const tail = text.slice(starts[k]);
    const end = tail.lastIndexOf("}");
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(tail.slice(0, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* try an earlier start */ }
  }
  return null;
}

/** The first line (the cause, usually) plus the last lines (the verdict), short. */
export function trimError(raw: unknown, maxLines = 4, maxChars = 300): string {
  const lines = String(raw ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const picked = lines.length <= maxLines ? lines : [lines[0], ...lines.slice(-(maxLines - 1))];
  return [...new Set(picked)].map((l) => (l.length > maxChars ? `${l.slice(0, maxChars - 1)}…` : l)).join("\n");
}

/** Quotes a token for a copy-paste command line; `"` works in sh, PowerShell and cmd. */
export function shellToken(t: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(t) ? t : `"${t.replace(/"/g, '\\"')}"`;
}

const PACKAGE_MANAGER = /(^|[\s;&|(])(sudo|doas|brew|port|winget|choco|scoop|apt|apt-get|dnf|yum|pacman|zypper|apk|snap)(\s|$)/;

/** Why a command needs the user's say-so, or null when it does not. */
export function permissionReason(cmd: string | null): string | null {
  if (!cmd) return null;
  const m = PACKAGE_MANAGER.exec(cmd);
  if (!m) return null;
  return m[2] === "sudo" || m[2] === "doas"
    ? "runs as root (sudo): the user must approve it and type the password"
    : `installs a system package with ${m[2]}: ask the user first`;
}

export interface FixEnv {
  platform: NodeJS.Platform;
  /** Path of a program on PATH, or null. */
  which: (cli: string) => string | null;
}

/** The command that installs a bare system tool, per platform; null when no manager is known. */
export function systemInstallCommand(tool: string, env: FixEnv): string | null {
  const t = shellToken(tool);
  if (env.platform === "darwin") return env.which("brew") ? `brew install ${t}` : null;
  if (env.platform === "win32") return env.which("winget") ? `winget install ${t}` : null;
  if (env.which("apt-get")) return `sudo apt-get install -y ${t}`;
  if (env.which("dnf")) return `sudo dnf install -y ${t}`;
  if (env.which("pacman")) return `sudo pacman -S --noconfirm ${t}`;
  if (env.which("apk")) return `sudo apk add ${t}`;
  return null;
}

function venvPython(venv: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
}

/** Items of these steps carry no `kind` of their own. */
const STEP_KIND: Record<string, string> = { env_vars: "env_var", mcps: "mcp", post_install: "post_install" };

/** One activator item (a failure, confirmation or warning) as an issue. */
export function issueFromItem(squad: string, severity: Severity, item: Record<string, any>, env: FixEnv): ActivationIssue {
  const retry = `nrv activate ${squad}`;
  const kind = String(item.kind || STEP_KIND[item.step] || item.step || "unknown");
  const name = String(item.name ?? item.dir ?? (Array.isArray(item.packages) ? item.packages.join(" ") : item.cmd ?? ""));
  const status = String(item.status || "");
  const base = { squad, severity, kind, name, status, retry };
  const errorText = trimError(item.error || item.reason || item.note || item.hint || item.description || status);
  const make = (fix: string | null, opts: { agent?: boolean; reason?: string | null } = {}): ActivationIssue => {
    const reason = opts.reason !== undefined ? opts.reason : permissionReason(fix);
    return { ...base, error: errorText, fix, needs_permission: !!reason, permission_reason: reason, agent_fixable: opts.agent ?? true };
  };

  if (severity === "confirmation") {
    const cmd = item.cmd ? String(item.cmd) : null;
    const why = item.needs_sudo ? "runs as root (sudo)" : item.fetches ? `downloads and executes ${item.fetches}` : "a large download";
    return make(`nrv activate ${squad} --confirm-heavy`, {
      agent: false,
      reason: `${why}: the user must accept it${cmd ? ` (${cmd})` : ""}`,
    });
  }
  if (kind === "env_var") {
    return { ...base, kind: "env_var", error: trimError(item.description || `${name} is not set`), fix: null,
      needs_permission: true, permission_reason: `the user must supply ${name} (environment or the project's .env)`, agent_fixable: false };
  }
  if (status === "host_missing") {
    return make(null, { agent: false, reason: "configure this MCP server in the runtime that runs the squad (it may need the user's credentials)" });
  }
  switch (kind) {
    case "system": {
      if (status === "missing_system_tool") return make(systemInstallCommand(name, env));
      return make(item.cmd ? String(item.cmd) : null);
    }
    case "python": {
      if (status === "python_unavailable") {
        const fix = env.platform === "darwin" && env.which("brew") ? "brew install uv"
          : env.platform === "win32" && env.which("winget") ? "winget install astral-sh.uv" : null;
        return make(fix);
      }
      const tokens: string[] = Array.isArray(item.packages) ? item.packages.map(String) : [];
      const py = item.python ? String(item.python) : item.venv ? venvPython(String(item.venv), env.platform) : null;
      if (!py || tokens.length === 0) return make(null);
      const spec = tokens.map(shellToken).join(" ");
      return make(env.which("uv") ? `uv pip install --python ${shellToken(py)} ${spec}` : `${shellToken(py)} -m pip install ${spec}`);
    }
    case "node": {
      const tokens: string[] = Array.isArray(item.packages) ? item.packages.map(String) : [];
      if (item.global) return make(tokens.length ? `npm install -g ${tokens.map(shellToken).join(" ")}` : null);
      return make(item.env ? `bun install --cwd ${shellToken(String(item.env))}` : null);
    }
    case "subapp":
      return make(item.env ? `bun install --cwd ${shellToken(String(item.env))}` : null);
    case "post_install":
      return { ...make(item.cmd ? String(item.cmd) : null), name: String(item.cmd || name) };
    default:
      return make(null);
  }
}

/** Every issue one squad's activation produced, in the activator's own order. */
export function issuesFromOutcome(o: SquadOutcome, env: FixEnv): ActivationIssue[] {
  const retry = `nrv activate ${o.slug}`;
  if (o.gateLines && o.gateLines.length) {
    return [{ squad: o.slug, severity: "failure", kind: "admission", name: o.slug, status: "refused_by_gate",
      error: trimError(o.gateLines.join("\n")), fix: `nrv validate squad ${o.slug}`, retry,
      needs_permission: false, permission_reason: null, agent_fixable: false }];
  }
  if (o.exitCode === 4 && (!o.result || o.result.error)) {
    return [{ squad: o.slug, severity: "failure", kind: "squad", name: o.slug, status: "not_found",
      error: trimError(o.result?.error || o.stderr || "squad not found in scope"), fix: "nrv list-squads", retry,
      needs_permission: false, permission_reason: null, agent_fixable: false }];
  }
  const r = o.result;
  if (!r) {
    if (o.exitCode === 0) return [];
    return [{ squad: o.slug, severity: "failure", kind: "activation", name: o.slug, status: `exit_${o.exitCode}`,
      error: trimError(o.stderr || "the activator printed no result"), fix: `nrv activate ${o.slug} --verbose`, retry,
      needs_permission: false, permission_reason: null, agent_fixable: true }];
  }
  const out: ActivationIssue[] = [];
  for (const f of r.failures || []) out.push(issueFromItem(o.slug, "failure", f, env));
  for (const c of r.confirmations_required || []) out.push(issueFromItem(o.slug, "confirmation", c, env));
  for (const w of r.warnings || []) {
    // Optional variables and MCPs the squad can live without are noise here.
    if (w.status === "host_missing" && !w.required) continue;
    out.push(issueFromItem(o.slug, "warning", w, env));
  }
  return out;
}

// ── what the reader sees ────────────────────────────────────────────────────

export const BLOCK_BEGIN = "=== nrv activate: issues for the agent ===";
export const BLOCK_END = "=== end of nrv activate issues ===";

/** The block an agent acts on. Plain text, stable markers, one entry per issue. */
export function renderAgentBlock(issues: ActivationIssue[]): string {
  const lines = [BLOCK_BEGIN, `${issues.length} issue(s). Fix only these; ask the user before any step marked "permission".`];
  issues.forEach((it, i) => {
    lines.push("", `[${i + 1}] squad: ${it.squad}`);
    lines.push(`    ${it.severity} · ${it.kind}: ${it.name} (${it.status})`);
    const err = it.error.split("\n");
    lines.push(`    error: ${err[0]}`, ...err.slice(1).map((l) => `           ${l}`));
    if (it.fix) lines.push(`    fix: ${it.fix}`);
    lines.push(`    then: ${it.retry}`);
    if (it.needs_permission) lines.push(`    permission: ${it.permission_reason}`);
  });
  lines.push("", "Same data as JSON: nrv activate … --json", BLOCK_END);
  return lines.join("\n");
}

/** What a person at a terminal reads: what broke, in words, and what to type. */
export function renderHumanSummary(issues: ActivationIssue[]): string {
  const bySquad = new Map<string, ActivationIssue[]>();
  for (const it of issues) bySquad.set(it.squad, [...(bySquad.get(it.squad) ?? []), it]);
  const lines = [`Some dependencies are not ready (${issues.length} issue(s) in ${bySquad.size} squad(s)):`];
  for (const [squad, list] of bySquad) {
    lines.push(`  ${squad}`);
    for (const it of list) {
      const what = it.severity === "confirmation" ? "needs your OK" : it.severity === "warning" ? "missing" : "failed";
      lines.push(`    - ${it.kind} ${it.name}: ${what}. ${it.error.split("\n")[0]}`);
      if (it.fix) lines.push(`      to fix: ${it.fix}${it.needs_permission ? "   (needs your permission)" : ""}`);
      else if (it.permission_reason) lines.push(`      ${it.permission_reason}`);
    }
  }
  return lines.join("\n");
}

/** The instructions a person follows alone: the fixes, then the retries. */
export function renderInstructions(issues: ActivationIssue[]): string {
  const fixes = [...new Set(issues.map((i) => i.fix).filter((f): f is string => !!f))];
  const retries = [...new Set(issues.map((i) => i.retry))];
  const lines = ["To fix by hand:"];
  for (const f of fixes) lines.push(`  ${f}`);
  for (const i of issues.filter((x) => !x.fix && x.permission_reason)) lines.push(`  ${i.squad}: ${i.permission_reason}`);
  lines.push("Then check again:");
  for (const r of retries) lines.push(`  ${r}`);
  return lines.join("\n");
}

/**
 * The prompt for the agent that fixes the failures. Scoped to the listed
 * items, the squad folders are off limits (the fix belongs to the machine and
 * the environments, never the squad's source), and the answer ends with what
 * changed, item by item.
 */
export function buildFixPrompt(issues: ActivationIssue[], ctx: { platform: NodeJS.Platform; squadDirs: string[] }): string {
  const lines = [
    `\`nrv activate\` (Nirvana-OS) could not prepare these squad dependencies on this machine (${ctx.platform}). The user asked you to fix them.`,
    "",
    "Rules:",
    "- Fix ONLY the items listed below. Change nothing else on the machine.",
    "- Do NOT create, edit, move or delete anything inside a squad folder" + (ctx.squadDirs.length ? `: ${ctx.squadDirs.join(", ")}` : "") + ". The fix belongs to the machine (system packages, the squad environments under ~/.nirvana/envs), never to the squad.",
    "- Never use sudo, never type a password, never invent a secret or an API key. When an item needs one of those, skip it and say exactly what the user must do.",
    "- The user's request covers installing with the package managers named in the fixes below (brew, winget, uv, pip, bun, npm).",
    "- Do not run `nrv dispatch`, `nrv run` or any other agent. You may run `nrv activate <squad>` to check your work.",
    "",
    "Items:",
  ];
  issues.forEach((it, i) => {
    lines.push(`${i + 1}. squad ${it.squad} · ${it.kind} ${it.name} (${it.status})`);
    lines.push(`   error: ${it.error.replace(/\n/g, " | ")}`);
    if (it.fix) lines.push(`   suggested fix: ${it.fix}`);
    lines.push(`   check: ${it.retry}`);
    if (it.needs_permission) lines.push(`   note: ${it.permission_reason}`);
  });
  lines.push(
    "",
    "When you are done, end your answer with one line per item:",
    "FIXED|NOT FIXED <n> <squad> <kind> <name>: what you changed (commands run, files touched), or why not.",
  );
  return lines.join("\n");
}

// ── the runtimes ────────────────────────────────────────────────────────────

const RUNTIME_LABEL: Record<Runtime, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "antigravity-cli": "Antigravity",
  "kimi-cli": "Kimi CLI",
  "grok-cli": "Grok CLI",
  pi: "Pi",
  "qwen-code": "Qwen Code",
  opencode: "OpenCode",
};

export function runtimeLabel(r: Runtime): string {
  return RUNTIME_LABEL[r] ?? r;
}

/** "Want an agent to try to fix these? Found: Claude Code, Codex. [1/2/n] " */
export function fixQuestion(runtimes: Runtime[]): string {
  const choices = [...runtimes.map((_, i) => String(i + 1)), "n"].join("/");
  return `Want an agent to try to fix these? Found: ${runtimes.map(runtimeLabel).join(", ")}. [${choices}] `;
}

/** The runtime an answer names: its number, its name or its label; null for no. */
export function parseChoice(answer: string, runtimes: Runtime[]): Runtime | null {
  const a = answer.trim().toLowerCase();
  if (!a || a === "n" || a === "no") return null;
  const n = Number(a);
  if (Number.isInteger(n) && n >= 1 && n <= runtimes.length) return runtimes[n - 1];
  return runtimes.find((r) => r === a || runtimeLabel(r).toLowerCase() === a) ?? null;
}

// ── the flow after the install pass ─────────────────────────────────────────

export interface FixDispatch {
  ok: boolean;
  /** The agent's final answer (what it changed). */
  answer: string;
  error?: string;
}

export interface RecoveryDeps {
  caller: CallerInfo;
  /** `--fix-with-agent[=<rt>]`. */
  fixWith: string | true | null;
  /** Runtimes installed and on PATH, in roster order. */
  available: () => Runtime[];
  /** Canonical runtime for a typed name (`claude` → `claude-code`). */
  canonical: (name: string) => Runtime;
  /** Asks the person at the terminal; only called for a human caller. */
  ask: (question: string) => Promise<string>;
  /** Runs the fixing agent headless and returns its answer. */
  dispatch: (runtime: Runtime, prompt: string) => FixDispatch | Promise<FixDispatch>;
  /** Re-runs the deterministic check for exactly these squads. */
  recheck: (squads: string[]) => Promise<SquadOutcome[]>;
  fixEnv: FixEnv;
  squadDirs: string[];
  /** Human-facing output. */
  print: (text: string) => void;
}

export interface AgentFixReport {
  runtime: Runtime;
  ok: boolean;
  answer: string;
  error: string | null;
  fixed: ActivationIssue[];
  still_failing: ActivationIssue[];
  /** Exit codes of the re-check, per squad. */
  recheck: { slug: string; exit_code: number }[];
}

export interface RecoveryResult {
  /** True when the agent fix ran and the re-check came back clean. */
  resolved: boolean;
  /** Exit code of the re-check, when it ran. */
  recheckExit: number | null;
  agentFix: AgentFixReport | null;
  prompted: boolean;
  /** Why no fix ran, when none did. */
  skipped: string | null;
}

const issueKey = (i: ActivationIssue) => `${i.squad}\u0000${i.kind}\u0000${i.name}\u0000${i.severity}`;

/** The aggregate exit code of a set of outcomes, by the activate contract (1 > 2 > 0). */
export function aggregateExit(outcomes: SquadOutcome[]): number {
  if (outcomes.some((o) => o.exitCode !== 0 && o.exitCode !== 2)) return 1;
  return outcomes.some((o) => o.exitCode === 2) ? 2 : 0;
}

/**
 * Prints what the caller needs and, when asked to (a human's answer or
 * `--fix-with-agent`), runs the agent fix and the re-check. The block and the
 * JSON are the caller's job (activate.ts), so a machine reader gets them in
 * one place whatever happens here.
 */
export async function recover(issues: ActivationIssue[], deps: RecoveryDeps): Promise<RecoveryResult> {
  const none: RecoveryResult = { resolved: false, recheckExit: null, agentFix: null, prompted: false, skipped: null };
  if (issues.length === 0) return { ...none, skipped: "nothing to fix" };
  const fixable = issues.filter((i) => i.agent_fixable);
  const human = deps.caller.caller === "human";
  if (human) {
    deps.print(renderHumanSummary(issues));
  }
  if (fixable.length === 0) {
    if (human) deps.print(renderInstructions(issues));
    return { ...none, skipped: "no issue an agent can fix: each needs the user (a secret, a consent or the squad's own source)" };
  }

  const available = deps.available();
  let runtime: Runtime | null = null;
  let prompted = false;
  if (deps.fixWith !== null) {
    if (deps.fixWith === true) {
      const session = deps.caller.sessionRuntime;
      runtime = session && available.includes(session) ? session : available[0] ?? null;
      if (!runtime) {
        deps.print("No agent runtime is installed on this machine, so nothing can fix these for you.");
        deps.print(renderInstructions(issues));
        return { ...none, skipped: "no usable runtime" };
      }
    } else {
      const named = deps.canonical(deps.fixWith);
      if (!available.includes(named)) {
        deps.print(`--fix-with-agent: '${deps.fixWith}' is not installed here${available.length ? ` (installed: ${available.join(", ")})` : ""}.`);
        if (human) deps.print(renderInstructions(issues));
        return { ...none, skipped: `runtime '${named}' not installed` };
      }
      runtime = named;
    }
  } else if (human) {
    if (available.length === 0) {
      deps.print(renderInstructions(issues));
      return { ...none, skipped: "no usable runtime" };
    }
    prompted = true;
    runtime = parseChoice(await deps.ask(fixQuestion(available)), available);
    if (!runtime) {
      deps.print(renderInstructions(issues));
      return { ...none, prompted, skipped: "declined" };
    }
  } else {
    // Agent or automation without --fix-with-agent: the block is the answer.
    return { ...none, skipped: "not requested" };
  }

  deps.print(`Asking ${runtimeLabel(runtime)} to fix ${fixable.length} issue(s)… (headless; this can take a few minutes)`);
  const prompt = buildFixPrompt(fixable, { platform: deps.fixEnv.platform, squadDirs: deps.squadDirs });
  let run: FixDispatch;
  try { run = await deps.dispatch(runtime, prompt); }
  catch (e) { run = { ok: false, answer: "", error: e instanceof Error ? e.message : String(e) }; }
  const answer = (run.answer || "").trim();
  if (answer) {
    const lines = answer.split(/\r?\n/);
    const shown = lines.length > 60 ? ["…", ...lines.slice(-60)] : lines;
    deps.print(`\n${runtimeLabel(runtime)} says:\n${shown.map((l) => `  ${l}`).join("\n")}`);
  }
  if (!run.ok) deps.print(`${runtimeLabel(runtime)} did not finish cleanly: ${trimError(run.error || "unknown error", 3)}`);

  const squads = [...new Set(fixable.map((i) => i.squad))];
  deps.print(`\nChecking again: ${squads.join(", ")}`);
  const outcomes = await deps.recheck(squads);
  const after = outcomes.flatMap((o) => issuesFromOutcome(o, deps.fixEnv));
  const afterKeys = new Set(after.map(issueKey));
  const handed = new Set(fixable.map(issueKey));
  const fixed = fixable.filter((i) => !afterKeys.has(issueKey(i)));
  // What was handed to the agent and is still there, plus any new failure.
  const stillFailing = after.filter((i) => handed.has(issueKey(i)) || i.severity === "failure");
  const recheckExit = aggregateExit(outcomes);
  if (fixed.length) {
    deps.print(`Fixed (${fixed.length}):`);
    for (const i of fixed) deps.print(`  ✓ ${i.squad} · ${i.kind} ${i.name}`);
  }
  if (stillFailing.length) {
    deps.print(`Still not ready (${stillFailing.length}):`);
    for (const i of stillFailing) deps.print(`  ✗ ${i.squad} · ${i.kind} ${i.name}: ${i.error.split("\n")[0]}`);
  } else {
    deps.print("Everything that was checked again is ready.");
  }
  return {
    resolved: recheckExit === 0 && stillFailing.length === 0,
    recheckExit,
    prompted,
    skipped: null,
    agentFix: {
      runtime, ok: run.ok, answer, error: run.ok ? null : run.error ?? null,
      fixed, still_failing: stillFailing,
      recheck: outcomes.map((o) => ({ slug: o.slug, exit_code: o.exitCode })),
    },
  };
}
