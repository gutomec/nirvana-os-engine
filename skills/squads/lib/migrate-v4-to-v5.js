/**
 * migrate-v4-to-v5.js — Migrate a v4 squad to v5 protocol.
 *
 * Reads a squad at <legacyDir>/<slug>, writes a v5-compliant copy to
 * <targetDir>/<slug>. Validates the result against the v5 SquadManifest
 * schema (Pydantic) and aborts the per-squad migration on failure.
 *
 * Steps per squad:
 *   1. cp -R legacy/<slug> target/<slug>
 *   2. Read squad.yaml, drop fields the v5 StrictModel rejects
 *   3. Bump protocol → "5.0", version → 5.0.0
 *   4. Inject capabilities[] inferred from workflows (via v4-capability-inferrer)
 *   5. Add legacy.v4_path pointing back to legacy source
 *   6. Write squad.yaml; validate via Pydantic
 *   7. On failure, remove the partial copy and report
 *
 * Usage (CLI):
 *   node migrate-v4-to-v5.js <slug>                  # migrate one squad
 *   node migrate-v4-to-v5.js --all                   # migrate every squad in legacy
 *   node migrate-v4-to-v5.js --all --dry-run         # report what would change
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PATHS = require(path.join(__dirname, '..', '..', '_shared', 'lib', 'paths.js'));
const YAML = require('yaml');
const inferrer = require(path.join(__dirname, 'v4-capability-inferrer.js'));

const LEGACY_DIR = PATHS.SQUADS_LEGACY_DIR;
const TARGET_DIR = PATHS.SQUADS_DIR;

// Fields v5 SquadManifest accepts at top level (validators.py:194-210).
const ALLOWED_TOP = new Set([
  'name', 'version', 'protocol', 'description', 'author', 'license', 'slashPrefix',
  'tags', 'capabilities', 'experimental_domains', 'components',
  'runtime_requirements', 'features_required', 'features_optional', 'output', 'legacy',
]);

// Fields v5 SquadComponents accepts (validators.py:180-183).
const ALLOWED_COMPONENT_FIELDS = new Set(['agents', 'tasks', 'workflows']);

const VALIDATOR_SCRIPT = `
import sys, json, yaml
sys.path.insert(0, '${path.join(PATHS.CLAUDE_SKILLS_DIR, '_shared', 'validators')}')
from validators import SquadManifest
from pydantic import ValidationError

with open(sys.argv[1]) as f:
    data = yaml.safe_load(f)

try:
    SquadManifest.model_validate(data)
    print(json.dumps({"ok": True}))
except ValidationError as e:
    errs = [{"loc": list(err["loc"]), "msg": err["msg"]} for err in e.errors()]
    print(json.dumps({"ok": False, "errors": errs}))
`;

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDirSync(s, d);
    else if (ent.isSymbolicLink()) {
      const target = fs.readlinkSync(s);
      try { fs.symlinkSync(target, d); } catch { /* ignore */ }
    } else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

