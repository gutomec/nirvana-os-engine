// solo-review.test.ts — review as an exception decided by a rule, one reviewer
// per delivery on another runtime when possible, at most max_rounds corrections
// in the worker's own session, then reservations for what never held.
// Hermetic: canned runners stand in for the runtimes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildRevisionPrompt, buildSoloReviewPrompt, businessWantsReview, claimProblems, criteriaFromBrief, decideReview, deliverableFiles,
  evidenceFileUnder, pickReviewRuntime, precheckSolo, readReviewAnswer, runSoloReviewStage, scoreSoloReview, SERIOUS_EXTRA_ROUNDS,
  type ReviewSignals, type SoloReviewArgs,
} from "../lib/solo-review.ts";
import { soloDirective } from "../lib/business-solo.ts";
import type { Criterion } from "../lib/work-brief.ts";
import * as runLedger from "../lib/run-ledger.ts";

let tmp: string;
let outputs: string;
let bizDir: string;
let briefFile: string;
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

const CRITERIA: Criterion[] = [
  { id: "d1", description: "The PRD lists every table", blocking: true },
  { id: "d2", description: "A monthly cost estimate", blocking: false },
];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-solo-review-")));
  outputs = path.join(tmp, "out");
  bizDir = path.join(tmp, "biz");
  briefFile = path.join(tmp, "brief.md");
  write(path.join(bizDir, "business.yaml"), "name: biz\n");
  write(briefFile, "## Request (verbatim)\nx\n## Decisions\nNone.\n## Your part\ny\n## Inputs\nNone.\n## Done when\n- The PRD lists every table (blocking)\n- A monthly cost estimate\n## Output\nout\n");
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function deliver(claims: unknown = [{ id: "d1", evidence: "prd.md:10-40, the tables section" }, { id: "d2", evidence: "cost.md:1-20, the monthly table" }]) {
  write(path.join(outputs, "prd.md"), "tables");
  write(path.join(outputs, "_SUMMARY.md"), "summary");
  write(path.join(outputs, "_CLAIMS.json"), JSON.stringify(claims));
}

describe("decideReview", () => {
  const base: ReviewSignals = { policy: "rule", userAsked: false, userDeclined: false, sensitive: false, precheckFailed: false };
  test.each([
    [{ ...base }, false],
    [{ ...base, sensitive: true }, true],
    [{ ...base, precheckFailed: true }, true],
    [{ ...base, policy: "on-request" as const, sensitive: true }, false],
    [{ ...base, policy: "on-request" as const, precheckFailed: true }, true],
    [{ ...base, policy: "always" as const }, true],
    [{ ...base, policy: "never" as const, precheckFailed: true }, false],
    [{ ...base, policy: "never" as const, userAsked: true }, true],
    [{ ...base, policy: "always" as const, userDeclined: true }, false],
    [{ ...base, userAsked: true, userDeclined: true }, false],
  ])("%o → %p", (signals, expected) => {
    expect(decideReview(signals).review).toBe(expected);
  });
});

