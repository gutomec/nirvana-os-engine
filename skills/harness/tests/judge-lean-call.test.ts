// judge-lean-call.test.ts — the quality judge asks its runtime for an answer
// only, at the effort `quality_gate.judge_effort` names, and the driver turns
// that into the flags each CLI understands. At the runtime's default effort the
// judge spent 82 s and US$ 0.56 on one LinkedIn post (2026-11-23).
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-judge-lean-"));
process.env.HARNESS_LOGS_DIR = path.join(TMP, "harness-logs");

import { judge, judgeBatch } from "../lib/judge.ts";
import { __testables } from "../../_shared/lib/host-agent-driver.ts";
import { PROFILE_PRESETS } from "../../_shared/lib/profiles.ts";
import type { RubricMeta } from "../lib/rubric-selector.ts";

const RUBRIC = { name: "r", display_name: "R", pass_threshold: 70, target_model: "any", body: "## Criteria\n- fine\n" } as RubricMeta;
const VERDICT = { verdict: "pass", total_score: 90, criteria_scores: [], critique: [] };

function fakeDriver(captured: Array<Record<string, unknown>>, text: string) {
  return {
    runtimeAvailable: () => true,
    callHostAgentAsync: async (_p: string, _m: string, opts: Record<string, unknown>) => { captured.push(opts); return { text, host: "claude-code", exit_code: 0 }; },
  };
}
const noRules = { loadRuntimeRules: () => [], detectCurrentHost: () => null, decideRuntime: () => ({ runtime: null, source: "none" }) };

const saved = process.env.NIRVANA_JUDGE_EFFORT;
afterEach(() => { if (saved === undefined) delete process.env.NIRVANA_JUDGE_EFFORT; else process.env.NIRVANA_JUDGE_EFFORT = saved; });

describe("what the judge asks for", () => {
  test("one file: answer-only, effort from the setting", async () => {
    process.env.NIRVANA_JUDGE_EFFORT = "low";
    const captured: Array<Record<string, unknown>> = [];
    await judge({ rubric: RUBRIC, artifact: "a" }, { __testDriver: fakeDriver(captured, JSON.stringify(VERDICT)), __testRuntimeRules: noRules });
    expect(captured[0].answerOnly).toBe(true);
    expect(captured[0].effort).toBe("low");
  });

  test("a batch: the same", async () => {
    process.env.NIRVANA_JUDGE_EFFORT = "medium";
    const captured: Array<Record<string, unknown>> = [];
    const text = JSON.stringify({ verdicts: [{ file: "F1", rubric: "r", ...VERDICT }] });
    await judgeBatch({ items: [{ id: "F1", artifact: "a", rubrics: [RUBRIC] }] } as never, { __testDriver: fakeDriver(captured, text), __testRuntimeRules: noRules });
    expect(captured[0].answerOnly).toBe(true);
    expect(captured[0].effort).toBe("medium");
  });

  test("`model` passes no effort: the runtime keeps its own default", async () => {
    process.env.NIRVANA_JUDGE_EFFORT = "model";
    const captured: Array<Record<string, unknown>> = [];
    await judge({ rubric: RUBRIC, artifact: "a" }, { __testDriver: fakeDriver(captured, JSON.stringify(VERDICT)), __testRuntimeRules: noRules });
    expect(captured[0].answerOnly).toBe(true);
    expect("effort" in captured[0]).toBe(false);
  });

  test("the profiles: max keeps the default, balanced medium, economy low", () => {
    expect(PROFILE_PRESETS.max["quality_gate.judge_effort"]).toBe("model");
    expect(PROFILE_PRESETS.balanced["quality_gate.judge_effort"]).toBe("medium");
    expect(PROFILE_PRESETS.economy["quality_gate.judge_effort"]).toBe("low");
  });
});

describe("what the driver passes to each CLI", () => {
  const byName = (n: string) => __testables.RUNTIMES.find((r: { name: string }) => r.name === n)!;
  const base = (n: string) => { const h = byName(n); return { h, call: h.buildCall("persona", "message") }; };

  test("claude: no tools, no MCP, no skills, hooks off, and the effort", () => {
    const { h, call } = base("claude-code");
    const out = __testables.withCallOpts(h, call, { answerOnly: true, effort: "medium" });
    const a = out.args;
    expect(a.slice(0, call.args.length)).toEqual(call.args);
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a).toContain("--strict-mcp-config");
    expect(a).toContain("--disable-slash-commands");
    expect(a[a.indexOf("--effort") + 1]).toBe("medium");
    const settings = a[a.indexOf("--settings") + 1];
    const json = settings.startsWith("{") ? settings : fs.readFileSync(settings, "utf8");
    expect(JSON.parse(json)).toEqual({ disableAllHooks: true });
    expect(out.input).toBe(call.input);
    for (const f of out.tmpFiles ?? []) fs.rmSync(f, { force: true });
  });

  test("claude without the options: the call is exactly what it was", () => {
    const { h, call } = base("claude-code");
    expect(__testables.withCallOpts(h, call, {})).toEqual(call);
    expect(__testables.withCallOpts(h, call, { effort: "fast" }).args).toEqual(call.args);
  });

  test("codex: the effort as its config key, after `exec`", () => {
    const { h, call } = base("codex");
    const a = __testables.withCallOpts(h, call, { answerOnly: true, effort: "low" }).args;
    expect(a[0]).toBe("exec");
    expect(a.slice(-2)).toEqual(["-c", 'model_reasoning_effort="low"']);
    expect(a).not.toContain("--tools");
  });

  test("a runtime with neither switch runs as before", () => {
    const other = __testables.RUNTIMES.find((r: { name: string }) => r.name !== "claude-code" && r.name !== "codex" && typeof r.buildCall === "function")!;
    const call = other.buildCall("persona", "message");
    expect(__testables.withCallOpts(other, call, { answerOnly: true, effort: "low" })).toEqual(call);
  });
});
