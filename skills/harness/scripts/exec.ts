#!/usr/bin/env bun
// exec.ts — the runtime, as itself. One prompt in, its answer out.
//
// Everything else in this engine wraps a brief: a persona, the autonomous
// directive, an outputs root, the ledger, the delivery pipeline, the quality
// gate. That wrapping is the product, and it is also why there was no way to
// ask a runtime a plain question. `--agent-x` is the thinnest dispatch and it
// still carries all of it.
//
// So this is the fourth thing `nrv` can do with a runtime, and the only one
// that promises nothing: no persona, no outputs directory, no gate, no run in
// the ledger. It exists for the errands around the work — check a fact, ask a
// second runtime when the one you are sitting in has hit a limit of its own,
// read something back in a language you do not write.
//
// Three properties it must keep, each for a reason.
//
//   1. It says it did not pass the gate, on stderr, every time. The value of
//      this engine is that a deliverable has `gate_passed` behind it. A command
//      that returns raw text has nothing behind it, and silence about that
//      would be the dishonest kind of convenience.
//   2. It is an OPERATOR tool. The role stamp (dispatch-depth.ts) gives it an
//      empty allowance, so a squad, a seat, a director or another exec cannot
//      open one. Without that it would be the perfect hole: a seat shelling out
//      to `nrv exec` is an unsupervised agent with a different name.
//   3. Its cost is recorded. An errand that leaves no trace is how a bill
//      becomes a mystery.
//
//   nrv exec "what changed in the Gemini CLI this month"
//   nrv exec --runtime=gemini-cli "search the web for agent frameworks"
//   cat long-question.md | nrv exec --runtime=codex
//   nrv exec --json "one sentence on X" | jq -r .result
import { EXIT } from "../../_shared/lib/bun-helpers.ts";
import { runHeadless, runtimeAvailable, listRuntimes, type Runtime } from "../../_shared/lib/host-agent-driver.ts";
import { resolveRunRuntime } from "../lib/runtime-rules.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { stamp } from "../../_shared/lib/audit-provenance.ts";

/** Same shape every script in this directory uses; never fatal. */
function appendAudit(payload: Record<string, unknown>): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(harnessLogsDir({ cwd: process.cwd() }), today);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify(stamp({ ts: new Date().toISOString(), ...payload })) + "\n");
  } catch { /* non-fatal */ }
}

