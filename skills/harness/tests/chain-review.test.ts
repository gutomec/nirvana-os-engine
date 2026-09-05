// chain-review.test.ts — the immediate superior as reviewer, and the one
// property the whole design rests on: silence rejects.
//
// A reviewer asked "is your subordinate's work good?" says yes — same model,
// same run, no incentive to object. So approval is not asked for. The reviewer
// reports what it CONFIRMED, with evidence, and the engine does the arithmetic:
// anything unmentioned is unconfirmed, and unconfirmed does not score. The lazy
// path therefore rejects instead of approving, which is the inversion that makes
// a checklist worth having.
//
// Zero-token: the verdict is a file, so no reviewer needs to run to test how a
// verdict is judged. Runs with: bun test skills/harness/tests
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const CLI = path.resolve(import.meta.dir, "..", "scripts", "chain.ts");
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-review-"));
  fs.mkdirSync(path.join(tmp, ".nirvana"), { recursive: true });
});
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

function manifest(slug: string): string {
  return [
    `name: ${slug}`, "author: nirvana-os", "version: 1.0.0", "protocol: '2.0'",
    `description: A fixture business used by the ${slug} review tests.`,
    "domains:", "  - testing",
    "runtime_requirements:", "  minimum:", "    - runtime: claude-code", "",
  ].join("\n");
}

/** Two seats: a worker with two declared criteria, and the boss above it. */
function business(): string {
  const dir = path.join(tmp, "businesses", "acme");
  fs.mkdirSync(path.join(dir, "employees"), { recursive: true });
  fs.writeFileSync(path.join(dir, "business.yaml"), manifest("acme"), "utf8");
  fs.writeFileSync(path.join(dir, "org-chart.yaml"),
    "chart:\n- employee: boss\n  reports: []\n  direct_reports:\n  - worker\n- employee: worker\n  reports:\n  - boss\n  direct_reports: []\n", "utf8");
  fs.writeFileSync(path.join(dir, "employees", "worker.md"),
    "---\nname: worker\nrole: worker specialist\ndescription: The worker seat of this fixture business.\n"
    + "acceptance:\n"
    + "  - id: has_three_items\n    description: \"The file lists exactly three items, each one a full line\"\n    blocking: true\n    minimum_score: 0.9\n"
    + "  - id: names_a_source\n    description: \"Each item names where it came from\"\n    blocking: false\n    minimum_score: 0.9\n"
    + "---\n\n# worker\n\nMethod of worker.\n", "utf8");
  fs.writeFileSync(path.join(dir, "employees", "boss.md"),
    "---\nname: boss\nrole: boss specialist\ndescription: The boss seat of this fixture business.\nis_brief_intake: true\n"
    + "acceptance:\n  - id: signs_the_delivery\n    description: \"The delivery is assembled and signed by the head of the house\"\n    blocking: true\n    minimum_score: 0.9\n"
    + "---\n\n# boss\n\nMethod of boss.\n", "utf8");
  return dir;
}

/** A plan written by hand — `plan` needs a director; judging a verdict does not. */
function plan(): string {
  business();
  const p = path.join(tmp, "plan.json");
  fs.writeFileSync(p, JSON.stringify({
    business: "acme", project_id: "proj-review-1", project_dir: tmp, project_root: tmp,
    outputs_root: path.join(tmp, "out"), brief_file: brief(),
    businesses_root: path.join(tmp, "businesses"), intake: "boss", reason: "fixture",
    chain: [
      { employee: "worker", task: "List three items.", reviewer: "boss" },
      { employee: "boss", task: "Assemble and sign." },
    ],
  }, null, 2));
  return p;
}

function brief(): string {
  const f = path.join(tmp, "brief.md");
  fs.writeFileSync(f, "Liste três itens sobre o assunto.", "utf8");
  return f;
}

