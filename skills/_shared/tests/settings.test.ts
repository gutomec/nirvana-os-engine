// settings.test.ts — the one resolution path of the operational settings:
// the four origins and their precedence (env > project > global > engine
// default > default), project discovery, a project without a config, the
// clear errors a malformed file or an invalid value raise, the
// comment-preserving writes, the refusals of setSetting, the audit callback,
// the per-process cache, and the variables a spawner pins into a child.
// Hermetic: every layer is an explicit temp path, the environment is the
// one the test passes. Runs with: bun test skills/_shared/tests
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  _resetSettingsCache, defaultWriteScope, describeSettingSource, discoverProjectRoot, editYamlScalar, engineConfigPath,
  globalConfigPath, projectConfigPath, resolveAllSettings, resolveSetting, resolveSettingsMap, SettingsError, setSetting,
  settingsEnvForChild, SETTINGS_SCHEMA, unsetSetting, type ResolveOptions,
} from "../lib/settings.ts";

let tmp: string;
let home: string;
let project: string;
let engine: string;
let base: ResolveOptions;

const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
};
const read = (file: string) => fs.readFileSync(file, "utf8");

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-settings-")));
  home = path.join(tmp, "home");
  project = path.join(tmp, "project");
  engine = path.join(tmp, "engine-config.yaml");
  fs.mkdirSync(path.join(project, ".nirvana"), { recursive: true });
  fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
  base = { env: {}, projectRoot: project, globalPath: globalConfigPath({ NIRVANA_HOME: home }), enginePath: engine };
  _resetSettingsCache();
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("the four origins", () => {
  test("nothing configured: every key is its schema default, source default", () => {
    const all = resolveAllSettings(base);
    expect(all.map((setting) => setting.key)).toEqual(SETTINGS_SCHEMA.map((spec) => spec.key));
    for (const setting of all) {
      expect(setting.source).toBe("default");
      expect(setting.value).toBe(SETTINGS_SCHEMA.find((spec) => spec.key === setting.key)!.default);
    }
    expect(resolveSettingsMap(base)["routing.mode"]).toBe("agentic");
  });

  test("env > project > global > engine default > default, one key at a time", () => {
    write(engine, "routing:\n  mode: fast\n");
    expect(resolveSetting("routing.mode", base)).toEqual({ key: "routing.mode", value: "fast", source: "engine-default", path: engine });
    write(base.globalPath!, "routing:\n  mode: agentic\n");
    expect(resolveSetting("routing.mode", base)).toMatchObject({ value: "agentic", source: "global", path: base.globalPath });
    write(projectConfigPath(project), "locale: pt-BR\nrouting:\n  mode: fast\n");
    expect(resolveSetting("routing.mode", base)).toMatchObject({ value: "fast", source: "project", path: projectConfigPath(project) });
    expect(resolveSetting("routing.mode", { ...base, env: { NIRVANA_ROUTING_MODE: "agentic" } }))
      .toEqual({ key: "routing.mode", value: "agentic", source: "env", variable: "NIRVANA_ROUTING_MODE", raw: "agentic" });
  });

  test("the engine's own config.yaml is the engine-default layer of the real resolution", () => {
    const enginePath = engineConfigPath({});
    expect(enginePath).toBe(path.resolve(import.meta.dir, "..", "..", "harness", "config.yaml"));
    const budget = resolveSetting("budget.on_budget_exceeded", { env: {}, projectRoot: null, globalPath: null });
    expect(budget).toMatchObject({ value: "warn", source: "engine-default", path: enginePath });
  });

  test("a project without a config file, and a key outside its scope in a file, fall through", () => {
    expect(resolveSetting("routing.mode", base).source).toBe("default");
    write(projectConfigPath(project), "updates:\n  check: false\n");
    expect(resolveSetting("updates.check", base)).toMatchObject({ value: true, source: "default" });
    write(base.globalPath!, "updates:\n  check: false\n");
    expect(resolveSetting("updates.check", base)).toMatchObject({ value: false, source: "global" });
  });

  test("a null value in a file is absent; unknown keys and sections are ignored", () => {
    write(projectConfigPath(project), "routing:\n  mode:\n  colour: blue\nsomething_else:\n  deep: 1\n");
    expect(resolveSetting("routing.mode", base).source).toBe("default");
  });

  test("an unknown key is a clear error", () => {
    expect(() => resolveSetting("routing.nope", base)).toThrow(SettingsError);
    expect(() => resolveSetting("nope", base)).toThrow(/chave desconhecida: nope/);
  });
});

