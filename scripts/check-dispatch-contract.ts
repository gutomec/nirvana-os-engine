#!/usr/bin/env bun
/**
 * check-dispatch-contract.ts — the protocol must teach how a dispatch comes home.
 *
 * A spawn returns "Async agent launched successfully" immediately: a launch
 * receipt. The work arrives later, in a `<task-notification>` carrying
 * `<result>` with the target's full report. Two things, two moments. Every
 * failure this gate guards against is a confusion between them.
 *
 * What went wrong before, in order, because the second mistake was mine:
 *
 *  1. The protocol never said the receipt was not the result. A real 13-target
 *     run took 13 receipts as results, never waited for a notification, and
 *     spent nine hours scanning `find`/`ls` to guess what had finished.
 *  2. I then mandated `run_in_background: false` everywhere. That does return
 *     the work in the tool result — by blocking the session for the entire run.
 *     A 45-minute deploy stack left the owner unable to say a word: messages
 *     queued unread behind work they were not about. Correct results, wrong
 *     trade, and it discarded a mechanism that already worked.
 *
 * So the contract is: dispatch in the background, stay available, collect on
 * the notification. This gate fails the build on either mistake — an example
 * that forces blocking, or a protocol that stops explaining where the result
 * actually comes from.
 *
 * Usage: bun scripts/check-dispatch-contract.ts
 * Exit: 0 clean · 1 a rule is missing or an example blocks the session
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PROTOCOL_FILES = [
  "skills/harness/SKILL.md",
  "skills/harness/references/04-multi-target.md",
  "skills/businesses/SKILL.md",
  "skills/squads/SKILL.md",
  "skills/_shared/adapters/claude-code.md",
];

/** Rules that must be stated where the orchestrator will read them. */
const REQUIRED: { file: string; label: string; test: RegExp }[] = [
  { file: "skills/harness/SKILL.md", label: "the receipt is not the result", test: /launch receipt/i },
  { file: "skills/harness/SKILL.md", label: "the result arrives by notification", test: /task-notification/i },
  { file: "skills/harness/SKILL.md", label: "never poll the filesystem", test: /[Nn]ever poll the filesystem/ },
  { file: "skills/harness/SKILL.md", label: "no timeout on a dispatch", test: /never set a timeout on a dispatch/i },
  { file: "skills/harness/SKILL.md", label: "do not block the session", test: /[Dd]o not block the session/ },
  { file: "skills/businesses/SKILL.md", label: "the handoff arrives by notification", test: /task-notification/i },
  { file: "skills/squads/SKILL.md", label: "a phase reports by notification", test: /task-notification/i },
  { file: "skills/harness/references/04-multi-target.md", label: "a wave is one message", test: /A wave is one message/ },
];

const findings: string[] = [];
let examples = 0;

// 1. No example may force a blocking dispatch.
for (const rel of PROTOCOL_FILES) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    console.error(`  ✗ protocol file not found: ${rel}`);
    console.error("    This gate reads a fixed list; a renamed file must be updated here, not dropped.");
    process.exit(1);
  }
  const text = readFileSync(abs, "utf8");
  for (const m of text.matchAll(/Agent\(\{[\s\S]{0,600}?\}\)/g)) {
    examples++;
    if (!/run_in_background:\s*false/.test(m[0])) continue;
    const line = text.slice(0, m.index).split("\n").length;
    findings.push(`${rel}:${line} — forces run_in_background: false, which blocks the session for the whole run`);
  }
}

// 2. Every rule must still be stated.
for (const r of REQUIRED) {
  const text = readFileSync(join(ROOT, r.file), "utf8");
  if (!r.test.test(text)) findings.push(`${r.file} — no longer states: ${r.label}`);
}

console.log("DISPATCH CONTRACT (background dispatch, collected on notification)");
console.log(`  scanned ......... ${PROTOCOL_FILES.length} protocol files · ${examples} Agent({...}) example(s) · ${REQUIRED.length} rules`);

if (findings.length) {
  console.error(`\n  ✗ ${findings.length} problem(s)\n`);
  for (const f of findings) console.error(`    ${f}`);
  console.error("\n  The contract: dispatch in the background, stay available for the user,");
  console.error("  and collect the work from the <task-notification> that carries <result>.");
  console.error("  Blocking returns the same work at the cost of the conversation.\n");
  process.exit(1);
}

console.log("  (clean — dispatches stay non-blocking and the protocol says where results come from)");
