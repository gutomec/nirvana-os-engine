import { describe, expect, it } from "bun:test";
import {
  availableProviders, decide, isDecisionError, localCapacity, subscriptionPrompt, validateRequest,
  type DecisionRequest,
} from "../lib/decision-model.ts";

const req: DecisionRequest = {
  state: "My payouts have been stuck for three days. Please help ASAP.",
  questions: {
    urgent: { type: "yes_no", instructions: "The message conveys urgency" },
    team: { type: "choice", instructions: "Which team handles this", options: { billing: "Payments", technical: "Bugs" } },
    severity: { type: "score", instructions: "How severe", levels: ["low", "medium", "high"] },
  },
};

type Call = { url: string; headers: Record<string, string>; body: any };
function fakeFetch(reply: (c: Call) => unknown, calls: Call[] = []) {
  return async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const c = { url, headers: init.headers, body: JSON.parse(init.body) };
    calls.push(c);
    const out = reply(c);
    return { ok: true, status: 200, text: async () => JSON.stringify(out) };
  };
}

describe("validateRequest", () => {
  it("rejects bad names, too few options and unknown types", () => {
    expect(() => validateRequest({ state: "x", questions: {} })).toThrow();
    expect(() => validateRequest({ state: "x", questions: { "bad name": { type: "yes_no", instructions: "q" } } })).toThrow();
    expect(() => validateRequest({ state: "x", questions: { a: { type: "choice", instructions: "q", options: { one: "" } } } })).toThrow();
    expect(() => validateRequest({ state: "x", questions: { a: { type: "nope", instructions: "q" } as any } })).toThrow();
    expect(() => validateRequest(req)).not.toThrow();
  });
});

describe("availableProviders", () => {
  it("orders local, typesafe, gemini, openai, subscription and needs a key for each API", () => {
    expect(availableProviders({ env: {}, localUrl: "", hostAvailable: false })).toEqual([]);
    expect(availableProviders({ env: { OPENAI_API_KEY: "k", GOOGLE_API_KEY: "g", TYPESAFE_API_KEY: "t" }, localUrl: "http://localhost:8000" }))
      .toEqual(["local", "typesafe", "gemini", "openai", "subscription"]);
  });
});

