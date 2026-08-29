// settings-readers.test.ts — every reader of a switch resolves through the
// settings core: for each one, the global config, the project config over it,
// and the variable over both. Also a guard: no reader in skills/**/{lib,scripts}
// reads a schema variable straight from the environment any more (the
// Node-only fallback of host-agent-driver.js is the documented exception).
// Hermetic: a temp HOME (NIRVANA_HOME) and a temp project (NIRVANA_PROJECT_ROOT),
// every managed variable restored after each test. Runs with: bun test skills/harness/tests
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsCache, SETTINGS_SCHEMA } from "../../_shared/lib/settings.ts";
import { resolveRoutingMode } from "../../_shared/lib/routing-mode.ts";
import { headlessSkipPermissions } from "../../_shared/lib/host-agent-driver.ts";
import { resolveSystemModel } from "../../_shared/lib/system-model.ts";
import { parseExecutionOptions } from "../lib/gauntlet/execution-options.ts";
import { detectExecutionRuntime } from "../lib/control-plane/execution-runner.ts";
import { freezeExecutionSnapshot, resolveCatalogDirs } from "../lib/runtime-snapshot.ts";
import { loadHarnessConfig } from "../lib/harness-config.ts";
import { engineGate } from "../scripts/multi-target.ts";
import { checkDisabled } from "../scripts/update-check.ts";
import { removeDir } from "./helpers/temp-dirs.ts";

const budget = createRequire(import.meta.url)("../lib/budget.js") as {
  check(target: Record<string, unknown>, ctx?: Record<string, unknown>): Promise<{ ok: boolean; max_cost_usd: number; estimated_usd: number }>;
  DEFAULTS: { budget: Record<string, unknown>; baselines: Record<string, unknown> };
};

const MANAGED = [
  "NIRVANA_HOME", "NIRVANA_PROJECT_ROOT", "CLAUDE_CONFIG_DIR", "ANTHROPIC_MODEL", "CI", "HARNESS_LOGS_DIR",
  ...SETTINGS_SCHEMA.flatMap((spec) => [spec.env, ...(spec.envAliases ?? [])]).filter((name): name is string => !!name),
];
const saved: Record<string, string | undefined> = {};
let root: string;
let home: string;
let project: string;

beforeEach(() => {
  for (const key of MANAGED) { saved[key] = process.env[key]; delete process.env[key]; }
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-settings-readers-")));
  home = path.join(root, "home");
  project = path.join(root, "project");
  fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
  fs.mkdirSync(path.join(project, ".nirvana"), { recursive: true });
  fs.mkdirSync(path.join(root, "claude-config"), { recursive: true });
  process.env.NIRVANA_HOME = home;
  process.env.NIRVANA_PROJECT_ROOT = project;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude-config");
  _resetSettingsCache();
});
afterEach(() => {
  for (const key of MANAGED) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  _resetSettingsCache();
  removeDir(root);
});

function globalConfig(yaml: string): void { fs.writeFileSync(path.join(home, ".nirvana", "config.yaml"), yaml, "utf8"); _resetSettingsCache(); }
function projectConfig(yaml: string): void { fs.writeFileSync(path.join(project, ".nirvana", "config.yaml"), yaml, "utf8"); _resetSettingsCache(); }

