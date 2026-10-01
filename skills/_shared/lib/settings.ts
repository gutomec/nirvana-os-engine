/**
 * settings.ts — the one resolution path for the engine's operational settings
 * (settings-schema.ts), with one precedence everywhere:
 *
 *   environment variable
 *   > <project>/.nirvana/config.yaml          (project layer)
 *   > <NIRVANA_HOME|~>/.nirvana/config.yaml   (global layer, the user's; survives updates)
 *   > skills/harness/config.yaml              (engine-default layer; overwritten by every update)
 *   > the schema default
 *
 * Every reader of a switch goes through resolveSetting / resolveAllSettings;
 * the harness-config adapter, routing-mode, budget, the spawners, `nrv config`,
 * `nrv doctor` and the Glance panel are consumers of this module, never a
 * second resolver beside it.
 *
 * Files: read with the `yaml` package, cached per process by path + mtime +
 * size, invalidated on every write. Malformed YAML and invalid values are
 * errors that name the file (or the variable) and the key: a setting the user
 * wrote and the engine silently ignored is the failure this module exists to
 * end. Unknown keys in a file are tolerated (`locale` lives in the project
 * file, read by locale-resolver.ts), and a key outside its allowed scopes is
 * skipped in that layer.
 *
 * Writes edit one `section.name` line at a time, keeping every other byte of
 * the file (comments included), and land atomically (temp file + rename).
 *
 * Project discovery: NIRVANA_PROJECT_ROOT, else the nearest ancestor of the
 * cwd holding a declared project (`.nirvana/project.yaml`). HOME itself never
 * counts: its `.nirvana/` is the global store, and reading it as a project
 * would make the global file its own override.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";
import { isProjectRoot, pinnedProjectRoot } from "./project-root.js";
import { profileValue } from "./profiles.ts";
import {
  coerceText, getSettingSpec, SETTINGS_SCHEMA, validateSettingValue,
  type SettingKey, type SettingScope, type SettingSpec, type SettingValue, type SettingValueOf, type SettingsEnv,
} from "./settings-schema.ts";

export { SETTINGS, SETTINGS_SCHEMA, SETTING_KEYS, getSettingSpec, settingInfo, coerceText, validateSettingValue } from "./settings-schema.ts";
export type { SettingInfo, SettingKey, SettingKind, SettingScope, SettingSpec, SettingValue, SettingValueOf, SettingsEnv } from "./settings-schema.ts";

export type SettingSource = "env" | "project" | "global" | "profile" | "engine-default" | "default";

export interface ResolvedSetting<T extends SettingValue = SettingValue> {
  key: string;
  value: T;
  source: SettingSource;
  /** The file the value came from (project, global, engine-default). */
  path?: string;
  /** The variable the value came from (env). */
  variable?: string;
  /** The variable's text (env). */
  raw?: string;
  /** The profile the value came from (profile). */
  profile?: string;
}

export interface ResolveOptions {
  /** The environment to read; default process.env. NIRVANA_HOME and NIRVANA_PROJECT_ROOT are read from it too. */
  env?: SettingsEnv;
  /** Project root; null switches the project layer off; undefined discovers it. */
  projectRoot?: string | null;
  /** Global file; null switches the layer off; undefined = <NIRVANA_HOME|~>/.nirvana/config.yaml. */
  globalPath?: string | null;
  /** Engine defaults file; null switches the layer off; undefined = skills/harness/config.yaml. */
  enginePath?: string | null;
  /** Where discovery starts; default process.cwd(). */
  cwd?: string;
}

export type SettingsErrorCode = "unknown_key" | "invalid_value" | "invalid_file" | "invalid_env" | "scope" | "pinned_by_env" | "no_project";

/** Every refusal of this module; `message` is what the user reads. */
export class SettingsError extends Error {
  constructor(public readonly code: SettingsErrorCode, message: string, public readonly detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "SettingsError";
  }
}

// ── paths ───────────────────────────────────────────────────────────────────

function homeOf(env: SettingsEnv): string {
  return env.NIRVANA_HOME || os.homedir();
}