function rmRfSync(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

/**
 * Convert an inferrer capability (registry-shape) into the schema-compliant
 * Capability shape that v5 SquadManifest accepts inline.
 */
function adaptCapability(c) {
  return {
    id: c.capability_id,
    description: c.description,
    domains: c.domains && c.domains.length ? c.domains : ['general'],
    invoke: c.invoke,
    examples: (c.examples && c.examples.length) ? c.examples : [c.description.slice(0, 80)],
    ...(c.not_for && c.not_for.length ? { not_for: c.not_for } : {}),
    fidelity: { status: 'experimental' },
    ...(typeof c.score_boost === 'number' ? { score_boost: c.score_boost } : {}),
  };
}

/**
 * Drop disallowed top-level fields and disallowed component sub-fields.
 * Returns a sanitized manifest object suitable for v5.
 */
function sanitizeManifest(manifest) {
  const out = {};
  for (const [k, v] of Object.entries(manifest)) {
    if (ALLOWED_TOP.has(k)) out[k] = v;
  }

  if (out.components && typeof out.components === 'object') {
    const comp = {};
    for (const [k, v] of Object.entries(out.components)) {
      if (ALLOWED_COMPONENT_FIELDS.has(k) && Array.isArray(v) && v.length > 0) {
        comp[k] = v;
      }
    }
    if (Object.keys(comp).length === 0) {
      // Components must exist but at least one of the three lists is non-empty
      // for any usable squad. We keep agents at minimum.
      comp.agents = [];
    }
    out.components = comp;
  } else {
    out.components = { agents: [] };
  }

  // license default is "MIT"; if blank, set explicitly
  if (!out.license) out.license = 'MIT';

  // Normalize author: schema requires string. v4 squads sometimes have
  // structured authors like {name, tool} — coerce to a flat string.
  if (out.author !== undefined && out.author !== null && typeof out.author !== 'string') {
    if (typeof out.author === 'object' && out.author.name) {
      out.author = String(out.author.name);
    } else {
      out.author = String(out.author);
    }
  }

  // Normalize output: v5 SquadOutput only allows base_dir.
  if (out.output && typeof out.output === 'object') {
    const cleanOutput = {};
    if (typeof out.output.base_dir === 'string') cleanOutput.base_dir = out.output.base_dir;
    if (Object.keys(cleanOutput).length === 0) delete out.output;
    else out.output = cleanOutput;
  }

  // Normalize tags: schema requires array of strings.
  if (Array.isArray(out.tags)) {
    out.tags = out.tags.filter(t => typeof t === 'string' && t.length > 0).map(t => String(t));
    if (out.tags.length === 0) delete out.tags;
  } else if (out.tags !== undefined) {
    delete out.tags;
  }

  return out;
}

/**
 * Migrate one squad.
 *
 * @returns {{slug, ok, errors?, capabilitiesInjected?, targetPath?}}
 */
function migrateSquad(slug, opts = {}) {
  const dryRun = !!opts.dryRun;
  const overwrite = !!opts.overwrite;

  const srcDir = path.join(LEGACY_DIR, slug);
  const dstDir = path.join(TARGET_DIR, slug);
  const srcManifestPath = path.join(srcDir, 'squad.yaml');
  const dstManifestPath = path.join(dstDir, 'squad.yaml');

  if (!fs.existsSync(srcManifestPath)) {
    return { slug, ok: false, errors: [`squad.yaml not found at ${srcManifestPath}`] };
  }

  if (fs.existsSync(dstDir) && !overwrite) {
    return { slug, ok: false, errors: [`target ${dstDir} exists; pass --overwrite to replace`] };
  }

  let manifest;
  try {
    manifest = YAML.parse(fs.readFileSync(srcManifestPath, 'utf8'));
  } catch (e) {
    return { slug, ok: false, errors: [`yaml parse error: ${e.message}`] };
  }

  if (!manifest || typeof manifest !== 'object') {
    return { slug, ok: false, errors: ['empty or non-object manifest'] };
  }

  // Infer capabilities BEFORE sanitization (uses the raw manifest's components)
  let capabilities = [];
  try {
    const inferred = inferrer.inferCapabilities(manifest, srcDir);
    capabilities = inferred.map(adaptCapability);
  } catch (e) {
    // Inferrer failure is non-fatal — squad still indexable, just without auto-discovery
    capabilities = [];
  }

  const sanitized = sanitizeManifest(manifest);
  sanitized.protocol = '5.0';

  // Bump version to 5.x.0 to signal protocol upgrade. Preserve user's previous
  // version inside legacy.v4_path metadata for traceability.
  const previousVersion = manifest.version || '0.0.0';
  if (typeof sanitized.version === 'string') {
    // If the squad already used a v5.x.x semver, keep it; else stamp 5.0.0
    if (!/^5\./.test(sanitized.version)) sanitized.version = '5.0.0';
  } else {
    sanitized.version = '5.0.0';
  }

  if (capabilities.length > 0) {
    sanitized.capabilities = capabilities;
  }

  sanitized.legacy = {
    ...(sanitized.legacy || {}),
    v4_path: srcDir,
  };

  if (dryRun) {
    return {
      slug,
      ok: true,
      dryRun: true,
      capabilitiesInjected: capabilities.length,
      previousVersion,
      newProtocol: '5.0',
      droppedTopFields: Object.keys(manifest).filter(k => !ALLOWED_TOP.has(k)),
    };
  }

  // Stage to a temp dir, then atomic-rename
  const stagingDir = `${dstDir}.staging-${Date.now()}`;
  try {
    copyDirSync(srcDir, stagingDir);
    const yamlOut = YAML.stringify(sanitized, { lineWidth: 0 });
    fs.writeFileSync(path.join(stagingDir, 'squad.yaml'), yamlOut, 'utf8');

    // Validate via Pydantic
    const result = execFileSync('python3', ['-c', VALIDATOR_SCRIPT, path.join(stagingDir, 'squad.yaml')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(result);
    if (!parsed.ok) {
      rmRfSync(stagingDir);
      return { slug, ok: false, errors: parsed.errors.map(e => `${e.loc.join('.')}: ${e.msg}`) };
    }

    if (fs.existsSync(dstDir)) rmRfSync(dstDir);
    fs.renameSync(stagingDir, dstDir);

    return {
      slug,
      ok: true,
      capabilitiesInjected: capabilities.length,
      previousVersion,
      targetPath: dstDir,
    };
  } catch (e) {
    rmRfSync(stagingDir);
    return { slug, ok: false, errors: [`migration error: ${e.message}`] };
  }
}

function listLegacySquads() {
  if (!fs.existsSync(LEGACY_DIR)) return [];
  return fs.readdirSync(LEGACY_DIR, { withFileTypes: true })
    .filter(ent => ent.isDirectory() && fs.existsSync(path.join(LEGACY_DIR, ent.name, 'squad.yaml')))
    .map(ent => ent.name);
}

module.exports = {
  migrateSquad,
  listLegacySquads,
  ALLOWED_TOP,
  ALLOWED_COMPONENT_FIELDS,
  adaptCapability,
  sanitizeManifest,
};

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const overwrite = args.includes('--overwrite');
  const all = args.includes('--all');

  const slugs = all ? listLegacySquads() : args.filter(a => !a.startsWith('--'));
  if (slugs.length === 0) {
    console.error('usage: migrate-v4-to-v5.js [--all] [--dry-run] [--overwrite] [<slug> ...]');
    process.exit(64);
  }

  const summary = { ok: [], failed: [] };
  for (const slug of slugs) {
    const r = migrateSquad(slug, { dryRun, overwrite });
    if (r.ok) {
      summary.ok.push(r);
      console.log(`✓ ${slug}  caps=${r.capabilitiesInjected}  ${r.dryRun ? '[dry-run]' : '→ ' + r.targetPath}`);
    } else {
      summary.failed.push(r);
      console.log(`✗ ${slug}  ${r.errors.slice(0, 3).join('; ')}`);
    }
  }

  console.log('');
  console.log(`Result: ${summary.ok.length} ok / ${summary.failed.length} failed`);
  process.exit(summary.failed.length > 0 ? 1 : 0);
}
