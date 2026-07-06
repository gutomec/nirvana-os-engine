/**
 * outputs-lint.js — detect run-artifact pollution inside squad/business dirs.
 *
 * Run-output dirs MUST live under <projectRoot>/.nirvana/outputs/<run_id>/.
 * When they appear inside a squad/business dir, copying that squad/business
 * to another project carries old run state, which is the bug we're guarding
 * against. See ~/.nirvana/skills/_shared/OUTPUTS_CONTRACT.md.
 *
 * Returns { errors, warnings } — caller decides how to escalate.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Names that are unambiguously run output. Block these.
const FORBIDDEN_NAMES = new Set(['outputs', 'output']);

// Names that are usually run output but occasionally legitimate fixture dirs.
// Warn only.
const SUSPICIOUS_NAMES = new Set(['runs', 'results']);

// Top-level entries matching these patterns are almost always run artifacts.
const SUSPICIOUS_PATTERNS = [
  /^proj-/,                              // brief-business default project_id
  /^\d{8}T\d{6}/,                        // ISO-ish timestamp prefix
  /^run-\d/,                             // run-1, run-001, etc.
];

function lintDir(dir) {
  const errors = [];
  const warnings = [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { errors, warnings };
  }
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return { errors, warnings }; }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const lower = e.name.toLowerCase();
    if (FORBIDDEN_NAMES.has(lower)) {
      errors.push(`run-output dir '${e.name}/' must not exist inside a portable squad/business — move to <projectRoot>/.nirvana/outputs/`);
      continue;
    }
    if (SUSPICIOUS_NAMES.has(lower)) {
      warnings.push(`'${e.name}/' looks like run output; if it is, move it under <projectRoot>/.nirvana/outputs/`);
      continue;
    }
    for (const pat of SUSPICIOUS_PATTERNS) {
      if (pat.test(e.name)) {
        warnings.push(`'${e.name}/' matches a run-id pattern; if it is run output, move under <projectRoot>/.nirvana/outputs/`);
        break;
      }
    }
  }
  return { errors, warnings };
}

module.exports = { lintDir, FORBIDDEN_NAMES, SUSPICIOUS_NAMES, SUSPICIOUS_PATTERNS };
