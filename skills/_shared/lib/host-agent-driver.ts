/**
 * host-agent-driver.ts — THE canonical runtime-agnostic driver (routing-360
 * Phase 4.4 unification). One module, two call layers, nine adapters:
 *
 *   LIGHT LAYER — callHostAgent / callHostAgentAsync: single text-in/text-out
 *   LLM calls (judge, audit consensus, verifier, amplifier). Detects the host
 *   runtime on PATH and never hard-codes a vendor, a model, or an API key.
 *
 *   HEADLESS LAYER — runHeadless: full agentic execution of a dispatch prompt
 *   (the child writes deliverables itself). Carries the dispatch-ledger
 *   heartbeat sidecar, capture files, and the driverSpawnSync choke point.
 *
 * skills/harness/lib/host-agent-driver.ts is a thin re-export of this module
 * (plus harness-only extras like AUTONOMOUS_DIRECTIVE). Do not fork adapters
 * there again — the pre-unification split is exactly the divergence this
 * module closes.
 *
 * Adapters (9): claude-code, codex, gemini-cli, antigravity-cli, kimi-cli,
 * grok-cli, pi, qwen-code, opencode.
 *
 * PROMPT DELIVERY (ARG_MAX safety): Linux caps a single argv element at
 * MAX_ARG_STRLEN (~128 KiB) and macOS shares a ~256 KiB pool across argv+env,
 * so a large prompt must NEVER travel as one argv string. Each adapter uses
 * its verified best channel:
 *   - STDIN when the CLI documents it (claude, codex, gemini, qwen).
 *   - A native prompt-file flag when the CLI has one (grok --prompt-file).
 *   - Otherwise argv for small prompts, degrading to a temp prompt file plus
 *     a short bootstrap argv ("read the file and execute it") above
 *     MAX_ARGV_PROMPT_BYTES (agy, kimi, opencode) or pi's native @file
 *     attachment (pi).
 * Verification notes (per-CLI --help audits) live on each adapter below.
 *
 * HEADLESS AUTONOMY: a non-interactive child cannot answer an approval prompt,
 * so every adapter whose CLI documents an approval-bypass flag passes it by
 * default, in BOTH layers (per-CLI --help audits, 2026-08-26: claude
 * --dangerously-skip-permissions, codex --dangerously-bypass-approvals-and-
 * sandbox, gemini --approval-mode yolo, agy --dangerously-skip-permissions,
 * grok --always-approve). NIRVANA_HEADLESS_SKIP_PERMISSIONS=0 turns the bypass
 * off everywhere (headlessSkipPermissions): the light layer then omits the
 * flag and runHeadless takes each runner's restricted path (the --safe path).
 * CLIs whose flag could not be verified here (kimi, qwen, opencode) and pi,
 * whose --approve is project-file trust rather than tool permission, stay as
 * they are.
 */

import { spawn, spawnSync } from "node:child_process";
import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveSystemModel } from "./system-model.ts";
import { resolveSetting } from "./settings.ts";

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

// ── shared delivery helpers ───────────────────────────────────────────────

/** Prompts above this byte count never travel as a single argv element.
 * Linux MAX_ARG_STRLEN is 128 KiB per argument; macOS shares ~256 KiB across
 * argv+env. 100 KB keeps clear of both with room for the other flags. */
export const MAX_ARGV_PROMPT_BYTES = 100_000;

/** The one switch for headless autonomy: the `execution.headless_skip_permissions`
 * setting. Its variable at `0` (also `false`, `off`, `no`), or `false` in the
 * project or global config, keeps every headless child on its CLI's own
 * approval path; anything else, unset included, is the autonomous default. */
export const HEADLESS_SKIP_PERMISSIONS_ENV = "NIRVANA_HEADLESS_SKIP_PERMISSIONS";

/** True unless the setting (env > project > global config) disables the permission bypass. */
export function headlessSkipPermissions(): boolean {
  return resolveSetting("execution.headless_skip_permissions").value;
}

/** Max persona chars accepted by --append-system-prompt-style flags. */
const PERSONA_MAX_CHARS = 8_000;

/** Truncation used to be silent — now it warns with sizes (stderr). */
function clampPersona(persona: string, cliName: string, max: number = PERSONA_MAX_CHARS): string {
  if (persona.length <= max) return persona;
  console.error(`[host-agent-driver] persona for ${cliName} truncated: ${persona.length} chars -> ${max} (adapter cap). ${persona.length - max} chars dropped.`);
  return persona.slice(0, max);
}

/**
 * Benign chatter agent CLIs print to stderr before (and after) the real failure.
 * A failed run reports ONLY `error` — quota-detector classifies from that string
 * and the ledger shows it to the user — so taking the first N bytes of stderr let
 * noise like gemini-cli's "YOLO mode is enabled" headline the failure and, when
 * the chatter was long enough, push the actual cause out of the window entirely.
 * Then nothing classifies it and the cascade cannot fail over. Match on whole
 * lines only: a line that merely CONTAINS one of these is still a real message.
 */
const STDERR_NOISE = [
  /^YOLO mode is enabled\b/i,
  /^Skill conflict detected:/i,
  /^\s*at\s+\S+\s*\(/,                       // stack frames
  /^\(node:\d+\)\s+\w*Warning:/i,            // node DeprecationWarning/ExperimentalWarning
  /^npm (warn|notice)\b/i,
  /^Loaded cached credentials\.?$/i,
];

/** Lines that carry an actual cause, preferred over anything else present. */
const STDERR_SIGNAL =
  /error|exception|refus|denied|unauthor|forbidden|ineligible|unsupported|quota|rate[ _-]?limit|not\s+found|invalid|expired|fail|\b(401|403|404|429|5\d\d)\b/i;

/**
 * Pull the meaningful failure out of a runtime's stderr. Signal lines win over
 * position, so the cause survives however much chatter precedes it.
 */
export function salientError(stderr: string, fallback: string, max = 500): string {
  const lines = (stderr || "").split("\n").map(l => l.trim())
    .filter(l => l.length > 0 && !STDERR_NOISE.some(rx => rx.test(l)));
  const picked = lines.filter(l => STDERR_SIGNAL.test(l));
  const chosen = (picked.length ? picked : lines).join("\n").trim();
  if (!chosen) return fallback;
  return chosen.length <= max ? chosen : chosen.slice(0, max - 1) + "…";
}

function writePromptFile(prompt: string, prefix = "nrv-prompt"): string {
  const f = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(f, prompt, "utf8");
  return f;
}

/** Bootstrap argv for agentic CLIs with neither STDIN nor a prompt-file flag:
 * the child reads its real prompt from a temp file via its own file tools. */
function promptFileBootstrap(file: string): string {
  return [
    `The complete task prompt is in the UTF-8 file at: ${file}`,
    `Read that file now and execute every instruction in it exactly as if its`,
    `contents had been sent as this message. Do not summarize or describe the`,
    `file — execute it.`,
  ].join("\n");
}

function removeTmpFiles(files: string[] | undefined): void {
  for (const f of files ?? []) {
    try { fs.rmSync(f, { force: true }); } catch { /* best-effort */ }
  }
}

/** Every prefix writePromptFile is ever called with (default "nrv-prompt",
 * plus claudeDirectiveArgs' "nrv-directive"). One place, so the reaper below
 * can never drift from what this module actually creates. */
const TMP_FILE_PREFIXES = ["nrv-prompt-", "nrv-directive-"];

/**
 * Process-wide safety net for the one gap a `finally`/`settle()` cannot close:
 * a process killed by an external signal while blocked inside spawnSync never
 * runs its own cleanup. Verified on this machine (Bun 2026-08-29): a
 * `process.on('SIGTERM', ...)` handler does not help either — the callback is
 * deferred until the blocking spawnSync call itself returns, so it cannot fire
 * while the process is stuck waiting on a hung child, which is exactly the
 * case the supervisor's kill exists for. SIGKILL cannot be caught at all, by
 * either mechanism.
 *
 * This is why every adapter's own try/finally stays as-is (correct for normal
 * exit, error, and spawnSync's own timeout-to-CHILD) and the file it cannot
 * reach is instead swept by a SEPARATE, later-running process that never
 * shares the killed process's fate. Call this from that other process (the
 * supervisor sweep), never from the same run that might leak — a self-reap
 * would need the very JS execution the leak scenario denies it.
 *
 * `maxAgeMs` defaults to 24h: comfortably longer than any lease-driven kill
 * or retry cycle (minutes), so it can never race a legitimately slow but
 * still-live run's file, while reliably reclaiming anything orphaned by a
 * kill.
 */
export function reapOrphanedPromptFiles(opts: { dir?: string; maxAgeMs?: number } = {}): string[] {
  const dir = opts.dir ?? os.tmpdir();
  const maxAgeMs = opts.maxAgeMs ?? 24 * 60 * 60_000;
  const now = Date.now();
  const removed: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return removed; }
  for (const name of entries) {
    if (!TMP_FILE_PREFIXES.some((p) => name.startsWith(p))) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || now - st.mtimeMs < maxAgeMs) continue;
      fs.rmSync(full, { force: true });
      removed.push(full);
    } catch { /* raced with its own creator/consumer — not our problem */ }
  }
  return removed;
}

/** The "where does this CLI live" probe, per platform. Windows `where` takes its options with a
 * slash (`WHERE [/R dir] [/Q] ... pattern...`), so the `-v` this used to pass was read as a SECOND
 * PATTERN, not a flag: the probe asked for a file named `-v` as well and answered about both. On
 * POSIX the probe stays the `command -v` builtin, which is shell-only and therefore normally fails
 * here — the manual PATH scan below is its real path. */
export function whichProbe(cli: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  return platform === "win32" ? { command: "where", args: [cli] } : { command: "command", args: ["-v", cli] };
}

/** The first real path in a probe's stdout. `where` ends every line with CRLF and prints ONE LINE
 * PER MATCH, so splitting on "\n" alone left a trailing "\r" on the chosen line whenever there was
 * more than one match. `/\.(cmd|bat)$/i` then failed on a path that plainly ends in `.cmd`, and
 * resolveExecutable spawned it without a shell — the exact "probe says yes, invocation dies" split
 * this module exists to prevent. */
