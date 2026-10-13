/**
 * squad-env.ts — one environment per squad, prepared when the squad is about
 * to run.
 *
 * Every squad used to install into ONE shared store (`~/.nirvana/node_modules`)
 * and ONE shared venv (`~/.nirvana/python/venv`). A shared folder holds one
 * version per package, so squads that pin different versions collided: the
 * store's presence check looked at the package NAME only, and a squad declaring
 * zod@^3 ran on the zod 4.4.3 another squad had installed; in Python the last
 * squad activated won, pip upgrading or downgrading in place.
 *
 * So each squad gets `~/.nirvana/envs/<slug>`:
 *   package.json + bun.lock + node_modules   what it declares, versions as written
 *   subapps/<dir>/…                          the same, per sub-app with its own package.json
 *   .venv                                    its own Python
 *   .env-state.json                          hashes of the declared specs + outcome
 *
 * The worker reaches the environment through variables set on its run only
 * (squadRunEnv): NODE_PATH, which Bun honours for `import` and `require` and
 * Node for `require`; a resolve hook in NODE_OPTIONS for Node's ESM loader,
 * which ignores NODE_PATH (node-path-hook.mjs); and PATH, with an `npx` shim
 * (npx-shim.ts), the packages' CLIs and the venv's interpreter first.
 *
 * The squad folder gets ONE thing, as a reinforcement nothing depends on:
 * `<squad>/node_modules` (and each sub-app's) linked to the environment, for a
 * tool that resolves on its own and ignores NODE_PATH. Made only when it is
 * missing or points somewhere stale, never over a real folder, and silently
 * skipped wherever the folder cannot be written (reinforceLinks). No venv, no
 * `.gitignore` edit: a git work tree gets `node_modules` in its untracked
 * `.git/info/exclude` instead.
 *
 * What it costs, measured 2026-10 on macOS (bun 1.4.0, uv 0.9.27): Bun clones
 * from its global cache (hardlinks on Linux), so five copies of a 55 MB
 * node_modules took 1.5 MB of real disk; sharp + @remotion/renderer installed
 * in 1.8 s cold and 31 ms warm. uv links from its cache too: three 100 MB venvs
 * took 4.7 MB, about 0.1 s each from a warm cache.
 *
 * Bun's auto-install is NOT used for squads: it ignores package.json versions
 * (always latest), and a version inside an import specifier crashed Bun.
 *
 * The hot path is every dispatch: when the hashes match the last successful
 * outcome, ensureSquadEnv returns after a few file reads, spawning nothing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { depsEnv, depsStore, dirLink, nirvanaHome, venvPython } from "./deps-home.ts";
import { SHIM_DIR } from "./npx-shim.ts";
import { withLock } from "./file-lock.ts";

const STATE_FILE = ".env-state.json";
const STATE_VERSION = 1;
/** An install can take minutes (torch, a browser download); a second dispatch
 *  of the same squad waits for it instead of installing over it. */
const LOCK_MS = 30 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const NODE_HOOK = path.join(import.meta.dir, "node-path-hook.mjs");
const NPX_SHIM = path.join(import.meta.dir, "npx-shim.ts");

/** `~/.nirvana/envs` — every squad's environment lives under it. */
export function envsRoot(): string {
  return path.join(nirvanaHome(), "envs");
}

/** `~/.nirvana/envs/<slug>`. */
export function squadEnvDir(slug: string): string {
  return path.join(envsRoot(), slug);
}

/** The squad's venv, `<env>/.venv`. */
export function squadVenvDir(slug: string): string {
  return path.join(squadEnvDir(slug), ".venv");
}

/** The squad's Python when its venv exists, null otherwise. A file check only. */
export function squadPythonBin(slug: string): string | null {
  const bin = venvPython(squadVenvDir(slug));
  return fs.existsSync(bin) ? bin : null;
}

/** Every node_modules the squad's environment holds: the root first, then its sub-apps'. */
export function squadNodeModules(slug: string): string[] {
  const dir = squadEnvDir(slug);
  const out = [path.join(dir, "node_modules")];
  try {
    for (const e of fs.readdirSync(path.join(dir, "subapps"), { withFileTypes: true })) {
      if (e.isDirectory()) out.push(path.join(dir, "subapps", e.name, "node_modules"));
    }
  } catch { /* no sub-apps */ }
  return out.filter((d) => fs.existsSync(d));
}

