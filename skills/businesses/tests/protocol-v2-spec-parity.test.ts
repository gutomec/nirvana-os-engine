// protocol-v2-spec-parity.test.ts — §16.2 of BUSINESS_PROTOCOL_V2.md IS the
// admission gate's criteria catalog, not a prose description of it.
//
// A spec table and a code catalog that are only *meant* to agree drift within
// one cut: this repository already shipped a SKILL.md pointing at six reference
// files that never existed. So the table is parsed here and compared, id by id,
// against the module the gate executes.
//
// The comparison used to run in one direction only (module ⊆ spec), because the
// module carried three structural criteria and the catalog had not landed yet.
// It is an equality now: same ids, same severity, same autofix class, same
// baselineable flag. Adding a criterion to one side without the other is a red
// test, which is the point.
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
  /** The spec writes the autofix class in Portuguese; the module in English. */
  const AUTOFIX: Record<string, string> = { "mecânico": "mechanical", "agêntico": "agentic", "nenhum": "none" };

  test("the module exists and exports a catalog", () => {
    expect(existsSync(KIND_MODULE)).toBe(true);
  });

  test("the two id sets are equal, in both directions", async () => {
    const mod = await import(KIND_MODULE);
    const moduleIds = (mod.criteria as Array<{ id: string }>).map((c) => c.id);
    expect(new Set(moduleIds).size).toBe(moduleIds.length);
    const specIds = spec.map((c) => c.id);
    expect(moduleIds.filter((id) => !specIds.includes(id))).toEqual([]);   // module ⊆ spec
    expect(specIds.filter((id) => !moduleIds.includes(id))).toEqual([]);   // spec ⊆ module
    expect(moduleIds.length).toBe(specIds.length);
  });

  test("severity, autofix class and baselineable agree row by row", async () => {
    const mod = await import(KIND_MODULE);
    const byId = new Map((mod.criteria as Array<Record<string, unknown>>).map((c) => [c.id as string, c]));
    const drift: string[] = [];
    for (const row of spec) {
      const c = byId.get(row.id);
      if (!c) continue;                                    // the id test above owns this
      if (c.severity !== row.severity) drift.push(`${row.id}: severity ${String(c.severity)} vs ${row.severity}`);
      if (c.autofix !== AUTOFIX[row.autofix]) drift.push(`${row.id}: autofix ${String(c.autofix)} vs ${AUTOFIX[row.autofix]}`);
      if (c.baselineable !== row.baselineable) drift.push(`${row.id}: baselineable ${String(c.baselineable)} vs ${row.baselineable}`);
    }
    expect(drift).toEqual([]);
  });

  test("every mechanical row names a fixer the module can actually run", async () => {
    const mod = await import(KIND_MODULE);
    const fixers = new Set(Object.keys(mod.businessModule.fixers));
    const missing: string[] = [];
    for (const c of mod.criteria as Array<{ id: string; autofix: string; fixer?: string }>) {
      if (c.autofix !== "mechanical") continue;
      if (!c.fixer || !fixers.has(c.fixer)) missing.push(c.id);
    }
    expect(missing).toEqual([]);
  });
});
