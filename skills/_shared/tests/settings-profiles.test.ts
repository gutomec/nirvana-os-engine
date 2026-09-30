// settings-profiles.test.ts — the performance profiles as a layer of the one
// resolution path: every preset validates against the schema, a profile moves
// its keys and nothing else, the user's own files and env still win over it,
// and the profile itself comes from the same layers as any key.
// Hermetic: every layer is an explicit temp path. Runs with: bun test skills/_shared/tests
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PROFILE_NAMES, PROFILE_PRESETS, profileValue } from "../lib/profiles.ts";
import {
  _resetSettingsCache, describeSettingSource, getSettingSpec, globalConfigPath, resolveSetting, validateSettingValue, type ResolveOptions,
} from "../lib/settings.ts";

let tmp: string;
let base: ResolveOptions;
let engine: string;

const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-profiles-")));
  const home = path.join(tmp, "home");
  const project = path.join(tmp, "project");
  engine = path.join(tmp, "engine-config.yaml");
  fs.mkdirSync(path.join(project, ".nirvana"), { recursive: true });
  fs.writeFileSync(path.join(project, ".nirvana", "project.yaml"), "{}\n");
  fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
  base = { env: {}, projectRoot: project, globalPath: globalConfigPath({ NIRVANA_HOME: home }), enginePath: engine };
  _resetSettingsCache();
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("the presets", () => {
  test("every key exists in the schema and every value validates", () => {
    for (const name of PROFILE_NAMES) {
      for (const [key, value] of Object.entries(PROFILE_PRESETS[name])) {
        const spec = getSettingSpec(key);
        expect(spec, `${name}: ${key} is not a setting`).toBeDefined();
        expect(validateSettingValue(spec!, value).ok, `${name}: ${key}=${value}`).toBe(true);
      }
    }
  });

  test("no profile pins a model: one id cannot fit every runtime", () => {
    for (const name of PROFILE_NAMES) expect(profileValue(name, "execution.model")).toBeUndefined();
  });

  test("the three profiles order from most to least context", () => {
    const ceiling = (name: string) => Number(profileValue(name, "execution.context_window"));
    expect(ceiling("max")).toBe(0);
    expect(ceiling("balanced")).toBeGreaterThan(ceiling("economy"));
  });
});

describe("the profile layer", () => {
  test("no profile: the engine defaults hold", () => {
    expect(resolveSetting("execution.business_mode", base).value).toBe("chain");
    expect(resolveSetting("execution.profile", base).source).toBe("default");
  });

  test("a profile in the global file moves its keys, and names itself as the origin", () => {
    write(base.globalPath!, "execution:\n  profile: \"economy\"\n");
    const mode = resolveSetting("execution.business_mode", base);
    expect(mode).toEqual({ key: "execution.business_mode", value: "solo", source: "profile", profile: "economy" });
    expect(describeSettingSource(mode)).toBe("profile economy");
    expect(resolveSetting("execution.context_window", base).value).toBe(200000);
    expect(resolveSetting("review.policy", base).value).toBe("on-request");
  });

  test("a key the profile does not set keeps its own origin", () => {
    write(base.globalPath!, "execution:\n  profile: \"balanced\"\n");
    expect(resolveSetting("execution.max_dispatch_depth", base).source).toBe("default");
  });

  test("the profile outranks the engine defaults", () => {
    write(engine, "routing:\n  mode: agentic\n");
    write(base.globalPath!, "execution:\n  profile: \"balanced\"\n");
    expect(resolveSetting("routing.mode", base)).toMatchObject({ value: "cards", source: "profile" });
  });

  test("an explicit key in the project or global file wins over the profile", () => {
    write(base.globalPath!, "execution:\n  profile: \"economy\"\n  effort: \"xhigh\"\n");
    expect(resolveSetting("execution.effort", base)).toMatchObject({ value: "xhigh", source: "global" });
    write(path.join(base.projectRoot!, ".nirvana", "config.yaml"), "review:\n  policy: \"always\"\n");
    expect(resolveSetting("review.policy", base)).toMatchObject({ value: "always", source: "project" });
  });

  test("the environment wins over the profile, and can pick the profile itself", () => {
    write(base.globalPath!, "execution:\n  profile: \"economy\"\n");
    expect(resolveSetting("execution.context_window", { ...base, env: { NIRVANA_CONTEXT_WINDOW: "300000" } }).value).toBe(300000);
    expect(resolveSetting("execution.context_window", { ...base, env: { NIRVANA_PROFILE: "max" } })).toMatchObject({ value: 0, source: "profile", profile: "max" });
  });

  test("a project profile overrides the global one", () => {
    write(base.globalPath!, "execution:\n  profile: \"economy\"\n");
    write(path.join(base.projectRoot!, ".nirvana", "config.yaml"), "execution:\n  profile: \"max\"\n");
    expect(resolveSetting("review.policy", base)).toMatchObject({ value: "always", profile: "max" });
  });
});
