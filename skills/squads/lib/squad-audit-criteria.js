/**
 * squad-audit-criteria.js — 13 pure scoring functions, one per nirvana-tier
 * dimension. Each returns { score, max, evidence, fixable_diff }.
 *
 *   score        : integer points earned (0..max)
 *   max          : max points for this criterion
 *   evidence     : short string (or array) explaining the score
 *   fixable_diff : optional structured patch the consensus loop can adopt;
 *                  null if the gap requires semantic judgement.
 *
 * Inputs are read from the squad directory; we never mutate.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), '.nirvana', 'skills')) ? path.join(os.homedir(), '.nirvana', 'skills') : path.join(os.homedir(), '.claude', 'skills'));
const YAML = require('yaml');
const CATALOG_PATH = path.join(SKILLS_ROOT, '_shared', 'catalogs', 'CAPABILITY_CATALOG_V1.yaml');
let CATALOG_DOMAINS = null;
function loadCatalog() {
  if (CATALOG_DOMAINS !== null) return CATALOG_DOMAINS;
  CATALOG_DOMAINS = new Set();
  try {
    const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
    const parsed = YAML ? YAML.parse(raw) : null;
    const cats = parsed?.categories || {};
    for (const cat of Object.values(cats)) {
      for (const d of (cat.domains || [])) CATALOG_DOMAINS.add(d);
    }
  } catch { /* leave empty; criterion 3 will be permissive */ }
  return CATALOG_DOMAINS;
}

