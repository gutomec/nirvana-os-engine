// settings-schema.test.ts — the table of operational settings: every key is
// well formed, its default passes its own type, its scopes and variable are
// declared once, strict validation refuses what the type refuses with the
// message the user reads, and the legacy variable encodings round-trip: what
// a spawner pins (toEnv) is what a child reads back (readSettingEnv).
// Runs with: bun test skills/_shared/tests
import { describe, expect, test } from "bun:test";
import {
  MULTI_TARGET_ENGINE_ENV, MULTI_TARGET_KILL_SWITCH_ENV, SETTINGS, SETTINGS_SCHEMA, SETTING_KEYS,
  coerceText, getSettingSpec, parseBooleanWord, settingInfo, validateSettingValue, type SettingSpec, type SettingValue,
} from "../lib/settings-schema.ts";
import { SettingsError, readSettingEnv } from "../lib/settings.ts";

describe("the table", () => {
  test("every key is section.name, unique, described, with a default its own type accepts", () => {
    const seen = new Set<string>();
    for (const spec of SETTINGS_SCHEMA) {
      expect(spec.key).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(seen.has(spec.key)).toBe(false);
      seen.add(spec.key);
      expect(spec.description.length).toBeGreaterThan(10);
      expect(spec.expects.length).toBeGreaterThan(0);
      expect(spec.scopes.length).toBeGreaterThan(0);
      expect(spec.secret).toBe(false);
      expect(validateSettingValue(spec, spec.default)).toEqual({ ok: true, value: spec.default });
      if (spec.kind === "enum") expect(spec.options).toContain(spec.default as string);
    }
    expect(SETTING_KEYS).toEqual(SETTINGS_SCHEMA.map((spec) => spec.key));
    expect(getSettingSpec("routing.mode")).toBe(SETTINGS["routing.mode"]);
    expect(getSettingSpec("nope")).toBeUndefined();
  });

  test("a variable names one key only, aliases included", () => {
    const owners = new Map<string, string>();
    for (const spec of SETTINGS_SCHEMA) {
      for (const variable of [spec.env, ...(spec.envAliases ?? [])]) {
        if (!variable) continue;
        expect(variable).toMatch(/^NIRVANA_[A-Z_]+$/);
        expect(owners.has(variable)).toBe(false);
        owners.set(variable, spec.key);
      }
    }
    expect(owners.get(MULTI_TARGET_KILL_SWITCH_ENV)).toBe("multi_target.enabled");
    expect(owners.get(MULTI_TARGET_ENGINE_ENV)).toBe("multi_target.enabled");
  });

  test("the keys the brief named are all there, with their legacy variables", () => {
    const expected: Record<string, string | null> = {
      "multi_target.enabled": "NIRVANA_MULTI_TARGET_KILL_SWITCH",
      "gauntlet.default_mode": "NIRVANA_EXECUTION_MODE",
      "gauntlet.default_intensity": "NIRVANA_GAUNTLET_INTENSITY",
      "gauntlet.evaluator": "NIRVANA_GAUNTLET_EVALUATOR",
      "gauntlet.business_allowlist": "NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST",
      "gauntlet.business_kill_switch": "NIRVANA_BUSINESS_GAUNTLET_KILL_SWITCH",
      "gauntlet.auto_allowed": "NIRVANA_ALLOW_AUTO_GAUNTLET",
      "execution.default_runtime": "NIRVANA_DEFAULT_RUNTIME",
      "execution.headless_skip_permissions": "NIRVANA_HEADLESS_SKIP_PERMISSIONS",
      "execution.model": "NIRVANA_MODEL",
      "execution.dna_injection": "NIRVANA_DNA_INJECTION",
      "glance.execution": "NIRVANA_GLANCE_EXECUTION",
      "runtime.provider_catalog_dir": "NIRVANA_PROVIDER_CATALOG_DIR",
      "runtime.allow_stale_catalog": "NIRVANA_ALLOW_STALE_CATALOG",
      "routing.mode": "NIRVANA_ROUTING_MODE",
      "routing.dense": "NIRVANA_ROUTER_DENSE",
      "routing.on_router_failure": null,
      "supervisor.progress_ping_sec": "NIRVANA_PROGRESS_PING_SEC",
      "supervisor.stall_threshold_ms": "NIRVANA_STALL_THRESHOLD_MS",
      "updates.check": "NIRVANA_NO_UPDATE_CHECK",
      "budget.default_max_cost_usd": null,
      "quality_gate.judge_enabled": null,
      "quality_gate.max_revisions": null,
      "verify.mode": "NIRVANA_VERIFY_MODE",
      "verify.enforce_on_install": "NIRVANA_VERIFY_ENFORCE_ON_INSTALL",
      "verify.enforce_on_activate": "NIRVANA_VERIFY_ENFORCE_ON_ACTIVATE",
    };
    for (const [key, variable] of Object.entries(expected)) expect(getSettingSpec(key)?.env).toBe(variable);
  });

  test("updates.check lives in the global scope only; every other key accepts both", () => {
    for (const spec of SETTINGS_SCHEMA) {
      if (spec.key === "updates.check") expect(spec.scopes).toEqual(["global"]);
      else expect(spec.scopes).toEqual(["global", "project"]);
    }
  });

  test("settingInfo is the spec without its zod type, JSON-safe", () => {
    const info = settingInfo(SETTINGS["routing.dense"]);
    expect(info).toEqual({
      key: "routing.dense", kind: "enum", default: "off", scopes: ["global", "project"], description: SETTINGS["routing.dense"].description,
      expects: "off | fallback", options: ["off", "fallback"], env: "NIRVANA_ROUTER_DENSE", envAliases: [], secret: false,
    });
    expect(JSON.parse(JSON.stringify(info))).toEqual(info);
  });
});

