/**
 * verify-business.test.ts — the business catalog of `nrv validate`.
 *
 * One fixture per criterion. The builder in `helpers/verify-fixture.ts` writes
 * a business that is ADMITTED with zero warnings under `--strict`; every test
 * below breaks exactly one thing and asserts that exactly that id fires. A
 * catalog whose criteria are only checked in aggregate is a catalog where a
 * criterion can silently stop firing, which is the failure mode this cut exists
 * to remove.
 *
 * Everything runs under mkdtemp with the CLI env redirected there; the
 * installed library at ~/businesses is never read and never written.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { businessFixture, INTAKE_SEAT, rmrf, runCli, squadFixture, tempRoot, writeSurfaceFor, type BusinessOpts } from "./helpers/verify-fixture.ts";
import { businessModule, criteria as businessCriteria } from "../lib/verify/kinds/business.ts";
import { verifyEntity } from "../lib/verify/index.ts";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) rmrf(r); });
function root(): string { const r = tempRoot(); ROOTS.push(r); return r; }

/** The gate's findings for one fixture, by id. */
function findings(r: string, slug: string, extra: string[] = []): Array<{ id: string; severity: string; where?: string; fixer?: string; message: string }> {
  const out = runCli(r, ["business", slug, "--no-retrieval", "--json", ...extra]);
  expect(out.json).not.toBeNull();
  return out.json.findings;
}
const idsOf = (f: Array<{ id: string }>) => f.map((x) => x.id);

/** Builds one business and returns what the gate says about it. */
function check(slug: string, o: BusinessOpts = {}, extra: string[] = []) {
  const r = root();
  businessFixture(r, slug, o);
  return { root: r, findings: findings(r, slug, extra) };
}

const SEAT = (name: string, extra: string[] = [], body = "\n## Method\n\n- One decision line that is long enough to count as method for the seat.\n") =>
  ["---", `name: ${name}`, `role: ${name} of the fixture business`,
    `description: The ${name} seat exists so the gate has a second employee to reason about.`,
    ...extra, "---", "", `# ${name}`, body].join("\n");

describe("catalog integrity", () => {
  test("ids are unique, every fixer exists and is in fixOrder, protocol rises last", () => {
    const ids = businessCriteria.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const fixers = new Set(Object.keys(businessModule.fixers));
    for (const c of businessCriteria) if (c.fixer) expect(fixers.has(c.fixer)).toBe(true);
    for (const f of fixers) expect(businessModule.fixOrder).toContain(f);
    // §18.4: the version is an assertion about everything else, so it rises
    // after every other handler had its turn.
    expect(businessModule.fixOrder[businessModule.fixOrder.length - 1]).toBe("protocol_bump_2");
    expect(businessModule.fixOrder).toContain("surface_regen");
  }, spawnBudgetMs(2));

  test("only seat_thin and self_retrieval_miss are baselineable, and no error is", () => {
    expect(businessCriteria.filter((c) => c.baselineable).map((c) => c.id).sort()).toEqual(["seat_thin", "self_retrieval_miss"]);
    for (const c of businessCriteria) if (c.severity === "error") expect(c.baselineable).toBe(false);
  }, spawnBudgetMs(2));

  test("every criterion declares error or warning — §16.2 has no third severity", () => {
    for (const c of businessCriteria) expect(["error", "warning"]).toContain(c.severity);
  }, spawnBudgetMs(2));
});

describe("a complete business is admitted", () => {
  test("the fixture passes every criterion, warnings included", () => {
    const r = root();
    businessFixture(r, "whole-biz");
    const out = runCli(r, ["business", "whole-biz", "--strict", "--no-retrieval", "--json"]);
    expect(out.json.findings).toEqual([]);
    expect(out.json.summary).toMatchObject({ errors: 0, warnings: 0, debt: 0, passed: businessCriteria.length });
    expect(out.code).toBe(0);
  }, spawnBudgetMs(2));

  test("a warning rejects only under --strict", () => {
    const r = root();
    businessFixture(r, "v1-biz", { protocol: "1.0" });
    expect(runCli(r, ["business", "v1-biz", "--no-retrieval"]).code).toBe(0);
    expect(runCli(r, ["business", "v1-biz", "--no-retrieval", "--strict"]).code).toBe(2);
  }, spawnBudgetMs(2));
});

