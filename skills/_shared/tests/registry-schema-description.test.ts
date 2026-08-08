// registry-schema-description.test.ts — routing-360 Phase 2.1 write-schemas.
//
// The registry indexers now emit routing-signal fields that were missing from
// the corpus: businesses emit `name` + `description`, squads emit a
// squad-level `description`. Both write-schemas are .strict(), so the fields
// MUST be declared or indexing fails at write time (businesses/lib/registry.ts
// validates with RegistryBusinessesSchema before writing).
//
// Runs with: bun test skills/_shared/tests
import { describe, expect, test } from "bun:test";
import { RegistryBusinessesSchema, RegistrySquadsSchema } from "../validators/validators.ts";

const bizRegistry = (entryExtra: Record<string, unknown>) => ({
  generated_at: "2026-08-05T12:00:00Z",
  businesses: {
    "fixture-biz": {
      version: "1.0.0",
      protocol: "1.0",
      manifest_path: "/x/business.yaml",
      manifest_hash: "sha256:" + "a".repeat(64),
      domains: ["testing"],
      capabilities: [],
      ...entryExtra,
    },
  },
});

const squadsRegistry = (entryExtra: Record<string, unknown>) => ({
  generated_at: "2026-08-05T12:00:00Z",
  host_protocol_version: "5.0" as const,
  squads_root_dirs: ["/x"],
  squads: {
    "fixture-squad": {
      version: "1.0.0",
      protocol: "5.0",
      manifest_path: "/x/squad.yaml",
      manifest_hash: "sha256:" + "b".repeat(64),
      domains: ["testing"],
      ...entryExtra,
    },
  },
  capabilities: {},
});

describe("RegistryBusinessesSchema — name + description (routing-360 Phase 2.1)", () => {
  test("accepts entries carrying name + description", () => {
    const r = RegistryBusinessesSchema.safeParse(bizRegistry({
      name: "fixture-biz",
      description: "A fixture business used to verify the registry write-schema.",
    }));
    expect(r.success).toBe(true);
  });

  test("both fields stay optional (legacy registries still validate)", () => {
    expect(RegistryBusinessesSchema.safeParse(bizRegistry({})).success).toBe(true);
  });

  test("stays strict — unknown entry fields are still rejected", () => {
    expect(RegistryBusinessesSchema.safeParse(bizRegistry({ bogus_field: "x" })).success).toBe(false);
  });
});

describe("RegistrySquadsSchema — squad-level description (routing-360 Phase 2.1)", () => {
  test("accepts squad entries carrying description", () => {
    const r = RegistrySquadsSchema.safeParse(squadsRegistry({
      description: "A fixture squad used to verify the registry write-schema.",
    }));
    expect(r.success).toBe(true);
  });

  test("description stays optional (legacy registries still validate)", () => {
    expect(RegistrySquadsSchema.safeParse(squadsRegistry({})).success).toBe(true);
  });

  test("stays strict — unknown entry fields are still rejected", () => {
    expect(RegistrySquadsSchema.safeParse(squadsRegistry({ bogus_field: "x" })).success).toBe(false);
  });
});

describe("RegistrySquadsSchema — squad-level discovery arrays (routing-360 Phase 2)", () => {
  test("accepts keywords + produces + example_briefs the registry already emits", () => {
    const r = RegistrySquadsSchema.safeParse(squadsRegistry({
      keywords: ["holding", "holding-patrimonial"],
      produces: ["holding-structure-design"],
      example_briefs: ["Estruture uma holding familiar para concentrar imóveis"],
    }));
    expect(r.success).toBe(true);
  });
});
