/**
 * business-audit-criteria.js — the Business Protocol Nirvana scorer.
 *
 * 11 dimensions, 100 points. Tiers: red <60, yellow 60-79, green >=80.
 *
 * Each function returns { score, max, evidence, fixable_diff? }, where
 * `fixable_diff.kind` names a handler of `business-fixers.js` and
 * `fixable_diff.class` says who can apply it:
 *
 *   mechanical — `nrv validate business <slug> --fix` applies it, no LLM
 *   agentic    — needs a model to write what the fixer must not invent
 *   none       — a human decision the tooling has no honest default for
 *
 * Until this cut the kinds named repairs no code performed. They are the
 * gate's fixer names now, so the scorer's suggestion and `--fix` are the same
 * table.
 *
 * Business Protocol 2.0 moved three of the dimensions (§6.12, §11, §13.2):
 * `employee_count` is derived, so c2 stopped scoring the author's arithmetic;
 * `heartbeat` is retired, so the six points c3 paid for declaring one now go to
 * `acceptance`, the contract the judge actually reads; and c5 asks routing for
 * a `brief_intake` and for patterns that fire against the business's own
 * example briefs, instead of counting keys.
 *
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
/** §13.2: patterns that match every brief, so they never select anything. */
const CATCH_ALL = new Set(['.*', '.+', '(?i).*', '(?i).+', '^.*$', '^.+$', '(?i)^.*$', '(?i)^.+$', '.*?']);

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
    fixable_diff: ok ? null : { kind: 'manifest_schema_repair', class: 'mechanical', stderr: (r.stderr || r.stdout || '').slice(-500) },
  };
}

// ─── Criterion 2 — the seats exist and their headers parse — 6 pts ─────
// Business Protocol 2.0 §6.12: `employee_count` is derived from disk, so what
// is worth scoring is whether the seats are there and readable — not whether
// the author kept a number in sync that the registry recomputes anyway.
function c2_employees_present({ businessDir, manifest }) {
  const max = 6;
  const dir = path.join(businessDir, 'employees');
  if (!exists(dir)) return { score: 0, max, evidence: 'employees/ missing', fixable_diff: { kind: 'create_employees_dir', class: 'none' } };
  const files = listDir(dir).filter(f => f.endsWith('.md'));
  if (files.length === 0) return { score: 0, max, evidence: 'employees/ holds no .md', fixable_diff: { kind: 'create_employees_dir', class: 'none' } };
  let parsed = 0;
  const offenders = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) { offenders.push(`${f}: no frontmatter`); continue; }
    try { const d = YAML.parse(fm[1]); if (d && typeof d === 'object') parsed++; else offenders.push(`${f}: header is not a mapping`); }
    catch { offenders.push(`${f}: header does not parse`); }
  }
  const authored = manifest && manifest.employee_count != null;
  const score = Math.round((parsed / files.length) * max);
  const evidence = `${parsed}/${files.length} header(s) parse${offenders.length ? ' · ' + offenders.slice(0, 2).join('; ') : ''}${authored ? ' · employee_count declared (derived since §6.12)' : ''}`;
  return {
    score, max, evidence,
    fixable_diff: parsed < files.length ? { kind: 'employee_frontmatter_repair', class: 'mechanical' }
      : authored ? { kind: 'employee_count_strip', class: 'mechanical' } : null,
  };
}

