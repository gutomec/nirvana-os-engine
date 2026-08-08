#!/usr/bin/env bun
// gen-audit-events-doc.ts — render the audit-event enum table into
// skills/harness/references/03-audit.md from the single source of truth
// (lib/audit.js ALLOWED_EVENTS), between BEGIN/END markers.
//
// The table used to be hand-written and fossilized (21 events documented, 96
// real). Generating it — plus the test in
// skills/harness/tests/audit-events-doc.test.ts asserting the doc matches —
// makes divergence a test failure instead of a silent lie.
//
// Usage:
//   bun scripts/gen-audit-events-doc.ts            # print the rendered block
//   bun scripts/gen-audit-events-doc.ts --write    # update 03-audit.md in place
//   bun scripts/gen-audit-events-doc.ts --check    # exit 1 when out of sync

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(ROOT, "skills", "harness", "references", "03-audit.md");

export const BEGIN = "<!-- BEGIN GENERATED: audit-events (scripts/gen-audit-events-doc.ts — do not edit by hand) -->";
export const END = "<!-- END GENERATED: audit-events -->";

export function allowedEvents(): string[] {
  const requireCjs = createRequire(import.meta.url);
  const audit = requireCjs(join(ROOT, "skills", "harness", "lib", "audit.js"));
  return [...(audit.ALLOWED_EVENTS as Set<string>)];
}

/** The full generated block, markers included. Declaration order preserved —
 *  it groups events by the phase that introduced them (audit.js comments). */
export function renderBlock(): string {
  const events = allowedEvents();
  const lines: string[] = [];
  lines.push(BEGIN);
  lines.push("");
  lines.push(`${events.length} events in the closed enum (declaration order of \`ALLOWED_EVENTS\` in \`lib/audit.js\`):`);
  lines.push("");
  lines.push("```");
  for (const e of events) lines.push(e);
  lines.push("```");
  lines.push(END);
  return lines.join("\n");
}

export function currentDoc(): string {
  return readFileSync(DOC, "utf8");
}

export function docInSync(): boolean {
  const doc = currentDoc();
  const start = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1) return false;
  return doc.slice(start, end + END.length) === renderBlock();
}

function writeDoc(): void {
  const doc = currentDoc();
  const start = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1) {
    console.error(`gen-audit-events-doc: markers not found in ${DOC}`);
    process.exit(1);
  }
  const next = doc.slice(0, start) + renderBlock() + doc.slice(end + END.length);
  writeFileSync(DOC, next, "utf8");
  console.log(`gen-audit-events-doc: wrote ${allowedEvents().length} events into ${DOC}`);
}

if (import.meta.main) {
  if (process.argv.includes("--write")) {
    writeDoc();
  } else if (process.argv.includes("--check")) {
    if (docInSync()) {
      console.log("gen-audit-events-doc: 03-audit.md is in sync with ALLOWED_EVENTS");
    } else {
      console.error("gen-audit-events-doc: 03-audit.md is OUT OF SYNC — run: bun scripts/gen-audit-events-doc.ts --write");
      process.exit(1);
    }
  } else {
    console.log(renderBlock());
  }
}