/** The one line a worker needs to run the squad's Python. */
export function pythonLine(bin: string): string {
  return `This squad's Python: \`${bin}\`; run its Python scripts and \`-m pip\` with it, never \`pip install\` into another interpreter.`;
}

/** The one line a worker needs to reach the squad's Node packages. */
export function nodeLine(modules: string): string {
  return `This squad's Node packages: \`${modules}\`, on NODE_PATH with their CLIs on PATH (\`npx <bin>\` runs them too); never install into the squad folder.`;
}

/** The `.shim` folder of a squad's environment, put first on the worker's PATH. */
export function squadShimDir(slug: string): string {
  return path.join(squadEnvDir(slug), SHIM_DIR);
}

/**
 * The two npx shims, as text: a POSIX sh script and a Windows `.cmd`, both
 * running npx-shim.ts with the bun that prepared the environment, or the `bun`
 * on PATH when that one is gone. Pure, for the test that cannot run a `.cmd`.
 */
export function npxShimFiles(bun: string, shimTs: string): { posix: string; cmd: string } {
  const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return {
    posix: [
      "#!/bin/sh",
      "# Nirvana squad environment: npx that runs the environment's own binaries (npx-shim.ts).",
      `B=${sq(bun)}`,
      '[ -x "$B" ] || B=bun',
      `exec "$B" ${sq(shimTs)} "$@"`,
      "",
    ].join("\n"),
    cmd: [
      "@echo off",
      "rem Nirvana squad environment: npx that runs the environment's own binaries (npx-shim.ts).",
      `set "NRV_BUN=${bun}"`,
      'if not exist "%NRV_BUN%" set "NRV_BUN=bun"',
      `"%NRV_BUN%" "${shimTs}" %*`,
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n"),
  };
}

/** Write the shims into the environment when absent or stale; best-effort. */
function writeShims(slug: string): void {
  try {
    const dir = squadShimDir(slug);
    const files = npxShimFiles(process.execPath, NPX_SHIM);
    writeIfChanged(path.join(dir, "npx"), files.posix);
    try { fs.chmodSync(path.join(dir, "npx"), 0o755); } catch { /* Windows: the .cmd is the one used */ }
    writeIfChanged(path.join(dir, "npx.cmd"), files.cmd);
  } catch { /* without a shim, npx is the machine's own: degraded, never broken */ }
}

/**
 * The lines a worker prompt or a squad card carries about the environment: the
 * Python line when the squad has a venv, the Node line when it has packages,
 * and one line per problem the caller passes (a failed install the worker
 * should know about). Empty otherwise, so a squad without an environment keeps
 * its prompt byte for byte.
 */
export function squadEnvLines(slug: string, problems: string[] = []): string[] {
  const lines: string[] = [];
  const bin = squadPythonBin(slug);
  if (bin) lines.push(pythonLine(bin));
  const modules = squadNodeModules(slug);
  if (modules.length) lines.push(nodeLine(modules[0]));
  for (const p of problems) lines.push(`Environment problem: ${p}`);
  return lines;
}

/**
 * The variables a worker that uses these squads runs with: NODE_PATH and the
 * ESM hook for their packages, PATH with their CLIs and the first squad's
 * venv first, VIRTUAL_ENV for tools that look for it. Prepended to what
 * `base` already has, never replacing it. Empty when no squad has an
 * environment. With several squads a name resolves to the first squad that
 * has it: one process has one NODE_PATH. Each card still names its own squad's
 * paths.
 */
export function squadRunEnv(slugs: string[], base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const modules: string[] = [];
  const bins: string[] = [];
  let venv: string | null = null;
  const shims: string[] = [];
  for (const slug of [...new Set(slugs)]) {
    const python = squadPythonBin(slug);
    if (python && !venv) { venv = squadVenvDir(slug); bins.push(path.dirname(python)); }
    const own = squadNodeModules(slug);
    for (const m of own) { modules.push(m); bins.push(path.join(m, ".bin")); }
    if (own.length && fs.existsSync(squadShimDir(slug))) shims.push(squadShimDir(slug));
  }
  if (!modules.length && !venv) return {};
  const join = (head: string[], tail: string | undefined) => [...head, ...(tail ? [tail] : [])].join(path.delimiter);
  // Windows spells it `Path`; a second key in another case would be a second variable.
  const pathKey = Object.keys(base).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  // The shims first: `npx` must be found before the machine's own.
  const env: Record<string, string> = { [pathKey]: join([...shims, ...bins], base[pathKey]) };
  if (venv) env.VIRTUAL_ENV = venv;
  if (modules.length) {
    env.NODE_PATH = join(modules, base.NODE_PATH);
    // A file URL: a Windows path would read as a `c:` URL scheme, and a space
    // would split NODE_OPTIONS in two.
    const hook = `--import=${pathToFileURL(NODE_HOOK).href}`;
    const prior = base.NODE_OPTIONS ?? "";
    env.NODE_OPTIONS = prior.includes(hook) ? prior : `${prior} ${hook}`.trim();
  }
  return env;
}

export interface SquadEnvResult {
  /** No install failed. */
  ok: boolean;
  problems: string[];
  /** null when the squad declares no local Node packages. `installed`: an install ran in this call. */
  node: { installed: boolean; packages: string[]; error?: string } | null;
  /** One entry per sub-app with a readable package.json that declares something. */
  subapps: Array<{ name: string; installed: boolean; error?: string }>;
  /** null when the squad declares no Python packages. `bin` is null when the venv could not be made. */
  python: { bin: string | null; installed: boolean; packages: string[]; error?: string; unavailable?: boolean } | null;
  durationMs: number;
  /** Nothing was spawned: the state file answered, or there was nothing to install. */
  cached: boolean;
  dir: string;
}

type Declared = {
  node: Record<string, string> | null;
  nodeTokens: string[];
  subapps: Array<{ name: string; deps: Record<string, string> }>;
  python: string[] | null;
  problems: string[];
};

interface EnvState {
  version: number;
  node_hash: string | null;
  python_hash: string | null;
  ok: boolean;
  problems: string[];
  updated_at: string;
}

/** The activator, loaded on first use: it loads this file back for the env install. */
let activatorMemo: any = null;
function activator(): any {
  if (!activatorMemo) activatorMemo = createRequire(import.meta.url)(path.resolve(import.meta.dir, "..", "..", "squads", "lib", "activator.js"));
  return activatorMemo;
}

/**
 * An npm token as the activator writes it (`zod@^3`, `@remotion/cli@4.0.0`,
 * `sharp`) split into a package.json entry. The version is kept exactly as
 * declared; a bare name asks for `latest`, which the lockfile then pins.
 */
export function splitNodeToken(token: string): [string, string] {
  const at = token.indexOf("@", token.startsWith("@") ? 1 : 0);
  if (at <= 0) return [token, "latest"];
  return [token.slice(0, at), token.slice(at + 1) || "latest"];
}

/** A `file:`/`link:` spec relative to the manifest that declared it, made
 *  absolute: the manifest is rewritten inside the environment, elsewhere. */
function anchored(spec: string, from: string): string {
  const m = /^(file|link):(.+)$/.exec(spec);
  return m && !path.isAbsolute(m[2]) ? `${m[1]}:${path.resolve(from, m[2])}` : spec;
}

const anchoredAll = (deps: Record<string, string>, from: string): Record<string, string> =>
  Object.fromEntries(Object.entries(deps).map(([n, v]) => [n, anchored(String(v), from)]));

/** What the squad declares, parsed by the activator (dependencies.yaml, or package.json / pyproject / requirements). */
function declared(squadDir: string): Declared {
  const A = activator();
  const deps = A.declaredDeps(squadDir) || {};
  let node: Record<string, string> | null = null;
  let nodeTokens: string[] = [];
  const n = deps.node ? A.normalizeDepSpec(deps.node, "npm") : null;
  // A global install is a command on the machine's PATH, not a package of the
  // squad: the activator keeps that carve-out, the environment never sees it.
  if (n && !n.global) {
    nodeTokens = n.raw.map((x: unknown) => A.depToToken(x, "npm")).filter(Boolean);
    if (nodeTokens.length) node = anchoredAll(Object.fromEntries(nodeTokens.map(splitNodeToken)), squadDir);
  }
  let python: string[] | null = null;
  const p = deps.python ? A.normalizeDepSpec(deps.python, "pip") : null;
  if (p) {
    const tokens = p.raw.map((x: unknown) => A.depToToken(x, "pip")).filter(Boolean);
    if (tokens.length) python = tokens;
  }
  const subapps: Declared["subapps"] = [];
  const problems: string[] = [];
  for (const s of A.subAppManifests(squadDir) as Array<{ name: string; deps: Record<string, string> | null }>) {
    if (s.deps === null) problems.push(`sub-app ${s.name}/ has an unreadable package.json; nothing installed for it`);
    else if (Object.keys(s.deps).length) subapps.push({ name: s.name, deps: anchoredAll(s.deps, path.join(squadDir, s.name)) });
  }
  return { node, nodeTokens, subapps, python, problems };
}

const hashOf = (v: unknown): string | null =>
  v == null ? null : createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

function readState(dir: string): EnvState | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), "utf8"));
    return s && s.version === STATE_VERSION ? s : null;
  } catch { return null; }
}

