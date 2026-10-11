#!/usr/bin/env bun
/**
 * activate.ts — `nrv activate`: prepare squads to touch the real world.
 *
 * A squad is prose plus scripts. Most of it an LLM executes on its own, but
 * the ones that call real tools — ffmpeg, epubcheck, playwright, a Python
 * library, a downloaded model — need those tools present. `dependencies.yaml`
 * declares them; this command installs and verifies them.
 *
 * Activation was reachable only as a raw script path
 * (skills/squads/scripts/activate-squad.ts), invisible to `nrv --help`, one
 * squad per invocation. Asked to "activate all squads", an agent had to grep
 * the filesystem to find the door and then walk 107 of them by hand. This is
 * that door, with the batch the library-sized case always needed.
 *
 * Usage:
 *   nrv activate <slug> [--dry-run] [--confirm-heavy] [--verbose] [--skip-verify] [--json] [--fix-with-agent[=<runtime>]]
 *   nrv activate --all [--dry-run] [--confirm-heavy] [--only-declared] [--skip-verify] [--json] [--fix-with-agent[=<runtime>]]
 *   nrv activate status <slug>
 *
 * Exit codes mirror the per-squad contract, aggregated over the batch:
 *   0 = every squad ready · 1 = at least one failed
 *   2 = at least one needs confirmation (heavy download / sudo)
 *   4 = invalid args / squad not found
 *
 * After the install pass, what is printed depends on who runs the command
 * (lib/activate-recovery.ts): an agent or a script gets a delimited block of
 * issues with the fix for each, a person at a terminal a summary and the offer
 * to hand the failures to an installed agent runtime.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { spawnSync } from "node:child_process";
import { resolveScope, enumerate } from "../../_shared/lib/scope.ts";
import { verifyHook } from "../../_shared/lib/verify/index.ts";
import { listRuntimes, runtimeAvailable, runHeadless, whichSync, type Runtime } from "../../_shared/lib/host-agent-driver.ts";
import { canonicalRuntimeName, detectSessionHost } from "../lib/runtime-rules.ts";
import {
  detectCaller, issuesFromOutcome, parseActivatorJson, parseFixWithAgent, recover, renderAgentBlock,
  type ActivationIssue, type FixEnv, type SquadOutcome,
} from "../lib/activate-recovery.ts";

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(process.env.HOME || "", ".nirvana", "skills"))
    ? path.join(process.env.HOME || "", ".nirvana", "skills")
    : path.resolve(import.meta.dir, "..", ".."));
const ACTIVATOR = path.join(SKILLS_ROOT, "squads", "scripts", "activate-squad.ts");
const BUN = process.env.NIRVANA_BUN || "bun";

const DIM = "\x1b[2m", GRN = "\x1b[32m", YEL = "\x1b[33m", RED = "\x1b[31m", BOLD = "\x1b[1m", RST = "\x1b[0m";

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith("--"));
const positional = argv.filter((a) => !a.startsWith("--"));
const all = flags.includes("--all");
const onlyDeclared = flags.includes("--only-declared");
const skipVerify = flags.includes("--skip-verify");
const passthrough = flags.filter((f) => ["--dry-run", "--confirm-heavy", "--verbose", "-v"].includes(f));
const asJson = flags.includes("--json");
const fixWith = parseFixWithAgent(flags);
const dryRun = flags.includes("--dry-run");
// Under --json, stdout carries the JSON alone; everything else moves to stderr.
const say = (text: string) => (asJson ? process.stderr : process.stdout).write(`${text}\n`);

if (flags.includes("--help") || flags.includes("-h") || (!all && positional.length === 0)) {
  console.error(`usage:
  nrv activate <slug> [--dry-run] [--confirm-heavy] [--verbose] [--skip-verify] [--json] [--fix-with-agent[=<runtime>]]
  nrv activate --all [--dry-run] [--confirm-heavy] [--only-declared] [--skip-verify] [--json] [--fix-with-agent[=<runtime>]]
  nrv activate status <slug>

Installs what a squad's dependencies.yaml declares: system tools, Python and
Node packages (into the squad's own environment, ~/.nirvana/envs/<slug>,
which a dispatch also prepares on demand), sub-app node_modules, model downloads (heavy ones need
--confirm-heavy) — then verifies each check. Idempotent: an already-active
squad is re-verified, not reinstalled.

--all walks the library ONE SQUAD AT A TIME and never stops on a failure;
the summary at the end says what is ready, what needs confirmation and what
broke. --only-declared skips squads with no dependencies.yaml (they need no
activation at all).

Each squad passes the admission gate before its dependencies are installed.
The gate reports by default; with verify.enforce_on_activate on, a squad
carrying an error the debt baseline does not cover is refused instead of
activated. --skip-verify is the documented escape.

When something is not ready, the output depends on who runs the command.
An agent session or a script gets a block between
"=== nrv activate: issues for the agent ===" and its end marker: per issue,
the squad, the dependency, the useful error lines, the command that fixes it,
"nrv activate <slug>" to check again, and whether the user must approve the
fix. --json prints the same data as JSON on stdout. Neither ever prompts.
A person at a terminal gets a summary and the offer to let an installed agent
runtime (Claude Code, Codex, ...) fix the failures headless; the squads are
then checked again.
--fix-with-agent[=<runtime>] runs that fix without asking, in any context
(without a value: this session's runtime, else the first one installed).`);
  process.exit(flags.includes("--help") || flags.includes("-h") ? 0 : 4);
}

/** status passes straight through — it is a per-squad question. */
if (positional[0] === "status" || positional[0] === "deactivate") {
  const r = spawnSync(BUN, [ACTIVATOR, positional[0], positional[1] ?? "", ...passthrough], { windowsHide: true, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

/**
 * Activation is where a squad stops being prose and starts touching the real
 * world — it installs tools, downloads models, runs verification commands. So
 * it is the last honest moment to ask whether the squad is admissible at all,
 * and it asks BEFORE the first dependency is installed: a refusal leaves the
 * machine untouched. Report-only until `verify.enforce_on_activate` is on.
 */
async function gateOne(slug: string): Promise<{ ok: boolean; lines: string[] }> {
  const gate = await verifyHook({ kind: "squad", target: slug, gate: "activate", skip: skipVerify });
  for (const line of gate.lines) console.error(`  ${line}`);
  return { ok: !gate.blocked, lines: gate.lines };
}

/** Copies a child's stream to `sink` as it arrives and returns all of it. */
async function tee(stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream | null): Promise<string> {
  const decoder = new TextDecoder();
  let all = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    all += text;
    if (sink) sink.write(text);
  }
  return all + decoder.decode();
}

/**
 * One squad through the gate and the activator. The activator's output still
 * streams live (to stderr under --json, nowhere on a silent re-check), and is
 * also kept, because its JSON is where the failures are.
 */
async function runOne(slug: string, opts: { echo?: boolean } = {}): Promise<SquadOutcome> {
  const echo = opts.echo !== false;
  const gate = await gateOne(slug);
  if (!gate.ok) return { slug, dir: null, exitCode: 1, result: null, gateLines: gate.lines };
  const proc = Bun.spawn([BUN, ACTIVATOR, "activate", slug, ...passthrough], {
    stdin: "inherit", stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const [stdout, stderr] = await Promise.all([
    tee(proc.stdout, echo ? (asJson ? process.stderr : process.stdout) : null),
    tee(proc.stderr, echo ? process.stderr : null),
  ]);
  const exitCode = await proc.exited;
  return { slug, dir: null, exitCode, result: parseActivatorJson(stdout), stderr };
}

const fixEnv: FixEnv = { platform: process.platform, which: whichSync };
const callerInfo = detectCaller({
  env: process.env,
  stdinTTY: process.stdin.isTTY,
  stdoutTTY: process.stdout.isTTY,
  sessionHost: detectSessionHost,
});

function askLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
    rl.on("close", () => resolve(""));
  });
}

/**
 * What happens after the install pass, the same for one squad and for --all:
 * the issues block (agent, automation), the summary and the offer (human),
 * the agent fix when asked for, and the JSON under --json. Returns the exit code.
 */
async function finish(outcomes: SquadOutcome[], baseExit: number, dirs: Map<string, string>): Promise<number> {
  const issues: ActivationIssue[] = dryRun ? [] : outcomes.flatMap((o) => issuesFromOutcome(o, fixEnv));
  // --json is a machine reading stdout: nobody to prompt, whoever started it.
  const caller = asJson && callerInfo.caller === "human" ? { ...callerInfo, caller: "automation" as const } : callerInfo;
  if (issues.length && caller.caller !== "human") {
    // The block goes where the reader looks: stdout, or stderr when stdout is the JSON.
    say(`\n${renderAgentBlock(issues)}\n`);
  }
  const result = await recover(issues, {
    caller,
    fixWith,
    available: () => listRuntimes().map((r) => r.name).filter(runtimeAvailable),
    canonical: canonicalRuntimeName,
    ask: askLine,
    dispatch: (runtime: Runtime, prompt: string) => {
      // The fixer runs as an errand (role `exec`: it dispatches nothing), with
      // the same permission bypass a worker gets, in a scratch folder that is
      // no squad's. Its own output is captured and summarised by recover().
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-activate-fix-"));
      try {
        const r = runHeadless({ runtime, prompt, cwd: workDir, yolo: true, dispatchRole: "exec", ephemeral: true });
        return { ok: r.ok, answer: r.answer ?? r.result ?? "", error: r.error ?? (r.ok ? undefined : r.stderr) };
      } finally {
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* tmp is reclaimed */ }
      }
    },
    recheck: async (squads) => {
      const out: SquadOutcome[] = [];
      for (const s of squads) out.push(await runOne(s, { echo: false }));
      return out;
    },
    fixEnv,
    squadDirs: [...new Set(issues.map((i) => dirs.get(i.squad)).filter((d): d is string => !!d))],
    print: say,
  });
  const exitCode = result.recheckExit ?? baseExit;
  if (asJson) {
    process.stdout.write(`${JSON.stringify({
      ok: exitCode === 0,
      exit_code: exitCode,
      caller: callerInfo.caller,
      session_runtime: callerInfo.sessionRuntime,
      squads: outcomes.map((o) => ({ slug: o.slug, exit_code: o.exitCode })),
      issues,
      agent_fix: result.agentFix,
      agent_fix_skipped: result.agentFix ? null : result.skipped,
    }, null, 2)}\n`);
  }
  return exitCode;
}

