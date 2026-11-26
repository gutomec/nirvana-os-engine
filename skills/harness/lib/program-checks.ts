// program-checks.ts — an acceptance criterion a program decides.
//
// A criterion is a sentence, and until now a model judged every one of them.
// Some are not a matter of judgment: a sum, a check digit, a price against its
// table, a schema, a count of rows. A model gets those wrong some of the time
// and a program never does. So a criterion may name a program, and the gate
// runs it:
//
//   acceptance:
//     - id: totals_match
//       description: "every statement line is paired or listed as pending"
//       blocking: true
//       check: scripts/check-reconciliation.ts          # or { run, args, timeout_sec }
//
// The program runs in the outputs folder with NIRVANA_OUTPUTS_DIR and
// NIRVANA_PROJECT_DIR set, and answers by its exit code:
//
//   0  the criterion holds
//   1  it does not: each line it printed on stdout is one thing to fix
//   2  it could not measure (an input is missing, a tool is absent)
//
// Anything else is "not measured" too: a timeout, a program that is not there,
// a language with no interpreter on this machine, and a crash. An uncaught
// error also ends with exit 1, so exit 1 with nothing on stdout is read as a
// crash: a broken checker must never be taken for a broken deliverable. "Not measured" is
// never a pass. A blocking criterion left unmeasured caps the delivery at
// "delivered with reservations", and the reservation names it.
//
// The checks of a run are written beside its brief (`checks.json`), so every
// caller of the pipeline (dispatch, revise, the supervisor) runs the same ones.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { whichSync } from "../../_shared/lib/host-agent-driver.ts";

export interface ProgramCheck {
  id: string;
  description: string;
  blocking: boolean;
  /** Absolute path of the program. */
  run: string;
  /** `{outputs}` and `{project}` are replaced; default: the outputs folder. */
  args: string[];
  /** The folder under the outputs root this check reads: set when several
   *  squads share one dispatch and each writes under its own. */
  dir?: string;
  timeoutSec: number;
}

export type CheckState = "pass" | "fail" | "not_measured";

export interface CheckResult {
  id: string;
  description: string;
  blocking: boolean;
  state: CheckState;
  /** What the program printed: the things to fix on a fail, the reason on a not-measured. */
  lines: string[];
  seconds: number;
}

export const RUN_CHECKS_FILE = "checks.json";
const DEFAULT_TIMEOUT_SEC = 120;
const MAX_LINES = 40;
const MAX_LINE_CHARS = 400;

const inside = (root: string, file: string): boolean => {
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** One acceptance entry's `check`, or null when it names none or names a file outside the entity. */
function checkOf(entry: any, entityDir: string): ProgramCheck | null {
  const raw = entry?.check;
  const spec = typeof raw === "string" ? { run: raw } : raw && typeof raw === "object" ? raw : null;
  if (!spec || typeof spec.run !== "string" || !spec.run.trim()) return null;
  if (typeof entry.id !== "string" || typeof entry.description !== "string") return null;
  const run = path.resolve(entityDir, spec.run);
  if (!inside(entityDir, run)) return null;
  const timeout = Number(spec.timeout_sec);
  return {
    id: entry.id, description: entry.description.replace(/\s+/g, " ").trim(),
    // The same default as a business role's acceptance: blocking unless the author says otherwise.
    blocking: entry.blocking !== false,
    run,
    args: Array.isArray(spec.args) && spec.args.every((a: unknown) => typeof a === "string") ? spec.args : ["{outputs}"],
    timeoutSec: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 1800) : DEFAULT_TIMEOUT_SEC,
  };
}

/** The program checks of one squad capability, read from the squad on disk. */
export function squadProgramChecks(squadDir: string | null | undefined, capabilityId: string | null | undefined): ProgramCheck[] {
  if (!squadDir || !capabilityId) return [];
  try {
    const doc = parseYaml(fs.readFileSync(path.join(squadDir, "squad.yaml"), "utf8")) as any;
    const cap = (Array.isArray(doc?.capabilities) ? doc.capabilities : []).find((c: any) => c?.id === capabilityId);
    return (Array.isArray(cap?.acceptance) ? cap.acceptance : []).map((a: any) => checkOf(a, squadDir)).filter((c: ProgramCheck | null): c is ProgramCheck => !!c);
  } catch { return []; }
}