function writeIfChanged(file: string, text: string): void {
  try { if (fs.readFileSync(file, "utf8") === text) return; } catch { /* absent */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

/**
 * Every declared package present in the environment AT A VERSION ITS RANGE
 * accepts. The name alone is not enough: that is the check that let a squad
 * declaring zod@^3 run on zod 4. A spec that is not a semver range (`latest`,
 * `file:`, `npm:`, a git URL) can only be checked by presence.
 */
function nodeSatisfied(modules: string, deps: Record<string, string>): boolean {
  return Object.entries(deps).every(([name, spec]) => {
    let version: string;
    try { version = JSON.parse(fs.readFileSync(path.join(modules, name, "package.json"), "utf8")).version; }
    catch { return false; }
    if (spec === "latest" || spec.includes(":")) return true;
    try { return Bun.semver.satisfies(version, spec); } catch { return true; }
  });
}

/** `bun install` of `deps` in `dir`; the error line, or null when it is in place. */
function installNode(dir: string, deps: Record<string, string>, name: string, bun: string): string | null {
  writeIfChanged(path.join(dir, "package.json"),
    JSON.stringify({ name, private: true, dependencies: deps }, null, 2) + "\n");
  // argv, never a shell line, as deps-home's install does: a version string is data.
  const r = spawnSync(bun, ["install"], { cwd: dir, windowsHide: true, encoding: "utf8", env: depsEnv(), timeout: INSTALL_TIMEOUT_MS });
  if (r.status === 0) return null;
  // A failing post-install (puppeteer that could not fetch its browser) exits
  // non-zero after every package resolved; when bun did run, the tree decides.
  if (!r.error && nodeSatisfied(path.join(dir, "node_modules"), deps)) return null;
  const detail = (r.stderr || r.stdout || r.error?.message || "bun install failed").trim().split(/\r?\n/).slice(-1)[0].slice(0, 300);
  return `bun install failed: ${detail}`;
}

/** A link the engine may replace: it points at a legacy shared store or at an
 *  environment, of this machine or of another one whose folder synced here. */
export function staleEngineLink(raw: string, resolved: string): boolean {
  let store = path.resolve(depsStore());
  try { store = fs.realpathSync(store); } catch { /* no store on this machine */ }
  return resolved === store || /[\\/]\.nirvana[\\/](envs[\\/]|node_modules[\\/]?$)/.test(raw);
}

/**
 * `<dir>/node_modules` → `target`, when it is missing, broken or a stale
 * engine link; a reinforcement for tools that ignore NODE_PATH, which nothing
 * depends on. A real folder or file there is the author's and is left alone,
 * and so is a link to anywhere else. When the link is right this is two reads.
 * Any error (a read-only folder, EPERM, EACCES, EROFS) is swallowed: no log
 * line, no problem, nothing stops. Returns true when a link was made.
 */
export function reinforceLink(dir: string, target: string): boolean {
  const link = path.join(dir, "node_modules");
  try {
    if (!fs.existsSync(target)) return false;   // nothing to point at: leave whatever is there
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(link); } catch { /* absent */ }
    if (st) {
      if (!st.isSymbolicLink()) return false;   // a real folder or file: the author's
      let resolved: string | null = null;
      try { resolved = fs.realpathSync(link); } catch { /* broken */ }
      if (resolved !== null && resolved === fs.realpathSync(target)) return false;
      if (resolved !== null && !staleEngineLink(fs.readlinkSync(link), resolved)) return false;
      fs.unlinkSync(link);
    }
    dirLink(target, link);
    return true;
  } catch { return false; }
}

/**
 * The `.git/info/exclude` of the work tree `dir` sits in, found by walking up
 * for `.git` (a folder, or a file with `gitdir:`; a linked worktree's
 * `commondir` leads to the shared one). Null when there is none, or anything
 * about it is unusual.
 */
export function gitExcludeFile(dir: string): string | null {
  try {
    for (let d = path.resolve(dir); ; d = path.dirname(d)) {
      const dotGit = path.join(d, ".git");
      let st: fs.Stats | null = null;
      try { st = fs.statSync(dotGit); } catch { /* keep walking */ }
      if (st) {
        let gitDir = dotGit;
        if (st.isFile()) {
          const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"));
          if (!m) return null;
          gitDir = path.resolve(d, m[1]);
          try { gitDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim()); } catch { /* not a linked worktree */ }
        }
        return fs.statSync(gitDir).isDirectory() ? path.join(gitDir, "info", "exclude") : null;
      }
      if (path.dirname(d) === d) return null;
    }
  } catch { return null; }
}

