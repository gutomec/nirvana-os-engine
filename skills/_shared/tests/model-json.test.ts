// model-json.test.ts — reading a model's JSON out of whatever its runtime
// printed around it.
//
// Every decision point that asks a model for JSON carried the same line:
// `text.match(/\{[\s\S]*\}/)`. Greedy — first `{` in the whole output to the
// last `}`. It works on a runtime that prints the answer alone and fails on
// every runtime that wraps the final message in an event stream, because the
// span opens inside the telemetry and closes inside the answer.
//
// Measured on a client's machine (2026-09-11, Codex as the session runtime):
// the business director answered correctly, the run died with "invalid
// director JSON", and the maestro read that as "this business does not work"
// and replaced the whole org chart with `agent-x`. The same line was in the
// reviewer's verdict, the quality gate's judge, the squad audit consensus and
// the squad audit verifier — one runtime, and the engine's entire decision
// surface degraded at once.
import { describe, expect, test } from "bun:test";
import { extractJsonObject, extractJsonWithKeys, jsonObjectsIn } from "../lib/model-json.ts";

/** What Codex puts around a final message. */
const withTelemetry = (answer: string) => [
  `{"type":"turn.started","id":"t1"}`,
  `{"type":"item.completed","item":{"type":"reasoning","summary":{"text":"pensei"}}}`,
  `Segue o resultado:`,
  answer,
  `{"type":"turn.completed","usage":{"input_tokens":10}}`,
].join("\n");

describe("the failure this replaces", () => {
  test("the old greedy regex cannot read an answer wrapped in an event stream", () => {
    const text = withTelemetry(`{"chain":[{"employee":"cto"}],"reason":"r"}`);
    const greedy = text.match(/\{[\s\S]*\}/)![0];
    expect(() => JSON.parse(greedy)).toThrow();      // the defect, pinned
    expect(extractJsonWithKeys(text, "chain")).toEqual({ chain: [{ employee: "cto" }], reason: "r" });
  });
});

describe("jsonObjectsIn", () => {
  test("finds every balanced object and skips what does not parse", () => {
    const found = jsonObjectsIn(`{"a":1} lixo {não json} {"b":{"c":2}}`);
    expect(found).toEqual([{ a: 1 }, { b: { c: 2 } }]);
  });

  test("a brace inside a string is text, not structure", () => {
    expect(jsonObjectsIn(`{"task":"use { and } and \\" in the copy"}`))
      .toEqual([{ task: `use { and } and " in the copy` }]);
  });

  test("nested objects are returned once, from the outside", () => {
    expect(jsonObjectsIn(`{"outer":{"inner":{"deep":1}}}`)).toEqual([{ outer: { inner: { deep: 1 } } }]);
  });

  test("an unterminated object does not swallow the rest of the output", () => {
    expect(jsonObjectsIn(`{"broken": [1,2 \n{"verdict":"pass"}`)).toEqual([{ verdict: "pass" }]);
  });

  test("no object at all is an empty list, never a throw", () => {
    expect(jsonObjectsIn("prosa sem chaves")).toEqual([]);
    expect(jsonObjectsIn("")).toEqual([]);
    expect(jsonObjectsIn(undefined as unknown as string)).toEqual([]);
  });
});

describe("extractJsonObject", () => {
  test("takes the LAST object that qualifies: the answer comes after the noise", () => {
    const text = withTelemetry(`{"verdict":"pass","score":0.9}`);
    expect(extractJsonObject(text, (v) => v.verdict !== undefined)).toEqual({ verdict: "pass", score: 0.9 });
  });

  test("a model that corrects itself is taken at its latest word", () => {
    const text = `{"verdict":"fail"}\nme enganei, na verdade:\n{"verdict":"pass"}`;
    expect(extractJsonWithKeys(text, "verdict")).toEqual({ verdict: "pass" });
  });

  test("a fenced block is ordinary and reads fine", () => {
    expect(extractJsonWithKeys("Segue:\n```json\n{\"verdict\":\"pass\"}\n```\npronto.", "verdict")).toEqual({ verdict: "pass" });
  });

  test("telemetry never qualifies as the answer", () => {
    expect(extractJsonWithKeys(`{"type":"turn.started"}\n{"type":"turn.completed"}`, "verdict")).toBeNull();
    expect(extractJsonWithKeys(`{"type":"turn.started"}`, "chain")).toBeNull();
  });

  test("nothing readable is null — the caller must not read that as an empty answer", () => {
    expect(extractJsonObject("sem nada aqui")).toBeNull();
    expect(extractJsonWithKeys("sem nada aqui", "verdict")).toBeNull();
  });

  test("several required keys must all be present", () => {
    const text = `{"verdict":"pass"}\n{"verdict":"pass","score":1}`;
    expect(extractJsonWithKeys(text, ["verdict", "score"])).toEqual({ verdict: "pass", score: 1 });
    expect(extractJsonWithKeys(`{"verdict":"pass"}`, ["verdict", "score"])).toBeNull();
  });
});

describe("the shapes each caller actually reads", () => {
  test("the director's plan survives the stream", () => {
    const plan = extractJsonObject<{ chain: any[] }>(
      withTelemetry(`{"chain":[{"employee":"backend","task":"api"},{"employee":"cto","task":"sintetizar"}],"reason":"seis cadeiras"}`),
      (v) => v && Array.isArray(v.chain),
    );
    expect(plan?.chain).toHaveLength(2);
  });

  test("the gate's judge verdict survives the stream", () => {
    const v = extractJsonObject<{ verdict: string; categories: unknown }>(
      withTelemetry(`{"verdict":"needs_revision","score":0.7,"categories":{"structure":0.6},"failed_checks":["x"]}`),
      (o) => o && o.verdict !== undefined,
    );
    expect(v?.verdict).toBe("needs_revision");
    expect(v?.categories).toEqual({ structure: 0.6 });
  });

  test("a verdict carrying a nested object is not cut at the inner brace", () => {
    // The verifier's old regex closed at the first `}` after the word "verdict";
    // with a nested object in between, that brace belongs to the inner one.
    const text = `{"verdict":"rollback","evidence":{"file":"a.md","line":3},"reasons":["y"]}`;
    expect(extractJsonWithKeys(text, "verdict")).toEqual({
      verdict: "rollback", evidence: { file: "a.md", line: 3 }, reasons: ["y"],
    });
  });
});