// ─── Criterion 3 — headers complete + acceptance declared — 14 pts ──────
// §11 (BP4 redefined): the six points this criterion used to pay for declaring
// a `heartbeat` no scheduler ever ran now go to `acceptance`, the requirement
// the Gauntlet judge and `verify-deliverable` actually read.
function c3_employees_contract({ businessDir }) {
  const max = 14;
  const dir = path.join(businessDir, 'employees');
  if (!exists(dir)) return { score: 0, max, evidence: 'employees/ missing', fixable_diff: null };
  const files = listDir(dir).filter(f => f.endsWith('.md'));
  if (files.length === 0) return { score: 0, max, evidence: 'no employees', fixable_diff: null };
  let complete = 0;
  let intakeWithAcceptance = 0;
  let intakes = 0;
  let withSelfScore = 0;
  const offenders = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) { offenders.push(`${f}: no frontmatter`); continue; }
    let d = null;
    try { d = YAML.parse(fm[1]); } catch { offenders.push(`${f}: header does not parse`); continue; }
    if (!d || typeof d !== 'object') { offenders.push(`${f}: header is not a mapping`); continue; }
    if (typeof d.name === 'string' && typeof d.role === 'string' && typeof d.description === 'string') complete++;
    else offenders.push(`${f}: name, role or description missing`);
    if (d.self_score_contract) withSelfScore++;
    if (d.is_brief_intake === true) {
      intakes++;
      if (Array.isArray(d.acceptance) && d.acceptance.length > 0) intakeWithAcceptance++;
    }
  }
  const completeRatio = complete / files.length;
  const acceptanceRatio = intakes > 0 ? intakeWithAcceptance / intakes : 0;
  const score = Math.round(completeRatio * 8 + acceptanceRatio * 6);
  return {
    score, max,
    evidence: `${complete}/${files.length} complete header(s) · ${intakeWithAcceptance}/${intakes || 0} intake seat(s) declare acceptance${offenders.length ? ' · ' + offenders.slice(0, 2).join('; ') : ''}`,
    fixable_diff: complete < files.length ? { kind: 'employee_frontmatter_repair', class: 'mechanical' }
      : acceptanceRatio < 1 ? (withSelfScore > 0
        ? { kind: 'acceptance_from_self_score', class: 'mechanical' }
        : { kind: 'acceptance_author', class: 'agentic' })
      : null,
  };
}

// ─── Criterion 4 — org-chart.yaml valid — 12 pts ────────────────────────
function c4_org_chart({ businessDir }) {
  const max = 12;
  const file = path.join(businessDir, 'org-chart.yaml');
  if (!exists(file)) return { score: 0, max, evidence: 'org-chart.yaml missing', fixable_diff: { kind: 'org_chart_repair', class: 'mechanical' } };
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
    fixable_diff: score < max ? { kind: 'org_chart_repair', class: 'mechanical' } : null,
  };
}

// ─── Criterion 5 — brief_intake declared + routes that fire — 10 pts ────
// §13.2: an `auto_route` does two things — it makes the business a routing
// candidate and it picks the seat that receives the brief. A pattern that
// matches none of the business's own example briefs does neither, and a
// catch-all matches everything before any specific rule is evaluated. So the
// points follow both: half for declaring where a brief lands by default, half
// for patterns that can actually fire.
function c5_routing({ businessDir, manifest }) {
  const max = 10;
  const file = path.join(businessDir, 'routing.yaml');
  if (!exists(file)) return { score: 0, max, evidence: 'routing.yaml missing', fixable_diff: { kind: 'routing_scaffold', class: 'mechanical' } };
  const r = readYaml(file);
  if (!r) return { score: 3, max, evidence: 'routing.yaml unparseable', fixable_diff: null };

  const intake = r.brief_intake && typeof r.brief_intake === 'object'
    ? (typeof r.brief_intake.default_employee === 'string' && r.brief_intake.default_employee.length > 0)
    : typeof r.brief_intake === 'string' && r.brief_intake.length > 0;
  const routes = (Array.isArray(r.auto_routes) ? r.auto_routes : []).filter(x => x && typeof x.pattern === 'string');
  const briefs = Array.isArray(manifest && manifest.example_briefs) ? manifest.example_briefs.filter(b => typeof b === 'string') : [];
  let firing = 0;
  const dead = [];
  for (const route of routes) {
    if (CATCH_ALL.has(route.pattern.trim())) { dead.push(route.pattern); continue; }
    let re = null;
    try { const ci = route.pattern.startsWith('(?i)'); re = new RegExp(ci ? route.pattern.slice(4) : route.pattern, ci ? 'i' : ''); } catch { re = null; }
    if (re && briefs.some(b => re.test(b))) firing++;
    else dead.push(route.pattern);
  }
  const routeShare = routes.length === 0 ? 0 : firing / routes.length;
  const score = Math.round((intake ? 5 : 0) + routeShare * 5);
  return {
    score, max,
    evidence: `brief_intake ${intake ? 'declared' : 'absent'} · ${firing}/${routes.length} route(s) fire against the ${briefs.length} example brief(s)${dead.length ? ' · dead: ' + dead.slice(0, 2).join(', ') : ''}`,
    fixable_diff: !intake ? { kind: 'routing_scaffold', class: 'mechanical' }
      : dead.length ? { kind: 'routing_default_routes', class: 'agentic', dead } : null,
  };
}