// ── errors ──────────────────────────────────────────────────────────────────

describe("errors", () => {
  test("manifest_parse: business.yaml is not YAML", () => {
    expect(idsOf(check("bad-yaml", { manifest: "name: [unclosed\n" }).findings)).toContain("manifest_parse");
  }, spawnBudgetMs(2));

  test("manifest_schema: a required key the schema names is absent", () => {
    const f = check("no-domains", { manifest: 'name: no-domains\nversion: 1.0.0\nprotocol: "2.0"\ndescription: A manifest that declares no domains at all, which the schema requires it to.\n' }).findings;
    expect(idsOf(f)).toContain("manifest_schema");
    expect(f.find((x) => x.id === "manifest_schema")!.severity).toBe("error");
  }, spawnBudgetMs(2));

  test("protocol_unsupported: a version this engine does not load", () => {
    expect(idsOf(check("v3-biz", { protocol: "3.0" }).findings)).toContain("protocol_unsupported");
  }, spawnBudgetMs(2));

  test("employees_present: employees/ is empty", () => {
    expect(idsOf(check("no-seats", { employees: {}, orgChart: "chart: []\n" }).findings)).toContain("employees_present");
  }, spawnBudgetMs(2));

  test("employee_frontmatter_invalid: no frontmatter at all, and the fixer is the skeleton", () => {
    const f = check("no-fm", { employees: { "ceo.md": INTAKE_SEAT, "ghost.md": "# ghost\n\nNo frontmatter here.\n" } }).findings;
    const hit = f.find((x) => x.id === "employee_frontmatter_invalid");
    expect(hit).toBeDefined();
    expect(hit!.where).toBe("ghost");
    expect(hit!.fixer).toBe("employee_frontmatter_repair");
  }, spawnBudgetMs(2));

  test("employee_frontmatter_invalid: a header that fails the schema carries no fixer", () => {
    const f = check("bad-fm", { employees: { "ceo.md": INTAKE_SEAT.replace("role: Chief executive of the fixture business", "role: X") } }).findings;
    const hit = f.find((x) => x.id === "employee_frontmatter_invalid");
    expect(hit).toBeDefined();
    expect(hit!.fixer).toBeUndefined();
  }, spawnBudgetMs(2));

  test("intake_exactly_one: zero intakes get the chart-root fixer, two get none", () => {
    const none = check("no-intake", { employees: { "ceo.md": INTAKE_SEAT.replace("is_brief_intake: true", "is_brief_intake: false") } }).findings;
    expect(none.find((x) => x.id === "intake_exactly_one")!.fixer).toBe("intake_from_chart_root");
    const two = check("two-intakes", { employees: { "ceo.md": INTAKE_SEAT, "second.md": SEAT("second", ["is_brief_intake: true"]) } }).findings;
    expect(two.find((x) => x.id === "intake_exactly_one")!.fixer).toBeUndefined();
  }, spawnBudgetMs(2));

  test("org_chart_missing / org_chart_inconsistent", () => {
    expect(idsOf(check("no-chart", { orgChart: null }).findings)).toContain("org_chart_missing");
    const f = check("ghost-chart", { orgChart: "chart:\n  - employee: ghost\n    reports: []\n    direct_reports: []\n" }).findings;
    expect(idsOf(f)).toContain("org_chart_inconsistent");
    expect(f.find((x) => x.id === "org_chart_inconsistent")!.message).toMatch(/inconsistenc/);
  }, spawnBudgetMs(2));

  test("org_chart_inconsistent: reporting that is not bidirectional", () => {
    const employees = { "ceo.md": INTAKE_SEAT, "second.md": SEAT("second") };
    const chart = "chart:\n  - employee: ceo\n    reports: []\n    direct_reports: [second]\n  - employee: second\n    reports: []\n    direct_reports: []\n";
    expect(idsOf(check("one-way", { employees, orgChart: chart }).findings)).toContain("org_chart_inconsistent");
  }, spawnBudgetMs(2));

  test("antagonist_bp7: six seats and no adversarial review", () => {
    const employees: Record<string, string> = { "ceo.md": INTAKE_SEAT };
    for (let i = 1; i <= 5; i++) employees[`seat${i}.md`] = SEAT(`seat${i}`, ["reports_to: ceo"]);
    const chart = ["chart:", "  - employee: ceo", "    reports: []", `    direct_reports: [${[1, 2, 3, 4, 5].map((i) => `seat${i}`).join(", ")}]`,
      ...[1, 2, 3, 4, 5].flatMap((i) => [`  - employee: seat${i}`, "    reports: [ceo]", "    direct_reports: []"]), ""].join("\n");
    expect(idsOf(check("bp7-biz", { employees, orgChart: chart }).findings)).toContain("antagonist_bp7");
  }, spawnBudgetMs(2));

  test("auto_route_unknown_employee: route_to names nobody", () => {
    const f = check("ghost-route", { routing: 'auto_routes:\n  - pattern: "(?i)fixture report"\n    route_to: ghost\n' }).findings;
    expect(idsOf(f)).toContain("auto_route_unknown_employee");
    expect(f.find((x) => x.id === "auto_route_unknown_employee")!.where).toBe("ghost");
  }, spawnBudgetMs(2));

  // The `investigation-bureau` shape (28/08/2026): nine routes named a real
  // seat under the key `employee:`, and the gate answered `route_to (empty)
  // names no seat` — blaming a seat name nobody had written. There is no alias
  // normalizer: the gate reads `r.route_to` and `router.js` skips any entry
  // whose `route_to` is not a string, so the route is dead on both sides. The
  // finding has to say that, because a message that hides it costs the reader
  // the whole search.
  test("auto_route_unknown_employee: the seat sits under another key", () => {
    const f = check("misplaced-key", { routing: 'auto_routes:\n  - pattern: "(?i)fixture report"\n    employee: ceo\n' }).findings;
    const hit = f.find((x) => x.id === "auto_route_unknown_employee");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("employee");
    expect(hit!.message).toContain("ceo");
    expect(hit!.message).toMatch(/route_to is absent/);
    expect(hit!.message).toMatch(/router/);
    expect(hit!.message).not.toContain("(empty)");
  }, spawnBudgetMs(2));

  test("auto_route_unknown_employee: two keys hold a seat, and the gate picks neither", () => {
    const employees = { "ceo.md": INTAKE_SEAT, "second.md": SEAT("second") };
    const routing = 'auto_routes:\n  - pattern: "(?i)fixture report"\n    employee: ceo\n    owner: second\n';
    const hit = check("two-keys", { employees, routing }).findings.find((x) => x.id === "auto_route_unknown_employee");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("employee: ceo");
    expect(hit!.message).toContain("owner: second");
    expect(hit!.message).not.toContain("(empty)");
  }, spawnBudgetMs(2));

  // §13.2 defines `requires_escalation_to`, and it is not a routing target.
  // A seat name under it is a fact, never a rename candidate.
  test("auto_route_unknown_employee: a retired route field is never read as a misspelled route_to", () => {
    const routing = 'auto_routes:\n  - pattern: "(?i)fixture report"\n    requires_escalation_to: ceo\n';
    const hit = check("retired-key", { routing }).findings.find((x) => x.id === "auto_route_unknown_employee");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/route_to is absent/);
    expect(hit!.message).not.toMatch(/requires_escalation_to/);
    expect(hit!.message).not.toContain("(empty)");
  }, spawnBudgetMs(2));

  // `router.js` skips any entry whose route_to is not a string, so a YAML scalar
  // that parses as a number is dropped there while `String()` hid it here.
  test("auto_route_unknown_employee: route_to that is not a string says which type it is", () => {
    const f = check("typed-route", { routing: 'auto_routes:\n  - pattern: "(?i)fixture report"\n    route_to: 42\n' }).findings;
    const hit = f.find((x) => x.id === "auto_route_unknown_employee");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/route_to is a number, not a string/);
    expect(hit!.message).not.toContain("(empty)");
  }, spawnBudgetMs(2));

  test("auto_route_unknown_employee: route_to genuinely empty is not a seat named (empty)", () => {
    const f = check("empty-route", { routing: 'auto_routes:\n  - pattern: "(?i)fixture report"\n    route_to: ""\n' }).findings;
    const hit = f.find((x) => x.id === "auto_route_unknown_employee");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/route_to is empty/);
    expect(hit!.message).not.toContain("(empty)");
  }, spawnBudgetMs(2));

  test("auto_route_in_manifest: the routes are in the wrong file", () => {
    const f = check("manifest-routes", { manifestExtra: 'auto_routes:\n  - pattern: "(?i)fixture report"\n    route_to: ceo\n' }).findings;
    expect(idsOf(f)).toContain("auto_route_in_manifest");
    expect(f.find((x) => x.id === "auto_route_in_manifest")!.fixer).toBe("auto_routes_relocate");
  }, spawnBudgetMs(2));

  test("pinned_clone_unresolved: a seat promises a voice the library does not have", () => {
    const f = check("ghost-pin", { employees: { "ceo.md": INTAKE_SEAT.replace("type: orchestrator", "type: orchestrator\npinned_mind_clones: [nobody-at-all]") } }).findings;
    expect(idsOf(f)).toContain("pinned_clone_unresolved");
    expect(f.find((x) => x.id === "pinned_clone_unresolved")!.where).toBe("nobody-at-all");
  }, spawnBudgetMs(2));

  test("acceptance_invalid: a malformed id, a duplicate id and a score outside 0..1", () => {
    const bad = INTAKE_SEAT.replace("  - id: brief_understood", "  - id: Brief Understood");
    expect(idsOf(check("bad-acc-id", { employees: { "ceo.md": bad } }).findings)).toContain("acceptance_invalid");

    const dup = SEAT("second", ["acceptance:", "  - id: brief_understood", "    description: the same id as the intake seat"]);
    const f = check("dup-acc", { employees: { "ceo.md": INTAKE_SEAT, "second.md": dup } }).findings;
    expect(f.filter((x) => x.id === "acceptance_invalid").some((x) => /already declared/.test(x.message))).toBe(true);

    const score = INTAKE_SEAT.replace("minimum_score: 0.8", "minimum_score: 80");
    expect(check("bad-score", { employees: { "ceo.md": score } }).findings.filter((x) => x.id === "acceptance_invalid").some((x) => /0\.\.1/.test(x.message))).toBe(true);
  }, spawnBudgetMs(2));

  test("surface_missing", () => {
    expect(idsOf(check("no-surface", { surface: false }).findings)).toContain("surface_missing");
  }, spawnBudgetMs(2));

  test("dna_symlink_dangling: the binding already broke", () => {
    const r = root();
    const dir = businessFixture(r, "dangling-biz");
    fs.mkdirSync(path.join(dir, "dna"));
    fs.symlinkSync(path.join(r, "dna", "gone-clone"), path.join(dir, "dna", "gone-clone"));
    writeSurfaceFor(dir, "business");
    const f = findings(r, "dangling-biz");
    expect(idsOf(f)).toContain("dna_symlink_dangling");
    expect(idsOf(f)).toContain("dna_dir_present");
  }, spawnBudgetMs(2));

  test("outputs_pollution: a run-output dir inside the business", () => {
    const r = root();
    const dir = businessFixture(r, "polluted-biz");
    fs.mkdirSync(path.join(dir, "outputs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "outputs", "report.md"), "# run output\n", "utf8");
    expect(idsOf(findings(r, "polluted-biz"))).toContain("outputs_pollution");
  }, spawnBudgetMs(2));
});