export function globalConfigPath(env: SettingsEnv = process.env): string {
  return path.join(homeOf(env), ".nirvana", "config.yaml");
}

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".nirvana", "config.yaml");
}

function skillsRoot(env: SettingsEnv): string {
  if (env.NIRVANA_SKILLS_DIR) return env.NIRVANA_SKILLS_DIR;
  const shared = path.join(os.homedir(), ".nirvana", "skills");
  return fs.existsSync(shared) ? shared : path.join(os.homedir(), ".claude", "skills");
}

/** The engine's own config.yaml: the source tree first (this file lives in
 * _shared/lib), then the installed tree. Null on a config-less install. */
export function engineConfigPath(env: SettingsEnv = process.env): string | null {
  const candidates = [
    path.join(import.meta.dir, "..", "..", "harness", "config.yaml"),
    path.join(skillsRoot(env), "harness", "config.yaml"),
  ];
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* next */ }
  }
  return null;
}

/** One spelling per directory: the OS's own real path (expands Windows 8.3 short
 * names such as `RUNNER~1`, which `realpathSync` leaves alone), case-folded where
 * the filesystem is. */
function canonicalDir(dir: string): string {
  let resolved = path.resolve(dir);
  try {
    const native = (fs.realpathSync as unknown as { native?: (target: string) => string }).native;
    resolved = native ? native(resolved) : fs.realpathSync(resolved);
  } catch { /* keep the resolved spelling */ }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * NIRVANA_PROJECT_ROOT, else the nearest ancestor of `cwd` holding a declared
 * project (`.nirvana/project.yaml`, by project-root.js, the one definition).
 * Never HOME (under any of its names) and never the root. A bare `.nirvana/`
 * no longer counts: hooks and CLI runs created one in folders that were never
 * projects, and every one of them then had a settings layer of its own.
 */
export function discoverProjectRoot(env: SettingsEnv = process.env, cwd: string = process.cwd()): string | null {
  if (env.NIRVANA_PROJECT_ROOT) return pinnedProjectRoot(env, { home: env.HOME || env.USERPROFILE });
  const homes = new Set([env.NIRVANA_HOME, env.HOME, env.USERPROFILE, os.homedir()].filter((dir): dir is string => !!dir).map(canonicalDir));
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 40; depth++) {
    if (dir === path.parse(dir).root || homes.has(canonicalDir(dir))) return null;
    if (isProjectRoot(dir, { home: env.HOME || env.USERPROFILE })) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// ── files ───────────────────────────────────────────────────────────────────

type Mapping = Record<string, unknown>;
interface CacheEntry { mtimeMs: number; size: number; data: Mapping }
const cache = new Map<string, CacheEntry>();

/** Drops every cached file (tests). */
export function _resetSettingsCache(): void {
  cache.clear();
}

/** The parsed file, or null when it does not exist. Malformed YAML or a
 * top-level value that is not a mapping is an error naming the file. */
function readYamlFile(file: string): Mapping | null {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { cache.delete(file); return null; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.data;
  let parsed: unknown;
  try { parsed = YAML.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    throw new SettingsError("invalid_file", `${file}: invalid YAML (${(error as Error).message.split("\n")[0]})`, { path: file });
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsError("invalid_file", `${file}: the content must be a mapping (section: key: value)`, { path: file });
  }
  const data = parsed as Mapping;
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, data });
  return data;
}

interface Layer { source: "project" | "global" | "engine-default"; path: string; data: Mapping | null }

function splitKey(key: string): [string, string] {
  const dot = key.indexOf(".");
  return [key.slice(0, dot), key.slice(dot + 1)];
}

/** The raw scalar stored for `key` in a parsed file, `undefined` when absent. */
function rawFileValue(file: string, data: Mapping, key: string): unknown {
  const [section, name] = splitKey(key);
  const block = data[section];
  if (block === undefined || block === null) return undefined;
  if (typeof block !== "object" || Array.isArray(block)) {
    throw new SettingsError("invalid_file", `${file}: "${section}" must be a mapping (key: value) to hold ${key}`, { path: file, key });
  }
  const value = (block as Mapping)[name];
  return value === null ? undefined : value;
}

function layerValue(layer: Layer, spec: SettingSpec): SettingValue | undefined {
  if (!layer.data) return undefined;
  if (layer.source !== "engine-default" && !spec.scopes.includes(layer.source)) return undefined;
  const raw = rawFileValue(layer.path, layer.data, spec.key);
  if (raw === undefined) return undefined;
  const checked = validateSettingValue(spec, raw);
  if (!checked.ok) throw new SettingsError("invalid_value", `${layer.path}: ${checked.message}`, { path: layer.path, key: spec.key });
  return checked.value;
}

// ── environment ─────────────────────────────────────────────────────────────

export interface EnvReading { variable: string; raw: string; value: SettingValue }

/** The variable that sets `spec` in `env`, decoded and validated; null when none does. */
export function readSettingEnv(spec: SettingSpec, env: SettingsEnv = process.env): EnvReading | null {
  if (!spec.env) return null;
  for (const variable of [spec.env, ...(spec.envAliases ?? [])]) {
    const raw = env[variable];
    if (raw === undefined || raw.trim() === "") continue;
    const candidate = spec.fromEnv ? spec.fromEnv(raw.trim(), variable) : coerceText(spec, raw);
    if (candidate === null) continue;
    const checked = validateSettingValue(spec, candidate);
    if (!checked.ok) throw new SettingsError("invalid_env", `${variable}=${raw} is invalid for ${spec.key}; expected ${spec.expects}`, { variable, raw, key: spec.key });
    return { variable, raw, value: checked.value };
  }
  return null;
}

// ── resolution ──────────────────────────────────────────────────────────────

interface Layers { env: SettingsEnv; files: Layer[]; profile: string }

const PROFILE_KEY = "execution.profile";

function loadLayers(opts: ResolveOptions): Layers {
  const env = opts.env ?? process.env;
  const files: Layer[] = [];
  const projectRoot = opts.projectRoot === undefined ? discoverProjectRoot(env, opts.cwd) : opts.projectRoot;
  if (projectRoot) {
    const file = projectConfigPath(projectRoot);
    files.push({ source: "project", path: file, data: readYamlFile(file) });
  }
  const globalPath = opts.globalPath === undefined ? globalConfigPath(env) : opts.globalPath;
  if (globalPath) files.push({ source: "global", path: globalPath, data: readYamlFile(globalPath) });
  const enginePath = opts.enginePath === undefined ? engineConfigPath(env) : opts.enginePath;
  if (enginePath) files.push({ source: "engine-default", path: enginePath, data: readYamlFile(enginePath) });
  // The profile is resolved over the same layers, without a profile of its
  // own, before any other key reads it.
  const profile = String(resolveSpec(getSettingSpec(PROFILE_KEY)!, { env, files, profile: "none" }).value);
  return { env, files, profile };
}

/** env > project > global > profile > engine default > schema default. The
 *  profile sits below the user's own files, so a key the user set explicitly
 *  wins, and above the engine defaults, which it exists to replace. */
function resolveSpec(spec: SettingSpec, layers: Layers): ResolvedSetting {
  const fromEnv = readSettingEnv(spec, layers.env);
  if (fromEnv) return { key: spec.key, value: fromEnv.value, source: "env", variable: fromEnv.variable, raw: fromEnv.raw };
  let profileChecked = false;
  const fromProfile = (): ResolvedSetting | null => {
    profileChecked = true;
    const preset = profileValue(layers.profile, spec.key);
    if (preset === undefined) return null;
    const checked = validateSettingValue(spec, preset);
    // A preset that does not validate is an engine bug, caught by the profile tests; never a silent value.
    if (!checked.ok) throw new SettingsError("invalid_value", `profile ${layers.profile}: ${checked.message}`, { key: spec.key });
    return { key: spec.key, value: checked.value, source: "profile", profile: layers.profile };
  };
  for (const layer of layers.files) {
    if (layer.source === "engine-default" && !profileChecked) {
      const preset = fromProfile();
      if (preset) return preset;
    }
    const value = layerValue(layer, spec);
    if (value !== undefined) return { key: spec.key, value, source: layer.source, path: layer.path };
  }
  if (!profileChecked) {
    const preset = fromProfile();
    if (preset) return preset;
  }
  return { key: spec.key, value: spec.default, source: "default" };
}

export function requireSpec(key: string): SettingSpec {
  const spec = getSettingSpec(key);
  if (!spec) throw new SettingsError("unknown_key", `unknown key: ${key} (see nrv config list)`, { key });
  return spec;
}

/** The effective value of one key and where it came from. */
export function resolveSetting<K extends SettingKey>(key: K, opts?: ResolveOptions): ResolvedSetting<SettingValueOf<K>>;
export function resolveSetting(key: string, opts?: ResolveOptions): ResolvedSetting;
export function resolveSetting(key: string, opts: ResolveOptions = {}): ResolvedSetting {
  return resolveSpec(requireSpec(key), loadLayers(opts));
}

/** Every key of the schema, in schema order, resolved once over the same layers. */
export function resolveAllSettings(opts: ResolveOptions = {}): ResolvedSetting[] {
  const layers = loadLayers(opts);
  return SETTINGS_SCHEMA.map((spec) => resolveSpec(spec, layers));
}

/** `resolveAllSettings` as a key → value object, for readers that want several keys at once. */
export function resolveSettingsMap(opts: ResolveOptions = {}): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const resolved of resolveAllSettings(opts)) out[resolved.key] = resolved.value;
  return out;
}