describe("clear errors, never silent defaults", () => {
  test("malformed YAML names the file", () => {
    write(base.globalPath!, "routing: [oops\n");
    let error: SettingsError | null = null;
    try { resolveSetting("routing.mode", base); } catch (caught) { error = caught as SettingsError; }
    expect(error).toBeInstanceOf(SettingsError);
    expect(error!.code).toBe("invalid_file");
    expect(error!.message).toContain(base.globalPath!);
    expect(error!.message).toContain("YAML inválido");
  });

  test("an invalid value names the file, the key and the choices", () => {
    write(projectConfigPath(project), "routing:\n  mode: turbo\n");
    expect(() => resolveSetting("routing.mode", base)).toThrow(`${projectConfigPath(project)}: routing.mode: valor inválido "turbo"; esperado agentic | fast`);
    write(projectConfigPath(project), "quality_gate:\n  max_revisions: two\n");
    expect(() => resolveSetting("quality_gate.max_revisions", base)).toThrow(/quality_gate\.max_revisions: valor inválido "two"; esperado inteiro >= 0/);
  });

  test("a section that is not a mapping is refused, a scalar file too", () => {
    write(projectConfigPath(project), "routing: fast\n");
    expect(() => resolveSetting("routing.mode", base)).toThrow(/"routing" deve ser um mapeamento/);
    write(projectConfigPath(project), "just a string\n");
    expect(() => resolveSetting("routing.mode", base)).toThrow(/deve ser um mapeamento/);
  });

  test("an invalid variable names the variable", () => {
    expect(() => resolveSetting("routing.mode", { ...base, env: { NIRVANA_ROUTING_MODE: "turbo" } }))
      .toThrow("NIRVANA_ROUTING_MODE=turbo inválido para routing.mode; esperado agentic | fast");
  });
});

describe("project discovery", () => {
  test("NIRVANA_PROJECT_ROOT wins; else the nearest ancestor with .nirvana/; HOME and the root never count", () => {
    expect(discoverProjectRoot({ NIRVANA_PROJECT_ROOT: "/elsewhere/project" }, project)).toBe(path.resolve("/elsewhere/project"));
    const deep = path.join(project, "src", "deep");
    fs.mkdirSync(deep, { recursive: true });
    expect(discoverProjectRoot({}, deep)).toBe(project);
    expect(discoverProjectRoot({ NIRVANA_HOME: home }, path.join(home, "work"))).toBeNull();
    expect(discoverProjectRoot({ HOME: home }, home)).toBeNull();
    expect(discoverProjectRoot({}, tmp)).toBeNull();
  });

  test("the resolution discovers the project from cwd, and HOME's own .nirvana/ is the global layer, not a project", () => {
    write(projectConfigPath(project), "routing:\n  mode: fast\n");
    expect(resolveSetting("routing.mode", { env: {}, cwd: path.join(project, "anywhere"), globalPath: null, enginePath: null })).toMatchObject({ value: "fast", source: "project" });
    write(path.join(home, ".nirvana", "config.yaml"), "routing:\n  mode: fast\n");
    const fromHome = resolveSetting("routing.mode", { env: { NIRVANA_HOME: home, HOME: home }, cwd: home, enginePath: null });
    expect(fromHome).toMatchObject({ value: "fast", source: "global", path: path.join(home, ".nirvana", "config.yaml") });
  });

  test("defaultWriteScope is the project inside one, global outside", () => {
    expect(defaultWriteScope({ env: {}, cwd: path.join(project, "x") })).toEqual({ scope: "project", projectRoot: project });
    expect(defaultWriteScope({ env: {}, cwd: tmp })).toEqual({ scope: "global", projectRoot: null });
  });
});

