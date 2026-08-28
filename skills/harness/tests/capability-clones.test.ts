/**
 * The gate that asks whether the router can tell two providers apart.
 *
 * A capability id may have many providers — nine squads can each define a
 * design language, and the router is supposed to pick the one whose angle fits.
 * It picks by BM25 over each provider's description, keywords and
 * example_briefs. When two providers carry identical text there is nothing to
 * pick with: both score the same and a confident HIGH is a coin toss.
 *
 * Two bulk injections shipped exactly that. `media.video.compose` went into ten
 * squads with the text copied verbatim and, in nine of them, with no keywords
 * and no example_briefs at all — the fields weighted ×3 and ×2. Three
 * `frontend.*` capabilities went into seven to nine squads the same way.
 *
 * The distinction this pins: sharing an id is the design, sharing the words is
 * the defect. A gate that flagged the shared id would fire on 22 legitimate
 * capabilities and be switched off the same week.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const GATE = join(REPO, "scripts", "check-capability-clones.ts");
const tmp = mkdtempSync(join(tmpdir(), "clones-"));

type Cap = { squad: string; description: string; keywords?: string[]; example_briefs?: string[] };

function run(caps: Record<string, Cap[]>, args: string[] = []) {
  const f = join(tmp, `r${Object.keys(caps).join("_").replace(/\W/g, "")}.json`);
  writeFileSync(f, JSON.stringify(caps), "utf8");
  const r = spawnSync(process.execPath, [GATE, "--registry", f, ...args], { cwd: REPO, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const cap = (squad: string, description = "does the thing", keywords = ["a", "b"]): Cap =>
  ({ squad, description, keywords, example_briefs: ["some brief"] });

describe("what counts as a clone", () => {
  test("identical text across two providers is a clone", () => {
    const r = run({ "x.y.z": [cap("alpha"), cap("beta")] }, ["--strict"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("alpha, beta");
  }, spawnBudgetMs(2));

  test("different keywords make them distinguishable", () => {
    // The actual fix applied to the library: same work, each squad's own words.
    const r = run({
      "x.y.z": [cap("alpha", "does the thing", ["dashboard", "echarts"]), cap("beta", "does the thing", ["landing page", "shadcn"])],
    }, ["--strict"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("describes itself differently");
  }, spawnBudgetMs(2));

  test("different example_briefs alone are enough", () => {
    const a = { ...cap("alpha"), example_briefs: ["build me a dashboard"] };
    const b = { ...cap("beta"), example_briefs: ["build me a landing page"] };
    expect(run({ "x.y.z": [a, b] }, ["--strict"]).code).toBe(0);
  });

  test("a capability with a single provider is never a clone", () => {
    expect(run({ "x.y.z": [cap("alpha")], "p.q.r": [cap("beta")] }, ["--strict"]).code).toBe(0);
  });

  test("sharing an id is not itself the finding", () => {
    // 22 capability ids in the library legitimately have several providers. A
    // gate that flagged those would be noise, and noise gets switched off.
    const r = run({
      "x.y.z": [cap("alpha", "d", ["one"]), cap("beta", "d", ["two"]), cap("gamma", "d", ["three"])],
    });
    expect(r.out).toContain("1 capability ids have more than one provider (3 instances)");
    expect(r.out).toContain("describes itself differently");
  }, spawnBudgetMs(2));
});

describe("partial cloning is reported precisely", () => {
  test("it separates the identical camp from the distinct providers", () => {
    // The real shape of the defect: eight copies identical, one already curated.
    const r = run({
      "frontend.design_language.define": [
        cap("alpha"), cap("beta"), cap("gamma"),
        cap("delta", "a genuinely different description", ["own", "words"]),
      ],
    });
    expect(r.out).toContain("alpha, beta, gamma");
    expect(r.out).toContain("delta");
    expect(r.out).toMatch(/3 of 4 providers/);
  }, spawnBudgetMs(2));
});

describe("the gate is usable from a build step", () => {
  test("--json carries the camps", () => {
    const d = JSON.parse(run({ "x.y.z": [cap("alpha"), cap("beta")] }, ["--json"]).out);
    expect(d.shared_ids).toBe(1);
    expect(d.provider_instances).toBe(2);
    expect(d.cloned_instances).toBe(2);
    expect(d.affected[0].camps[0]).toEqual(["alpha", "beta"]);
  }, spawnBudgetMs(2));

  test("without --strict it reports rather than fails", () => {
    expect(run({ "x.y.z": [cap("alpha"), cap("beta")] }).code).toBe(0);
  });

  test("a single capability id can be inspected", () => {
    const r = run({ "x.y.z": [cap("alpha"), cap("beta")], "p.q.r": [cap("c"), cap("d")] }, ["x.y.z"]);
    expect(r.out).toContain("alpha, beta");
    expect(r.out).not.toContain("p.q.r");
  }, spawnBudgetMs(2));
});

process.on("exit", () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });
