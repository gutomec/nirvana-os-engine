/**
 * wiki-lint.js — orchestrate cross-document consistency check.
 *
 * Reads N documents (briefs, entity pages, outputs), packages them into a
 * multi-artifact context, and calls quality-judge with phase='wiki_lint'.
 * The rubric (`~/.nirvana/skills/_shared/rubrics/wiki-lint.md`) defines the
 * verdict shape; the LLM does the actual semantic comparison.
 *
 * Cost: 1 LLM call per lint run. Best used in pre-ship gate (rare), not in
 * audit-batch (frequent).
 *
 * Public API:
 *   const r = await lintDocs({ files, anchor_files?, project_id?, timeoutMs? });
 *   // → { verdict, score, contradictions: [...], host, deterministic_findings }
 *
 * `files` is the full set of docs to compare. `anchor_files` (optional)
 * is a subset that is treated as authoritative — when set, contradictions
 * are reported as "downstream doc deviates from anchor X".
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

let _judge = null;
function loadJudge() {
  if (_judge) return _judge;
  try { _judge = require(path.join(SKILLS_ROOT, '_shared', 'lib', 'quality-judge.js')); }
  catch { _judge = null; }
  return _judge;
}

// Walk up from cwd looking for .nirvana/ or .git/ — mirrors handoff.js's
// findProjectRootFromCwd so the wiki_lint quality_gate row lands in the
// PROJECT state.db (<root>/.nirvana/state.db) instead of always the global one.
function findProjectRootFromCwd() {
  let cur = process.cwd();
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(path.join(cur, '.nirvana')) || fs.existsSync(path.join(cur, '.git'))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

let _stateDb = null;
function loadStateDb() {
  if (_stateDb !== null) return _stateDb;
  try {
    const sdb = require(path.join(SKILLS_ROOT, '_shared', 'lib', 'state-db.js'));
    _stateDb = { sdb, handle: sdb.openDb(findProjectRootFromCwd()) };
    if (!_stateDb.handle.available) _stateDb = false;
  } catch { _stateDb = false; }
  return _stateDb;
}

const RUBRIC_PATH = path.join(SKILLS_ROOT, '_shared', 'rubrics', 'wiki-lint.md');

function readDoc(filePath, opts = {}) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  // truncate huge files (>30KB) but mark
  const TRUNC = opts.maxBytesPerDoc || 30_000;
  return {
    path: filePath,
    bytes: stat.size,
    content: content.length > TRUNC ? content.slice(0, TRUNC) + `\n\n[... TRUNCATED at ${TRUNC} bytes; original ${stat.size} bytes ...]` : content,
    truncated: content.length > TRUNC,
  };
}

function buildArtifact(docs, opts = {}) {
  const anchors = new Set(opts.anchor_files || []);
  const lines = [];
  for (const d of docs) {
    if (!d) continue;
    const role = anchors.has(d.path) ? 'ANCHOR' : 'doc';
    lines.push(`──── ${role}: ${d.path} (${d.bytes} bytes${d.truncated ? ', truncated' : ''}) ────`);
    lines.push(d.content);
    lines.push('');
  }
  return lines.join('\n');
}

async function lintDocs({ files, anchor_files, project_id, timeoutMs }) {
  const judge = loadJudge();
  if (!judge) return { verdict: 'skipped', reason: 'quality-judge-not-loadable', contradictions: [] };
  if (!Array.isArray(files) || files.length < 2) {
    return { verdict: 'skipped', reason: 'need-at-least-2-files', contradictions: [] };
  }
  const docs = files.map(f => readDoc(f)).filter(Boolean);
  if (docs.length < 2) {
    return { verdict: 'skipped', reason: 'fewer-than-2-readable-files', contradictions: [] };
  }
  const artifact = buildArtifact(docs, { anchor_files });
  const r = await judge.runQualityJudge({
    phase: 'wiki_lint',
    artifact,
    rubric_path: RUBRIC_PATH,
    context: {
      project_id,
      doc_count: docs.length,
      docs: docs.map(d => ({ path: d.path, bytes: d.bytes, truncated: d.truncated })),
      anchor_files: anchor_files || [],
    },
    timeoutMs: timeoutMs || 120_000,
  });

  // Persist as a quality_gate so it shows up in Glance Memory
  const sd = loadStateDb();
  if (sd && sd.handle?.available && r.verdict !== 'skipped') {
    try {
      sd.sdb.recordGate(sd.handle, {
        project_id: project_id || null,
        task_id: null,
        phase: 'wiki_lint',
        verdict: r.verdict,
        score: r.score,
        failed_checks: r.failed_checks || (r.contradictions || []).map(c => `${c.severity || 'medium'}/${c.category || 'unknown'}: ${(c.evidence || '').slice(0, 200)}`),
        evidence: r.evidence || [],
        deterministic_findings: { docs: docs.map(d => d.path), contradictions_count: (r.contradictions || []).length },
        host: r.host || null,
      });
    } catch {}
  }

  return Object.assign({ contradictions: [] }, r);
}

module.exports = { lintDocs, readDoc, buildArtifact, RUBRIC_PATH };