/**
 * The effective settings as the legacy variables spell them, for a spawner to
 * pin into a child's environment: project and global values then reach a
 * child that only reads variables, and a child that resolves for itself
 * finds the variable first and agrees with its parent. A value the variable
 * cannot spell (an empty string, `updates.check: true`) is left unset.
 */
export function settingsEnvForChild(opts: ResolveOptions = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const resolved of resolveAllSettings(opts)) {
    const spec = getSettingSpec(resolved.key)!;
    if (!spec.env) continue;
    const text = spec.toEnv ? (spec.toEnv as (value: SettingValue) => string | null)(resolved.value) : String(resolved.value);
    if (text !== null) out[spec.env] = text;
  }
  return out;
}

/** Short English origin, for diagnostics (`env NIRVANA_X=1`, `project <path>`, `default`). */
export function describeSettingSource(resolved: ResolvedSetting): string {
  if (resolved.source === "env") return `env ${resolved.variable}=${resolved.raw}`;
  if (resolved.source === "default") return "default";
  if (resolved.source === "profile") return `profile ${resolved.profile}`;
  return `${resolved.source === "engine-default" ? "engine" : resolved.source} ${resolved.path}`;
}

// ── writing ─────────────────────────────────────────────────────────────────

const TOP_LEVEL_KEY = /^[A-Za-z0-9_]+\s*:/;

