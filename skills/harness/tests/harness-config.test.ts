// harness-config.test.ts — the harness view over the settings core.
//
// Pins: routing.dense parsing ("off"|"fallback"), quality_gate defaults, the
// layered resolution loadHarnessConfig reads through (project > global >
// engine file), env precedence in denseRoutingMode, the clear error a
// malformed file or an invalid value raises (never a silent default), and the
// comment-preserving setRoutingDense edit (only the dense line moves; every
// comment byte survives; without a path it writes the user's global config).
// Runs with: bun test skills/harness/tests
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadHarnessConfig,
  denseRoutingMode,
  setRoutingDense,
} from "../lib/harness-config.ts";
import { _resetSettingsCache } from "../../_shared/lib/settings.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-config-test-"));
const write = (name: string, content: string) => {
  const p = path.join(tmp, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
};

const MANAGED = ["NIRVANA_ROUTER_DENSE", "NIRVANA_HOME", "NIRVANA_PROJECT_ROOT", "HARNESS_LOGS_DIR"];
const saved: Record<string, string | undefined> = Object.fromEntries(MANAGED.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of MANAGED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  _resetSettingsCache();
});

describe("loadHarnessConfig", () => {
  test('parses routing.dense: "fallback"', () => {
    const p = write("a.yaml", 'routing:\n  mode: agentic\n  dense: "fallback"\n');
    expect(loadHarnessConfig(p).routing.dense).toBe("fallback");
  });

  test('parses unquoted dense: off as the string mode "off"', () => {
    const p = write("b.yaml", "routing:\n  dense: off\n");
    // yaml v2 core schema reads `off` as a plain string; a boolean-reading
    // parser would fail validation and raise, never land on a silent default.
    expect(loadHarnessConfig(p).routing.dense).toBe("off");
  });

  test("an unknown value is a clear error naming the file, the key and the choices", () => {
    const p = write("c.yaml", 'routing:\n  dense: "always"\n');
    expect(() => loadHarnessConfig(p)).toThrow(/c\.yaml.*routing\.dense.*off \| fallback/);
  });

  test("missing file / missing keys → defaults", () => {
    expect(loadHarnessConfig(path.join(tmp, "missing.yaml")).routing.dense).toBe("off");
    const p = write("d.yaml", "budget:\n  default_max_cost_usd: 0\n");
    const cfg = loadHarnessConfig(p);
    expect(cfg.routing.dense).toBe("off");
    expect(cfg.quality_gate.judge_enabled).toBe(false);
    expect(cfg.quality_gate.max_revisions).toBe(2);
  });

  test("malformed YAML is a clear error naming the file, never a silent default", () => {
    const p = write("e.yaml", "routing: [unclosed\n  dense: fallback");
    expect(() => loadHarnessConfig(p)).toThrow(/e\.yaml.*YAML/);
  });

  test("quality_gate reads the keys it knows and fills defaults for the rest", () => {
    const p = write("f.yaml", "quality_gate:\n  judge_enabled: true\n  custom_key: 7\n");
    const qg = loadHarnessConfig(p).quality_gate;
    expect(qg.judge_enabled).toBe(true);
    expect(qg.rubric_fallback).toBe("prose_shortform"); // default filled
    expect(qg.max_revisions).toBe(2);
  });

  test("the committed config.yaml parses and its dense default is off", () => {
    const committed = path.join(import.meta.dir, "..", "config.yaml");
    const cfg = loadHarnessConfig(committed);
    expect(cfg.routing.dense).toBe("off"); // Phase 3.4 DECISION — default off
    expect(cfg.quality_gate.judge_enabled).toBe(false); // Phase 4: judge stays opt-in
    expect(cfg.config_path).toBe(committed);
  });

  // routing.on_router_failure — Phase 4 router-failure ladder policy.
  test('on_router_failure defaults to "cascade" and accepts "fail"', () => {
    expect(loadHarnessConfig(path.join(tmp, "missing2.yaml")).routing.on_router_failure).toBe("cascade");
    const p = write("orf.yaml", 'routing:\n  on_router_failure: "fail"\n');
    expect(loadHarnessConfig(p).routing.on_router_failure).toBe("fail");
  });

  test("an unknown on_router_failure is a clear error", () => {
    const p = write("orf-bad.yaml", "routing:\n  on_router_failure: explode\n");
    expect(() => loadHarnessConfig(p)).toThrow(/orf-bad\.yaml.*routing\.on_router_failure.*cascade \| fail/);
  });

  test("without an explicit path the project and the global config apply over the engine file", () => {
    const home = path.join(tmp, "home-layers");
    const project = path.join(tmp, "project-layers");
    write("home-layers/.nirvana/config.yaml", "quality_gate:\n  max_revisions: 5\nrouting:\n  on_router_failure: fail\n");
    write("project-layers/.nirvana/config.yaml", "routing:\n  on_router_failure: cascade\n  dense: fallback\n");
    process.env.NIRVANA_HOME = home;
    process.env.NIRVANA_PROJECT_ROOT = project;
    delete process.env.NIRVANA_ROUTER_DENSE;
    const cfg = loadHarnessConfig();
    expect(cfg.quality_gate.max_revisions).toBe(5);          // global
    expect(cfg.routing.on_router_failure).toBe("cascade");   // project over global
    expect(cfg.routing.dense).toBe("fallback");              // project
    expect(cfg.config_path).toBe(path.join(import.meta.dir, "..", "config.yaml"));
  });
});

