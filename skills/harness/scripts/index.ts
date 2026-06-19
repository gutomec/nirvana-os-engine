#!/usr/bin/env bun
/**
 * index.ts — rebuild the harness routing index (squads + businesses + mind-clones).
 *
 * Previously this wrapper invoked `node lib/registry-loader.js`, which is a
 * read-only library with no `main` entry — every call was a silent no-op,
 * leaving registries stale for days. This version delegates to the actual
 * indexer scripts and surfaces their output.
 *
 * Usage:
 *   nrv index                         # rebuild both, summary on stdout
 *   nrv index --quiet                 # silence per-skill summaries, only emit final tally
 *   nrv index --json                  # emit machine-readable JSON to stdout
 *   nrv index squads | businesses | clones   # rebuild only one
 *
 * Exit codes:
 *   0  both registries rebuilt cleanly
 *   1  at least one indexer failed
 *   2  bad CLI usage
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { paths, EXIT } from "../../_shared/lib/bun-helpers.ts";

const args = process.argv.slice(2);
const quiet = args.includes("--quiet") || args.includes("-q");
const jsonOut = args.includes("--json");
const targets = args.filter(a => !a.startsWith("-"));
const want = (t: string) => targets.length === 0 || targets.includes(t);

const BUN = process.execPath.endsWith("/bun") ? process.execPath : "bun";

function runIndexer(label: string, scriptRelPath: string) {
  const start = Date.now();
  const script = path.join(paths.CLAUDE_SKILLS_DIR, scriptRelPath);
  if (!fs.existsSync(script)) {
    return { label, ok: false, ms: 0, error: `indexer script missing: ${script}`, stdout: "", stderr: "" };
  }
  const childArgs = [script];
  if (quiet) childArgs.push("--quiet");
  if (jsonOut) childArgs.push("--json");
  const r = spawnSync(BUN, childArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const ms = Date.now() - start;
  return {
    label,
    ok: r.status === 0,
    code: r.status ?? -1,
    ms,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

const results: any[] = [];
if (want("squads"))     results.push(runIndexer("squads",     "squads/scripts/index-squads.ts"));
if (want("businesses")) results.push(runIndexer("businesses", "businesses/scripts/index-businesses.ts"));
if (want("clones") || want("mind-clones")) results.push(runIndexer("clones", "_shared/scripts/index-clones.ts"));

if (jsonOut) {
  console.log(JSON.stringify({
    ok: results.every(r => r.ok),
    results: results.map(r => ({ label: r.label, ok: r.ok, code: r.code, ms: r.ms, stdout: r.stdout, stderr: r.stderr })),
  }, null, 2));
} else {
  for (const r of results) {
    if (!quiet && r.stdout.trim()) {
      process.stdout.write(r.stdout);
      if (!r.stdout.endsWith("\n")) process.stdout.write("\n");
    }
    if (r.stderr.trim()) process.stderr.write(r.stderr);
    if (!r.ok) {
      console.error(`[index] ✗ ${r.label} failed (exit ${r.code}, ${r.ms}ms)${r.error ? " — " + r.error : ""}`);
    } else {
      console.log(`[index] ✓ ${r.label} rebuilt in ${r.ms}ms`);
    }
  }
  const totalMs = results.reduce((s, r) => s + r.ms, 0);
  const failed = results.filter(r => !r.ok).length;
  console.log(`[index] ${results.length - failed}/${results.length} ok · ${totalMs}ms total`);
}

process.exit(results.every(r => r.ok) ? EXIT.OK : EXIT.FAILURES);