describe("each reader: global, project over global, variable over both", () => {
  test("routing.mode (routing-mode.ts), with an explicit --mode over everything", () => {
    expect(resolveRoutingMode()).toBe("agentic");
    globalConfig("routing:\n  mode: fast\n");
    expect(resolveRoutingMode()).toBe("fast");
    projectConfig("routing:\n  mode: agentic\n");
    expect(resolveRoutingMode()).toBe("agentic");
    process.env.NIRVANA_ROUTING_MODE = "fast";
    expect(resolveRoutingMode()).toBe("fast");
    expect(resolveRoutingMode("agentic")).toBe("agentic");
  });

  test("routing.dense and quality_gate (harness-config.ts)", () => {
    globalConfig("routing:\n  dense: fallback\nquality_gate:\n  max_revisions: 4\n");
    expect(loadHarnessConfig()).toMatchObject({ routing: { dense: "fallback" }, quality_gate: { max_revisions: 4 } });
    projectConfig("quality_gate:\n  max_revisions: 1\n");
    expect(loadHarnessConfig().quality_gate.max_revisions).toBe(1);
    process.env.NIRVANA_ROUTER_DENSE = "0";
    expect(loadHarnessConfig().routing.dense).toBe("off");
  });

  test("budget.* and baselines.* (budget.js), defaults from the schema", async () => {
    expect(budget.DEFAULTS.budget.default_max_cost_usd).toBe(0);
    expect(budget.DEFAULTS.baselines.squad_capability_usd).toBe(0.3);
    expect((await budget.check({ type: "squad_capability" })).ok).toBe(true); // unlimited
    globalConfig("budget:\n  default_max_cost_usd: 0.1\n");
    const capped = await budget.check({ type: "squad_capability" });
    expect(capped).toMatchObject({ ok: false, max_cost_usd: 0.1, estimated_usd: 0.3 });
    projectConfig("baselines:\n  squad_capability_usd: 0.05\n");
    expect(await budget.check({ type: "squad_capability" })).toMatchObject({ ok: true, max_cost_usd: 0.1, estimated_usd: 0.05 });
  });

  test("gauntlet.default_mode, default_intensity and auto_allowed (execution-options.ts)", () => {
    expect(parseExecutionOptions([])).toMatchObject({ requestedMode: "standard", intensity: "balanced" });
    globalConfig("gauntlet:\n  default_intensity: exhaustive\n");
    projectConfig("gauntlet:\n  default_mode: gauntlet\n  default_intensity: light\n");
    expect(parseExecutionOptions([])).toMatchObject({ requestedMode: "gauntlet", resolvedMode: "gauntlet", intensity: "light" });
    process.env.NIRVANA_EXECUTION_MODE = "standard";
    expect(parseExecutionOptions([])).toMatchObject({ requestedMode: "standard", intensity: "light" });
    expect(parseExecutionOptions(["--gauntlet-intensity=balanced"]).intensity).toBe("balanced");
    delete process.env.NIRVANA_EXECUTION_MODE;
    projectConfig("gauntlet:\n  default_mode: forever\n");
    expect(() => parseExecutionOptions([])).toThrow(/gauntlet\.default_mode: valor inválido "forever"/);
  });

  test("execution.headless_skip_permissions (host-agent-driver.ts)", () => {
    expect(headlessSkipPermissions()).toBe(true);
    globalConfig("execution:\n  headless_skip_permissions: false\n");
    expect(headlessSkipPermissions()).toBe(false);
    projectConfig("execution:\n  headless_skip_permissions: true\n");
    expect(headlessSkipPermissions()).toBe(true);
    process.env.NIRVANA_HEADLESS_SKIP_PERMISSIONS = "no";
    expect(headlessSkipPermissions()).toBe(false);
  });

  test("execution.model (system-model.ts), always as the family alias", () => {
    expect(resolveSystemModel("claude-code")).toBeNull();
    globalConfig("execution:\n  model: claude-opus-4-7\n");
    expect(resolveSystemModel("claude-code")).toBe("opus");
    projectConfig('execution:\n  model: "sonnet"\n');
    expect(resolveSystemModel("codex")).toBe("sonnet");
    process.env.NIRVANA_MODEL = "haiku";
    expect(resolveSystemModel("codex")).toBe("haiku");
  });

  test("updates.check (update-check.ts): global only, the opt-out variable wins", () => {
    expect(checkDisabled()).toBe(false);
    projectConfig("updates:\n  check: false\n");
    expect(checkDisabled()).toBe(false); // a project may not switch the machine's check off
    globalConfig("updates:\n  check: false\n");
    expect(checkDisabled()).toBe(true);
    process.env.NIRVANA_NO_UPDATE_CHECK = "0";
    expect(checkDisabled()).toBe(false);
    process.env.NIRVANA_NO_UPDATE_CHECK = "1";
    expect(checkDisabled()).toBe(true);
  });

  test("multi_target.enabled (multi-target.ts engineGate): a config refusal names the key and the file, a variable refusal the variable", () => {
    expect(engineGate(process.env).enabled).toBe(true);
    projectConfig("multi_target:\n  enabled: false\n");
    const byFile = engineGate(process.env);
    expect(byFile).toMatchObject({ enabled: false, variable: "multi_target.enabled", value: "false", source: "project", path: path.join(project, ".nirvana", "config.yaml") });
    expect(byFile.message).toContain("nrv config set multi_target.enabled true");
    process.env.NIRVANA_MULTI_TARGET_ENGINE = "1"; // the legacy opt-in at 1 changes nothing
    expect(engineGate(process.env).enabled).toBe(false);
    process.env.NIRVANA_MULTI_TARGET_KILL_SWITCH = "0";
    expect(engineGate(process.env).enabled).toBe(true); // the variable wins over the file
    process.env.NIRVANA_MULTI_TARGET_KILL_SWITCH = "on";
    expect(engineGate(process.env)).toMatchObject({ enabled: false, variable: "NIRVANA_MULTI_TARGET_KILL_SWITCH", value: "on", source: "env", path: null });
  });

  test("execution.default_runtime (execution-runner.ts detectExecutionRuntime, the rule dispatch.ts applies)", () => {
    const env = { NIRVANA_HOME: home, NIRVANA_PROJECT_ROOT: project, PATH: process.env.PATH };
    projectConfig("execution:\n  default_runtime: codex\n");
    expect(detectExecutionRuntime(env).runtime).toBe("codex");
    expect(detectExecutionRuntime({ ...env, NIRVANA_DEFAULT_RUNTIME: "gemini-cli" }).runtime).toBe("gemini-cli");
  });

  test("runtime.provider_catalog_dir and runtime.allow_stale_catalog (runtime-snapshot.ts)", () => {
    const catalog = path.join(root, "catalog");
    fs.mkdirSync(catalog, { recursive: true });
    fs.writeFileSync(path.join(catalog, "provider.json"), JSON.stringify({
      schema_version: "nirvana.runtime-provider/v1alpha1",
      provider: { id: "fixture-provider" },
      catalog: { observed_at: "2026-08-24T00:00:00Z", max_age_seconds: 172800 },
      runtimes: [{ id: "codex", version: "1.2.0", capabilities: { file_read: { support: "native" } } }],
      models: [{ canonical_id: "fixture-provider/text-model/1", priority: 10, modalities: { input: ["text"], output: ["text"] }, capabilities: { tool_calling: { support: "native" } } }],
    }), "utf8");
    const env = { NIRVANA_HOME: home, NIRVANA_PROJECT_ROOT: project };
    expect(resolveCatalogDirs({ env, projectRoot: project })).toEqual([]);
    projectConfig(`runtime:\n  provider_catalog_dir: ${JSON.stringify(catalog)}\n`);
    expect(resolveCatalogDirs({ env, projectRoot: project })).toEqual([catalog]);
    expect(resolveCatalogDirs({ env: { ...env, NIRVANA_PROVIDER_CATALOG_DIR: path.join(root, "nowhere") }, projectRoot: project })).toEqual([]);

    // A year later the catalog is stale: unresolved with a warning, unless the setting accepts stale data.
    const now = () => new Date("2027-08-24T00:00:00Z");
    const stale = freezeExecutionSnapshot({ runtimeId: "codex", runtimeSource: "flag", now, env, projectRoot: project });
    expect(stale.policy?.allowStale).toBe(false);
    expect(stale.warnings?.[0]).toContain("nrv config set runtime.allow_stale_catalog true");
    globalConfig("runtime:\n  allow_stale_catalog: true\n");
    const accepted = freezeExecutionSnapshot({ runtimeId: "codex", runtimeSource: "flag", now, env, projectRoot: project });
    expect(accepted.policy?.allowStale).toBe(true);
    expect(accepted.model.resolved).toBe(true);
    const refused = freezeExecutionSnapshot({ runtimeId: "codex", runtimeSource: "flag", now, env: { ...env, NIRVANA_ALLOW_STALE_CATALOG: "0" }, projectRoot: project });
    expect(refused.policy?.allowStale).toBe(false);
  });
});

