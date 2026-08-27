// verify-runner.test.ts — the CLI contract of `nrv validate`: exit codes
// 0/1/2/64, --strict, the JSON shapes, --all, --pack, kind autodetection by
// path, state and audit side effects. Every fixture lives under mkdtemp and
// the CLI env points every root, the state dir, the logs and the baseline at
// it — the installed library is never read or written.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { businessFixture, cloneFixture, rmrf, runCli, squadFixture, tempRoot } from "./helpers/verify-fixture.ts";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) rmrf(r); });
function root(): string { const r = tempRoot(); ROOTS.push(r); return r; }

describe("exit codes", () => {
  test("a complete clone is admitted (0) by path and by slug", () => {
    const r = root();
    const dir = cloneFixture(r, "jane-doe");
    const byPath = runCli(r, ["mind-clone", dir, "--no-retrieval"]);
    expect(byPath.stderr).toBe("");
    expect(byPath.code).toBe(0);
    expect(byPath.stdout).toContain("ADMITTED");
    const bySlug = runCli(r, ["mind-clone", "jane-doe", "--no-retrieval"]);
    expect(bySlug.code).toBe(0);
    for (const alias of ["clone", "mc"]) expect(runCli(r, [alias, "jane-doe", "--no-retrieval"]).code).toBe(0);
  }, spawnBudgetMs(2));

  test("an error rejects (1)", () => {
    const r = root();
    const dir = cloneFixture(r, "jane-doe");
    fs.rmSync(path.join(dir, "agent", "SOUL.md"));
    const out = runCli(r, ["mind-clone", "jane-doe", "--no-retrieval"]);
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("artifact_missing:agent/SOUL.md");
    expect(out.stdout).toContain("REJECTED");
  }, spawnBudgetMs(2));

  test("warnings only: 0 by default, 2 under --strict", () => {
    const r = root();
    cloneFixture(r, "jane-doe", { routing: { one_liner: "x".repeat(130) } });
    expect(runCli(r, ["mind-clone", "jane-doe", "--no-retrieval"]).code).toBe(0);
    const strict = runCli(r, ["mind-clone", "jane-doe", "--no-retrieval", "--strict"]);
    expect(strict.code).toBe(2);
    expect(strict.stdout).toContain("one_liner_too_long");
  }, spawnBudgetMs(2));

  test("usage errors and unknown entities exit 64", () => {
    const r = root();
    cloneFixture(r, "jane-doe");
    expect(runCli(r, ["mind-clone", "nobody", "--no-retrieval"]).code).toBe(64);
    expect(runCli(r, ["dragon", "jane-doe"]).code).toBe(64);
    expect(runCli(r, ["mind-clone", "jane-doe", "--bogus"]).code).toBe(64);
    expect(runCli(r, ["mind-clone"]).code).toBe(64);
    expect(runCli(r, ["mind-clone", "jane-doe", "--fix=agentic", "--budget-usd", "nope"]).code).toBe(64);
    expect(runCli(r, ["--help"]).code).toBe(0);
  }, spawnBudgetMs(2));
});

describe("--fix=agentic", () => {
  test("a spend is never silent: no --yes, exit 2, and nothing was touched", () => {
    const r = root();
    // `not_for` absent is an `autofix: "agentic"` finding — the mode has
    // something to do, so the confirmation is the only thing standing in the
    // way. With the fixture complete there would be nothing to confirm.
    const dir = cloneFixture(r, "jane-doe", { routing: { not_for: undefined } });
    const before = fs.readFileSync(path.join(dir, "MANIFEST.yaml"), "utf8");
    const out = runCli(r, ["mind-clone", "jane-doe", "--fix=agentic", "--no-retrieval"]);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("Re-run with --yes");
    expect(out.stderr).toContain("$3.00");
    expect(fs.readFileSync(path.join(dir, "MANIFEST.yaml"), "utf8")).toBe(before);
  }, spawnBudgetMs(2));

  test("--budget-usd names the ceiling the confirmation quotes", () => {
    const r = root();
    cloneFixture(r, "jane-doe", { routing: { not_for: undefined } });
    const out = runCli(r, ["mind-clone", "jane-doe", "--fix=agentic", "--budget-usd", "0.5", "--no-retrieval"]);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("$0.50");
  }, spawnBudgetMs(2));
});

