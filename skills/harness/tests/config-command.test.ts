// config-command.test.ts — `nrv config list|get|set|unset|explain` end to end:
// the effective value and origin per key, the default write scope (the
// project inside one, else global), the refusals (invalid value, unknown key,
// a scope the key rejects, a key pinned by a variable), the audit event of
// every write, and a config file the resolver cannot read. Hermetic: a temp
// HOME (HOME and NIRVANA_HOME), a temp project, a temp harness log; every
// schema variable scrubbed from the inherited environment. Runs with: bun test skills/harness/tests
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SETTINGS_SCHEMA } from "../../_shared/lib/settings.ts";
import { removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const SCRIPT = path.join(import.meta.dir, "..", "scripts", "config.ts");
const SCHEMA_VARIABLES = new Set(SETTINGS_SCHEMA.flatMap((spec) => [spec.env, ...(spec.envAliases ?? [])]).filter((name): name is string => !!name));

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeDir(root); });

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-config-cmd-")));
  roots.push(root);
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const logs = path.join(root, "logs");
  fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
  fs.mkdirSync(path.join(project, ".nirvana"), { recursive: true });
  return { root, home, project, logs, globalFile: path.join(home, ".nirvana", "config.yaml"), projectFile: path.join(project, ".nirvana", "config.yaml") };
}
type Fixture = ReturnType<typeof fixture>;

function nrvConfig(setup: Fixture, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || SCHEMA_VARIABLES.has(key) || key === "NIRVANA_PROJECT_ROOT" || key === "HARNESS_LOGS_DIR" || key === "CI") continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: setup.home, USERPROFILE: setup.home, NIRVANA_HOME: setup.home, HARNESS_LOGS_DIR: setup.logs,
    NIRVANA_SCOPE_QUIET: "1", NIRVANA_SKIP_PATH_PERSIST: "1", NO_COLOR: "1",
  }, opts.env ?? {});
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: opts.cwd ?? setup.root, encoding: "utf8", env });
  // `out` / `err` read paths with slashes whatever the OS prints; `stdout` stays raw for JSON.
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", out: slashes(r.stdout ?? ""), err: slashes(r.stderr ?? "") };
}

const slashes = (text: string): string => text.replace(/\\/g, "/");

