// run-plumbing.ts — what the harness writes NEXT TO a deliverable, and which is
// never one.
//
// This list existed three times, privately, and the copies disagreed:
//
//   verify-deliverable.ts   12 entries, correct
//   serve/artifacts.ts       3 entries  → the API served the employee's prompt
//   build-report-html.ts     1 entry    → the client report embedded it
//
// Measured on a customer VPS (2026-09-18): `GET /v1/jobs/<trace>/artifacts/
// final-report.html` returned 81 KB that contained no line of the delivered
// work and every line of the run's instrumentation — the employee's full system
// prompt, the mind-clone library, the business manifest and the firm's
// permanent memory. That is the intellectual property of a pack sold for
// US$ 1,290, downloadable by anyone holding a session key.
//
// A private copy of an exclusion list is where a leak gets in, every time. One
// list, every consumer.
import * as path from "node:path";

/** Files the engine writes beside the work. Never a deliverable. */
export const RUN_PLUMBING: ReadonlySet<string> = new Set([
  // What the dispatcher and the loop leave behind
  "HANDOFF.json", "audit.jsonl", "deliverables.json", "brief.md", ".brief.md",
  "agent-prompt.md", ".step-brief.md", "session.json", "sessions.json",
  "chain.json", "dag-state.json", ".run.json", "run-budget.json",
  // Promoted into the run envelope as fields; not files a client downloads
  "_SUMMARY.md", "_QA-RESERVATIONS.md",
  // The project's own contract, which travels with every Nirvana project and
  // describes the engine rather than the work
  "AGENTS.md", "CLAUDE.md", "GEMINI.md",
]);

/** Directories that hold run state or the engine itself, never deliverables. */
export const RUN_PLUMBING_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", ".nirvana", ".squad-state", ".squads-outputs",
  ".harness-logs", ".wiki-brain-state", ".vercel", ".omc", "_internal", "_report",
  // The report publisher's working folder in runs made before it was renamed.
  "relatorio",
]);

/** True when this file is instrumentation rather than work. Name-based on
 *  purpose: the same file is plumbing wherever it lands in the tree. */
export function isRunPlumbing(fileOrPath: string): boolean {
  return RUN_PLUMBING.has(path.basename(fileOrPath));
}

/** True when nothing under this directory can be a deliverable. */
export function isRunPlumbingDir(name: string): boolean {
  return RUN_PLUMBING_DIRS.has(path.basename(name));
}

/** What a run writes about itself beside the work: the worker's summary and
 *  claims, the gate's reservations and status, the prompt it was handed, its
 *  session and its trail. Matched by basename, wherever it lands. */
export const RUN_STATE_FILES: ReadonlySet<string> = new Set([
  "_SUMMARY.md", "_CLAIMS.json", "_QA-RESERVATIONS.md", "_STATUS.json",
  "solo-prompt.md", "agent-prompt.md", "participation.json", "session.json",
  "HANDOFF.json", "audit.jsonl",
]);

/** The worker's scratch folder and the reviewer's folder: everything under
 *  them is run state, at any depth. */
const RUN_STATE_DIRS: ReadonlySet<string> = new Set(["_work", "_review"]);

/**
 * True when `relPath` (relative to an outputs root, a run folder or an archive
 * source) is run state rather than work. Every place that counts, gates,
 * verifies, reports, zips or exports deliverables asks this one question, so
 * a run that left only its own bookkeeping is never mistaken for a delivery.
 *
 * Either separator is accepted, and on Windows names compare without case, so
 * `_work\\PROGRESS.md` and `_Summary.md` answer the same there as their POSIX
 * spellings. A path ending in a separator is a directory: `isRunStateFile("_work/")`
 * lets a walker prune the whole folder.
 *
 * `cards/` is where the engine writes the squad cards for a solo worker, at the
 * top of the run folder (`cards/…`, or `businesses/<slug>/cards/…` seen from the
 * run root). Only those positions count: a deliverable folder that happens to
 * be called `cards` deeper in the tree is work.
 */
export function isRunStateFile(relPath: string, platform: NodeJS.Platform = process.platform): boolean {
  const normalised = relPath.replace(/\\/g, "/");
  const fold = (s: string) => (platform === "win32" ? s.toLowerCase() : s);
  const segs = normalised.split("/").filter((s) => s && s !== ".").map(fold);
  if (!segs.length) return false;
  const isDir = normalised.endsWith("/");
  const dirs = isDir ? segs : segs.slice(0, -1);
  if (!isDir) {
    const base = segs[segs.length - 1];
    for (const f of RUN_STATE_FILES) if (fold(f) === base) return true;
  }
  if (dirs.some((d) => [...RUN_STATE_DIRS].some((r) => fold(r) === d))) return true;
  return dirs[0] === "cards" || (dirs[0] === "businesses" && dirs[2] === "cards");
}
