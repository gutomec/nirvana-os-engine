/**
 * business-fixers.test.ts — the mechanical fixers of Business Protocol 2.0,
 * and the frontmatter primitive they all write through.
 *
 * Two promises are tested here more than anything else, because breaking either
 * one damages 581 installed seats at once:
 *
 * 1. **The body is not touched.** `frontmatter-edit.ts` rewrites the `---`
 *    block and reassembles the file around the original body slice. Every test
 *    that edits a seat compares the body byte for byte afterwards.
 * 2. **The second run writes nothing.** A fixer that is not idempotent turns
 *    `--fix` into a source of diffs, and the gate's rollback logic assumes the
 *    opposite. Each fixer runs twice; the tree digest after run two equals the
 *    digest after run one.
 *
 * Everything is built under mkdtemp; ~/businesses is never read or written.
 *
 * Runs with: bun test skills/businesses/tests
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";
import {
  businessFixture, cliEnv, crlf, INTAKE_SEAT, rmrf, runCli, tempRoot, treeDigest, writeSurfaceFor,
} from "../../_shared/tests/helpers/verify-fixture.ts";
import {
  editFrontmatter, joinFrontmatter, prependFrontmatter, readFrontmatter, splitFrontmatter,
} from "../../_shared/lib/frontmatter-edit.ts";
import { businessModule, verifyEntity, type KindModule } from "../../_shared/lib/verify/index.ts";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

const require_ = createRequire(import.meta.url);
const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const { applyBusinessFixes, acceptanceId, cloneSlug, normalizeScore } = require_(path.join(REPO, "skills", "businesses", "lib", "business-fixers.js"));

const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) rmrf(r); });
function root(): string { const r = tempRoot(); ROOTS.push(r); return r; }

const apply = (dir: string, kind: string, patch: Record<string, unknown> = {}) =>
  applyBusinessFixes(dir, { patches: [{ kind, ...patch }] })[0].result;

const seatFile = (dir: string, name = "ceo") => path.join(dir, "employees", `${name}.md`);
const bodyOf = (file: string) => readFrontmatter(file)!.body;
const fmOf = (file: string) => readFrontmatter(file)!.data as Record<string, any>;
const manifestOf = (dir: string) => parseYaml(fs.readFileSync(path.join(dir, "business.yaml"), "utf8")) as Record<string, any>;
const routingOf = (dir: string) => parseYaml(fs.readFileSync(path.join(dir, "routing.yaml"), "utf8")) as Record<string, any>;

/** Runs a fixer twice and asserts the second run changes nothing on disk. */
function twice(dir: string, kind: string, patch: Record<string, unknown> = {}) {
  const first = apply(dir, kind, patch);
  const afterFirst = treeDigest(dir);
  const second = apply(dir, kind, patch);
  expect(treeDigest(dir)).toEqual(afterFirst);
  return { first, second };
}

// ── the frontmatter primitive ───────────────────────────────────────────────

