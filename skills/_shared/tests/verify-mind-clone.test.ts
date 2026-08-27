// verify-mind-clone.test.ts — one fixture per criterion of the mind-clone
// catalog, and the six mechanical fixers. In-process (no CLI): baseline,
// state and audit are off, self-retrieval runs only where injected.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CANONICAL_ARTIFACTS, countLayerItems, mindCloneCriteria, verifyEntity } from "../lib/verify/index.ts";
import { cloneFixture, rmrf, tempRoot } from "./helpers/verify-fixture.ts";

const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) rmrf(r); });
function root(): string { const r = tempRoot(); ROOTS.push(r); return r; }
const quiet = { retrieval: false, baselinePath: null, stateDir: null, emit: null } as const;

async function ids(dir: string, extra: Record<string, unknown> = {}): Promise<string[]> {
  const r = await verifyEntity("mind-clone", dir, { ...quiet, ...extra });
  return r.findings.map((f) => (f.where ? `${f.id}:${f.where}` : f.id)).sort();
}
async function finding(dir: string, id: string) {
  const r = await verifyEntity("mind-clone", dir, quiet);
  return r.findings.find((f) => f.id === id);
}
const manifest = (dir: string) => fs.readFileSync(path.join(dir, "MANIFEST.yaml"), "utf8");
const setManifest = (dir: string, text: string) => fs.writeFileSync(path.join(dir, "MANIFEST.yaml"), text, "utf8");

describe("the catalog", () => {
  test("every criterion has an id, a severity, an autofix and a baselineable flag; every fixer is declared", () => {
    const seen = new Set<string>();
    for (const c of mindCloneCriteria) {
      expect(seen.has(c.id)).toBe(false); seen.add(c.id);
      expect(["error", "warning", "info"]).toContain(c.severity);
      expect(["mechanical", "agentic", "none"]).toContain(c.autofix);
      expect(typeof c.baselineable).toBe("boolean");
      if (c.autofix === "mechanical") expect(typeof c.fixer).toBe("string");
    }
    const baselineable = mindCloneCriteria.filter((c) => c.baselineable).map((c) => c.id).sort();
    expect(baselineable).toEqual(["dna_layers_missing", "fonte_density_low", "one_liner_missing", "routing_block_missing", "self_retrieval_miss", "source_material_missing", "validation_verdict_missing"]);
    const errors = mindCloneCriteria.filter((c) => c.severity === "error").map((c) => c.id).sort();
    expect(errors).toEqual(["agent_md_invalid", "artifact_missing", "category_numbered", "dna_schema_layers_incomplete", "domains_item_malformed", "manifest_name_mismatch", "manifest_parse", "manifest_schema", "surface_missing", "validation_verdict_unknown"]);
  });

  test("a complete clone has no finding at all", async () => {
    expect(await ids(cloneFixture(root(), "jane-doe"))).toEqual([]);
  });
});

