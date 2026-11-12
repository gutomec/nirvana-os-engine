import { describe, expect, it } from "bun:test";
import { chooseRuntimeByDecision } from "../lib/decision-runtime.ts";

const answer = (choice: string, confidence: number | null) => async () => ({
  provider: "typesafe" as const, model: "jev", latency_ms: 1,
  answers: { runtime: { type: "choice" as const, choice, probabilities: { [choice]: 0.9 }, confidence } },
});

describe("chooseRuntimeByDecision", () => {
  const base = { brief: "Watch this product video and write a review", candidates: ["claude-code", "antigravity-cli"] as any, host: "claude-code" as any };

  it("returns the pick when it clears the confidence floor", async () => {
    const pick = await chooseRuntimeByDecision({ ...base, decideFn: answer("antigravity-cli", 0.9) as any });
    expect(pick).toMatchObject({ runtime: "antigravity-cli", provider: "typesafe" });
  });

  it("keeps the default below the floor or without a calibrated confidence", async () => {
    expect(await chooseRuntimeByDecision({ ...base, decideFn: answer("antigravity-cli", 0.4) as any })).toBeNull();
    expect(await chooseRuntimeByDecision({ ...base, decideFn: answer("antigravity-cli", null) as any })).toBeNull();
  });

  it("ignores a pick outside the candidates and needs two candidates", async () => {
    expect(await chooseRuntimeByDecision({ ...base, decideFn: answer("codex", 0.99) as any })).toBeNull();
    expect(await chooseRuntimeByDecision({ ...base, candidates: ["claude-code"] as any, decideFn: answer("claude-code", 1) as any })).toBeNull();
  });

  it("asks API or local providers only, never a CLI", async () => {
    let seen: any;
    await chooseRuntimeByDecision({ ...base, decideFn: (async (req: any, opts: any) => { seen = { req, opts }; return { error: "x", tried: [] }; }) as any });
    expect(seen.opts.apiOnly).toBe(true);
    expect(Object.keys(seen.req.questions.runtime.options)).toEqual(["claude-code", "antigravity-cli"]);
    expect(seen.req.questions.runtime.options["claude-code"]).toContain("session the user is working in");
  });
});