describe("frontmatter-edit: the block changes, the body does not", () => {
  test("splitFrontmatter keeps the body as a slice, LF and CRLF alike", () => {
    const lfText = "---\nname: ceo\n---\n\n# CEO\n\nBody  with   spacing.\t\n";
    const s = splitFrontmatter(lfText)!;
    expect(s.block).toBe("name: ceo");
    expect(s.body).toBe("\n# CEO\n\nBody  with   spacing.\t\n");
    expect(s.eol).toBe("\n");
    expect(joinFrontmatter(s, s.block)).toBe(lfText);

    const c = splitFrontmatter(crlf(lfText))!;
    expect(c.eol).toBe("\r\n");
    expect(joinFrontmatter(c, c.block)).toBe(crlf(lfText));
  });

  test("an empty block, a BOM and a file that ends at the fence all round-trip", () => {
    for (const text of ["---\n---\n# body\n", "﻿---\nname: x\n---\nbody\n", "---\nname: x\n---"]) {
      const s = splitFrontmatter(text)!;
      expect(joinFrontmatter(s, s.block)).toBe(text);
    }
    expect(splitFrontmatter("# no frontmatter\n")).toBeNull();
  });

  test("editFrontmatter preserves comments, key order and every byte of the body", () => {
    const r = root();
    const file = path.join(r, "cwd", "seat.md");
    const body = "\n# CEO\n\n- One  line with  odd   spacing.\t\n\n\n## Trailing section\n";
    fs.writeFileSync(file, ["---", "# a comment the fixer must not eat", "name: ceo", "heartbeat:", "  enabled: true", "role: CEO", "---", body].join("\n"), "utf8");
    const before = bodyOf(file);
    expect(editFrontmatter(file, (doc) => { doc.delete("heartbeat"); return true; })).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("# a comment the fixer must not eat");
    expect(text).not.toContain("heartbeat");
    expect(bodyOf(file)).toBe(before);
    expect(Object.keys(fmOf(file))).toEqual(["name", "role"]);
    // The second edit finds nothing to do and writes nothing.
    expect(editFrontmatter(file, (doc) => { if (!doc.has("heartbeat")) return false; doc.delete("heartbeat"); return true; })).toBe(false);
  });

  test("a file with no block is left alone; prependFrontmatter writes one", () => {
    const r = root();
    const file = path.join(r, "cwd", "bare.md");
    fs.writeFileSync(file, "# bare\n\nBody.\n", "utf8");
    expect(editFrontmatter(file, () => true)).toBe(false);
    expect(prependFrontmatter(file, "name: bare\nrole: Bare seat")).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("---\nname: bare\nrole: Bare seat\n---\n# bare\n\nBody.\n");
    expect(prependFrontmatter(file, "name: other")).toBe(false);
  });
});

describe("helpers the conversions rely on", () => {
  test("acceptanceId, normalizeScore and cloneSlug", () => {
    expect(acceptanceId("Brief Understood")).toBe("brief_understood");
    expect(acceptanceId("9-lives")).toBe("c_9-lives");
    expect(normalizeScore(0.8)).toBe(0.8);
    expect(normalizeScore(80)).toBe(0.8);
    expect(normalizeScore("nope")).toBeNull();
    expect(cloneSlug("dna/april-dunford/agent/AGENT.md")).toBe("april-dunford");
    expect(cloneSlug("/Volumes/x/mindclones/26-research/philip-tetlock")).toBe("philip-tetlock");
    expect(cloneSlug("~/businesses/_library/dna/edward-tufte.md")).toBe("edward-tufte");
  });
});

// ── the seat fixers ─────────────────────────────────────────────────────────

