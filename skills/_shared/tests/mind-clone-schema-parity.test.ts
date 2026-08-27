// mind-clone-schema-parity.test.ts — MindCloneManifestSchema (Zod, executed)
// and mind-clone.schema.json (documentation mirror) name the same keys, the
// same enums, the same patterns and the same required fields. The JSON is
// read by no code path; this test is what keeps it honest.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MIND_CLONE_ARTIFACT_STATUS, MIND_CLONE_CATEGORY, MIND_CLONE_DNA_LAYER_KEYS, MIND_CLONE_VALIDATION_VERDICTS,
  MindCloneArtifactSchema, MindCloneDnaLayersSchema, MindCloneManifestSchema, MindCloneRoutingSchema, MindCloneScoresSchema,
} from "../validators/validators.ts";

const JSON_SCHEMA = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "schemas", "mind-clone.schema.json"), "utf8"));
const keys = (o: Record<string, unknown>) => Object.keys(o).sort();
const requiredOf = (shape: Record<string, any>) => Object.keys(shape).filter((k) => !shape[k].safeParse(undefined).success).sort();

describe("keys", () => {
  test("top level", () => {
    expect(keys(MindCloneManifestSchema.shape)).toEqual(keys(JSON_SCHEMA.properties));
    expect(requiredOf(MindCloneManifestSchema.shape)).toEqual([...JSON_SCHEMA.required].sort());
  });
  test("manifest", () => {
    const zod = (MindCloneManifestSchema.shape.manifest as any).shape;
    expect(keys(zod)).toEqual(keys(JSON_SCHEMA.properties.manifest.properties));
    expect(requiredOf(zod)).toEqual([...JSON_SCHEMA.properties.manifest.required].sort());
  });
  test("routing", () => {
    expect(keys(MindCloneRoutingSchema.shape)).toEqual(keys(JSON_SCHEMA.properties.routing.properties));
  });
  test("dna_layers", () => {
    expect(keys(MindCloneDnaLayersSchema.shape)).toEqual(keys(JSON_SCHEMA.properties.dna_layers.properties));
    expect(keys(MindCloneDnaLayersSchema.shape)).toEqual([...MIND_CLONE_DNA_LAYER_KEYS].sort());
  });
  test("scores", () => {
    expect(keys(MindCloneScoresSchema.shape)).toEqual(keys(JSON_SCHEMA.properties.scores.properties));
  });
  test("artifacts (array form)", () => {
    expect(keys(MindCloneArtifactSchema.shape)).toEqual(keys(JSON_SCHEMA.properties.artifacts.oneOf[0].items.properties));
  });
});

describe("enums and patterns", () => {
  test("validation_verdict enum, with the three live values", () => {
    expect([...MIND_CLONE_VALIDATION_VERDICTS]).toEqual(JSON_SCHEMA.properties.validation_verdict.enum);
    for (const v of ["ARCHETYPE_PERSONA", "EXTRACTED_FROM_PUBLIC_CORPUS", "PACKAGED_FROM_EXISTING_DOSSIER"]) expect(MIND_CLONE_VALIDATION_VERDICTS).toContain(v);
  });
  test("artifacts[].status enum", () => {
    expect([...MIND_CLONE_ARTIFACT_STATUS]).toEqual(JSON_SCHEMA.properties.artifacts.oneOf[0].items.properties.status.enum);
  });
  test("category is bare kebab-case in both", () => {
    expect(MIND_CLONE_CATEGORY.source).toBe(JSON_SCHEMA.properties.manifest.properties.category.pattern);
    expect(MindCloneManifestSchema.shape.manifest.safeParse({ name: "a-b", display_name: "A B", version: "1.0.0", category: "09-marketing" }).success).toBe(false);
    expect(MindCloneManifestSchema.shape.manifest.safeParse({ name: "a-b", display_name: "A B", version: "1.0.0", category: "marketing" }).success).toBe(true);
  });
  test("name and version patterns", () => {
    const m = MindCloneManifestSchema.shape.manifest;
    expect(m.safeParse({ name: "Bad Name", display_name: "A B", version: "1.0.0" }).success).toBe(false);
    expect(m.safeParse({ name: "ok-name", display_name: "A B", version: "1.0" }).success).toBe(false);
    expect(JSON_SCHEMA.properties.manifest.properties.name.pattern).toBe("^[a-z][a-z0-9-]{1,63}$");
  });
});

describe("tolerance", () => {
  test("delegates_to is tolerated, unknown keys pass, a malformed domain item fails at its path", () => {
    const base = { manifest: { name: "a-b", display_name: "A B", version: "1.0.0" }, artifacts: [{ path: "agent/AGENT.md" }] };
    expect(MindCloneManifestSchema.safeParse({ ...base, routing: { delegates_to: ["x"] }, key_quotes: ["q"] }).success).toBe(true);
    const bad = MindCloneManifestSchema.safeParse({ ...base, routing: { domains: ["ok", { colon: "trap" }] } });
    expect(bad.success).toBe(false);
    expect(bad.success ? [] : bad.error.issues.map((i) => i.path.join("."))).toEqual(["routing.domains.1"]);
    const verdict = MindCloneManifestSchema.safeParse({ ...base, validation_verdict: "MAYBE" });
    expect(verdict.success ? [] : verdict.error.issues.map((i) => i.path.join("."))).toEqual(["validation_verdict"]);
  });
});
