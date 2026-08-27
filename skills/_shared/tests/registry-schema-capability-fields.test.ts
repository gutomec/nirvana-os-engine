// registry-schema-capability-fields.test.ts — the squads write-schema accepts
// the capability projection the indexer actually writes.
//
// `RegistrySquadsSchema.capabilities[]` is .strict(), and it had drifted behind
// `squads/lib/registry.js`: the indexer has been emitting produces, keywords,
// example_briefs and body_text for several cuts, and now also carries the
// contract, scheduling and v6 fields a capability declares. A strict schema that
// rejects the live registry is a gate that can only ever be switched off, so the
// declarations catch up here — all optional, so a registry written before any of
// this still validates.
//
// Runs with: bun test skills/_shared/tests
import { describe, expect, test } from "bun:test";
import { RegistrySquadsSchema } from "../validators/validators.ts";

const registryWith = (capExtra: Record<string, unknown>) => ({
  generated_at: "2026-08-27T12:00:00Z",
  host_protocol_version: "6.0" as const,
  squads_root_dirs: ["/x"],
  squads: {
    "fixture-squad": {
      version: "1.0.0",
      protocol: "6.0",
      manifest_path: "/x/squad.yaml",
      manifest_hash: "sha256:" + "b".repeat(64),
      domains: ["testing"],
    },
  },
  capabilities: {
    "fixture.rich.execute": [{
      squad: "fixture-squad",
      description: "Builds the fixture artifact end to end, from the brief to the rendered file.",
      domains: ["testing"],
      ...capExtra,
    }],
  },
});

const issues = (r: ReturnType<typeof RegistrySquadsSchema.safeParse>) =>
  r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);

describe("RegistrySquadsSchema — the discovery fields the indexer already wrote", () => {
  test("accepts produces, example_briefs, keywords and body_text on a capability entry", () => {
    const r = RegistrySquadsSchema.safeParse(registryWith({
      produces: ["fixture-artifact"],
      example_briefs: ["Build me the fixture artifact from this brief, rendered and ready"],
      keywords: ["fixture", "artefato de teste"],
      body_text: "The prose the capability executes, extracted at index time.",
    }));
    expect(issues(r)).toEqual([]);
  });
});

describe("RegistrySquadsSchema — the fields the registry stopped dropping", () => {
  test("accepts the contract and scheduling fields", () => {
    const r = RegistrySquadsSchema.safeParse(registryWith({
      inputs: [{ name: "brief_path", type: "file", formats: ["md"], required: true }],
      outputs: [{ name: "artifact", type: "file", format: "html" }],
      tools_required: ["Read", "Write"],
      model_hint: "opus",
      estimated_cost_usd: 4.25,
      parallel_safe: true,
      writes_paths: ["outputs/fixture/**"],
      contributions: [{
        into: "squad",
        at: "execute:pre",
        fragment: { inline: "Prefer the shortest path that satisfies the brief." },
      }],
      fidelity: { status: "validated", threshold: 0.92 },
    }));
    expect(issues(r)).toEqual([]);
  });

  test("accepts the v6 fields: acceptance, evaluator, requires, consumes", () => {
    const r = RegistrySquadsSchema.safeParse(registryWith({
      acceptance: [{ id: "renders-clean", description: "The artifact renders with no console error.", blocking: true, minimumScore: 0.9 }],
      evaluator: { scorecard: "fixture-scorecard", rubric: "fixture-rubric", dimensions: ["fidelity"], max_cost_usd: 1.5 },
      requires: ["other-squad:fixture.dep.execute"],
      consumes: ["upstream-artifact"],
    }));
    expect(issues(r)).toEqual([]);
  });

  test("every added field stays optional — a legacy entry still validates", () => {
    expect(RegistrySquadsSchema.safeParse(registryWith({})).success).toBe(true);
  });

  test("stays strict — an undeclared capability field is still rejected", () => {
    expect(RegistrySquadsSchema.safeParse(registryWith({ bogus_field: "x" })).success).toBe(false);
  });

  test("the added fields keep the manifest's shape — a malformed one is rejected", () => {
    expect(RegistrySquadsSchema.safeParse(registryWith({ estimated_cost_usd: -1 })).success).toBe(false);
    expect(RegistrySquadsSchema.safeParse(registryWith({ parallel_safe: "yes" })).success).toBe(false);
    expect(RegistrySquadsSchema.safeParse(registryWith({ evaluator: { rubric: "r" } })).success).toBe(false);
  });
});
