/**
 * business-fixers.js — the mechanical fixers of Business Protocol 2.0.
 *
 * The squad side of the house has had `mechanical-fixers.js` for a year: a
 * dispatch table, one idempotent handler per patch kind, filesystem side
 * effects and no LLM. Businesses had thirteen `fixable_diff` kinds that no code
 * ever applied — the audit scorer named the repair and then nobody performed
 * it. This is the applier, plus the conversions Business Protocol 2.0 added
 * (§0, §6, §7, §11, §13, §22).
 *
 * Three rules the handlers never break:
 *
 * 1. **Idempotent.** Every handler compares before it writes, so a second run
 *    produces zero bytes of change. `nrv validate business <slug> --fix` twice
 *    in a row is a no-op the second time, and the gate's rollback logic depends
 *    on that.
 * 2. **Never deletes authored content.** Deprecated *fields* are removed or
 *    converted (§0.3); deprecated *files* are reported and left where they are;
 *    routes are never dropped, only converted into the field that implements
 *    them; a `dna/` directory loses its symlinks after the bindings move into
 *    the frontmatter, and keeps any real file it holds.
 * 3. **Never invents prose.** No fixer writes a `not_for`, an `example_brief`,
 *    a description or an acceptance criterion the author did not write. What
 *    the author cannot be derived from stays a finding for a human — or for
 *    `--fix=agentic`, which is a different tool with a ledger line.
 *
 * Employee frontmatter is edited through `_shared/lib/frontmatter-edit.ts`,
 * which rewrites the `---` block and leaves the body byte for byte. YAML files
 * are edited through the `yaml` Document API, so comments and key order survive.
 *
 * Entry point: `applyBusinessFixes(businessDir, { patches: [{ kind, ... }] })`,
 * the same shape `applyMechanicalFixes` takes for squads.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');

const SHARED_LIB = path.join(__dirname, '..', '..', '_shared', 'lib');
const { editFrontmatter, employeeFiles, prependFrontmatter, readFrontmatter } = require(path.join(SHARED_LIB, 'frontmatter-edit.js'));
const { refToSlug, slugOf } = require(path.join(SHARED_LIB, 'entity-graph.js'));

// ─── file helpers ───────────────────────────────────────────────────────────

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function listDir(p) { try { return fs.readdirSync(p); } catch { return []; } }
const manifestOf = (dir) => path.join(dir, 'business.yaml');
const chartOf = (dir) => path.join(dir, 'org-chart.yaml');
const routingOf = (dir) => path.join(dir, 'routing.yaml');

/** Parses a YAML file into a Document, or null when it is missing/broken. */
function readDoc(file) {
  if (!exists(file)) return null;
  try {
    const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'), { uniqueKeys: false });
    return doc.errors.length ? null : doc;
  } catch { return null; }
}

function readData(file) {
  const doc = readDoc(file);
  if (!doc) return null;
  const js = doc.toJS();
  return js && typeof js === 'object' && !Array.isArray(js) ? js : null;
}

/**
 * Edits a YAML file through the Document API. `mutate` returns true when it
 * changed something; nothing is written otherwise, which is where idempotence
 * comes from.
 */
function editDoc(file, mutate) {
  const text = exists(file) ? fs.readFileSync(file, 'utf8') : null;
  if (text === null) return false;
  let doc;
  try {
    doc = YAML.parseDocument(text, { uniqueKeys: false });
    if (doc.errors.length) return false;
  } catch { return false; }
  if (!mutate(doc)) return false;
  // lineWidth 0 keeps a long description on its own line instead of
  // re-wrapping it at 80 columns. The Document API still re-renders the file,
  // so a comment attached to a key this edit removes goes with it.
  let out = doc.toString({ lineWidth: 0 });
  if (text.endsWith('\n') && !out.endsWith('\n')) out += '\n';
  if (out === text) return false;
  fs.writeFileSync(file, out, 'utf8');
  return true;
}

/** Creates a YAML file from plain data. Never overwrites. */
function createYaml(file, data) {
  if (exists(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(data, { lineWidth: 0 }), 'utf8');
  return true;
}

/** Every employee, as `{ file, name, data }`, in file order. */
function readEmployees(dir) {
  const out = [];
  for (const file of employeeFiles(dir)) {
    const fm = readFrontmatter(file);
    const data = fm && fm.doc ? fm.data : null;
    out.push({
      file,
      stem: path.basename(file).replace(/\.md$/, ''),
      name: data && typeof data.name === 'string' ? data.name : path.basename(file).replace(/\.md$/, ''),
      data,
    });
  }
  return out;
}

const isArray = Array.isArray;
const isMapping = (v) => !!v && typeof v === 'object' && !isArray(v);
/** A `yaml` sequence node already sitting in the document. */
const isSeqNode = (n) => !!n && typeof n === 'object' && isArray(n.items);

/** `Some Name` → `some-name`, the shape KEBAB_CASE accepts. */
function kebab(s) {
  const out = String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(out) ? out : `seat-${out}`;
}

/** An acceptance id: `^[a-z][a-z0-9_-]*$`. */
function acceptanceId(s) {
  const out = String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[_-]+/, '');
  return /^[a-z]/.test(out) ? out : `c_${out}`;
}

