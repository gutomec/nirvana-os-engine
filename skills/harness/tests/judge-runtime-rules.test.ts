// judge-runtime-rules.test.ts — the judge consults runtime-rules
// (decideRuntime) for its host instead of blindly taking the first CLI on
// PATH, with the PATH scan kept as the no-signal fallback. Seam-injected:
// __testRuntimeRules replaces the rules module, __testDriver captures the
// CallOpts handed to callHostAgentAsync.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-judge-rules-test-"));
process.env.HARNESS_LOGS_DIR = path.join(TMP, "harness-logs");

import { judge, type JudgeInput } from "../lib/judge.ts";
import type { RubricMeta } from "../lib/rubric-selector.ts";

const RUBRIC = {
  name: "test-rubric",
  display_name: "Test rubric",
  pass_threshold: 70,
  target_model: "any",
  body: "## Criteria\n- looks fine\n",
} as RubricMeta;

const VERDICT_JSON = JSON.stringify({ verdict: "pass", total_score: 90, criteria_scores: [], critique: [] });

function fakeDriver(captured: Array<Record<string, unknown>>, availableRuntimes?: string[]) {
  return {
    runtimeAvailable: (r: string) => (availableRuntimes ? availableRuntimes.includes(r) : true),
    callHostAgentAsync: async (_persona: string, _msg: string, opts: Record<string, unknown>) => {
      captured.push(opts);
      return { text: VERDICT_JSON, host: (opts.preferredHost as string) ?? "path-scan-host", exit_code: 0 };
    },
  };
}

function input(brief?: string): JudgeInput {
  return { rubric: RUBRIC, artifact: "the artifact body", brief };
}

describe("judge — runtime-rules consultation", () => {
  test("decideRuntime's pick flows into callHostAgentAsync as preferredHost", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const decideCalls: Array<Record<string, unknown>> = [];
    const rules = [{ runtime: "codex", rule: "sempre que for julgar artefatos", envKey: "USE_CODEX", sourceFile: null, negate: false }];
    const out = await judge(input("julgue este relatório"), {
      __testDriver: fakeDriver(captured),
      __testRuntimeRules: {
        loadRuntimeRules: () => rules,
        detectCurrentHost: () => "claude-code",
        decideRuntime: (o: Record<string, unknown>) => { decideCalls.push(o); return { runtime: "codex", source: "rule", rule: rules[0] }; },
      },
    });
    expect(out.verdict).toBe("pass");
    expect(out.judge_runtime).toBe("codex");
    expect(captured[0].preferredHost).toBe("codex");
    // The consultation ran in fast mode with the judge's brief and an
    // availability probe wired to the driver.
    expect(decideCalls[0].mode).toBe("fast");
    expect(decideCalls[0].brief).toBe("julgue este relatório");
    expect(decideCalls[0].defaultRuntime).toBe("claude-code");
    expect(typeof decideCalls[0].available).toBe("function");
  });

  test("no rules AND no detectable session host → PATH-scan fallback (no preferredHost)", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const out = await judge(input("qualquer brief"), {
      __testDriver: fakeDriver(captured),
      __testRuntimeRules: {
        loadRuntimeRules: () => [],
        detectCurrentHost: () => null,
        decideRuntime: () => { throw new Error("must not be consulted without a signal"); },
      },
    });
    expect(out.verdict).toBe("pass");
    expect(captured[0].preferredHost).toBeUndefined();
    expect(out.judge_runtime).toBe("path-scan-host");
  });

  test("synthetic default (source=default with no session host) → PATH-scan fallback", async () => {
    const captured: Array<Record<string, unknown>> = [];
    await judge(input("brief sem match"), {
      __testDriver: fakeDriver(captured),
      __testRuntimeRules: {
        loadRuntimeRules: () => [{ runtime: "codex", rule: "algo sem relação", envKey: "USE_CODEX", sourceFile: null, negate: false }],
        detectCurrentHost: () => null,
        decideRuntime: () => ({ runtime: "claude-code", source: "default" }),
      },
    });
    expect(captured[0].preferredHost).toBeUndefined();
  });

  test("session host with no rules is still a signal (judge follows the host)", async () => {
    const captured: Array<Record<string, unknown>> = [];
    await judge(input("qualquer brief"), {
      __testDriver: fakeDriver(captured),
      __testRuntimeRules: {
        loadRuntimeRules: () => [],
        detectCurrentHost: () => "pi",
        decideRuntime: (o: Record<string, unknown>) => ({ runtime: o.defaultRuntime, source: "default" }),
      },
    });
    expect(captured[0].preferredHost).toBe("pi");
  });

  test("rules module exploding falls back to PATH scan instead of failing the judge", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const out = await judge(input("brief"), {
      __testDriver: fakeDriver(captured),
      __testRuntimeRules: {
        loadRuntimeRules: () => { throw new Error("env parse exploded"); },
        detectCurrentHost: () => "claude-code",
        decideRuntime: () => ({ runtime: "codex", source: "rule" }),
      },
    });
    expect(out.verdict).toBe("pass");
    expect(captured[0].preferredHost).toBeUndefined();
  });
});