describe("errors", () => {
  test("manifest_parse", async () => {
    const dir = cloneFixture(root(), "jane-doe");
    setManifest(dir, "manifest: [unclosed\n");
    const r = await ids(dir);
    expect(r).toContain("manifest_parse");
    expect(r).not.toContain("manifest_schema");
    expect(r).toContain("surface_stale"); // the manifest changed after the surface was written
  });
  test("manifest_schema: shape only, the semantic ids are separate", async () => {
    const dir = cloneFixture(root(), "jane-doe", { extraManifest: "" });
    setManifest(dir, manifest(dir).replace("  version: 1.0.0", "  version: v1"));
    const f = await finding(dir, "manifest_schema");
    expect(f?.severity).toBe("error");
    expect(f?.evidence).toContain("manifest.version");
  });
  test("manifest_name_mismatch", async () => {
    expect(await ids(cloneFixture(root(), "jane-doe", { name: "someone-else" }))).toEqual(["manifest_name_mismatch"]);
  });
  test("artifact_missing:<path> for each canonical artifact, empty counts as absent", async () => {
    for (const rel of CANONICAL_ARTIFACTS) {
      const dir = cloneFixture(root(), "jane-doe");
      fs.writeFileSync(path.join(dir, rel), "\n", "utf8");
      const r = await ids(dir);
      expect(r).toContain(`artifact_missing:${rel}`);
    }
  });
  test("agent_md_invalid uses the persona validator's errors", async () => {
    const dir = cloneFixture(root(), "jane-doe");
    fs.writeFileSync(path.join(dir, "agent", "AGENT.md"), "---\nname: jane-doe\n---\n\n# thin\n", "utf8");
    const f = await finding(dir, "agent_md_invalid");
    expect(f?.severity).toBe("error");
    expect(f?.message).toContain("DESCRIPTION_MISSING");
    expect(f?.message).toContain("BODY_TOO_THIN");
  });
  test("category_numbered (bare is canonical); a bare category is fine", async () => {
    expect(await ids(cloneFixture(root(), "jane-doe", { category: "09-marketing" }))).toEqual(["category_numbered"]);
    expect(await ids(cloneFixture(root(), "jane-doe", { category: "tax-law" }))).toEqual([]);
  });
  test("domains_item_malformed, per item", async () => {
    const dir = cloneFixture(root(), "jane-doe");
    setManifest(dir, manifest(dir).replace('    - "slogan"', "    - margem de segurança: desconto sobre o valor"));
    const r = await ids(dir);
    expect(r.some((x) => x.startsWith("domains_item_malformed:domains["))).toBe(true);
    expect(r).not.toContain("manifest_schema");
  });
  test("validation_verdict_unknown; the three live verdicts are known", async () => {
    expect(await ids(cloneFixture(root(), "jane-doe", { verdict: "MAYBE" }))).toEqual(["validation_verdict_unknown"]);
    for (const v of ["ARCHETYPE_PERSONA", "EXTRACTED_FROM_PUBLIC_CORPUS", "PACKAGED_FROM_EXISTING_DOSSIER"]) expect(await ids(cloneFixture(root(), "jane-doe", { verdict: v }))).toEqual([]);
  });
  test("dna_schema_layers_incomplete below three layers", async () => {
    const dir = cloneFixture(root(), "jane-doe");
    fs.writeFileSync(path.join(dir, "dna", "dna-schema.md"), "# DNA\n\n## L1 — Philosophies\n\n1. **A.** x ^[FONTE:x]\n\n## L2 — Mental Models\n\n1. **B.** y ^[FONTE:y]\n", "utf8");
    const r = await ids(dir);
    expect(r).toContain("dna_schema_layers_incomplete");
    expect(r).not.toContain("dna_layers_count_drift");
  });
  test("surface_missing", async () => {
    expect(await ids(cloneFixture(root(), "jane-doe", { surface: false }))).toEqual(["surface_missing"]);
  });
});

