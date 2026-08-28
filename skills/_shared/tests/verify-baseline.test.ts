// verify-baseline.test.ts — recorded debt may only shrink. Merge per entity,
// refusal of growth without --allow-regression, the one-time import of the
// two legacy baselines, and day-one grandfathering in hook mode.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyBaseline, importLegacy, loadBaseline, recordBaseline, verifyEntity, type Finding } from "../lib/verify/index.ts";
import { cloneFixture, rmrf, runCli, tempRoot } from "./helpers/verify-fixture.ts";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) rmrf(r); });
function root(): string { const r = tempRoot(); ROOTS.push(r); return r; }
const bl = (r: string) => path.join(r, "home", ".nirvana", ".verify-baseline.json");
const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

describe("merge and regression", () => {
  test("recording from A never erases what only B recorded; a clean entity is cleared", () => {
    const r = root();
    const file = bl(r);
    expect(recordBaseline(file, [{ kind: "mind-clone", slug: "a", debt: ["validation_verdict_missing"] }]).ok).toBe(true);
    // b is new to this baseline, so its debt is growth: deliberate, like a
    // pack recorded for the first time next to one already on record.
    expect(recordBaseline(file, [{ kind: "mind-clone", slug: "b", debt: ["source_material_missing"] }]).ok).toBe(false);
    expect(recordBaseline(file, [{ kind: "mind-clone", slug: "b", debt: ["source_material_missing"] }], { allowRegression: true }).ok).toBe(true);
    // recording b did not touch a: the merge is per entity, never a replace
    expect(read(file).entities).toEqual({ "mind-clone:a": ["validation_verdict_missing"], "mind-clone:b": ["source_material_missing"] });
    expect(recordBaseline(file, [{ kind: "mind-clone", slug: "a", debt: [] }]).ok).toBe(true);
    expect(read(file).entities).toEqual({ "mind-clone:b": ["source_material_missing"] });
  }, spawnBudgetMs(2));

  test("growth is refused without allowRegression, and named", () => {
    const r = root();
    const file = bl(r);
    recordBaseline(file, [{ kind: "mind-clone", slug: "a", debt: ["validation_verdict_missing"] }]);
    const refused = recordBaseline(file, [{ kind: "mind-clone", slug: "a", debt: ["validation_verdict_missing", "source_material_missing"] }]);
    expect(refused.ok).toBe(false);
    expect(refused.regressions).toEqual([{ entity: "mind-clone:a", added: ["source_material_missing"] }]);
    expect(read(file).entities["mind-clone:a"]).toEqual(["validation_verdict_missing"]);
    const allowed = recordBaseline(file, [{ kind: "mind-clone", slug: "a", debt: ["validation_verdict_missing", "source_material_missing"] }], { allowRegression: true });
    expect(allowed.ok).toBe(true);
    expect(read(file).entities["mind-clone:a"]).toEqual(["source_material_missing", "validation_verdict_missing"]);
  }, spawnBudgetMs(2));

  test("a first record with no baseline is never a regression", () => {
    const r = root();
    expect(recordBaseline(bl(r), [{ kind: "business", slug: "x", debt: ["seat_thin:employees/ceo.md"] }]).ok).toBe(true);
  }, spawnBudgetMs(2));
});

describe("applyBaseline", () => {
  test("marks only baselineable ids that the baseline records, keyed by id[:where]", () => {
    const mk = (id: string, where?: string): Finding => ({ id, severity: "warning", autofix: "none", message: "", evidence: "", ...(where ? { where } : {}), baselined: false });
    const findings = [mk("validation_verdict_missing"), mk("seat_thin", "employees/ceo.md"), mk("seat_thin", "employees/cto.md"), mk("one_liner_too_long")];
    const baseline = { recorded_at: "t", entities: { "business:acme": ["validation_verdict_missing", "seat_thin:employees/ceo.md", "one_liner_too_long"] } };
    applyBaseline("business", "acme", findings, new Set(["validation_verdict_missing", "seat_thin"]), baseline);
    expect(findings.map((f) => f.baselined)).toEqual([true, true, false, false]);
  }, spawnBudgetMs(2));
});

