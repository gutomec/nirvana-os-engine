// harness-config.test.ts — typed reader for skills/harness/config.yaml.
//
// Pins: routing.dense parsing ("off"|"fallback", anything else → "off"),
// quality_gate passthrough with defaults, env precedence in denseRoutingMode,
// and the comment-preserving setRoutingDense edit (only the dense line moves;
// every comment byte survives).
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-config-test-"));
const write = (name: string, content: string) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
};

const savedEnv = process.env.NIRVANA_ROUTER_DENSE;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.NIRVANA_ROUTER_DENSE;
  else process.env.NIRVANA_ROUTER_DENSE = savedEnv;
});

describe("loadHarnessConfig", () => {
  test('parses routing.dense: "fallback"', () => {
    const p = write("a.yaml", 'routing:\n  mode: agentic\n  dense: "fallback"\n');
    expect(loadHarnessConfig(p).routing.dense).toBe("fallback");
  });

  test('parses unquoted dense: off as the string mode "off"', () => {
    const p = write("b.yaml", "routing:\n  dense: off\n");
    // yaml v2 core schema reads `off` as a plain string; a boolean-reading
    // parser would fail normalizeDense and land on the default — same result.
    expect(loadHarnessConfig(p).routing.dense).toBe("off");
  });

  test('unknown values degrade to "off"', () => {
    const p = write("c.yaml", 'routing:\n  dense: "always"\n');
    expect(loadHarnessConfig(p).routing.dense).toBe("off");
  });

  test("missing file / missing keys → defaults", () => {
    expect(loadHarnessConfig(path.join(tmp, "missing.yaml")).routing.dense).toBe("off");
    const p = write("d.yaml", "budget:\n  default_max_cost_usd: 0\n");
    const cfg = loadHarnessConfig(p);
    expect(cfg.routing.dense).toBe("off");
    expect(cfg.quality_gate.judge_enabled).toBe(false);
    expect(cfg.quality_gate.max_revisions).toBe(2);
  });

  test("malformed YAML degrades to defaults, never throws", () => {
    const p = write("e.yaml", "routing: [unclosed\n  dense: fallback");
    expect(loadHarnessConfig(p).routing.dense).toBe("off");
  });

  test("quality_gate passthrough keeps user values and fills defaults", () => {
    const p = write("f.yaml", "quality_gate:\n  judge_enabled: true\n  custom_key: 7\n");
    const qg = loadHarnessConfig(p).quality_gate;
    expect(qg.judge_enabled).toBe(true);
    expect(qg.custom_key).toBe(7);
    expect(qg.rubric_fallback).toBe("prose_shortform"); // default filled
  });

  test("the committed config.yaml parses and its dense default is off", () => {
    const committed = path.join(import.meta.dir, "..", "config.yaml");
    const cfg = loadHarnessConfig(committed);
    expect(cfg.routing.dense).toBe("off"); // Phase 3.4 DECISION — default off
    expect(cfg.quality_gate.judge_enabled).toBe(false); // Phase 4: judge stays opt-in
  });

  // routing.on_router_failure — Phase 4 router-failure ladder policy.
  test('on_router_failure defaults to "cascade" and accepts "fail"', () => {
    expect(loadHarnessConfig(path.join(tmp, "missing2.yaml")).routing.on_router_failure).toBe("cascade");
    const p = write("orf.yaml", 'routing:\n  on_router_failure: "fail"\n');
    expect(loadHarnessConfig(p).routing.on_router_failure).toBe("fail");
  });

  test('unknown on_router_failure values degrade to "cascade"', () => {
    const p = write("orf-bad.yaml", "routing:\n  on_router_failure: explode\n");
    expect(loadHarnessConfig(p).routing.on_router_failure).toBe("cascade");
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

  test("returns null when there is no config file to edit", () => {
    expect(setRoutingDense("fallback", path.join(tmp, "nope.yaml"))).toBeNull();
  });
});