describe("no reader bypasses the core", () => {
  const SKILLS = path.resolve(import.meta.dir, "..", "..");
  const EXEMPT = new Set([
    path.join(SKILLS, "_shared", "lib", "settings.ts"),
    path.join(SKILLS, "_shared", "lib", "settings-schema.ts"),
    // The inline Node-only fallback (Bun delegates to the .ts driver on the first lines).
    path.join(SKILLS, "_shared", "lib", "host-agent-driver.js"),
  ]);

  function* sources(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "tests") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* sources(full);
      else if (/\.(ts|js)$/.test(entry.name) && !/\.test\.(ts|js)$/.test(entry.name)) yield full;
    }
  }

  test("every schema variable is read only through settings.ts across skills/**/{lib,scripts}", () => {
    const variables = SETTINGS_SCHEMA.flatMap((spec) => [spec.env, ...(spec.envAliases ?? [])]).filter((name): name is string => !!name);
    const direct = new RegExp(`(?:process\\.env\\.|\\benv\\.|\\benvironment\\.)(${variables.join("|")})\\b|(?:process\\.env|\\benv|\\benvironment)\\[["'](${variables.join("|")})["']\\]`);
    const offenders: string[] = [];
    for (const skill of fs.readdirSync(SKILLS, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      for (const sub of ["lib", "scripts"]) {
        const dir = path.join(SKILLS, skill.name, sub);
        if (!fs.existsSync(dir)) continue;
        for (const file of sources(dir)) {
          if (EXEMPT.has(file)) continue;
          const lines = fs.readFileSync(file, "utf8").split("\n");
          lines.forEach((line, index) => { if (direct.test(line)) offenders.push(`${path.relative(SKILLS, file)}:${index + 1}: ${line.trim()}`); });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