/** The program checks the employees of a business declare in their `acceptance[]`. One per id. */
export function businessProgramChecks(businessDir: string | null | undefined): ProgramCheck[] {
  if (!businessDir) return [];
  const out = new Map<string, ProgramCheck>();
  let files: string[] = [];
  try { files = fs.readdirSync(path.join(businessDir, "employees")).filter((f) => f.endsWith(".md")).sort(); } catch { return []; }
  for (const f of files) {
    try {
      const fm = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(path.join(businessDir, "employees", f), "utf8"))?.[1];
      const doc = fm ? (parseYaml(fm) as any) : null;
      for (const a of Array.isArray(doc?.acceptance) ? doc.acceptance : []) {
        const c = checkOf(a, businessDir);
        if (c && !out.has(c.id)) out.set(c.id, c);
      }
    } catch { /* an employee file that does not parse declares no check */ }
  }
  return [...out.values()];
}

/** Write a run's checks beside its brief. No checks: no file, and a stale one is removed. */
export function writeRunChecks(projectDir: string, checks: ProgramCheck[]): void {
  const file = path.join(projectDir, RUN_CHECKS_FILE);
  try {
    if (!checks.length) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ checks }, null, 2), "utf8");
  } catch { /* a run with no readable checks file runs none */ }
}

export function readRunChecks(projectDir: string): ProgramCheck[] {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(projectDir, RUN_CHECKS_FILE), "utf8"));
    return (Array.isArray(doc?.checks) ? doc.checks : []).filter((c: any) => c && typeof c.id === "string" && typeof c.run === "string" && Array.isArray(c.args));
  } catch { return []; }
}

/** The interpreter of a program, by its extension; null when this machine has none for it. */
function interpreterOf(file: string, env: Record<string, string | undefined>): { command: string; pre: string[] } | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".ts" || ext === ".js" || ext === ".mjs" || ext === ".cjs") return { command: process.execPath, pre: [] };
  if (ext === ".py") {
    // The squad's own environment first: its packages live there.
    const venv = env.VIRTUAL_ENV;
    if (venv) {
      const py = path.join(venv, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
      if (fs.existsSync(py)) return { command: py, pre: [] };
    }
    const found = whichSync("python3") ?? whichSync("python");
    return found ? { command: found, pre: [] } : null;
  }
  return null;
}

const linesOf = (text: string): string[] =>
  text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, MAX_LINES).map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l));

export interface RunChecksOpts {
  outputsRoot: string;
  projectDir: string;
  env?: Record<string, string | undefined>;
  /** True ends the checks at once (the run was stopped under them). */
  shouldStop?: () => boolean;
  /** Called before each program, for the caller to renew its lease. */
  beforeCheck?: (check: ProgramCheck) => void;
}