if (!all) {
  const slug = positional[0];
  let dir: string | undefined;
  try { dir = enumerate(resolveScope(), "squads").find((e) => e.slug === slug && !e.overridden)?.dir; } catch { /* the activator reports it */ }
  const outcome = await runOne(slug);
  process.exit(await finish([{ ...outcome, dir: dir ?? null }], outcome.exitCode, new Map(dir ? [[slug, dir]] : [])));
}

// ── batch ──────────────────────────────────────────────────────────────────
const scope = resolveScope();
const squads = enumerate(scope, "squads")
  .filter((e) => !e.overridden)
  .filter((e) => !onlyDeclared || fs.existsSync(path.join(e.dir, "dependencies.yaml")))
  .sort((a, b) => a.slug.localeCompare(b.slug));

if (squads.length === 0) {
  console.error("no squads found in scope — check `nrv list-squads`");
  if (asJson) process.stdout.write(`${JSON.stringify({ ok: false, exit_code: 4, caller: callerInfo.caller, session_runtime: callerInfo.sessionRuntime, squads: [], issues: [], agent_fix: null, agent_fix_skipped: "no squads in scope" }, null, 2)}\n`);
  process.exit(4);
}

const declared = squads.filter((e) => fs.existsSync(path.join(e.dir, "dependencies.yaml"))).length;
say(`\n${BOLD}ACTIVATING ${squads.length} SQUAD(S)${RST} ${DIM}· ${declared} declare dependencies · one at a time${RST}\n`);