describe("the signals", () => {
  test("a manifest asks for review with review: required", () => {
    expect(businessWantsReview(bizDir)).toBe(false);
    write(path.join(bizDir, "business.yaml"), "name: biz\nreview: required\n");
    expect(businessWantsReview(bizDir)).toBe(true);
  });

  test("with `other`, the reviewer runs on another available runtime, else on the worker's", () => {
    expect(pickReviewRuntime("other", "claude-code", (rt) => rt === "codex" || rt === "claude-code")).toBe("codex");
    expect(pickReviewRuntime("other", "codex", (rt) => rt === "codex" || rt === "claude-code")).toBe("claude-code");
    expect(pickReviewRuntime("other", "claude-code", (rt) => rt === "claude-code")).toBe("claude-code");
    expect(pickReviewRuntime("same", "claude-code", () => true)).toBe("claude-code");
  });

  test("with `other`, a runtime a NOT_USE_* rule vetoes is skipped", () => {
    const available = (rt: string) => ["codex", "claude-code", "gemini-cli"].includes(rt);
    expect(pickReviewRuntime("other", "claude-code", available, (rt) => rt === "codex")).toBe("gemini-cli");
    expect(pickReviewRuntime("other", "claude-code", available, (rt) => rt !== "claude-code")).toBe("claude-code");
  });

  test("the precheck names what is missing, without a model", () => {
    expect(precheckSolo(outputs, CRITERIA).problems).toEqual([
      "no deliverable file under the outputs root", "_SUMMARY.md is missing", "_CLAIMS.json is missing or not a JSON array",
    ]);
    deliver([{ id: "d2", evidence: "cost.md:1-20, the monthly table" }]);
    expect(precheckSolo(outputs, CRITERIA).problems).toEqual(["no evidence claimed for blocking criterion d1"]);
    deliver();
    expect(precheckSolo(outputs, CRITERIA).ok).toBe(true);
  });

  test("evidence must name a file that exists under the outputs root, not merely be long", () => {
    deliver([{ id: "d1", evidence: "the tables section of the PRD, lines 10 to 40" }]);
    expect(precheckSolo(outputs, CRITERIA).problems).toEqual(["the evidence for blocking criterion d1 names no file that exists under the outputs root"]);
    deliver([{ id: "d1", evidence: "missing.md:10-40, the tables section" }]);
    expect(precheckSolo(outputs, CRITERIA).ok).toBe(false);
    // The worker's own summary is a claim, never its proof.
    deliver([{ id: "d1", evidence: "_SUMMARY.md:1, says the tables are there" }]);
    expect(precheckSolo(outputs, CRITERIA).ok).toBe(false);
  });

  test("evidence paths: either separator, relative or absolute, never outside the outputs root", () => {
    write(path.join(outputs, "docs", "prd.md"), "tables");
    write(path.join(tmp, "outside.md"), "x");
    expect(evidenceFileUnder(outputs, "docs\\prd.md:10-40, the tables")).toBe(path.join(outputs, "docs", "prd.md"));
    expect(evidenceFileUnder(outputs, "`docs/prd.md` (#L10-L40)")).toBe(path.join(outputs, "docs", "prd.md"));
    expect(evidenceFileUnder(outputs, `${path.join(outputs, "docs", "prd.md")}:3`)).toBe(path.join(outputs, "docs", "prd.md"));
    expect(evidenceFileUnder(outputs, `${path.join(tmp, "outside.md")}:1`)).toBeNull();
    expect(evidenceFileUnder(outputs, "../outside.md:1")).toBeNull();
    expect(evidenceFileUnder(outputs, "C:\\elsewhere\\prd.md:1")).toBeNull();
    expect(claimProblems(outputs, CRITERIA).map((p) => p.id)).toEqual(["d1"]);
  });

  test("the worker's own reports and working folder are not deliverables", () => {
    deliver();
    write(path.join(outputs, "_work", "PROGRESS.md"), "p");
    write(path.join(outputs, "_STATUS.json"), "{}");
    write(path.join(outputs, "_review", "answer-0.txt"), "{}");
    expect(deliverableFiles(outputs)).toEqual(["prd.md"]);
  });
});

describe("the brief's criteria", () => {
  const brief = (done: string) => `## Request (verbatim)\nx\n## Decisions\nNone.\n## Your part\ny\n## Inputs\nNone.\n## Done when\n${done}\n## Output\nout\n`;

  test("only top-level bullets are criteria; a nested bullet details its parent", () => {
    const c = criteriaFromBrief(brief("- The PRD lists every table (blocking)\n  - including the audit table\n- A cost estimate"));
    expect(c.map((x) => [x.id, x.description, x.blocking])).toEqual([
      ["d1", "The PRD lists every table", true], ["d2", "A cost estimate", false],
    ]);
  });

  test("blocking in the user's language: (bloqueante), a leading deve or must, a bold marker", () => {
    const c = criteriaFromBrief(brief("- O relatório cita as fontes (bloqueante)\n- Deve ter um resumo executivo\n- must open offline\n- Um gráfico **(blocking)**\n- Uma capa bonita"));
    expect(c.map((x) => x.blocking)).toEqual([true, true, true, true, false]);
    expect(c[0].description).toBe("O relatório cita as fontes");
  });

  test("no section, or a section with no bullet, gives nothing to check", () => {
    expect(criteriaFromBrief("Faça um relatório.")).toEqual([]);
    expect(criteriaFromBrief(brief("Quando estiver bom."))).toEqual([]);
  });
});

