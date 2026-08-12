/**
 * quality-judge.js — LLM-as-judge gate runner. Uses host-agent-driver
 * (agnostic across Claude Code, Codex, Gemini CLI, etc.) to evaluate an
 * artifact against a markdown rubric and return a structured verdict.
 *
 * Calling pattern (see ~/.nirvana/skills/_shared/rubrics/*.md for shapes):
 *   const r = await runQualityJudge({
 *     phase: 'plan' | 'post_execution' | 'pre_ship',
 *     artifact: '<the thing to evaluate, as text/markdown/json>',
 *     rubric_path: '<absolute path to rubric .md>',
 *     context: { ... },           // any extra structured context
 *     timeoutMs: 120_000,
 *   });
 *   // r → { verdict, score, categories, failed_checks, evidence, host, raw? }
 *   //   verdict ∈ { 'pass', 'needs_revision', 'fail', 'skipped' }
 *
 * Returns 'skipped' when no host runtime is detected — caller decides whether
 * to fail-closed (treat as fail) or fail-open (proceed with warning).
 */

'use strict';

const fs = require('fs');
const path = require('path');

let _hostDriver = null;
function loadHostDriver() {
  if (_hostDriver) return _hostDriver;
  try { _hostDriver = require(path.join(__dirname, 'host-agent-driver.js')); }
  catch {
    try { _hostDriver = require(path.join(__dirname, 'host-agent-driver.ts')); }
    catch { _hostDriver = null; }
  }
  return _hostDriver;
}

function loadRubric(rubricPath) {
  if (!fs.existsSync(rubricPath)) {
    throw new Error(`rubric not found: ${rubricPath}`);
  }
  return fs.readFileSync(rubricPath, 'utf8');
}

function buildPersona(phase, rubricMd) {
  return [
    `You are a quality judge for the "${phase}" phase of an autonomous multi-agent system.`,
    'Your role is to verify an artifact against the rubric below and return a structured JSON verdict.',
    'You are decisive — pass when the artifact meets the bar, fail when it does not, needs_revision only when fixes are clearly small.',
    'Cite EVIDENCE you observed in the artifact for each finding. Do NOT invent facts.',
    '',
    '── RUBRIC ──',
    rubricMd,
    '────────────',
    '',
    'Output ONLY the JSON verdict described in the rubric. No preamble, no commentary, no markdown fencing.',
  ].join('\n');
}

function buildUserMessage(artifact, context) {
  const ctxBlock = context && Object.keys(context).length
    ? `\n\nAdditional context:\n${JSON.stringify(context, null, 2)}`
    : '';
  return [
    'Evaluate the following artifact against the rubric in your system prompt.',
    '',
    '── ARTIFACT ──',
    artifact,
    '──────────────',
    ctxBlock,
  ].join('\n');
}