/** The clone slug a reference names, or null when it names none. */
function cloneSlug(ref) {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  const viaLibrary = refToSlug(ref);
  const last = slugOf(ref.replace(/\/+$/, '')).replace(/\.(md|markdown)$/i, '');
  // `dna/<slug>/agent/AGENT.md` names the clone in the middle of the path;
  // every other form names it in the last segment.
  const slug = /(^|\/)dna\//.test(ref) && viaLibrary ? viaLibrary : last;
  return slug && !/\.(md|ya?ml|json)$/i.test(slug) ? slug : null;
}

/** Clone slugs installed on this machine, or the set the caller measured. */
function availableClones(patch) {
  if (isArray(patch && patch.available_clones)) return new Set(patch.available_clones.map(String));
  const root = process.env.DNA_LIBRARY || path.join(os.homedir(), 'businesses', '_library', 'dna');
  const out = new Set();
  for (const name of listDir(root)) {
    if (name.startsWith('.')) continue;
    const full = path.join(root, name);
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (!st.isDirectory()) { out.add(name.replace(/\.md$/, '')); continue; }
    out.add(name);
    // A clone directory holds its own manifest; anything else at this level is
    // a category of the legacy nested layout, and its children are the clones.
    if (exists(path.join(full, 'MANIFEST.yaml'))) continue;
    for (const sub of listDir(full)) if (!sub.startsWith('.')) out.add(sub);
  }
  return out;
}

// ─── §7 · employees ─────────────────────────────────────────────────────────

/**
 * A seat with no frontmatter at all gets the skeleton the schema requires and
 * nothing more. `name` comes from the filename, `role` from the first heading,
 * `description` from the first paragraph the author already wrote — the fixer
 * derives, it does not compose. A seat whose frontmatter exists but fails the
 * schema is left alone: rewriting a header a human wrote is authorship.
 */
