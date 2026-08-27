// protocol-v2-spec-parity.test.ts — §16.2 of BUSINESS_PROTOCOL_V2.md IS the
// admission gate's criteria catalog, not a prose description of it.
//
// A spec table and a code catalog that are only *meant* to agree drift within
// one cut: this repository already shipped a SKILL.md pointing at six reference
// files that never existed. So the table is parsed here and compared, id by id,
// against the module the gate executes.
//
// The business kind module (`_shared/lib/verify/kinds/business.ts`) lands in a
// later cut. Until it exists, the comparison has nothing to run against — and a
// silent `skip` would let the spec rot unnoticed for as long as that takes. So
// the tests below always run: they assert the table is well-formed on its own,
// and the parity test states out loud that the module is absent and flips to a
// real comparison the moment the file appears. Nothing has to be re-enabled by
// hand.
//
// Runs with: bun test skills/businesses/tests
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SPEC = join(import.meta.dir, "..", "BUSINESS_PROTOCOL_V2.md");
/** Where the gate's business criteria land. Absent until the verify-gate cut. */
const KIND_MODULE = join(import.meta.dir, "..", "..", "_shared", "lib", "verify", "kinds", "business.ts");

export interface SpecCriterion {
  id: string;
  severity: "error" | "warning";
  autofix: string;
  baselineable: boolean;
}

/**
 * Parse the two tables under `### 16.2`. A row is
 * `| \`id\` | autofix | baselinável | descrição |`, and the `#### Erros` /
 * `#### Avisos` headings decide the severity.
 */
export function parseSpecCriteria(text: string): SpecCriterion[] {
  const start = text.indexOf("### 16.2");
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf("\n### ", start + 1);
  const section = text.slice(start, end === -1 ? undefined : end);

  const out: SpecCriterion[] = [];
  let severity: "error" | "warning" | null = null;
  for (const line of section.split("\n")) {
    if (/^####\s+Erros/.test(line)) { severity = "error"; continue; }
    if (/^####\s+Avisos/.test(line)) { severity = "warning"; continue; }
    if (!severity || !line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) continue;
    const id = /^`([^`]+)`$/.exec(cells[0])?.[1];
    if (!id) continue;                                   // header + separator rows
    out.push({ id, severity, autofix: cells[1], baselineable: cells[2] === "sim" });
  }
  return out;
}

const spec = parseSpecCriteria(readFileSync(SPEC, "utf8"));

describe("Business Protocol 2.0 §16.2 — the table is a catalog", () => {
  test("both severities are populated", () => {
    expect(spec.filter((c) => c.severity === "error").length).toBeGreaterThan(10);
    expect(spec.filter((c) => c.severity === "warning").length).toBeGreaterThan(10);
  });

  test("every id is a slug the gate can emit, and no id is declared twice", () => {
    for (const c of spec) expect(c.id).toMatch(/^[a-z][a-z0-9_]*$/);
    const ids = spec.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("autofix is one of the three declared values", () => {
    for (const c of spec) expect(["mecânico", "agêntico", "nenhum"]).toContain(c.autofix);
  });

  test("the criteria the protocol names in prose are in the table", () => {
    const ids = new Set(spec.map((c) => c.id));
    for (const id of [
      "protocol_v1", "employee_count_authored", "squads_authorized_empty",
      "auto_route_catch_all", "auto_route_never_fires", "auto_route_unknown_employee",
      "pinned_clone_unresolved", "type_mind_clone_without_pin", "type_flag_mismatch",
      "dna_dir_present", "dna_symlink_dangling", "surface_missing", "surface_stale",
      "acceptance_invalid", "acceptance_missing", "deprecated_field", "deprecated_file",
    ]) expect(ids).toContain(id);
  });

  test("only the two facts the pipeline produces are baselineable", () => {
    expect(spec.filter((c) => c.baselineable).map((c) => c.id).sort())
      .toEqual(["seat_thin", "self_retrieval_miss"]);
    for (const c of spec) if (c.severity === "error") expect(c.baselineable).toBe(false);
  });
});

describe("Business Protocol 2.0 §16.2 — parity with the gate module", () => {
  test("every criterion the module carries is declared by the spec", async () => {
    // The gate module grows one cut at a time: PR2 landed the three structural
    // criteria, the full catalog arrives with the business cut. The direction
    // asserted here is the one that must hold at every point in between — the
    // module never checks something §16 does not declare. The other direction
    // (spec ⊆ module) becomes true when the catalog lands, and the count below
    // is what tells us how far the module still is.
    expect(existsSync(KIND_MODULE)).toBe(true);
    const mod = await import(KIND_MODULE);
    const moduleIds = new Set<string>(
      (mod.criteria ?? mod.default?.criteria ?? []).map((c: { id: string }) => c.id.split(":")[0]),
    );
    const specIds = new Set(spec.map((c) => c.id));
    expect([...moduleIds].filter((id) => !specIds.has(id))).toEqual([]);
    expect(moduleIds.size).toBeGreaterThan(0);
  });
});
