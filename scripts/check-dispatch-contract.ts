#!/usr/bin/env bun
/**
 * check-dispatch-contract.ts — every dispatch example in the agentic protocol
 * must spawn its subagent SYNCHRONOUSLY.
 *
 * Why this gate exists. The subagent tool defaults to background. A background
 * dispatch returns "Async agent launched successfully" — a launch receipt, not
 * the target's work. Every instruction downstream of a dispatch assumes a real
 * result: the harness waits for the return (Phase 5), a business reads the
 * handoff artifact to pick the next employee (businesses SKILL.md step 6), a
 * workflow phase consumes the previous phase's output. None of that survives a
 * launch receipt.
 *
 * The protocol shipped dispatch examples without the flag, and the model did
 * exactly what the examples showed. Measured on a real 13-target run: 13
 * dispatches, 13 launch receipts, zero results — and an orchestrator reduced to
 * scanning the filesystem to guess what had finished.
 *
 * Prose cannot enforce itself, so this gate reads the protocol the way the model
 * does and fails the build on any `Agent({...})` that would fire and forget.
 *
 * Usage: bun scripts/check-dispatch-contract.ts
 * Exit: 0 clean · 1 a dispatch example is missing the flag
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The files the orchestrator actually reads when it decides how to dispatch. */
const PROTOCOL_FILES = [
  "skills/harness/SKILL.md",
  "skills/harness/references/04-multi-target.md",
  "skills/businesses/SKILL.md",
  "skills/squads/SKILL.md",
  "skills/_shared/adapters/claude-code.md",
];

/** Matches an `Agent({ ... })` spawn example, including multi-line ones. */
const SPAWN = /Agent\(\{[\s\S]{0,600}?\}\)/g;

/** The only accepted opt-out: the example deliberately sets the flag true,
 *  i.e. it IS the background exception. An earlier version of this gate
 *  exempted any example whose surrounding lines mentioned "background", which
 *  silently exempted every example under the paragraph explaining why
 *  background is wrong — the exemption swallowed exactly what it had to catch.
 *  Proximity is not intent; the flag is. */
const DELIBERATE_BACKGROUND = /run_in_background:\s*true/;

interface Finding { file: string; line: number; snippet: string }

const findings: Finding[] = [];
let examples = 0;
const missingFiles: string[] = [];

for (const rel of PROTOCOL_FILES) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) { missingFiles.push(rel); continue; }
  const text = readFileSync(abs, "utf8");
  for (const m of text.matchAll(SPAWN)) {
    examples++;
    const snippet = m[0];
    if (snippet.includes("run_in_background: false") || DELIBERATE_BACKGROUND.test(snippet)) continue;
    // Line number of the match, for a clickable error.
    const line = text.slice(0, m.index).split("\n").length;
    findings.push({ file: rel, line, snippet: snippet.replace(/\s+/g, " ").slice(0, 90) });
  }
}

console.log("DISPATCH CONTRACT (subagent spawns are synchronous)");
if (missingFiles.length) {
  console.error(`  ✗ protocol file(s) not found: ${missingFiles.join(", ")}`);
  console.error("    This gate reads a fixed list; a renamed file must be updated here, not dropped.");
  process.exit(1);
}
console.log(`  scanned ......... ${PROTOCOL_FILES.length} protocol files · ${examples} Agent({...}) example(s)`);

if (findings.length) {
  console.error(`\n  ✗ ${findings.length} dispatch example(s) missing run_in_background: false\n`);
  for (const f of findings) console.error(`    ${f.file}:${f.line}\n      ${f.snippet}`);
  console.error("\n  A background dispatch returns a launch receipt, not the target's work.");
  console.error("  Add `run_in_background: false` — or, if the example is teaching the");
  console.error("  background exception, say so in the surrounding lines.\n");
  process.exit(1);
}

console.log("  (clean — every dispatch example returns its result to the orchestrator)");