function fix_employee_frontmatter_repair(dir) {
  const repaired = [];
  for (const file of employeeFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    const stem = path.basename(file).replace(/\.md$/, '');
    if (readFrontmatter(file) !== null) continue;
    const heading = /^#\s+(.+)$/m.exec(text);
    const role = heading ? heading[1].trim().slice(0, 80) : stem.replace(/[-_]+/g, ' ');
    const paragraph = text.replace(/^#.*$/gm, '').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).find((p) => p.length >= 20);
    const description = (paragraph || `Seat ${stem}: frontmatter scaffolded by the admission gate, method below.`).slice(0, 400);
    const block = YAML.stringify({ name: kebab(stem), role, description }, { lineWidth: 0 }).replace(/\n+$/, '');
    if (prependFrontmatter(file, block)) repaired.push(stem);
  }
  return repaired.length ? { ok: true, repaired } : { ok: true, changed: false, reason: 'every employee already declares frontmatter' };
}

/**
 * Exactly one seat receives the brief. With zero declared, the root of the org
 * chart is the only answer the files already contain; with more than one, the
 * choice is the owner's and the gate keeps reporting it.
 */
function fix_intake_from_chart_root(dir) {
  const employees = readEmployees(dir).filter((e) => e.data);
  const declared = employees.filter((e) => e.data.is_brief_intake === true);
  if (declared.length === 1) return { ok: true, changed: false, reason: 'the intake seat is already declared' };
  if (declared.length > 1) return { ok: false, reason: `${declared.length} seats declare is_brief_intake: choosing between them is the owner's call` };
  const names = new Set(employees.map((e) => e.name));

  const chart = readData(chartOf(dir));
  const roots = isArray(chart && chart.chart)
    ? chart.chart.filter((n) => isMapping(n) && isArray(n.reports) && n.reports.length === 0 && names.has(n.employee)).map((n) => n.employee)
    : [];
  let target = roots.length === 1 ? roots[0] : null;
  if (!target) {
    const orphans = employees.filter((e) => !e.data.reports_to);
    if (orphans.length === 1) target = orphans[0].name;
  }
  if (!target) return { ok: false, reason: 'no single root in org-chart.yaml and no single seat without reports_to' };
  const seat = employees.find((e) => e.name === target);
  if (!seat) return { ok: false, reason: `org-chart root ${target} has no employee file` };
  const changed = editFrontmatter(seat.file, (doc) => { doc.set('is_brief_intake', true); return true; });
  return { ok: true, intake: target, changed };
}

/** `type: antagonist_gate` implies `is_antagonist: true` (§7.8). */
function fix_type_flag_sync(dir) {
  const synced = [];
  for (const e of readEmployees(dir)) {
    if (!e.data || e.data.type !== 'antagonist_gate' || e.data.is_antagonist === true) continue;
    if (editFrontmatter(e.file, (doc) => { doc.set('is_antagonist', true); return true; })) synced.push(e.name);
  }
  return synced.length ? { ok: true, synced } : { ok: true, changed: false, reason: 'no antagonist_gate seat is missing the flag' };
}

function fix_heartbeat_strip(dir) {
  const stripped = stripEmployeeField(dir, 'heartbeat');
  return stripped.length ? { ok: true, stripped } : { ok: true, changed: false, reason: 'no seat declares heartbeat' };
}

function stripEmployeeField(dir, field) {
  const stripped = [];
  for (const e of readEmployees(dir)) {
    if (!e.data || !(field in e.data)) continue;
    if (editFrontmatter(e.file, (doc) => { if (!doc.has(field)) return false; doc.delete(field); return true; })) stripped.push(e.name);
  }
  return stripped;
}

/**
 * §11: `self_score_contract.criteria[]` already has the shape of an acceptance
 * requirement — `{id, description, threshold}` → `{id, description,
 * minimum_score}` — so 566 dead self-assessments become live requirements of
 * the judge without one line of new authorship. `weight`, `on_below_threshold`
 * and `max_revise_iterations` have no destination: the Gauntlet's revision loop
 * already replaced them.
 */
function fix_acceptance_from_self_score(dir) {
  const employees = readEmployees(dir).filter((e) => e.data);
  const used = new Set();
  for (const e of employees) for (const a of (isArray(e.data.acceptance) ? e.data.acceptance : [])) {
    if (isMapping(a) && typeof a.id === 'string') used.add(a.id);
  }
  const converted = [];
  for (const e of employees) {
    const contract = e.data.self_score_contract;
    if (!isMapping(contract)) continue;
    const criteria = isArray(contract.criteria) ? contract.criteria.filter(isMapping) : [];
    const existing = new Set((isArray(e.data.acceptance) ? e.data.acceptance : []).filter(isMapping).map((a) => a.id));
    const entries = [];
    for (const c of criteria) {
      if (typeof c.id !== 'string' || !c.id.trim()) continue;
      let id = acceptanceId(c.id);
      if (used.has(id) && !existing.has(id)) id = acceptanceId(`${e.name}_${c.id}`);
      if (existing.has(id)) continue;
      const entry = { id, description: String(c.description || c.id).trim(), blocking: true };
      const score = normalizeScore(c.threshold);
      if (score !== null) entry.minimum_score = score;
      entries.push(entry);
      used.add(id);
      existing.add(id);
    }
    const changed = editFrontmatter(e.file, (doc) => {
      if (!doc.has('self_score_contract')) return false;
      if (entries.length) {
        if (isSeqNode(doc.get('acceptance'))) for (const entry of entries) doc.addIn(['acceptance'], entry);
        else doc.set('acceptance', entries);
      }
      doc.delete('self_score_contract');
      return true;
    });
    if (changed) converted.push({ employee: e.name, requirements: entries.length });
  }
  return converted.length
    ? { ok: true, converted, note: 'weight, on_below_threshold and max_revise_iterations have no destination in §11 and were not carried over' }
    : { ok: true, changed: false, reason: 'no seat declares self_score_contract' };
}

/** 0..1 as declared; a percentage (1 < n ≤ 100) read as one; anything else, null. */
function normalizeScore(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  if (n >= 0 && n <= 1) return n;
  if (n > 1 && n <= 100) return Math.round((n / 100) * 100) / 100;
  return null;
}

/** §11: ids that match the pattern, unique inside the business, scores in 0..1. */
function fix_acceptance_normalize(dir) {
  const employees = readEmployees(dir).filter((e) => e.data);
  const seen = new Set();
  const fixed = [];
  for (const e of employees) {
    const list = isArray(e.data.acceptance) ? e.data.acceptance : null;
    if (!list) continue;
    const changed = editFrontmatter(e.file, (doc) => {
      let touched = false;
      list.forEach((entry, i) => {
        if (!isMapping(entry)) return;
        if (typeof entry.id === 'string') {
          let id = acceptanceId(entry.id);
          if (seen.has(id)) id = acceptanceId(`${e.name}_${entry.id}`);
          let n = 2;
          while (seen.has(id)) id = acceptanceId(`${e.name}_${entry.id}_${n++}`);
          seen.add(id);
          if (id !== entry.id) { doc.setIn(['acceptance', i, 'id'], id); touched = true; }
        }
        if ('minimum_score' in entry) {
          const score = normalizeScore(entry.minimum_score);
          if (score !== null && score !== entry.minimum_score) { doc.setIn(['acceptance', i, 'minimum_score'], score); touched = true; }
        }
      });
      return touched;
    });
    if (changed) fixed.push(e.name);
  }
  return fixed.length ? { ok: true, normalized: fixed } : { ok: true, changed: false, reason: 'every acceptance id is already valid and unique' };
}

/** §22: `draws_from` was a hint with a path; `assigned_mind_clones` is the hint. */
function fix_draws_from_to_assigned(dir, patch) {
  const clones = availableClones(patch);
  const converted = [];
  const kept = [];
  for (const e of readEmployees(dir)) {
    if (!e.data || !isArray(e.data.draws_from)) continue;
    const sources = e.data.draws_from.filter(isMapping).map((d) => d.source);
    const slugs = sources.map(cloneSlug);
    const resolved = slugs.filter((s) => s && clones.has(s));
    const unresolved = sources.filter((_, i) => !slugs[i] || !clones.has(slugs[i]));
    const already = new Set((isArray(e.data.assigned_mind_clones) ? e.data.assigned_mind_clones : []).map((x) => slugOf(String(x))));
    const additions = [...new Set(resolved)].filter((s) => !already.has(s));
    const changed = editFrontmatter(e.file, (doc) => {
      let touched = false;
      if (additions.length) {
        if (isSeqNode(doc.get('assigned_mind_clones'))) for (const s of additions) doc.addIn(['assigned_mind_clones'], s);
        else doc.set('assigned_mind_clones', additions);
        touched = true;
      }
      // The field goes only when every source it carried arrived somewhere.
      if (unresolved.length === 0 && doc.has('draws_from')) { doc.delete('draws_from'); touched = true; }
      return touched;
    });
    if (changed) converted.push({ employee: e.name, clones: additions });
    if (unresolved.length) kept.push({ employee: e.name, unresolved });
  }
  const result = converted.length ? { ok: true, converted } : { ok: true, changed: false, reason: 'no seat declares draws_from that resolves to an installed clone' };
  if (kept.length) result.note = `draws_from kept on ${kept.length} seat(s): a source that resolves to no installed clone is not a binding to move`;
  return result;
}

/** §7.7: `dna_reference` named the clone by path; the pin names it by slug. */
function fix_dna_reference_to_pin(dir, patch) {
  const clones = availableClones(patch);
  const pinned = [];
  const kept = [];
  for (const e of readEmployees(dir)) {
    if (!e.data || typeof e.data.dna_reference !== 'string') continue;
    const slug = cloneSlug(e.data.dna_reference);
    if (!slug || !clones.has(slug)) { kept.push({ employee: e.name, ref: e.data.dna_reference }); continue; }
    const current = isArray(e.data.pinned_mind_clones) ? e.data.pinned_mind_clones.map(String) : [];
    if (current.length >= 2 && !current.includes(slug)) { kept.push({ employee: e.name, ref: e.data.dna_reference }); continue; }
    const changed = editFrontmatter(e.file, (doc) => {
      if (!current.includes(slug)) {
        if (isSeqNode(doc.get('pinned_mind_clones'))) doc.addIn(['pinned_mind_clones'], slug);
        else doc.set('pinned_mind_clones', [slug]);
      }
      doc.delete('dna_reference');
      return true;
    });
    if (changed) pinned.push({ employee: e.name, clone: slug });
  }
  const result = pinned.length ? { ok: true, pinned } : { ok: true, changed: false, reason: 'no dna_reference resolves to an installed clone' };
  if (kept.length) result.note = `dna_reference kept on ${kept.length} seat(s): the path resolves to no installed clone, or the seat already carries two pins`;
  return result;
}

// ─── §6 · the manifest ──────────────────────────────────────────────────────

/** §6.12: the count is derived from `employees/*.md`; declaring it is a smell. */
function fix_employee_count_strip(dir) {
  const changed = editDoc(manifestOf(dir), (doc) => {
    if (!doc.has('employee_count')) return false;
    doc.delete('employee_count');
    return true;
  });
  return changed ? { ok: true, changed: true } : { ok: true, changed: false, reason: 'the manifest declares no employee_count' };
}

/**
 * §6.10: an empty `squads_authorized` meant "every squad" in the spec and "no
 * squad" in the prompt. Removing it restores what the author who wrote `[]`
 * against the spec intended. A non-empty list is a real fence and is never
 * touched.
 */
function fix_squads_authorized_empty_strip(dir) {
  const isEmpty = (v) => v === null || (isArray(v) && v.length === 0);
  const stripped = [];
  const manifest = readData(manifestOf(dir));
  if (manifest && 'squads_authorized' in manifest && isEmpty(manifest.squads_authorized)) {
    if (editDoc(manifestOf(dir), (doc) => { doc.delete('squads_authorized'); return true; })) stripped.push('business.yaml');
  }
  for (const e of readEmployees(dir)) {
    if (!e.data || !('squads_authorized' in e.data) || !isEmpty(e.data.squads_authorized)) continue;
    if (editFrontmatter(e.file, (doc) => { doc.delete('squads_authorized'); return true; })) stripped.push(e.name);
  }
  return stripped.length ? { ok: true, stripped } : { ok: true, changed: false, reason: 'no empty squads_authorized declared' };
}

/**
 * Every field §22 retires without a conversion, removed wherever it is
 * declared. The allowlist is the whole authority: a kind this table does not
 * name is refused, so a typo can never strip a live field.
 */
const DEPRECATED_FIELDS = {
  budget_monthly_usd: ['employee'],
  mentions: ['employee'],
  escalation_triggers: ['employee'],
  disclosure_template: ['employee', 'manifest'],
  capabilities_required: ['manifest'],
  default_tools: ['manifest', 'employee'],
  project_tool_overrides: ['manifest', 'employee'],
  tickets: ['manifest'],
  ticket_intake: ['manifest', 'routing'],
  mention_routing: ['routing'],
  confidence_threshold: ['route'],
  requires_escalation_to: ['route'],
};

function fix_deprecated_field_strip(dir, patch) {
  const field = patch && patch.field;
  const scopes = DEPRECATED_FIELDS[field];
  if (!scopes) return { ok: false, reason: `not a field Business Protocol 2.0 §22 retires: ${field}` };
  const stripped = [];
  if (scopes.includes('employee')) for (const name of stripEmployeeField(dir, field)) stripped.push(name);
  if (scopes.includes('manifest') && editDoc(manifestOf(dir), (doc) => { if (!doc.has(field)) return false; doc.delete(field); return true; })) stripped.push('business.yaml');
  if (scopes.includes('routing') && editDoc(routingOf(dir), (doc) => { if (!doc.has(field)) return false; doc.delete(field); return true; })) stripped.push('routing.yaml');
  if (scopes.includes('route') && editDoc(routingOf(dir), (doc) => {
    const routes = doc.get('auto_routes');
    if (!routes || !isArray(routes.items)) return false;
    let touched = false;
    routes.items.forEach((_, i) => {
      if (!doc.hasIn(['auto_routes', i, field])) return;
      doc.deleteIn(['auto_routes', i, field]);
      touched = true;
    });
    return touched;
  })) stripped.push(`routing.yaml:auto_routes[].${field}`);
  return stripped.length ? { ok: true, field, stripped } : { ok: true, changed: false, field, reason: `${field} is not declared anywhere in this business` };
}

/**
 * The keys the schema requires and the directory already answers. Nothing here
 * is prose: a name, a version, a protocol and a license are metadata whose
 * absence blocks the load, and every other schema failure stays a finding.
 */
function fix_manifest_schema_repair(dir) {
  const manifest = readData(manifestOf(dir));
  if (!manifest) return { ok: false, reason: 'business.yaml is missing or does not parse' };
  const slug = path.basename(dir);
  const filled = [];
  const changed = editDoc(manifestOf(dir), (doc) => {
    let touched = false;
    if (typeof manifest.name !== 'string' || !/^[a-z][a-z0-9-]+$/.test(manifest.name)) {
      if (/^[a-z][a-z0-9-]+$/.test(slug)) { doc.set('name', slug); filled.push('name'); touched = true; }
    }
    if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+/.test(manifest.version)) { doc.set('version', '1.0.0'); filled.push('version'); touched = true; }
    if (manifest.protocol !== '1.0' && manifest.protocol !== '2.0') { doc.set('protocol', '1.0'); filled.push('protocol'); touched = true; }
    if (manifest.license !== undefined && typeof manifest.license !== 'string') { doc.set('license', 'MIT'); filled.push('license'); touched = true; }
    return touched;
  });
  return changed
    ? { ok: true, filled }
    : { ok: true, changed: false, reason: 'the schema failure is not one of the derivable keys (name, version, protocol, license)' };
}

