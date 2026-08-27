// registry-description.test.ts — what the businesses registry emits, and what
// the router therefore gets to see.
//
// Two waves of the same defect class. First (routing-360 Phase 2.1): the entry
// emitter dropped `description`, so `router.js`'s `b.description || ''` read
// empty for every business. Second (Business Protocol 2.0): `not_for` was
// declared by five live businesses and dropped the same way — `ScanItem` had no
// field and `RegistryBusinessesSchema` is `.strict()`, so the only exclusion
// lever BM25 has never reached the router for a business at all.
//
// Exercises the real CLI (`registry.ts rebuild`) over a temp-dir fixture, so it
// also proves the strict write-schema accepts the emitted shape — the rebuild
// validates before writing — and that a `protocol: "2.0"` manifest indexes
// instead of throwing.
//
// Runs with: bun test skills/businesses/tests
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require_ = createRequire(import.meta.url);
const REGISTRY_TS = path.join(import.meta.dir, "..", "lib", "registry.ts");
const router = require_(path.join(import.meta.dir, "..", "..", "harness", "lib", "router.js"));

const DESCRIPTION = "A fixture business used to verify the registry emits the manifest description field.";
const V2_DESCRIPTION = "A Protocol 2.0 fixture business that declares routing fences and a per-run budget.";
const NOT_FOR = ["legal advice", "tax filing"];

let tmp: string;
let root: string;
let output: string;
let result: ReturnType<typeof spawnSync>;
let registry: Record<string, any>;

/** A loadable business: manifest + one intake employee + a canonical org-chart. */
function writeBusiness(slug: string, manifestLines: string[]): void {
  const biz = path.join(root, slug);
  fs.mkdirSync(path.join(biz, "employees"), { recursive: true });
  fs.writeFileSync(path.join(biz, "business.yaml"), manifestLines.join("\n") + "\n");
  fs.writeFileSync(path.join(biz, "org-chart.yaml"), [
    "chart:",
    "  - employee: ceo",
    "    reports: []",
    "    direct_reports: []",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(biz, "employees", "ceo.md"), [
    "---",
    "name: ceo",
    "role: Chief executive",
    "description: Receives every brief and produces the fixture output for registry emission tests.",
    "is_brief_intake: true",
    "---",
    "",
    "Fixture employee body.",
    "",
  ].join("\n"));
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-biz-desc-"));
  root = path.join(tmp, "businesses");
  output = path.join(tmp, "registry.json");

  writeBusiness("fixture-biz", [
    "name: fixture-biz",
    "version: 1.0.0",
    'protocol: "1.0"',
    `description: ${DESCRIPTION}`,
    "domains:",
    "  - testing",
    "runtime_requirements:",
    "  minimum:",
    "    - runtime: claude-code",
  ]);

  // Protocol 2.0, with the fields this cut teaches the registry to carry.
  writeBusiness("fixture-biz-v2", [
    "name: fixture-biz-v2",
    "version: 1.0.0",
    'protocol: "2.0"',
    `description: ${V2_DESCRIPTION}`,
    "domains:",
    "  - testing",
    "not_for:",
    ...NOT_FOR.map((n) => `  - ${n}`),
    "squads_preferred:",
    "  - fixture-alpha",
    "run_budget_usd: 5",
    "runtime_requirements:",
    "  minimum:",
    "    - runtime: claude-code",
  ]);

  result = spawnSync(
    process.execPath,
    [REGISTRY_TS, "rebuild", "--roots", root, "--output", output, "--quiet"],
    { encoding: "utf8" },
  );
  if (result.status === 0) registry = JSON.parse(fs.readFileSync(output, "utf8"));
});

afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("businesses registry — name + description (routing-360 Phase 2.1)", () => {
  test("rebuild succeeds (write-schema accepts the emitted shape)", () => {
    expect(result.stderr || "").not.toContain("FAIL");
    expect(result.status).toBe(0);
    expect(fs.existsSync(output)).toBe(true);
  });

  test("registry entry carries the manifest description", () => {
    expect(registry.businesses["fixture-biz"].description).toBe(DESCRIPTION);
  });

  test("registry entry carries the manifest name", () => {
    expect(registry.businesses["fixture-biz"].name).toBe("fixture-biz");
  });
});

describe("businesses registry — Business Protocol 2.0", () => {
  test("a v1 and a v2 business load and index side by side", () => {
    expect(registry.businesses["fixture-biz"].protocol).toBe("1.0");
    expect(registry.businesses["fixture-biz-v2"].protocol).toBe("2.0");
    expect(registry._invalid_entries).toBeUndefined();
  });

  test("business not_for reaches the registry", () => {
    expect(registry.businesses["fixture-biz-v2"].not_for).toEqual(NOT_FOR);
  });

  test("a business without not_for gains no empty key", () => {
    expect("not_for" in registry.businesses["fixture-biz"]).toBe(false);
  });

  test("not_for reaches the router's business doc meta", () => {
    const docs = router.buildMatchDocs(null, registry);
    const v2 = docs.find((d: { id: string }) => d.id === "business:fixture-biz-v2");
    const v1 = docs.find((d: { id: string }) => d.id === "business:fixture-biz");
    expect(v2.meta.not_for).toEqual(NOT_FOR);
    expect(v1.meta.not_for).toEqual([]);
  });

  test("not_for stays out of the indexed text — it is a fence, not vocabulary", () => {
    const docs = router.buildMatchDocs(null, registry);
    const v2 = docs.find((d: { id: string }) => d.id === "business:fixture-biz-v2");
    expect(v2.text).not.toContain("tax filing");
  });
});