describe("--json", () => {
  test("is nirvana.verify-report/v1 with the documented keys", () => {
    const r = root();
    fs.rmSync(path.join(cloneFixture(r, "jane-doe"), "agent", "DNA-CONFIG.yaml"));
    const out = runCli(r, ["mind-clone", "jane-doe", "--json", "--no-retrieval"]);
    expect(out.code).toBe(1);
    const j = out.json;
    expect(j.schema).toBe("nirvana.verify-report/v1");
    expect(j.kind).toBe("mind-clone");
    expect(j.slug).toBe("jane-doe");
    expect(j.verdict).toBe("REJECTED");
    expect(Object.keys(j.summary).sort()).toEqual(["debt", "errors", "passed", "warnings"]);
    expect(j.summary.errors).toBe(1);
    expect(j.summary.passed).toBeGreaterThan(20);
    expect(Array.isArray(j.findings)).toBe(true);
    const f = j.findings.find((x: any) => x.id === "artifact_missing");
    expect(f).toMatchObject({ severity: "error", autofix: "none", where: "agent/DNA-CONFIG.yaml", baselined: false });
    expect(typeof f.message).toBe("string");
    expect(typeof f.evidence).toBe("string");
    expect(j.fixes).toEqual([]);
    expect(j.fix_outcome).toBeNull();
    expect(j.baseline).toEqual({ present: false, debt: 0 });
    expect(j.exit_code).toBe(1);
  }, spawnBudgetMs(2));

  test("registry_absent is an info finding that never changes the verdict", () => {
    const r = root();
    cloneFixture(r, "jane-doe-verify-fixture-zz");
    const out = runCli(r, ["mind-clone", "jane-doe-verify-fixture-zz", "--json"]);
    expect(out.code).toBe(0);
    const info = out.json.findings.find((x: any) => x.id === "registry_absent");
    expect(info?.severity).toBe("info");
    expect(out.json.summary.warnings).toBe(0);
  }, spawnBudgetMs(2));
});

describe("--all and --pack", () => {
  test("--all over a root reports every entity and rejects when one has an error", () => {
    const r = root();
    cloneFixture(r, "alpha");
    fs.rmSync(path.join(cloneFixture(r, "beta"), "agent", "SOUL.md"));
    const out = runCli(r, ["mind-clone", "--all", "--root", path.join(r, "dna"), "--json", "--no-retrieval"]);
    expect(out.code).toBe(1);
    const b = out.json;
    expect(b.schema).toBe("nirvana.verify-batch/v1");
    expect(b.mode).toBe("all");
    expect(b.entities).toBe(2);
    expect(b.summary).toMatchObject({ admitted: 1, rejected: 1, errors: 1 });
    expect(b.reports.map((x: any) => x.slug)).toEqual(["alpha", "beta"]);
    expect(b.exit_code).toBe(1);
    const text = runCli(r, ["mind-clone", "--all", "--root", path.join(r, "dna"), "--no-retrieval", "--quiet"]);
    expect(text.stdout).toContain("beta");
    expect(text.stdout).not.toContain("alpha");
  }, spawnBudgetMs(2));

  test("--all uses the installed root when no --root is given", () => {
    const r = root();
    cloneFixture(r, "alpha");
    const out = runCli(r, ["mind-clone", "--all", "--json", "--no-retrieval"]);
    expect(out.code).toBe(0);
    expect(out.json.entities).toBe(1);
  }, spawnBudgetMs(2));

  test("--pack walks <dir>/{squads,businesses,mind-clones}", () => {
    const r = root();
    const pack = path.join(r, "pack");
    fs.mkdirSync(pack);
    // reuse the fixture builders by pointing them at the pack layout
    const fake = { dna: path.join(pack, "mind-clones"), squads: path.join(pack, "squads") };
    fs.mkdirSync(fake.dna); fs.mkdirSync(fake.squads);
    const tmp = tempRoot(); ROOTS.push(tmp);
    fs.cpSync(cloneFixture(tmp, "gamma"), path.join(fake.dna, "gamma"), { recursive: true });
    fs.cpSync(squadFixture(tmp, "one-squad", { surface: false }), path.join(fake.squads, "one-squad"), { recursive: true });
    const out = runCli(r, ["--pack", pack, "--json"]);
    expect(out.code).toBe(1);
    expect(out.json.mode).toBe("pack");
    expect(out.json.kinds.sort()).toEqual(["mind-clone", "squad"]);
    expect(out.json.reports.find((x: any) => x.slug === "one-squad").findings.map((f: any) => f.id)).toContain("surface_missing");
    expect(runCli(r, ["--pack", pack, "mind-clone", "--json"]).json.entities).toBe(1);
    expect(fs.existsSync(path.join(r, "state", "gamma"))).toBe(false); // pack entities are not installed: no state
  }, spawnBudgetMs(2));
});

