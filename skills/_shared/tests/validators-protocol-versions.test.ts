/**
 * The executed validators accept Squad Protocol 6.0 and Business Protocol 2.0
 * before any content declares them.
 *
 * `validators.ts` is the only validator that runs (`capability-validator.js`
 * requires it; `validate-squad` spawns that). Until this cut a manifest with
 * `protocol: "6.0"` failed there, so `build-all-packs.sh` would go FATAL on
 * the first v6 squad. The fields the following cuts will author are accepted
 * as optional and bounded, and nothing reads them yet: a v5 manifest parses to
 * the same object it parsed to before, with no new key injected.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  BusinessManifestSchema, CapabilitySchema, EmployeeFrontmatterSchema,
  RegistryBusinessesSchema, RegistrySquadsSchema, SquadManifestSchema,
} from "../validators/validators.ts";
import { businessV1, businessV2, tmpRoot, v5StepsSquad, v6MarkdownSquad } from "./fixtures/protocol-entities.ts";

const ROOTS: string[] = [];
function root(): string { const r = tmpRoot(); ROOTS.push(r); return r; }
afterAll(() => { for (const r of ROOTS) try { rmSync(r, { recursive: true, force: true }); } catch {} });

const manifest = (dir: string, file: string) => parseYaml(readFileSync(join(dir, file), "utf8"));
const frontmatter = (file: string) => parseYaml(/^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"))![1]);
const issues = (r: { success: boolean; error?: any }) =>
  r.success ? [] : r.error.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`);

describe("squad manifests", () => {
  test("protocol 6.0 passes; 4.0, 4.1 and 5.0 keep passing; 7.0 fails", () => {
    const v6 = manifest(v6MarkdownSquad(root()), "squad.yaml");
    expect(issues(SquadManifestSchema.safeParse(v6))).toEqual([]);
    const v5 = manifest(v5StepsSquad(root()), "squad.yaml");
    for (const p of ["4.0", "4.1", "5.0"]) expect(SquadManifestSchema.safeParse({ ...v5, protocol: p }).success).toBe(true);
    expect(SquadManifestSchema.safeParse({ ...v5, protocol: "7.0" }).success).toBe(false);
  });

  test("a v5 capability parses to the same object as before: no v6 key is injected", () => {
    const cap = manifest(v5StepsSquad(root()), "squad.yaml").capabilities[0];
    const parsed = CapabilitySchema.parse(cap);
    for (const k of ["acceptance", "evaluator", "requires", "consumes"]) expect(k in parsed).toBe(false);
  });

  test("the v6 capability fields are optional and bounded, and mean nothing yet", () => {
    const base = manifest(v6MarkdownSquad(root()), "squad.yaml").capabilities[0];
    expect(issues(CapabilitySchema.safeParse(base))).toEqual([]);
    const ok = (patch: Record<string, unknown>) => CapabilitySchema.safeParse({ ...base, ...patch }).success;
    const acceptance = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `req_${i}`, description: `requirement ${i}` }));
    expect(ok({ acceptance: acceptance(12) })).toBe(true);
    expect(ok({ acceptance: acceptance(13) })).toBe(false);
    expect(ok({ acceptance: [{ id: "Bad Id", description: "x" }] })).toBe(false);
    expect(ok({ acceptance: [{ id: "ok", description: "x", minimumScore: 1.5 }] })).toBe(false);
    expect(ok({ evaluator: { scorecard: "scorecards/x.json", rubric: "rubrics/x.md", dimensions: ["a"], max_cost_usd: 2 } })).toBe(true);
    expect(ok({ evaluator: { scorecard: "s", rubric: "r", unknown: 1 } })).toBe(false);
    expect(ok({ evaluator: { scorecard: "s", rubric: "r", max_cost_usd: -1 } })).toBe(false);
    expect(ok({ requires: ["fixture.beta.run", "other-squad:fixture.beta.run"] })).toBe(true);
    expect(ok({ requires: ["not an id"] })).toBe(false);
    expect(ok({ requires: Array.from({ length: 9 }, (_, i) => `fixture.beta.run_${i}`) })).toBe(false);
    expect(ok({ consumes: ["beta_artifact"] })).toBe(true);
    expect(ok({ consumes: Array.from({ length: 21 }, (_, i) => `artifact_${i}`) })).toBe(false);
  });
});

describe("business manifests and employees", () => {
  test("protocol 1.0 fixture passes; 2.0 with its new fields passes; 3.0 fails", () => {
    const v1 = manifest(businessV1(root()), "business.yaml");
    expect(issues(BusinessManifestSchema.safeParse(v1))).toEqual([]);
    const v2 = manifest(businessV2(root()), "business.yaml");
    expect(issues(BusinessManifestSchema.safeParse(v2))).toEqual([]);
    expect(BusinessManifestSchema.safeParse({ ...v2, protocol: "3.0" }).success).toBe(false);
    expect(BusinessManifestSchema.safeParse({ ...v2, run_budget_usd: -1 }).success).toBe(false);
    expect(BusinessManifestSchema.safeParse({ ...v2, squads_preferred: ["Not Kebab"] }).success).toBe(false);
  });

  test("employee v2: pinned_mind_clones (max 2), squads_preferred and acceptance; a v1 employee gains no key", () => {
    const v2 = frontmatter(join(businessV2(root()), "employees", "intake.md"));
    expect(issues(EmployeeFrontmatterSchema.safeParse(v2))).toEqual([]);
    expect(EmployeeFrontmatterSchema.safeParse({ ...v2, pinned_mind_clones: ["a", "b", "c"] }).success).toBe(false);
    expect(EmployeeFrontmatterSchema.safeParse({ ...v2, acceptance: [{ id: "Bad Id", description: "x" }] }).success).toBe(false);
    expect(EmployeeFrontmatterSchema.safeParse({ ...v2, acceptance: [{ id: "ok", description: "x", min_bytes: -1 }] }).success).toBe(false);
    const v1 = EmployeeFrontmatterSchema.parse(frontmatter(join(businessV1(root()), "employees", "intake.md")));
    for (const k of ["pinned_mind_clones", "squads_preferred", "acceptance"]) expect(k in v1).toBe(false);
  });
});

describe("registries", () => {
  const HASH = `sha256:${"a".repeat(64)}`;

  test("the businesses registry accepts protocol 2.0 and still rejects 3.0", () => {
    const registry = (protocol: string) => ({
      generated_at: "2026-08-26T00:00:00.000Z",
      businesses: { "fixture-biz": { version: "1.0.0", protocol, manifest_path: "/x/business.yaml", manifest_hash: HASH, domains: ["fixture_domain"], capabilities: [] } },
    });
    expect(issues(RegistryBusinessesSchema.safeParse(registry("1.0")))).toEqual([]);
    expect(issues(RegistryBusinessesSchema.safeParse(registry("2.0")))).toEqual([]);
    expect(RegistryBusinessesSchema.safeParse(registry("3.0")).success).toBe(false);
  });

  test("the squads registry accepts host_protocol_version 6.0", () => {
    const registry = (host: string) => ({
      generated_at: "2026-08-26T00:00:00.000Z", host_protocol_version: host, squads_root_dirs: [], squads: {}, capabilities: {},
    });
    expect(issues(RegistrySquadsSchema.safeParse(registry("5.0")))).toEqual([]);
    expect(issues(RegistrySquadsSchema.safeParse(registry("6.0")))).toEqual([]);
  });

  test("core-schemas.json mirrors the enums", () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dir, "..", "schemas", "core-schemas.json"), "utf8"));
    const enums: Record<string, string[][]> = { host_protocol_version: [], protocol: [] };
    const walk = (node: any) => {
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        if (k in enums && v && typeof v === "object" && Array.isArray((v as any).enum)) enums[k].push((v as any).enum);
        walk(v);
      }
    };
    walk(schema);
    expect(enums.host_protocol_version.some((e) => e.includes("6.0"))).toBe(true);
    expect(enums.protocol.some((e) => e.includes("1.0") && e.includes("2.0"))).toBe(true);
  });
});