// ─── Criterion 6 — Description quality (≥ 50 chars) — 6 pts ─────────────
function c6_description({ manifest }) {
  const max = 6;
  const desc = (manifest?.description || '').trim();
  if (desc.length >= 100) return { score: max, max, evidence: `${desc.length} chars` };
  if (desc.length >= 50) return { score: 4, max, evidence: `${desc.length} chars (good, could be richer)` };
  if (desc.length >= 20) return { score: 2, max, evidence: `${desc.length} chars (minimum only)`, fixable_diff: { kind: 'description_expand', class: 'agentic' } };
  return { score: 0, max, evidence: `${desc.length} chars (below minimum)`, fixable_diff: { kind: 'description_expand', class: 'agentic' } };
}

// ─── Criterion 7 — runtime_requirements + features_required — 8 pts ────
function c7_runtime_requirements({ manifest }) {
  const max = 8;
  const rr = manifest?.runtime_requirements;
  const hasMin = Array.isArray(rr?.minimum) && rr.minimum.length > 0;
  const usesActiveRuntime = rr?.policy === 'active';
  const hasFeats = Array.isArray(manifest?.features_required) && manifest.features_required.length > 0;
  let score = 0;
  if (usesActiveRuntime || hasMin) score += 5;
  if (hasFeats) score += 3;
  return {
    score, max,
    evidence: `policy=${rr?.policy || 'declared'} · min=${hasMin ? rr.minimum.length : 0} · features=${hasFeats ? manifest.features_required.length : 0}`,
    // Only the runtime floor is mechanical. `features_required` is a claim
    // about what the host must support, and no fixer can guess it.
    fixable_diff: (!usesActiveRuntime && !hasMin)
      ? { kind: 'runtime_requirements_business_default', class: 'mechanical', missing_min: true, missing_feats: !hasFeats }
      : !hasFeats ? { kind: 'features_required_author', class: 'none', missing_feats: true } : null,
  };
}

// ─── Criterion 9 — README.md exists with sections — 10 pts ──────────────
function c9_readme({ businessDir }) {
  const max = 10;
  const candidates = ['README.md', 'README.pt-BR.md'];
  let chosen = null;
  for (const c of candidates) if (exists(path.join(businessDir, c))) { chosen = path.join(businessDir, c); break; }
  if (!chosen) return { score: 0, max, evidence: 'README.md missing', fixable_diff: { kind: 'readme_business_scaffold', class: 'mechanical' } };
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
    fixable_diff: score < max ? { kind: 'readme_business_expand', class: 'agentic' } : null,
  };
}