describe("kinds", () => {
  test("a path is autodetected for squads and businesses; --fix regenerates a missing surface", () => {
    const r = root();
    const squad = squadFixture(r, "one-squad", { surface: false });
    const biz = businessFixture(r, "one-biz");
    expect(runCli(r, [biz]).code).toBe(0);
    const before = runCli(r, [squad, "--json"]);
    expect(before.code).toBe(1);
    expect(before.json.kind).toBe("squad");
    expect(before.json.findings[0].id).toBe("surface_missing");
    const fixed = runCli(r, [squad, "--fix", "--json"]);
    expect(fixed.code).toBe(0);
    expect(fs.existsSync(path.join(squad, ".nirvana-surface.json"))).toBe(true);
    expect(fixed.json.fix_outcome).toMatchObject({ mode: "mechanical", rolled_back: false, before: { errors: 1 }, after: { errors: 0 } });
    expect(runCli(r, ["squad", "one-squad", "--json"]).json.verdict).toBe("ADMITTED");
    expect(runCli(r, ["biz", "one-biz"]).code).toBe(0);
    expect(runCli(r, ["business", "one-biz", "--strict"]).code).toBe(0);
  }, spawnBudgetMs(2));

  test("a manifest that does not parse is manifest_parse", () => {
    const r = root();
    const squad = squadFixture(r, "bad-squad", { manifest: "name: [unclosed\n" });
    const out = runCli(r, ["squad", "bad-squad", "--json"]);
    expect(out.code).toBe(1);
    expect(out.json.findings.map((f: any) => f.id)).toContain("manifest_parse");
    // a squad path the kind does not own is unknown, not a crash
    expect(runCli(r, ["business", squad]).code).toBe(64);
  }, spawnBudgetMs(2));
});

describe("side effects", () => {
  test("writes SQUADS_STATE_DIR/<slug>/verify.json and audits x_verify_<kind>", () => {
    const r = root();
    cloneFixture(r, "jane-doe");
    expect(runCli(r, ["mind-clone", "jane-doe", "--no-retrieval"]).code).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(r, "state", "jane-doe", "verify.json"), "utf8"));
    expect(state.schema).toBe("nirvana.verify-report/v1");
    expect(state.kind).toBe("mind-clone");
    const day = new Date().toISOString().slice(0, 10);
    const log = fs.readFileSync(path.join(r, "logs", day, "audit.jsonl"), "utf8");
    const ev = log.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === "x_verify_mind_clone");
    expect(ev).toMatchObject({ slug: "jane-doe", verdict: "ADMITTED", exit_code: 0 });
  }, spawnBudgetMs(2));
});