/** Run every check once, in the order declared. Never throws. */
export function runProgramChecks(checks: ProgramCheck[], opts: RunChecksOpts): CheckResult[] {
  const results: CheckResult[] = [];
  const env = { ...process.env, ...(opts.env ?? {}), NIRVANA_OUTPUTS_DIR: path.resolve(opts.outputsRoot), NIRVANA_PROJECT_DIR: path.resolve(opts.projectDir) };
  for (const check of checks) {
    const base = { id: check.id, description: check.description, blocking: check.blocking };
    const unmeasured = (why: string, seconds = 0): CheckResult => ({ ...base, state: "not_measured", lines: [why], seconds });
    if (opts.shouldStop?.()) { results.push(unmeasured("the run was stopped before this check")); continue; }
    if (!fs.existsSync(check.run)) { results.push(unmeasured(`the program is not there: ${check.run}`)); continue; }
    const how = interpreterOf(check.run, env);
    if (!how) { results.push(unmeasured(`no interpreter on this machine for ${path.basename(check.run)}`)); continue; }
    opts.beforeCheck?.(check);
    const outputs = path.resolve(opts.outputsRoot, check.dir ?? "");
    const args = check.args.map((a) => a.replaceAll("{outputs}", outputs).replaceAll("{project}", path.resolve(opts.projectDir)));
    const started = Date.now();
    const r = spawnSync(how.command, [...how.pre, check.run, ...args], {
      cwd: fs.existsSync(outputs) ? outputs : opts.outputsRoot, env: { ...env, NIRVANA_OUTPUTS_DIR: outputs }, encoding: "utf8", windowsHide: true, timeout: check.timeoutSec * 1000, maxBuffer: 8 * 1024 * 1024,
    });
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    const found = linesOf(r.stdout ?? "");
    const printed = linesOf(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
    if (r.error) {
      const timedOut = (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
      results.push(unmeasured(timedOut ? `the program did not finish in ${check.timeoutSec} s` : `the program did not start: ${r.error.message}`, seconds));
    } else if (r.status === 0) {
      results.push({ ...base, state: "pass", lines: [], seconds });
    } else if (r.status === 1 && found.length) {
      results.push({ ...base, state: "fail", lines: found, seconds });
    } else if (r.status === 1) {
      results.push(unmeasured(`the program ended with exit 1 and named nothing to fix, which reads as a crash${printed[0] ? `: ${printed[0]}` : ""}`, seconds));
    } else {
      const why = r.status === 2 ? (printed[0] ?? "the program could not measure") : `the program ended with exit ${r.status ?? "?"}${printed[0] ? `: ${printed[0]}` : ""}`;
      results.push({ ...base, state: "not_measured", lines: [why, ...(r.status === 2 ? printed.slice(1) : [])], seconds });
    }
  }
  return results;
}

/** The lines of `_GATE-FINDINGS.md` for one round of checks. */
export function checksBlock(results: CheckResult[]): string[] {
  if (!results.length) return [];
  const mark = (s: CheckState) => (s === "pass" ? "pass" : s === "fail" ? "FAIL" : "NOT MEASURED");
  return [
    "### Program checks",
    ...results.flatMap((r) => [
      `- ${r.id} (${r.blocking ? "blocking" : "advisory"}): ${mark(r.state)} — ${r.description}`,
      ...r.lines.map((l) => `  - ${l}`),
    ]),
    "",
  ];
}

/** How a worker runs one check itself, as a command line. */
export function checkCommand(check: ProgramCheck, outputsRoot: string): string {
  const ext = path.extname(check.run).toLowerCase();
  const how = ext === ".py" ? "python3" : "bun";
  const q = (v: string) => (/[\s"]/.test(v) ? JSON.stringify(v) : v);
  return [how, q(check.run), ...check.args.map((a) => q(a.replaceAll("{outputs}", path.resolve(outputsRoot)).replaceAll("{project}", "<the run folder>")))].join(" ");
}

/** What a worker is told about the programs that will check its work. "" when there are none. */
export function programChecksDirective(checks: ProgramCheck[], outputsRoot: string): string {
  if (!checks.length) return "";
  return [
    "",
    "",
    "PROGRAM CHECKS: after you finish, the engine runs these programs on your deliverables. A program decides its criterion, no reviewer does, and each line it prints on a failure comes back to you to fix. Run each one yourself before you finish and correct what it reports:",
    ...checks.map((c) => `- ${c.id}${c.blocking ? " (blocking)" : ""}: ${c.description}\n  ${checkCommand(c, outputsRoot)}`),
    "Exit 0 means the criterion holds, 1 that it does not, 2 that the program could not measure: when it cannot measure because something of yours is missing, produce what is missing.",
  ].join("\n");
}

/** What a judge is told about the criteria a program decides: they are settled,
 *  and a finding that asks for the opposite sends the worker in circles. Seen on
 *  2026-11-26: a program approved a contact list, the judge asked for the
 *  opposite of two of its rules, the worker obeyed, the program failed the next
 *  round, and the two took turns for five corrections. "" when there are none. */
export function settledCriteriaNote(checks: ProgramCheck[]): string {
  if (!checks.length) return "";
  return [
    "",
    "",
    "## Settled by program",
    "",
    "A program checks the criteria below on the delivered files, with the exact rules of the work. They are not yours to judge. Do not report a finding, and do not propose a fix, that would change what these criteria fix (a value, a count, a format, a rule of acceptance or rejection): grade the rest.",
    "",
    ...checks.map((c) => `- ${c.id}: ${c.description}`),
    "",
  ].join("\n");
}

/** The same, for the worker that corrects: the program's criteria outrank any other finding. */
export function settledCriteriaRule(checks: ProgramCheck[]): string[] {
  if (!checks.length) return [];
  return [
    "Criteria a program decides are settled, and the same program runs again after your correction:",
    ...checks.map((c) => `  - ${c.id}: ${c.description}`),
    "Where a point above asks for something that would break one of them, keep the program's criterion, leave that point undone and say so in the summary.",
    "",
  ];
}
