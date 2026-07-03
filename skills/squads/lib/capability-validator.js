/**
 * Capability Validator — Squad Protocol v5 §22.9
 *
 * Authoritative schema validation via the Zod validators in
 * ~/.nirvana/skills/_shared/validators/validators.ts, plus a fast pure-JS
 * structural pre-check. Bun-native: no Python required.
 *
 * API:
 *   validateCapability(cap, catalogPath?)         → { valid, errors, warnings }
 *   validateSquadV5Manifest(manifest)             → { valid, errors, warnings }
 *   validateAll(squadDir)                         → full sweep: manifest + agents + tasks + workflows
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const YAML = require('yaml');

const HOME = os.homedir();
const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), '.nirvana', 'skills')) ? path.join(os.homedir(), '.nirvana', 'skills') : path.join(os.homedir(), '.claude', 'skills'));
const VALIDATORS_TS = path.join(SKILLS_ROOT, '_shared', 'validators', 'validators.ts');
const CATALOG_PATH = path.join(SKILLS_ROOT, '_shared', 'catalogs', 'CAPABILITY_CATALOG_V1.yaml');

const CAPABILITY_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;
const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;

// ─────────────────────────────────────────────────────────────────────
// Catalog loader (idempotent, lazy)
// ─────────────────────────────────────────────────────────────────────

let _catalogDomainSet = null;

function loadCatalogDomains(catalogPath) {
  const target = catalogPath || CATALOG_PATH;
  if (_catalogDomainSet && !catalogPath) return _catalogDomainSet;
  if (!fs.existsSync(target)) return new Set();
  let raw;
  try { raw = fs.readFileSync(target, 'utf8'); } catch (e) { return new Set(); }
  let parsed;
  try { parsed = YAML.parse(raw); } catch (e) { return new Set(); }
  const set = new Set();
  if (parsed && Array.isArray(parsed.domains)) {
    for (const d of parsed.domains) {
      if (d && typeof d.id === 'string') set.add(d.id);
    }
  }
  if (!catalogPath) _catalogDomainSet = set;
  return set;
}

// ─────────────────────────────────────────────────────────────────────
// Pure-JS structural checks (fallback + fast-path)
// ─────────────────────────────────────────────────────────────────────

function structuralCapabilityCheck(cap, catalogDomains, options) {
  const errors = [];
  const warnings = [];
  const experimentalDomains = options && options.experimental_domains === true;

  if (!cap || typeof cap !== 'object') {
    return { errors: ['capability is not an object'], warnings: [] };
  }

  if (typeof cap.id !== 'string' || !CAPABILITY_ID_RE.test(cap.id)) {
    errors.push(`id must match ${CAPABILITY_ID_RE} (got: ${JSON.stringify(cap.id)})`);
  }

  if (typeof cap.description !== 'string' ||
      cap.description.length < 20 ||
      cap.description.length > 500) {
    errors.push('description must be a string between 20 and 500 chars');
  }

  if (!Array.isArray(cap.domains) || cap.domains.length < 1 || cap.domains.length > 5) {
    errors.push('domains must have 1 to 5 entries');
  } else {
    for (const d of cap.domains) {
      if (typeof d !== 'string' || !SNAKE_CASE_RE.test(d)) {
        errors.push(`domain ${JSON.stringify(d)} is not snake_case`);
      } else if (catalogDomains.size > 0 && !catalogDomains.has(d) && !experimentalDomains) {
        warnings.push(
          `domain '${d}' is not in CAPABILITY_CATALOG_V1.yaml; ` +
          `set 'experimental_domains: true' on the squad if intentional`
        );
      }
    }
  }

  if (!cap.invoke || typeof cap.invoke !== 'object') {
    errors.push('invoke is required');
  } else {
    if (!['workflow', 'task', 'agent'].includes(cap.invoke.type)) {
      errors.push(`invoke.type must be one of [workflow, task, agent] (got: ${cap.invoke.type})`);
    }
    if (typeof cap.invoke.ref !== 'string' || cap.invoke.ref.length === 0) {
      errors.push('invoke.ref is required and non-empty');
    }
  }

  if (!Array.isArray(cap.examples) || cap.examples.length < 1) {
    errors.push('examples[] requires ≥1 entry (used by BM25 discovery)');
  } else {
    for (const ex of cap.examples) {
      if (typeof ex !== 'string' || ex.length < 5) {
        errors.push(`example ${JSON.stringify(ex)} is too short (min 5 chars)`);
      }
    }
  }

  if (cap.fidelity && cap.fidelity.status &&
      !['validated', 'experimental', 'drifted', 'retired'].includes(cap.fidelity.status)) {
    errors.push(`fidelity.status invalid: ${cap.fidelity.status}`);
  }

  if (cap.score_boost !== undefined &&
      (typeof cap.score_boost !== 'number' || cap.score_boost < 0 || cap.score_boost > 2)) {
    errors.push('score_boost must be a number in [0, 2]');
  }

  return { errors, warnings };
}

// ─────────────────────────────────────────────────────────────────────
// Schema validation via Zod (validators.ts) — authoritative, Bun-native.
// No Python: Bun transpiles and requires the TypeScript validators directly.
// ─────────────────────────────────────────────────────────────────────

const SCHEMA_BY_MODEL = {
  Capability: 'CapabilitySchema',
  SquadManifest: 'SquadManifestSchema',
};

function runSchemaValidation(modelName, payload) {
  let validators;
  try {
    validators = require(VALIDATORS_TS);
  } catch (exc) {
    return { ok: false, reason: `validators.ts load error: ${exc.message}`, errors: [] };
  }
  const schemaName = SCHEMA_BY_MODEL[modelName] || `${modelName}Schema`;
  const schema = validators[schemaName];
  if (!schema || typeof schema.safeParse !== 'function') {
    return { ok: false, errors: [`model not found: ${modelName}`], reason: null };
  }
  const result = schema.safeParse(payload);
  if (result.success) return { ok: true, errors: [], reason: null };
  const errors = result.error.issues.map(
    (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
  );
  return { ok: false, errors, reason: null };
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

function validateCapability(cap, catalogPath) {
  const catalog = loadCatalogDomains(catalogPath);
  const struct = structuralCapabilityCheck(cap, catalog, {});

  // If structural check failed, don't bother with pydantic (clearer errors).
  if (struct.errors.length > 0) {
    return { valid: false, errors: struct.errors, warnings: struct.warnings, source: 'structural' };
  }

  const py = runSchemaValidation('Capability', cap);
  if (py.reason) {
    return {
      valid: true,
      errors: [],
      warnings: struct.warnings.concat(['pydantic skipped: ' + py.reason]),
      source: 'structural-only'
    };
  }
  return {
    valid: py.ok,
    errors: py.errors,
    warnings: struct.warnings,
    source: 'pydantic'
  };
}

function validateSquadV5Manifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['manifest is not an object'], warnings: [] };
  }
  const errors = [];
  const warnings = [];

  if (manifest.protocol === '5.0') {
    if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
      errors.push("v5 squads must declare capabilities[] (else they are invisible to discovery)");
    } else {
      const catalog = loadCatalogDomains();
      const opts = { experimental_domains: manifest.experimental_domains === true };
      manifest.capabilities.forEach((cap, idx) => {
        const r = structuralCapabilityCheck(cap, catalog, opts);
        for (const e of r.errors) errors.push(`capabilities[${idx}]: ${e}`);
        for (const w of r.warnings) warnings.push(`capabilities[${idx}]: ${w}`);
      });
    }
  } else if (manifest.protocol === '4.0' || manifest.protocol === '4.1') {
    if (Array.isArray(manifest.capabilities) && manifest.capabilities.length > 0) {
      warnings.push("protocol 4.x with capabilities[] declared — consider bumping protocol to 5.0");
    }
  } else {
    warnings.push(`unknown protocol: ${manifest.protocol}`);
  }

  // Pydantic SquadManifest as authoritative final pass.
  const py = runSchemaValidation('SquadManifest', manifest);
  if (py.reason) {
    warnings.push('pydantic skipped: ' + py.reason);
  } else if (!py.ok) {
    for (const e of py.errors) errors.push('SquadManifest: ' + e);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateAll(squadDir) {
  const result = {
    valid: true,
    squad_dir: squadDir,
    manifest: null,
    errors: [],
    warnings: [],
    referenced_files: { agents: [], tasks: [], workflows: [] }
  };

  const manifestPath = path.join(squadDir, 'squad.yaml');
  if (!fs.existsSync(manifestPath)) {
    result.valid = false;
    result.errors.push('squad.yaml not found');
    return result;
  }

  let raw, manifest;
  try { raw = fs.readFileSync(manifestPath, 'utf8'); } catch (e) {
    result.valid = false; result.errors.push('cannot read squad.yaml: ' + e.message); return result;
  }
  try { manifest = YAML.parse(raw); } catch (e) {
    result.valid = false; result.errors.push('squad.yaml YAML parse error: ' + e.message); return result;
  }
  result.manifest = manifest;

  // Philosophy (b) visibility: the manifest tolerates unknown top-level keys
  // (user/system extras), but we WARN on each so they stay visible and we can
  // decide what to formalize into the protocol later. Keep this set in sync with
  // SquadManifest fields in _shared/validators/validators.{py,ts}.
  const KNOWN_TOP_LEVEL = new Set([
    'name', 'version', 'protocol', 'description', 'author', 'license', 'slashPrefix',
    'tags', 'capabilities', 'experimental_domains', 'components', 'runtime_requirements',
    'features_required', 'features_optional', 'output', 'legacy', 'io', 'memory', 'instrumentation',
  ]);
  if (manifest && typeof manifest === 'object') {
    for (const key of Object.keys(manifest)) {
      if (!KNOWN_TOP_LEVEL.has(key)) {
        result.warnings.push(`non-canonical top-level key '${key}' (tolerated; formalize in the protocol if it becomes standard)`);
      }
    }
  }

  const m = validateSquadV5Manifest(manifest);
  result.errors.push(...m.errors);
  result.warnings.push(...m.warnings);

  // Component file existence (relative to squad dir).
  // Accepts: full relative path, bare filename with extension, or bare filename
  // without extension (default: .md for agents/tasks, .yaml or .yml for workflows).
  const components = manifest.components || {};
  const defaultExt = (bucket) => bucket === 'workflows' ? ['.yaml', '.yml'] : ['.md'];
  const checkBucket = (bucket, subdir) => {
    if (!Array.isArray(components[bucket])) return;
    for (const file of components[bucket]) {
      const exts = defaultExt(bucket);
      const tries = file.includes('/')
        ? [path.join(squadDir, file)]
        : [path.join(squadDir, subdir, file), ...exts.map(e => path.join(squadDir, subdir, file + e))];
      const found = tries.find(p => fs.existsSync(p));
      const candidate = found || tries[0];
      const exists = !!found;
      result.referenced_files[bucket].push({ file, path: candidate, exists });
      if (!exists) result.errors.push(`components.${bucket}: file not found: ${file}`);
    }
  };
  checkBucket('agents', 'agents');
  checkBucket('tasks', 'tasks');
  checkBucket('workflows', 'workflows');

  // Capability invoke refs must point to existing files when possible.
  if (Array.isArray(manifest.capabilities)) {
    manifest.capabilities.forEach((cap, idx) => {
      if (!cap || !cap.invoke || typeof cap.invoke.ref !== 'string') return;
      const ref = cap.invoke.ref;
      // Allow external references or skip if it's a bare agent name.
      const candidate = path.join(squadDir, ref);
      if (!fs.existsSync(candidate) && cap.invoke.type !== 'agent') {
        result.warnings.push(
          `capabilities[${idx}].invoke.ref does not resolve on disk: ${ref}`
        );
      }
    });
  }

  result.valid = result.errors.length === 0;
  return result;
}

module.exports = {
  validateCapability,
  validateSquadV5Manifest,
  validateAll,
  loadCatalogDomains,
  CATALOG_PATH,
  VALIDATORS_TS
};

// ─────────────────────────────────────────────────────────────────────
// CLI: node capability-validator.js {squad|capability} <path>
// ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const sub = process.argv[2];
  const target = process.argv[3];
  if (!sub || !target) {
    process.stderr.write('Usage: node capability-validator.js {squad|manifest|capability} <path>\n');
    process.exit(1);
  }
  let payload, manifest;
  if (sub === 'squad') {
    const r = validateAll(target);
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(r.valid ? 0 : 1);
  }
  if (sub === 'manifest') {
    manifest = YAML.parse(fs.readFileSync(target, 'utf8'));
    const r = validateSquadV5Manifest(manifest);
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(r.valid ? 0 : 1);
  }
  if (sub === 'capability') {
    payload = JSON.parse(fs.readFileSync(target, 'utf8'));
    const r = validateCapability(payload);
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(r.valid ? 0 : 1);
  }
  process.stderr.write('unknown subcommand: ' + sub + '\n');
  process.exit(1);
}
