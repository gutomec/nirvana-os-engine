// return-handoff.ts — the closing handoff a dispatch prints for the orchestrator.
//
// The orchestrating agent reads the end of `nrv dispatch` / `nrv revise` and
// reports to the user from it. Without the files named by their full paths the
// report came back as a localhost URL and the user had to ask where the work
// was, so the engine names every delivered file itself and says what the
// report must carry.

import * as fs from "node:fs";
import * as path from "node:path";
import { deliverableFiles } from "./solo-review.ts";

/** Files listed one by one; past this the rest is a count and the folder. */
export const HANDOFF_FILE_CAP = 25;

const HANDOFF_STATES: ReadonlySet<string> = new Set(["delivered", "delivered_with_reservations", "withheld"]);

/** The lines to print after a delivery was judged: every deliverable by its
 *  absolute path, the summary's path, and what the orchestrator reports to the
 *  user (`projectId` names the run in the revise command). Empty for a state
 *  that delivered nothing to report (stopped, waiting on quota, indeterminate,
 *  failed). */
export function returnHandoffLines(outputsRoot: string, state: string, projectId = "<project>"): string[] {
  if (!HANDOFF_STATES.has(state)) return [];
  const root = path.resolve(outputsRoot);
  const files = deliverableFiles(root).sort().map((rel) => path.join(root, ...rel.split("/")));
  const withheld = state === "withheld";
  const lines: string[] = [];
  lines.push(withheld ? `  Files on disk, NOT delivered (${files.length}):` : `  Delivered files (${files.length}):`);
  for (const file of files.slice(0, HANDOFF_FILE_CAP)) lines.push(`    ${file}`);
  if (files.length > HANDOFF_FILE_CAP) lines.push(`    +${files.length - HANDOFF_FILE_CAP} more under ${root}`);
  const summary = path.join(root, "_SUMMARY.md");
  lines.push(`  Summary:      ${fs.existsSync(summary) ? summary : "(no _SUMMARY.md was written)"}`);
  lines.push("");
  lines.push("  Report to the user now, in their language:");
  lines.push(withheld
    ? "    1. that the delivery was withheld and why (_STATUS.json, _GATE-FINDINGS.md), and what was done (from _SUMMARY.md)"
    : "    1. what was done (from _SUMMARY.md)");
  lines.push(`    2. each ${withheld ? "file on disk" : "delivered file"} by its full path, and how to open it`);
  lines.push('    3. the "Going live" steps in _SUMMARY.md, when it has them: what the user must do, and what you need from them to do it for them');
  lines.push(`    4. the decisions made for them and why (from "Decisions made for you" in _SUMMARY.md); a different choice is nrv revise ${projectId} "<change>", which goes back to the same worker in the same session`);
  lines.push("    5. what is still open");
  return lines;
}