/**
 * Keep the link out of git without touching the squad's `.gitignore`: one
 * `node_modules` line in the repository's untracked `info/exclude`, added once.
 * `node_modules/` would not do: with the slash git matches folders only, and a
 * link is not one. Silent on every failure.
 */
function excludeInGit(dir: string): void {
  try {
    const file = gitExcludeFile(dir);
    if (!file) return;
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (/^(\*\*\/)?\/?node_modules\s*$/m.test(text)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}node_modules\n`, "utf8");
  } catch { /* best effort */ }
}

/** The squad's links and shims, after an ensure: best-effort, never a problem line. */
function reinforce(slug: string, squadDir: string, r: SquadEnvResult): void {
  const root = path.join(r.dir, "node_modules");
  if (!r.node && !r.subapps.length) return;
  if (fs.existsSync(root)) writeShims(slug);
  let made = r.node ? reinforceLink(squadDir, root) : false;
  for (const sub of r.subapps) made = reinforceLink(path.join(squadDir, sub.name), path.join(r.dir, "subapps", sub.name, "node_modules")) || made;
  if (made) excludeInGit(squadDir);
}

/**
 * Prepare a squad's environment, installing only what changed, then reinforce
 * the squad's node_modules links (reinforceLink). Never throws: every failure
 * becomes a line in `problems`.
 */
export function ensureSquadEnv(slug: string, squadDir: string, opts: { log?: (line: string) => void; bun?: string } = {}): SquadEnvResult {
  const r = prepareEnv(slug, squadDir, opts);
  reinforce(slug, squadDir, r);
  return r;
}

function prepareEnv(slug: string, squadDir: string, opts: { log?: (line: string) => void; bun?: string }): SquadEnvResult {
  const t0 = Date.now();
  const dir = squadEnvDir(slug);
  const result = (r: Omit<SquadEnvResult, "durationMs" | "dir">): SquadEnvResult => ({ ...r, durationMs: Date.now() - t0, dir });
  let want: Declared;
  try { want = declared(squadDir); }
  catch (e) { return result({ ok: false, problems: [`could not read the squad's dependencies: ${(e as Error).message}`], node: null, subapps: [], python: null, cached: false }); }

  const nodeHash = want.node || want.subapps.length ? hashOf({ root: want.node, subapps: want.subapps }) : null;
  const pythonHash = hashOf(want.python);
  const rootModules = path.join(dir, "node_modules");
  const subDir = (name: string) => path.join(dir, "subapps", name);
  const nodeInPlace = () => (!want.node || fs.existsSync(rootModules))
    && want.subapps.every((s) => fs.existsSync(path.join(subDir(s.name), "node_modules")));
  const venvBin = venvPython(squadVenvDir(slug));

  // ── hot path: same specs, last outcome ok, artifacts in place ──
  const hot = (): SquadEnvResult | null => {
    const s = readState(dir);
    if (!s || !s.ok || s.node_hash !== nodeHash || s.python_hash !== pythonHash) return null;
    if (!nodeInPlace()) return null;
    if (want.python && !fs.existsSync(venvBin)) return null;
    return result({
      ok: true, problems: s.problems, cached: true,
      node: want.node ? { installed: false, packages: want.nodeTokens } : null,
      subapps: want.subapps.map((x) => ({ name: x.name, installed: false })),
      python: want.python ? { bin: venvBin, installed: false, packages: want.python } : null,
    });
  };
  const fast = hot();
  if (fast) return fast;
  if (!want.node && !want.subapps.length && !want.python) {
    return result({ ok: true, problems: want.problems, node: null, subapps: [], python: null, cached: true });
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    return withLock(path.join(dir, ".ensure"), () => {
      // Another process may have finished the same install while this one waited.
      const again = hot();
      if (again) return again;
      const problems: string[] = [...want.problems];
      let failed = false;
      const prev = readState(dir);
      const bun = opts.bun || process.env.NIRVANA_BUN || "bun";
      const nodeChanged = !prev?.ok || prev.node_hash !== nodeHash || !nodeInPlace();

      let node: SquadEnvResult["node"] = null;
      if (want.node) {
        let error: string | null = null;
        if (nodeChanged) {
          opts.log?.(`env ${slug}: installing ${want.nodeTokens.length} node package(s)…`);
          error = installNode(dir, want.node, `squad-env-${slug}`, bun);
        }
        if (error) { failed = true; problems.push(error); }
        node = { installed: nodeChanged && !error, packages: want.nodeTokens, ...(error ? { error } : {}) };
      }

      const subapps: SquadEnvResult["subapps"] = [];
      for (const s of want.subapps) {
        let error: string | null = null;
        if (nodeChanged) {
          opts.log?.(`env ${slug}: installing sub-app ${s.name}/…`);
          error = installNode(subDir(s.name), s.deps, `squad-env-${slug}-${s.name}`, bun);
        }
        if (error) { failed = true; problems.push(`sub-app ${s.name}/: ${error}`); }
        subapps.push({ name: s.name, installed: nodeChanged && !error, ...(error ? { error } : {}) });
      }

      let python: SquadEnvResult["python"] = null;
      if (want.python) {
        const changed = !prev?.ok || prev.python_hash !== pythonHash || !fs.existsSync(venvBin);
        if (!changed) python = { bin: venvBin, installed: false, packages: want.python };
        else {
          opts.log?.(`env ${slug}: installing ${want.python.length} python package(s)…`);
          const r = activator().installPythonEnv(squadVenvDir(slug), want.python);
          if (r.ok) python = { bin: r.python, installed: true, packages: want.python };
          else {
            failed = true;
            const error = `python: ${r.error}${r.hint ? ` (${r.hint})` : ""}`;
            problems.push(error);
            python = { bin: null, installed: false, packages: want.python, error, ...(r.unavailable ? { unavailable: true } : {}) };
          }
        }
      }

      const state: EnvState = {
        version: STATE_VERSION, node_hash: nodeHash, python_hash: pythonHash,
        ok: !failed, problems, updated_at: new Date().toISOString(),
      };
      try { fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2) + "\n", "utf8"); } catch { /* the next call simply re-checks */ }
      return result({ ok: !failed, problems, node, subapps, python, cached: false });
    }, { timeoutMs: LOCK_MS, staleMs: LOCK_MS });
  } catch (e) {
    return result({ ok: false, problems: [`environment not prepared: ${(e as Error).message}`], node: null, subapps: [], python: null, cached: false });
  }
}