function run(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8", cwd: tmp,
    env: { ...process.env, HARNESS_LOGS_DIR: path.join(tmp, ".nirvana", "logs", "harness") },
  });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function verdict(p: string, idx: number, body: unknown): { code: number; out: string; err: string } {
  const f = path.join(tmp, `v-${idx}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
  return run(["verdict", "--plan", p, "--index", String(idx), "--verdict", f]);
}

function audit(): any[] {
  const day = new Date().toISOString().slice(0, 10);
  const f = path.join(tmp, ".nirvana", "logs", "harness", day, "audit.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
}

describe("nrv team review", () => {
  test("the reviewer gets its own persona, the brief, and the subordinate's criteria", () => {
    const p = plan();
    const r = run(["review", "--plan", p, "--index", "0"]);
    expect(r.code).toBe(0);
    // Its own seat, not a generic judge — that is the whole reason to ask a boss.
    expect(r.out).toContain("Method of boss");
    // What the client asked, so the review can compare delivery against request.
    expect(r.out).toContain("Liste três itens sobre o assunto.");
    // And the criteria the SUBORDINATE declared, verbatim, blocking marked.
    expect(r.out).toContain("`has_three_items`");
    expect(r.out).toContain("(blocking)");
    expect(r.out).toContain("`names_a_source`");
    expect(r.err).toContain("boss reviewing worker");
  }, spawnBudgetMs(3));

  test("the root of the chart has nobody above it, and the refusal says so", () => {
    const p = plan();
    const r = run(["review", "--plan", p, "--index", "1"]);
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/root of the org chart|signs for the delivery/);
  }, spawnBudgetMs(2));
});

describe("nrv team verdict — silence rejects", () => {
  test("a reviewer that confirms nothing FAILS, rather than waving it through", () => {
    const p = plan();
    const r = verdict(p, 0, { confirmed: [], notes: "looks fine to me" });
    expect(r.code).toBe(3);
    const out = JSON.parse(r.out);
    expect(out.verdict).toBe("rejected");
    expect(out.score).toBe(0);
    // The gap says the reviewer never mentioned it — not that the work is bad.
    expect(out.gaps.find((g: any) => g.id === "has_three_items").why).toMatch(/not mentioned/);
  }, spawnBudgetMs(2));

  test("real evidence on every criterion approves", () => {
    const p = plan();
    const r = verdict(p, 0, { confirmed: [
      { id: "has_three_items", evidence: "01-worker.md:3-5 — three full lines" },
      { id: "names_a_source", evidence: "01-worker.md:3 — each line ends with a citation" },
    ] });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).verdict).toBe("approved");
    expect(JSON.parse(r.out).score).toBe(1);
  }, spawnBudgetMs(2));

  test("a blocking criterion left unconfirmed sinks the review whatever the score", () => {
    const p = plan();
    // Half the criteria confirmed: 0.5, under the floor anyway — so confirm the
    // NON-blocking one and leave the blocking one out, which is the case the
    // floor alone would not catch if there were ten criteria.
    const r = verdict(p, 0, { confirmed: [{ id: "names_a_source", evidence: "01-worker.md:3 — sources cited inline" }] });
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).blocking_missed).toEqual(["has_three_items"]);
  }, spawnBudgetMs(2));

  test("evidence that is a shrug does not count as evidence", () => {
    const p = plan();
    const r = verdict(p, 0, { confirmed: [
      { id: "has_three_items", evidence: "ok" },
      { id: "names_a_source", evidence: "" },
    ] });
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).confirmed).toEqual([]);
  }, spawnBudgetMs(2));

  test("a criterion the seat never declared is dropped and named", () => {
    const p = plan();
    const r = verdict(p, 0, { confirmed: [{ id: "invented_rule", evidence: "I checked it thoroughly and it holds" }] });
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).invented_ids).toEqual(["invented_rule"]);
    expect(r.err).toMatch(/not in worker's acceptance were dropped/);
  }, spawnBudgetMs(2));

  test("a fenced or chatty answer still parses — punctuation is not the contract", () => {
    const p = plan();
    const r = verdict(p, 0, "Here is my review:\n```json\n"
      + JSON.stringify({ confirmed: [
        { id: "has_three_items", evidence: "01-worker.md:3-5 — three full lines" },
        { id: "names_a_source", evidence: "01-worker.md:3 — citations inline" },
      ] }) + "\n```\nHope that helps.");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).verdict).toBe("approved");
  }, spawnBudgetMs(2));
});