describe("writing", () => {
  test("setSetting creates the file and its directory, quotes strings, writes numbers and booleans bare", () => {
    const fresh = path.join(tmp, "fresh-home");
    const opts = { ...base, globalPath: path.join(fresh, ".nirvana", "config.yaml") };
    expect(setSetting("routing.mode", "fast", { ...opts, scope: "global" })).toEqual({ key: "routing.mode", scope: "global", path: opts.globalPath, from: null, to: "fast", changed: true });
    setSetting("quality_gate.max_revisions", "3", { ...opts, scope: "global" });
    setSetting("multi_target.enabled", "off", { ...opts, scope: "global" });
    setSetting("budget.default_max_cost_usd", 2.5, { ...opts, scope: "global" });
    expect(read(opts.globalPath)).toBe([
      "routing:", '  mode: "fast"', "", "quality_gate:", "  max_revisions: 3", "", "multi_target:", "  enabled: false", "", "budget:", "  default_max_cost_usd: 2.5", "",
    ].join("\n"));
    expect(resolveSettingsMap(opts)).toMatchObject({ "routing.mode": "fast", "quality_gate.max_revisions": 3, "multi_target.enabled": false, "budget.default_max_cost_usd": 2.5 });
  });

  test("a line edit keeps every other byte: comments, inline comments, the locale, other sections", () => {
    const file = projectConfigPath(project);
    write(file, [
      "# project config",
      "locale: pt-BR",
      "routing:",
      "  # how targets are chosen",
      "  mode: agentic   # set by hand",
      "  dense: off",
      "gauntlet:",
      "  default_intensity: light",
      "",
    ].join("\n"));
    const change = setSetting("routing.mode", "fast", { ...base, scope: "project" });
    expect(change).toMatchObject({ from: "agentic", to: "fast", changed: true, path: file });
    expect(read(file)).toBe([
      "# project config",
      "locale: pt-BR",
      "routing:",
      "  # how targets are chosen",
      '  mode: "fast"   # set by hand',
      "  dense: off",
      "gauntlet:",
      "  default_intensity: light",
      "",
    ].join("\n"));
    setSetting("routing.on_router_failure", "fail", { ...base, scope: "project" });
    expect(read(file)).toContain('routing:\n  on_router_failure: "fail"\n  # how targets are chosen');
  });

  test("unsetSetting removes the line, then the empty section, and reports nothing to remove", () => {
    const file = projectConfigPath(project);
    write(file, "locale: pt-BR\nrouting:\n  mode: fast\n  dense: off\n");
    expect(unsetSetting("routing.mode", { ...base, scope: "project" })).toMatchObject({ from: "fast", to: null, changed: true });
    expect(read(file)).toBe("locale: pt-BR\nrouting:\n  dense: off\n");
    unsetSetting("routing.dense", { ...base, scope: "project" });
    expect(read(file)).toBe("locale: pt-BR\n");
    expect(unsetSetting("routing.dense", { ...base, scope: "project" })).toMatchObject({ from: null, to: null, changed: false });
  });

  test("an unchanged value is no write and no audit; a changed one is audited with key, scope, path, from and to", () => {
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const audit = (event: string, payload: Record<string, unknown>) => events.push({ event, payload });
    const opts = { ...base, scope: "global" as const, audit };
    setSetting("routing.mode", "fast", opts);
    const mtime = fs.statSync(base.globalPath!).mtimeMs;
    expect(setSetting("routing.mode", "fast", opts).changed).toBe(false);
    expect(fs.statSync(base.globalPath!).mtimeMs).toBe(mtime);
    unsetSetting("routing.mode", opts);
    expect(events).toEqual([
      { event: "x_settings_changed", payload: { key: "routing.mode", scope: "global", path: base.globalPath, from: null, to: "fast" } },
      { event: "x_settings_changed", payload: { key: "routing.mode", scope: "global", path: base.globalPath, from: "fast", to: null } },
    ]);
  });

  test("refusals: an invalid value, a scope the key rejects, a project scope with no project, a section written in line", () => {
    expect(() => setSetting("routing.mode", "turbo", { ...base, scope: "global" })).toThrow('routing.mode: valor inválido "turbo"; esperado agentic | fast');
    expect(() => setSetting("quality_gate.max_revisions", "many", { ...base, scope: "global" })).toThrow(/esperado inteiro >= 0/);
    expect(() => setSetting("updates.check", "false", { ...base, scope: "project" })).toThrow(/updates\.check só aceita escopo global/);
    expect(() => setSetting("routing.mode", "fast", { env: {}, cwd: tmp, scope: "project", globalPath: base.globalPath, enginePath: null })).toThrow(/nenhum projeto Nirvana/);
    write(base.globalPath!, "routing: { mode: agentic }\n");
    expect(() => setSetting("routing.dense", "fallback", { ...base, scope: "global" })).toThrow(/"routing:" está escrito em linha/);
    expect(fs.existsSync(projectConfigPath(project))).toBe(false);
  });

  test("a key pinned by a variable is refused with the variable named, unless the caller ignores the environment", () => {
    const env = { NIRVANA_ROUTING_MODE: "agentic" };
    expect(() => setSetting("routing.mode", "fast", { ...base, env, scope: "global" })).toThrow(/routing\.mode está fixado pela variável NIRVANA_ROUTING_MODE=agentic/);
    expect(() => unsetSetting("routing.mode", { ...base, env, scope: "global" })).toThrow(/fixado pela variável/);
    expect(setSetting("routing.mode", "fast", { ...base, env, scope: "global", ignoreEnv: true }).changed).toBe(true);
    // The variable still wins the resolution; the file holds the value for later.
    expect(resolveSetting("routing.mode", { ...base, env })).toMatchObject({ value: "agentic", source: "env" });
    expect(resolveSetting("routing.mode", base)).toMatchObject({ value: "fast", source: "global" });
  });

  test("a bad value already in the file can be repaired: the write does not validate what it replaces", () => {
    write(base.globalPath!, "routing:\n  mode: turbo\n");
    expect(() => resolveSetting("routing.mode", base)).toThrow(/turbo/);
    expect(setSetting("routing.mode", "fast", { ...base, scope: "global" })).toMatchObject({ from: "turbo", to: "fast", changed: true });
    expect(resolveSetting("routing.mode", base).value).toBe("fast");
  });

  test("editYamlScalar alone: replace, insert after the section, append, remove; the file always ends with a newline", () => {
    expect(editYamlScalar("", "routing.mode", '"fast"')).toBe('routing:\n  mode: "fast"\n');
    expect(editYamlScalar("a: 1", "routing.mode", '"fast"')).toBe('a: 1\n\nrouting:\n  mode: "fast"\n');
    expect(editYamlScalar("routing:\n    dense: off\n", "routing.mode", '"fast"')).toBe('routing:\n    mode: "fast"\n    dense: off\n');
    expect(editYamlScalar("routing:\n  mode: agentic # c\nother:\n  mode: x\n", "routing.mode", '"fast"')).toBe('routing:\n  mode: "fast"   # c\nother:\n  mode: x\n');
    expect(editYamlScalar("routing:\n  mode: agentic\nother:\n  mode: x\n", "routing.mode", null)).toBe("other:\n  mode: x\n");
    expect(editYamlScalar("other:\n  mode: x\n", "routing.mode", null)).toBe("other:\n  mode: x\n");
  });
});