describe("seat fixers", () => {
  test("heartbeat_strip removes the block and nothing else", () => {
    const r = root();
    const dir = businessFixture(r, "hb-biz", {
      employees: { "ceo.md": INTAKE_SEAT.replace("type: orchestrator", "type: orchestrator\nheartbeat:\n  cadence: daily\n  enabled: true") },
    });
    const body = bodyOf(seatFile(dir));
    const { first } = twice(dir, "heartbeat_strip");
    expect(first.ok).toBe(true);
    expect(fmOf(seatFile(dir)).heartbeat).toBeUndefined();
    expect(fmOf(seatFile(dir)).is_brief_intake).toBe(true);
    expect(bodyOf(seatFile(dir))).toBe(body);
  });

  test("acceptance_from_self_score converts the criteria and drops the contract", () => {
    const r = root();
    const seat = INTAKE_SEAT.split("acceptance:")[0] + [
      "self_score_contract:",
      "  required_before_handoff: true",
      "  max_revise_iterations: 3",
      "  criteria:",
      "    - id: brief_understood",
      "      description: the deliverable answers the brief that was written",
      "      threshold: 0.8",
      "      weight: 1.5",
      "    - id: sources_cited",
      "      description: every factual claim names a dated source",
      "      threshold: 90",
      "---", "", "# CEO", "", "## Method", "", "- A decision line long enough to keep the seat sufficient.", "",
    ].join("\n");
    const dir = businessFixture(r, "ssc-biz", { employees: { "ceo.md": seat } });
    const body = bodyOf(seatFile(dir));
    const { first } = twice(dir, "acceptance_from_self_score");
    expect(first.ok).toBe(true);
    const fm = fmOf(seatFile(dir));
    expect(fm.self_score_contract).toBeUndefined();
    expect(fm.acceptance).toEqual([
      { id: "brief_understood", description: "the deliverable answers the brief that was written", blocking: true, minimum_score: 0.8 },
      { id: "sources_cited", description: "every factual claim names a dated source", blocking: true, minimum_score: 0.9 },
    ]);
    expect(bodyOf(seatFile(dir))).toBe(body);
  });

  test("acceptance_from_self_score prefixes an id another seat already holds", () => {
    const r = root();
    const second = ["---", "name: second", "role: Second seat", "description: The second seat of the fixture business, with its own contract.",
      "reports_to: ceo", "self_score_contract:", "  criteria:", "    - id: brief_understood", "      description: the same id the intake seat declares",
      "---", "", "# second", ""].join("\n");
    const dir = businessFixture(r, "collide-biz", { employees: { "ceo.md": INTAKE_SEAT, "second.md": second } });
    apply(dir, "acceptance_from_self_score");
    expect(fmOf(seatFile(dir, "second")).acceptance[0].id).toBe("second_brief_understood");
  });

  test("acceptance_normalize repairs the id shape and a percentage score", () => {
    const r = root();
    const seat = INTAKE_SEAT.replace("  - id: brief_understood", "  - id: Brief Understood").replace("minimum_score: 0.8", "minimum_score: 80");
    const dir = businessFixture(r, "acc-biz", { employees: { "ceo.md": seat } });
    twice(dir, "acceptance_normalize");
    expect(fmOf(seatFile(dir)).acceptance[0]).toMatchObject({ id: "brief_understood", minimum_score: 0.8 });
  });

  test("draws_from becomes assigned_mind_clones only for clones that exist", () => {
    const r = root();
    const seat = INTAKE_SEAT.replace("type: orchestrator", [
      "type: orchestrator",
      "draws_from:",
      "  - source: /Volumes/x/mindclones/02-strategy/jim-collins",
      "  - source: ~/businesses/_library/dna/nobody-here.md",
    ].join("\n"));
    const dir = businessFixture(r, "draws-biz", { employees: { "ceo.md": seat } });
    const { first } = twice(dir, "draws_from_to_assigned", { available_clones: ["jim-collins"] });
    expect(first.ok).toBe(true);
    const fm = fmOf(seatFile(dir));
    expect(fm.assigned_mind_clones).toEqual(["jim-collins"]);
    // One source resolved to nothing, so the field that carried it stays.
    expect(fm.draws_from).toHaveLength(2);
    expect(first.note).toMatch(/kept/);
  });

  test("draws_from goes when every source landed", () => {
    const r = root();
    const seat = INTAKE_SEAT.replace("type: orchestrator", "type: orchestrator\ndraws_from:\n  - source: dna/jim-collins/agent/AGENT.md");
    const dir = businessFixture(r, "draws-clean", { employees: { "ceo.md": seat } });
    twice(dir, "draws_from_to_assigned", { available_clones: ["jim-collins"] });
    const fm = fmOf(seatFile(dir));
    expect(fm.draws_from).toBeUndefined();
    expect(fm.assigned_mind_clones).toEqual(["jim-collins"]);
  });

  test("dna_reference becomes a pin, and stays put when the clone is missing", () => {
    const r = root();
    const seat = INTAKE_SEAT.replace("type: orchestrator", "type: orchestrator\ndna_reference: dna/april-dunford/agent/AGENT.md");
    const dir = businessFixture(r, "pin-biz", { employees: { "ceo.md": seat } });
    twice(dir, "dna_reference_to_pin", { available_clones: ["april-dunford"] });
    expect(fmOf(seatFile(dir)).pinned_mind_clones).toEqual(["april-dunford"]);
    expect(fmOf(seatFile(dir)).dna_reference).toBeUndefined();

    const other = businessFixture(root(), "pin-miss", { employees: { "ceo.md": seat } });
    const r2 = apply(other, "dna_reference_to_pin", { available_clones: [] });
    expect(r2.note).toMatch(/kept/);
    expect(fmOf(seatFile(other)).dna_reference).toBe("dna/april-dunford/agent/AGENT.md");
  });

  test("type_flag_sync gives an antagonist_gate seat its flag", () => {
    const r = root();
    const gate = ["---", "name: second", "role: Adversarial reviewer", "description: Reviews the deliverable before it leaves the business, against the brief.",
      "type: antagonist_gate", "reports_to: ceo", "---", "", "# second", ""].join("\n");
    const dir = businessFixture(r, "gate-biz", { employees: { "ceo.md": INTAKE_SEAT, "second.md": gate } });
    twice(dir, "type_flag_sync");
    expect(fmOf(seatFile(dir, "second")).is_antagonist).toBe(true);
  });

  test("employee_frontmatter_repair derives a header and keeps the prose", () => {
    const r = root();
    const bare = "# Growth lead\n\nOwns acquisition end to end, from the first ad to the activated account.\n";
    const dir = businessFixture(r, "bare-biz", { employees: { "ceo.md": INTAKE_SEAT, "growth.md": bare } });
    const { first } = twice(dir, "employee_frontmatter_repair");
    expect(first.repaired).toEqual(["growth"]);
    const fm = fmOf(seatFile(dir, "growth"));
    expect(fm.name).toBe("growth");
    expect(fm.role).toBe("Growth lead");
    expect(fm.description).toContain("Owns acquisition end to end");
    expect(fs.readFileSync(seatFile(dir, "growth"), "utf8")).toContain(bare);
  });

  test("intake_from_chart_root promotes the root, and refuses to choose between two", () => {
    const r = root();
    const noIntake = INTAKE_SEAT.replace("is_brief_intake: true", "is_brief_intake: false");
    const dir = businessFixture(r, "root-biz", { employees: { "ceo.md": noIntake } });
    twice(dir, "intake_from_chart_root");
    expect(fmOf(seatFile(dir)).is_brief_intake).toBe(true);

    const two = businessFixture(root(), "two-biz", {
      employees: { "ceo.md": INTAKE_SEAT, "second.md": ["---", "name: second", "role: Second", "description: Another seat that also declares itself the intake of the business.", "is_brief_intake: true", "---", "", "# second", ""].join("\n") },
    });
    expect(apply(two, "intake_from_chart_root").ok).toBe(false);
  });
});