/** The manifest must declare a runtime floor, or say it follows the active one. */
function fix_runtime_requirements_business_default(dir) {
  const manifest = readData(manifestOf(dir));
  if (!manifest) return { ok: false, reason: 'business.yaml is missing or does not parse' };
  const rr = manifest.runtime_requirements;
  const ok = isMapping(rr) && (rr.policy === 'active' || (isArray(rr.minimum) && rr.minimum.length > 0));
  if (ok) return { ok: true, changed: false, reason: 'runtime_requirements already declares a floor or follows the active runtime' };
  const changed = editDoc(manifestOf(dir), (doc) => {
    if (isMapping(rr)) doc.setIn(['runtime_requirements', 'policy'], 'active');
    else doc.set('runtime_requirements', { policy: 'active' });
    return true;
  });
  return changed ? { ok: true, policy: 'active' } : { ok: false, reason: 'business.yaml could not be rewritten' };
}

/** §18.4: the version rises last, and only over a business with no error left. */
function fix_protocol_bump_2(dir) {
  const changed = editDoc(manifestOf(dir), (doc) => {
    if (doc.get('protocol') === '2.0') return false;
    doc.set('protocol', '2.0');
    return true;
  });
  return changed ? { ok: true, protocol: '2.0' } : { ok: true, changed: false, reason: 'the manifest already declares protocol 2.0' };
}