const ready: string[] = [];
const needsConfirm: string[] = [];
const failed: string[] = [];
const nothingToDo: string[] = [];
const outcomes: SquadOutcome[] = [];

let i = 0;
for (const s of squads) {
  i++;
  const hasDeps = fs.existsSync(path.join(s.dir, "dependencies.yaml"));
  say(`${DIM}[${i}/${squads.length}]${RST} ${s.slug} ${DIM}…${RST}`);
  if (!hasDeps) {
    nothingToDo.push(s.slug);
    continue;
  }
  // A failure never stops the walk: the point of --all is to leave the
  // library as ready as it can be, then report what still needs a human.
  const outcome = await runOne(s.slug);
  outcomes.push({ ...outcome, dir: s.dir });
  const code = outcome.exitCode;
  if (code === 0) ready.push(s.slug);
  else if (code === 2) needsConfirm.push(s.slug);
  else failed.push(s.slug);
}

say(`\n${BOLD}SUMMARY${RST}`);
say(`  ${GRN}ready${RST} ................ ${ready.length}`);
if (nothingToDo.length) say(`  ${DIM}no dependencies${RST} ...... ${nothingToDo.length} ${DIM}(nothing to install)${RST}`);
if (needsConfirm.length) {
  say(`  ${YEL}needs confirmation${RST} ... ${needsConfirm.length}`);
  for (const s of needsConfirm.slice(0, 10)) say(`      ${YEL}·${RST} ${s}`);
  if (needsConfirm.length > 10) say(`      ${DIM}… and ${needsConfirm.length - 10} more${RST}`);
  say(`  ${DIM}heavy downloads or sudo: re-run with --confirm-heavy to accept${RST}`);
}
if (failed.length) {
  say(`  ${RED}failed${RST} ............... ${failed.length}`);
  for (const s of failed.slice(0, 10)) say(`      ${RED}✗${RST} ${s}`);
  if (failed.length > 10) say(`      ${DIM}… and ${failed.length - 10} more${RST}`);
  say(`  ${DIM}inspect one with: nrv activate <slug> --verbose${RST}`);
}
say("");

const batchExit = failed.length ? 1 : needsConfirm.length ? 2 : 0;
process.exit(await finish(outcomes, batchExit, new Map(squads.map((e) => [e.slug, e.dir]))));
