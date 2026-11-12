#!/usr/bin/env bun
// clean-project.ts — remove an autopilot project's scaffold + outputs.
//
// Default is reversible: the project dir + its .zip are MOVED to
// ~/.nirvana/trash/<project_id>-<ts>/. With --hard they are deleted outright.
// An append-only `project_purged` event is written to the audit log (the log
// itself is never rewritten).
//
// What this does NOT remove, deliberately: the project's Run in
// <project>/.nirvana/run-kernel.sqlite, the run-ledger rows and the audit log.
// Those are the record of what ran; the scaffold is the draft it ran on, and a
// draft going away is not the run un-happening. Same rule the ledger and the
// audit already follow. One consequence to know: the Run id is derived from the
// project id, so re-dispatching with a project id whose Run has ended is refused
// with `x_run_id_collision` even after a clean. Pass a fresh --project.
//
// What it DOES close: every ledger row of the project still open (dispatched,
// running, verifying, gated, failed, stalled) ends `abandoned`, reason "project
// cleaned". Left open, the supervisor could resume one of them into a folder
// that is gone, or that a new run of the same project id is using: a run failed
// on quota, its folder was cleaned, the project was re-dispatched on another
// runtime, and the old `failed` row stayed active under it. A row whose worker
// is still running refuses the clean (exit 4) unless --force, which abandons it
// too (the worker itself is not stopped).
//
// Usage:
//   nrv clean <project_id>           # move to trash (reversible)
//   nrv clean <project_id> --hard    # delete permanently
//   nrv clean <project_id> --dry-run # show what would be removed
//   nrv clean <project_id> --force   # clean even while one of its runs is still working
//
// Exit codes: 0 = cleaned · 1 = nothing found · 2 = bad args · 4 = refused, a run is still working

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as runLedger from "../lib/run-ledger.ts";
import { findRunSessions } from "../lib/run-session.ts";

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", lime: "\x1b[38;5;154m" };
const noColor = process.argv.includes("--no-color") || !process.stdout.isTTY;
function c(k: keyof typeof ANSI, s: string): string { return noColor ? s : `${ANSI[k]}${s}${ANSI.reset}`; }

const positional = process.argv.slice(2).filter(a => !a.startsWith("--"));
const projectId = positional[0];
const hard = process.argv.includes("--hard");
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");

if (!projectId) {
  console.error("Usage: nrv clean <project_id> [--hard] [--dry-run] [--force]");
  process.exit(2);
}

// A directory only qualifies as a Nirvana project if it carries one of these
// markers — guards against nuking an unrelated folder that happens to match.
function isNirvanaProject(dir: string): boolean {
  // `.nirvana/project.yaml` is what `nrv init` writes, and it was missing from
  // this list — so the scaffold a user most often wants to undo was the one
  // shape `nrv clean` refused to recognise.
  const markers = ["businesses", "brief.md", "HANDOFF.json", "squads", "agent-x", path.join(".nirvana", "project.yaml")];
  return markers.some(m => fs.existsSync(path.join(dir, m)));
}

// An absolute path is the thing itself, not a name to look up. Joining one onto
// an outputs root produced candidates like
// `/Users/x/outputs/Users/x/my-project` — nonsense the user then had to read
// past to learn that `nrv clean <path>` simply is not supported. It is now.
const looksLikePath = path.isAbsolute(projectId) || projectId.startsWith("~") || projectId.includes(path.sep);
const expanded = projectId.startsWith("~") ? path.join(os.homedir(), projectId.slice(1)) : projectId;

const candidates = looksLikePath
  ? [path.resolve(expanded)]
  : [
      path.join(process.cwd(), "outputs", projectId),            // new visible default
      path.join(os.homedir(), ".nirvana/outputs", projectId),
      path.join(process.cwd(), ".nirvana/outputs", projectId),
      path.join(os.homedir(), projectId),
    ];

const projectDirs = [...new Set(candidates)].filter(d => fs.existsSync(d) && fs.statSync(d).isDirectory() && isNirvanaProject(d));

// Find any zip: cwd/<id>.zip + session.json's zip_path (any worker's session).
const zips = new Set<string>();
const cwdZip = path.resolve(`./${projectId}.zip`);
if (fs.existsSync(cwdZip)) zips.add(cwdZip);
for (const d of projectDirs) {
  for (const { file } of findRunSessions(d)) {
    try {
      const z = JSON.parse(fs.readFileSync(file, "utf8")).zip_path;
      if (z && fs.existsSync(z)) zips.add(z);
    } catch { /* ignore */ }
  }
}

// ── the project's open ledger rows ─────────────────────────────────────────
// The ledger's project id is the run folder's name, also when the argument is
// a path. A row is this project's when it is open in the project this process
// serves (the ledger's own scope), or when what it records (its scaffold, its
// project dir, its outputs root) lies inside a folder being removed — the case
// of a store run, or of a clean started from outside the project.
const ledgerProjectId = looksLikePath ? path.basename(path.resolve(expanded)) : projectId;
/** One spelling per path: resolved, real, and case-folded on Windows. */
function canonicalPath(p: string): string {
  const n = runLedger.normalizeRoot(p);
  return process.platform === "win32" ? n.toLowerCase() : n;
}
const removedDirs = projectDirs.map(canonicalPath);
function insideRemoved(p: unknown): boolean {
  if (typeof p !== "string" || !p) return false;
  const target = canonicalPath(p);
  return removedDirs.some(d => target === d || target.startsWith(d.endsWith(path.sep) ? d : d + path.sep));
}
const ledger = (() => {
  try {
    const handle = runLedger.openLedger();
    const inScope = new Set(runLedger.findNonTerminal(handle).map(r => r.run_id));
    const rows = runLedger.findNonTerminal(handle, { allProjects: true }).filter(r => r.project_id === ledgerProjectId
      && (inScope.has(r.run_id) || ["scaffold_root", "project_dir", "outputs_root"].some(k => insideRemoved(r.meta?.[k]))));
    return { handle, rows };
  } catch (e) {
    console.error(c("yellow", `⚠ run ledger unavailable (${(e as Error)?.message ?? e}): the project's open runs were not checked nor closed.`));
    return null;
  }
})();
const openRows = ledger?.rows ?? [];

if (projectDirs.length === 0 && zips.size === 0 && openRows.length === 0) {
  console.error(c("yellow", `Nothing found for '${projectId}'. Looked in:`));
  candidates.forEach(p => console.error("  " + p));
  process.exit(1);
}

console.log("");
console.log(c("lime", "▶") + c("bold", ` nrv clean — ${projectId}`));
console.log(c("dim", `  mode: ${hard ? "HARD (deletes)" : "trash (reversible)"}${dryRun ? " · dry-run" : ""}`));
[...projectDirs, ...zips].forEach(p => console.log(c("dim", `  target: ${p}`)));
openRows.forEach(r => console.log(c("dim", `  open run: ${r.run_id} (${r.target_kind ?? "?"}/${r.target_slug ?? "?"}, ${r.state}) → abandoned`)));

// A run still at work in the folder: moving the folder from under it breaks the
// run, and abandoning its row hides it from the supervisor. Refused before
// anything moves, unless --force.
const working = openRows.filter(r => runLedger.stillWorking(r));
if (working.length && !force && dryRun) {
  console.log(c("yellow", `  still running: ${working.map(r => r.run_id).join(", ")} (without --force the clean is refused)`));
} else if (working.length && !force) {
  console.error("");
  for (const r of working) {
    const why = runLedger.workerPidAlive(r) ? `worker pid ${r.child_pid} is alive` : `its lease runs until ${r.lease_expires_at}`;
    console.error(c("red", `✗ run ${r.run_id} (${r.target_kind ?? "?"}/${r.target_slug ?? "?"}, ${r.state}) is still running: ${why}.`));
  }
  const pids = working.filter(r => runLedger.workerPidAlive(r)).map(r => r.child_pid);
  if (pids.length) {
    console.error(`  Stop it first: ${process.platform === "win32" ? pids.map(p => `taskkill /PID ${p} /T /F`).join(" & ") : `kill ${pids.join(" ")}`}, or wait for it to finish.`);
  } else {
    console.error("  Wait for it to finish, or for its lease to run out.");
  }
  console.error(`  Or run nrv clean ${projectId} --force to clean anyway: the run is abandoned, its worker is not stopped.`);
  process.exit(4);
}

if (dryRun) {
  console.log("");
  console.log(c("yellow", "  dry-run: nothing removed."));
  process.exit(0);
}

const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const trashRoot = path.join(os.homedir(), ".nirvana", "trash", `${projectId}-${ts}`);
const moved: string[] = [];

function dispose(target: string, kind: "dir" | "file"): void {
  if (hard) {
    fs.rmSync(target, { recursive: true, force: true });
  } else {
    fs.mkdirSync(trashRoot, { recursive: true });
    const dest = path.join(trashRoot, path.basename(target));
    try {
      fs.renameSync(target, dest);
    } catch (e: any) {
      // Cross-device (EXDEV): trash on another volume. Copy then remove.
      if (e?.code === "EXDEV") {
        fs.cpSync(target, dest, { recursive: true });
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        throw e;
      }
    }
  }
  moved.push(target);
}

for (const d of projectDirs) dispose(d, "dir");
for (const z of zips) dispose(z, "file");

// The project's open rows end here: a supervisor must not resume a run into a
// folder that is gone, nor into the one a new run of this project id is using.
const abandoned: string[] = [];
for (const r of openRows) {
  try {
    const now = runLedger.getRun(ledger!.handle, r.run_id);
    if (!now || runLedger.isTerminal(now.state)) continue;
    runLedger.abandon(ledger!.handle, r.run_id, "project cleaned");
    abandoned.push(r.run_id);
  } catch (e) {
    console.error(c("yellow", `⚠ run ${r.run_id} was not closed: ${(e as Error)?.message ?? e}`));
  }
}

function appendAudit(payload: Record<string, any>): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { harnessLogsDir } = require(path.join(SKILLS_ROOT, "_shared/lib/log-paths.ts"));
    // Try to route the purge event into the project's own logs first (so the
    // record stays with the project being purged). projectDirs[0] is the
    // best cwd hint we have here.
    const dir = path.join(harnessLogsDir({ cwd: projectDirs[0] || process.cwd() }), today);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n");
  } catch { /* non-fatal */ }
}
appendAudit({ event: "project_purged", project_id: projectId, hard, removed: moved, trash: hard ? null : trashRoot, abandoned_runs: abandoned });

console.log("");
console.log(c("green", `✓ Removed (${moved.length} target(s)).`));
if (abandoned.length) console.log(c("dim", `  Open runs abandoned: ${abandoned.join(", ")}`));
if (!hard && moved.length) console.log(c("dim", `  Recoverable at: ${trashRoot}`));
console.log("");
process.exit(0);
