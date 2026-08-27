/**
 * business-audit-criteria.test.ts — the scorer's scale and its suggestions.
 *
 * Two things drift silently and cost a release each time they do: the rubric's
 * maximum (it read "100 points" in the header while summing 104 for as long as
 * `seat_sufficiency` had been bolted on) and the `fixable_diff` kinds (they
 * named repairs no applier implemented, so "fixable" meant nothing). Both are
 * asserted here against the fixer table itself.
 *
 * Runs with: bun test skills/businesses/tests
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { businessFixture, INTAKE_SEAT, rmrf, tempRoot } from "../../_shared/tests/helpers/verify-fixture.ts";

const require_ = createRequire(import.meta.url);
const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const { scoreBusiness } = require_(path.join(REPO, "skills", "businesses", "lib", "business-audit-criteria.js"));
const { HANDLERS } = require_(path.join(REPO, "skills", "businesses", "lib", "business-fixers.js"));

const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) rmrf(r); });
function root(): string { const r = tempRoot(); ROOTS.push(r); return r; }

/** Every fixable_diff a corpus of businesses produces, dedup by kind. */
function suggestions(dirs: string[]): Map<string, { kind: string; class?: string }> {
  const out = new Map<string, { kind: string; class?: string }>();
  for (const dir of dirs) for (const b of scoreBusiness(dir).breakdown) if (b.fixable_diff) out.set(b.fixable_diff.kind, b.fixable_diff);
  return out;
}

describe("the rubric", () => {
  test("eleven dimensions summing to exactly 100", () => {
    const r = scoreBusiness(businessFixture(root(), "scored-biz"));
    expect(r.breakdown).toHaveLength(11);
    expect(r.breakdown.reduce((a: number, b: any) => a + b.max, 0)).toBe(100);
    expect(r.max).toBe(100);
    expect(r.breakdown.map((b: any) => b.name)).toContain("employees_present");
    expect(r.breakdown.map((b: any) => b.name)).toContain("employees_contract");
  });

  test("a complete business scores green and suggests nothing mechanical", () => {
    const r = scoreBusiness(businessFixture(root(), "green-biz", { routing: 'brief_intake:\n  default_employee: ceo\n' }));
    expect(r.tier).toBe("green");
    expect(r.breakdown.filter((b: any) => b.fixable_diff?.class === "mechanical")).toEqual([]);
  });

  test("employee_count no longer costs points, and is suggested for removal", () => {
    const withCount = scoreBusiness(businessFixture(root(), "counted-biz", { manifestExtra: "employee_count: 1" }));
    const without = scoreBusiness(businessFixture(root(), "uncounted-biz"));
    const c2 = (r: any) => r.breakdown.find((b: any) => b.name === "employees_present");
    expect(c2(withCount).score).toBe(c2(without).score);
    expect(c2(withCount).fixable_diff).toMatchObject({ kind: "employee_count_strip", class: "mechanical" });
  });

  test("declaring a heartbeat earns nothing; declaring acceptance earns the six points", () => {
    const noAcceptance = INTAKE_SEAT.split("acceptance:")[0] + "heartbeat:\n  cadence: daily\n  enabled: true\n---\n\n# CEO\n\n## Method\n\n- One decision line.\n";
    const bare = scoreBusiness(businessFixture(root(), "hb-biz", { employees: { "ceo.md": noAcceptance } }));
    const full = scoreBusiness(businessFixture(root(), "acc-biz"));
    const c3 = (r: any) => r.breakdown.find((b: any) => b.name === "employees_contract");
    expect(c3(bare).score).toBe(8);
    expect(c3(full).score).toBe(14);
    expect(c3(bare).evidence).toContain("0/1 intake seat(s) declare acceptance");
  });

  test("a self_score_contract is scored as convertible, an empty seat as authorship", () => {
    const contract = INTAKE_SEAT.split("acceptance:")[0] + "self_score_contract:\n  criteria:\n    - id: quality\n      description: worth handing over\n---\n\n# CEO\n\n## Method\n\n- One decision line.\n";
    const withContract = scoreBusiness(businessFixture(root(), "ssc-biz", { employees: { "ceo.md": contract } }));
    expect(withContract.breakdown.find((b: any) => b.name === "employees_contract").fixable_diff)
      .toMatchObject({ kind: "acceptance_from_self_score", class: "mechanical" });

    const empty = INTAKE_SEAT.split("acceptance:")[0] + "---\n\n# CEO\n\n## Method\n\n- One decision line.\n";
    const withoutContract = scoreBusiness(businessFixture(root(), "empty-acc", { employees: { "ceo.md": empty } }));
    expect(withoutContract.breakdown.find((b: any) => b.name === "employees_contract").fixable_diff)
      .toMatchObject({ kind: "acceptance_author", class: "agentic" });
  });

  test("routing scores the intake seat and the patterns that fire", () => {
    const c5 = (r: any) => r.breakdown.find((b: any) => b.name === "routing");
    const none = scoreBusiness(businessFixture(root(), "no-routing"));
    expect(c5(none)).toMatchObject({ score: 0, fixable_diff: { kind: "routing_scaffold", class: "mechanical" } });

    const intakeOnly = scoreBusiness(businessFixture(root(), "intake-only", { routing: "brief_intake:\n  default_employee: ceo\n" }));
    expect(c5(intakeOnly).score).toBe(5);

    const firing = scoreBusiness(businessFixture(root(), "firing", {
      routing: 'brief_intake:\n  default_employee: ceo\nauto_routes:\n  - pattern: "(?i)fixture report"\n    route_to: ceo\n',
    }));
    expect(c5(firing).score).toBe(10);

    const dead = scoreBusiness(businessFixture(root(), "dead-routes", {
      routing: 'brief_intake:\n  default_employee: ceo\nauto_routes:\n  - pattern: "(?i)\\\\bcryogenics\\\\b"\n    route_to: ceo\n',
    }));
    expect(c5(dead).score).toBe(5);
    expect(c5(dead).fixable_diff).toMatchObject({ kind: "routing_default_routes", class: "agentic" });
  });
});

describe("every suggestion names something that exists", () => {
  test("mechanical kinds are handlers of business-fixers.js; the others declare why not", () => {
    const r = root();
    const dirs = [
      businessFixture(r, "a-biz", { manifestExtra: "employee_count: 1", readme: null, memory: false }),
      businessFixture(r, "b-biz", { orgChart: null, employees: { "ceo.md": INTAKE_SEAT, "ghost.md": "# ghost\n" } }),
      businessFixture(r, "c-biz", { manifest: "name: c-biz\nversion: 1.0.0\n" }),
      businessFixture(r, "d-biz", { routing: 'brief_intake:\n  default_employee: ceo\nauto_routes:\n  - pattern: ".*"\n    route_to: ceo\n' }),
    ];
    // A thin seat and a short description, to reach the two agentic kinds.
    fs.writeFileSync(path.join(dirs[0], "employees", "thin.md"), "---\nname: thin\nrole: Thin seat\ndescription: A seat whose body carries no method of its own at all.\n---\n\n# thin\n", "utf8");

    const found = suggestions(dirs);
    expect(found.size).toBeGreaterThan(4);
    for (const [kind, diff] of found) {
      if (diff.class === "mechanical") expect(Object.keys(HANDLERS)).toContain(kind);
      else expect(["agentic", "none"]).toContain(diff.class);
    }
  });
});