// ── warnings ────────────────────────────────────────────────────────────────

describe("warnings", () => {
  test("protocol_v1 carries the bump fixer", () => {
    const f = check("still-v1", { protocol: "1.0" }).findings;
    expect(f.find((x) => x.id === "protocol_v1")!.fixer).toBe("protocol_bump_2");
  }, spawnBudgetMs(2));

  test("employee_count_authored", () => {
    expect(idsOf(check("counted", { manifestExtra: "employee_count: 1" }).findings)).toContain("employee_count_authored");
  }, spawnBudgetMs(2));

  test("deprecated_field: the conversions and the removals reach different fixers", () => {
    const seat = INTAKE_SEAT.replace("type: orchestrator", [
      "type: orchestrator",
      "budget_monthly_usd: 10",
      "heartbeat:",
      "  cadence: daily",
      "  enabled: true",
      "self_score_contract:",
      "  required_before_handoff: true",
      "  criteria:",
      "    - id: quality",
      "      description: the deliverable is worth handing over",
      "      threshold: 0.8",
    ].join("\n"));
    const f = check("deprecated-biz", { employees: { "ceo.md": seat } }).findings.filter((x) => x.id === "deprecated_field");
    const byField = Object.fromEntries(f.map((x) => [x.where, x.fixer]));
    expect(byField.heartbeat).toBe("heartbeat_strip");
    expect(byField.self_score_contract).toBe("acceptance_from_self_score");
    expect(byField.budget_monthly_usd).toBe("deprecated_field_strip");
  }, spawnBudgetMs(2));

  test("deprecated_file: reported, never deleted", () => {
    const r = root();
    const dir = businessFixture(r, "culture-biz");
    fs.writeFileSync(path.join(dir, "culture.md"), "# Culture\n\nWe ship.\n", "utf8");
    const f = findings(r, "culture-biz");
    expect(f.find((x) => x.id === "deprecated_file")!.where).toBe("culture.md");
    expect(runCli(r, ["business", "culture-biz", "--no-retrieval", "--fix"]).code).toBe(0);
    expect(fs.existsSync(path.join(dir, "culture.md"))).toBe(true);
  }, spawnBudgetMs(2));

  test("squads_authorized_empty: the manifest and the seat both count", () => {
    const f = check("empty-authorized", {
      manifestExtra: "squads_authorized: []",
      employees: { "ceo.md": INTAKE_SEAT.replace("type: orchestrator", "type: orchestrator\nsquads_authorized: []") },
    }).findings;
    const hit = f.find((x) => x.id === "squads_authorized_empty")!;
    expect(hit.message).toMatch(/2 declaration/);
    expect(hit.fixer).toBe("squads_authorized_empty_strip");
  }, spawnBudgetMs(2));

  test("squads_ref_unknown: a fence naming a squad that is not installed", () => {
    const r = root();
    squadFixture(r, "real-squad");
    businessFixture(r, "fenced-biz", { manifestExtra: "squads_authorized: [real-squad, ghost-squad]" });
    const f = findings(r, "fenced-biz");
    const hits = f.filter((x) => x.id === "squads_ref_unknown");
    expect(hits.map((x) => x.where)).toEqual(["ghost-squad"]);
  }, spawnBudgetMs(2));

  test("acceptance_missing: the intake seat declares nothing for the judge", () => {
    const seat = INTAKE_SEAT.split("acceptance:")[0] + "---\n\n# CEO\n\n## Method\n\n- A decision line long enough to keep this seat out of seat_thin.\n- A second decision line so the seat has method of its own.\n";
    expect(idsOf(check("no-acceptance", { employees: { "ceo.md": seat } }).findings)).toContain("acceptance_missing");
  }, spawnBudgetMs(2));

  test("routing_metadata_incomplete names the field that is missing", () => {
    const r = root();
    const dir = businessFixture(r, "no-fence");
    const manifest = fs.readFileSync(path.join(dir, "business.yaml"), "utf8").replace(/^not_for:.*$/m, "");
    fs.writeFileSync(path.join(dir, "business.yaml"), manifest, "utf8");
    writeSurfaceFor(dir, "business");
    const hit = findings(r, "no-fence").find((x) => x.id === "routing_metadata_incomplete")!;
    expect(hit.message).toMatch(/§6\.9/);
  }, spawnBudgetMs(2));

  test("routing_metadata_incomplete: three briefs in one language only", () => {
    const r = root();
    const dir = businessFixture(r, "one-language");
    const manifest = fs.readFileSync(path.join(dir, "business.yaml"), "utf8")
      .replace('  - "preciso do relatório de fixture a partir deste brief"', '  - "produce the fixture report for the team that asked"');
    fs.writeFileSync(path.join(dir, "business.yaml"), manifest, "utf8");
    writeSurfaceFor(dir, "business");
    expect(idsOf(findings(r, "one-language"))).toContain("routing_metadata_incomplete");
  }, spawnBudgetMs(2));

  test("description_short", () => {
    const manifest = [
      "name: terse-biz", "version: 1.0.0", 'protocol: "2.0"',
      "description: Does things for people sometimes.",
      "domains: [fixture_domain]", "produces: [fixture-report]", "keywords: [fixture, relatorio]",
      "example_briefs:", '  - "turn this brief into the fixture report our team can read"',
      '  - "preciso do relatório de fixture a partir deste brief"', '  - "write the fixture report and review it"',
      'not_for: ["logo design"]', "runtime_requirements:", "  policy: active", "",
    ].join("\n");
    expect(idsOf(check("terse-biz", { manifest }).findings)).toContain("description_short");
  }, spawnBudgetMs(2));

  test("auto_route_never_fires and auto_route_catch_all", () => {
    const never = check("dead-route", { routing: 'auto_routes:\n  - pattern: "(?i)\\\\bcryogenics\\\\b"\n    route_to: ceo\n' }).findings;
    expect(idsOf(never)).toContain("auto_route_never_fires");
    const all = check("catch-all", { routing: 'auto_routes:\n  - pattern: ".*"\n    route_to: ceo\n' }).findings;
    const hit = all.find((x) => x.id === "auto_route_catch_all")!;
    expect(hit.fixer).toBe("catch_all_to_default_employee");
    // A catch-all is judged before "does it fire": it fires against everything.
    expect(idsOf(all)).not.toContain("auto_route_never_fires");
  }, spawnBudgetMs(2));

  test("seat_thin is baselineable debt, not a verdict", () => {
    const thin = ["---", "name: second", "role: Second seat", "description: A seat whose body says nothing about how it works at all.", "---", "", "# second", ""].join("\n");
    const r = root();
    businessFixture(r, "thin-biz", { employees: { "ceo.md": INTAKE_SEAT, "second.md": thin } });
    const f = findings(r, "thin-biz");
    // The key the legacy seat-sufficiency baseline imports as.
    expect(f.find((x) => x.id === "seat_thin")!.where).toBe("employees/second.md");
    // Recorded once, it stops counting as a warning.
    expect(runCli(r, ["business", "--all", "--no-retrieval", "--record", "--json"]).json.baseline.recorded).toBe(true);
    const after = runCli(r, ["business", "thin-biz", "--no-retrieval", "--strict", "--json"]);
    expect(after.json.findings.find((x: any) => x.id === "seat_thin").baselined).toBe(true);
    expect(after.code).toBe(0);
  }, spawnBudgetMs(2));

  test("readme_missing / readme_thin / memory_missing", () => {
    expect(idsOf(check("no-readme", { readme: null }).findings)).toContain("readme_missing");
    expect(idsOf(check("thin-readme", { readme: "# thin\n\nNothing here.\n" }).findings)).toContain("readme_thin");
    expect(idsOf(check("no-memory", { memory: false }).findings)).toContain("memory_missing");
  }, spawnBudgetMs(2));

  test("runtime_requirements_default: the template skeleton never got a floor", () => {
    const manifest = [
      "name: skeleton-biz", "version: 1.0.0", 'protocol: "2.0"',
      "description: Fixture business that turns a written brief into one artifact and hands it back reviewed, twice over.",
      "domains: [fixture_domain]", "produces: [fixture-report]", "keywords: [fixture, relatorio]",
      "example_briefs:", '  - "turn this brief into the fixture report our team can read"',
      '  - "preciso do relatório de fixture a partir deste brief"', '  - "write the fixture report and review it"',
      'not_for: ["logo design"]', "runtime_requirements:", "  policy: declared", "",
    ].join("\n");
    expect(idsOf(check("skeleton-biz", { manifest }).findings)).toContain("runtime_requirements_default");
  }, spawnBudgetMs(2));

  test("type_mind_clone_without_pin and type_flag_mismatch", () => {
    const clone = SEAT("second", ["type: mind_clone", "disclosure_required: true"]);
    expect(idsOf(check("unpinned", { employees: { "ceo.md": INTAKE_SEAT, "second.md": clone } }).findings)).toContain("type_mind_clone_without_pin");
    const gate = SEAT("second", ["type: antagonist_gate"]);
    const f = check("flagless", { employees: { "ceo.md": INTAKE_SEAT, "second.md": gate } }).findings;
    expect(f.find((x) => x.id === "type_flag_mismatch")!.fixer).toBe("type_flag_sync");
  }, spawnBudgetMs(2));

  test("surface_stale: a file changed after the surface was written", () => {
    const r = root();
    const dir = businessFixture(r, "stale-biz");
    fs.appendFileSync(path.join(dir, "employees", "ceo.md"), "\n- One more decision line, written after the surface was frozen.\n");
    expect(idsOf(findings(r, "stale-biz"))).toContain("surface_stale");
  }, spawnBudgetMs(2));

  test("operation_mode_unsupported and legacy_partial", () => {
    expect(idsOf(check("hybrid-biz", { manifestExtra: "operation_mode: hybrid" }).findings)).toContain("operation_mode_unsupported");
    expect(idsOf(check("half-legacy", { manifestExtra: "legacy:\n  paperclip_instance: prod" }).findings)).toContain("legacy_partial");
  }, spawnBudgetMs(2));

  test("dna_dir_present carries the bindings fixer", () => {
    const r = root();
    const dir = businessFixture(r, "dna-biz");
    fs.mkdirSync(path.join(dir, "dna", "some-clone"), { recursive: true });
    writeSurfaceFor(dir, "business");
    expect(findings(r, "dna-biz").find((x) => x.id === "dna_dir_present")!.fixer).toBe("dna_dir_to_bindings");
  }, spawnBudgetMs(2));
});

