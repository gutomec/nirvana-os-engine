/**
 * Squad Registry — Squad Protocol v5 §23
 *
 * Walks configured roots looking for squad.yaml, validates manifests,
 * computes content hashes, and emits a single registry JSON conforming to
 * core-schemas.json#/registry_squads.
 *
 * Source of truth = the squad.yaml files on disk. The registry is cache.
 *
 * Zero external deps beyond the local `yaml` module already in node_modules.
 *
 * Usage:
 *   const registry = require('~/.nirvana/skills/squads/lib/registry');
 *   registry.rebuild();                          // full rebuild → ~/.squads-registry.json
 *   const reg = registry.build();                // returns object without writing
 *   const entries = registry.scan();             // returns [{squad_name, manifest_path, manifest, hash}, ...]
 *   registry.write(registry.build(), '/tmp/r.json');
 *
 * v4 compatibility: squads without `capabilities` are still indexed
 * (entry exists in registry.squads with capabilities: []). They cannot
 * be discovered by capability_id but ARE listable.
 *
 * Collision rule: when the same squad name exists in multiple roots,
 * SQUADS_DIR (canonical, default ~/squads) wins over SQUADS_LEGACY_DIR
 * (default ~/squads-legacy-v4), and ./squads (local) wins over both.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// yaml resolves via the shared node_modules symlink at the skills-tree root.
const YAML = require('yaml');

// v4 capability inferrer (no external deps).
const v4Inferrer = require(path.join(__dirname, 'v4-capability-inferrer'));

// Centralized path resolver — single source of truth for all path defaults.
const PATHS = require(path.join(__dirname, '..', '..', '_shared', 'lib', 'paths.js'));

// ─────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────

const HOME = PATHS.HOME;
const REGISTRY_PATH = PATHS.SQUADS_REGISTRY_PATH;

// Ordered by priority: later roots override earlier ones on collision.
// Scope-aware: in project mode, only walk .nirvana/squads. In merge, walk
// both (project last, so its slugs override globals). In global, walk only
// the home installation. Backward-compatible default = global.
function _computeDefaultRoots() {
  const mode = PATHS.NIRVANA_SCOPE_MODE || 'global';
  const projectRoot = PATHS.NIRVANA_PROJECT_ROOT;
  const projectSquads = projectRoot
    ? (process.env.NIRVANA_PROJECT_SQUADS_DIR || path.join(projectRoot, '.nirvana', 'squads'))
    : null;

  if (mode === 'project' && projectSquads) {
    return [projectSquads];
  }
  if (mode === 'merge' && projectSquads) {
    return [
      PATHS.SQUADS_LEGACY_DIR,
      PATHS.SQUADS_DIR,
      projectSquads,                       // project last → wins on slug collision
      path.join(process.cwd(), 'squads'),
    ];
  }
  return [
    PATHS.SQUADS_LEGACY_DIR,
    PATHS.SQUADS_DIR,
    path.join(process.cwd(), 'squads'),
  ];
}
const DEFAULT_ROOTS = _computeDefaultRoots();

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function sha256OfBuffer(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return null;
  }
}

function safeYamlParse(raw, filePath) {
  try {
    return YAML.parse(raw);
  } catch (err) {
    process.stderr.write(`[registry] WARN cannot parse ${filePath}: ${err.message}\n`);
    return null;
  }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

/**
 * Find squad.yaml files inside a root, depth ≤ 2.
 * Robust: silently skips inaccessible directories.
 */