describe("the audit can answer who reviewed what, and why it failed", () => {
  test("every verdict carries the trace, the pair, the score and the gaps", () => {
    const p = plan();
    verdict(p, 0, { confirmed: [] });
    const e = audit().find(x => x.event === "x_review_rejected");
    // Finding 16 of the observability notes: gate verdicts carry no trace, so
    // "did this run pass" cannot be answered by a join. These do.
    expect(e?.trace_id).toBe("proj-review-1");
    expect(e?.project_id).toBe("proj-review-1");
    expect(e?.business_slug).toBe("acme");
    expect(e?.employee).toBe("worker");
    expect(e?.reviewer).toBe("boss");
    expect(e?.score).toBe(0);
    expect(e?.floor).toBe(0.9);
    expect(e?.blocking_missed).toEqual(["has_three_items"]);
  }, spawnBudgetMs(2));

  test("an approval is logged as its own event, not as the absence of a rejection", () => {
    const p = plan();
    verdict(p, 0, { confirmed: [
      { id: "has_three_items", evidence: "01-worker.md:3-5 — three full lines" },
      { id: "names_a_source", evidence: "01-worker.md:3 — citations inline" },
    ] });
    const e = audit().find(x => x.event === "x_review_approved");
    expect(e?.employee).toBe("worker");
    expect(e?.score).toBe(1);
    expect(e?.confirmed).toEqual(["has_three_items", "names_a_source"]);
  }, spawnBudgetMs(2));
});

describe("nrv team receipt — computed, never narrated", () => {
  // The failure this whole line of work started from was a deliverable crediting
  // six seats with one dispatch event behind them. A receipt assembled from the
  // audit cannot make that mistake: there is nothing to read for a seat that
  // never ran. So the head does not write the receipt — the engine does.
  test("a plan whose seats never ran is refused, and names who is missing", () => {
    const p = plan();
    const r = run(["receipt", "--plan", p]);
    expect(r.code).toBe(3);
    const out = JSON.parse(r.out);
    expect(out.complete).toBe(false);
    expect(out.never_dispatched).toEqual(["worker", "boss"]);
    expect(r.err).toMatch(/do NOT report this business as delivered/);
  }, spawnBudgetMs(2));

  test("dispatched and approved seats sign off; the root needs no superior", () => {
    const p = plan();
    // The two events a real run would leave behind, written straight into the
    // audit the receipt reads — no agent needs to run to test the arithmetic.
    run(["step", "--plan", p, "--index", "0"]);
    run(["step", "--plan", p, "--index", "1"]);
    verdict(p, 0, { confirmed: [
      { id: "has_three_items", evidence: "01-worker.md:3-5 — three full lines" },
      { id: "names_a_source", evidence: "01-worker.md:3 — citations inline" },
    ] });

    const r = run(["receipt", "--plan", p]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.complete).toBe(true);
    expect(out.seats.find((x: any) => x.seat === "worker").review).toBe("approved");
    // The head of the house signs; nobody reviews it, and that is not a gap.
    expect(out.seats.find((x: any) => x.seat === "boss").review).toBe("signs (no superior)");
    expect(audit().some(e => e.event === "x_business_signed_off")).toBe(true);
  }, spawnBudgetMs(4));

  test("a seat that ran but was rejected keeps the business unsigned", () => {
    const p = plan();
    run(["step", "--plan", p, "--index", "0"]);
    run(["step", "--plan", p, "--index", "1"]);
    verdict(p, 0, { confirmed: [] });

    const r = run(["receipt", "--plan", p]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).review_unresolved).toEqual(["worker"]);
    expect(audit().some(e => e.event === "x_business_incomplete")).toBe(true);
  }, spawnBudgetMs(4));
});