// ── self-retrieval ──────────────────────────────────────────────────────────

describe("the self-retrieval axis", () => {
  const registryEntry = (o: Record<string, unknown>) => ({
    description: "", domains: [], capabilities: [], produces: [], keywords: [], example_briefs: [], not_for: [], ...o,
  });

  test("no registry means no finding — the axis is skipped, never guessed", async () => {
    const r = root();
    const dir = businessFixture(r, "unindexed-biz");
    const report = await verifyEntity("business", dir, { stateDir: null, emit: null, baselinePath: null });
    expect(report.findings.map((f) => f.id)).not.toContain("self_retrieval_miss");
    expect(report.verdict).toBe("ADMITTED");
  }, spawnBudgetMs(2));

  test("an example_brief that returns another business first is a miss", async () => {
    const r = root();
    const dir = businessFixture(r, "misdeclared-biz", {
      manifestExtra: undefined,
      manifest: [
        "name: misdeclared-biz", "version: 1.0.0", 'protocol: "2.0"',
        "description: Bookkeeping, tax filing and payroll reconciliation for small companies, month after month.",
        "domains: [accounting]", "produces: [tax-return]", "keywords: [bookkeeping, tax, payroll, contabilidade]",
        "example_briefs:",
        '  - "design a new logo and a full brand book for our company"',
        '  - "preciso de um logotipo novo e de um manual de marca completo"',
        '  - "create the brand identity, logo and visual system"',
        'not_for: ["logo design"]', "runtime_requirements:", "  policy: active", "",
      ].join("\n"),
    });
    const registries = {
      squads: { squads: {}, domains: {}, _v4_inferred_capabilities: {}, capabilities: {} },
      businesses: {
        businesses: {
          "misdeclared-biz": registryEntry({ description: "Bookkeeping, tax filing and payroll reconciliation for small companies.", domains: ["accounting"], keywords: ["bookkeeping", "tax", "payroll"] }),
          "brand-studio": registryEntry({ description: "Logo design, brand book and the whole visual identity system.", domains: ["branding"], keywords: ["logo", "brand", "identity", "logotipo", "marca"] }),
        },
        _business_routing: {},
      },
      warnings: [],
    };
    const report = await verifyEntity("business", dir, { stateDir: null, emit: null, baselinePath: null, registries });
    const hit = report.findings.find((f) => f.id === "self_retrieval_miss");
    expect(hit).toBeDefined();
    expect(hit!.baselined).toBe(false);
    expect(report.summary.warnings).toBeGreaterThan(0);
    expect(report.verdict).toBe("ADMITTED");            // a warning never rejects on its own
  });
});