function findManifests(root) {
  if (!isDir(root)) return [];
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.')) continue;
    const dir = path.join(root, ent.name);
    const manifest = path.join(dir, 'squad.yaml');
    if (fs.existsSync(manifest) && fs.statSync(manifest).isFile()) {
      out.push(manifest);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/**
 * scan(roots?) → Array<{ squad_name, manifest_path, manifest, hash, root }>
 *
 * Reads every squad.yaml in the given roots. Malformed files are skipped
 * with a warning. Later roots override earlier ones on name collision
 * (so cwd > SQUADS_DIR > SQUADS_LEGACY_DIR).
 */
function scan(roots) {
  const inputRoots = Array.isArray(roots) && roots.length > 0 ? roots : DEFAULT_ROOTS;
  const byName = new Map();

  for (const root of inputRoots) {
    const manifests = findManifests(root);
    for (const manifestPath of manifests) {
      const raw = safeRead(manifestPath);
      if (raw === null) continue;
      const manifest = safeYamlParse(raw, manifestPath);
      if (!manifest || typeof manifest !== 'object') continue;
      if (!manifest.name || typeof manifest.name !== 'string') {
        process.stderr.write(`[registry] WARN skipping ${manifestPath}: missing 'name'\n`);
        continue;
      }
      const hash = sha256OfBuffer(Buffer.from(raw, 'utf8'));
      // Colisão de nome no MESMO root é ambígua (ordem do SO decide o vencedor):
      // avisa (E5e). Colisão cross-root é override deliberado (LEGACY → SQUADS_DIR
      // → cwd), documentado — não avisa para não poluir.
      const existing = byName.get(manifest.name);
      if (existing && existing.root === root) {
        process.stderr.write(
          `[registry] WARN squad '${manifest.name}' duplicado no mesmo root (o último vence — use dot-dir para backups):\n` +
          `  ${existing.manifest_path}\n  ${manifestPath}\n`,
        );
      }
      // Override on collision (later root wins).
      byName.set(manifest.name, {
        squad_name: manifest.name,
        manifest_path: manifestPath,
        manifest,
        hash,
        root
      });
    }
  }

  return Array.from(byName.values());
}

/**
 * build(roots?) → Object conforming to core-schemas.json#/registry_squads.
 *
 * Always emits required fields: schema_version, generated_at,
 * host_protocol_version, squads_root_dirs, squads, capabilities.
 */
function build(roots) {
  const inputRoots = Array.isArray(roots) && roots.length > 0 ? roots : DEFAULT_ROOTS;
  const entries = scan(inputRoots);

  const squads = {};
  const capabilities = {};
  const domains = {};
  // v4 squads get inferred capabilities here. Stored separately so harness
  // BM25 can include them as Stage 2 docs without polluting the canonical
  // v5 capabilities map.
  const v4InferredCapabilities = {};

  for (const entry of entries) {
    const m = entry.manifest;
    const squadDomains = collectSquadDomains(m);
    const capIds = Array.isArray(m.capabilities)
      ? m.capabilities.map(c => c && c.id).filter(Boolean)
      : [];

    // Agrega os campos de descoberta das capabilities no nível do SQUAD. Sem
    // isso, consumidores squad-level (o catálogo do concierge, matching por
    // squad) só veem domains + ids e NÃO enxergam o que o squad realmente FAZ
    // (ex.: brandcraft cria PDF/carrossel/vídeo/site — mas isso vivia só dentro
    // das capabilities). Os businesses já agregam; os squads não agregavam.
    const aggKeywords = new Set();
    const aggProduces = new Set();
    const aggBriefs = [];
    if (Array.isArray(m.capabilities)) {
      for (const cap of m.capabilities) {
        if (!cap || typeof cap !== 'object') continue;
        for (const k of (Array.isArray(cap.keywords) ? cap.keywords : [])) aggKeywords.add(k);
        for (const pr of (Array.isArray(cap.produces) ? cap.produces : [])) aggProduces.add(pr);
        for (const b of (Array.isArray(cap.example_briefs) ? cap.example_briefs : [])) if (aggBriefs.length < 12) aggBriefs.push(b);
      }
    }

    squads[m.name] = {
      version: typeof m.version === 'string' ? m.version : '0.0.0',
      protocol: typeof m.protocol === 'string' ? m.protocol : '4.0',
      manifest_path: entry.manifest_path,
      manifest_hash: entry.hash,
      domains: squadDomains,
      capabilities: capIds,
      keywords: Array.from(aggKeywords).slice(0, 60),
      produces: Array.from(aggProduces).slice(0, 40),
      example_briefs: aggBriefs
    };

    // Index capabilities[] by id.
    if (Array.isArray(m.capabilities)) {
      for (const cap of m.capabilities) {
        if (!cap || typeof cap !== 'object' || typeof cap.id !== 'string') continue;
        const capEntry = {
          squad: m.name,
          description: typeof cap.description === 'string' ? cap.description : '',
          domains: Array.isArray(cap.domains) ? cap.domains : [],
          examples: Array.isArray(cap.examples) ? cap.examples : [],
          not_for: Array.isArray(cap.not_for) ? cap.not_for : [],
          fidelity_status: cap.fidelity && cap.fidelity.status ? cap.fidelity.status : 'experimental',
          invoke: cap.invoke || {},
          score_boost: typeof cap.score_boost === 'number' ? cap.score_boost : 1.0
        };
        // Agentic-discovery metadata (Squad Protocol v5 §22.x — optional fields).
        // Surface in the index so Pass 1 (semantic shortlist) sees them without loading full yaml.
        if (Array.isArray(cap.produces) && cap.produces.length > 0) capEntry.produces = cap.produces;
        if (Array.isArray(cap.example_briefs) && cap.example_briefs.length > 0) capEntry.example_briefs = cap.example_briefs;
        if (Array.isArray(cap.keywords) && cap.keywords.length > 0) capEntry.keywords = cap.keywords;
        if (!capabilities[cap.id]) capabilities[cap.id] = [];
        capabilities[cap.id].push(capEntry);
      }
    } else {
      // v4 squad — try to infer capabilities from workflows/agents.
      try {
        const manifestDir = path.dirname(entry.manifest_path);
        const inferred = v4Inferrer.inferCapabilities(m, manifestDir);
        if (Array.isArray(inferred) && inferred.length > 0) {
          v4InferredCapabilities[m.name] = inferred;
          // Also propagate inferred domains back into the squad's domains[]
          // so domain index covers v4 squads.
          const inferredDomains = new Set(squadDomains);
          for (const cap of inferred) {
            for (const d of cap.domains || []) inferredDomains.add(d);
          }
          squads[m.name].domains = Array.from(inferredDomains);
        }
      } catch (e) {
        // Inferrer failure is non-fatal; squad remains in registry without inferred caps.
      }
    }

    for (const d of squads[m.name].domains) {
      if (!domains[d]) domains[d] = [];
      if (!domains[d].includes(m.name)) domains[d].push(m.name);
    }
  }

  return {
    schema_version: '1.0.0',
    generated_at: new Date().toISOString(),
    host_protocol_version: '5.0',
    squads_root_dirs: inputRoots.filter(isDir),
    squads,
    capabilities,
    domains,
    // Extra (non-schema) field for harness Stage 2. Prefixed with '_'
    // so RegistrySquads schema validation ignores it.
    _v4_inferred_capabilities: v4InferredCapabilities
  };
}

/**
 * Collects unique domains from capabilities[].domains. v4 squads (no
 * capabilities[]) get an empty domains list — they remain listable but
 * are not domain-indexed.
 */
function collectSquadDomains(manifest) {
  const set = new Set();
  if (Array.isArray(manifest.capabilities)) {
    for (const cap of manifest.capabilities) {
      if (cap && Array.isArray(cap.domains)) {
        for (const d of cap.domains) {
          if (typeof d === 'string') set.add(d);
        }
      }
    }
  }
  return Array.from(set);
}

/**
 * write(registry, registryPath) — atomic write. Creates parent dir if
 * missing. Idempotent.
 */
function write(registry, registryPath) {
  const target = registryPath || REGISTRY_PATH;
  const parent = path.dirname(target);
  // EEXIST tolerado: no Windows o Bun pode lançar mesmo com recursive:true.
  try { fs.mkdirSync(parent, { recursive: true }); }
  catch (e) { if (e && e.code !== 'EEXIST') throw e; }
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

/**
 * rebuild(roots?) → registry path
 *
 * Convenience: scan + build + write in one call. Idempotent. Auto-creates
 * SQUADS_DIR (default ~/squads) if missing so a fresh-install user has a
 * usable root.
 */
function rebuild(roots) {
  // Auto-bootstrap canonical squads root for fresh installs.
  const squadsRoot = PATHS.SQUADS_DIR;
  if (!isDir(squadsRoot)) {
    try { fs.mkdirSync(squadsRoot, { recursive: true }); } catch (e) { /* ignore */ }
  }
  const registry = build(roots);
  const written = write(registry);
  return { path: written, summary: summarize(registry) };
}

function summarize(registry) {
  const squadCount = Object.keys(registry.squads).length;
  const capCount = Object.keys(registry.capabilities).length;
  const domainCount = Object.keys(registry.domains || {}).length;
  return { squads: squadCount, capabilities: capCount, domains: domainCount };
}

module.exports = {
  scan,
  build,
  write,
  rebuild,
  REGISTRY_PATH,
  DEFAULT_ROOTS
};

// ─────────────────────────────────────────────────────────────────────
// CLI: `node registry.js [rebuild|build|scan]`
// ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const cmd = process.argv[2] || 'rebuild';
  if (cmd === 'rebuild') {
    const r = rebuild();
    process.stdout.write(`registry written: ${r.path}\n`);
    process.stdout.write(`  squads: ${r.summary.squads}\n`);
    process.stdout.write(`  capabilities: ${r.summary.capabilities}\n`);
    process.stdout.write(`  domains: ${r.summary.domains}\n`);
  } else if (cmd === 'build') {
    process.stdout.write(JSON.stringify(build(), null, 2) + '\n');
  } else if (cmd === 'scan') {
    const entries = scan().map(e => ({
      squad_name: e.squad_name,
      manifest_path: e.manifest_path,
      hash: e.hash,
      protocol: e.manifest.protocol || '4.0',
      capability_count: Array.isArray(e.manifest.capabilities) ? e.manifest.capabilities.length : 0
    }));
    process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
  } else {
    process.stderr.write(`Usage: node registry.js [rebuild|build|scan]\n`);
    process.exit(1);
  }
}