function yamlScalar(value: SettingValue): string {
  // Strings are always quoted so YAML 1.1 readers never turn `off`, `no` or `1.0` into something else.
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * Rewrites one `section.name` scalar in YAML source with a line edit: the
 * value on the `name:` line inside the top-level `section:` block is replaced
 * (inline comment kept); an absent key is inserted right after the section
 * line; an absent section is appended. `text === null` removes the key line
 * (and the section line when nothing else is left in it). Every other byte
 * survives, comments included: the config files carry curated comments a YAML
 * re-serialize would destroy. Same approach as the former setRoutingDense.
 */
export function editYamlScalar(source: string, key: string, text: string | null): string {
  const [section, name] = splitKey(key);
  const lines = source.split("\n");
  const sectionRe = new RegExp(`^${section}\\s*:`);
  const nameRe = new RegExp(`^(\\s+)${name}\\s*:`);
  let inSection = false;
  let sectionLine = -1;
  let sectionEnd = lines.length;
  let keyLine = -1;
  let childIndent = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (TOP_LEVEL_KEY.test(line)) {
      if (inSection) { sectionEnd = i; break; }
      inSection = sectionRe.test(line);
      if (inSection) sectionLine = i;
      continue;
    }
    if (!inSection) continue;
    const child = /^(\s+)\S/.exec(line);
    if (child && !childIndent && !line.trim().startsWith("#")) childIndent = child[1];
    if (keyLine === -1 && nameRe.test(line)) keyLine = i;
  }
  if (inSection && sectionEnd === lines.length) sectionEnd = lines.length;

  if (sectionLine !== -1) {
    const rest = lines[sectionLine].replace(sectionRe, "").trim();
    if (rest && !rest.startsWith("#")) {
      throw new SettingsError("invalid_file", `"${section}:" is written inline (${lines[sectionLine].trim()}); edit the file by hand to store ${key}`, { key });
    }
  }

  if (text === null) {
    if (keyLine === -1) return source;
    lines.splice(keyLine, 1);
    const remaining = lines.slice(sectionLine + 1, sectionEnd - 1).some((line) => line.trim() !== "");
    if (!remaining) lines.splice(sectionLine, 1);
    return lines.join("\n");
  }

  const indent = childIndent || "  ";
  if (keyLine !== -1) {
    const m = lines[keyLine].match(/^(\s+[A-Za-z0-9_]+\s*:\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^#\s]+)?\s*(#.*)?$/);
    lines[keyLine] = m ? `${m[1]}${text}${m[2] ? "   " + m[2] : ""}` : `${indent}${name}: ${text}`;
  } else if (sectionLine !== -1) {
    lines.splice(sectionLine + 1, 0, `${indent}${name}: ${text}`);
  } else {
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(`${section}:`, `${indent}${name}: ${text}`);
  }
  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  return out;
}

export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
  cache.delete(file);
}

export interface FileEdit {
  path: string;
  /** The scalar stored before the edit, null when absent. Read as stored, unvalidated, so a bad value can be repaired. */
  from: SettingValue | null;
  to: SettingValue | null;
  changed: boolean;
}

function storedScalar(file: string, key: string): SettingValue | null {
  const data = readYamlFile(file);
  if (!data) return null;
  const raw = rawFileValue(file, data, key);
  if (raw === undefined) return null;
  return typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" ? raw : JSON.stringify(raw);
}

/** Sets (`value`) or removes (`null`) one key in one file, preserving the rest of it. */
/**
 * The comment block a config file is born with.
 *
 * Which file this is decides what it promises: the global one survives
 * `nrv update`, the project one travels with the repository. The SCOPE is
 * passed, never inferred from the path: `globalPath` is overridable (the
 * Glance API and every test do it), so a path comparison against the real
 * global location calls an overridden global file a project one. Both are read
 * under the same precedence, and a variable in the shell beats either.
 */
export function configFileHeader(scope: SettingScope): string {
  const isGlobal = scope === "global";
  const banner = isGlobal
    ? "GLOBAL user configuration. It survives `nrv update`: the engine never\n# rewrites this file."
    : "THIS PROJECT's configuration. It travels with the repository and beats the global one.";
  return [
    "# Nirvana-OS — " + banner,
    "#",
    "# Precedence, strongest to weakest:",
    "#   environment variable  >  <project>/.nirvana/config.yaml  >  ~/.nirvana/config.yaml",
    "#   >  engine config.yaml (replaced on every update)  >  schema default",
    "#",
    "# No need to edit by hand: the command writes here and validates the value.",
    "#   nrv config list                  every key: effective value, source and default",
    "#   nrv config explain <key>       what the key does, scopes and the equivalent variable",
    "#   nrv config set <key> <value> " + (isGlobal ? "--global" : "--project"),
    "#   nrv config unset <key> " + (isGlobal ? "--global" : "--project"),
    "#",
    "# A key the schema does not know is ignored, not an error.",
    "",
    "",
  ].join("\n");
}

export function editSettingInFile(file: string, key: string, value: SettingValue | null, scope?: SettingScope): FileEdit {
  const from = storedScalar(file, key);
  if (from === value) return { path: file, from, to: value, changed: false };
  if (value === null && from === null) return { path: file, from, to: null, changed: false };
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  // A file that has never held anything is the user's first sight of this
  // layer, and it used to arrive blank: no name, no precedence, no hint that it
  // is the one file `nrv update` does not replace. Seeding the header on first
  // write makes the file explain itself to whoever opens it, which is where
  // they will be looking. An existing file is never re-headed.
  const source = existing.trim() === "" && scope ? configFileHeader(scope) : existing;
  const edited = editYamlScalar(source, key, value === null ? null : yamlScalar(value));
  if (edited === source) return { path: file, from, to: value, changed: false };
  writeFileAtomic(file, edited);
  return { path: file, from, to: value, changed: true };
}

export type SettingsAudit = (event: string, payload: Record<string, unknown>) => void;

export interface ChangeOptions extends ResolveOptions {
  scope: SettingScope;
  /** Write even when a variable pins the key in `env` (the value would be shadowed until the variable goes). */
  ignoreEnv?: boolean;
  /** Receives `x_settings_changed { key, scope, path, from, to }` when the file changed. */
  audit?: SettingsAudit;
}

export interface SettingChange extends FileEdit {
  key: string;
  scope: SettingScope;
}

/** The scope `nrv config set` writes to when none is given: the project when inside one, else global. */
export function defaultWriteScope(opts: ResolveOptions = {}): { scope: SettingScope; projectRoot: string | null } {
  const env = opts.env ?? process.env;
  const projectRoot = opts.projectRoot === undefined ? discoverProjectRoot(env, opts.cwd) : opts.projectRoot;
  return { scope: projectRoot ? "project" : "global", projectRoot };
}

function targetFile(spec: SettingSpec, opts: ChangeOptions): string {
  if (!spec.scopes.includes(opts.scope)) {
    throw new SettingsError("scope", `${spec.key} only accepts scope ${spec.scopes.join(" or ")}; --${opts.scope} does not apply to this key`, { key: spec.key, scope: opts.scope });
  }
  const env = opts.env ?? process.env;
  if (opts.scope === "global") {
    const file = opts.globalPath === undefined ? globalConfigPath(env) : opts.globalPath;
    if (!file) throw new SettingsError("scope", "the global layer is disabled in this resolution", { key: spec.key, scope: "global" });
    return file;
  }
  const projectRoot = opts.projectRoot === undefined ? discoverProjectRoot(env, opts.cwd) : opts.projectRoot;
  if (!projectRoot) {
    throw new SettingsError("no_project", `no Nirvana project (.nirvana/ directory) found from ${opts.cwd ?? process.cwd()}; run inside the project or use --global`, { key: spec.key, scope: "project" });
  }
  return projectConfigPath(projectRoot);
}

function refuseWhenPinned(spec: SettingSpec, opts: ChangeOptions): void {
  if (opts.ignoreEnv) return;
  const pinned = readSettingEnv(spec, opts.env ?? process.env);
  if (!pinned) return;
  throw new SettingsError("pinned_by_env", `${spec.key} is pinned by the variable ${pinned.variable}=${pinned.raw} in the environment; the value stored in the file would only apply without the variable. Remove the variable (or run with it empty) and retry`, { key: spec.key, variable: pinned.variable, raw: pinned.raw });
}

/** Validates `input` (a typed value, or text as the CLI receives it) and writes it to the file of `scope`. */
export function setSetting(key: string, input: unknown, opts: ChangeOptions): SettingChange {
  const spec = requireSpec(key);
  const candidate = typeof input === "string" && spec.kind !== "string" ? coerceText(spec, input) : input;
  const checked = validateSettingValue(spec, candidate);
  if (!checked.ok) throw new SettingsError("invalid_value", checked.message, { key });
  const file = targetFile(spec, opts);
  refuseWhenPinned(spec, opts);
  const edit = editSettingInFile(file, key, checked.value, opts.scope);
  if (edit.changed) opts.audit?.("x_settings_changed", { key, scope: opts.scope, path: file, from: edit.from, to: edit.to });
  return { key, scope: opts.scope, ...edit };
}

/** Removes the key from the file of `scope`; the next layer down takes over. */
export function unsetSetting(key: string, opts: ChangeOptions): SettingChange {
  const spec = requireSpec(key);
  const file = targetFile(spec, opts);
  refuseWhenPinned(spec, opts);
  const edit = editSettingInFile(file, key, null, opts.scope);
  if (edit.changed) opts.audit?.("x_settings_changed", { key, scope: opts.scope, path: file, from: edit.from, to: null });
  return { key, scope: opts.scope, ...edit };
}
