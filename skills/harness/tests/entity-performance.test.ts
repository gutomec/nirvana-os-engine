// entity-performance.test.ts — the per-entity view of the audit, the block a
// dispatch hands its worker when the same finding keeps coming back, and
// `nrv performance` as an agent runs it. Every log here is a fixture in a
// temporary folder.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { entityPerformance, recurringFindingsDirective, type EntityPerformance } from "../lib/entity-performance.ts";
import { failedRubricNames, GATE_FINDINGS_FILE, MATERIAL_DEFECT, UNPROVEN_CRITERION } from "../lib/delivery-pipeline.ts";
import { removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const SCRIPT = path.resolve(import.meta.dir, "..", "scripts", "performance.ts");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-performance-")));
const logs = path.join(root, "logs");
const empty = path.join(root, "empty-logs");
const oldOutputs = path.join(root, "outputs-t4");
afterAll(() => removeDir(root));

const day = new Date().toISOString().slice(0, 10);
const lines: string[] = [];
/** One event, `sec` seconds into today's fixture clock. */
function ev(trace: string, sec: number, event: string, payload: Record<string, unknown> = {}): void {
  const ts = new Date(Date.parse(`${day}T00:00:00.000Z`) + sec * 1000).toISOString();
  lines.push(JSON.stringify({ ts, event, trace_id: trace, project_id: trace, ...payload }));
}
const biz = (slug: string) => ({ business_slug: slug });
const dispatchBusiness = (trace: string, slug: string, mode = "headless-subprocess") => ev(trace, 0, "dispatch_business", { ...biz(slug), mode });

// acme: one run of each outcome.
// t1 passes the gate at the first round; the only run whose runtime reported a cost.
dispatchBusiness("t1", "acme");
ev("t1", 40, "agent_executed", { ...biz("acme"), cost_usd: 0.5, duration_ms: 40_000 });
ev("t1", 50, "gate_passed", { ...biz("acme"), revisions: 0 });
ev("t1", 60, "delivered", { ...biz("acme"), gate: "pass" });
// t2 passes after one correction.
dispatchBusiness("t2", "acme");
ev("t2", 30, "agent_executed", { ...biz("acme"), cost_usd: null, duration_ms: 30_000 });
ev("t2", 60, "revision_auto", { ...biz("acme"), attempt: 1, ok: true, failed_rubrics: ["no-placeholder", "wiki-lint"] });
ev("t2", 90, "gate_passed", { ...biz("acme"), revisions: 1 });
ev("t2", 120, "delivered", { ...biz("acme"), gate: "pass" });
// t3 never passes and is delivered with reservations; one correction did not run and is not a round.
dispatchBusiness("t3", "acme");
ev("t3", 50, "revision_auto", { ...biz("acme"), attempt: 1, ok: true, failed_rubrics: ["no-placeholder"] });
ev("t3", 60, "revision_auto", { ...biz("acme"), attempt: 2, ok: false, counted: false, failed_rubrics: ["no-placeholder"] });
ev("t3", 100, "gate_failed", { ...biz("acme"), revisions: 1, failed_rubrics: ["no-placeholder", "secret-leak"] });
ev("t3", 110, "x_delivered_with_reservations", biz("acme"));
ev("t3", 180, "delivered", { ...biz("acme"), gate: "fail-accepted", reservations: true });
// t4 is withheld, from before the audit named what failed: the findings file beside its outputs does.
dispatchBusiness("t4", "acme");
ev("t4", 200, "gate_failed", { ...biz("acme"), revisions: 0 });
ev("t4", 240, "x_delivery_withheld", { ...biz("acme"), outputs_root: oldOutputs, serious: ["report.md: brief-fidelity failed"] });
// t5 fails, t6 never ended, t7 only wrote the scaffold.
dispatchBusiness("t5", "acme");
ev("t5", 20, "agent_exec_failed", { ...biz("acme"), exit_code: 1 });
dispatchBusiness("t6", "acme");
dispatchBusiness("t7", "acme", "scaffold-only");

// writers: a squad with two gated runs, no cost on record. The pipeline's
// events carry no slug for a squad: the trace ties them to it.
for (const [trace, capability] of [["s1", "copy.write"], ["s2", "copy.write"]] as const) {
  ev(trace, 0, "dispatch_squad", { squad_slug: "writers", squad_name: "writers", capability_id: capability });
  ev(trace, 30, "revision_auto", { business_slug: null, attempt: 1, ok: true, failed_rubrics: ["tone"] });
  ev(trace, 60, "gate_passed", { business_slug: null, revisions: 1 });
  ev(trace, 90, "delivered", { business_slug: null, gate: "pass" });
}
// steady: three gated runs, a different finding each time. Nothing recurs.
["x1", "x2", "x3"].forEach((trace, i) => {
  dispatchBusiness(trace, "steady");
  ev(trace, 30, "revision_auto", { ...biz("steady"), attempt: 1, ok: true, failed_rubrics: [`finding-${i}`] });
  ev(trace, 60, "gate_passed", { ...biz("steady"), revisions: 1 });
  ev(trace, 90, "delivered", { ...biz("steady"), gate: "pass" });
});
// idle: dispatched once, nothing after it.
ev("i1", 0, "dispatch_squad", { squad_slug: "idle", squad_name: "idle" });

fs.mkdirSync(path.join(logs, day), { recursive: true });
fs.writeFileSync(path.join(logs, day, "audit.jsonl"), lines.join("\n") + "\nnot json\n");
fs.mkdirSync(empty, { recursive: true });
fs.mkdirSync(oldOutputs, { recursive: true });
fs.writeFileSync(path.join(oldOutputs, GATE_FINDINGS_FILE), [
  "# Gate findings", "",
  "## Gate run · t0 · 2026-01-01T00:00:00.000Z", "",
  "### Round 0 (first gate) · FAIL · 2026-01-01T00:00:00.000Z", "",
  "- `old.md` · `from-another-run`: not this trace",
  "",
  "## Gate run · t4 · 2026-01-02T00:00:00.000Z", "",
  "### Round 0 (first gate) · FAIL · 2026-01-02T00:00:00.000Z", "",
  "1 serious finding(s).", "",
  "- **SERIOUS** `page.html` · `html-valid`: the file is not HTML",
  "  - fix: close the body",
  "- `report.md` · `wiki-lint`: a dead link",
  "- **SERIOUS** `report.md` · judge: material defect: the numbers do not add up",
  "- **SERIOUS** blocking criterion `c1` (cites sources): no proof",
  "",
].join("\n"));

const find = (list: EntityPerformance[], kind: string, slug: string) => list.find(e => e.kind === kind && e.slug === slug)!;

describe("entityPerformance", () => {
  test("counts each outcome and sorts by runs", async () => {
    const report = await entityPerformance({ root: logs });
    expect(report.window_days).toBe(30);
    expect(report.entities.map(e => `${e.kind}:${e.slug}`)).toEqual(["business:acme", "business:steady", "squad:writers", "squad:idle"]);
    const acme = find(report.entities, "business", "acme");
    expect(acme).toMatchObject({ runs: 6, delivered: 2, delivered_with_reservations: 1, withheld: 1, failed: 1, other: 1 });
  });

  test("the gate rates count only the runs that reached the gate", async () => {
    const acme = find((await entityPerformance({ root: logs })).entities, "business", "acme");
    expect(acme.gated_runs).toBe(4);
    expect(acme.first_pass_gate_rate).toBe(0.25);
    // t2 and t3 took one round each; the correction that did not run is not one.
    expect(acme.mean_correction_rounds).toBe(0.5);
  });

  test("findings come from the audit, and from the findings file for an older run", async () => {
    const acme = find((await entityPerformance({ root: logs })).entities, "business", "acme");
    expect(acme.findings_known_runs).toBe(4);
    expect(acme.findings[0]).toEqual({ finding: "no-placeholder", runs: 2 });
    expect(acme.findings.find(f => f.finding === "wiki-lint")).toEqual({ finding: "wiki-lint", runs: 2 });
    const once = acme.findings.filter(f => f.runs === 1).map(f => f.finding).sort();
    expect(once).toEqual(["brief-fidelity", "html-valid", MATERIAL_DEFECT, "secret-leak", UNPROVEN_CRITERION].sort());
    expect(acme.findings.some(f => f.finding === "from-another-run")).toBe(false);
  });

  test("duration is a median over the runs that ended, cost a sum over the runs that reported one", async () => {
    const acme = find((await entityPerformance({ root: logs })).entities, "business", "acme");
    // t1 60s, t2 120s, t3 180s, t4 240s, t5 20s.
    expect(acme.median_duration_ms).toBe(120_000);
    expect(acme.total_cost_usd).toBe(0.5);
    expect(acme.cost_known_runs).toBe(1);
  });

  test("what the audit does not hold is null, never zero", async () => {
    const { entities } = await entityPerformance({ root: logs });
    const writers = find(entities, "squad", "writers");
    expect(writers).toMatchObject({ runs: 2, delivered: 2, gated_runs: 2, first_pass_gate_rate: 0, mean_correction_rounds: 1 });
    expect(writers.total_cost_usd).toBeNull();
    expect(writers.median_duration_ms).toBe(90_000);
    expect(writers.capabilities).toEqual([{ id: "copy.write", runs: 2 }]);
    const idle = find(entities, "squad", "idle");
    expect(idle).toMatchObject({ runs: 1, other: 1, gated_runs: 0 });
    expect(idle.first_pass_gate_rate).toBeNull();
    expect(idle.mean_correction_rounds).toBeNull();
    expect(idle.median_duration_ms).toBeNull();
    expect(idle.total_cost_usd).toBeNull();
  });

  test("an empty or missing log root is an empty report", async () => {
    expect((await entityPerformance({ root: empty })).entities).toEqual([]);
    expect((await entityPerformance({ root: path.join(root, "nowhere"), days: 7 })).entities).toEqual([]);
  });
});

describe("recurringFindingsDirective", () => {
  test("names what failed in two or more of at least three gated runs", async () => {
    const block = await recurringFindingsDirective("business", "acme", { root: logs });
    expect(block).toBe("\nRECURRING FINDINGS for this business in its last 4 runs: no-placeholder (2 of 4 runs); wiki-lint (2 of 4 runs). Get these right the first time.");
  });

  test("is empty below either threshold, for an unknown entity and when the log cannot be read", async () => {
    // Two gated runs with the same finding: not enough runs.
    expect(await recurringFindingsDirective("squad", "writers", { root: logs })).toBe("");
    // Three gated runs, no finding twice.
    expect(await recurringFindingsDirective("business", "steady", { root: logs })).toBe("");
    expect(await recurringFindingsDirective("business", "nobody", { root: logs })).toBe("");
    expect(await recurringFindingsDirective("business", "", { root: logs })).toBe("");
    expect(await recurringFindingsDirective("business", "acme", { root: path.join(logs, day, "audit.jsonl") })).toBe("");
  });
});

describe("failedRubricNames", () => {
  test("names the rubrics, a material defect and an unproven criterion once each", () => {
    const fail = (failedRubrics: string[], material: boolean) => ({ file: "a.md", fixes: [], failedRubrics, material });
    const run = { pass: false, fails: [fail(["wiki-lint", "tone"], true), fail(["tone"], false)], modes: {} };
    expect(failedRubricNames(run, 2)).toEqual([MATERIAL_DEFECT, "tone", UNPROVEN_CRITERION, "wiki-lint"]);
    expect(failedRubricNames({ pass: true, fails: [], modes: {} }, 0)).toEqual([]);
  });
});

describe("nrv performance", () => {
  function run(args: string[], logsDir = logs): { code: number; out: string; err: string } {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, env: { ...process.env, HARNESS_LOGS_DIR: logsDir }, encoding: "utf8" });
    return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
  }

  test("the table lists every entity and says how to read it", () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Performance of 4 entities over the last 30 day(s)");
    expect(r.out).toMatch(/business acme\s+6\s+2\s+1\s+1\s+1\s+1\s+25%\s+0\.5\s+2m 0s\s+\$0\.50\s+no-placeholder \(2\)/);
    expect(r.out).toMatch(/squad idle\s+1\s+0\s+0\s+0\s+0\s+1\s+unknown\s+unknown\s+unknown\s+unknown\s+-/);
    expect(r.out).toContain("it is not zero");
    expect(r.out.trimEnd().endsWith("?")).toBe(false);
  }, spawnBudgetMs(1));

  test("one entity in detail, with what the next worker is told", () => {
    const r = run(["business", "acme", "--days", "7"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("business acme: 6 run(s) in the last 7 day(s)");
    expect(r.out).toContain("2 delivered, 1 delivered with reservations, 1 withheld, 1 failed, 1 with no recorded end");
    expect(r.out).toContain("25% passed at the first round");
    expect(r.out).toContain("no-placeholder: 2 run(s)");
    expect(r.out).toContain("tells its worker up front about: no-placeholder, wiki-lint.");
    const idle = run(["squad", "idle"]);
    expect(idle.out).toContain("Cost: unknown");
    expect(idle.out).toContain("Nothing is passed to the next worker");
    expect(run(["squad", "nobody"]).out).toContain("has no run in the last 30 day(s)");
  }, spawnBudgetMs(3));

  test("--json parses, with nulls for what is unknown", () => {
    const all = JSON.parse(run(["--json"]).out);
    expect(all.ok).toBe(true);
    expect(all.entities).toHaveLength(4);
    expect(all.entities[0]).toMatchObject({ kind: "business", slug: "acme", runs: 6, first_pass_gate_rate: 0.25, total_cost_usd: 0.5 });
    const one = JSON.parse(run(["squad", "writers", "--json", "--days=14"]).out);
    expect(one.window_days).toBe(14);
    expect(one.entity).toMatchObject({ slug: "writers", total_cost_usd: null });
    expect(one.recurring).toEqual([]);
    expect(JSON.parse(run(["business", "nobody", "--json"]).out).entity).toBeNull();
    expect(JSON.parse(run(["--json"], empty).out).entities).toEqual([]);
  }, spawnBudgetMs(4));

  test("an empty audit and wrong arguments are said plainly", () => {
    expect(run([], empty).out).toContain("No business or squad was dispatched in the last 30 day(s)");
    for (const bad of [["business"], ["clone", "x"], ["--days", "soon"], ["--days", "0"], ["squad", "a", "b"]]) {
      const r = run(bad);
      expect(r.code).toBe(4);
      expect(r.err).toContain("usage: nrv performance");
    }
  }, spawnBudgetMs(6));
});