// ─── §13 · routing ──────────────────────────────────────────────────────────

const routeKey = (r) => `${String(r && r.pattern)}\u0000${String(r && r.route_to)}`;

/** §13.2: `auto_routes` lives in `routing.yaml`. The manifest copy moves there. */
function fix_auto_routes_relocate(dir) {
  const manifest = readData(manifestOf(dir));
  if (!manifest) return { ok: false, reason: 'business.yaml is missing or does not parse' };
  const routes = isArray(manifest.auto_routes) ? manifest.auto_routes.filter(isMapping) : [];
  if (!('auto_routes' in manifest)) return { ok: true, changed: false, reason: 'the manifest declares no auto_routes' };

  const routingFile = routingOf(dir);
  const routing = readData(routingFile);
  if (routing === null && exists(routingFile)) return { ok: false, reason: 'routing.yaml does not parse: the routes have nowhere safe to land' };
  const existing = new Set(((routing && isArray(routing.auto_routes) ? routing.auto_routes : []).filter(isMapping)).map(routeKey));
  const moving = routes.filter((r) => !existing.has(routeKey(r)));

  if (moving.length && !exists(routingFile)) createYaml(routingFile, { auto_routes: moving });
  else if (moving.length) editDoc(routingFile, (doc) => {
    if (isSeqNode(doc.get('auto_routes'))) for (const r of moving) doc.addIn(['auto_routes'], r);
    else doc.set('auto_routes', moving);
    return true;
  });
  const changed = editDoc(manifestOf(dir), (doc) => { if (!doc.has('auto_routes')) return false; doc.delete('auto_routes'); return true; });
  return {
    ok: true, relocated: moving.length, deduplicated: routes.length - moving.length, changed,
    note: moving.length ? 'comments written inside business.yaml auto_routes are not carried into routing.yaml' : undefined,
  };
}

