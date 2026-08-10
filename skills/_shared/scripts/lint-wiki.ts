#!/usr/bin/env bun
/**
 * lint-wiki.ts — CLI for cross-document consistency lint.
 *
 * Usage:
 *   bun lint-wiki.ts <file1> <file2> [<file3>...] [--anchors <a,b>] [--project <id>] [--json]
 *
 * Exit codes:
 *   0 — pass (no contradictions or only low-severity)
 *   1 — fail or needs_revision (contradictions found)
 *   2 — invalid args
 *   3 — host runtime unavailable / lint skipped
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs, EXIT } from "../lib/bun-helpers.ts";

const wl = require("../lib/wiki-lint.js");

const { positional, flags } = parseArgs();
const files = positional.filter(p => !p.startsWith("--"));
const jsonOut = !!flags.json;
const anchors = typeof flags.anchors === "string" ? flags.anchors.split(",").map(s => s.trim()) : [];
const projectId = typeof flags.project === "string" ? flags.project : null;

if (files.length < 2) {
  console.error("usage: lint-wiki <file1> <file2> [<file3>...] [--anchors <a,b>] [--project <id>] [--json]");
  process.exit(EXIT.INVALID_ARGS);
}

for (const f of files) {
  if (!fs.existsSync(f)) {
    console.error(`[lint-wiki] file not found: ${f}`);
    process.exit(EXIT.INVALID_ARGS);
  }
}

const absFiles = files.map(f => path.resolve(f));
const absAnchors = anchors.map(f => path.resolve(f));

console.error(`[lint-wiki] linting ${absFiles.length} docs${absAnchors.length ? ` (${absAnchors.length} anchors)` : ""}…`);

const r = await wl.lintDocs({
  files: absFiles,
  anchor_files: absAnchors,
  project_id: projectId,
  timeoutMs: 180_000,
});

if (jsonOut) {
  console.log(JSON.stringify(r, null, 2));
} else {
  console.log("");
  console.log(`══════ Wiki Lint Result ══════`);
  console.log(`  verdict:  ${r.verdict}${r.score != null ? `  (score=${r.score}/100)` : ""}`);
  if (r.host) console.log(`  host:     ${r.host}`);
  if (r.reason) console.log(`  reason:   ${r.reason}`);
  console.log(`  contradictions: ${(r.contradictions || []).length}`);
  console.log("");
  for (const c of (r.contradictions || [])) {
    const sev = (c.severity || "medium").toUpperCase();
    const cat = c.category || "unknown";
    console.log(`  [${sev}/${cat}]`);
    if (c.claim_a) console.log(`    A: ${c.claim_a.doc} — "${(c.claim_a.text || "").slice(0, 140)}"`);
    if (c.claim_b) console.log(`    B: ${c.claim_b.doc} — "${(c.claim_b.text || "").slice(0, 140)}"`);
    if (c.evidence) console.log(`    why: ${c.evidence}`);
    if (c.suggested_resolution) console.log(`    fix: ${c.suggested_resolution}`);
    console.log("");
  }
}

if (r.verdict === "skipped") process.exit(3);
if (r.verdict === "fail" || r.verdict === "needs_revision") process.exit(EXIT.FAILURES);
process.exit(EXIT.OK);