/**
 * Prepare the environments of the squads a dispatch is about to run, one
 * after the other, and print one line per squad only when something was
 * installed or went wrong. Returns, per squad, the failures its worker should
 * be told about; a squad that is ready maps to nothing. Never stops the
 * dispatch: a failure is reported and the work goes on.
 */
export function prepareSquadEnvs(
  squads: Array<{ slug: string; dir: string }>,
  opts: { ensure?: typeof ensureSquadEnv; print?: (line: string) => void } = {},
): Map<string, string[]> {
  const ensure = opts.ensure ?? ensureSquadEnv;
  const print = opts.print ?? ((line: string) => console.log(line));
  const notes = new Map<string, string[]>();
  for (const { slug, dir } of squads) {
    if (!fs.existsSync(dir)) continue;
    const r = ensure(slug, dir);
    if (!r.ok) notes.set(slug, r.problems);
    if (r.cached) continue;
    const ready = [r.node?.installed || r.subapps.some((s) => s.installed) ? "node" : null, r.python?.installed ? "python" : null].filter(Boolean);
    if (ready.length) print(`  env ${slug}: ${ready.join(" + ")} ready (${(r.durationMs / 1000).toFixed(1)} s)`);
    for (const p of r.problems) print(`  ⚠ env ${slug}: ${p}`);
  }
  return notes;
}