/** A business with no `routing.yaml` gets the one line the file needs: the seat
 *  a brief reaches when no route fires. */
function fix_routing_scaffold(dir) {
  const routingFile = routingOf(dir);
  if (exists(routingFile)) {
    const routing = readData(routingFile);
    if (routing === null) return { ok: false, reason: 'routing.yaml does not parse' };
    if (isMapping(routing.brief_intake)) return { ok: true, changed: false, reason: 'routing.yaml already declares brief_intake' };
  }
  const intakes = readEmployees(dir).filter((e) => e.data && e.data.is_brief_intake === true);
  if (intakes.length !== 1) return { ok: false, reason: `brief_intake needs exactly one intake seat (found ${intakes.length})` };
  const target = intakes[0].name;
  if (!exists(routingFile)) { createYaml(routingFile, { brief_intake: { default_employee: target } }); return { ok: true, default_employee: target, created: true }; }
  const changed = editDoc(routingFile, (doc) => { doc.set('brief_intake', { default_employee: target }); return true; });
  return changed ? { ok: true, default_employee: target } : { ok: false, reason: 'routing.yaml could not be rewritten' };
}

const CATCH_ALL = new Set(['.*', '.+', '(?i).*', '(?i).+', '^.*$', '^.+$', '(?i)^.*$', '(?i)^.+$', '.*?']);
const isCatchAll = (p) => typeof p === 'string' && CATCH_ALL.has(p.trim());

/**
 * §13.2: a catch-all route matches every brief before any specific rule is
 * evaluated, so it turns routing off while looking like routing. What it
 * expresses — "when nothing else fits, this seat" — is exactly
 * `brief_intake.default_employee`, so the route is converted into that field
 * rather than removed: the destination survives, in the key that implements it.
 * When the file already names a DIFFERENT default employee the conversion would
 * lose one of the two, so the fixer declines and the finding stands.
 */
function fix_catch_all_to_default_employee(dir) {
  const routingFile = routingOf(dir);
  const routing = readData(routingFile);
  if (!routing) return { ok: false, reason: 'routing.yaml is missing or does not parse' };
  const routes = (isArray(routing.auto_routes) ? routing.auto_routes : []).filter(isMapping);
  const catchAll = routes.filter((r) => isCatchAll(r.pattern));
  if (!catchAll.length) return { ok: true, changed: false, reason: 'no catch-all pattern declared' };
  const targets = [...new Set(catchAll.map((r) => String(r.route_to)))];
  const current = isMapping(routing.brief_intake) ? routing.brief_intake.default_employee : undefined;
  if (targets.length > 1) return { ok: false, reason: `catch-all routes name ${targets.length} different seats: the default employee is the owner's call` };
  if (current !== undefined && current !== targets[0]) return { ok: false, reason: `brief_intake.default_employee is ${current} and the catch-all routes to ${targets[0]}: converting would drop one of them` };

  const changed = editDoc(routingFile, (doc) => {
    if (current === undefined) {
      if (isMapping(routing.brief_intake)) doc.setIn(['brief_intake', 'default_employee'], targets[0]);
      else doc.set('brief_intake', { default_employee: targets[0] });
    }
    const seq = doc.get('auto_routes');
    if (!isSeqNode(seq)) return true;
    for (let i = seq.items.length - 1; i >= 0; i--) {
      if (isCatchAll(doc.getIn(['auto_routes', i, 'pattern']))) doc.deleteIn(['auto_routes', i]);
    }
    return true;
  });
  return changed
    ? { ok: true, default_employee: targets[0], converted: catchAll.length, note: 'the catch-all route became brief_intake.default_employee: the destination is preserved, the dead pattern is not' }
    : { ok: false, reason: 'routing.yaml could not be rewritten' };
}

// ─── §5 · files ─────────────────────────────────────────────────────────────