const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", yellow: "\x1b[33m", red: "\x1b[31m", lime: "\x1b[38;5;154m" };
const noColor = process.argv.includes("--no-color") || !process.stderr.isTTY;
const c = (color: keyof typeof ANSI, s: string) => (noColor ? s : `${ANSI[color]}${s}${ANSI.reset}`);

const argv = process.argv.slice(2);
const flag = (name: string) => argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const val = (name: string): string | undefined => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function usage(code: number = EXIT.INVALID_ARGS): never {
  console.error("Usage: nrv exec [options] \"<prompt>\"        (or pipe the prompt on stdin)");
  console.error("");
  console.error("  The runtime, as itself. No persona, no outputs directory, no quality gate.");
  console.error("  For the errands around the work — not for producing a deliverable.");
  console.error("");
  console.error("  --runtime=<name>     which runtime (default: the one this session is in)");
  console.error("  --json               print {ok, runtime, result, cost_usd, duration_ms}");
  console.error("  --timeout=<seconds>  give up after this long (default 300)");
  console.error("  --max-budget=<usd>   spend ceiling, where the runtime accepts one");
  console.error("  --quiet              do not print the no-gate notice");
  console.error("");
  console.error("Examples:");
  console.error("  nrv exec \"what changed in the Gemini CLI this month\"");
  console.error("  nrv exec --runtime=gemini-cli \"search the web for agent frameworks\"");
  console.error("  cat question.md | nrv exec --runtime=codex");
  console.error("");
  console.error("  To produce something, dispatch it: nrv dispatch --auto --exec \"<brief>\"");
  process.exit(code);
}

// Asking what a command does is not a usage error. Same rule the update
// command had to learn: --help prints and exits 0, and does nothing else.
if (flag("help") || argv.includes("-h")) usage(EXIT.OK);

const asJson = flag("json");
const quiet = flag("quiet");
const timeoutMs = Math.max(1, Number(val("timeout") ?? 300)) * 1000;
const budget = val("max-budget") ? Number(val("max-budget")) : undefined;

// The prompt: positional words, or stdin when it is piped. Parsed by INDEX and
// never by value — `indexOf` finds the first occurrence, so a prompt that
// repeats a word ("codex, compare codex and gemini") would lose a piece of
// itself to the flag it happened to match.
const VALUE_FLAGS = new Set(["--runtime", "--timeout", "--max-budget"]);
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_FLAGS.has(a)) { i++; continue; }   // its value belongs to it
  if (a.startsWith("--")) continue;
  positional.push(a);
}
let prompt = positional.join(" ").trim();
if (!prompt && !process.stdin.isTTY) prompt = (await Bun.stdin.text()).trim();
if (!prompt) usage();

const explicit = val("runtime") as Runtime | undefined;
if (explicit && !listRuntimes().some((r) => r.name === explicit)) {
  console.error(c("red", `✗ unknown runtime '${explicit}'. Known: ${listRuntimes().map((r) => r.name).join(", ")}`));
  process.exit(EXIT.INVALID_ARGS);
}
if (explicit && !runtimeAvailable(explicit)) {
  // Same rule the dispatcher holds to: a named runtime that is not installed is
  // a stop, never a silent substitution to another vendor.
  console.error(c("red", `✗ '${explicit}' is not installed on this machine. Install it, or name one that is.`));
  process.exit(EXIT.FAILURES);
}

const choice = resolveRunRuntime({ explicit: explicit ?? null, brief: prompt });
const runtime = choice.runtime;

if (!quiet && !asJson) console.error(c("dim", `▪ ${runtime} — raw, no gate`));

const started = Date.now();
const r = runHeadless({
  runtime,
  prompt,
  cwd: process.cwd(),
  // An errand runs like an errand: no project directories granted beyond the
  // one the operator is already standing in, and no subagents.
  yolo: false,
  timeoutMs,
  ...(budget !== undefined ? { maxBudgetUsd: budget } : {}),
  dispatchRole: "exec",
});
const durationMs = Date.now() - started;

// What it cost and that it happened. Never the prompt: an errand can carry
// anything, and the audit is read by more people than the person who typed it.
try {
  appendAudit({
    event: "x_exec_passthrough",
    runtime, prompt_chars: prompt.length, ok: r.ok,
    cost_usd: r.costUsd ?? null, duration_ms: durationMs,
    runtime_source: choice.source,
  });
} catch { /* an errand is not worth failing over telemetry */ }

if (asJson) {
  console.log(JSON.stringify({
    ok: r.ok, runtime, result: r.result ?? "", cost_usd: r.costUsd ?? null,
    duration_ms: durationMs, gate: null, error: r.error ?? null,
  }, null, 2));
  process.exit(r.ok ? EXIT.OK : EXIT.FAILURES);
}

if (!r.ok) {
  console.error(c("red", `✗ ${runtime} failed: ${r.error || r.stderr || `exit ${r.exitCode}`}`));
  process.exit(EXIT.FAILURES);
}

process.stdout.write((r.result ?? "").replace(/\s+$/, "") + "\n");
if (!quiet) {
  const cost = typeof r.costUsd === "number" ? ` · $${r.costUsd.toFixed(4)}` : "";
  console.error(c("dim", `▪ ${(durationMs / 1000).toFixed(1)}s${cost}`));
  console.error(c("yellow", "▪ raw runtime output — it passed no quality gate and produced no artifact."));
  console.error(c("dim", "  To produce something the engine stands behind: nrv dispatch --auto --exec \"<brief>\""));
}
