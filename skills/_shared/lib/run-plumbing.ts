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
// relatorio-final.html` returned 81 KB that contained no line of the delivered
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
  "chain.json", "dag-state.json", ".run.json",
  // Promoted into the run envelope as fields; not files a client downloads
  "_SUMMARY.md", "_QA-RESERVATIONS.md",
  // The project's own contract, which travels with every Nirvana project and
  // describes the engine rather than the work
  "AGENTS.md", "CLAUDE.md", "GEMINI.md",
]);

/** Directories that hold run state or the engine itself, never deliverables. */
export const RUN_PLUMBING_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", ".nirvana", ".squad-state", ".squads-outputs",
  ".harness-logs", ".wiki-brain-state", ".vercel", ".omc", "_internal", "relatorio",
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