describe("validation", () => {
  const cases: Array<[string, unknown, boolean, RegExp?]> = [
    ["routing.mode", "fast", true],
    ["routing.mode", "turbo", false, /routing\.mode: valor inválido "turbo"; esperado agentic \| fast/],
    ["multi_target.enabled", true, true],
    ["multi_target.enabled", "true", false, /esperado true \| false/],
    ["quality_gate.max_revisions", 3, true],
    ["quality_gate.max_revisions", -1, false, /inteiro >= 0/],
    ["quality_gate.max_revisions", 1.5, false],
    ["supervisor.stall_threshold_ms", 0, false, /inteiro > 0/],
    ["budget.default_max_cost_usd", 2.5, true],
    ["gauntlet.evaluator", "squad:spec-judge:quality.specification_conformance", true],
    ["gauntlet.evaluator", "squad:spec-judge", true],
    ["gauntlet.evaluator", "judge-x", true],
    ["gauntlet.evaluator", "", true],
    ["gauntlet.evaluator", "my-judge", false, /squad:<slug>/],
    ["gauntlet.business_allowlist", "a-biz, other.biz", true],
    ["gauntlet.business_allowlist", "a biz", false],
    ["execution.default_runtime", "claude-code", true],
    ["execution.default_runtime", "claude code", false],
    ["quality_gate.rubric_fallback", "", false],
  ];
  for (const [key, value, ok, message] of cases) {
    test(`${key} ${JSON.stringify(value)} → ${ok ? "accepted" : "refused"}`, () => {
      const verdict = validateSettingValue(getSettingSpec(key)!, value);
      expect(verdict.ok).toBe(ok);
      if (!verdict.ok && message) expect(verdict.message).toMatch(message);
    });
  }

  test("coerceText reads a CLI argument by kind and leaves the unreadable as text for the refusal", () => {
    expect(coerceText(SETTINGS["multi_target.enabled"], "on")).toBe(true);
    expect(coerceText(SETTINGS["multi_target.enabled"], "No")).toBe(false);
    expect(coerceText(SETTINGS["multi_target.enabled"], "maybe")).toBe("maybe");
    expect(coerceText(SETTINGS["quality_gate.max_revisions"], " 4 ")).toBe(4);
    expect(coerceText(SETTINGS["quality_gate.max_revisions"], "four")).toBe("four");
    expect(coerceText(SETTINGS["quality_gate.max_revisions"], "")).toBe("");
    expect(coerceText(SETTINGS["routing.mode"], "fast")).toBe("fast");
    expect(parseBooleanWord("YES")).toBe(true);
    expect(parseBooleanWord("0")).toBe(false);
    expect(parseBooleanWord("")).toBeNull();
  });
});