describe("scoring", () => {
  test("silence rejects, a shrug is not evidence, invented ids are dropped", () => {
    const s = scoreSoloReview({ confirmed: [{ id: "d1", evidence: "ok" }, { id: "d9", evidence: "prd.md:1, whatever it says" }] }, CRITERIA);
    expect(s.approved).toBe(false);
    expect(s.confirmed).toEqual([]);
    expect(s.invented).toEqual(["d9"]);
    expect(s.blockingMissed).toEqual(["d1"]);
  });

  test("a brief with nothing to check is never approved (it used to score 1)", () => {
    const s = scoreSoloReview({ confirmed: [], notes: "looks fine" }, []);
    expect(s.approved).toBe(false);
    expect(s.score).toBe(0);
    expect(s.gaps.map((g) => g.id)).toEqual(["done-when"]);
  });

  test("a figure nobody can trace keeps the review from approving", () => {
    const s = scoreSoloReview({
      confirmed: [{ id: "d1", evidence: "prd.md:10, the tables" }, { id: "d2", evidence: "cost.md:3, monthly total" }],
      untraceable: [{ where: "cost.md:3", what: "R$ 4.990/mês: not in the brief, no source cited" }],
    }, CRITERIA);
    expect(s.score).toBe(1);
    expect(s.approved).toBe(false);
    expect(s.untraceable).toHaveLength(1);
    expect(buildRevisionPrompt(s.gaps, CRITERIA, s.untraceable)).toContain("cost.md:3: R$ 4.990/mês");
  });

  test("everything confirmed with evidence approves", () => {
    const s = scoreSoloReview({ confirmed: [{ id: "d1", evidence: "prd.md:10, the tables" }, { id: "d2", evidence: "cost.md:3, monthly total" }] }, CRITERIA);
    expect(s.approved).toBe(true);
    expect(s.score).toBe(1);
  });

  test("the prompts carry the criteria, the claims and the gaps", () => {
    const p = buildSoloReviewPrompt({ business: "biz", briefFile, outputsRoot: outputs, criteria: CRITERIA, claims: [{ id: "d1", evidence: "prd.md:10" }] });
    expect(p).toContain("- `d1` **(blocking)**: The PRD lists every table");
    expect(p).toContain("- `d1`: prd.md:10");
    expect(p).toContain("every figure, price, date, guarantee, promise or factual claim");
    expect(p).toContain('"untraceable"');
    const r = buildRevisionPrompt([{ id: "d1", blocking: true, why: "no tables" }], CRITERIA);
    expect(r).toContain("- `d1` (blocking): The PRD lists every table. Reviewer: no tables");
  });
});