// ── the manifest, routing and file fixers ───────────────────────────────────

describe("manifest and routing fixers", () => {
  test("employee_count_strip and squads_authorized_empty_strip keep every other key and comment", () => {
    const r = root();
    const dir = businessFixture(r, "strip-biz", {
      manifestExtra: "# a comment about the whole business\nauthor: someone\nemployee_count: 1\nsquads_authorized: []",
    });
    twice(dir, "employee_count_strip");
    twice(dir, "squads_authorized_empty_strip");
    const text = fs.readFileSync(path.join(dir, "business.yaml"), "utf8");
    // A comment that belongs to a surviving key survives with it; one attached
    // to the removed key leaves with the key, which is what the author meant.
    expect(text).toContain("# a comment about the whole business");
    expect(manifestOf(dir).employee_count).toBeUndefined();
    expect(manifestOf(dir).squads_authorized).toBeUndefined();
    expect(manifestOf(dir).author).toBe("someone");
    expect(manifestOf(dir).name).toBe("strip-biz");
    // The description keeps its single line: the rewrite never re-wraps prose.
    expect(text).toContain("description: Fixture business that turns a written brief into one artifact, decides the format from the brief and hands it back reviewed.");
  });

  test("squads_authorized_empty_strip never touches a fence that names a squad", () => {
    const r = root();
    const dir = businessFixture(r, "fenced-biz", { manifestExtra: "squads_authorized: [brandcraft]" });
    apply(dir, "squads_authorized_empty_strip");
    expect(manifestOf(dir).squads_authorized).toEqual(["brandcraft"]);
  });

  test("deprecated_field_strip only accepts a field §22 retires", () => {
    const r = root();
    const seat = INTAKE_SEAT.replace("type: orchestrator", "type: orchestrator\nbudget_monthly_usd: 40\nmentions:\n  receives: ['@ceo']");
    const dir = businessFixture(r, "dep-biz", { employees: { "ceo.md": seat } });
    twice(dir, "deprecated_field_strip", { field: "budget_monthly_usd" });
    twice(dir, "deprecated_field_strip", { field: "mentions" });
    expect(fmOf(seatFile(dir)).budget_monthly_usd).toBeUndefined();
    expect(fmOf(seatFile(dir)).mentions).toBeUndefined();
    expect(fmOf(seatFile(dir)).role).toBeTruthy();
    expect(apply(dir, "deprecated_field_strip", { field: "description" })).toMatchObject({ ok: false });
  });

  test("auto_routes_relocate moves every route and drops none", () => {
    const r = root();
    const dir = businessFixture(r, "relocate-biz", {
      manifestExtra: 'auto_routes:\n  - pattern: "(?i)fixture report"\n    route_to: ceo\n  - pattern: "(?i)relatorio"\n    route_to: ceo',
      routing: 'brief_intake:\n  default_employee: ceo\nauto_routes:\n  - pattern: "(?i)fixture report"\n    route_to: ceo\n',
    });
    const { first } = twice(dir, "auto_routes_relocate");
    expect(first.relocated).toBe(1);
    expect(first.deduplicated).toBe(1);
    expect(manifestOf(dir).auto_routes).toBeUndefined();
    expect(routingOf(dir).auto_routes.map((x: any) => x.pattern)).toEqual(["(?i)fixture report", "(?i)relatorio"]);
    expect(routingOf(dir).brief_intake.default_employee).toBe("ceo");
  });

  test("auto_routes_relocate creates routing.yaml when the business has none", () => {
    const r = root();
    const dir = businessFixture(r, "no-routing-biz", { manifestExtra: 'auto_routes:\n  - pattern: "(?i)fixture report"\n    route_to: ceo' });
    twice(dir, "auto_routes_relocate");
    expect(routingOf(dir).auto_routes).toHaveLength(1);
  });

  test("catch_all_to_default_employee converts the destination, and declines when it would drop one", () => {
    const r = root();
    const dir = businessFixture(r, "catchall-biz", { routing: 'auto_routes:\n  - pattern: ".*"\n    route_to: ceo\n  - pattern: "(?i)fixture"\n    route_to: ceo\n' });
    const { first } = twice(dir, "catch_all_to_default_employee");
    expect(first.ok).toBe(true);
    expect(routingOf(dir).brief_intake.default_employee).toBe("ceo");
    expect(routingOf(dir).auto_routes.map((x: any) => x.pattern)).toEqual(["(?i)fixture"]);

    const conflict = businessFixture(root(), "conflict-biz", {
      employees: { "ceo.md": INTAKE_SEAT, "second.md": ["---", "name: second", "role: Second", "description: A second seat the catch-all route points at instead of the intake.", "reports_to: ceo", "---", "", "# second", ""].join("\n") },
      routing: 'brief_intake:\n  default_employee: ceo\nauto_routes:\n  - pattern: ".*"\n    route_to: second\n',
    });
    const declined = apply(conflict, "catch_all_to_default_employee");
    expect(declined.ok).toBe(false);
    expect(routingOf(conflict).auto_routes).toHaveLength(1);
  });

  test("manifest_schema_repair fills only what the directory already answers", () => {
    const r = root();
    const dir = businessFixture(r, "schema-biz", { manifest: 'description: A manifest with no name, no version and no protocol at all, which the schema requires.\ndomains: [fixture_domain]\n' });
    const { first } = twice(dir, "manifest_schema_repair");
    expect(first.filled.sort()).toEqual(["name", "protocol", "version"]);
    expect(manifestOf(dir)).toMatchObject({ name: "schema-biz", version: "1.0.0", protocol: "1.0" });
    // Nothing invented: the description the author wrote is still the one there.
    expect(manifestOf(dir).description).toMatch(/^A manifest with no name/);
  });

  test("runtime_requirements_business_default declares the active-runtime policy", () => {
    const r = root();
    const dir = businessFixture(r, "rr-biz", { manifest: 'name: rr-biz\nversion: 1.0.0\nprotocol: "2.0"\ndescription: A manifest whose runtime_requirements never got a floor of its own, only a policy.\ndomains: [fixture_domain]\nruntime_requirements:\n  policy: declared\n' });
    twice(dir, "runtime_requirements_business_default");
    expect(manifestOf(dir).runtime_requirements).toEqual({ policy: "active" });
  });

  test("org_chart_repair derives a chart that is consistent in both directions", () => {
    const r = root();
    const second = ["---", "name: second", "role: Second seat", "description: Reports to the CEO and owns the delivery half of the business.", "reports_to: ceo", "---", "", "# second", ""].join("\n");
    const third = ["---", "name: third", "role: Third seat", "description: Managed by the CEO through manages, with no reports_to of its own.", "---", "", "# third", ""].join("\n");
    const dir = businessFixture(r, "chart-biz", {
      employees: { "ceo.md": INTAKE_SEAT.replace("type: orchestrator", "type: orchestrator\nmanages: [third]"), "second.md": second, "third.md": third },
      orgChart: "chart:\n  - employee: ceo\n    reports: []\n    direct_reports: []\nrouting_rules:\n  escalation_path:\n    second: ceo\n",
    });
    const { first } = twice(dir, "org_chart_repair");
    expect(first.ok).toBe(true);
    const chart = parseYaml(fs.readFileSync(path.join(dir, "org-chart.yaml"), "utf8")) as any;
    expect(chart.chart).toEqual([
      { employee: "ceo", reports: [], direct_reports: ["second", "third"], is_antagonist: false },
      { employee: "second", reports: ["ceo"], direct_reports: [], is_antagonist: false },
      { employee: "third", reports: ["ceo"], direct_reports: [], is_antagonist: false },
    ]);
    // Everything else the file held is still there.
    expect(chart.routing_rules.escalation_path.second).toBe("ceo");
  });

  test("org_chart_repair refuses two roots rather than inventing a hierarchy", () => {
    const r = root();
    const orphan = ["---", "name: second", "role: Second seat", "description: A seat that reports to nobody, next to another seat that reports to nobody.", "---", "", "# second", ""].join("\n");
    const dir = businessFixture(r, "two-roots", { employees: { "ceo.md": INTAKE_SEAT, "second.md": orphan } });
    expect(apply(dir, "org_chart_repair")).toMatchObject({ ok: false });
  });

  test("dna_dir_to_bindings moves the links and keeps a real file", () => {
    const r = root();
    const dir = businessFixture(r, "dna-biz");
    fs.mkdirSync(path.join(dir, "dna"), { recursive: true });
    fs.mkdirSync(path.join(r, "dna", "rory-sutherland"), { recursive: true });
    fs.symlinkSync(path.join(r, "dna", "rory-sutherland"), path.join(dir, "dna", "rory-sutherland"));
    fs.writeFileSync(path.join(dir, "dna", "README.md"), "# why this directory exists\n", "utf8");
    const { first } = twice(dir, "dna_dir_to_bindings");
    expect(first.clones).toEqual(["rory-sutherland"]);
    expect(fmOf(seatFile(dir)).assigned_mind_clones).toEqual(["rory-sutherland"]);
    expect(fs.existsSync(path.join(dir, "dna", "rory-sutherland"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "dna", "README.md"))).toBe(true);
    expect(first.note).toMatch(/README\.md/);
  });

  test("readme_business_scaffold and memory_seed create, never overwrite", () => {
    const r = root();
    const dir = businessFixture(r, "files-biz", { readme: null, memory: false });
    twice(dir, "readme_business_scaffold");
    twice(dir, "memory_seed");
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toContain("Fixture business that turns a written brief");
    expect(fs.readFileSync(path.join(dir, "memory", "permanent.md"), "utf8")).toContain("Permanent memory");
    fs.writeFileSync(path.join(dir, "README.md"), "# mine\n", "utf8");
    apply(dir, "readme_business_scaffold");
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("# mine\n");
  });

  test("an unknown patch kind is refused, an exception is caught", () => {
    const r = root();
    const dir = businessFixture(r, "unknown-biz");
    expect(apply(dir, "no_such_fixer")).toEqual({ ok: false, reason: "unknown patch kind" });
  });
});