// ─── Criterion 10 — memory is NOT accumulated inside the business — 6 pts ──
//
// This used to award points for HAVING `memory/` inside the business, and the
// seeder it pointed at created one. Both were backwards: the business directory
// is the product, replaced whole by a pack update, a migration or a reinstall,
// so memory kept there is written on a surface built to be overwritten. It lives
// in `.nirvana/memory/businesses/<slug>/` — the project's or the machine's —
// alongside the temporal rows `state-db.js` has always kept there.
//
// A shipped `permanent.md` is tolerated: packs seed one, and the engine reads it
// once to populate the canonical home. What costs points is ACCUMULATED state —
// `learned.md` and `memory/projects/`, the two the pack build already refuses to
// ship, sitting where an update will silently discard them.
function c10_memory({ businessDir }) {
  const max = 6;
  const stray = ['learned.md', 'projects']
    .filter(n => exists(path.join(businessDir, 'memory', n)));
  if (stray.length) {
    return {
      score: 2, max,
      evidence: `memory/${stray.join(', memory/')} accumulated inside the business — an update discards it; run \`nrv memory relocate --apply\``,
    };
  }
  return { score: max, max, evidence: 'memory lives in .nirvana/memory/businesses/<slug>/, outside the replaceable entity' };
}

// ─── Criterion 11 — legacy migration tagged or N/A — 6 pts ──────────────
// c12 — can every seat stand without a clone? The per-task clone model makes
// "no clone" a legitimate outcome of any dispatch, so the employee body IS the
// seat's method. Advisory here (the blocking gate is check-seat-sufficiency);
// the fixable_diff points operators at the enricher.
function c12_seat_sufficiency({ businessDir }) {
  const max = 10;
  const { sufficiencyOfFile } = require('../../_shared/lib/seat-sufficiency.js');
  const empDir = path.join(businessDir, 'employees');
  if (!exists(empDir)) return { score: 0, max, evidence: 'no employees/', fixable_diff: null };
  const thin = [];
  let total = 0;
  for (const f of fs.readdirSync(empDir)) {
    if (!f.endsWith('.md')) continue;
    total++;
    const r = sufficiencyOfFile(fs.readFileSync(path.join(empDir, f), 'utf8'));
    if (r.verdict === 'thin') thin.push(f.replace(/\.md$/, ''));
  }
  if (total === 0) return { score: 0, max, evidence: 'no employee files', fixable_diff: null };
  const ratio = (total - thin.length) / total;
  return {
    score: Math.round(ratio * max), max,
    evidence: thin.length ? `${thin.length}/${total} thin: ${thin.join(', ')}` : `${total}/${total} seats sufficient`,
    fixable_diff: thin.length ? { kind: 'enrich_employee_method', class: 'agentic', slugs: thin } : null,
  };
}

function c11_legacy_tagged({ manifest }) {
  const max = 6;
  // Either explicitly declared as fresh business (no legacy block needed)
  // or the legacy block has paperclip migration tracked.
  const legacy = manifest?.legacy;
  if (!legacy) return { score: max, max, evidence: 'fresh business (no legacy)' };
  const hasInstance = typeof legacy.paperclip_instance === 'string';
  const hasDataDir = typeof legacy.paperclip_data_dir === 'string';
  if (hasInstance && hasDataDir) return { score: max, max, evidence: 'legacy migration tagged' };
  return { score: 3, max, evidence: 'partial legacy block', fixable_diff: { kind: 'legacy_complete', class: 'none' } };
}

// ─── orchestrator ───────────────────────────────────────────────────────

function scoreBusiness(businessDir) {
  const manifestPath = path.join(businessDir, 'business.yaml');
  const manifest = readYaml(manifestPath);
  const ctx = { businessDir, manifest };

  const fns = [
    ['manifest_valid', c1_manifest_valid],
    ['employees_present', c2_employees_present],
    ['employees_contract', c3_employees_contract],
    ['org_chart', c4_org_chart],
    ['routing', c5_routing],
    ['description', c6_description],
    ['runtime_requirements', c7_runtime_requirements],
    ['readme', c9_readme],
    ['memory', c10_memory],
    ['legacy_tagged', c11_legacy_tagged],
    ['seat_sufficiency', c12_seat_sufficiency],
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