/**
 * §5.3: symlinks do not travel in a zip, so a `dna/` binding reaches the buyer
 * broken. The link names become `assigned_mind_clones` on the intake seat and
 * the links go; a real file inside `dna/` is authored content and stays, with
 * the directory around it.
 */
function fix_dna_dir_to_bindings(dir) {
  const dnaDir = path.join(dir, 'dna');
  if (!exists(dnaDir)) return { ok: true, changed: false, reason: 'no dna/ directory' };
  const links = [];
  const others = [];
  for (const name of listDir(dnaDir)) {
    let st; try { st = fs.lstatSync(path.join(dnaDir, name)); } catch { continue; }
    if (st.isSymbolicLink() || st.isDirectory()) links.push(name);
    else others.push(name);
  }
  const slugs = [...new Set(links.map((n) => n.replace(/\.md$/, '')))];
  const intakes = readEmployees(dir).filter((e) => e.data && e.data.is_brief_intake === true);
  if (slugs.length && intakes.length !== 1) return { ok: false, reason: `the bindings need one intake seat to land on (found ${intakes.length})` };

  if (slugs.length) {
    const seat = intakes[0];
    const already = new Set((isArray(seat.data.assigned_mind_clones) ? seat.data.assigned_mind_clones : []).map((x) => slugOf(String(x))));
    const additions = slugs.filter((s) => !already.has(s));
    if (additions.length) {
      editFrontmatter(seat.file, (doc) => {
        if (isSeqNode(doc.get('assigned_mind_clones'))) for (const s of additions) doc.addIn(['assigned_mind_clones'], s);
        else doc.set('assigned_mind_clones', additions);
        return true;
      });
    }
  }
  for (const name of links) fs.rmSync(path.join(dnaDir, name), { recursive: true, force: true });
  if (others.length === 0) fs.rmdirSync(dnaDir);
  return {
    ok: true, clones: slugs, removed_links: links.length,
    note: others.length ? `dna/ kept: it also holds ${others.join(', ')}, which the gate never deletes` : undefined,
  };
}

function fix_readme_business_scaffold(dir) {
  const file = path.join(dir, 'README.md');
  if (exists(file) || exists(path.join(dir, 'README.pt-BR.md'))) return { ok: true, changed: false, reason: 'a README is already present' };
  const manifest = readData(manifestOf(dir)) || {};
  const slug = path.basename(dir);
  const employees = readEmployees(dir);
  const lines = [
    `# ${manifest.name || slug}`,
    '',
    String(manifest.description || 'Describe what this business does and who it serves.').trim(),
    '',
    '## Employees',
    '',
    ...(employees.length ? employees.map((e) => `- \`${e.name}\`${e.data && e.data.role ? ` — ${e.data.role}` : ''}`) : ['- (none yet)']),
    '',
    '## Usage',
    '',
    '```bash',
    `nrv validate business ${slug} --strict`,
    `bun ~/.nirvana/skills/businesses/scripts/brief-business.ts ${slug} "<brief>"`,
    '```',
    '',
    '> Scaffolded by `nrv validate business --fix`. Replace it with the real thing.',
    '',
  ];
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return { ok: true, created: 'README.md' };
}

// Retired, deliberately kept as a declining handler rather than deleted so an
// old finding or a cached catalog cannot resurrect the behavior silently.
//
// This used to create `memory/permanent.md` INSIDE the business, and its own
// seed text admitted the flaw: "A pack update replaces this file." Memory does
// not belong to the entity, because the entity is the product — replaced whole
// by a pack update, a migration or a reinstall. It belongs to `.nirvana`, the
// project's or the machine's, keyed by kind and slug (`_shared/lib/entity-memory.ts`),
// which is where every read now comes from and where `nrv memory relocate` moves
// what earlier versions left behind.
function fix_memory_seed(dir) {
  return {
    ok: false,
    reason: 'memory is not stored inside a business — it lives in .nirvana/memory/businesses/<slug>/ '
      + '(see `nrv memory relocate`). Nothing to seed here.',
  };
}

/**
 * §5.3: `org-chart.yaml` is derived, not authored twice. The parent of a seat
 * is its own `reports_to`; a seat that declares none is adopted by the single
 * seat that lists it under `manages`. Deriving `direct_reports` from the
 * children's side is what makes the chart bidirectionally consistent by
 * construction — the inconsistency the loader rejects cannot be written here.
 */