describe("denseRoutingMode — env precedence", () => {
  test("NIRVANA_ROUTER_DENSE=1 overrides a config that says off", () => {
    const p = write("g.yaml", 'routing:\n  dense: "off"\n');
    process.env.NIRVANA_ROUTER_DENSE = "1";
    expect(denseRoutingMode(p)).toBe("fallback");
  });

  test("NIRVANA_ROUTER_DENSE=0 overrides a config that says fallback", () => {
    const p = write("h.yaml", 'routing:\n  dense: "fallback"\n');
    process.env.NIRVANA_ROUTER_DENSE = "0";
    expect(denseRoutingMode(p)).toBe("off");
  });

  test("without env the config decides", () => {
    delete process.env.NIRVANA_ROUTER_DENSE;
    const p = write("i.yaml", 'routing:\n  dense: "fallback"\n');
    expect(denseRoutingMode(p)).toBe("fallback");
  });
});

describe("setRoutingDense — comment-preserving edit", () => {
  test("rewrites only the dense line, keeps comments and inline comment", () => {
    const src = [
      "# top comment",
      "routing:",
      "  # dense controls the neural arm",
      '  dense: "off"   # persisted by nrv embeddings',
      "  mode: agentic",
      "other:",
      "  dense: untouched-not-in-routing",
      "",
    ].join("\n");
    const p = write("j.yaml", src);
    expect(setRoutingDense("fallback", p)).toBe(p);
    const out = fs.readFileSync(p, "utf8");
    expect(out).toContain('  dense: "fallback"   # persisted by nrv embeddings');
    expect(out).toContain("# top comment");
    expect(out).toContain("  # dense controls the neural arm");
    expect(out).toContain("  dense: untouched-not-in-routing"); // other block untouched
    expect(loadHarnessConfig(p).routing.dense).toBe("fallback");
  });

  test("inserts the key when the routing block lacks it", () => {
    const p = write("k.yaml", "routing:\n  mode: agentic\n");
    setRoutingDense("fallback", p);
    expect(loadHarnessConfig(p).routing.dense).toBe("fallback");
    expect(fs.readFileSync(p, "utf8")).toContain("  mode: agentic"); // untouched
  });

  test("appends a routing block when none exists", () => {
    const p = write("l.yaml", "budget:\n  default_max_cost_usd: 0\n");
    setRoutingDense("fallback", p);
    expect(loadHarnessConfig(p).routing.dense).toBe("fallback");
  });

  test("round-trips off → fallback → off", () => {
    const p = write("m.yaml", 'routing:\n  dense: "off"\n');
    setRoutingDense("fallback", p);
    expect(loadHarnessConfig(p).routing.dense).toBe("fallback");
    setRoutingDense("off", p);
    expect(loadHarnessConfig(p).routing.dense).toBe("off");
  });

  test("returns null when there is no explicit file to edit", () => {
    expect(setRoutingDense("fallback", path.join(tmp, "nope.yaml"))).toBeNull();
  });

  test("without a path it writes the user's global config (created when absent) and audits x_settings_changed", () => {
    const home = path.join(tmp, "home-write");
    const logs = path.join(tmp, "logs-write");
    process.env.NIRVANA_HOME = home;
    process.env.HARNESS_LOGS_DIR = logs;
    process.env.NIRVANA_PROJECT_ROOT = path.join(tmp, "no-project-here");
    delete process.env.NIRVANA_ROUTER_DENSE;
    const globalFile = path.join(home, ".nirvana", "config.yaml");
    expect(setRoutingDense("fallback")).toBe(globalFile);
    expect(fs.readFileSync(globalFile, "utf8")).toContain('dense: "fallback"');
    expect(denseRoutingMode()).toBe("fallback");
    const day = fs.readdirSync(logs).find((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))!;
    const events = fs.readFileSync(path.join(logs, day, "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({ event: "x_settings_changed", key: "routing.dense", scope: "global", from: null, to: "fallback" }));
  });
});
