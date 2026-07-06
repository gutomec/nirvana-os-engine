/**
 * business-audit-criteria.js — Business Protocol v1 Nirvana scorer.
 *
 * 11 dimensions, 100 points. Tiers: red <60, yellow 60-79, green ≥80.
 *
 * Each function returns { score, max, evidence, fixable_diff? }.
 * Pure: only filesystem reads, no side effects.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), '.nirvana', 'skills')) ? path.join(os.homedir(), '.nirvana', 'skills') : path.join(os.homedir(), '.claude', 'skills'));
const YAML = require('yaml');
const LOADER_TS = path.join(SKILLS_ROOT, 'businesses', 'lib', 'loader.ts');

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function listDir(p) { try { return fs.readdirSync(p); } catch { return []; } }
function readYaml(p) { try { return YAML?.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// ─── Criterion 1 — Manifest valid (Zod via loader.ts, Bun) — 12 pts ─────
function c1_manifest_valid({ businessDir }) {
  const max = 12;
  if (!exists(LOADER_TS)) return { score: max, max, evidence: 'loader.ts missing — skipping' };
  const r = spawnSync(process.execPath, [LOADER_TS, businessDir], { encoding: 'utf8', timeout: 30000 });
  const ok = r.status === 0;
  return {
    score: ok ? max : 0, max,
    evidence: ok ? 'manifest valid' : `validation failed: ${(r.stderr || r.stdout || '').slice(-200)}`,
    fixable_diff: ok ? null : { kind: 'manifest_validation', stderr: (r.stderr || r.stdout || '').slice(-500) },
  };
}

// ─── Criterion 2 — employee_count matches disk — 10 pts ─────────────────
function c2_employee_count({ businessDir, manifest }) {
  const max = 10;
  const declared = manifest?.employee_count;
  const dir = path.join(businessDir, 'employees');
  if (!exists(dir)) return { score: 0, max, evidence: 'employees/ missing', fixable_diff: { kind: 'create_employees_dir' } };
  const actual = listDir(dir).filter(f => f.endsWith('.md')).length;
  if (declared == null) return { score: 5, max, evidence: `${actual} on disk (no employee_count declared)`, fixable_diff: { kind: 'declare_employee_count', count: actual } };
  if (declared === actual) return { score: max, max, evidence: `${actual} match` };
  return { score: 4, max, evidence: `declared ${declared} but disk has ${actual}`, fixable_diff: { kind: 'sync_employee_count', actual } };
}

// ─── Criterion 3 — Employees have frontmatter + heartbeat — 14 pts ──────
function c3_employees_frontmatter({ businessDir }) {
  const max = 14;
  const dir = path.join(businessDir, 'employees');
  if (!exists(dir)) return { score: 0, max, evidence: 'employees/ missing', fixable_diff: null };
  const files = listDir(dir).filter(f => f.endsWith('.md'));
  if (files.length === 0) return { score: 0, max, evidence: 'no employees', fixable_diff: null };
  let withFrontmatter = 0;
  let withHeartbeat = 0;
  const offenders = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const fm = raw.match(/^---\n([\s\S]+?)\n---/);
    if (!fm) { offenders.push(`${f}: no frontmatter`); continue; }
    withFrontmatter++;
    if (/^\s*heartbeat\s*:/m.test(fm[1])) withHeartbeat++;
  }
  const fmRatio = withFrontmatter / files.length;
  const hbRatio = withHeartbeat / files.length;
  const score = Math.round(fmRatio * 8 + hbRatio * 6);
  return {
    score, max,
    evidence: `${withFrontmatter}/${files.length} frontmatter · ${withHeartbeat}/${files.length} heartbeat${offenders.length ? ' · ' + offenders.slice(0, 2).join('; ') : ''}`,
    fixable_diff: (withFrontmatter < files.length || withHeartbeat < files.length) ? { kind: 'employee_frontmatter_repair' } : null,
  };
}

// ─── Criterion 4 — org-chart.yaml valid — 12 pts ────────────────────────
function c4_org_chart({ businessDir }) {
  const max = 12;
  const file = path.join(businessDir, 'org-chart.yaml');
  if (!exists(file)) return { score: 0, max, evidence: 'org-chart.yaml missing', fixable_diff: { kind: 'org_chart_scaffold' } };
  const oc = readYaml(file);
  if (!oc) return { score: 4, max, evidence: 'org-chart.yaml unparseable', fixable_diff: null };
  // Accept multiple shapes: nodes[], chart[], or nested orgchart.nodes
  const nodes = Array.isArray(oc.nodes) ? oc.nodes
    : Array.isArray(oc.chart) ? oc.chart
    : Array.isArray(oc?.orgchart?.nodes) ? oc.orgchart.nodes
    : [];
  const hasNodes = nodes.length > 0;
  // CEO detection: explicit oc.ceo, role/is_ceo flag, OR a node with reports==[] (no superior)
  const hasCEO = !!oc.ceo
    || nodes.some(n => n?.role === 'ceo' || n?.is_ceo)
    || nodes.some(n => Array.isArray(n?.reports) && n.reports.length === 0);
  let score = 6;
  if (hasNodes) score += 4;
  if (hasCEO) score += 2;
  return {
    score, max,
    evidence: `nodes=${nodes.length} · ceo=${hasCEO ? 'yes' : 'no'}`,
    fixable_diff: score < max ? { kind: 'org_chart_repair' } : null,
  };
}

// ─── Criterion 5 — routing.yaml exists + valid — 10 pts ─────────────────
function c5_routing({ businessDir }) {
  const max = 10;
  const file = path.join(businessDir, 'routing.yaml');
  if (!exists(file)) return { score: 0, max, evidence: 'routing.yaml missing', fixable_diff: { kind: 'routing_scaffold' } };
  const r = readYaml(file);
  if (!r) return { score: 3, max, evidence: 'routing.yaml unparseable', fixable_diff: null };
  const hasRoutes = (Array.isArray(r.routes) && r.routes.length > 0)
    || (Array.isArray(r.auto_routes) && r.auto_routes.length > 0)
    || (typeof r.brief_intake === 'string' && r.brief_intake.length > 0);
  return {
    score: hasRoutes ? max : 6, max,
    evidence: hasRoutes ? 'routes declared' : 'routing.yaml lacks routes/auto_routes/brief_intake',
    fixable_diff: hasRoutes ? null : { kind: 'routing_default_routes' },
  };
}

// ─── Criterion 6 — Description quality (≥ 50 chars) — 6 pts ─────────────
function c6_description({ manifest }) {
  const max = 6;
  const desc = (manifest?.description || '').trim();
  if (desc.length >= 100) return { score: max, max, evidence: `${desc.length} chars` };
  if (desc.length >= 50) return { score: 4, max, evidence: `${desc.length} chars (good, could be richer)` };
  if (desc.length >= 20) return { score: 2, max, evidence: `${desc.length} chars (minimum only)`, fixable_diff: { kind: 'description_expand' } };
  return { score: 0, max, evidence: `${desc.length} chars (below minimum)`, fixable_diff: { kind: 'description_expand' } };
}

// ─── Criterion 7 — runtime_requirements + features_required — 8 pts ────
function c7_runtime_requirements({ manifest }) {
  const max = 8;
  const rr = manifest?.runtime_requirements;
  const hasMin = Array.isArray(rr?.minimum) && rr.minimum.length > 0;
  const hasFeats = Array.isArray(manifest?.features_required) && manifest.features_required.length > 0;
  let score = 0;
  if (hasMin) score += 5;
  if (hasFeats) score += 3;
  return {
    score, max,
    evidence: `min=${hasMin ? rr.minimum.length : 0} · features=${hasFeats ? manifest.features_required.length : 0}`,
    fixable_diff: score < max ? { kind: 'runtime_requirements_business_default', missing_min: !hasMin, missing_feats: !hasFeats } : null,
  };
}

// ─── Criterion 9 — README.md exists with sections — 10 pts ──────────────
function c9_readme({ businessDir }) {
  const max = 10;
  const candidates = ['README.md', 'README.pt-BR.md'];
  let chosen = null;
  for (const c of candidates) if (exists(path.join(businessDir, c))) { chosen = path.join(businessDir, c); break; }
  if (!chosen) return { score: 0, max, evidence: 'README.md missing', fixable_diff: { kind: 'readme_business_scaffold' } };
  const text = fs.readFileSync(chosen, 'utf8');
  const lines = text.split('\n').length;
  const lower = text.toLowerCase();
  const wantGroups = [
    ['#'], ['## '],
    ['description', 'descrição', 'sobre', 'overview'],
    ['employee', 'funcionário', 'agent', 'role'],
    ['usage', 'uso', 'como', 'getting started'],
    ['domain', 'domínio'],
  ];
  const hit = wantGroups.filter(group => group.some(kw => lower.includes(kw))).length;
  let score = 0;
  if (lines >= 80) score += 6;
  else if (lines >= 40) score += 4;
  else if (lines >= 15) score += 2;
  if (hit >= 5) score += 4;
  else if (hit >= 3) score += 3;
  else if (hit >= 1) score += 1;
  return {
    score: Math.min(score, max), max,
    evidence: `${lines} lines · ${hit} sections`,
    fixable_diff: score < max ? { kind: 'readme_business_expand' } : null,
  };
}

// ─── Criterion 10 — memory/ directory non-empty — 6 pts ─────────────────
function c10_memory({ businessDir }) {
  const max = 6;
  const dir = path.join(businessDir, 'memory');
  if (!exists(dir)) return { score: 0, max, evidence: 'memory/ missing', fixable_diff: { kind: 'memory_scaffold' } };
  const files = listDir(dir).filter(f => !f.startsWith('.'));
  if (files.length === 0) return { score: 2, max, evidence: 'memory/ empty', fixable_diff: { kind: 'memory_seed' } };
  return { score: max, max, evidence: `${files.length} memory file(s)` };
}

// ─── Criterion 11 — legacy migration tagged or N/A — 6 pts ──────────────
function c11_legacy_tagged({ manifest }) {
  const max = 6;
  // Either explicitly declared as fresh business (no legacy block needed)
  // or the legacy block has paperclip migration tracked.
  const legacy = manifest?.legacy;
  if (!legacy) return { score: max, max, evidence: 'fresh business (no legacy)' };
  const hasInstance = typeof legacy.paperclip_instance === 'string';
  const hasDataDir = typeof legacy.paperclip_data_dir === 'string';
  if (hasInstance && hasDataDir) return { score: max, max, evidence: 'legacy migration tagged' };
  return { score: 3, max, evidence: 'partial legacy block', fixable_diff: { kind: 'legacy_complete' } };
}

// ─── orchestrator ───────────────────────────────────────────────────────

function scoreBusiness(businessDir) {
  const manifestPath = path.join(businessDir, 'business.yaml');
  const manifest = readYaml(manifestPath);
  const ctx = { businessDir, manifest };

  const fns = [
    ['manifest_valid', c1_manifest_valid],
    ['employee_count', c2_employee_count],
    ['employees_frontmatter', c3_employees_frontmatter],
    ['org_chart', c4_org_chart],
    ['routing', c5_routing],
    ['description', c6_description],
    ['runtime_requirements', c7_runtime_requirements],
    ['readme', c9_readme],
    ['memory', c10_memory],
    ['legacy_tagged', c11_legacy_tagged],
  ];

  const breakdown = [];
  let score = 0, maxScore = 0;
  for (let i = 0; i < fns.length; i++) {
    const [name, fn] = fns[i];
    const r = fn(ctx);
    breakdown.push({ id: i + 1, name, score: r.score, max: r.max, evidence: r.evidence, fixable_diff: r.fixable_diff || null });
    score += r.score;
    maxScore += r.max;
  }

  const tier = score >= 80 ? 'green' : score >= 60 ? 'yellow' : 'red';
  return {
    slug: path.basename(businessDir),
    business_dir: businessDir,
    score, max: maxScore, tier,
    breakdown,
  };
}

module.exports = { scoreBusiness };