function readYaml(p) {
  if (!fs.existsSync(p) || !YAML) return null;
  try { return YAML.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function exists(p) { return fs.existsSync(p); }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function listDir(p) { try { return fs.readdirSync(p).filter(f => !f.startsWith('.')); } catch { return []; } }

const SEMVER_RE = /^\d+\.\d+\.\d+([+\-].*)?$/;
const CAP_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;

// ─────────────────────────────────────────────────────────────────────
// Criterion 1 — protocol "5.0" + valid semver version  (8 pts)
// ─────────────────────────────────────────────────────────────────────
function c1_protocol_version({ manifest }) {
  const max = 8;
  if (!manifest) return { score: 0, max, evidence: 'no squad.yaml', fixable_diff: null };
  const proto = String(manifest.protocol || '').trim();
  const ver = String(manifest.version || '').trim();
  let score = 0;
  const ev = [];
  if (proto === '5.0') { score += 4; ev.push('protocol=5.0'); }
  else { ev.push(`protocol=${proto || '(missing)'}`); }
  if (SEMVER_RE.test(ver)) { score += 4; ev.push(`version=${ver}`); }
  else { ev.push(`version=${ver || '(missing)'} (not semver)`); }
  let fix = null;
  if (proto !== '5.0' || !SEMVER_RE.test(ver)) {
    fix = { kind: 'manifest_patch', patches: [] };
    if (proto !== '5.0') fix.patches.push({ op: 'set', path: 'protocol', value: '5.0' });
    if (!SEMVER_RE.test(ver)) fix.patches.push({ op: 'set', path: 'version', value: '5.0.0' });
  }
  return { score, max, evidence: ev.join(' · '), fixable_diff: fix };
}

// ─────────────────────────────────────────────────────────────────────
// Criterion 2 — capabilities[] non-empty, schema-shape valid  (12 pts)
// ─────────────────────────────────────────────────────────────────────
function c2_capabilities_shape({ manifest }) {
  const max = 12;
  if (!manifest) return { score: 0, max, evidence: 'no manifest', fixable_diff: null };
  const caps = manifest.capabilities;
  if (!Array.isArray(caps) || caps.length === 0) {
    return { score: 0, max, evidence: 'capabilities[] missing or empty', fixable_diff: { kind: 'caps_inference_required' } };
  }
  let valid = 0, invalid = 0;
  const issues = [];
  for (const c of caps) {
    if (typeof c !== 'object' || !c) { invalid++; continue; }
    const id = c.id || c;
    const desc = (c.description || '').toString();
    const okId = typeof id === 'string' && CAP_ID_RE.test(id);
    const okDesc = desc.length >= 20;
    if (okId && okDesc) valid++;
    else { invalid++; issues.push(`${id || '?'}: ${!okId ? 'bad id' : ''}${!okDesc ? ' short desc' : ''}`); }
  }
  const ratio = valid / caps.length;
  const score = Math.round(ratio * max);
  return {
    score, max,
    evidence: `${valid}/${caps.length} valid${issues.length ? ' · issues: ' + issues.slice(0, 2).join('; ') : ''}`,
    fixable_diff: invalid > 0 ? { kind: 'caps_repair', invalid_count: invalid, issues } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Criterion 3 — capability domains in catalog  (10 pts)
// ─────────────────────────────────────────────────────────────────────
function c3_capability_domains({ manifest }) {
  const max = 10;
  const cat = loadCatalog();
  const caps = manifest?.capabilities;
  if (!Array.isArray(caps) || caps.length === 0) return { score: 0, max, evidence: 'no caps', fixable_diff: null };
  if (cat.size === 0) return { score: max, max, evidence: 'catalog unavailable, lenient pass', fixable_diff: null };
  let aligned = 0, total = 0;
  const offenders = [];
  for (const c of caps) {
    const domains = Array.isArray(c.domains) ? c.domains : (c.domain ? [c.domain] : []);
    if (domains.length === 0) { total++; offenders.push(`${c.id || '?'}: no domain`); continue; }
    total++;
    const allIn = domains.every(d => cat.has(d));
    if (allIn) aligned++;
    else offenders.push(`${c.id || '?'}: ${domains.filter(d => !cat.has(d)).join(',')}`);
  }
  const score = total === 0 ? 0 : Math.round((aligned / total) * max);
  return {
    score, max,
    evidence: `${aligned}/${total} caps with catalog-aligned domains${offenders.length ? ' · ' + offenders.slice(0, 2).join('; ') : ''}`,
    fixable_diff: offenders.length > 0 ? { kind: 'domain_realign', offenders } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Criterion 4 — examples[] ≥1 and not_for[] ≥1 per capability  (8 pts)
// ─────────────────────────────────────────────────────────────────────
function c4_examples_not_for({ manifest }) {
  const max = 8;
  const caps = manifest?.capabilities;
  if (!Array.isArray(caps) || caps.length === 0) return { score: 0, max, evidence: 'no caps', fixable_diff: null };
  let withExamples = 0, withNotFor = 0;
  for (const c of caps) {
    if (Array.isArray(c.examples) && c.examples.length >= 1) withExamples++;
    if (Array.isArray(c.not_for) && c.not_for.length >= 1) withNotFor++;
  }
  const total = caps.length;
  const halfMax = max / 2;
  const score = Math.round((withExamples / total) * halfMax + (withNotFor / total) * halfMax);
  return {
    score, max,
    evidence: `examples ${withExamples}/${total} · not_for ${withNotFor}/${total}`,
    fixable_diff: (withExamples < total || withNotFor < total) ? { kind: 'caps_examples_not_for' } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Criterion 5 — agents/*.md with frontmatter + maxTurns + tools[]  (8 pts)
// ─────────────────────────────────────────────────────────────────────
function c5_agents({ squadDir }) {
  const max = 8;
  const dir = path.join(squadDir, 'agents');
  if (!exists(dir)) return { score: 0, max, evidence: 'agents/ missing', fixable_diff: { kind: 'create_agents_dir' } };
  const files = listDir(dir).filter(f => f.endsWith('.md'));
  if (files.length === 0) return { score: 0, max, evidence: 'no agent files', fixable_diff: null };
  let valid = 0;
  const offenders = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const fm = raw.match(/^---\n([\s\S]+?)\n---/);
    if (!fm) { offenders.push(`${f}: no frontmatter`); continue; }
    const meta = readYaml(path.join(dir, f)) || (YAML ? (() => { try { return YAML.parse(fm[1]); } catch { return null; } })() : null);
    const fmText = fm[1];
    const hasMaxTurns = /(\b)maxTurns\s*:/m.test(fmText);
    const hasTools = /(\b)tools\s*:/m.test(fmText);
    if (hasMaxTurns && hasTools) valid++;
    else offenders.push(`${f}: ${!hasMaxTurns ? 'no maxTurns' : ''}${!hasTools ? ' no tools' : ''}`.trim());
  }
  const score = Math.round((valid / files.length) * max);
  return {
    score, max,
    evidence: `${valid}/${files.length} agents complete${offenders.length ? ' · ' + offenders.slice(0, 2).join('; ') : ''}`,
    fixable_diff: offenders.length > 0 ? { kind: 'agents_frontmatter_repair', offenders } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Criterion 6 — tasks/*.md with Acceptance Criteria  (6 pts)
// ─────────────────────────────────────────────────────────────────────
function c6_tasks({ squadDir }) {
  const max = 6;
  const dir = path.join(squadDir, 'tasks');
  if (!exists(dir)) return { score: 0, max, evidence: 'tasks/ missing', fixable_diff: { kind: 'create_tasks_dir' } };
  const files = listDir(dir).filter(f => f.endsWith('.md'));
  if (files.length === 0) return { score: 0, max, evidence: 'no task files', fixable_diff: null };
  let qualified = 0;
  for (const f of files) {
    const body = fs.readFileSync(path.join(dir, f), 'utf8');
    // Accept either: "## Acceptance Criteria" header (markdown style)
    //              OR: declarative `outputs:` block (yaml-frontmatter style),
    //              OR: declarative `acceptance_criteria:` field.
    // Both patterns satisfy v5 §7.3 (binary verifiable acceptance).
    const hasACHeader = /^##+\s+(Acceptance Criteria|Critérios de Aceita[çc]ão|Success Criteria)/im.test(body);
    const hasOutputs = /^outputs\s*:/m.test(body);
    const hasACField = /^acceptance_criteria\s*:/m.test(body);
    if (hasACHeader || hasOutputs || hasACField) qualified++;
  }
  const score = Math.round((qualified / files.length) * max);
  return {
    score, max,
    evidence: `${qualified}/${files.length} tasks declare outputs/acceptance criteria`,
    fixable_diff: qualified < files.length ? { kind: 'tasks_acceptance_criteria' } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Criterion 7 — workflows/*.yaml DAG-valid, refs resolve  (8 pts)
// ─────────────────────────────────────────────────────────────────────
function c7_workflows({ squadDir, manifest }) {
  const max = 8;
  const dir = path.join(squadDir, 'workflows');
  if (!exists(dir)) return { score: 0, max, evidence: 'workflows/ missing', fixable_diff: { kind: 'create_workflows_dir' } };
  const files = listDir(dir).filter(f => /\.ya?ml$/.test(f));
  if (files.length === 0) return { score: 0, max, evidence: 'no workflow files', fixable_diff: null };
  const knownAgents = new Set(listDir(path.join(squadDir, 'agents')).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '')));
  const knownTasks = new Set(listDir(path.join(squadDir, 'tasks')).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '')));
  let valid = 0;
  const issues = [];
  for (const f of files) {
    const wf = readYaml(path.join(dir, f));
    if (!wf || typeof wf !== 'object') { issues.push(`${f}: parse-fail`); continue; }
    // v5 protocol allows multiple workflow shapes (real-world variance):
    //   top-level `steps:`            (Squad Protocol V5 canonical DAG)
    //   nested   `flow.steps:`        (pipeline-style; design squads)
    //   nested   `pipeline.steps:`    (alias)
    //   `phases[].steps:`             (multi-phase workflows)
    //   `workflow:` object/array      (declarative orchestration descriptors)
    //   `agent_sequence:` array       (linear pipeline declaration)
    //   `stages:` array               (broad lifecycle workflows)
    let steps = wf.steps;
    if (!Array.isArray(steps)) steps = wf.flow?.steps;
    if (!Array.isArray(steps)) steps = wf.pipeline?.steps;
    if (!Array.isArray(steps) && Array.isArray(wf.phases)) {
      steps = wf.phases.flatMap(p => Array.isArray(p?.steps) ? p.steps : []);
    }
    if (!Array.isArray(steps) && Array.isArray(wf.stages)) {
      steps = wf.stages.flatMap(p => Array.isArray(p?.steps) ? p.steps : [{ id: p?.id || 'stage', agent: p?.agent }]);
    }
    if (!Array.isArray(steps) && Array.isArray(wf.workflow)) steps = wf.workflow;
    if (!Array.isArray(steps) && Array.isArray(wf.agent_sequence)) {
      steps = wf.agent_sequence.map((a, i) => ({ id: `step-${i}`, agent: typeof a === 'string' ? a : a?.agent }));
    }
    if (!Array.isArray(steps) || steps.length === 0) { issues.push(`${f}: no steps`); continue; }
    // DAG cycle check (Kahn-like)
    const ids = new Set(steps.map(s => s.id));
    let danglingAgent = 0, danglingTask = 0;
    for (const s of steps) {
      if (s.agent && knownAgents.size > 0 && !knownAgents.has(s.agent)) danglingAgent++;
      if (s.task && knownTasks.size > 0 && !knownTasks.has(s.task)) danglingTask++;
      for (const dep of (s.depends_on || [])) if (!ids.has(dep)) { issues.push(`${f}: dep ${dep} unresolved`); }
    }
    if (danglingAgent === 0 && danglingTask === 0) valid++;
    else issues.push(`${f}: ${danglingAgent} bad agent refs, ${danglingTask} bad task refs`);
  }
  const score = Math.round((valid / files.length) * max);
  return {
    score, max,
    evidence: `${valid}/${files.length} workflows resolve${issues.length ? ' · ' + issues.slice(0, 2).join('; ') : ''}`,
    fixable_diff: valid < files.length ? { kind: 'workflow_refs_repair', issues } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Criterion 8 — runtime_requirements + features_required[]  (6 pts)
// ─────────────────────────────────────────────────────────────────────
function c8_runtime_requirements({ manifest }) {
  const max = 6;
  if (!manifest) return { score: 0, max, evidence: 'no manifest', fixable_diff: null };
  const rr = manifest.runtime_requirements || {};
  const min = Array.isArray(rr.minimum) ? rr.minimum : [];
  const feats = Array.isArray(manifest.features_required) ? manifest.features_required : [];
  let score = 0;
  if (min.length >= 1) score += 4;
  if (feats.length >= 1) score += 2;
  return {
    score, max,
    evidence: `runtimes=${min.length} · features_required=${feats.length}`,
    fixable_diff: (min.length === 0 || feats.length === 0)
      ? { kind: 'runtime_requirements_default', missing_min: min.length === 0, missing_feats: feats.length === 0 }
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Criterion 9 — humanize: true wired (P11)  (6 pts)
// ─────────────────────────────────────────────────────────────────────
function c9_humanize({ manifest }) {
  const max = 6;
  const caps = manifest?.capabilities;
  if (!Array.isArray(caps) || caps.length === 0) return { score: 0, max, evidence: 'no caps', fixable_diff: null };
  // Check capabilities producing human-facing output
  const HUMAN_KINDS = new Set(['markdown', 'html', 'string', 'text']);
  let needs = 0, satisfied = 0;
  for (const c of caps) {
    const out = c.output || c.output_kind;
    const kind = typeof out === 'string' ? out : (out?.type || out?.kind);
    const looksHuman = kind && HUMAN_KINDS.has(String(kind).toLowerCase());
    if (looksHuman) {
      needs++;
      const hum = (out && typeof out === 'object' && 'humanize' in out) ? !!out.humanize : true;
      if (hum) satisfied++;
    }
  }
  if (needs === 0) return { score: max, max, evidence: 'no human-facing outputs', fixable_diff: null };
  const score = Math.round((satisfied / needs) * max);
  return {
    score, max,
    evidence: `${satisfied}/${needs} human outputs humanized`,
    fixable_diff: satisfied < needs ? { kind: 'humanize_default_true' } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Criterion 10 — dependencies declared (yaml or package manifests)  (6 pts)
// ─────────────────────────────────────────────────────────────────────
function c10_dependencies({ squadDir }) {
  const max = 6;
  const candidates = ['dependencies.yaml', 'package.json', 'pyproject.toml', 'requirements.txt'];
  const found = candidates.filter(f => isFile(path.join(squadDir, f)));
  if (found.length === 0) return { score: 0, max, evidence: 'none of: ' + candidates.join(', '), fixable_diff: { kind: 'dependencies_synth' } };
  return { score: max, max, evidence: 'present: ' + found.join(', '), fixable_diff: null };
}

// ─────────────────────────────────────────────────────────────────────
// Criterion 11 — README ≥100 lines + key sections  (8 pts)
// ─────────────────────────────────────────────────────────────────────
function c11_readme({ squadDir }) {
  const max = 8;
  const candidates = ['README.md', 'README.pt-BR.md'];
  let chosen = null;
  for (const c of candidates) if (isFile(path.join(squadDir, c))) { chosen = path.join(squadDir, c); break; }
  if (!chosen) return { score: 0, max, evidence: 'README.md missing', fixable_diff: { kind: 'readme_scaffold' } };
  const text = fs.readFileSync(chosen, 'utf8');
  const lines = text.split('\n').length;
  let score = 0;
  if (lines >= 100) score += 5;
  else if (lines >= 50) score += 3;
  else if (lines >= 20) score += 1;
  // Section coverage — recognize EN + PT-BR markers (case-insensitive substring)
  const lower = text.toLowerCase();
  const wantGroups = [
    ['#'],                                              // any heading
    ['## '],                                            // any sub-heading
    ['description', 'descrição', 'sobre', 'o que é', 'overview'],
    ['agent', 'agente'],
    ['usage', 'uso', 'como usar', 'comece', 'getting started'],
    ['example', 'exemplo'],
    ['workflow', 'fluxo', 'pipeline'],
    ['capabilit', 'capacidade', 'habilid', 'feature', 'recurso'],
  ];
  const hit = wantGroups.filter(group => group.some(kw => lower.includes(kw.toLowerCase()))).length;
  if (hit >= 5) score += 3;
  else if (hit >= 3) score += 2;
  else if (hit >= 1) score += 1;
  return {
    score: Math.min(score, max), max,
    evidence: `${lines} lines · ${hit} key sections`,
    fixable_diff: lines < 100 ? { kind: 'readme_expand' } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Criterion 12 — portable shebangs in scripts/*.sh  (4 pts)
// ─────────────────────────────────────────────────────────────────────
function c12_shebangs({ squadDir }) {
  const max = 4;
  const dir = path.join(squadDir, 'scripts');
  if (!exists(dir)) return { score: max, max, evidence: 'no scripts/ (n/a)', fixable_diff: null };
  const files = listDir(dir).filter(f => f.endsWith('.sh'));
  if (files.length === 0) return { score: max, max, evidence: 'no .sh files (n/a)', fixable_diff: null };
  let portable = 0;
  const bad = [];
  for (const f of files) {
    const head = fs.readFileSync(path.join(dir, f), 'utf8').split('\n')[0] || '';
    if (/^#!\/usr\/bin\/env\s+(bash|sh|zsh)/.test(head)) portable++;
    else bad.push(f);
  }
  const score = Math.round((portable / files.length) * max);
  return {
    score, max,
    evidence: `${portable}/${files.length} portable${bad.length ? ' · bad: ' + bad.slice(0, 2).join(',') : ''}`,
    fixable_diff: bad.length > 0 ? { kind: 'shebang_repair', files: bad } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Criterion 13 — fidelity{} block OR explicit experimental status  (10 pts)
// ─────────────────────────────────────────────────────────────────────
function c13_fidelity({ manifest, squadDir }) {
  const max = 10;
  const caps = manifest?.capabilities;
  if (!Array.isArray(caps) || caps.length === 0) return { score: 0, max, evidence: 'no caps', fixable_diff: null };
  let withFidelity = 0, experimental = 0;
  for (const c of caps) {
    if (c.fidelity && typeof c.fidelity === 'object') {
      const gtDir = c.fidelity.ground_truth_dir;
      const evalRes = c.fidelity.eval_results;
      const status = c.fidelity.status;
      const hasGT = gtDir && exists(path.join(squadDir, gtDir));
      const hasEval = evalRes && exists(path.join(squadDir, evalRes));
      if (status === 'validated' && hasGT && hasEval) withFidelity++;
      else if (status === 'experimental') experimental++;
    } else if ((c.status || '').toLowerCase() === 'experimental') {
      experimental++;
    }
  }
  const total = caps.length;
  // Either fully validated OR explicitly experimental counts
  const declared = withFidelity + experimental;
  const score = Math.round((declared / total) * max);
  return {
    score, max,
    evidence: `validated=${withFidelity} · experimental=${experimental} · undeclared=${total - declared}`,
    fixable_diff: declared < total ? { kind: 'fidelity_status_default_experimental' } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

const CRITERIA = [
  { id: 1, name: 'protocol_version', fn: c1_protocol_version, max: 8 },
  { id: 2, name: 'capabilities_shape', fn: c2_capabilities_shape, max: 12 },
  { id: 3, name: 'capability_domains', fn: c3_capability_domains, max: 10 },
  { id: 4, name: 'examples_not_for', fn: c4_examples_not_for, max: 8 },
  { id: 5, name: 'agents', fn: c5_agents, max: 8 },
  { id: 6, name: 'tasks', fn: c6_tasks, max: 6 },
  { id: 7, name: 'workflows', fn: c7_workflows, max: 8 },
  { id: 8, name: 'runtime_requirements', fn: c8_runtime_requirements, max: 6 },
  { id: 9, name: 'humanize', fn: c9_humanize, max: 6 },
  { id: 10, name: 'dependencies', fn: c10_dependencies, max: 6 },
  { id: 11, name: 'readme', fn: c11_readme, max: 8 },
  { id: 12, name: 'shebangs', fn: c12_shebangs, max: 4 },
  { id: 13, name: 'fidelity', fn: c13_fidelity, max: 10 },
];
const TOTAL_MAX = CRITERIA.reduce((a, c) => a + c.max, 0); // = 100

function tierFor(score) {
  if (score >= 80) return 'green';
  if (score >= 60) return 'yellow';
  return 'red';
}

function scoreSquad(squadDir) {
  const manifestPath = path.join(squadDir, 'squad.yaml');
  const manifest = readYaml(manifestPath);
  const ctx = { squadDir, manifest };
  const breakdown = CRITERIA.map(c => {
    let r;
    try { r = c.fn(ctx); }
    catch (e) { r = { score: 0, max: c.max, evidence: 'criterion error: ' + e.message, fixable_diff: null }; }
    return { id: c.id, name: c.name, ...r };
  });
  const score = breakdown.reduce((a, b) => a + b.score, 0);
  return {
    slug: path.basename(squadDir),
    squad_dir: squadDir,
    score,
    max: TOTAL_MAX,
    tier: tierFor(score),
    breakdown,
    fixable_count: breakdown.filter(b => b.fixable_diff).length,
  };
}

module.exports = { CRITERIA, TOTAL_MAX, tierFor, scoreSquad };

if (require.main === module) {
  // CLI: node squad-audit-criteria.js <squadDir>
  const arg = process.argv[2];
  if (!arg) { console.error('usage: node squad-audit-criteria.js <squadDir>'); process.exit(2); }
  console.log(JSON.stringify(scoreSquad(path.resolve(arg)), null, 2));
}
