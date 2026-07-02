/**
 * activator.js — Squad activation + dependency installation.
 *
 * When a user asks to activate a squad, this module:
 *   1. Reads `<squad>/dependencies.yaml` (sidecar; not validated by SquadManifest)
 *   2. Walks each dependency category in order: system → python → node → services → custom_nodes → models → env_vars
 *   3. For each item: runs `check` command — if exit 0, mark `already_present`. Else runs `install`.
 *   4. Validates with health checks.
 *   5. Persists state at ~/.claude/squads-state/<slug>/activated.json
 *
 * Heavy installs (>1GB, sudo, network downloads) require user confirmation —
 * activator returns `confirmation_required` items so the calling agent can
 * surface them to the user before proceeding.
 *
 * Idempotent: re-running activation on an already-active squad is fast
 * (every check passes, nothing installs).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const HOME = os.homedir();
const PLATFORM = process.platform; // 'darwin' | 'linux' | 'win32'
const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), '.nirvana', 'skills')) ? path.join(os.homedir(), '.nirvana', 'skills') : path.join(os.homedir(), '.claude', 'skills'));
const PATHS = require(path.join(SKILLS_ROOT, '_shared', 'lib', 'paths.js'));
const SQUADS_DIR = process.env.SQUADS_DIR || PATHS.SQUADS_DIR;
const STATE_DIR = process.env.NIRVANA_STATE_DIR || PATHS.SQUADS_STATE_DIR;
// When the caller (activate-squad.ts) resolved a project-scoped squad,
// it passes the absolute path through this env var so we operate on the
// project copy instead of falling back to $SQUADS_DIR/<slug>.
const RESOLVED_SQUAD_PATH = process.env.NIRVANA_RESOLVED_SQUAD_PATH || null;

const YAML = require('yaml');

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function readYaml(filePath) {
  if (!YAML || !fs.existsSync(filePath)) return null;
  try { return YAML.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (e) { return null; }
}

function checkCmd(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: 'pipe', timeout: opts.timeoutMs || 30000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function runCmd(cmd, opts = {}) {
  // Verbose mode (set by CLI via env) overrides silent: stream output live so
  // an automation agent can see brew/git/pip progress in real time.
  const verbose = process.env.MAESTRO_ACTIVATOR_VERBOSE === '1';
  const stdio = verbose ? 'inherit' : (opts.silent ? 'pipe' : 'pipe');
  try {
    const out = execSync(cmd, {
      stdio,
      timeout: opts.timeoutMs || 600000,
      cwd: opts.cwd || undefined,
      env: { ...process.env, ...(opts.env || {}) },
    });
    return { ok: true, output: out ? out.toString() : '' };
  } catch (e) {
    return { ok: false, error: e.message, code: e.status, stderr: e.stderr ? e.stderr.toString() : null };
  }
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function expandPath(p) {
  if (!p) return p;
  if (p.startsWith('~')) return path.join(HOME, p.slice(1));
  return p;
}

function getStatePath(slug) {
  return path.join(STATE_DIR, slug, 'activated.json');
}

function loadState(slug) {
  const p = getStatePath(slug);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function saveState(slug, state) {
  const p = getStatePath(slug);
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  return p;
}

// ─────────────────────────────────────────────────────────────────────
// Per-category installers
// ─────────────────────────────────────────────────────────────────────

// Tolerates the multiple dependency shapes that dependencies.yaml files use
// across squads: {manager, packages:[strings]}, {manager, packages:[{name,version,global,check}]},
// bare arrays of either, and version-bearing strings like "ffmpeg >= 6.0".
function depToToken(item, eco) {
  if (typeof item === 'string') {
    const s = item.trim();
    return eco === 'pip' ? s.replace(/\s+/g, '') : s;
  }
  if (item && typeof item === 'object' && item.name) {
    const name = String(item.name).trim();
    const ver = item.version ? String(item.version).replace(/\s+/g, '') : '';
    if (!ver) return name;
    if (eco === 'npm') return `${name}@${ver}`;
    return /^[<>=~!]/.test(ver) ? `${name}${ver}` : `${name}==${ver}`;
  }
  return null;
}

function normalizeDepSpec(spec, defaultManager) {
  // Returns { manager, global, raw:[item], checks:[string|null] } or null.
  if (!spec) return null;
  let list, manager = defaultManager, glob = false;
  if (Array.isArray(spec)) {
    list = spec;
  } else if (Array.isArray(spec.packages)) {
    list = spec.packages; manager = spec.manager || defaultManager; glob = !!spec.global;
  } else {
    return null;
  }
  const raw = list.filter(Boolean);
  if (raw.length === 0) return null;
  const objGlobal = raw.some(x => x && typeof x === 'object' && x.global);
  const checks = raw.map(x => (x && typeof x === 'object' && x.check) ? x.check : null);
  return { manager, global: glob || objGlobal, raw, checks };
}

function allChecksPass(norm) {
  if (!norm.checks.length || norm.checks.some(c => !c)) return false;
  return norm.checks.every(c => checkCmd(c).ok);
}

function installSystem(dep, dryRun) {
  // Bare prereq string (e.g. "ffmpeg >= 6.0", "node >= 20"): we can only verify
  // presence — auto-installing a system tool needs a package-manager mapping we
  // don't have, so a miss is surfaced (non-blocking), not failed.
  if (typeof dep === 'string') {
    const tool = dep.trim().split(/[\s<>=!~]/)[0];
    if (!tool) return { name: dep, status: 'skipped', kind: 'system' };
    const present = checkCmd(`command -v ${tool}`).ok;
    return present
      ? { name: tool, status: 'already_present', kind: 'system' }
      : { name: tool, status: 'missing_system_tool', kind: 'system', spec: dep,
          note: `Prereq '${tool}' not found on PATH. Install it (brew/apt/winget) and re-activate.` };
  }
  const checkResult = checkCmd(dep.check);
  if (checkResult.ok) {
    return { name: dep.name, status: 'already_present', kind: 'system' };
  }
  const installCmd = (dep.install || {})[PLATFORM];
  if (!installCmd) {
    return { name: dep.name, status: 'install_unsupported_platform', kind: 'system', platform: PLATFORM };
  }
  if (dryRun) {
    return { name: dep.name, status: 'would_install', kind: 'system', cmd: installCmd };
  }
  const installResult = runCmd(installCmd);
  if (!installResult.ok) {
    return { name: dep.name, status: 'install_failed', kind: 'system', error: installResult.error };
  }
  const recheck = checkCmd(dep.check);
  return {
    name: dep.name,
    status: recheck.ok ? 'installed' : 'install_completed_but_check_failed',
    kind: 'system',
  };
}

function installPython(spec, dryRun) {
  const norm = normalizeDepSpec(spec, 'pip');
  if (!norm) return { status: 'no_python_deps' };
  const tokens = norm.raw.map(x => depToToken(x, 'pip')).filter(Boolean);
  if (tokens.length === 0) return { status: 'no_python_deps' };
  if (allChecksPass(norm)) return { status: 'already_present', kind: 'python', packages: tokens };
  const manager = norm.manager === 'uv' ? 'uv' : 'pip';
  const target = expandPath((!Array.isArray(spec) && (spec.target_dir || (spec.use_squad_venv ? '.venv' : null))) || null);

  let cmd;
  if (manager === 'uv') {
    cmd = `uv pip install ${tokens.map(p => `'${p}'`).join(' ')}`;
  } else {
    // pip vs pip3 fallback (macOS system python often only ships pip3); --user
    // when there is no explicit target dir/venv so it works on managed pythons.
    const pipBin = checkCmd('pip --version').ok ? 'pip' : (checkCmd('pip3 --version').ok ? 'pip3' : 'pip');
    const userFlag = target ? '' : ' --user';
    cmd = `${pipBin} install${userFlag} ${tokens.map(p => `'${p}'`).join(' ')}`;
  }
  if (dryRun) return { status: 'would_install', kind: 'python', manager, cmd };
  const r = runCmd(cmd, { cwd: target });
  return {
    status: r.ok ? 'installed' : 'install_failed',
    kind: 'python',
    manager,
    packages: tokens,
    error: r.ok ? null : r.error,
  };
}

function installNode(spec, dryRun, squadDir) {
  const norm = normalizeDepSpec(spec, 'npm');
  if (!norm) return { status: 'no_node_deps' };
  const tokens = norm.raw.map(x => depToToken(x, 'npm')).filter(Boolean);
  if (tokens.length === 0) return { status: 'no_node_deps' };
  if (allChecksPass(norm)) return { status: 'already_present', kind: 'node', manager: norm.manager, global: norm.global, packages: tokens };
  const manager = norm.manager || 'npm';
  const g = norm.global;
  const cmd = manager === 'pnpm' ? `pnpm add${g ? ' -g' : ''} ${tokens.join(' ')}`
            : manager === 'yarn' ? `yarn ${g ? 'global add' : 'add'} ${tokens.join(' ')}`
            : `npm install${g ? ' -g' : ''} ${tokens.join(' ')}`;
  if (dryRun) return { status: 'would_install', kind: 'node', manager, global: g, cmd };
  // Local installs default to the squad's OWN dir, so npm never pollutes the
  // ~/squads root with a stray node_modules/package-lock. An explicit spec.cwd
  // (object form) still wins; global installs (-g) ignore cwd.
  const r = runCmd(cmd, { cwd: g ? undefined : (expandPath(!Array.isArray(spec) ? spec.cwd : null) || squadDir) });
  return { status: r.ok ? 'installed' : 'install_failed', kind: 'node', manager, global: g, packages: tokens, error: r.ok ? null : r.error };
}

// Sub-app installer: some squads ship self-contained sub-projects with their
// OWN package.json (e.g. dashboard/, scripts/). The root install can't reach
// them, so a squad would look "activated" while its dashboard/renderer can't
// run. This installs each sub-app IN ITS OWN dir (so a squad is fully runnable
// after `nrv activate`, not just its root deps). Skips non-app dirs and any
// sub-app that already has node_modules.
const SUBAPP_SKIP = new Set(['node_modules', 'templates', 'examples', 'example', 'fixtures', 'references', 'schemas', 'docs', 'test', 'tests', '__tests__', 'data', 'assets', '.git']);
function installSubApps(squadDir, dryRun) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(squadDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SUBAPP_SKIP.has(e.name)) continue;
    const sub = path.join(squadDir, e.name);
    if (!fs.existsSync(path.join(sub, 'package.json'))) continue;
    if (fs.existsSync(path.join(sub, 'node_modules'))) { out.push({ dir: e.name, status: 'already_present', kind: 'subapp' }); continue; }
    const mgr = (fs.existsSync(path.join(sub, 'bun.lock')) || fs.existsSync(path.join(sub, 'bun.lockb'))) ? 'bun'
              : fs.existsSync(path.join(sub, 'pnpm-lock.yaml')) ? 'pnpm'
              : fs.existsSync(path.join(sub, 'yarn.lock')) ? 'yarn' : 'npm';
    const cmd = `${mgr} install`;
    if (dryRun) { out.push({ dir: e.name, status: 'would_install', kind: 'subapp', cmd }); continue; }
    const r = runCmd(cmd, { cwd: sub });
    out.push({ dir: e.name, status: r.ok ? 'installed' : 'install_failed', kind: 'subapp', manager: mgr, error: r.ok ? null : r.error });
  }
  return out;
}

function installService(svc, dryRun) {
  const installDir = expandPath(svc.install_dir);
  const alreadyCloned = installDir && fs.existsSync(installDir);

  // 1. Health check first — service may already be running
  if (svc.health_check) {
    const h = checkCmd(svc.health_check);
    if (h.ok) return { name: svc.name, status: 'already_running', kind: 'service' };
  }

  // 2. Clone if missing
  if (svc.repo && !alreadyCloned) {
    if (dryRun) return { name: svc.name, status: 'would_clone', kind: 'service', cmd: `git clone ${svc.repo} ${installDir}` };
    const r = runCmd(`git clone ${svc.repo} ${installDir}`);
    if (!r.ok) return { name: svc.name, status: 'clone_failed', kind: 'service', error: r.error };
  }

  // 3. Install command
  if (svc.install_cmd) {
    if (dryRun) return { name: svc.name, status: 'would_install', kind: 'service', cmd: svc.install_cmd, cwd: installDir };
    const r = runCmd(svc.install_cmd, { cwd: installDir });
    if (!r.ok) return { name: svc.name, status: 'install_failed', kind: 'service', error: r.error };
  }

  // 4. Note: starting the service is the user's responsibility (long-running process).
  return {
    name: svc.name,
    status: 'installed_not_started',
    kind: 'service',
    install_dir: installDir,
    start_cmd: svc.start_cmd || null,
    health_check: svc.health_check || null,
    note: 'Service installed but NOT started. Run start_cmd manually in a separate terminal, then re-run activator to verify health.',
  };
}

function installCustomNodes(nodes, dryRun) {
  if (!Array.isArray(nodes) || nodes.length === 0) return { status: 'no_custom_nodes' };
  const results = [];
  for (const node of nodes) {
    const dst = path.join(expandPath(node.install_to || '~/comfyui/custom_nodes'), node.name || path.basename(node.repo, '.git'));
    if (fs.existsSync(dst)) {
      results.push({ name: node.name, status: 'already_present', kind: 'custom_node' });
      continue;
    }
    if (dryRun) {
      results.push({ name: node.name, status: 'would_clone', kind: 'custom_node', cmd: `git clone ${node.repo} ${dst}` });
      continue;
    }
    const r = runCmd(`git clone ${node.repo} ${dst}`);
    results.push({ name: node.name, status: r.ok ? 'installed' : 'clone_failed', kind: 'custom_node', error: r.ok ? null : r.error });
  }
  return { status: 'done', kind: 'custom_nodes', items: results };
}

function installModels(models, dryRun, opts = {}) {
  if (!Array.isArray(models) || models.length === 0) return { status: 'no_models' };
  const results = [];
  for (const m of models) {
    const dst = expandPath(m.install_to);
    const fileTarget = m.filename ? path.join(dst, m.filename) : dst;
    if (m.filename && fs.existsSync(fileTarget)) {
      results.push({ name: m.name, status: 'already_present', kind: 'model' });
      continue;
    }
    const sizeGb = m.size_gb || 0;
    if (sizeGb > 1 && !opts.confirmHeavyDownloads) {
      results.push({
        name: m.name,
        status: 'confirmation_required',
        kind: 'model',
        size_gb: sizeGb,
        source: m.source,
        repo: m.repo,
        install_to: dst,
        reason: `Large download (${sizeGb} GB). User must confirm.`,
      });
      continue;
    }
    let cmd;
    if (m.source === 'huggingface') {
      cmd = `huggingface-cli download ${m.repo} ${m.filename || ''} --local-dir ${dst}`.trim();
    } else if (m.source === 'url') {
      cmd = `curl -L -o ${fileTarget} ${m.url}`;
    } else {
      results.push({ name: m.name, status: 'unknown_source', kind: 'model', source: m.source });
      continue;
    }
    if (dryRun) {
      results.push({ name: m.name, status: 'would_download', kind: 'model', cmd });
      continue;
    }
    ensureDir(dst);
    const r = runCmd(cmd, { timeoutMs: 7200000 });
    results.push({ name: m.name, status: r.ok ? 'downloaded' : 'download_failed', kind: 'model', error: r.ok ? null : r.error });
  }
  return { status: 'done', kind: 'models', items: results };
}

function checkEnvVars(vars) {
  // Accept an array of {name,required,description}/strings, OR the
  // {required:[...], optional:[...]} shape that some squads use.
  let list = [];
  if (Array.isArray(vars)) {
    list = vars;
  } else if (vars && typeof vars === 'object') {
    for (const v of (vars.required || [])) list.push(typeof v === 'string' ? { name: v, required: true } : { ...v, required: true });
    for (const v of (vars.optional || [])) list.push(typeof v === 'string' ? { name: v, required: false } : { ...v, required: false });
  }
  if (list.length === 0) return { status: 'no_env_vars' };
  const results = [];
  for (const v of list) {
    const name = typeof v === 'string' ? v : v.name;
    const required = typeof v === 'object' ? !!v.required : false;
    const present = !!process.env[name];
    results.push({
      name,
      status: present ? 'set' : (required ? 'missing_required' : 'missing_optional'),
      description: (typeof v === 'object' ? v.description : null) || null,
    });
  }
  return { status: 'done', kind: 'env_vars', items: results };
}

function runPostInstall(commands, dryRun) {
  if (!Array.isArray(commands) || commands.length === 0) return { status: 'no_post_install' };
  const results = [];
  for (const cmd of commands) {
    if (dryRun) { results.push({ cmd, status: 'would_run' }); continue; }
    const r = runCmd(cmd, { timeoutMs: 120000 });
    results.push({ cmd, status: r.ok ? 'ok' : 'failed', error: r.ok ? null : r.error });
  }
  return { status: 'done', kind: 'post_install', items: results };
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

function _synthesizeFromManifests(squadDir, slug) {
  // Look for standard-format manifests in the squad dir; if any are present,
  // synthesize a dependencies.yaml-equivalent object so activation can still
  // run. Cached at ~/.claude/squads-state/<slug>/synth-deps.yaml for the
  // user to inspect and optionally promote to a real sidecar.
  const synth = { schema_version: '1.0', _synthesized: true, _sources: [] };

  // package.json → node.packages
  const pkgPath = path.join(squadDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const packages = Object.entries(deps).map(([name, ver]) => `${name}@${ver}`);
      if (packages.length > 0) {
        synth.node = { manager: pkg.packageManager?.startsWith('pnpm') ? 'pnpm' : 'npm', cwd: squadDir, packages };
        synth._sources.push('package.json');
      }
    } catch (e) { /* malformed package.json — skip */ }
  }

  // pyproject.toml → python.packages (project.dependencies array)
  const pyprojectPath = path.join(squadDir, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    try {
      const raw = fs.readFileSync(pyprojectPath, 'utf8');
      // Minimal toml extraction: we just look for `dependencies = [...]` under [project]
      const m = raw.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
      if (m) {
        const packages = m[1].split(/,\s*/)
          .map(s => s.replace(/^[\s"']+|[\s"']+$/g, ''))
          .filter(s => s.length > 0 && !s.startsWith('#'));
        if (packages.length > 0) {
          synth.python = { manager: 'uv', target_dir: squadDir, packages };
          synth._sources.push('pyproject.toml');
        }
      }
    } catch (e) { /* skip */ }
  }

  // requirements.txt → python.packages (line-delimited, ignore comments)
  const reqPath = path.join(squadDir, 'requirements.txt');
  if (fs.existsSync(reqPath) && !synth.python) {
    try {
      const packages = fs.readFileSync(reqPath, 'utf8')
        .split('\n')
        .map(l => l.replace(/#.*$/, '').trim())
        .filter(l => l.length > 0);
      if (packages.length > 0) {
        synth.python = { manager: 'pip', target_dir: squadDir, packages };
        synth._sources.push('requirements.txt');
      }
    } catch (e) { /* skip */ }
  }

  // Dockerfile / docker-compose → confirmation_required marker
  const dockerfile = path.join(squadDir, 'Dockerfile');
  const compose = ['docker-compose.yaml', 'docker-compose.yml', 'compose.yaml']
    .map(n => path.join(squadDir, n)).find(p => fs.existsSync(p));
  if (compose) {
    synth.services = synth.services || [];
    synth.services.push({
      name: 'docker-compose-stack',
      install_cmd: `cd ${squadDir} && docker compose pull`,
      start_cmd: `cd ${squadDir} && docker compose up -d`,
      health_check: `cd ${squadDir} && docker compose ps`,
      _confirmation_required: true,
    });
    synth._sources.push(path.basename(compose));
  } else if (fs.existsSync(dockerfile)) {
    synth._sources.push('Dockerfile');
    // We don't auto-build — just flag as note
    synth._dockerfile_present = true;
  }

  if (synth._sources.length === 0) return null;

  // Cache for user inspection
  const stateDir = path.join(STATE_DIR, slug);
  ensureDir(stateDir);
  const cachePath = path.join(stateDir, 'synth-deps.yaml');
  if (YAML) {
    try { fs.writeFileSync(cachePath, YAML.stringify(synth, { lineWidth: 0 }), 'utf8'); } catch { /* skip cache */ }
  }
  synth._cached_at = cachePath;
  return synth;
}

function activate(slug, opts = {}) {
  const squadDir = RESOLVED_SQUAD_PATH || path.join(SQUADS_DIR, slug);
  const depsPath = path.join(squadDir, 'dependencies.yaml');

  if (!fs.existsSync(squadDir)) {
    return { ok: false, slug, error: `squad not found: ${squadDir}` };
  }

  let deps = readYaml(depsPath);
  let synthesized = false;
  if (!deps) {
    deps = _synthesizeFromManifests(squadDir, slug);
    synthesized = !!deps;
  }
  if (!deps) {
    const result = {
      ok: true, slug,
      status: 'no_dependencies_declared',
      message: `No dependencies.yaml at ${depsPath} and no package.json / pyproject.toml / requirements.txt to synthesize from. Squad assumed self-contained.`,
      squad_dir: squadDir,
      activated_at: new Date().toISOString(),
    };
    // Persist state so callers (glance, `status`, audits) see this squad as
    // activated even though there were no deps to install.
    try {
      const stateDir = path.join(STATE_DIR, slug);
      ensureDir(stateDir);
      fs.writeFileSync(path.join(stateDir, 'activated.json'), JSON.stringify(result, null, 2), 'utf8');
    } catch { /* state persist best-effort */ }
    return result;
  }

  const dryRun = !!opts.dryRun;
  const confirmHeavyDownloads = !!opts.confirmHeavyDownloads;

  const log = {
    slug,
    started_at: new Date().toISOString(),
    dry_run: dryRun,
    platform: PLATFORM,
    schema_version: deps.schema_version || '1.0',
    synthesized,
    synth_sources: deps._sources || null,
    synth_cached_at: deps._cached_at || null,
    steps: {},
  };

  // System tools
  if (Array.isArray(deps.system)) {
    log.steps.system = deps.system.map(d => installSystem(d, dryRun));
  }

  // Python deps
  if (deps.python) {
    log.steps.python = installPython(deps.python, dryRun);
  }

  // Node deps
  if (deps.node) {
    log.steps.node = installNode(deps.node, dryRun, squadDir);
  }

  // Sub-app deps (dashboard/, scripts/, … with their own package.json) — a squad
  // is only "ready" if its sub-projects can run too, not just the root.
  const subapps = installSubApps(squadDir, dryRun);
  if (subapps.length) log.steps.subapps = subapps;

  // Services (Pixelle, ComfyUI, Ollama, etc.)
  if (Array.isArray(deps.services)) {
    log.steps.services = deps.services.map(s => installService(s, dryRun));
  }

  // ComfyUI custom nodes
  if (deps.custom_nodes) {
    log.steps.custom_nodes = installCustomNodes(deps.custom_nodes, dryRun);
  }

  // Model downloads (HuggingFace etc.)
  if (deps.models) {
    log.steps.models = installModels(deps.models, dryRun, { confirmHeavyDownloads });
  }

  // Env vars (check only — never write)
  if (deps.env_vars) {
    log.steps.env_vars = checkEnvVars(deps.env_vars);
  }

  // Post-install hooks
  if (deps.post_install) {
    log.steps.post_install = runPostInstall(deps.post_install, dryRun);
  }

  // Roll-up
  const failures = [];
  const confirmations = [];
  const warnings = [];
  for (const stepName of Object.keys(log.steps)) {
    const step = log.steps[stepName];
    const items = Array.isArray(step) ? step : (step.items || [step]);
    for (const item of items) {
      if (!item || !item.status) continue;
      if (/_failed$/.test(item.status)) failures.push({ step: stepName, ...item });
      else if (item.status === 'confirmation_required') confirmations.push({ step: stepName, ...item });
      // Missing API keys / system prereqs do NOT block activation — the squad
      // installs its code deps and runs in degraded mode until the user supplies
      // them. Surfaced as warnings so the caller can prompt the user.
      else if (item.status === 'missing_required' || item.status === 'missing_system_tool') warnings.push({ step: stepName, ...item });
    }
  }

  log.ok = failures.length === 0 && confirmations.length === 0;
  log.failures = failures;
  log.confirmations_required = confirmations;
  log.warnings = warnings;
  log.completed_at = new Date().toISOString();

  if (!dryRun && log.ok) {
    saveState(slug, {
      slug,
      activated_at: log.completed_at,
      deps_hash: JSON.stringify(deps).length,  // simple change-detection
      schema_version: log.schema_version,
    });
  }

  return log;
}

function status(slug) {
  const state = loadState(slug);
  const depsPath = path.join(RESOLVED_SQUAD_PATH || path.join(SQUADS_DIR, slug), 'dependencies.yaml');
  const hasDeps = fs.existsSync(depsPath);
  return {
    slug,
    has_dependencies_yaml: hasDeps,
    activated: !!state,
    state: state || null,
  };
}

function deactivate(slug) {
  const p = getStatePath(slug);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return { ok: true, slug, deactivated_at: new Date().toISOString() };
}

module.exports = { activate, status, deactivate };

// CLI — exit codes follow the contract documented in scripts/activate-squad.sh:
//   0 = ok / activated
//   1 = failures present (one or more steps reported _failed)
//   2 = confirmations required (heavy downloads / sudo)
//   4 = invalid args / squad not found
if (require.main === module) {
  const cmd = process.argv[2];
  const slug = process.argv[3];
  const flags = process.argv.slice(4);
  const opts = {
    dryRun: flags.includes('--dry-run'),
    confirmHeavyDownloads: flags.includes('--confirm-heavy'),
    verbose: flags.includes('--verbose') || flags.includes('-v'),
  };

  if (cmd === 'activate' && slug) {
    // --verbose hint propagates to install helpers via env so they keep stdio: 'inherit'
    if (opts.verbose) process.env.MAESTRO_ACTIVATOR_VERBOSE = '1';

    const result = activate(slug, opts);
    console.log(JSON.stringify(result, null, 2));

    // Exit-code contract
    if (result.ok === false && result.error) {
      // Squad not found etc.
      process.exit(4);
    }
    const failures = (result.failures || []).length;
    const confirmations = (result.confirmations_required || []).length;
    if (failures > 0) process.exit(1);
    if (confirmations > 0) process.exit(2);
    process.exit(0);
  }

  if (cmd === 'status' && slug) {
    console.log(JSON.stringify(status(slug), null, 2));
    process.exit(0);
  }

  if (cmd === 'deactivate' && slug) {
    console.log(JSON.stringify(deactivate(slug), null, 2));
    process.exit(0);
  }

  console.error('usage: activator.js {activate|status|deactivate} <slug> [--dry-run] [--confirm-heavy] [--verbose|-v]');
  process.exit(4);
}