describe("legacy variables", () => {
  const read = (spec: SettingSpec, env: Record<string, string>) => readSettingEnv(spec, env);

  test("what a spawner pins is what a child reads back, for every key with a variable", () => {
    for (const spec of SETTINGS_SCHEMA) {
      if (!spec.env) continue;
      const samples: SettingValue[] = spec.kind === "enum" ? [...spec.options!]
        : spec.kind === "boolean" ? [true, false]
        : spec.kind === "number" ? [spec.default, 7]
        : [spec.default, spec.key === "gauntlet.evaluator" ? "squad:spec-judge" : "sample-value"];
      for (const value of samples) {
        const text = (spec.toEnv as (value: SettingValue) => string | null)(value);
        if (text === null) continue; // the variable cannot spell this value; the child resolves it itself
        const reading = read(spec, { [spec.env]: text });
        expect(reading, `${spec.key} ← ${spec.env}=${text}`).toEqual({ variable: spec.env, raw: text, value });
      }
    }
  });

  test("an empty string is unset, whichever the key", () => {
    for (const spec of SETTINGS_SCHEMA) {
      if (!spec.env) continue;
      expect(read(spec, { [spec.env]: "" })).toBeNull();
      expect(read(spec, { [spec.env]: "   " })).toBeNull();
    }
  });

  test("the multi-target kill switch and the legacy opt-in flag", () => {
    const spec = SETTINGS["multi_target.enabled"];
    for (const raw of ["1", "true", "on", "ON"]) expect(read(spec, { NIRVANA_MULTI_TARGET_KILL_SWITCH: raw })?.value).toBe(false);
    for (const raw of ["0", "false", "off"]) expect(read(spec, { NIRVANA_MULTI_TARGET_KILL_SWITCH: raw })?.value).toBe(true);
    for (const raw of ["0", "false", "off"]) expect(read(spec, { NIRVANA_MULTI_TARGET_ENGINE: raw })).toEqual({ variable: "NIRVANA_MULTI_TARGET_ENGINE", raw, value: false });
    expect(read(spec, { NIRVANA_MULTI_TARGET_ENGINE: "1" })).toBeNull(); // accepted, no effect
    expect(read(spec, { NIRVANA_MULTI_TARGET_ENGINE: "1", NIRVANA_MULTI_TARGET_KILL_SWITCH: "on" })?.variable).toBe("NIRVANA_MULTI_TARGET_KILL_SWITCH");
    expect(() => read(spec, { NIRVANA_MULTI_TARGET_KILL_SWITCH: "maybe" })).toThrow(SettingsError);
    expect(() => read(spec, { NIRVANA_MULTI_TARGET_KILL_SWITCH: "maybe" })).toThrow(/NIRVANA_MULTI_TARGET_KILL_SWITCH=maybe inválido para multi_target\.enabled/);
    expect(spec.toEnv!(true)).toBe("0");
    expect(spec.toEnv!(false)).toBe("1");
  });

  test("NIRVANA_NO_UPDATE_CHECK is an opt-out of updates.check", () => {
    const spec = SETTINGS["updates.check"];
    for (const raw of ["1", "true", "yes"]) expect(read(spec, { NIRVANA_NO_UPDATE_CHECK: raw })?.value).toBe(false);
    expect(read(spec, { NIRVANA_NO_UPDATE_CHECK: "0" })?.value).toBe(true);
    expect(spec.toEnv!(false)).toBe("1");
    expect(spec.toEnv!(true)).toBeNull();
  });

  test("the switches whose variable only turns them off keep today's reading: an off word disables, anything else is on", () => {
    for (const key of ["execution.headless_skip_permissions", "glance.execution"] as const) {
      const spec = SETTINGS[key];
      for (const raw of ["0", "false", "off", "no", "NO"]) expect(read(spec, { [spec.env!]: raw })?.value).toBe(false);
      for (const raw of ["1", "true", "on", "whatever"]) expect(read(spec, { [spec.env!]: raw })?.value).toBe(true);
    }
  });

  test("NIRVANA_ROUTER_DENSE speaks 1/0 and the mode names", () => {
    const spec = SETTINGS["routing.dense"];
    expect(read(spec, { NIRVANA_ROUTER_DENSE: "1" })?.value).toBe("fallback");
    expect(read(spec, { NIRVANA_ROUTER_DENSE: "0" })?.value).toBe("off");
    expect(read(spec, { NIRVANA_ROUTER_DENSE: "fallback" })?.value).toBe("fallback");
    expect(() => read(spec, { NIRVANA_ROUTER_DENSE: "2" })).toThrow(/NIRVANA_ROUTER_DENSE=2 inválido para routing\.dense; esperado off \| fallback/);
  });

  test("a number variable must be a number, an enum variable one of its choices", () => {
    expect(read(SETTINGS["supervisor.progress_ping_sec"], { NIRVANA_PROGRESS_PING_SEC: "60" })?.value).toBe(60);
    expect(() => read(SETTINGS["supervisor.progress_ping_sec"], { NIRVANA_PROGRESS_PING_SEC: "soon" })).toThrow(/NIRVANA_PROGRESS_PING_SEC=soon/);
    expect(() => read(SETTINGS["gauntlet.default_mode"], { NIRVANA_EXECUTION_MODE: "forever" })).toThrow(/esperado standard \| gauntlet \| auto/);
  });

  test("a string setting pins nothing when empty and its text otherwise", () => {
    expect(SETTINGS["execution.model"].toEnv!("")).toBeNull();
    expect(SETTINGS["execution.model"].toEnv!("opus")).toBe("opus");
    expect(SETTINGS["supervisor.stall_threshold_ms"].toEnv!(300000)).toBe("300000");
  });
});