function fix_org_chart_repair(dir) {
  const employees = readEmployees(dir).filter((e) => e.data);
  if (!employees.length) return { ok: false, reason: 'no employee frontmatter to derive the chart from' };
  const names = employees.map((e) => e.name);
  const known = new Set(names);
  if (new Set(names).size !== names.length) return { ok: false, reason: 'two seats declare the same name' };

  const parent = new Map();
  for (const e of employees) {
    const r = e.data.reports_to;
    if (typeof r === 'string' && known.has(r) && r !== e.name) parent.set(e.name, r);
  }
  for (const e of employees) {
    for (const child of (isArray(e.data.manages) ? e.data.manages : [])) {
      if (typeof child !== 'string' || !known.has(child) || child === e.name || parent.has(child)) continue;
      parent.set(child, e.name);
    }
  }
  const roots = names.filter((n) => !parent.has(n));
  if (roots.length !== 1) return { ok: false, reason: `the frontmatter yields ${roots.length} roots: exactly one seat must report to nobody` };
  for (const start of names) {
    const seen = new Set();
    let cur = start;
    while (parent.has(cur)) {
      cur = parent.get(cur);
      if (seen.has(cur)) return { ok: false, reason: `reports_to/manages form a cycle through ${cur}` };
      seen.add(cur);
    }
  }

  const chart = employees.map((e) => {
    const node = {
      employee: e.name,
      reports: parent.has(e.name) ? [parent.get(e.name)] : [],
      direct_reports: names.filter((n) => parent.get(n) === e.name).sort(),
      is_antagonist: e.data.is_antagonist === true,
    };
    const antagonizes = isArray(e.data.antagonizes) ? e.data.antagonizes.filter((x) => typeof x === 'string') : [];
    if (antagonizes.length) node.antagonizes = antagonizes;
    return node;
  });

  const file = chartOf(dir);
  if (!exists(file)) { createYaml(file, { chart }); return { ok: true, created: 'org-chart.yaml', nodes: chart.length }; }
  const current = readData(file);
  if (current === null) return { ok: false, reason: 'org-chart.yaml does not parse: rewriting it would drop what it holds' };
  if (JSON.stringify(current.chart) === JSON.stringify(chart)) return { ok: true, changed: false, reason: 'org-chart.yaml already matches the frontmatter' };
  const changed = editDoc(file, (doc) => { doc.set('chart', chart); return true; });
  return changed ? { ok: true, nodes: chart.length, note: 'routing_rules and every other key of org-chart.yaml were left as they were' } : { ok: false, reason: 'org-chart.yaml could not be rewritten' };
}

// ─── apply orchestrator ─────────────────────────────────────────────────────

const HANDLERS = {
  employee_frontmatter_repair: fix_employee_frontmatter_repair,
  intake_from_chart_root: fix_intake_from_chart_root,
  org_chart_repair: fix_org_chart_repair,
  type_flag_sync: fix_type_flag_sync,
  acceptance_from_self_score: fix_acceptance_from_self_score,
  acceptance_normalize: fix_acceptance_normalize,
  heartbeat_strip: fix_heartbeat_strip,
  draws_from_to_assigned: fix_draws_from_to_assigned,
  dna_reference_to_pin: fix_dna_reference_to_pin,
  deprecated_field_strip: fix_deprecated_field_strip,
  employee_count_strip: fix_employee_count_strip,
  squads_authorized_empty_strip: fix_squads_authorized_empty_strip,
  manifest_schema_repair: fix_manifest_schema_repair,
  runtime_requirements_business_default: fix_runtime_requirements_business_default,
  auto_routes_relocate: fix_auto_routes_relocate,
  routing_scaffold: fix_routing_scaffold,
  catch_all_to_default_employee: fix_catch_all_to_default_employee,
  dna_dir_to_bindings: fix_dna_dir_to_bindings,
  readme_business_scaffold: fix_readme_business_scaffold,
  memory_seed: fix_memory_seed,
  protocol_bump_2: fix_protocol_bump_2,
};

/**
 * The order `--fix` applies them in: seats first (the chart is derived from
 * their frontmatter), then the manifest, then routing, then the files, and the
 * version last — declaring 2.0 over a business that still fails a v2 rule is
 * worse than declaring the old one. The gate regenerates `.nirvana-surface.json`
 * after the last handler; nothing here writes it.
 */
const FIX_ORDER = [
  'employee_frontmatter_repair', 'intake_from_chart_root', 'type_flag_sync',
  'acceptance_from_self_score', 'acceptance_normalize',
  'heartbeat_strip', 'draws_from_to_assigned', 'dna_reference_to_pin',
  'deprecated_field_strip', 'squads_authorized_empty_strip',
  'manifest_schema_repair', 'employee_count_strip', 'runtime_requirements_business_default',
  'org_chart_repair',
  'auto_routes_relocate', 'routing_scaffold', 'catch_all_to_default_employee',
  'dna_dir_to_bindings', 'readme_business_scaffold', 'memory_seed',
  'protocol_bump_2',
];

/** Applies a set of patches to one business directory. */
function applyBusinessFixes(businessDir, diff) {
  const results = [];
  for (const patch of ((diff && diff.patches) || [])) {
    let r;
    try {
      const handler = HANDLERS[patch.kind];
      r = handler ? handler(businessDir, patch) : { ok: false, reason: 'unknown patch kind' };
    } catch (e) {
      r = { ok: false, reason: 'exception: ' + e.message };
    }
    results.push({ kind: patch.kind, criterion: patch.criterion, result: r });
  }
  return results;
}

module.exports = { applyBusinessFixes, FIX_ORDER, HANDLERS, DEPRECATED_FIELDS, cloneSlug, acceptanceId, normalizeScore };
