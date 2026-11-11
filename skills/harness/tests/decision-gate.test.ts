import { describe, expect, it } from "bun:test";
import { decisionVerdict } from "../scripts/quality-gate.ts";

const reply = (meets: number, score: number, confidence: number | null) => async () => ({
  provider: "gemini" as const, model: "gemini-decision-1", latency_ms: 1,
  answers: {
    meets: { type: "yes_no" as const, probability: meets, confidence: null },
    quality: { type: "score" as const, score, probabilities: [0, 0, 0, 0, 1], confidence },
  },
});
const rubric = { name: "prose_longform", display_name: "Long-form prose" };

describe("decisionVerdict: the gate's fallback when the judge is out of quota", () => {
  it("passes when both answers agree on a pass with enough confidence", async () => {
    expect(await decisionVerdict(rubric, "a report", "write a report", reply(0.9, 3.2, 0.8) as any))
      .toMatchObject({ pass: true, score: 0.8, provider: "gemini" });
  });
  it("fails when both answers agree on a fail", async () => {
    expect(await decisionVerdict(rubric, "a report", "write a report", reply(0.1, 1, 0.9) as any)).toMatchObject({ pass: false });
  });
  it("decides nothing on disagreement, low or missing confidence, or an empty file", async () => {
    expect(await decisionVerdict(rubric, "a report", undefined, reply(0.9, 1, 0.9) as any)).toBeNull();
    expect(await decisionVerdict(rubric, "a report", undefined, reply(0.9, 3.5, 0.3) as any)).toBeNull();
    expect(await decisionVerdict(rubric, "a report", undefined, reply(0.9, 3.5, null) as any)).toBeNull();
    expect(await decisionVerdict(rubric, "  ", undefined, reply(0.9, 3.5, 0.9) as any)).toBeNull();
  });
  it("asks hosted or local providers only", async () => {
    let opts: any;
    await decisionVerdict(rubric, "x", undefined, (async (_r: any, o: any) => { opts = o; return { error: "none", tried: [] }; }) as any);
    expect(opts.apiOnly).toBe(true);
  });
});