describe("decide: one contract over every backend", () => {
  it("typesafe: map of questions with noul and criteria, bearer key", async () => {
    const calls: Call[] = [];
    const r = await decide(req, {
      provider: "typesafe", env: { TYPESAFE_API_KEY: "t" },
      fetchImpl: fakeFetch(() => ({
        model: "jev-1.14.0",
        answers: {
          urgent: { type: "noul", noul: 0.9 },
          team: { type: "choice", choice: "billing", confidence: 0.8, probabilities: { billing: 0.85, technical: 0.15 } },
          severity: { type: "score", score: 1.6, confidence: 0.7, probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 } },
        },
      }), calls) as any,
    });
    expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0].headers.authorization).toBe("Bearer t");
    expect(calls[0].body.questions.urgent).toEqual({ type: "noul", instructions: "The message conveys urgency" });
    expect(calls[0].body.questions.severity.criteria).toEqual(["low", "medium", "high"]);
    if (isDecisionError(r)) throw new Error(r.error);
    expect(r.model).toBe("jev-1.14.0");
    expect(r.answers.urgent).toEqual({ type: "yes_no", probability: 0.9, confidence: null });
    expect(r.answers.team).toMatchObject({ choice: "billing", confidence: 0.8 });
    expect(r.answers.severity).toMatchObject({ score: 1.6, probabilities: [0.1, 0.2, 0.7] });
  });

  it("gemini: v1beta/decisions with x-goog-api-key and text input", async () => {
    const calls: Call[] = [];
    const r = await decide(req, {
      provider: "gemini", env: { GEMINI_API_KEY: "g" },
      fetchImpl: fakeFetch(() => ({
        answers: {
          urgent: { type: "noul", noul: 0.8, confidence: 0.9 },
          team: { type: "choice", choice: "technical", probabilities: { billing: 0.4, technical: 0.6 }, confidence: 0.6 },
          severity: { type: "score", score: 2, probabilities: [0, 0, 1], confidence: 1 },
        },
      }), calls) as any,
    });
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/decisions");
    expect(calls[0].headers["x-goog-api-key"]).toBe("g");
    expect(calls[0].body.model).toBe("gemini-decision-1");
    expect(typeof calls[0].body.input).toBe("string");
    if (isDecisionError(r)) throw new Error(r.error);
    expect(r.answers.urgent).toEqual({ type: "yes_no", probability: 0.8, confidence: 0.9 });
    expect(r.answers.severity).toMatchObject({ score: 2, probabilities: [0, 0, 1] });
  });

  it("openai: predicate questions in an array, answers as an array", async () => {
    const calls: Call[] = [];
    const r = await decide(req, {
      provider: "openai", env: { OPENAI_API_KEY: "o" },
      fetchImpl: fakeFetch(() => ({
        answers: [
          { type: "predicate", name: "urgent", probability: 0.7 },
          { type: "choice", name: "team", choice: "billing", probabilities: [{ value: "billing", probability: 0.9 }, { value: "technical", probability: 0.1 }], confidence: 0.9 },
          { type: "score", name: "severity", score: 1, probabilities: [0.2, 0.6, 0.2], confidence: 0.6 },
        ],
      }), calls) as any,
    });
    expect(calls[0].url).toBe("https://api.openai.com/v1/decisions");
    expect(calls[0].body.model).toBe("gpt-6-luna");
    expect(calls[0].body.questions[0]).toEqual({ type: "predicate", name: "urgent", instructions: "The message conveys urgency" });
    expect(calls[0].body.questions[1].choices).toEqual([{ value: "billing", description: "Payments" }, { value: "technical", description: "Bugs" }]);
    expect(calls[0].body.questions[2].levels[0]).toEqual({ label: "0", description: "low" });
    if (isDecisionError(r)) throw new Error(r.error);
    expect(r.answers.team).toMatchObject({ choice: "billing", probabilities: { billing: 0.9, technical: 0.1 } });
  });

  it("local JEV-27B: one /v1/decide call per question", async () => {
    const calls: Call[] = [];
    const r = await decide(req, {
      provider: "local", env: {}, localUrl: "http://localhost:8000/",
      fetchImpl: fakeFetch((c) => c.body.kind === "noul" ? { probabilities: [0.2, 0.8], choice: "true" }
        : c.body.kind === "choice" ? { probabilities: [0.3, 0.7], choice_index: 1, choice: "technical" }
        : { probabilities: [0, 0.5, 0.5, 0, 0, 0] }, calls) as any,
    });
    expect(calls.map((c) => c.url)).toEqual(Array(3).fill("http://localhost:8000/v1/decide"));
    if (isDecisionError(r)) throw new Error(r.error);
    expect(r.answers.urgent).toMatchObject({ probability: 0.8 });
    expect(r.answers.team).toMatchObject({ choice: "technical" });
    expect((r.answers.severity as any).score).toBeCloseTo(1.5);
  });

  it("subscription: parses the CLI's JSON and never claims a confidence", async () => {
    const r = await decide(req, {
      provider: "subscription", env: {},
      callHost: async (p) => {
        expect(p).toContain("STATE:");
        return 'ok {"urgent":{"probability":0.6},"team":{"choice":"billing","probabilities":{"billing":0.7,"technical":0.3},"confidence":0.99},"severity":{"score":1,"probabilities":[0,1,0]}}';
      },
    });
    if (isDecisionError(r)) throw new Error(r.error);
    expect(r.provider).toBe("subscription");
    expect(r.answers.team.confidence).toBeNull();
  });

  it("falls through to the next provider and reports why each failed", async () => {
    const r = await decide(req, {
      env: { TYPESAFE_API_KEY: "t", GEMINI_API_KEY: "g" }, provider: "auto", apiOnly: true,
      fetchImpl: (async (url: string) => url.includes("typesafe")
        ? { ok: false, status: 503, text: async () => "busy" }
        : { ok: true, status: 200, text: async () => JSON.stringify({ answers: {
          urgent: { noul: 0.5 }, team: { choice: "billing" }, severity: { score: 0 } } }) }) as any,
    });
    if (isDecisionError(r)) throw new Error(r.error);
    expect(r.provider).toBe("gemini");
  });

  it("off and no provider are errors, not throws", async () => {
    expect(await decide(req, { provider: "off" as any, env: {} })).toMatchObject({ error: expect.stringContaining("off") });
    const none = await decide(req, { provider: "auto", env: {}, localUrl: "", apiOnly: true });
    expect(isDecisionError(none) && none.tried.length).toBe(0);
  });

  it("subscriptionPrompt lists every question", () => {
    const p = subscriptionPrompt(req);
    for (const n of ["urgent", "team", "severity"]) expect(p).toContain(`- ${n} (`);
  });
});

describe("localCapacity: JEV-27B hosting advice, never a download", () => {
  it("16 GB Apple Silicon cannot host it", () => {
    const c = localCapacity({ platform: "darwin", arch: "arm64", totalRamBytes: 16 * 1024 ** 3, nvidiaSmi: () => null });
    expect(c.fits).toBe("none");
  });
  it("64 GB Apple Silicon fits Q8_0, flagged unverified", () => {
    const c = localCapacity({ platform: "darwin", arch: "arm64", totalRamBytes: 64 * 1024 ** 3 });
    expect(c.fits).toBe("q8_0");
    expect(c.advice).toContain("unverified");
  });
  it("Windows with a 24 GB NVIDIA GPU fits Q4_K_M; an 80 GB GPU fits bf16", () => {
    expect(localCapacity({ platform: "win32", arch: "x64", totalRamBytes: 32 * 1024 ** 3, nvidiaSmi: () => "NVIDIA GeForce RTX 4090, 24564\r\n" }).fits).toBe("q4_k_m");
    expect(localCapacity({ platform: "linux", arch: "x64", totalRamBytes: 128 * 1024 ** 3, nvidiaSmi: () => "NVIDIA H100, 81559\n" }).fits).toBe("bf16");
  });
  it("no GPU on Windows: none", () => {
    expect(localCapacity({ platform: "win32", arch: "x64", totalRamBytes: 64 * 1024 ** 3, nvidiaSmi: () => null }).fits).toBe("none");
  });
});
