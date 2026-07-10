/**
 * squad-audit-verifier.js — independent post-application verifier.
 *
 * Spawns a SECOND `claude -p` instance (acting as a fresh Claude Code project
 * or specialized verification squad) to review the diff that improve-squad
 * just applied. Verdict: "ok" → keep; "rollback" → restore from backup.
 *
 * This is a "trust but verify" step: even after the consensus loop accepts
 * a patch and validate-squad passes Pydantic, an independent reviewer reads
 * the actual diff against the squad protocol and judges.
 *
 * Auth: CLAUDE_CODE_OAUTH_TOKEN required. Falls back to "ok" (skip) if missing.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), '.nirvana', 'skills')) ? path.join(os.homedir(), '.nirvana', 'skills') : path.join(os.homedir(), '.claude', 'skills'));
const self_audit_DIR = path.join(HOME, 'squads', 'synthetic-reasoning');

let _hostDriver = null;
function loadHostDriver() {
  if (_hostDriver) return _hostDriver;
  try {
    _hostDriver = require(path.join(SKILLS_ROOT, '_shared', 'lib', 'host-agent-driver.ts'));
  } catch {
    try { _hostDriver = require(path.join(SKILLS_ROOT, '_shared', 'lib', 'host-agent-driver.js')); }
    catch { _hostDriver = null; }
  }
  return _hostDriver;
}

function readMetaPersona() {
  // Use the meta agent — metacognitive overseer of the self_audit squad
  const f = path.join(self_audit_DIR, 'agents', 'meta.md');
  if (!fs.existsSync(f)) {
    return 'You are an independent senior reviewer. You verify squad improvements without bias.';
  }
  return fs.readFileSync(f, 'utf8').slice(0, 8000);
}

function diffSquad(backupDir, currentDir) {
  // Use git diff --no-index for a clean diff (don't touch git state)
  try {
    const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--stat', backupDir, currentDir], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    return r.stdout || '(no diff produced)';
  } catch (e) {
    return `(diff failed: ${e.message})`;
  }
}

/**
 * Verify the improvement to a squad. Returns { verdict, reasons, raw }.
 *
 *   verdict: 'ok' | 'rollback' | 'skipped'
 *   reasons: string[]
 */
function verifyImprovement({ slug, squadDir, backupDir, scoreBefore, scoreAfter, patchKinds }) {
  const driver = loadHostDriver();
  const host = driver?.detectHost?.();
  if (!host) {
    return { verdict: 'skipped', reasons: ['no host agent runtime detected on PATH'] };
  }
  const diff = diffSquad(backupDir, squadDir).slice(0, 12_000);
  const persona = readMetaPersona();
  const userMessage = [
    `# Squad Improvement Verification`,
    ``,
    `Squad: \`${slug}\``,
    `Score: ${scoreBefore} → ${scoreAfter} (+${scoreAfter - scoreBefore})`,
    `Patches applied: ${patchKinds.join(', ') || '(none)'}`,
    ``,
    `## Diff (git stat):`,
    '```',
    diff,
    '```',
    ``,
    `## Your task`,
    ``,
    `Verify the improvement against Squad Protocol v5. Reject ONLY if:`,
    `- a real regression was introduced (existing functionality broken)`,
    `- semantic intent was lost (e.g. capability description rewritten beyond recognition)`,
    `- the diff includes content that violates v5 schema (extra fields, wrong types)`,
    ``,
    `Do NOT reject for stylistic preferences, formatting, or "could be better" reasons.`,
    ``,
    `Respond with strict JSON only:`,
    '```json',
    '{ "verdict": "ok"|"rollback", "reasons": ["short bullet 1", "short bullet 2"] }',
    '```',
  ].join('\n');

  const r = driver.callHostAgent(persona, userMessage, { timeoutMs: 90_000 });
  if ('error' in r) {
    return { verdict: 'skipped', reasons: [`${r.host || 'host'}: ${r.error.slice(0, 200)}`] };
  }
  const result = r.text;
  // Find embedded JSON
  const m = result.match(/\{[\s\S]*?"verdict"[\s\S]*?\}/);
  if (!m) {
    return { verdict: 'skipped', reasons: ['could not parse verifier response'], raw: result.slice(0, 500) };
  }
  try {
    const verdict = JSON.parse(m[0]);
    return {
      verdict: verdict.verdict === 'rollback' ? 'rollback' : 'ok',
      reasons: Array.isArray(verdict.reasons) ? verdict.reasons : [],
      raw: result.slice(0, 500),
    };
  } catch (e) {
    return { verdict: 'skipped', reasons: ['invalid verifier JSON: ' + e.message], raw: m[0].slice(0, 500) };
  }
}

module.exports = { verifyImprovement };