describe("warnings", () => {
  test("artifacts_status_wrong only when a status is declared and wrong", async () => {
    const dir = cloneFixture(root(), "jane-doe", { artifacts: [
      { path: "agent/AGENT.md", status: "missing" }, { path: "agent/SOUL.md" }, { path: "agent/DNA-CONFIG.yaml", status: "pending" }, { path: "dna/dna-schema.md", status: "present" },
    ] });
    const f = await finding(dir, "artifacts_status_wrong");
    expect(f?.severity).toBe("warning");
    expect(f?.evidence).toContain("agent/AGENT.md: declared missing, disk present");
    expect(f?.evidence).not.toContain("SOUL");
  });
  test("routing_block_missing (baselineable, agentic)", async () => {
    const f = await finding(cloneFixture(root(), "jane-doe", { routing: null }), "routing_block_missing");
    expect(f).toMatchObject({ severity: "warning", autofix: "agentic", baselined: false });
  });
  test("one_liner_missing / one_liner_too_long", async () => {
    expect(await ids(cloneFixture(root(), "jane-doe", { routing: { one_liner: "" } }))).toEqual(["one_liner_missing"]);
    expect(await ids(cloneFixture(root(), "jane-doe", { routing: { one_liner: "x".repeat(121) } }))).toEqual(["one_liner_too_long"]);
    expect(await ids(cloneFixture(root(), "jane-doe", { routing: { one_liner: "x".repeat(120) } }))).toEqual([]);
  });
  test("domains_count outside 20–30", async () => {
    expect(await ids(cloneFixture(root(), "jane-doe", { routing: { domains: ["a", "b", "c"] } }))).toEqual(["domains_count"]);
    expect(await ids(cloneFixture(root(), "jane-doe", { routing: { domains: Array.from({ length: 31 }, (_, i) => `d${i}`) } }))).toEqual(["domains_count"]);
  });
  test("domains_negation, domains_slash, domains_refuses_conflict (accent-insensitive)", async () => {
    const base = Array.from({ length: 19 }, (_, i) => `d${i}`);
    expect(await ids(cloneFixture(root(), "jane-doe", { routing: { domains: [...base, "sugerir em vez de explicar"] } }))).toEqual(["domains_negation"]);
    expect(await ids(cloneFixture(root(), "jane-doe", { routing: { domains: [...base, "tom de voz / tone of voice"] } }))).toEqual(["domains_slash"]);
    expect(await ids(cloneFixture(root(), "jane-doe", { routing: { domains: [...base, "Resposta Direta"], refuses: ["resposta direta"] } }))).toEqual(["domains_refuses_conflict"]);
    expect(await ids(cloneFixture(root(), "jane-doe", { routing: { domains: [...base, "cartum"], refuses: ["Cartúm"] } }))).toEqual(["domains_refuses_conflict"]);
  });
  test("serves_missing (legacy when_to_use named), serves_too_long, not_for_missing", async () => {
    const r = await verifyEntity("mind-clone", cloneFixture(root(), "jane-doe", { routing: { serves: undefined, when_to_use: "legacy prose" } }), quiet);
    const f = r.findings.find((x) => x.id === "serves_missing");
    expect(f?.message).toContain("when_to_use");
    expect(await ids(cloneFixture(root(), "jane-doe", { routing: { serves: Array.from({ length: 501 }, () => "word").join(" ") } }))).toEqual(["serves_too_long"]);
    expect(await ids(cloneFixture(root(), "jane-doe", { routing: { not_for: undefined } }))).toEqual(["not_for_missing"]);
  });
  test("delegates_to_present is mechanical", async () => {
    const f = await finding(cloneFixture(root(), "jane-doe", { routing: { delegates_to: ["x", "y"] } }), "delegates_to_present");
    expect(f).toMatchObject({ severity: "warning", autofix: "mechanical", fixer: "delegates_to_strip" });
  });
  test("validation_verdict_missing and source_material_missing are baselineable debt", async () => {
    expect(await ids(cloneFixture(root(), "jane-doe", { verdict: null }))).toEqual(["validation_verdict_missing"]);
    expect(await ids(cloneFixture(root(), "jane-doe", { sourceMaterial: false }))).toEqual(["source_material_missing"]);
    const dir = cloneFixture(root(), "jane-doe");
    setManifest(dir, manifest(dir).replace(/source_material:\n  primary:\n.*\n.*\n/, "source_material:\n  primary: []\n"));
    expect(await ids(dir)).toContain("source_material_missing");
  });
  test("dna_layers_missing, dna_layers_count_drift, dna_layers_below_min", async () => {
    expect(await ids(cloneFixture(root(), "jane-doe", { dnaLayers: null }))).toEqual(["dna_layers_missing"]);
    const f = await finding(cloneFixture(root(), "jane-doe", { dnaLayers: { L3_heuristics: 12 } }), "dna_layers_count_drift");
    expect(f?.evidence).toContain("L3_heuristics: declared 12, measured 5");
    const dir = cloneFixture(root(), "jane-doe", { dnaLayers: { L1_philosophies: 2 } });
    const md = fs.readFileSync(path.join(dir, "dna", "dna-schema.md"), "utf8").replace("3. **Item 3.** Statement 3. ^[FONTE:SOUL.md#V1]\n", "");
    fs.writeFileSync(path.join(dir, "dna", "dna-schema.md"), md, "utf8");
    const r = await ids(dir);
    expect(r).toContain("dna_layers_below_min");
    expect(r).not.toContain("dna_layers_count_drift");
  });
  test("fonte_density_low and source_coverage_unsupported", async () => {
    const r = await verifyEntity("mind-clone", cloneFixture(root(), "jane-doe", { fonte: false }), quiet);
    const idsNow = r.findings.map((f) => f.id).sort();
    expect(idsNow).toEqual(["fonte_density_low", "source_coverage_unsupported"]);
    expect(r.findings.find((f) => f.id === "fonte_density_low")?.message).toContain("ARCHETYPE_PERSONA");
    expect(await ids(cloneFixture(root(), "jane-doe", { fonte: false, scores: { source_coverage: 0 } }))).toEqual(["fonte_density_low"]);
  });
  test("surface_stale after a file changes", async () => {
    const dir = cloneFixture(root(), "jane-doe");
    fs.appendFileSync(path.join(dir, "agent", "SOUL.md"), "\nMore voice.\n");
    expect(await ids(dir)).toEqual(["surface_stale"]);
  });
  test("self_retrieval_miss with an injected registry; a hit is silent; absence is info", async () => {
    const dir = cloneFixture(root(), "jane-doe");
    const entry = (slug: string, one_liner: string, domains: string[]) => ({ slug, display_name: slug, tags: [], pack_category: null, manifest_category: null, match: { one_liner, domains, serves: null, when_to_use: null, not_for: null, refuses: [], delegates_to: [] } });
    const hit = { "jane-doe": entry("jane-doe", "Jane Doe — the choice for brand tone of voice and verbal identity", ["brand tone of voice", "verbal identity"]), other: entry("other", "Other — the choice for cinematic promo video rendering", ["promo video", "render"]) };
    expect(await ids(dir, { retrieval: true, cloneRegistry: hit })).toEqual([]);
    const miss = { "jane-doe": entry("jane-doe", "brand tone of voice", []), other: entry("other", "brand tone of voice and verbal identity, brand tone of voice", ["brand tone of voice", "verbal identity", "brand tone of voice"]) };
    const r = await verifyEntity("mind-clone", dir, { ...quiet, retrieval: true, cloneRegistry: miss });
    const f = r.findings.find((x) => x.id === "self_retrieval_miss");
    expect(f).toMatchObject({ severity: "warning", autofix: "agentic" });
    expect(f?.evidence).toContain("clone:other");
    expect(await ids(dir, { retrieval: true, cloneRegistry: { other: hit.other } })).toEqual(["registry_absent"]);
  });
});