export function firstExecutablePath(stdout: string): string | null {
  for (const line of (stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function whichSync(cli: string): string | null {
  const probe = whichProbe(cli);
  const r = spawnSync(probe.command, probe.args, { encoding: "utf8", env: process.env });
  // bash builtin `command` is shell-only; fallback to PATH scan
  if (r.status === 0) {
    const found = firstExecutablePath(r.stdout);
    if (found) return found;
  }
  // Manual PATH scan. The Windows extension list is not decoration: an agent CLI
  // installed by npm is `<name>.cmd`, never a bare file, so a scan that only
  // tried `.exe` reported "not installed" for a runtime sitting right there.
  const exts = process.platform === "win32" ? ["", ".cmd", ".bat", ".exe"] : ["", ".exe"];
  const PATH = (process.env.PATH || "").split(path.delimiter);
  for (const dir of PATH) {
    for (const ext of exts) {
      const full = path.join(dir, cli + ext);
      try { if (fs.statSync(full).isFile()) return full; } catch { /* next candidate */ }
    }
  }
  return null;
}

// ── Windows: spawn what the shim names, not the shim ──────────────────────
//
// An agent CLI installed through npm is a `.cmd` on Windows, and every `.cmd`
// had been started through `cmd.exe`, which ends the command line at the first
// CR/LF of any argument, quoted or not (the parser's limit, not the quoting's).
// That cost the claude runner both `--add-dir` grants and its permission flag,
// and the eight other adapters carry the same shape.
//
// The shim itself is not the program. It is a five-line batch file whose only
// job is to run `node <script> %*`. Reading it, taking the pair it names and
// spawning THAT removes the interpreter from the chain entirely: the child
// starts the same way a real `.exe` already does on this platform, with nothing
// left to cut anything.
//
// Reading is deliberately literal-minded. A shim whose shape does not match
// what these functions can name with certainty produces no candidate, and the
// caller falls back to the `cmd.exe` path. Degrading is acceptable; guessing is
// not, so every guard below refuses rather than assumes:
//
//   - positional arguments (`%1`, `%~2`) or `SHIFT`: the wrapper rearranges
//     what it forwards, so `%*` no longer proves the arguments pass intact;
//   - a `SET` of anything but the three variables npm/pnpm/yarn shims use, an
//     environment the direct spawn would not reproduce;
//   - a variable that survives expansion, since we cannot name what would run;
//   - `%*` anywhere but as the last token, so arguments land somewhere we did
//     not read;
//   - an interpreter or script that is not on disk, or an interpreter that is
//     itself a `.cmd`, which would only re-enter the trap.

/** A shim is a few hundred bytes. Anything bigger is a batch program doing work
 * of its own, and reading it as a launcher would be a guess. */
const MAX_SHIM_BYTES = 16 * 1024;

/** `%1`, `%~2`, `%0` — argument reshuffling. `%~dp0` and `%*` do not match. */
const SHIM_POSITIONAL = /%~?[0-9]/;
const SHIM_SHIFT = /^[\s@]*shift\b/im;
const SHIM_SET = /^[\s@]*set\s+"?([A-Za-z_][A-Za-z0-9_]*)\s*=/gim;
const SHIM_PROG_SET = /^[\s@]*set\s+(?:"_prog=([^"\r\n]*)"|_prog=([^\r\n]*))/gim;
/** `dp0` and `_prog` are the shim's own two variables; `PATHEXT` is the tweak
 * that keeps its `node` from resolving to a `.js`, which is program resolution
 * we do ourselves below. Any other assignment is an environment we would drop. */
const SHIM_SET_ALLOWED = new Set(["dp0", "_prog", "pathext"]);

/** Split one command fragment into arguments the way the interpreter would:
 * double quotes group, unquoted whitespace separates, `""` stays an argument. */
function tokenizeCmdFragment(fragment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quoted = false;
  for (const ch of fragment) {
    if (ch === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && /\s/.test(ch)) {
      if (started) { tokens.push(current); current = ""; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** Index of the last `&` or `|` outside quotes. The modern npm shim hides its
 * real invocation behind both:
 * `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "…" %*`. */
function lastCommandSeparator(line: string): number {
  let quoted = false;
  let at = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && (ch === "&" || ch === "|")) at = i;
  }
  return at;
}

/** Shims are written with `\`; this module has to compare against real paths.
 * On Windows the swap is the identity (`path.sep` IS `\`), which is also what
 * lets the win32 branch be exercised on a POSIX runner. Only tokens that carry
 * a separator are touched, so a flag survives byte for byte. */
function normalizeShimPath(value: string): string {
  if (!/[\\/]/.test(value)) return value;
  return path.normalize(path.sep === "/" ? value.replace(/\\/g, "/") : value);
}

/** Expand the three variables a shim uses, or null when anything else survives:
 * an unexpanded `%VAR%` means we cannot name what the shim would run. */
function expandShimToken(token: string, dp0: string, prog: string | null): string | null {
  let out = token.replace(/%~dp0/gi, () => dp0).replace(/%dp0%/gi, () => dp0);
  if (prog !== null) out = out.replace(/%_prog%/gi, () => prog);
  if (out.includes("%")) return null;
  return normalizeShimPath(out);
}

/**
 * Every invocation a shim names, best first — nothing is checked against the
 * filesystem here, which keeps this half testable as pure text.
 *
 * Order mirrors the shim's own `IF EXIST`: the interpreter sitting beside the
 * shim (`%~dp0\node.exe`) is offered before the bare name it falls back to, in
 * both the modern `_prog` form and the older two-branch one.
 */
export function parseCmdShim(text: string, shimPath: string): Array<{ program: string; args: string[] }> {
  if (SHIM_POSITIONAL.test(text) || SHIM_SHIFT.test(text)) return [];
  SHIM_SET.lastIndex = 0;
  for (let m = SHIM_SET.exec(text); m; m = SHIM_SET.exec(text)) {
    if (!SHIM_SET_ALLOWED.has(m[1].toLowerCase())) { SHIM_SET.lastIndex = 0; return []; }
  }
  const dp0 = path.dirname(shimPath) + path.sep;
  const progs: string[] = [];
  SHIM_PROG_SET.lastIndex = 0;
  for (let m = SHIM_PROG_SET.exec(text); m; m = SHIM_PROG_SET.exec(text)) {
    const raw = (m[1] ?? m[2] ?? "").trim();
    const expanded = raw ? expandShimToken(raw, dp0, null) : null;
    if (expanded) progs.push(expanded);
  }

  const candidates: Array<{ program: string; args: string[] }> = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("%*")) continue;
    const cut = lastCommandSeparator(line);
    const tokens = tokenizeCmdFragment((cut >= 0 ? line.slice(cut + 1) : line).replace(/^[\s@]+/, ""));
    // `%*` last and alone is the whole proof that the arguments pass through
    // untouched. Anything else is a wrapper we did not read.
    if (tokens.length < 2 || tokens[tokens.length - 1] !== "%*") continue;
    if (tokens.slice(0, -1).some(t => t.includes("%*"))) continue;
    const usesProg = /%_prog%/i.test(tokens[0]);
    for (const prog of usesProg ? progs : [null]) {
      const program = expandShimToken(tokens[0], dp0, prog);
      if (!program) continue;
      const args = tokens.slice(1, -1).map(t => expandShimToken(t, dp0, prog));
      if (args.some(a => a === null)) continue;
      candidates.push({ program, args: args as string[] });
    }
  }
  return candidates;
}

function isFile(candidate: string): boolean {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

/** A flag passes through untouched; anything carrying a separator is a path the
 * shim expects to exist, and if it does not we did not read the shim right. */
function shimArgPresent(arg: string): boolean {
  return !/[\\/]/.test(arg) || isFile(arg);
}

/** The named interpreter as a real executable. A path is taken as given — this
 * is the `%~dp0` case, where node sits beside the shim and need not be on PATH
 * at all. A bare name is looked up on PATH, which is what the shim's own ELSE
 * branch asks `cmd.exe` for. Another `.cmd` is refused: resolving one would
 * only re-enter the trap this whole path exists to leave. */
function resolveShimProgram(program: string): string | null {
  const bases = /[\\/]/.test(program) || /^[A-Za-z]:/.test(program)
    ? [program]
    : (process.env.PATH || "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, program));
  for (const base of bases) {
    for (const full of [base, base + ".exe", base + ".com"]) {
      if (/\.(cmd|bat)$/i.test(full)) continue;
      if (isFile(full)) return full;
    }
  }
  return null;
}

/** The interpreter and leading arguments a `.cmd`/`.bat` names, or null when its
 * shape is not one we can read with certainty — in which case the caller keeps
 * the `cmd.exe` path it has always used. */
export function resolveShimTarget(shimPath: string): { program: string; args: string[] } | null {
  let text: string;
  try {
    const stat = fs.statSync(shimPath);
    if (!stat.isFile() || stat.size > MAX_SHIM_BYTES) return null;
    text = fs.readFileSync(shimPath, "utf8");
  } catch { return null; }
  for (const candidate of parseCmdShim(text, shimPath)) {
    const program = resolveShimProgram(candidate.program);
    if (!program) continue;
    if (!candidate.args.every(shimArgPresent)) continue;
    return { program, args: candidate.args };
  }
  return null;
}

/**
 * How to actually START a CLI on this platform.
 *
 * Windows CreateProcess only auto-appends `.exe` — never `.cmd` or `.bat`. Every
 * agent CLI installed through npm IS a `.cmd`, so spawning the bare name fails
 * there while `where` happily reports the runtime as available: the probe says
 * yes and the invocation dies, which is the worst possible split. (Recent Node
 * makes it explicit, refusing to spawn a `.cmd` without a shell at all.)
 *
 * A `.cmd` is not the program, though — it is a launcher naming one. When the
 * shim can be read (`resolveShimTarget`), the interpreter and script it names
 * are spawned directly and the command interpreter never enters the chain: no
 * shell, nothing re-parsed, and no command line for `cmd.exe` to cut at a
 * newline. A shim of an unrecognized shape keeps the old route — through the
 * interpreter, with `quoteForCmd` on every argument.
 *
 * On POSIX this is the identity: same command, same args, no shell.
 */
export function resolveExecutable(cli: string): { command: string; args: (a: string[]) => string[]; shell: boolean } {
  if (process.platform !== "win32") return { command: cli, args: a => a, shell: false };
  const resolved = whichSync(cli);
  if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
    const target = resolveShimTarget(resolved);
    if (target) return { command: target.program, args: a => [...target.args, ...a], shell: false };
    return { command: quoteForCmd(resolved), args: a => a.map(quoteForCmd), shell: true };
  }
  // A real .exe (or nothing found — let the spawn report the honest ENOENT).
  return { command: resolved ?? cli, args: a => a, shell: false };
}

/**
 * Quote one argument for the Windows command interpreter. Only applied on the
 * shell path above: a temp prompt file lands under a user profile, and plenty of
 * those contain a space ("C:\\Users\\John Doe\\..."), which unquoted becomes two
 * arguments and a CLI that fails for a reason nobody can guess from the message.
 */
export function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"^&|<>()]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

// ── light layer: adapters ─────────────────────────────────────────────────

interface AdapterCall {
  args: string[];
  /** Payload piped to the child's STDIN (adapters with a stdin channel). */
  input?: string;
  /** Temp files created for delivery; removed by the caller after the run. */
  tmpFiles?: string[];
}

interface RuntimeAdapter {
  name: string;
  cli: string;
  /** Preferred: argv + optional stdin payload + temp files for delivery. */
  buildCall?(persona: string, userMsg: string): AdapterCall;
  /** Legacy shape (argv only). Still honored so injected __testRuntime stubs
   * with only buildArgs keep working. Real adapters implement buildCall. */
  buildArgs?(persona: string, userMsg: string): string[];
  parseStdout(stdout: string): string;
  /** Optional: extract token usage + USD cost from raw stdout. Returns null
   *  when the runtime doesn't report usage. */
  parseUsage?(stdout: string): {
    usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
    total_cost_usd: number | null;
    model: string | null;
    duration_ms: number | null;
    session_id: string | null;
  } | null;
  envHints: string[];  // env vars that signal this runtime is the host
}

function adapterCall(host: RuntimeAdapter, persona: string, userMsg: string): AdapterCall {
  if (typeof host.buildCall === "function") return host.buildCall(persona, userMsg);
  return { args: (host.buildArgs as NonNullable<RuntimeAdapter["buildArgs"]>)(persona, userMsg) };
}

/** Small-prompt argv / large-prompt bootstrap-file delivery for CLIs with no
 * stdin and no prompt-file flag. */
function argvOrPromptFile(merged: string, argvFor: (prompt: string) => string[]): AdapterCall {
  if (Buffer.byteLength(merged, "utf8") <= MAX_ARGV_PROMPT_BYTES) return { args: argvFor(merged) };
  const f = writePromptFile(merged);
  return { args: argvFor(promptFileBootstrap(f)), tmpFiles: [f] };
}

const RUNTIMES: RuntimeAdapter[] = [
  {
    name: "claude-code",
    cli: "claude",
    // `claude -p` reads the prompt from STDIN when no positional is given
    // (same channel runClaudeCode uses) — argv stays small no matter the
    // prompt size. `claude --help` (audited 2026-08-26): "--dangerously-skip-
    // permissions  Bypass all permission checks" — without it a headless
    // child dies on the first tool that needs approval.
    buildCall(persona, userMsg) {
      // System model (what the user's session runs) propagated to the child —
      // without this, judge/gate/verify fell to the CLI default (sonnet)
      // instead of inheriting fable/opus. null → no --model (keeps the default).
      const args = ["-p", "--no-session-persistence", "--output-format", "json"];
      if (headlessSkipPermissions()) args.push("--dangerously-skip-permissions");
      const model = resolveSystemModel("claude-code");
      if (model) args.push("--model", model);
      if (persona) args.push("--append-system-prompt", clampPersona(persona, "claude-code"));
      return { args, input: userMsg };
    },
    parseStdout(stdout) {
      try { const o = JSON.parse(stdout); return (o.result || o.text || o.content || "").trim(); }
      catch { return stdout.trim(); }
    },
    parseUsage(stdout) {
      // Claude Code --output-format json includes:
      //   { usage: { input_tokens, output_tokens, cache_creation_input_tokens,
      //              cache_read_input_tokens }, total_cost_usd, model }
      try {
        const o = JSON.parse(stdout);
        if (!o || typeof o !== "object") return null;
        const u = o.usage || {};
        const tokens = {
          input_tokens: Number(u.input_tokens || 0),
          output_tokens: Number(u.output_tokens || 0),
          cache_creation_input_tokens: Number(u.cache_creation_input_tokens || 0),
          cache_read_input_tokens: Number(u.cache_read_input_tokens || 0),
        };
        const total = tokens.input_tokens + tokens.output_tokens
                    + tokens.cache_creation_input_tokens + tokens.cache_read_input_tokens;
        if (total === 0) return null;
        return {
          usage: tokens,
          total_cost_usd: typeof o.total_cost_usd === "number" ? o.total_cost_usd : null,
          model: o.model || o.session_model || null,
          duration_ms: typeof o.duration_ms === "number" ? o.duration_ms : null,
          session_id: o.session_id || null,
        };
      } catch { return null; }
    },
    envHints: ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"],
  },
  {
    name: "codex",
    cli: "codex",
    // `codex exec` with no positional PROMPT reads instructions from stdin
    // (verified via `codex exec --help`) — never pass the prompt via argv.
    // Autonomy (`codex exec --help`, audited 2026-08-26): "--dangerously-
    // bypass-approvals-and-sandbox  Skip all confirmation prompts and execute
    // commands without sandboxing" — the same flag runCodex passes.
    buildCall(persona, userMsg) {
      const merged = persona ? `${persona}\n\n---\n\n${userMsg}` : userMsg;
      const args = ["exec"];
      if (headlessSkipPermissions()) args.push("--dangerously-bypass-approvals-and-sandbox");
      return { args, input: merged };
    },
    parseStdout(stdout) { return stdout.trim(); },
    envHints: ["CODEX_HOME"],
  },
  {
    // Antigravity CLI (`agy`) — replaces gemini-cli for the consumer tier after
    // 2026-06-18. Same Google backend, different binary + flags. `agy --help`
    // (audited 2026-08-06): -p/--print runs a single prompt non-interactively;
    // NO stdin channel and NO prompt-file flag documented, so large prompts
    // degrade to the temp-file bootstrap. --dangerously-skip-permissions for
    // autonomous runs (without it agy halts waiting for approval; `agy --help`
    // audited 2026-08-26: "Auto-approve all tool permission requests without
    // prompting").
    name: "antigravity-cli",
    cli: "agy",
    buildCall(persona, userMsg) {
      const merged = persona ? `${persona}\n\n---\n\n${userMsg}` : userMsg;
      const autonomy = headlessSkipPermissions() ? ["--dangerously-skip-permissions"] : [];
      return argvOrPromptFile(merged, (p) => ["-p", p, ...autonomy]);
    },
    parseStdout(stdout) { return stdout.trim(); },
    envHints: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
  {
    name: "gemini-cli",
    cli: "gemini",
    // `gemini --help` (audited 2026-08-06): "-p ... Appended to input on
    // stdin (if any)" — stdin is a documented prompt channel. The prompt goes
    // via STDIN; `-p ""` keeps headless mode without duplicating content.
    // Autonomy (`gemini --help`, audited 2026-08-26): "--approval-mode ...
    // yolo (auto-approve all tools)" — the same flag runGemini passes.
    buildCall(persona, userMsg) {
      const merged = persona ? `${persona}\n\n---\n\n${userMsg}` : userMsg;
      const args = ["-p", ""];
      if (headlessSkipPermissions()) args.push("--approval-mode", "yolo");
      return { args, input: merged };
    },
    parseStdout(stdout) { return stdout.trim(); },
    envHints: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
  {
    // Pi Coding Agent (`pi`, pi.dev) — minimalist multi-provider harness
    // (15+ providers, including local models via Ollama/models.json).
    // Print mode (-p) returns plain text; --no-approve ignores the project's
    // local extensions (without a TTY there is no way to answer the trust prompt).
    // `pi --help` (audited 2026-08-06): usage is `pi [options] [@files...]
    // [messages...]` — no stdin channel, but @file attachments are native, so
    // large prompts ride an attached temp file instead of argv.
    name: "pi",
    cli: "pi",
    buildCall(persona, userMsg) {
      // Persona via --append-system-prompt (native, confirmed on pi 0.82.1).
      const args = ["-p", "--no-approve"];
      if (persona) args.push("--append-system-prompt", clampPersona(persona, "pi"));
      if (Buffer.byteLength(userMsg, "utf8") <= MAX_ARGV_PROMPT_BYTES) {
        args.push(userMsg);
        return { args };
      }
      const f = writePromptFile(userMsg);
      args.push(`@${f}`, "The attached file contains the complete task prompt. Execute every instruction in it exactly as if its contents had been sent as this message.");
      return { args, tmpFiles: [f] };
    },
    parseStdout(stdout) { return stdout.trim(); },
    envHints: ["PI_CODING_AGENT", "PI_SESSION_ID"],
  },
  {
    // Kimi Code CLI (`kimi`, MoonshotAI). Headless: `kimi -p <prompt>`.
    // Binary not auditable here (not installed); no stdin or prompt-file flag
    // is documented, so large prompts use the temp-file bootstrap fallback.
    name: "kimi-cli",
    cli: "kimi",
    buildCall(persona, userMsg) {
      const merged = persona ? `${persona}\n\n---\n\n${userMsg}` : userMsg;
      return argvOrPromptFile(merged, (p) => ["-p", p]);
    },
    parseStdout(stdout) { return stdout.trim(); },
    envHints: ["KIMI_SESSION_ID", "KIMI_CLI", "KIMI_CODE"],
  },
  {
    // Grok Build CLI (`grok`, xAI). `grok --help` (audited 2026-08-06):
    // native `--prompt-file <PATH>` = "Single-turn prompt from a file" — the
    // lossless channel for any prompt size. Autonomy (`grok --help`, audited
    // 2026-08-26): "--always-approve  Auto-approve all tool executions" — the
    // same flag runGrok passes.
    name: "grok-cli",
    cli: "grok",
    buildCall(persona, userMsg) {
      const merged = persona ? `${persona}\n\n---\n\n${userMsg}` : userMsg;
      const f = writePromptFile(merged);
      const args = ["--prompt-file", f];
      if (headlessSkipPermissions()) args.push("--always-approve");
      return { args, tmpFiles: [f] };
    },
    parseStdout(stdout) {
      try {
        const o = JSON.parse(stdout);
        return (o.text || o.response || o.result || o.output || "").trim() || stdout.trim();
      } catch { return stdout.trim(); }
    },
    envHints: ["GROK_SESSION_ID", "XAI_API_KEY"],
  },
  {
    // qwen-code is a gemini-cli fork; stdin + `-p` follow the parent CLI's
    // documented semantics (prompt appended to stdin input).
    name: "qwen-code",
    cli: "qwen",
    buildCall(persona, userMsg) {
      const merged = persona ? `${persona}\n\n---\n\n${userMsg}` : userMsg;
      return { args: ["-p", ""], input: merged };
    },
    parseStdout(stdout) { return stdout.trim(); },
    envHints: [],
  },
  {
    // opencode: `opencode run <message>`. Binary not auditable here; no stdin
    // channel verified, so large prompts use the temp-file bootstrap fallback.
    name: "opencode",
    cli: "opencode",
    buildCall(persona, userMsg) {
      const merged = persona ? `${persona}\n\n---\n\n${userMsg}` : userMsg;
      return argvOrPromptFile(merged, (p) => ["run", p]);
    },
    parseStdout(stdout) { return stdout.trim(); },
    envHints: [],
  },
];

export interface HostCall {
  text: string;
  host: string;
  exit_code: number;
}
export interface HostError {
  error: string;
  host?: string;
  exit_code?: number;
  /** Set when the watchdog detected a stall. ms elapsed without bytes. */
  stalled_after_ms?: number;
  /** Total stdout+stderr bytes seen before stall classification. */
  bytes_received_before_stall?: number;
}

/**
 * detectHost — returns the first runtime whose CLI is on PATH.
 * If `forceRuntime` is set (NIRVANA_AGENT_RUNTIME env), that one is preferred
 * (must still be installed). Caller may also pass `preferred` slug.
 */
export function detectHost(opts: { preferred?: string } = {}): RuntimeAdapter | null {
  const preferred = opts.preferred || process.env.NIRVANA_AGENT_RUNTIME;
  if (preferred) {
    const r = RUNTIMES.find(x => x.name === preferred);
    if (r && whichSync(r.cli)) return r;
  }
  for (const r of RUNTIMES) {
    if (whichSync(r.cli)) return r;
  }
  return null;
}

/**
 * callHostAgent — dispatches a single LLM call through the host runtime.
 * Persona is the role's persona text (loaded from the agent .md). User
 * message is the actual task prompt.
 *
 * `timeoutMs` here is WALL CLOCK, and it is the one place in this file where
 * that is not a defect but a limit: spawnSync blocks the event loop, so no
 * timer can run and nothing can observe the child working. Say it plainly
 * rather than let a caller assume the async contract. Work that may legitimately
 * take a long time belongs in callHostAgentAsync (silence budget) or runHeadless
 * (heartbeat sidecar); the default here is only large enough that the blocking
 * path stops being the thing that kills a thinking model.
 */
export function callHostAgent(persona: string, userMessage: string, opts: CallOpts = {}): HostCall | HostError {
  const host = opts.__testRuntime ?? detectHost({ preferred: opts.preferredHost });
  if (!host) {
    return { error: "no host agent CLI found on PATH (tried: " + RUNTIMES.map(r => r.cli).join(", ") + ")" };
  }
  const call = adapterCall(host, persona || "", userMessage);
  let r!: SpawnSyncReturns<string>;
  try {
    const exec = resolveExecutable(host.cli);
    r = spawnSync(exec.command, exec.args(call.args), {
      encoding: "utf8",
      timeout: opts.timeoutMs ?? DEFAULT_INACTIVITY_BUDGET_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env },
      ...(exec.shell ? { shell: true } : {}),
      ...(call.input !== undefined ? { input: call.input } : {}),
    });
  } finally {
    removeTmpFiles(call.tmpFiles);
  }
  if (r.status !== 0) {
    return {
      error: salientError(r.stderr || "", `${host.cli} exited ${r.status}`),
      host: host.name,
      exit_code: r.status ?? -1,
    };
  }
  try { emitCostAudit(host, r.stdout, opts); } catch { /* non-fatal */ }
  return {
    text: host.parseStdout(r.stdout),
    host: host.name,
    exit_code: 0,
  };
}

/**
 * Async variant — dispatches via child_process.spawn so multiple calls can
 * run in parallel from the same process. Returns the same shape as
 * callHostAgent but as a Promise.
 *
 * Two windows, one activity signal (`lastDataAt`, advanced by every
 * stdout/stderr chunk):
 *
 *  - `timeoutMs` — the budget of SILENCE every call gets, default
 *    DEFAULT_INACTIVITY_BUDGET_MS. Rearms on activity; resolves with
 *    `{ error: 'inactivity_timeout', stalled_after_ms, ... }`.
 *  - `heartbeatMs` — a TIGHTER opt-in window for callers whose adapter
 *    streams. `heartbeatMode: 'kill'` (default) SIGTERMs and resolves with
 *    `{ error: 'stall', ... }`; `'warn'` resolves early and lets the child run
 *    on until the inactivity budget.
 *
 * `heartbeatMs` defaults to 0 — DISARMED — because most adapters here are not
 * streaming: `claude -p --output-format json`, gemini, grok, kimi and
 * antigravity all print one JSON object at the END of the call. For those,
 * "no bytes yet" is not a stall signal, it is the normal shape of a call in
 * progress, and the old 60 s default was a 60-second wall clock on an LLM
 * wearing the name of an activity check. A caller that knows its child streams
 * asks for the tighter window explicitly.
 *
 * The driver does not retry — that is the caller's job (see
 * `_shared/lib/host-agent-retry.js`). Cost telemetry is emitted by callers;
 * the one event the driver emits itself is the kill (emitDriverAudit), because
 * only the driver knows which rule fired.
 */
export type HeartbeatMode = "kill" | "warn";

/**
 * Default budget of SILENCE for a light-layer call — 45 minutes.
 *
 * It replaced a 120 s WALL-CLOCK default, and both halves of that sentence
 * were wrong. Measured on this machine's 557 Claude Code transcripts
 * (123,318 gaps between two consecutive non-human entries, scoped to one
 * sessionId and cut at compaction boundaries): p50 1.1 s, p95 28 s, p99 192 s.
 * 1.8% of the pauses a model takes between two tool calls are longer than two
 * minutes, 0.45% longer than ten, 0.089% longer than forty-five — and past an
 * hour the count stops falling (90 → 77 → 71), which is the resumed-session
 * floor rather than any real pause. 45 min is where the credible tail ends.
 *
 * It is a budget of silence, not of life: any byte on stdout/stderr rearms it,
 * so a child that keeps working is never killed for working long. What it
 * bounds is a child that has stopped saying anything at all.
 */
export const DEFAULT_INACTIVITY_BUDGET_MS = 45 * 60_000;

export interface CallOpts {
  /** Max ms of SILENCE before the child is killed (default
   *  DEFAULT_INACTIVITY_BUDGET_MS). Rearmed by every stdout/stderr byte — this
   *  is not a wall-clock lifetime. */
  timeoutMs?: number;
  /** Tighter opt-in stall window for callers whose adapter streams. Default 0
   *  (disarmed) — see callHostAgentAsync's contract. */
  heartbeatMs?: number;
  minBytesPerHeartbeat?: number;   // bytes counted toward "alive"; default 1
  heartbeatMode?: HeartbeatMode;   // default 'kill'
  /** Preferred runtime slug (e.g. from runtime-rules decideRuntime). Must
   *  still be installed; falls back to the PATH scan when absent. The
   *  NIRVANA_AGENT_RUNTIME env override has lower precedence only when this
   *  is unset (detectHost: preferred || env). */
  preferredHost?: string;
  /** Identifies the caller for cost telemetry attribution (e.g. "quality-judge",
   *  "squad-audit-consensus:critic", "stage-2-amplifier"). Surfaced in the
   *  cost_emission audit event so dashboards can break down by source. */
  caller_id?: string;
  /** Project to attribute the cost to. Defaults to NIRVANA_PROJECT_ID env. */
  project_id?: string;
  /** Set to false to suppress cost_emission emission for this call. Default true. */
  emitCost?: boolean;
  /**
   * TEST-ONLY: bypass detectHost and use this adapter directly. Must conform to
   * the RuntimeAdapter shape ({ name, cli, buildCall|buildArgs, parseStdout }).
   * Do not use in production code paths.
   */
  __testRuntime?: any;
}

/** The audit module, or null when it cannot be loaded. Lazy for the same
 *  reason emitCostAudit is: the driver must not depend on a sibling skill at
 *  module init. */
function loadAudit(): { emit?: (e: string, p: unknown, c?: unknown) => void } | null {
  try { return require(path.join(SKILLS_ROOT, "harness", "lib", "audit.js")); }
  catch { return null; }
}

/**
 * A child the driver kills says WHY, in the audit, before it dies.
 *
 * Until this existed, a run killed by the global timeout reached its caller as
 * `"<cli> exited null"` — the same message a crash produces, with nothing about
 * the rule that fired or how long the child had been silent. Telemetry is
 * fire-and-forget; the kill never waits on it.
 */
function emitDriverAudit(event: string, payload: Record<string, unknown>, opts: CallOpts): void {
  const audit = loadAudit();
  if (!audit?.emit) return;
  try {
    audit.emit(event, { caller_id: opts.caller_id || null, ...payload }, {
      project_id: opts.project_id || process.env.NIRVANA_PROJECT_ID || null,
    });
  } catch { /* non-fatal */ }
}

/**
 * Fire-and-forget audit emission. Loaded lazily so the driver stays free of
 * cross-skill dependencies at module init.
 */
function emitCostAudit(host: any, stdoutRaw: string, opts: CallOpts) {
  if (opts.emitCost === false) return;
  if (!host?.parseUsage) return;
  const usage = host.parseUsage(stdoutRaw);
  if (!usage) return;
  const audit = loadAudit();
  if (!audit?.emit) return;
  try {
    audit.emit("cost_emission", {
      host: host.name,
      caller_id: opts.caller_id || null,
      model: usage.model,
      usage: usage.usage,
      total_cost_usd: usage.total_cost_usd,
      duration_ms: usage.duration_ms,
      session_id: usage.session_id,
    }, {
      project_id: opts.project_id || process.env.NIRVANA_PROJECT_ID || null,
    });
  } catch { /* non-fatal */ }
}

export function callHostAgentAsync(persona: string, userMessage: string, opts: CallOpts = {}): Promise<HostCall | HostError> {
  return new Promise((resolve) => {
    const host = opts.__testRuntime ?? detectHost({ preferred: opts.preferredHost });
    if (!host) {
      resolve({ error: "no host agent CLI found on PATH (tried: " + RUNTIMES.map(r => r.cli).join(", ") + ")" });
      return;
    }
    const heartbeatMs = opts.heartbeatMs ?? 0;
    const minBytes = opts.minBytesPerHeartbeat ?? 1;
    const mode: HeartbeatMode = opts.heartbeatMode ?? "kill";

    const call = adapterCall(host, persona || "", userMessage);
    const exec = resolveExecutable(host.cli);
    const child = spawn(exec.command, exec.args(call.args), {
      env: { ...process.env },
      ...(exec.shell ? { shell: true } : {}),
      stdio: [call.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (call.input !== undefined && child.stdin) {
      child.stdin.on("error", () => { /* EPIPE if the child exits early */ });
      child.stdin.write(call.input);
      child.stdin.end();
    }
    let stdout = "";
    let stderr = "";
    let bytesReceived = 0;
    let bytesSinceLastBeat = 0;
    let lastDataAt = Date.now();
    let stallSignaled = false;

    const onChunk = (d: Buffer) => {
      bytesReceived += d.length;
      bytesSinceLastBeat += d.length;
      lastDataAt = Date.now();
    };
    child.stdout?.on("data", (d) => { stdout += d.toString(); onChunk(d); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); onChunk(d); });

    // ── timer registry + single settle path ────────────────────────────────
    // Every resolution funnels through settle(); every timer is cleared from
    // it (with two deliberate survivors, each reclaimed on child close):
    //   - keep.escalation: the SIGKILL escalation must outlive a stall-kill
    //     settle so a SIGTERM-ignoring child still dies; close clears it.
    //   - keep.timeout: in 'warn' mode the child keeps running after the
    //     early resolve, so the inactivity timer stays armed; close clears it.
    let globalTimeout: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let killEscalation: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const clearWatchdog = () => { if (watchdog) { clearInterval(watchdog); watchdog = null; } };
    const clearGlobalTimeout = () => { if (globalTimeout) { clearTimeout(globalTimeout); globalTimeout = null; } };
    const clearEscalation = () => { if (killEscalation) { clearTimeout(killEscalation); killEscalation = null; } };
    const clearAllTimers = () => { clearWatchdog(); clearGlobalTimeout(); clearEscalation(); };
    const settle = (payload: HostCall | HostError, keep: { timeout?: boolean; escalation?: boolean } = {}) => {
      clearWatchdog();
      if (!keep.timeout) clearGlobalTimeout();
      if (!keep.escalation) clearEscalation();
      removeTmpFiles(call.tmpFiles);
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    // ── inactivity budget ──────────────────────────────────────────────────
    // `timeoutMs` used to arm ONE setTimeout at spawn, so it fired on elapsed
    // time and could not tell a model thinking from a dead socket. It now
    // measures from the last byte: the timer rearms for whatever is left of the
    // budget whenever the child has spoken since it was set, so a child that
    // keeps writing outlives any elapsed time and only silence is fatal.
    //
    // It reads the same `lastDataAt` the stall watchdog reads — one activity
    // signal, two windows, never two notions of "alive".
    const inactivityBudgetMs = opts.timeoutMs ?? DEFAULT_INACTIVITY_BUDGET_MS;
    const armInactivity = (ms: number) => {
      globalTimeout = setTimeout(() => {
        const silentMs = Date.now() - lastDataAt;
        if (silentMs < inactivityBudgetMs) { armInactivity(inactivityBudgetMs - silentMs); return; }
        globalTimeout = null;
        stallSignaled = true;   // the watchdog must not fire a second verdict
        emitDriverAudit("x_driver_child_killed", {
          rule: "inactivity",
          host: host.name,
          budget_ms: inactivityBudgetMs,
          silent_ms: silentMs,
          bytes_received: bytesReceived,
        }, opts);
        try { child.kill("SIGTERM"); } catch {}
        // Same escalation the stall path uses: a SIGTERM-ignoring child still
        // dies, and `keep.escalation` lets that timer outlive this settle.
        killEscalation = setTimeout(() => {
          killEscalation = null;
          try { child.kill("SIGKILL"); } catch {}
        }, 5000);
        settle({
          error: "inactivity_timeout",
          host: host.name,
          exit_code: -1,
          stalled_after_ms: silentMs,
          bytes_received_before_stall: bytesReceived,
        }, { escalation: true });
      }, ms);
    };
    armInactivity(inactivityBudgetMs);

    if (heartbeatMs > 0) {
      const tickMs = Math.max(500, Math.floor(heartbeatMs / 2));
      watchdog = setInterval(() => {
        if (stallSignaled) return;
        const since = Date.now() - lastDataAt;
        const tookEnoughBytes = bytesSinceLastBeat >= minBytes;
        if (tookEnoughBytes) { bytesSinceLastBeat = 0; return; }
        if (since >= heartbeatMs) {
          stallSignaled = true;
          const stallPayload: HostError = {
            error: mode === "kill" ? "stall" : "stall_warning",
            host: host.name,
            exit_code: -1,
            stalled_after_ms: since,
            bytes_received_before_stall: bytesReceived,
          };
          if (mode === "kill") {
            try { child.kill("SIGTERM"); } catch {}
            killEscalation = setTimeout(() => {
              killEscalation = null;
              try { child.kill("SIGKILL"); } catch {}
            }, 5000);
            settle(stallPayload, { escalation: true });
          } else {
            // 'warn': resolve early but let the child run until the global
            // timeout (or its natural exit) — timers reclaimed on close.
            settle(stallPayload, { timeout: true });
          }
        }
      }, tickMs);
    }

    child.on("close", (code) => {
      if (settled) { clearAllTimers(); return; } // stall/warn already resolved — reclaim survivors
      if (code !== 0) {
        settle({
          error: salientError(stderr, `${host.cli} exited ${code}`),
          host: host.name,
          exit_code: code ?? -1,
        });
        return;
      }
      // Auto-emit cost_emission audit event when the host reports usage.
      // Fire-and-forget: never block the resolve() on telemetry.
      try { emitCostAudit(host, stdout, opts); } catch { /* non-fatal */ }
      settle({
        text: host.parseStdout(stdout),
        host: host.name,
        exit_code: 0,
      });
    });
    child.on("error", (e) => {
      if (settled) { clearAllTimers(); return; }
      settle({ error: e.message, host: host.name, exit_code: -1 });
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// HEADLESS LAYER — runHeadless: full agentic execution of a dispatch prompt.
// The runtime writes deliverables itself (cwd-scoped); we capture the
// session_id so `nrv revise` can resume the same conversation.
// ══════════════════════════════════════════════════════════════════════════

export type Runtime =
  | "claude-code" | "codex" | "gemini-cli" | "antigravity-cli"
  | "kimi-cli" | "grok-cli" | "pi" | "qwen-code" | "opencode";

export interface RunHeadlessOpts {
  runtime: Runtime;
  prompt: string;
  cwd: string;
  /** Extra directories the runtime may touch (e.g. the project root). */
  addDirs?: string[];
  /** Resume an existing conversation (revise flow). */
  sessionId?: string;
  /** Injected as a system-prompt suffix (autonomous-mode directive). */
  appendSystemPrompt?: string;
  /** Tool allowlist. Default: file + web tools, no Bash. */
  allowedTools?: string[];
  /** claude permission mode. Default: acceptEdits. */
  permissionMode?: string;
  /** Hard dollar cap for the run (claude --max-budget-usd). Omit = uncapped. */
  maxBudgetUsd?: number;
  /** Wall-clock timeout in ms. Default: NONE (uncapped) — long book/PDF runs
   * must not be SIGTERM'd mid-flight (the old 20-min default killed real runs
   * with exit 143). Callers that want a cap pass it explicitly (e.g. the fast
   * router sets 5 min; `nrv dispatch --timeout=<min>`). */
  timeoutMs?: number;
  /** Bypass all permission checks (claude --dangerously-skip-permissions and
   * each runtime's equivalent). Default true; `false` is the restricted path
   * (`nrv dispatch --safe`). NIRVANA_HEADLESS_SKIP_PERMISSIONS=0 forces
   * `false` for every run (see headlessSkipPermissions). */
  yolo?: boolean;
  /** Optional model override. Passed as `--model <id>` (or equivalent) to the
   * underlying CLI. Honors model hints from LLM_CASCADE entries. If unset,
   * each CLI uses its own configured default. */
  model?: string;
  /** Optional provider id for CLIs that support multi-provider config
   * (codex `--provider <id>` referencing [model_providers.<id>] in
   * ~/.codex/config.toml; qwen-code modelProviders[].id; pi's native
   * `--provider` — anthropic/openai/google/openrouter/ollama/…). Ignored by
   * CLIs that don't have this concept. */
  providerHint?: string;
  /** Dispatch-ledger heartbeat (routing-360 Phase 4). When present the run is
   * SUPERVISED: a detached sidecar renews the run's lease while the child shows
   * activity, and the wall clock falls back to LEDGER_DEFAULT_TIMEOUT_MS — a
   * backstop above any real run, not a hang detector. What ends a hung run is
   * the lease expiring DEFAULT_LEASE_SEC after the last sign of life. */
  ledger?: LedgerHeartbeatOpts;
  /** Max ms without observed activity before the sidecar RECORDS the gap
   * (`x_ledger_stall_observed`, the supervisor.stall_threshold_ms setting,
   * 5 min). This is an early warning and kills nothing: the lease is what
   * decides. Only meaningful together with opts.ledger. */
  stallBudgetMs?: number;
}

export interface LedgerHeartbeatOpts {
  /** Ledger run id (run-ledger.ts openRun). */
  runId: string;
  /** Directory watched for activity (the run's output dir). Activity = newest
   * mtime under it advanced — activity-based, not existence-based. Every file
   * the sweep finds is also NAMED in an `artifact_touched` audit event, which
   * is what the Glance reads to say where a run is. */
  watchDir?: string;
  /** Ceiling on those `artifact_touched` events for this child; 0 reports none.
   * Default: the supervisor.touch_events_max setting. */
  touchEventsMax?: number;
  /** Ledger DB path override (tests). Default: resolveLedgerDbPath(). */
  dbPath?: string;
  /** Heartbeat check interval in ms (default 15s; tests shrink it). */
  intervalMs?: number;
  /** Seconds each renewal extends the lease from now (default
   * DEFAULT_LEASE_SEC). This is the window that decides a run is dead. */
  leaseSec?: number;
}

/**
 * Wall-clock backstop for LEDGERED runs: 7 days.
 *
 * The ceiling survives, and it moved. It survives because the activity signal
 * cannot catch one failure by construction — a child that keeps emitting
 * output forever without converging is indistinguishable from a child that is
 * working, so something has to bound it. It moved because 24h was not above
 * the work: this machine's ledger holds 371 runs, whose longest is 25.5h and
 * whose longest DELIVERED one is 4.9h (p50 21min, p90 62min, p99 5.7h). A
 * ceiling below the observed maximum is not a backstop, it is a second hang
 * detector — a worse one, that kills finished work at the clock.
 *
 * 7 days sits ~7x above anything this system has produced, which is the whole
 * point: it can never be the rule that ends real work, and a runaway is still
 * noticed within a week instead of never.
 *
 * What actually catches a hang is the heartbeat sidecar: it renews the lease
 * only while stdout/stderr bytes or output-dir mtimes advance, and stops when
 * they do not. The lease then expires and the supervisor sweeps the run,
 * DEFAULT_LEASE_SEC after the last sign of life, regardless of how long the
 * run was allowed to live.
 *
 * Unledgered calls keep the historical no-timeout behavior (see timeoutMs).
 */
export const LEDGER_DEFAULT_TIMEOUT_MS = 7 * 24 * 60 * 60_000;

/**
 * How long a ledgered run stays leased after its last observed activity — the
 * window that actually decides whether a run is alive, and therefore the one
 * the measurement has to size.
 *
 * It was 600s. Ten minutes of silence is inside the normal behaviour of a
 * working agent: of the 123,318 intra-turn gaps measured across this machine's
 * transcripts, 0.45% exceed ten minutes, and the code that supervises the
 * AGENTIC path already says so in its own comment ("a squad legitimately
 * thinks for ten minutes between writes", AGENTIC_LEASE_SEC = 1800). The
 * scripted path was left on the tighter window, so a long-thinking child had
 * its lease expire while it worked and the supervisor read it as orphaned.
 *
 * Now the same 45 minutes the light layer tolerates: one number for "how long
 * silence is allowed to mean nothing", whichever layer is asking.
 */
export const DEFAULT_LEASE_SEC = DEFAULT_INACTIVITY_BUDGET_MS / 1000;

/** Effective timeout for a run: explicit timeoutMs always wins; a ledgered
 * run without one gets LEDGER_DEFAULT_TIMEOUT_MS; otherwise none. Exported
 * for tests. */
export function resolveLedgerTimeoutMs(opts: Pick<RunHeadlessOpts, "timeoutMs" | "ledger">): number | undefined {
  if (typeof opts.timeoutMs === "number") return opts.timeoutMs;
  return opts.ledger?.runId ? LEDGER_DEFAULT_TIMEOUT_MS : undefined;
}

export interface RunHeadlessResult {
  ok: boolean;
  runtime: Runtime;
  sessionId: string | null;
  result: string;
  /** Native USD figure reported by the CLI itself. null = not reported. */
  costUsd: number | null;
  /** The CLI's own result subtype when its output format carries one (claude-code:
   * `success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution`).
   * A caller that set `maxBudgetUsd` reads `error_max_budget_usd` here to tell a
   * spent cap from any other failure. Absent on runtimes without the field. */
  resultSubtype?: string;
  /** True when the CLI's output format carries NO native USD figure for this
   * run — "cost unknown", explicitly distinct from a reported $0. Downstream
   * (spend-tracker / cost-estimator) may still ESTIMATE from token counts;
   * this flag only states the CLI did not say. */
  costUnavailable?: boolean;
  exitCode: number;
  stderr: string;
  durationMs: number;
  error?: string;
}

/** Conservative allowlist used only when the caller asks for safe mode
 * (--safe). Default trust mode passes NO allowlist (all tools available). */
export const DEFAULT_ALLOWED_TOOLS = ["Write", "Edit", "Read", "Glob", "Grep", "WebSearch", "WebFetch"];

// ── managed (ledgered) child spawn ────────────────────────────────────────
// runHeadless is synchronous by design (spawnSync), which means the event
// loop is BLOCKED while the child runs — no in-process timer can ever fire.
// The async light layer's dangling-timer bug class is therefore avoided
// structurally: the heartbeat lives in a detached sidecar PROCESS
// (harness/lib/run-ledger.ts heartbeat) instead of in timers. To let that
// sidecar observe stdout/stderr growth mid-run, a ledgered spawn redirects
// the child's output to capture files (read back after exit for result
// parsing).

interface ManagedSpawnCtx { outFile: string; errFile: string }
let managedCtx: ManagedSpawnCtx | null = null;

/** All runners spawn their child through this. Pass-through to spawnSync when
 * unledgered (zero behavior change); with an active ledger context, stdout/
 * stderr go to capture files the heartbeat sidecar watches.
 *
 * env note: Node snapshots the LIVE process.env at spawn time; Bun instead
 * inherits the process's ORIGINAL environment, ignoring runtime mutations.
 * Passing the live process.env explicitly restores Node semantics (and lets
 * hermetic tests inject a fake runtime binary via PATH). */
function driverSpawnSync(cmd: string, args: string[], options: SpawnSyncOptions & { encoding: "utf8" }): SpawnSyncReturns<string> {
  // Every runtime adapter reaches the OS through here, so Windows `.cmd`
  // resolution belongs here too — sixteen call sites, one rule. No-op on POSIX.
  const exec = resolveExecutable(cmd);
  cmd = exec.command;
  args = exec.args(args);
  options = { env: { ...process.env }, ...(exec.shell ? { shell: true } : {}), ...options };
  if (!managedCtx) return spawnSync(cmd, args, options) as SpawnSyncReturns<string>;
  // "w" truncates between attempts (some runners retry without a flag); the
  // sidecar treats ANY size change as activity, so truncation is safe.
  const outFd = fs.openSync(managedCtx.outFile, "w");
  const errFd = fs.openSync(managedCtx.errFile, "w");
  try {
    // `input` (when given) overrides stdio[0] per Node semantics.
    const r = spawnSync(cmd, args, { ...options, stdio: ["pipe", outFd, errFd] }) as SpawnSyncReturns<string>;
    let stdout = "";
    let stderr = "";
    try { stdout = fs.readFileSync(managedCtx.outFile, "utf8"); } catch { /* keep "" */ }
    try { stderr = fs.readFileSync(managedCtx.errFile, "utf8"); } catch { /* keep "" */ }
    return { ...r, stdout, stderr };
  } finally {
    try { fs.closeSync(outFd); } catch { /* already closed */ }
    try { fs.closeSync(errFd); } catch { /* already closed */ }
  }
}

/** Wraps a runner call with the heartbeat sidecar + capture files. EVERY exit
 * path (return or throw) stops the sidecar and removes the temp dir — the
 * managed equivalent of "clear all timers". */
function runWithLedgerHeartbeat(opts: RunHeadlessOpts, runner: (o: RunHeadlessOpts) => RunHeadlessResult): RunHeadlessResult {
  const led = opts.ledger!;
  const effective: RunHeadlessOpts = { ...opts, timeoutMs: resolveLedgerTimeoutMs(opts) };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-hb-"));
  const outFile = path.join(tmpDir, "child-stdout.log");
  const errFile = path.join(tmpDir, "child-stderr.log");
  const doneFile = path.join(tmpDir, "done");
  fs.writeFileSync(outFile, "");
  fs.writeFileSync(errFile, "");

  // run-ledger.ts lives in the harness skill; resolve relative to THIS module
  // so both the repo tree and installed copies find it.
  const runLedgerPath = path.join(import.meta.dir, "..", "..", "harness", "lib", "run-ledger.ts");
  const sidecarArgs = [
    runLedgerPath, "heartbeat",
    "--run-id", led.runId,
    "--out", outFile, "--err", errFile, "--done", doneFile,
    "--interval", String(led.intervalMs ?? 15_000),
    "--stall", String(opts.stallBudgetMs ?? resolveSetting("supervisor.stall_threshold_ms").value),
    "--lease", String(led.leaseSec ?? DEFAULT_LEASE_SEC),
    "--parent", String(process.pid),
  ];
  if (led.watchDir) {
    sidecarArgs.push("--watch", led.watchDir);
    sidecarArgs.push("--touch-max", String(led.touchEventsMax ?? resolveSetting("supervisor.touch_events_max").value));
  }
  if (led.dbPath) sidecarArgs.push("--db", led.dbPath);

  let sidecarPid: number | null = null;
  try {
    // Live env (not Bun's original-env snapshot) so audit/state paths set at
    // runtime reach the sidecar.
    const sc = spawn(process.execPath, sidecarArgs, { detached: true, stdio: "ignore", env: { ...process.env } });
    sc.unref();
    sidecarPid = sc.pid ?? null;
  } catch (e) {
    console.error(`[run-ledger] heartbeat sidecar failed to start: ${(e as Error)?.message ?? e}`);
  }

  managedCtx = { outFile, errFile };
  try {
    return runner(effective);
  } finally {
    managedCtx = null;
    // Belt and suspenders: sentinel (sidecar polls it) + SIGTERM + cleanup.
    try { fs.writeFileSync(doneFile, "done"); } catch { /* best-effort */ }
    if (sidecarPid) { try { process.kill(sidecarPid, "SIGTERM"); } catch { /* already gone */ } }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ── per-runtime headless runners ──────────────────────────────────────────

// FAILURE CONTRACT (defect: pi-style exit-0-on-provider-failure, generalized):
// a turn that failed upstream must never report ok:true. Every adapter that
// emits a machine-readable envelope verifies it beyond the exit code. What
// "failure" looks like, per adapter:
//   claude-code: single JSON object, `is_error: true` (subtype carries the
//     class, e.g. error_max_turns) — exit code may still be 0.
//   codex: JSONL event stream; a terminal `error` event or `turn.failed`
//     with no subsequent `turn.completed` (a later completed turn = internal
//     retry succeeded, clears the failure).
//   gemini-cli / qwen-code: single JSON object; an `error` field in the
//     envelope marks a failed run even on exit 0.
//   antigravity-cli: single JSON object; `is_error: true` or an `error`
//     field.
//   kimi-cli: NDJSON stream; an `error` event or a terminal `result` event
//     with `is_error: true` (a result with is_error:false clears earlier
//     error events — internal retry).
//   grok-cli: single JSON object; `is_error: true` or an `error` field.
//   pi: JSONL stream; assistant `message_end` with `stopReason: "error"` /
//     `errorMessage` (a later successful turn clears it).
//   opencode: no machine envelope verified — exit code is the only signal.

/** Message extracted from an envelope `error` field (string or object). */
function envelopeErrorMessage(err: unknown): string | null {
  if (err == null) return null;
  if (typeof err === "string") return err.trim() || "runtime reported an error";
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    const msg = o.message ?? o.msg ?? o.detail;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
    try { return JSON.stringify(err).slice(0, 300); } catch { return "runtime reported an error"; }
  }
  return String(err);
}

function runClaudeCode(opts: RunHeadlessOpts): RunHeadlessResult {
  const started = Date.now();
  const args: string[] = ["-p", "--output-format", "json"];

  if (opts.sessionId) args.push("--resume", opts.sessionId);
  // Model: caller's explicit value > system model (what the user's session
  // runs) > CLI default. Without this, the child `claude -p` falls to the
  // default (sonnet) instead of inheriting the interactive session's fable/opus.
  const ccModel = opts.model ?? resolveSystemModel("claude-code");
  if (ccModel) args.push("--model", ccModel);

  // Trust by default. EXPLICIT caller settings (allowedTools / permissionMode)
  // always take precedence — so focused text-only calls like the brief-proxy or
  // the team-orchestrator director can lock down permissions without the trust
  // default overriding them.
  const safe = opts.yolo === false;
  const explicitTools = opts.allowedTools !== undefined;
  const explicitPerm = opts.permissionMode !== undefined;

  if (explicitTools) {
    if (opts.allowedTools!.length > 0) args.push("--allowedTools", opts.allowedTools!.join(" "));
    // length === 0 → caller asked for "no tools": skip the flag and let
    // permissionMode govern (default mode denies tool calls in headless).
  } else if (safe) {
    args.push("--allowedTools", DEFAULT_ALLOWED_TOOLS.join(" "));
  }

  if (explicitPerm) {
    args.push("--permission-mode", opts.permissionMode!);
  } else if (safe) {
    args.push("--permission-mode", "acceptEdits");
  } else {
    args.push("--dangerously-skip-permissions");
  }

  if (typeof opts.maxBudgetUsd === "number") args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  for (const d of opts.addDirs ?? []) args.push("--add-dir", d);

  // The directive goes LAST, and under a shell it does not go through argv at all
  // (claudeDirectiveArgs). Defence in depth: the file delivery is the cure, and last
  // position means that even a runtime whose CLI lacks the file flag can only ever lose
  // the tail of the directive — never an `--add-dir` grant or the permission mode, which
  // is what a 6251-character command line silently dropped before this.
  const directive = claudeDirectiveArgs(opts.appendSystemPrompt ?? "", resolveExecutable("claude").shell);
  args.push(...directive.args);

  let r!: SpawnSyncReturns<string>;
  try {
    r = driverSpawnSync("claude", args, {
      cwd: opts.cwd,
      input: opts.prompt,
      encoding: "utf8",
      ...(typeof opts.timeoutMs === "number" ? { timeout: opts.timeoutMs } : {}),
      maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    removeTmpFiles(directive.tmpFiles);
  }

  const durationMs = Date.now() - started;
  const exitCode = r.status ?? (r.signal ? 124 : 1);
  const stdout = r.stdout || "";
  const stderr = (r.stderr || "").trim();

  // claude --output-format json prints a single JSON object:
  // { type:"result", subtype, is_error, result, session_id, total_cost_usd, ... }
  let sessionId: string | null = null;
  let result = "";
  let costUsd: number | null = null;
  let resultSubtype: string | undefined;
  let isError = exitCode !== 0;
  try {
    const parsed = JSON.parse(stdout.trim());
    sessionId = parsed.session_id ?? null;
    result = typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result ?? "");
    costUsd = typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null;
    if (typeof parsed.subtype === "string") resultSubtype = parsed.subtype;
    if (typeof parsed.is_error === "boolean") isError = isError || parsed.is_error;
  } catch {
    // Non-JSON stdout (e.g. early crash). Keep raw for diagnostics.
    result = stdout.trim();
  }

  return {
    ok: !isError && exitCode === 0,
    runtime: "claude-code",
    sessionId,
    result,
    costUsd,
    ...(costUsd === null ? { costUnavailable: true } : {}),
    ...(resultSubtype !== undefined ? { resultSubtype } : {}),
    exitCode,
    stderr,
    durationMs,
    error: isError ? salientError(stderr, "runtime returned an error verdict") : undefined,
  };
}

// codex / gemini lack a --append-system-prompt flag, so we fold the directive
// into the user prompt as a preamble for those runtimes.
function withPreamble(opts: RunHeadlessOpts): string {
  return opts.appendSystemPrompt ? `${opts.appendSystemPrompt}\n\n---\n\n${opts.prompt}` : opts.prompt;
}

// Codex CLI (codex exec). Writes deliverables under cwd via the workspace-write
// sandbox. Resume is a subcommand (`codex exec resume <id>`). Session id is
// scraped best-effort from the --json event stream; if it can't be captured,
// the run still completes but `nrv revise` for that project won't resume.
// Prompt via STDIN (verified `codex exec --help`: no positional → stdin).
// Cost: codex reports TOKEN COUNTS in turn.completed events, never a USD
// figure → costUnavailable (the cost-estimator prices the tokens downstream).
function runCodex(opts: RunHeadlessOpts): RunHeadlessResult {
  const started = Date.now();
  const lastMsg = path.join(os.tmpdir(), `codex-last-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const base = opts.sessionId
    ? ["exec", "resume", opts.sessionId]
    : ["exec"];
  const args = [...base, "--json", "--skip-git-repo-check", "-C", opts.cwd, "-o", lastMsg];
  const cxModel = opts.model ?? resolveSystemModel("codex");
  if (cxModel) args.push("--model", cxModel);
  if (opts.providerHint) args.push("--provider", opts.providerHint);
  // Trust by default; --safe (opts.yolo===false) → workspace-write sandbox.
  if (opts.yolo === false) args.push("-s", "workspace-write");
  else args.push("--dangerously-bypass-approvals-and-sandbox");

  const r = driverSpawnSync("codex", args, {
    cwd: opts.cwd,
    input: withPreamble(opts),
    encoding: "utf8",
    ...(typeof opts.timeoutMs === "number" ? { timeout: opts.timeoutMs } : {}),
    maxBuffer: 64 * 1024 * 1024,
  });

  const durationMs = Date.now() - started;
  const exitCode = r.status ?? (r.signal ? 124 : 1);
  const stderr = (r.stderr || "").trim();

  let sessionId: string | null = opts.sessionId ?? null;
  let streamError: string | null = null;
  for (const line of (r.stdout || "").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t);
      sessionId = j.session_id || j.thread_id || j.conversation_id || j?.session?.id || j?.msg?.session_id || sessionId;
      // Failure contract: exit 0 does not mean the turn succeeded. Terminal
      // `error` events / `turn.failed` mark failure; a LATER turn.completed
      // (codex-internal retry) clears it.
      const evType = j.type ?? j?.msg?.type;
      if (evType === "error") {
        streamError = envelopeErrorMessage(j.message ?? j?.msg?.message ?? j) || "codex stream error event";
      } else if (evType === "turn.failed") {
        streamError = envelopeErrorMessage(j.error ?? j?.msg?.error) || "codex turn failed";
      } else if (evType === "turn.completed") {
        streamError = null;
      }
    } catch { /* not a json line */ }
  }
  let lastMsgContent = "";
  try { lastMsgContent = fs.readFileSync(lastMsg, "utf8"); } catch { /* ignore */ }
  try { fs.rmSync(lastMsg, { force: true }); } catch { /* ignore */ }

  // Result is the agent's final message FOLLOWED BY the JSONL event stream.
  // The stream carries `turn.completed.usage` events that the cost-estimator
  // needs (input_tokens, output_tokens). Concatenating preserves both.
  const result = (lastMsgContent || "").trim()
    + ((lastMsgContent && r.stdout) ? "\n\n--- codex event stream ---\n" : "")
    + ((r.stdout || "").trim());

  const ok = exitCode === 0 && streamError === null;
  return {
    ok, runtime: "codex", sessionId, result,
    costUsd: null, costUnavailable: true, exitCode, stderr, durationMs,
    error: ok ? undefined : (streamError || salientError(stderr, "codex exec failed")),
  };
}

// Gemini CLI. We set a known --session-id on first run so revise can resume it
// deterministically with -r. auto_edit auto-approves file writes (yolo = all).
// Prompt via STDIN (verified `gemini --help`: "-p ... Appended to input on
// stdin (if any)") — `-p ""` keeps headless mode, content rides stdin, argv
// stays small no matter the prompt size.
function runGemini(opts: RunHeadlessOpts): RunHeadlessResult {
  const started = Date.now();
  const sid = opts.sessionId || randomUUID();
  const args = ["-p", "", "-o", "json", "--skip-trust"];
  if (opts.sessionId) args.push("-r", opts.sessionId);
  else args.push("--session-id", sid);
  const gmModel = opts.model ?? resolveSystemModel("gemini-cli");
  if (gmModel) args.push("--model", gmModel);
  // Trust by default (--yolo); --safe (opts.yolo===false) → auto_edit.
  args.push("--approval-mode", opts.yolo === false ? "auto_edit" : "yolo");

  const r = driverSpawnSync("gemini", args, {
    cwd: opts.cwd,
    input: withPreamble(opts),
    encoding: "utf8",
    ...(typeof opts.timeoutMs === "number" ? { timeout: opts.timeoutMs } : {}),
    maxBuffer: 64 * 1024 * 1024,
  });

  const durationMs = Date.now() - started;
  const exitCode = r.status ?? (r.signal ? 124 : 1);
  const stderr = (r.stderr || "").trim();

  const rawStdout = (r.stdout || "").trim();
  let sessionId: string | null = sid;
  let envelopeError: string | null = null;
  let costUsd: number | null = null;
  try {
    const j = JSON.parse(rawStdout);
    sessionId = j.session_id || j.sessionId || sid;
    // Failure contract: an `error` field in the envelope = failed run even
    // when the process exits 0.
    if (j.error != null) envelopeError = envelopeErrorMessage(j.error);
    if (typeof j.total_cost_usd === "number" && Number.isFinite(j.total_cost_usd)) costUsd = j.total_cost_usd;
  } catch { /* keep sid */ }
  // CRITICAL: keep the FULL JSON stdout in result, not just j.response — the
  // cost-estimator needs the `stats.models.*.tokens` block to compute spend.
  // Slicing to j.response throws that data away and forces $0 tracking.
  const result = rawStdout;

  const ok = exitCode === 0 && envelopeError === null;
  return {
    ok, runtime: "gemini-cli", sessionId, result,
    costUsd, ...(costUsd === null ? { costUnavailable: true } : {}),
    exitCode, stderr, durationMs,
    error: ok ? undefined : (envelopeError || salientError(stderr, "gemini failed")),
  };
}

// Antigravity CLI (`agy`). Replaces gemini-cli for consumer tier after 2026-06-18.
// Same Google backend (Gemini models), different binary + flag conventions.
// Prompt delivery: `agy --help` (audited 2026-08-06) documents NO stdin
// channel and NO prompt-file flag — argv for small prompts, temp-file
// bootstrap above MAX_ARGV_PROMPT_BYTES. Note: the bootstrap needs the child
// to READ the file, so in --safe mode (no skip-permissions) a large-prompt
// run can block on approval — a pre-existing agy constraint (headless agy
// without the skip flag halts anyway).
function runAntigravity(opts: RunHeadlessOpts): RunHeadlessResult {
  const started = Date.now();
  const sid = opts.sessionId || randomUUID();
  // agy headless: -p / --print / --prompt all accept the prompt as argv value.
  // Output formats: "json" (single object) or "stream-json" (NDJSON events).
  // We use single-object json for parity with runGemini/runClaudeCode.
  // Resume = --continue (most recent conversation); we can't set our own id
  // upfront. Autonomy = --dangerously-skip-permissions (without it agy hangs
  // waiting for approval).
  //
  // --output-format json: under non-TTY, `agy -p` in TEXT mode can drop the
  // final response from stdout (documented terminal-render bug); JSON does not
  // suffer from it. Old builds do NOT have the flag (confirmed via --help on
  // installed versions) — if the spawn fails with a flag error, retry without it.
  const delivery = argvOrPromptFile(withPreamble(opts), (p) => ["-p", p]);
  const args = [...delivery.args, "--output-format", "json"];
  if (opts.sessionId) args.push("--continue");
  const agyModel = opts.model ?? resolveSystemModel("antigravity-cli");
  if (agyModel) args.push("--model", agyModel);
  if (opts.yolo !== false) args.push("--dangerously-skip-permissions");
  for (const d of opts.addDirs ?? []) args.push("--add-dir", d);

  const spawnOpts = {
    cwd: opts.cwd,
    encoding: "utf8" as const,
    ...(typeof opts.timeoutMs === "number" ? { timeout: opts.timeoutMs } : {}),
    maxBuffer: 64 * 1024 * 1024,
  };
  let r!: SpawnSyncReturns<string>;
  try {
    r = driverSpawnSync("agy", args, spawnOpts);
    if ((r.status ?? 1) !== 0 && /output[- ]format|unknown|unrecognized|invalid (option|flag|argument)/i.test(r.stderr || "")) {
      const i = args.indexOf("--output-format");
      r = driverSpawnSync("agy", [...args.slice(0, i), ...args.slice(i + 2)], spawnOpts);
    }
  } finally {
    removeTmpFiles(delivery.tmpFiles);
  }

  const durationMs = Date.now() - started;
  const exitCode = r.status ?? (r.signal ? 124 : 1);
  const stderr = (r.stderr || "").trim();

  const rawStdout = (r.stdout || "").trim();
  let sessionId: string | null = sid;
  let result = rawStdout;
  let envelopeError: string | null = null;
  let costUsd: number | null = null;
  try {
    const j = JSON.parse(rawStdout);
    sessionId = j.session_id || j.sessionId || j.conversation_id || sid;
    // JSON format (new builds): the response comes in a field; text (old
    // builds): the whole stdout IS the response.
    if (typeof j.response === "string") result = j.response;
    else if (typeof j.result === "string") result = j.result;
    // Failure contract: is_error / error in the envelope = failed run.
    if (j.is_error === true) envelopeError = envelopeErrorMessage(j.error) || "agy returned is_error";
    else if (j.error != null) envelopeError = envelopeErrorMessage(j.error);
    if (typeof j.total_cost_usd === "number" && Number.isFinite(j.total_cost_usd)) costUsd = j.total_cost_usd;
  } catch { /* plain text — keep the whole stdout */ }

  const ok = exitCode === 0 && envelopeError === null;
  return {
    ok, runtime: "antigravity-cli", sessionId, result,
    costUsd, ...(costUsd === null ? { costUnavailable: true } : {}),
    exitCode, stderr, durationMs,
    error: ok ? undefined : (envelopeError || salientError(stderr, "agy failed")),
  };
}

// Kimi Code CLI (`kimi`, MoonshotAI/kimi-code). Open-weight Moonshot models
// (K2.x / K3), 1M context, agentic-coding-first. Free + agentic when authed
// with a Kimi.com account via `kimi` → `/login` (OAuth, no API key); paid via
// a `[providers.*]` type="openai" block in ~/.kimi-code/config.toml pointing at
// api.moonshot.ai or OpenRouter. The free OAuth tier reports no per-call spend
// → costUnavailable unless a result event carries total_cost_usd.
//
// Headless: `kimi -p <prompt>` is one-shot (no TUI); the model is picked with
// `-m <id>` (e.g. `k3`). We ask for `--output-format stream-json` (NDJSON) —
// like agy's stream-json it survives non-TTY spawns where plain-text render can
// drop the final line. Old builds may lack the flag → retry without it (stdout
// then carries the plain assistant text). The model comes ONLY from the cascade
// entry (`kimi-cli:k3`), never hardcoded — engine stays model-agnostic.
// Prompt delivery: no stdin or prompt-file flag documented (binary not
// auditable here) — argv for small prompts, temp-file bootstrap above
// MAX_ARGV_PROMPT_BYTES.
function runKimi(opts: RunHeadlessOpts): RunHeadlessResult {
  const started = Date.now();
  const sid = opts.sessionId || randomUUID();
  const delivery = argvOrPromptFile(withPreamble(opts), (p) => ["-p", p]);
  const args = [...delivery.args, "--output-format", "stream-json"];
  const kmModel = opts.model ?? resolveSystemModel("kimi-cli");
  if (kmModel) args.push("-m", kmModel);

  const spawnOpts = {
    cwd: opts.cwd,
    encoding: "utf8" as const,
    ...(typeof opts.timeoutMs === "number" ? { timeout: opts.timeoutMs } : {}),
    maxBuffer: 64 * 1024 * 1024,
  };
  let r!: SpawnSyncReturns<string>;
  try {
    r = driverSpawnSync("kimi", args, spawnOpts);
    if ((r.status ?? 1) !== 0 && /output[- ]format|unknown|unrecognized|invalid (option|flag|argument)/i.test(r.stderr || "")) {
      const i = args.indexOf("--output-format");
      r = driverSpawnSync("kimi", [...args.slice(0, i), ...args.slice(i + 2)], spawnOpts);
    }
  } finally {
    removeTmpFiles(delivery.tmpFiles);
  }

  const durationMs = Date.now() - started;
  const exitCode = r.status ?? (r.signal ? 124 : 1);
  const stderr = (r.stderr || "").trim();
  const rawStdout = (r.stdout || "").trim();

  // stream-json = NDJSON events. Extract the assistant's final text defensively
  // (schema varies by build), accumulating any assistant-content field; if the
  // output isn't NDJSON (plain-text fallback path) keep the whole stdout.
  let sessionId: string | null = sid;
  let assistant = "";
  let sawJson = false;
  let streamError: string | null = null;
  let costUsd: number | null = null;
  for (const line of rawStdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t);
      sawJson = true;
      sessionId = j.session_id || j.sessionId || j.conversation_id || j?.session?.id || sessionId;
      // Failure contract: an `error` event marks failure; a terminal `result`
      // event is authoritative (is_error true = fail; false clears earlier
      // error events — internal retry succeeded).
      if (j.type === "error") {
        streamError = envelopeErrorMessage(j.message ?? j.error ?? j) || "kimi stream error event";
      } else if (j.type === "result") {
        if (j.is_error === true) streamError = envelopeErrorMessage(j.error ?? j.result) || "kimi returned is_error";
        else if (j.is_error === false) streamError = null;
        if (typeof j.total_cost_usd === "number" && Number.isFinite(j.total_cost_usd)) costUsd = j.total_cost_usd;
      }
      const piece = typeof j.text === "string" ? j.text
        : typeof j.content === "string" ? j.content
        : typeof j.response === "string" ? j.response
        : typeof j.message === "string" ? j.message
        : typeof j?.delta?.text === "string" ? j.delta.text
        : typeof j?.message?.content === "string" ? j.message.content
        : "";
      if (piece) assistant += piece;
    } catch { /* not a json line */ }
  }
  const result = (sawJson && assistant) ? assistant.trim() : rawStdout;

  const ok = exitCode === 0 && streamError === null;
  return {
    ok, runtime: "kimi-cli", sessionId, result,
    costUsd, ...(costUsd === null ? { costUnavailable: true } : {}),
    exitCode, stderr, durationMs,
    error: ok ? undefined : (streamError || salientError(stderr, "kimi failed")),
  };
}

// Grok Build CLI (`grok`, xAI). Agentic coding + native media gen (image/i2v).
// Two auth rails: (A) `grok` subscription login ($0 marginal, same rail the
// grok-studio-nirvana squad uses) or (B) xAI API via XAI_API_KEY (pay-per-token).
// Model comes ONLY from the cascade entry (`grok-cli:<model>`) — engine stays
// model-agnostic. Cost comes from the JSON itself (`total_cost_usd`) when the
// build reports it; on the subscription rail it may come absent/zero →
// costUnavailable when absent.
//
// Prompt delivery: native `--prompt-file <PATH>` ("Single-turn prompt from a
// file", verified `grok --help` 2026-08-06) — lossless at any prompt size.
// `--always-approve` auto-approves tool executions (without it a headless run
// hangs waiting for approval) — it is the DOCUMENTED flag; `--yolo` is only a
// hidden alias that vanishes without notice between builds. `--output-format
// json` returns a single object (real keys: text/sessionId/total_cost_usd).
// Old builds may lack `--output-format` (retry without it) or even
// `--prompt-file` (retry with -p argv — small prompts only at that point).
function runGrok(opts: RunHeadlessOpts): RunHeadlessResult {
  const started = Date.now();
  const sid = opts.sessionId || randomUUID();
  const merged = withPreamble(opts);
  const promptFile = writePromptFile(merged);
  const buildArgs = (delivery: string[], withFormat: boolean): string[] => {
    const a = [...delivery, ...(withFormat ? ["--output-format", "json"] : []), "--cwd", opts.cwd];
    if (opts.yolo !== false) a.push("--always-approve");
    const gkModel = opts.model ?? resolveSystemModel("grok-cli");
    if (gkModel) a.push("-m", gkModel);
    return a;
  };

  const spawnOpts = {
    cwd: opts.cwd,
    encoding: "utf8" as const,
    ...(typeof opts.timeoutMs === "number" ? { timeout: opts.timeoutMs } : {}),
    maxBuffer: 64 * 1024 * 1024,
  };
  const flagError = (res: SpawnSyncReturns<string>): boolean =>
    (res.status ?? 1) !== 0 && /unknown|unrecognized|unexpected|invalid (option|flag|argument)/i.test(res.stderr || "");
  let r!: SpawnSyncReturns<string>;
  try {
    let delivery = ["--prompt-file", promptFile];
    r = driverSpawnSync("grok", buildArgs(delivery, true), spawnOpts);
    if (flagError(r) && /prompt[- ]file/i.test(r.stderr || "")) {
      // Very old build without --prompt-file → argv fallback (ARG_MAX-unsafe
      // above MAX_ARGV_PROMPT_BYTES, but the flagless build leaves no choice).
      delivery = ["-p", merged];
      r = driverSpawnSync("grok", buildArgs(delivery, true), spawnOpts);
    }
    if (flagError(r) && /output[- ]format/i.test(r.stderr || "")) {
      r = driverSpawnSync("grok", buildArgs(delivery, false), spawnOpts);
    }
  } finally {
    removeTmpFiles([promptFile]);
  }

  const durationMs = Date.now() - started;
  const exitCode = r.status ?? (r.signal ? 124 : 1);
  const stderr = (r.stderr || "").trim();
  const rawStdout = (r.stdout || "").trim();

  // --output-format json = single object; parse defensively (schema varies by
  // build), else keep the whole stdout (plain-text fallback path).
  let sessionId: string | null = sid;
  let result = rawStdout;
  let costUsd: number | null = null;
  let envelopeError: string | null = null;
  try {
    const j = JSON.parse(rawStdout);
    sessionId = j.session_id || j.sessionId || j.conversation_id || j?.session?.id || sid;
    if (typeof j.response === "string") result = j.response;
    else if (typeof j.result === "string") result = j.result;
    else if (typeof j.output === "string") result = j.output;
    else if (typeof j.text === "string") result = j.text;
    // Failure contract: is_error / error in the envelope = failed run.
    if (j.is_error === true) envelopeError = envelopeErrorMessage(j.error) || "grok returned is_error";
    else if (j.error != null) envelopeError = envelopeErrorMessage(j.error);
    const cost = j.total_cost_usd ?? j.totalCostUsd ?? j.cost_usd;
    if (typeof cost === "number" && Number.isFinite(cost)) costUsd = cost;
  } catch { /* plain text — keep stdout */ }

  const ok = exitCode === 0 && envelopeError === null;
  return {
    ok, runtime: "grok-cli", sessionId, result,
    costUsd, ...(costUsd === null ? { costUnavailable: true } : {}),
    exitCode, stderr, durationMs,
    error: ok ? undefined : (envelopeError || salientError(stderr, "grok failed")),
  };
}

// Pi Coding Agent (`pi`, Earendil — pi.dev). Minimalist multi-provider
// harness: ONE runtime gives access to 15+ providers (Anthropic, OpenAI,
// Google, Bedrock, Groq, xAI, OpenRouter…) AND to LOCAL MODELS (Ollama,
// llama.cpp, LM Studio, vLLM — custom providers in ~/.pi/agent/models.json).
// Model and provider come ONLY from the LLM_CASCADE `pi:<model>@<provider>`
// entry — never hardcoded; the @provider becomes the native `--provider`
// (pi is, with codex, the only runtime that truly honors providerHint).
//
// Headless (VERIFIED against `pi 0.82.1` on 2026-07-28): `pi -p --mode json
// "<prompt>"` — JSONL event stream on stdout: header {"type":"session","id":
// "<uuid>", ...} and the assistant text in `message_end` events with
// message.content = [{type:"text",text}]. Deterministic session via
// `--session-id <uuid>` ("exact project session ID, creating it if missing")
// — same pattern as runGemini: we generate the id on the 1st run and `nrv
// revise` resumes with the SAME id. `--append-system-prompt` exists (the
// directive goes as a REAL system prompt, not folded into the user prompt).
//
// Prompt delivery: `pi --help` (audited 2026-08-06) documents no stdin, but
// `pi [options] [@files...] [messages...]` — @file attachments are native.
// Small prompts stay argv; above MAX_ARGV_PROMPT_BYTES the prompt rides an
// attached temp file plus a short pointer message.
//
// Confirmed QUIRK: pi exits with EXIT 0 even when the provider fails — the
// error comes in the stream (message.stopReason === "error" +
// message.errorMessage, e.g. 403 "used all available credits"). ok/error come
// from the STREAM, not just the exit code. Real cost comes in
// message.usage.cost.total (summed per assistant turn).
//
// No permission popups by design; `-a/--approve` trusts the project's LOCAL
// FILES (extensions/settings — without a TTY there is no way to answer the
// trust prompt) and `--safe` uses `-na/--no-approve`. Old builds without
// `--mode` → retry in plain print mode `-p` (text on stdout).
function runPi(opts: RunHeadlessOpts): RunHeadlessResult {
  const started = Date.now();
  const sid = opts.sessionId || randomUUID();
  const flags: string[] = ["--session-id", sid];
  if (opts.appendSystemPrompt) flags.push("--append-system-prompt", opts.appendSystemPrompt);
  const piModel = opts.model ?? resolveSystemModel("pi");
  if (piModel) flags.push("--model", piModel);
  if (opts.providerHint) flags.push("--provider", opts.providerHint);
  flags.push(opts.yolo === false ? "--no-approve" : "--approve");

  let promptArgs: string[] = [opts.prompt];
  let tmpFiles: string[] | undefined;
  if (Buffer.byteLength(opts.prompt, "utf8") > MAX_ARGV_PROMPT_BYTES) {
    const f = writePromptFile(opts.prompt);
    tmpFiles = [f];
    promptArgs = [`@${f}`, "The attached file contains the complete task prompt. Execute every instruction in it exactly as if its contents had been sent as this message."];
  }

  const spawnOpts = {
    cwd: opts.cwd,
    encoding: "utf8" as const,
    ...(typeof opts.timeoutMs === "number" ? { timeout: opts.timeoutMs } : {}),
    maxBuffer: 64 * 1024 * 1024,
  };
  let r!: SpawnSyncReturns<string>;
  try {
    r = driverSpawnSync("pi", ["-p", "--mode", "json", ...flags, ...promptArgs], spawnOpts);
    if ((r.status ?? 1) !== 0 && /--mode|unknown|unrecognized|invalid (option|flag|argument)/i.test(r.stderr || "")) {
      r = driverSpawnSync("pi", ["-p", ...flags, ...promptArgs], spawnOpts);
    }
  } finally {
    removeTmpFiles(tmpFiles);
  }

  const durationMs = Date.now() - started;
  const exitCode = r.status ?? (r.signal ? 124 : 1);
  const stderr = (r.stderr || "").trim();
  const rawStdout = (r.stdout || "").trim();

  // JSONL events: session id from the header, LAST assistant text from the
  // message_end events (the final answer), stream error and summed cost. If
  // stdout is not JSONL (print-mode fallback), keep the whole stdout as result.
  let sessionId: string | null = sid;
  let assistant = "";
  let sawJson = false;
  let costUsd: number | null = null;
  let streamError: string | null = null;
  for (const line of rawStdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t);
      sawJson = true;
      if (j.type === "session") { sessionId = j.id || j.session_id || sessionId; continue; }
      const msg = j.message;
      if (j.type === "message_end" && msg && msg.role === "assistant") {
        let text = "";
        if (typeof msg.content === "string") text = msg.content;
        else if (Array.isArray(msg.content)) {
          text = msg.content
            .map((b: any) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : ""))
            .join("");
        }
        if (text.trim()) assistant = text; // last assistant wins
        // Exit 0 does not mean success: the provider error comes in the turn
        // itself. A later successful turn (pi-internal retry) clears the error.
        if (msg.stopReason === "error" || typeof msg.errorMessage === "string") {
          streamError = msg.errorMessage || "pi assistant turn ended with stopReason=error";
        } else {
          streamError = null;
        }
        const cost = msg?.usage?.cost?.total;
        if (typeof cost === "number" && Number.isFinite(cost)) costUsd = (costUsd ?? 0) + cost;
      }
    } catch { /* not a json line */ }
  }
  const result = (sawJson && assistant) ? assistant.trim() : rawStdout;
  const ok = exitCode === 0 && streamError === null;

  return {
    ok, runtime: "pi", sessionId, result,
    costUsd, ...(costUsd === null ? { costUnavailable: true } : {}),
    exitCode, stderr, durationMs,
    error: ok ? undefined : (streamError || salientError(stderr, "pi failed")),
  };
}

// qwen-code (`qwen`) — gemini-cli fork; stdin + `-p` follow the parent CLI's
// documented semantics ("-p ... appended to input on stdin"). Binary not
// auditable here, so flags stay minimal; unrecognized approval-mode flags
// retry without them. No session flags until verified → sessionId null (no
// resume). No native USD figure → costUnavailable.
function runQwen(opts: RunHeadlessOpts): RunHeadlessResult {
  const started = Date.now();
  const args = ["-p", ""];
  const qwModel = opts.model ?? resolveSystemModel("qwen-code");
  if (qwModel) args.push("--model", qwModel);
  if (opts.yolo !== false) args.push("--approval-mode", "yolo");

  const spawnOpts = {
    cwd: opts.cwd,
    input: withPreamble(opts),
    encoding: "utf8" as const,
    ...(typeof opts.timeoutMs === "number" ? { timeout: opts.timeoutMs } : {}),
    maxBuffer: 64 * 1024 * 1024,
  };
  let r = driverSpawnSync("qwen", args, spawnOpts);
  if ((r.status ?? 1) !== 0 && /approval[- ]mode|unknown|unrecognized|invalid (option|flag|argument)/i.test(r.stderr || "")) {
    const i = args.indexOf("--approval-mode");
    if (i >= 0) r = driverSpawnSync("qwen", [...args.slice(0, i), ...args.slice(i + 2)], spawnOpts);
  }

  const durationMs = Date.now() - started;
  const exitCode = r.status ?? (r.signal ? 124 : 1);
  const stderr = (r.stderr || "").trim();
  const rawStdout = (r.stdout || "").trim();

  // Plain text by default; if the fork emits a gemini-style JSON envelope,
  // honor its `error` field (failure contract).
  let envelopeError: string | null = null;
  try {
    const j = JSON.parse(rawStdout);
    if (j && typeof j === "object" && j.error != null) envelopeError = envelopeErrorMessage(j.error);
  } catch { /* plain text */ }

  const ok = exitCode === 0 && envelopeError === null;
  return {
    ok, runtime: "qwen-code", sessionId: null, result: rawStdout,
    costUsd: null, costUnavailable: true, exitCode, stderr, durationMs,
    error: ok ? undefined : (envelopeError || salientError(stderr, "qwen failed")),
  };
}

// opencode (`opencode run <message>`) — no stdin channel or machine envelope
// verified (binary not auditable here): argv for small prompts, temp-file
// bootstrap above MAX_ARGV_PROMPT_BYTES; exit code is the only failure
// signal. No session capture, no native USD figure → costUnavailable.
function runOpencode(opts: RunHeadlessOpts): RunHeadlessResult {
  const started = Date.now();
  const delivery = argvOrPromptFile(withPreamble(opts), (p) => ["run", p]);

  let r!: SpawnSyncReturns<string>;
  try {
    r = driverSpawnSync("opencode", delivery.args, {
      cwd: opts.cwd,
      encoding: "utf8",
      ...(typeof opts.timeoutMs === "number" ? { timeout: opts.timeoutMs } : {}),
      maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    removeTmpFiles(delivery.tmpFiles);
  }

  const durationMs = Date.now() - started;
  const exitCode = r.status ?? (r.signal ? 124 : 1);
  const stderr = (r.stderr || "").trim();

  return {
    ok: exitCode === 0, runtime: "opencode", sessionId: null,
    result: (r.stdout || "").trim(),
    costUsd: null, costUnavailable: true, exitCode, stderr, durationMs,
    error: exitCode === 0 ? undefined : salientError(stderr, "opencode failed"),
  };
}

/**
 * Runtimes whose CLI accepts a hard spend cap. Only claude-code takes
 * `--max-budget-usd`; the rest have no equivalent flag, so a cap handed to
 * them cannot bind the run itself.
 */
const BUDGET_CAPABLE: ReadonlySet<Runtime> = new Set<Runtime>(["claude-code"]);

/** One warning per (runtime, cap) per process — a team chain must not spam. */
const _warnedUncappable = new Set<string>();

export function runHeadless(opts: RunHeadlessOpts): RunHeadlessResult {
  // The operator's switch outranks the caller: with the bypass disabled every
  // runner takes its restricted path, the same one `--safe` selects.
  if (!headlessSkipPermissions() && opts.yolo !== false) opts = { ...opts, yolo: false };
  // A budget cap the runtime cannot enforce is worse than no cap: the caller
  // believes the run is bounded. The contract calls the cap HARD, so say
  // plainly when it is not being applied. The caller-side accumulator
  // (spend-tracker, consulted by the cascade between runs) still bounds
  // multi-run flows; this is about THIS run's own ceiling.
  if (typeof opts.maxBudgetUsd === "number" && !BUDGET_CAPABLE.has(opts.runtime)) {
    const key = `${opts.runtime}:${opts.maxBudgetUsd}`;
    if (!_warnedUncappable.has(key)) {
      _warnedUncappable.add(key);
      console.error(
        `[driver] AVISO: teto de $${opts.maxBudgetUsd} pedido, mas o runtime '${opts.runtime}' não aceita limite de gasto — ` +
        `este run NÃO está limitado. Só claude-code aplica o teto no próprio CLI. ` +
        `Entre runs, o acumulador de gasto do LLM_CASCADE continua valendo.`,
      );
    }
  }
  // Ledgered runs get the heartbeat sidecar + the 7-day wall-clock backstop;
  // unledgered calls are byte-for-byte the historical behavior.
  if (opts.ledger?.runId) return runWithLedgerHeartbeat(opts, dispatchToRunner);
  return dispatchToRunner(opts);
}

function dispatchToRunner(opts: RunHeadlessOpts): RunHeadlessResult {
  switch (opts.runtime) {
    case "claude-code":
      return runClaudeCode(opts);
    case "codex":
      return runCodex(opts);
    case "gemini-cli":
      return runGemini(opts);
    case "antigravity-cli":
      return runAntigravity(opts);
    case "kimi-cli":
      return runKimi(opts);
    case "grok-cli":
      return runGrok(opts);
    case "pi":
      return runPi(opts);
    case "qwen-code":
      return runQwen(opts);
    case "opencode":
      return runOpencode(opts);
    default:
      return {
        ok: false, runtime: opts.runtime, sessionId: null, result: "", costUsd: null, costUnavailable: true,
        exitCode: 2, stderr: "", durationMs: 0,
        error: `unknown runtime '${opts.runtime}'. Use claude-code | codex | gemini-cli | antigravity-cli | kimi-cli | grok-cli | pi | qwen-code | opencode.`,
      };
  }
}

/** The runtime roster, from the single source of truth. `RUNTIMES` used to be
 * reachable only through the __testables seam, so consumers that needed the
 * list (nrv doctor) grew hardcoded copies — the doctor's had 3 of the 9, and
 * grok/pi/agy/kimi/qwen/opencode never appeared in its report on any OS.
 * Derive from here; a 10th adapter then shows up everywhere automatically. */
export function listRuntimes(): { name: Runtime; cli: string }[] {
  return RUNTIMES.map((r) => ({ name: r.name as Runtime, cli: r.cli }));
}

// Mirrors RUNTIMES above. Kept as a literal Record<Runtime, string> ON PURPOSE:
// the exhaustive key type makes adding a Runtime member a compile error here,
// which a derived Object.fromEntries would silently satisfy. The mirror is
// drift-proofed by doctor-runtimes.test.ts instead.
const RUNTIME_BINS: Record<Runtime, string> = {
  "claude-code": "claude",
  "codex": "codex",
  "gemini-cli": "gemini",
  "antigravity-cli": "agy",
  "kimi-cli": "kimi",
  "grok-cli": "grok",
  "pi": "pi",
  "qwen-code": "qwen",
  "opencode": "opencode",
};

/** True if the runtime's CLI binary is on PATH. Cross-platform: uses `where`
 * on Windows, `which` elsewhere. */
export function runtimeAvailable(runtime: Runtime): boolean {
  const bin = RUNTIME_BINS[runtime] ?? "gemini";
  const probe = process.platform === "win32" ? "where" : "which";
  // `env` is passed EXPLICITLY: under Bun a spawn without it uses the
  // environment captured at process start, not the current `process.env`. The
  // probe would then answer about a different PATH than the one the actual
  // invocation runs with (callHostAgent spawns with `env: {...process.env}`),
  // so a runtime added to PATH mid-process reads as unavailable while being
  // perfectly invocable. Same reason in whichSync below.
  const r = spawnSync(probe, [bin], { encoding: "utf8", env: process.env });
  return r.status === 0;
}

/**
 * How the multi-line system directive reaches `claude`, per start path.
 *
 * When a `.cmd`/`.bat` runtime cannot be read as a launcher, it is still started through the
 * command interpreter (resolveExecutable), and cmd.exe ends the command line at the first
 * CR/LF of an argument however it is quoted: quoteForCmd cannot help, because the limit is
 * the parser and not the escaping. The directive is the one argument here that spans lines,
 * so under a shell it travels as `--append-system-prompt-file <temp file>` and the command
 * line stays single-line. Without a shell it stays inline, exactly as before.
 *
 * resolveExecutable now spawns the pair a readable shim names, so the shell branch is the
 * exception rather than the rule. This stays as the defense for whatever falls into it.
 */
export function claudeDirectiveArgs(directive: string, shell: boolean): { args: string[]; tmpFiles?: string[] } {
  if (!directive) return { args: [] };
  if (!shell) return { args: ["--append-system-prompt", directive] };
  const file = writePromptFile(directive, "nrv-directive");
  return { args: ["--append-system-prompt-file", file], tmpFiles: [file] };
}

/** TEST-ONLY seams. Not part of the public driver contract. */
export const __testables = {
  RUNTIMES,
  clampPersona,
  argvOrPromptFile,
  promptFileBootstrap,
  envelopeErrorMessage,
  TMP_FILE_PREFIXES,
};

if (import.meta.main) {
  const host = detectHost();
  if (!host) { console.log("no-host-detected"); process.exit(0); }
  console.log(JSON.stringify({ host: host.name, cli: host.cli }, null, 2));
}