describe("legacy import", () => {
  test("imports .admission-baseline.json and .seat-sufficiency-baseline.json once", () => {
    const r = root();
    const dir = path.join(r, "home", ".nirvana");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".admission-baseline.json"), JSON.stringify({ recorded_at: "t", entities: { jane: ["no_verdict", "no_source"], "acme/ceo.md": ["thin_seat"] } }));
    fs.writeFileSync(path.join(dir, ".seat-sufficiency-baseline.json"), JSON.stringify({ recorded_at: "t", thin_seats: ["acme/cto.md", "beta/ops.md"] }));
    const imported = importLegacy(dir);
    expect(imported.sources.length).toBe(2);
    const b = loadBaseline(bl(r));
    expect(b?.entities).toEqual({
      "business:acme": ["seat_thin:employees/ceo.md", "seat_thin:employees/cto.md"],
      "business:beta": ["seat_thin:employees/ops.md"],
      "mind-clone:jane": ["source_material_missing", "validation_verdict_missing"],
    });
    expect(b?.imported_from?.length).toBe(2);
    expect(fs.existsSync(bl(r))).toBe(true);
    // second load reads the written file: the legacy files are not consulted again
    fs.writeFileSync(path.join(dir, ".admission-baseline.json"), JSON.stringify({ entities: { other: ["no_verdict"] } }));
    expect(Object.keys(loadBaseline(bl(r))!.entities)).not.toContain("mind-clone:other");
    expect(read(path.join(dir, ".admission-baseline.json")).entities.other).toEqual(["no_verdict"]);
  });

  test("no baseline and no legacy files → null, nothing written", () => {
    const r = root();
    expect(loadBaseline(bl(r))).toBeNull();
    expect(fs.existsSync(bl(r))).toBe(false);
  }, spawnBudgetMs(2));
});

describe("grandfathering", () => {
  test("hook mode with no baseline records the entity's debt and admits it; the CLI stays honest", async () => {
    const r = root();
    const dir = cloneFixture(r, "jane-doe", { verdict: null });
    const events: Array<[string, Record<string, unknown>]> = [];
    const hook = await verifyEntity("mind-clone", dir, { mode: "hook", retrieval: false, baselinePath: bl(r), stateDir: null, emit: (e, p) => events.push([e, p]) });
    expect(hook.summary).toMatchObject({ errors: 0, warnings: 0, debt: 1 });
    expect(hook.baseline).toEqual({ present: true, debt: 1 });
    expect(hook.exit_code).toBe(0);
    expect(read(bl(r)).entities).toEqual({ "mind-clone:jane-doe": ["validation_verdict_missing"] });
    expect(events.map((e) => e[0])).toEqual(["x_verify_baseline_recorded", "x_verify_mind_clone"]);
    expect(events[0][1]).toMatchObject({ reason: "hook_grandfathering", entity: "mind-clone:jane-doe" });

    // a second hook call finds the baseline and simply applies it
    const again = await verifyEntity("mind-clone", dir, { mode: "hook", retrieval: false, baselinePath: bl(r), stateDir: null, emit: null });
    expect(again.summary.debt).toBe(1);

    // the explicit CLI with no baseline counts the warning (and rejects under --strict)
    const r2 = root();
    cloneFixture(r2, "jane-doe", { verdict: null });
    expect(runCli(r2, ["mind-clone", "jane-doe", "--strict", "--no-retrieval"]).code).toBe(2);
    expect(fs.existsSync(bl(r2))).toBe(false);
  }, spawnBudgetMs(2));

  test("--all --record then --all --strict: recorded debt no longer rejects; growth is refused", () => {
    const r = root();
    cloneFixture(r, "alpha", { verdict: null });
    cloneFixture(r, "beta");
    const rootArg = ["--root", path.join(r, "dna"), "--no-retrieval"];
    expect(runCli(r, ["mind-clone", "--all", "--strict", ...rootArg]).code).toBe(2);
    const rec = runCli(r, ["mind-clone", "--all", "--record", "--json", ...rootArg]);
    expect(rec.code).toBe(0);
    expect(rec.json.baseline.recorded).toBe(true);
    expect(read(bl(r)).entities).toEqual({ "mind-clone:alpha": ["validation_verdict_missing"] });
    expect(runCli(r, ["mind-clone", "--all", "--strict", ...rootArg]).code).toBe(0);
    // alpha gains debt: refused, then accepted deliberately
    cloneFixture(r, "alpha", { verdict: null, sourceMaterial: false });
    const refused = runCli(r, ["mind-clone", "--all", "--record", ...rootArg]);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain("Refusing to record");
    expect(read(bl(r)).entities["mind-clone:alpha"]).toEqual(["validation_verdict_missing"]);
    expect(runCli(r, ["mind-clone", "--all", "--record", "--allow-regression", ...rootArg]).code).toBe(0);
    expect(read(bl(r)).entities["mind-clone:alpha"]).toEqual(["source_material_missing", "validation_verdict_missing"]);
    // --baseline <file> points elsewhere
    const other = path.join(r, "other-baseline.json");
    expect(runCli(r, ["mind-clone", "--all", "--record", "--baseline", other, ...rootArg]).code).toBe(0);
    expect(fs.existsSync(other)).toBe(true);
  }, spawnBudgetMs(2));
});