describe("fixers", () => {
  const fix = (dir: string) => verifyEntity("mind-clone", dir, { ...quiet, fix: "mechanical", backupRoot: path.join(dir, "..", "..", "backups") });

  test("manifest_name_sync, category_bare, delegates_to_strip keep comments and untouched formatting", async () => {
    const dir = cloneFixture(root(), "jane-doe", { name: "wrong-name", category: "09-marketing", routing: { delegates_to: ["x"] } });
    const before = manifest(dir);
    const r = await fix(dir);
    expect(r.exit_code).toBe(0);
    expect(r.fixes.filter((f) => f.applied).map((f) => f.fixer)).toEqual(["manifest_name_sync", "category_bare", "delegates_to_strip", "surface_regen"]);
    const after = manifest(dir);
    expect(after).toContain("# fixture manifest — this comment must survive a --fix");
    expect(after).toContain("  name: jane-doe");
    expect(after).toContain("  category: marketing");
    expect(after).not.toContain("delegates_to");
    // untouched blocks are byte-identical
    const tail = (s: string) => s.slice(s.indexOf("artifacts:"));
    expect(tail(after)).toBe(tail(before));
  });

  test("artifacts_status_sync rewrites only the wrong statuses", async () => {
    const dir = cloneFixture(root(), "jane-doe", { artifacts: [
      { path: "agent/AGENT.md", status: "missing" }, { path: "agent/SOUL.md" }, { path: "agent/DNA-CONFIG.yaml", status: "present" }, { path: "dna/dna-schema.md", status: "present" },
    ] });
    await fix(dir);
    const after = manifest(dir);
    expect(after).toContain("  - path: agent/AGENT.md\n    status: present");
    expect(after).toContain("  - path: agent/SOUL.md\n  - path: agent/DNA-CONFIG.yaml");
    expect(await ids(dir)).toEqual([]);
  });

  test("dna_layers_sync measures the schema: drift is corrected, a missing block is written", async () => {
    const drift = cloneFixture(root(), "jane-doe", { dnaLayers: { L2_mental_models: 9, L4_frameworks: 1 } });
    await fix(drift);
    expect(manifest(drift)).toContain("  L2_mental_models: 4\n  L3_heuristics: 5\n  L4_frameworks: 3\n");
    const missing = cloneFixture(root(), "jane-doe", { dnaLayers: null });
    await fix(missing);
    expect(manifest(missing)).toContain("dna_layers:\n  L1_philosophies: 3\n  L2_mental_models: 4\n  L3_heuristics: 5\n  L4_frameworks: 3\n  L5_methodologies: 1\n");
    expect(await ids(missing)).toEqual([]);
  });

  test("surface_regen after a stale surface", async () => {
    const dir = cloneFixture(root(), "jane-doe");
    fs.appendFileSync(path.join(dir, "agent", "SOUL.md"), "\nMore voice.\n");
    const r = await fix(dir);
    expect(r.fixes.map((f) => f.fixer)).toEqual(["surface_regen"]);
    expect(await ids(dir)).toEqual([]);
  });

  test("the fixers never invent a source or a citation", async () => {
    const dir = cloneFixture(root(), "jane-doe", { sourceMaterial: false, fonte: false, verdict: null, routing: null });
    const r = await fix(dir);
    expect(r.fixes).toEqual([]);
    expect(manifest(dir)).not.toContain("source_material");
    expect(fs.readFileSync(path.join(dir, "dna", "dna-schema.md"), "utf8")).not.toContain("FONTE");
  });
});

describe("layer item counting", () => {
  test("### headings, else list items, else table rows, else bold paragraphs", () => {
    expect(countLayerItems("## L4 — F\n\n### F1\n\ntext\n\n### F2\n\n1. a\n2. b\n")).toBe(2);
    expect(countLayerItems("## L1 — P\n\n1. **A.** x\n   continued\n2. **B.** y\n- c\n")).toBe(3);
    expect(countLayerItems("## L2 — M\n\n| Modelo | Uso |\n|---|---|\n| **a** | x |\n| **b** | y |\n| **c** | z |\n")).toBe(3);
    expect(countLayerItems("## L3 — H\n\n**H1 — one**\ntext\n\n**H2 — two**\ntext\n")).toBe(2);
    expect(countLayerItems("## L5 — M\n\nprose only\n")).toBe(0);
  });
});