function extractJson(text) {
  if (!text) return null;
  const stripped = text
    .replace(/^[\s\S]*?```(?:json)?\s*/i, '')
    .replace(/```[\s\S]*$/, '')
    .trim();
  const candidate = stripped.length > 0 ? stripped : text;
  const m = candidate.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (!m) {
    try { return JSON.parse(candidate); } catch { return null; }
  }
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * Run cheap deterministic pre-checks (artifact existence + volume bounds) when
 * the caller passed { delivery_dir, volume_targets } in context. The findings
 * are merged into the user message under "Deterministic findings" so the LLM
 * judge cites them as evidence rather than recounting words or guessing which
 * files exist.
 */
function runDeterministicPrechecks(context) {
  if (!context || typeof context !== 'object') return null;
  const findings = {};
  let ran = false;

  if (context.delivery_dir && fs.existsSync(context.delivery_dir)) {
    try {
      const aeg = require(path.join(__dirname, 'artifact-existence-gate.js'));
      const stat = fs.statSync(context.delivery_dir);
      const r = stat.isDirectory()
        ? aeg.checkDir(context.delivery_dir, { extensions: ['.html', '.htm', '.md', '.markdown', '.css'] })
        : { ok: true, files: [aeg.checkFile(context.delivery_dir)], totals: null };
      const totals = r.totals || {
        files_scanned: 1,
        refs_total: r.files[0].refs?.length || 0,
        missing: r.files[0].missing?.length || 0,
        placeholders: r.files[0].placeholders?.length || 0,
      };
      findings.artifact_existence = {
        ok: r.ok,
        totals,
        missing_samples: r.files
          .flatMap(f => (f.missing || []).map(m => ({ file: f.path, kind: m.kind, target: m.target, line: m.line })))
          .slice(0, 20),
      };
      ran = true;
    } catch (e) { findings.artifact_existence = { error: e.message }; }
  }

  if (context.volume_targets && typeof context.volume_targets === 'object' && context.delivery_dir) {
    try {
      const vb = require(path.join(__dirname, 'volume-bounds.js'));
      const out = [];
      for (const [relFile, target] of Object.entries(context.volume_targets)) {
        const full = path.resolve(context.delivery_dir, relFile);
        if (!fs.existsSync(full)) {
          out.push({ file: relFile, verdict: 'skipped', message: 'file not found' });
          continue;
        }
        const text = fs.readFileSync(full, 'utf8');
        const r = vb.check({ text, target });
        out.push({ file: relFile, ...r });
      }
      findings.volume_bounds = out;
      ran = true;
    } catch (e) { findings.volume_bounds = { error: e.message }; }
  }

  // structure_targets shape:
  //   { 'briefs/foo.md': ['Resumo executivo', 'Diagnóstico', 'Riscos'], ... }
  if (context.structure_targets && typeof context.structure_targets === 'object' && context.delivery_dir) {
    try {
      const sb = require(path.join(__dirname, 'structure-bounds.js'));
      const out = [];
      for (const [relFile, required] of Object.entries(context.structure_targets)) {
        if (!Array.isArray(required) || required.length === 0) continue;
        const full = path.resolve(context.delivery_dir, relFile);
        if (!fs.existsSync(full)) {
          out.push({ file: relFile, verdict: 'skipped', message: 'file not found' });
          continue;
        }
        const text = fs.readFileSync(full, 'utf8');
        const r = sb.check({ text, required_sections: required });
        out.push({ file: relFile, ...r });
      }
      findings.structure_bounds = out;
      ran = true;
    } catch (e) { findings.structure_bounds = { error: e.message }; }
  }

  return ran ? findings : null;
}

async function runQualityJudge({ phase, artifact, rubric_path, context, timeoutMs }) {
  const driver = loadHostDriver();
  if (!driver || !driver.callHostAgentAsync) {
    return { verdict: 'skipped', reason: 'host-agent-driver-not-loadable', score: null };
  }
  const host = driver.detectHost?.();
  if (!host) {
    return { verdict: 'skipped', reason: 'no-host-runtime-detected', score: null };
  }

  let rubricMd;
  try { rubricMd = loadRubric(rubric_path); }
  catch (e) { return { verdict: 'skipped', reason: e.message, score: null }; }

  const deterministic = runDeterministicPrechecks(context);
  const enrichedContext = deterministic
    ? Object.assign({}, context || {}, { deterministic_findings: deterministic })
    : context;

  const persona = buildPersona(phase, rubricMd);
  const userMsg = buildUserMessage(artifact, enrichedContext);

  // Use retry wrapper so stalled judge calls get one automatic retry.
  let retry = null;
  try { retry = require(path.join(__dirname, 'host-agent-retry.js')); } catch {}
  const callOpts = {
    timeoutMs: timeoutMs || 120_000,
    heartbeatMs: 60_000,
    maxRetries: 1,
  };
  const r = retry && retry.callWithRetryOnStall
    ? await retry.callWithRetryOnStall(persona, userMsg, callOpts)
    : await driver.callHostAgentAsync(persona, userMsg, callOpts);
  if ('error' in r) {
    return { verdict: 'skipped', reason: r.error.slice(0, 200), score: null, host: r.host };
  }
  const parsed = extractJson(r.text);
  if (!parsed || typeof parsed !== 'object' || !parsed.verdict) {
    return { verdict: 'skipped', reason: 'unparseable_judge_output', raw: (r.text || '').slice(0, 500), host: r.host };
  }
  const v = String(parsed.verdict).toLowerCase();
  const verdict = ['pass', 'fail', 'needs_revision'].includes(v) ? v : 'skipped';
  return {
    verdict,
    score: typeof parsed.score === 'number' ? parsed.score : null,
    categories: Array.isArray(parsed.categories) ? parsed.categories : [],
    failed_checks: Array.isArray(parsed.failed_checks) ? parsed.failed_checks : [],
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
    deterministic_findings: deterministic,
    host: r.host,
  };
}

module.exports = { runQualityJudge, loadRubric, buildPersona, extractJson, runDeterministicPrechecks };