describe("runSoloReviewStage", () => {
  const args = (extra: Partial<SoloReviewArgs>): SoloReviewArgs => ({
    business: "biz", bizDir, briefFile, outputsRoot: outputs, projectRoot: tmp,
    worker: { runtime: "claude-code", sessionId: "s-1", launch: { cwd: tmp, addDirs: [], appendSystemPrompt: "" } },
    policy: "rule", runtimePref: "other", maxRounds: 1, userAsked: false, userDeclined: false,
    available: (rt) => rt === "codex" || rt === "claude-code",
    ...extra,
  });
  const ok = (result: string) => ({ ok: true, runtime: "codex", sessionId: null, result, costUsd: null, durationMs: 1 }) as any;

  function stoppableRun(): { handle: runLedger.LedgerHandle; runId: string } {
    const handle = runLedger.openLedger(path.join(tmp, "ledger.sqlite"));
    const row = runLedger.openRun(handle, { traceId: "t", projectId: "p", targetSlug: "biz", targetKind: "business", runtime: "claude-code" });
    runLedger.markState(handle, row.run_id, "running");
    return { handle, runId: row.run_id };
  }

  test("a run stopped before the review: no reviewer, no correction", () => {
    deliver();
    const led = stoppableRun();
    runLedger.abandon(led.handle, led.runId, "stopped by the user");
    let calls = 0;
    const out = runSoloReviewStage(args({ policy: "always", ledger: led, runImpl: () => { calls++; return ok("{}"); } }));
    expect(calls).toBe(0);
    expect(out.skipped).toBe("stopped");
    expect(out.blockingMissed).toEqual([]);
  });

  test("a run stopped while the reviewer ran: the correction never starts", () => {
    deliver();
    const led = stoppableRun();
    const calls: any[] = [];
    const out = runSoloReviewStage(args({
      policy: "always", ledger: led,
      runImpl: (o: any) => { calls.push(o); runLedger.abandon(led.handle, led.runId, "stopped by the user"); return ok(JSON.stringify({ confirmed: [] })); },
    }));
    expect(calls).toHaveLength(1);
    expect(out.skipped).toBe("stopped");
  });

  test("no rule fires: no reviewer is run", () => {
    deliver();
    let calls = 0;
    const out = runSoloReviewStage(args({ runImpl: () => { calls++; return ok("{}"); } }));
    expect(out.decision.review).toBe(false);
    expect(calls).toBe(0);
  });

  test("approved on the first round, by another runtime", () => {
    deliver();
    const runtimes: string[] = [];
    const out = runSoloReviewStage(args({
      userAsked: true,
      runImpl: (o: any) => { runtimes.push(o.runtime); return ok(JSON.stringify({ confirmed: [{ id: "d1", evidence: "prd.md:10, tables" }, { id: "d2", evidence: "cost.md:2, monthly" }] })); },
    }));
    expect(out.approved).toBe(true);
    expect(out.reviewer).toBe("codex");
    expect(runtimes).toEqual(["codex"]);
    expect(out.reservations).toBeNull();
  });

  test("a non-blocking gap: max_rounds corrections in the worker's own session, then reservations", () => {
    deliver();
    const calls: any[] = [];
    const out = runSoloReviewStage(args({
      policy: "always", runtimePref: "other",
      runImpl: (o: any) => { calls.push(o); return ok(o.sessionId ? "" : JSON.stringify({ confirmed: [{ id: "d1", evidence: "prd.md:10, the tables" }] })); },
    }));
    expect(calls.map((c) => [c.runtime, c.sessionId ?? null, c.dispatchRole])).toEqual([
      ["codex", null, "planner"], ["claude-code", "s-1", "solo"], ["codex", null, "planner"],
    ]);
    expect(out.rounds).toBe(1);
    expect(out.approved).toBe(false);
    expect(out.blockingMissed).toEqual([]);
    expect(fs.readFileSync(out.reservations!, "utf8")).toContain("A monthly cost estimate");
  });

  test("a blocking criterion a correction does not move gets no extra round, and is carried out as serious", () => {
    deliver();
    const calls: any[] = [];
    const events: string[] = [];
    const missed = JSON.stringify({ confirmed: [], unconfirmed: [{ id: "d1", why: "the PRD has no table section" }] });
    const out = runSoloReviewStage(args({
      policy: "always", emit: (e) => events.push(e),
      runImpl: (o: any) => { calls.push(o); return ok(o.sessionId ? "" : missed); },
    }));
    expect(out.rounds).toBe(1);
    expect(calls.filter((c) => c.dispatchRole === "solo")).toHaveLength(1);
    expect(events).toContain("x_review_no_progress");
    expect(out.approved).toBe(false);
    expect(out.blockingMissed).toEqual(["d1"]);
    expect(fs.readFileSync(out.reservations!, "utf8")).toContain("**blocking** The PRD lists every table");
  });

  test("a correction that moves the blocking criteria earns the extra rounds", () => {
    deliver();
    write(briefFile, "## Request (verbatim)\nx\n## Decisions\nNone.\n## Your part\ny\n## Inputs\nNone.\n## Done when\n- The PRD lists every table (blocking)\n- A monthly cost estimate (blocking)\n## Output\nout\n");
    const answers = [
      { confirmed: [], unconfirmed: [{ id: "d1", why: "no tables" }, { id: "d2", why: "no estimate" }] },
      { confirmed: [{ id: "d2", evidence: "cost.md:1-20, the monthly table" }], unconfirmed: [{ id: "d1", why: "still no tables" }] },
      { confirmed: [{ id: "d2", evidence: "cost.md:1-20, the monthly table" }], unconfirmed: [{ id: "d1", why: "still no tables" }] },
    ];
    let review = 0;
    const out = runSoloReviewStage(args({
      policy: "always",
      runImpl: (o: any) => ok(o.sessionId ? "" : JSON.stringify(answers[Math.min(review++, answers.length - 1)])),
    }));
    // round 1 is the normal one, round 2 is extra (d2 moved), then no progress
    expect(out.rounds).toBe(2);
    expect(out.blockingMissed).toEqual(["d1"]);
  });

  // A client's three cases on Codex: the reviewer confirmed d2-d4 and gave
  // concrete reasons for d1, d5 and d6, and every event said confirmed=[] and
  // "not mentioned by the reviewer". The result was the verdict followed by
  // the whole event stream, and the parser took the last telemetry object.
  describe("the reviewer's answer as Codex reports it", () => {
    const verdict = { confirmed: [{ id: "d2", evidence: "cost.md:1-20, the monthly table" }], unconfirmed: [{ id: "d1", why: "the PRD has no table section" }], untraceable: [] };
    const stream = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(verdict) } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1200, output_tokens: 90 } }),
    ].join("\n");

    test("verdict then event stream: the verdict is read, with the reviewer's own reasons", () => {
      const raw = readReviewAnswer({ result: `${JSON.stringify(verdict)}\n\n--- codex event stream ---\n${stream}` });
      expect(raw.confirmed[0].id).toBe("d2");
      const s = scoreSoloReview(raw, CRITERIA);
      expect(s.confirmed).toEqual(["d2"]);
      expect(s.gaps.find((g) => g.id === "d1")!.why).toBe("the PRD has no table section");
    });

    test("the final message alone (answer) wins over the stream", () => {
      expect(readReviewAnswer({ answer: JSON.stringify(verdict), result: "garbage" }).confirmed[0].id).toBe("d2");
    });

    test("with only the event stream, the verdict inside the agent message is found", () => {
      expect(readReviewAnswer({ result: stream }).unconfirmed[0].why).toBe("the PRD has no table section");
    });

    test("no verdict anywhere is unreadable, not silence", () => {
      expect(readReviewAnswer({ result: JSON.stringify({ type: "turn.completed", usage: {} }) })).toBeNull();
      expect(readReviewAnswer({ result: "{}" })).toBeNull();
    });

    test("through the stage: the event keeps what was confirmed, and the correction points to the full answer", () => {
      deliver();
      const events: Array<[string, any]> = [];
      const calls: any[] = [];
      runSoloReviewStage(args({
        policy: "always", maxRounds: 1, emit: (e, p) => events.push([e, p]),
        runImpl: (o: any) => { calls.push(o); return o.sessionId ? ok("") : { ...ok(`${JSON.stringify(verdict)}\n\n--- codex event stream ---\n${stream}`), answer: JSON.stringify(verdict) }; },
      }));
      const rejected = events.find(([e]) => e === "x_review_rejected")![1];
      expect(rejected.confirmed).toEqual(["d2"]);
      expect(rejected.gaps[0].why).toBe("the PRD has no table section");
      const correction = calls.find((c) => c.dispatchRole === "solo")!;
      expect(correction.prompt).toContain("_review/answer-0.txt");
      expect(correction.prompt).toContain("Reviewer: the PRD has no table section");
    });

    test("an unreadable answer is skipped, never spends a correction round", () => {
      deliver();
      const calls: any[] = [];
      const events: string[] = [];
      const out = runSoloReviewStage(args({
        policy: "always", emit: (e) => events.push(e),
        runImpl: (o: any) => { calls.push(o); return ok(JSON.stringify({ type: "turn.completed", usage: {} })); },
      }));
      expect(out.skipped).toBe("reviewer-unreadable");
      expect(calls.filter((c) => c.dispatchRole === "solo")).toHaveLength(0);
      expect(events).toContain("x_review_skipped");
      expect(events).not.toContain("x_review_rejected");
    });
  });

  test("the reviewer runs on the session's runtime by default", () => {
    deliver();
    const runtimes: string[] = [];
    runSoloReviewStage(args({ policy: "always", maxRounds: 0, runtimePref: "same", runImpl: (o: any) => { runtimes.push(o.runtime); return ok("{}"); } }));
    expect(runtimes).toEqual(["claude-code"]);
  });

  test("with `other`, a NOT_USE_* rule matching the brief keeps that runtime off the review", () => {
    deliver();
    const runtimes: string[] = [];
    runSoloReviewStage(args({
      policy: "always", maxRounds: 0, runtimePref: "other",
      available: (rt) => ["codex", "claude-code", "gemini-cli"].includes(rt),
      rules: [{ runtime: "codex", rule: "PRD tables monthly cost estimate", envKey: "NOT_USE_CODEX", sourceFile: null, negate: true }],
      runImpl: (o: any) => { runtimes.push(o.runtime); return ok("{}"); },
    }));
    expect(runtimes).toEqual(["gemini-cli"]);
  });

  test("corrections run as the solo worker, with the solo directive, the budget and the ledger", () => {
    deliver();
    const calls: any[] = [];
    runSoloReviewStage(args({
      policy: "always", maxRounds: 1, maxBudgetUsd: 3, ledger: { runId: "run-x" }, rulesDirective: "\nRULES",
      runImpl: (o: any) => { calls.push(o); return ok(o.sessionId ? "" : JSON.stringify({ confirmed: [{ id: "d1", evidence: "prd.md:10, the tables" }] })); },
    }));
    const [reviewer, fix] = calls;
    expect(reviewer.maxBudgetUsd).toBe(3);
    expect(reviewer.ledger).toEqual({ runId: "run-x", watchDir: outputs });
    expect(fix.dispatchRole).toBe("solo");
    expect(fix.appendSystemPrompt).toBe(soloDirective("\nRULES"));
    expect(fix.maxBudgetUsd).toBe(3);
    expect(fix.ledger).toEqual({ runId: "run-x", watchDir: outputs });
  });

  test("a launch that already carries the solo directive keeps it as it is", () => {
    deliver();
    const calls: any[] = [];
    const launchDirective = soloDirective("\nPROJECT RULES");
    runSoloReviewStage(args({
      policy: "always", maxRounds: 1,
      worker: { runtime: "claude-code", sessionId: "s-1", launch: { cwd: tmp, addDirs: [], appendSystemPrompt: launchDirective } },
      runImpl: (o: any) => { calls.push(o); return ok(o.sessionId ? "" : JSON.stringify({ confirmed: [{ id: "d1", evidence: "prd.md:10, the tables" }] })); },
    }));
    expect(calls.find((c) => c.dispatchRole === "solo").appendSystemPrompt).toBe(launchDirective);
  });

  test("a failed precheck triggers the review under the rule policy", () => {
    deliver([]);
    let calls = 0;
    const out = runSoloReviewStage(args({ maxRounds: 0, runImpl: () => { calls++; return ok("{}"); } }));
    expect(out.decision.reason).toBe("the deterministic precheck failed");
    expect(calls).toBe(1);
  });

  test("no deliverable at all: no reviewer; the worker gets the precheck back directly", () => {
    const calls: any[] = [];
    const events: string[] = [];
    const out = runSoloReviewStage(args({
      maxRounds: 1, emit: (e) => events.push(e),
      runImpl: (o: any) => { calls.push(o); return ok(""); },
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0].dispatchRole).toBe("solo");
    expect(calls[0].prompt).toContain("no deliverable file under the outputs root");
    expect(out.reviewer).toBeNull();
    expect(out.skipped).toBe("no-deliverable");
    expect(events).toContain("x_review_skipped");
  });

  test("a reviewer that dies is skipped with an event, never counted as a rejection", () => {
    deliver();
    const calls: any[] = [];
    const events: Array<[string, any]> = [];
    const out = runSoloReviewStage(args({
      policy: "always", emit: (e, p) => events.push([e, p]),
      runImpl: (o: any) => { calls.push(o); return { ok: false, runtime: o.runtime, sessionId: null, result: "", costUsd: null, durationMs: 1, error: "quota exhausted" } as any; },
    }));
    expect(calls).toHaveLength(1);
    expect(out.approved).toBeNull();
    expect(out.skipped).toBe("reviewer-failed");
    expect(out.blockingMissed).toEqual([]);
    expect(out.reservations).toBeNull();
    expect(events.find(([e]) => e === "x_review_skipped")?.[1].error).toBe("quota exhausted");
    expect(events.map(([e]) => e)).not.toContain("x_review_rejected");
  });

  test("a brief with no Done when is never approved, and the worker is not sent to fix what it cannot", () => {
    deliver();
    write(briefFile, "## Request (verbatim)\nx\n## Done when\nWhen it is good.\n");
    const calls: any[] = [];
    const out = runSoloReviewStage(args({ policy: "always", runImpl: (o: any) => { calls.push(o); return ok(JSON.stringify({ confirmed: [], notes: "nothing to check against" })); } }));
    expect(calls).toHaveLength(1);
    expect(out.approved).toBe(false);
    expect(fs.readFileSync(out.reservations!, "utf8")).toContain("no \"Done when\" items");
  });
});