// ── the --fix loop end to end ───────────────────────────────────────────────

describe("nrv validate business --fix", () => {
  /** A business that fires most of the mechanical catalog at once. */
  function brokenBusiness(r: string, slug: string): string {
    const seat = INTAKE_SEAT.replace("type: orchestrator", [
      "type: orchestrator",
      "squads_authorized: []",
      "budget_monthly_usd: 40",
      "heartbeat:",
      "  cadence: daily",
      "  enabled: true",
    ].join("\n"));
    const dir = businessFixture(r, slug, {
      protocol: "1.0",
      employees: { "ceo.md": seat },
      manifestExtra: 'employee_count: 1\nauto_routes:\n  - pattern: "(?i)fixture report"\n    route_to: ceo',
      readme: null,
      memory: false,
    });
    return dir;
  }

  test("one run clears every mechanical finding; the second writes nothing", () => {
    const r = root();
    const dir = brokenBusiness(r, "broken-biz");
    const before = runCli(r, ["business", "broken-biz", "--no-retrieval", "--json"]);
    expect(before.json.summary.errors).toBeGreaterThan(0);

    const fixed = runCli(r, ["business", "broken-biz", "--no-retrieval", "--fix", "--json"]);
    expect(fixed.json.fix_outcome.rolled_back).toBe(false);
    expect(fixed.json.fix_outcome.backup).toBeTruthy();
    expect(fixed.json.summary.errors).toBe(0);
    expect(fixed.json.findings.filter((f: any) => f.fixer).map((f: any) => f.id)).toEqual([]);

    const digest = treeDigest(dir);
    const again = runCli(r, ["business", "broken-biz", "--no-retrieval", "--fix", "--json"]);
    expect(again.json.summary.errors).toBe(0);
    expect(treeDigest(dir)).toEqual(digest);
  }, spawnBudgetMs(3));

  test("the backup holds the business as it was before the fixers ran", () => {
    const r = root();
    const dir = brokenBusiness(r, "backup-biz");
    const before = treeDigest(dir);
    const out = runCli(r, ["business", "backup-biz", "--no-retrieval", "--fix", "--json"]);
    const backup = out.json.fix_outcome.backup as string;
    expect(fs.existsSync(backup)).toBe(true);
    expect(treeDigest(backup)).toEqual(before);
  }, spawnBudgetMs(2));

  test("protocol rises only once nothing is an error any more", () => {
    const r = root();
    // A schema failure no fixer can derive: `domains` is required and empty.
    const dir = businessFixture(r, "still-broken", {
      protocol: "1.0",
      manifest: 'name: still-broken\nversion: 1.0.0\nprotocol: "1.0"\ndescription: A manifest whose domains list is empty, which no mechanical fixer can fill in for the author.\ndomains: []\nruntime_requirements:\n  policy: active\n',
    });
    const out = runCli(r, ["business", "still-broken", "--no-retrieval", "--fix", "--json"]);
    expect(manifestOf(dir).protocol).toBe("1.0");
    const bump = out.json.fixes.find((f: any) => f.fixer === "protocol_bump_2");
    expect(bump.applied).toBe(false);
    expect(bump.note).toMatch(/error\(s\) still open/);

    const clean = root();
    businessFixture(clean, "clean-v1", { protocol: "1.0" });
    runCli(clean, ["business", "clean-v1", "--no-retrieval", "--fix"]);
    expect(manifestOf(path.join(clean, "businesses", "clean-v1")).protocol).toBe("2.0");
  }, spawnBudgetMs(2));

  test("--fix never deletes an authored file and never drops a route", () => {
    const r = root();
    const dir = businessFixture(r, "authored-biz", {
      protocol: "1.0",
      routing: 'brief_intake:\n  default_employee: ceo\nauto_routes:\n  - pattern: "(?i)fixture report"\n    route_to: ceo\n',
    });
    fs.writeFileSync(path.join(dir, "culture.md"), "# Culture\n\nWritten by a human.\n", "utf8");
    fs.writeFileSync(path.join(dir, "escalation-triggers.yaml"), "triggers: []\n", "utf8");
    writeSurfaceFor(dir, "business");
    runCli(r, ["business", "authored-biz", "--no-retrieval", "--fix"]);
    expect(fs.readFileSync(path.join(dir, "culture.md"), "utf8")).toContain("Written by a human.");
    expect(fs.existsSync(path.join(dir, "escalation-triggers.yaml"))).toBe(true);
    expect(routingOf(dir).auto_routes).toHaveLength(1);
  }, spawnBudgetMs(2));

  test("a seat's body survives the whole loop byte for byte", () => {
    const r = root();
    const dir = brokenBusiness(r, "body-biz");
    const before = bodyOf(seatFile(dir));
    runCli(r, ["business", "body-biz", "--no-retrieval", "--fix"]);
    expect(bodyOf(seatFile(dir))).toBe(before);
  }, spawnBudgetMs(2));

  test("a fixer that breaks the manifest rolls the whole business back", async () => {
    const r = root();
    const dir = brokenBusiness(r, "sabotaged-biz");
    const before = treeDigest(dir);
    // The saboteur stands in for `heartbeat_strip` and writes YAML that does
    // not parse. Every other handler still runs; the loop must undo all of it.
    const sabotaged: KindModule = {
      ...businessModule,
      fixers: {
        ...businessModule.fixers,
        heartbeat_strip: ({ finding }) => {
          fs.writeFileSync(path.join(dir, "business.yaml"), "name: [unclosed\n", "utf8");
          return { fixer: "heartbeat_strip", finding: finding.id, applied: true, changed_files: ["business.yaml"] };
        },
      },
    };
    const report = await verifyEntity("business", dir, {
      fix: "mechanical", retrieval: false, baselinePath: null, stateDir: null, emit: null,
      backupRoot: path.join(r, "backups"), module: sabotaged,
    });
    expect(report.fix_outcome?.rolled_back).toBe(true);
    expect(report.fix_outcome?.rollback_reason).toContain("manifest");
    expect(treeDigest(dir)).toEqual(before);
  });

  test("--all --fix walks the library the CLI was pointed at", () => {
    const r = root();
    brokenBusiness(r, "one-biz");
    brokenBusiness(r, "two-biz");
    const out = runCli(r, ["business", "--all", "--no-retrieval", "--fix", "--json"]);
    expect(out.json.entities).toBe(2);
    expect(out.json.summary.errors).toBe(0);
    expect(out.code).toBe(0);
  }, spawnBudgetMs(2));
});

// ── the environment contract ────────────────────────────────────────────────

describe("the fixers stay inside the directory they were given", () => {
  test("nothing under ~/businesses is opened while a fixture is repaired", () => {
    const r = root();
    const dir = businessFixture(r, "scoped-biz", { protocol: "1.0", readme: null });
    const env = cliEnv(r);
    expect(env.BUSINESSES_DIR).toBe(path.join(r, "businesses"));
    runCli(r, ["business", "scoped-biz", "--no-retrieval", "--fix"]);
    expect(fs.existsSync(path.join(dir, "README.md"))).toBe(true);
    expect(path.resolve(dir).startsWith(path.resolve(r))).toBe(true);
  }, spawnBudgetMs(2));
});
