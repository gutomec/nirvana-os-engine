#!/usr/bin/env bun
/**
 * validate-business.ts — validate a single business manifest + integrity.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { exec, paths, EXIT, BUN_BIN } from "../../_shared/lib/bun-helpers.ts";
import { resolveScope, enumerate } from "../../_shared/lib/scope.ts";

const SKILL_DIR = path.join(paths.CLAUDE_SKILLS_DIR, "businesses");
const outputsLint = require(path.join(paths.CLAUDE_SKILLS_DIR, "_shared", "lib", "outputs-lint.js"));
const slug = process.argv[2];
if (!slug) {
  console.error("usage: validate-business <slug>");
  process.exit(EXIT.INVALID_ARGS);
}

const scopedDir = enumerate(resolveScope(), "businesses").find(e => e.slug === slug && !e.overridden)?.dir;
const candidates = [
  ...(scopedDir ? [scopedDir] : []),
  path.join(paths.BUSINESSES_DIR, slug),
  slug,
];
const target = candidates.find(p => fs.existsSync(p));
if (!target) {
  console.error(`ERRO: business não encontrada (tentou: ${candidates.join(", ")})`);
  process.exit(EXIT.INVALID_ARGS);
}

// Outputs-pollution lint — block run-output dirs leaking into a portable business.
const lintResult = outputsLint.lintDir(target);
for (const w of lintResult.warnings) console.log(`[WARN] outputs-lint: ${w}`);
if (lintResult.errors.length > 0) {
  for (const e of lintResult.errors) console.error(`[FAIL] outputs-lint: ${e}`);
  process.exit(EXIT.FAILURES);
}

const r = exec(`${JSON.stringify(BUN_BIN)} ${JSON.stringify(path.join(SKILL_DIR, "lib", "loader.ts"))} ${JSON.stringify(target)}`, { silent: false });
process.exit(r.code ?? (r.ok ? EXIT.OK : EXIT.FAILURES));
