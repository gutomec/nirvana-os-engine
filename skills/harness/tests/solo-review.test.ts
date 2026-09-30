// solo-review.test.ts — review as an exception decided by a rule, one reviewer
// per delivery on another runtime when possible, at most max_rounds corrections
// in the worker's own session, then reservations for what never held.
// Hermetic: canned runners stand in for the runtimes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildRevisionPrompt, buildSoloReviewPrompt, businessWantsReview, decideReview, deliverableFiles, pickReviewRuntime,
  precheckSolo, runSoloReviewStage, scoreSoloReview, type ReviewSignals, type SoloReviewArgs,
} from "../lib/solo-review.ts";
import type { Criterion } from "../lib/work-brief.ts";

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
  test("a manifest asks for review with review: required or review_required: true", () => {
    expect(businessWantsReview(bizDir)).toBe(false);
    write(path.join(bizDir, "business.yaml"), "name: biz\nreview: required\n");
    expect(businessWantsReview(bizDir)).toBe(true);
    write(path.join(bizDir, "business.yaml"), "name: biz\nreview_required: true\n");
    expect(businessWantsReview(bizDir)).toBe(true);
  });

  test("the reviewer runs on another available runtime, else on the worker's", () => {
    expect(pickReviewRuntime("other", "claude-code", (rt) => rt === "codex" || rt === "claude-code")).toBe("codex");
    expect(pickReviewRuntime("other", "codex", (rt) => rt === "codex" || rt === "claude-code")).toBe("claude-code");
    expect(pickReviewRuntime("other", "claude-code", (rt) => rt === "claude-code")).toBe("claude-code");
    expect(pickReviewRuntime("same", "claude-code", () => true)).toBe("claude-code");
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

  test("the worker's own reports and working folder are not deliverables", () => {
    deliver();
    write(path.join(outputs, "_work", "PROGRESS.md"), "p");
    expect(deliverableFiles(outputs)).toEqual(["prd.md"]);
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

  test("everything confirmed with evidence approves", () => {
    const s = scoreSoloReview({ confirmed: [{ id: "d1", evidence: "prd.md:10, the tables" }, { id: "d2", evidence: "cost.md:3, monthly total" }] }, CRITERIA);
    expect(s.approved).toBe(true);
    expect(s.score).toBe(1);
  });

  test("the prompts carry the criteria, the claims and the gaps", () => {
    const p = buildSoloReviewPrompt({ business: "biz", briefFile, outputsRoot: outputs, criteria: CRITERIA, claims: [{ id: "d1", evidence: "prd.md:10" }] });
    expect(p).toContain("- `d1` **(blocking)**: The PRD lists every table");
    expect(p).toContain("- `d1`: prd.md:10");
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

  test("rejected: one correction in the worker's own session, then reservations", () => {
    deliver();
    const calls: any[] = [];
    const out = runSoloReviewStage(args({
      policy: "always",
      runImpl: (o: any) => { calls.push(o); return ok(o.sessionId ? "" : "{}"); },
    }));
    expect(calls.map((c) => [c.runtime, c.sessionId ?? null, c.dispatchRole])).toEqual([
      ["codex", null, "planner"], ["claude-code", "s-1", "solo"], ["codex", null, "planner"],
    ]);
    expect(out.rounds).toBe(1);
    expect(out.approved).toBe(false);
    expect(fs.readFileSync(out.reservations!, "utf8")).toContain("**blocking** The PRD lists every table");
  });

  test("a failed precheck triggers the review under the rule policy", () => {
    let calls = 0;
    const out = runSoloReviewStage(args({ maxRounds: 0, runImpl: () => { calls++; return ok("{}"); } }));
    expect(out.decision.reason).toBe("the deterministic precheck failed");
    expect(calls).toBe(1);
  });
});
