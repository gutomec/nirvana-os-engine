#!/usr/bin/env bun
// seal.ts — `nrv seal`: is a delivery still what the gate approved?
//
//   nrv seal check <project>     compare the project's deliverables with its seal
//   nrv seal check --dir <dir>   the same, for an outputs folder named by path
//
// Read-only. Written for an agent to run: the answer says what moved and what
// to do about it. Exit 0 intact · 1 something moved, or there is no seal ·
// 4 wrong arguments.
import * as path from "node:path";
import { EXIT, parseArgs } from "../../_shared/lib/bun-helpers.ts";
import { candidateArtifacts } from "../lib/delivery-pipeline.ts";
import { checkSeal } from "../lib/delivery-seal.ts";
import { readRunSession } from "../lib/run-session.ts";

const USAGE = [
  "usage: nrv seal check <project> | --dir <outputs folder>   [--json]",
  "  Compares the deliverables with the hashes recorded when the delivery was approved.",
].join("\n");

const { positional, flags } = parseArgs();
const [cmd, project] = positional;
const fail = (line: string, code: number = EXIT.FAILURES): never => { console.error(line); process.exit(code); };
if (cmd !== "check" || (!project && typeof flags.dir !== "string")) { console.error(USAGE); process.exit(cmd ? EXIT.INVALID_ARGS : EXIT.OK); }

let outputsRoot: string;
if (typeof flags.dir === "string") {
  outputsRoot = path.resolve(flags.dir);
} else {
  const found = readRunSession(project!);
  if (!found.ok) fail(`seal: ${found.reason}`);
  const root = (found as { data: Record<string, any> }).data.outputs_root;
  if (typeof root !== "string" || !root) fail(`seal: the run of ${project} recorded no outputs folder. Name it: nrv seal check --dir <folder>`);
  outputsRoot = root as string;
}

const result = checkSeal(outputsRoot, candidateArtifacts(outputsRoot, ""));
if (flags.json) { console.log(JSON.stringify({ ok: result.sealed && result.intact && !result.staleInputs.length, outputs_root: outputsRoot, ...result })); process.exit(result.sealed && result.intact ? EXIT.OK : EXIT.FAILURES); }

if (!result.sealed) {
  console.log(`No seal in ${outputsRoot}.`);
  console.log("A seal is written when a delivery goes out. This folder was delivered before seals existed, was withheld, or is not a delivery.");
  process.exit(EXIT.FAILURES);
}
console.log(`Sealed ${result.sealedAt} (gate: ${result.gate}) — ${outputsRoot}`);
if (result.intact && !result.staleInputs.length) {
  console.log("Intact: every deliverable is what the gate approved, and the inputs it was built from are unchanged.");
  process.exit(EXIT.OK);
}
const show = (title: string, items: string[]) => { if (items.length) { console.log(`${title} (${items.length}):`); for (const i of items) console.log(`  ${i}`); } };
show("Edited after the approval", result.changed);
show("Removed after the approval", result.missing);
show("Added after the approval, never gated", result.added);
show("Inputs that changed since the work was built from them", result.staleInputs);
console.log("");
console.log(result.intact
  ? `The deliverables are untouched, but they were built from inputs that changed. Bring them up to date: nrv revise ${project ?? "<project>"} "update the work to the current inputs"`
  : `The folder no longer holds what was approved. To have it gated and sealed again: nrv revise ${project ?? "<project>"} "<what should change, or: keep the edits as they are>"`);
process.exit(EXIT.FAILURES);