function auditEvents(setup: Fixture): Array<Record<string, unknown>> {
  let days: string[] = [];
  try { days = fs.readdirSync(setup.logs); } catch { return []; }
  return days.flatMap((day) => {
    try { return fs.readFileSync(path.join(setup.logs, day, "audit.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch { return []; }
  });
}

describe("nrv config", () => {
  test("list prints every key with its effective value, origin and default; --json is the same as data", () => {
    const setup = fixture();
    fs.writeFileSync(setup.globalFile, "routing:\n  mode: fast\n", "utf8");
    const text = nrvConfig(setup, ["list"]);
    expect(text.status).toBe(0);
    expect(text.out).toMatch(/^chave\s+valor\s+origem\s+padrão$/m);
    expect(text.out).toMatch(/^routing\.mode\s+fast\s+global ~\/\.nirvana\/config\.yaml\s+agentic$/m);
    expect(text.out).toMatch(/^multi_target\.enabled\s+true\s+padrão\s+true$/m);
    const json = nrvConfig(setup, ["list", "--json"], { env: { NIRVANA_ROUTER_DENSE: "1" } });
    expect(json.status).toBe(0);
    const rows = JSON.parse(json.stdout) as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.key)).toEqual(SETTINGS_SCHEMA.map((spec) => spec.key));
    expect(rows.find((row) => row.key === "routing.mode")).toMatchObject({ value: "fast", source: "global", path: setup.globalFile, default: "agentic", kind: "enum", options: ["agentic", "fast"], env: "NIRVANA_ROUTING_MODE" });
    expect(rows.find((row) => row.key === "routing.dense")).toMatchObject({ value: "fallback", source: "env", variable: "NIRVANA_ROUTER_DENSE", raw: "1" });
    expect(rows.every((row) => row.secret === false && typeof row.description === "string")).toBe(true);
  }, spawnBudgetMs(2));

  test("set writes the project inside one and the global outside, get reads the effective value, every write is audited", () => {
    const setup = fixture();
    const inside = nrvConfig(setup, ["set", "routing.mode", "fast"], { cwd: path.join(setup.project, ".nirvana") });
    expect(inside.status).toBe(0);
    expect(inside.out).toContain(`routing.mode = fast gravado em ${slashes(setup.projectFile)} (projeto)`);
    expect(fs.readFileSync(setup.projectFile, "utf8")).toBe('routing:\n  mode: "fast"\n');

    const outside = nrvConfig(setup, ["set", "quality_gate.max_revisions", "4"]);
    expect(outside.status).toBe(0);
    expect(outside.out).toContain("quality_gate.max_revisions = 4 gravado em ~/.nirvana/config.yaml (global)");
    expect(fs.readFileSync(setup.globalFile, "utf8")).toBe("quality_gate:\n  max_revisions: 4\n");

    const shadowed = nrvConfig(setup, ["set", "routing.mode", "agentic", "--global"], { cwd: setup.project });
    expect(shadowed.out).toContain("routing.mode = agentic gravado em ~/.nirvana/config.yaml (global)");
    expect(shadowed.out).toContain(`valor efetivo agora: fast (projeto ${slashes(setup.projectFile)})`);
    expect(nrvConfig(setup, ["get", "routing.mode"], { cwd: setup.project }).stdout.trim()).toBe("fast");
    expect(nrvConfig(setup, ["get", "routing.mode"]).stdout.trim()).toBe("agentic");
    expect(JSON.parse(nrvConfig(setup, ["get", "quality_gate.max_revisions", "--json"]).stdout)).toMatchObject({ key: "quality_gate.max_revisions", value: 4, source: "global" });

    const again = nrvConfig(setup, ["set", "quality_gate.max_revisions", "4"]);
    expect(again.stdout).toContain("já era 4");

    expect(auditEvents(setup).filter((event) => event.event === "x_settings_changed")).toEqual([
      expect.objectContaining({ key: "routing.mode", scope: "project", path: setup.projectFile, from: null, to: "fast" }),
      expect.objectContaining({ key: "quality_gate.max_revisions", scope: "global", path: setup.globalFile, from: null, to: 4 }),
      expect.objectContaining({ key: "routing.mode", scope: "global", path: setup.globalFile, from: null, to: "agentic" }),
    ]);
  }, spawnBudgetMs(8));

  test("refusals: an invalid value, an unknown key, a scope the key rejects, a key pinned by a variable, missing arguments", () => {
    const setup = fixture();
    const invalid = nrvConfig(setup, ["set", "routing.mode", "turbo"]);
    expect(invalid.status).toBe(4);
    expect(invalid.stderr).toContain('nrv config: routing.mode: valor inválido "turbo"; esperado agentic | fast');
    const unknown = nrvConfig(setup, ["get", "routing.nope"]);
    expect(unknown.status).toBe(4);
    expect(unknown.stderr).toContain("chave desconhecida: routing.nope");
    const scope = nrvConfig(setup, ["set", "updates.check", "false", "--project"], { cwd: setup.project });
    expect(scope.status).toBe(4);
    expect(scope.stderr).toContain("updates.check só aceita escopo global");
    const pinned = nrvConfig(setup, ["set", "routing.mode", "fast"], { env: { NIRVANA_ROUTING_MODE: "agentic" } });
    expect(pinned.status).toBe(4);
    expect(pinned.stderr).toContain("routing.mode está fixado pela variável NIRVANA_ROUTING_MODE=agentic");
    expect(fs.existsSync(setup.globalFile)).toBe(false);
    const noProject = nrvConfig(setup, ["set", "routing.mode", "fast", "--project"]);
    expect(noProject.status).toBe(4);
    expect(noProject.stderr).toContain("nenhum projeto Nirvana");
    expect(nrvConfig(setup, ["set", "routing.mode"]).status).toBe(4);
    expect(nrvConfig(setup, ["frobnicate"]).status).toBe(4);
    expect(auditEvents(setup)).toEqual([]);
  }, spawnBudgetMs(7));

  test("unset removes the key and audits it; explain describes the key", () => {
    const setup = fixture();
    fs.writeFileSync(setup.globalFile, "# mine\nrouting:\n  mode: fast\n  dense: fallback\n", "utf8");
    const removed = nrvConfig(setup, ["unset", "routing.mode"]);
    expect(removed.status).toBe(0);
    expect(removed.out).toContain("routing.mode removido de ~/.nirvana/config.yaml (global); era fast");
    expect(fs.readFileSync(setup.globalFile, "utf8")).toBe("# mine\nrouting:\n  dense: fallback\n");
    expect(nrvConfig(setup, ["unset", "routing.mode"]).out).toContain("não estava definido");
    expect(auditEvents(setup).filter((event) => event.event === "x_settings_changed")).toEqual([
      expect.objectContaining({ key: "routing.mode", scope: "global", from: "fast", to: null }),
    ]);

    const explain = nrvConfig(setup, ["explain", "routing.dense"]);
    expect(explain.status).toBe(0);
    expect(explain.stdout).toContain("routing.dense — ");
    expect(explain.stdout).toContain("tipo:     off | fallback");
    expect(explain.stdout).toContain("padrão:   off");
    expect(explain.stdout).toContain("escopos:  global, projeto");
    expect(explain.stdout).toContain("variável: NIRVANA_ROUTER_DENSE");
    expect(explain.out).toContain("efetivo:  fallback (global ~/.nirvana/config.yaml)");
    expect(nrvConfig(setup, ["explain", "multi_target.enabled"]).stdout).toContain("(também NIRVANA_MULTI_TARGET_ENGINE)");
  }, spawnBudgetMs(4));

  test("a config file the resolver cannot read is reported with its path, exit 1", () => {
    const setup = fixture();
    fs.writeFileSync(setup.globalFile, "routing: [oops\n", "utf8");
    const broken = nrvConfig(setup, ["list"]);
    expect(broken.status).toBe(1);
    expect(broken.err).toContain(`nrv config: ${slashes(setup.globalFile)}: YAML inválido`);
    fs.writeFileSync(setup.globalFile, "routing:\n  mode: turbo\n", "utf8");
    const bad = nrvConfig(setup, ["get", "routing.mode"]);
    expect(bad.status).toBe(4);
    expect(bad.err).toContain(`${slashes(setup.globalFile)}: routing.mode: valor inválido "turbo"`);
    // The write does not validate what it replaces, so the file can be repaired from the CLI.
    expect(nrvConfig(setup, ["set", "routing.mode", "fast"]).status).toBe(0);
    expect(nrvConfig(setup, ["get", "routing.mode"]).stdout.trim()).toBe("fast");
  }, spawnBudgetMs(4));
});