describe("cache", () => {
  test("a file is re-read when it changes on disk, and after a write through the module", () => {
    write(base.globalPath!, "routing:\n  mode: fast\n");
    expect(resolveSetting("routing.mode", base).value).toBe("fast");
    // Same size, different content: the cache keys on mtime too.
    const later = new Date(Date.now() + 5000);
    fs.writeFileSync(base.globalPath!, "routing:\n  mode: slow\n".replace("slow", "fast"), "utf8");
    fs.utimesSync(base.globalPath!, later, later);
    expect(resolveSetting("routing.mode", base).value).toBe("fast");
    setSetting("routing.mode", "agentic", { ...base, scope: "global" });
    expect(resolveSetting("routing.mode", base).value).toBe("agentic");
    fs.rmSync(base.globalPath!);
    expect(resolveSetting("routing.mode", base).source).toBe("default");
  });
});

describe("settingsEnvForChild", () => {
  test("pins every key that has a variable, in the variable's own spelling; empty strings and a true updates.check stay unset", () => {
    write(projectConfigPath(project), "routing:\n  dense: fallback\n  mode: fast\nmulti_target:\n  enabled: false\nexecution:\n  model: opus\nsupervisor:\n  progress_ping_sec: 5\n");
    write(base.globalPath!, "updates:\n  check: false\n");
    const pinned = settingsEnvForChild(base);
    expect(pinned).toMatchObject({
      NIRVANA_ROUTER_DENSE: "1", NIRVANA_ROUTING_MODE: "fast", NIRVANA_MULTI_TARGET_KILL_SWITCH: "1", NIRVANA_MODEL: "opus",
      NIRVANA_PROGRESS_PING_SEC: "5", NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_EXECUTION_MODE: "standard", NIRVANA_HEADLESS_SKIP_PERMISSIONS: "1",
      NIRVANA_GLANCE_EXECUTION: "1", NIRVANA_DNA_INJECTION: "full",
    });
    expect(pinned).not.toHaveProperty("NIRVANA_DEFAULT_RUNTIME");
    expect(pinned).not.toHaveProperty("NIRVANA_GAUNTLET_EVALUATOR");
    expect(pinned).not.toHaveProperty("NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST");
    const defaults = settingsEnvForChild({ ...base, projectRoot: null, globalPath: null, enginePath: null });
    expect(defaults).not.toHaveProperty("NIRVANA_NO_UPDATE_CHECK");
    expect(defaults.NIRVANA_MULTI_TARGET_KILL_SWITCH).toBe("0");
    // A child resolving for itself reads the pinned variables back to the same values.
    const child = resolveSettingsMap({ env: pinned, projectRoot: null, globalPath: null, enginePath: null });
    expect(child).toMatchObject({ "routing.dense": "fallback", "routing.mode": "fast", "multi_target.enabled": false, "execution.model": "opus", "supervisor.progress_ping_sec": 5, "updates.check": false });
  });

  test("a variable already in the child's environment wins and is pinned as is", () => {
    write(projectConfigPath(project), "routing:\n  mode: fast\n");
    expect(settingsEnvForChild({ ...base, env: { NIRVANA_ROUTING_MODE: "agentic" } }).NIRVANA_ROUTING_MODE).toBe("agentic");
  });
});

describe("describeSettingSource", () => {
  test("names the variable, the file or the default", () => {
    write(projectConfigPath(project), "routing:\n  mode: fast\n");
    expect(describeSettingSource(resolveSetting("routing.mode", base))).toBe(`project ${projectConfigPath(project)}`);
    expect(describeSettingSource(resolveSetting("routing.mode", { ...base, env: { NIRVANA_ROUTING_MODE: "fast" } }))).toBe("env NIRVANA_ROUTING_MODE=fast");
    expect(describeSettingSource(resolveSetting("routing.dense", base))).toBe("default");
    write(engine, "routing:\n  dense: fallback\n");
    expect(describeSettingSource(resolveSetting("routing.dense", base))).toBe(`engine ${engine}`);
  });
});
