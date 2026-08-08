// registry-description.test.ts — businesses registry emits manifest name +
// description (routing-360 Phase 2.1). Before this, the registry entry emitter
// dropped `description`, so all businesses had no description in the registry
// and router.js's `b.description || ''` always read empty.
//
// Exercises the real CLI (`registry.ts rebuild`) over a temp-dir fixture, so
// it also proves the .strict() write-schema (RegistryBusinessesSchema) accepts
// the new fields — the rebuild validates before writing.
//
// Runs with: bun test skills/businesses/tests
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const REGISTRY_TS = path.join(import.meta.dir, "..", "lib", "registry.ts");

const DESCRIPTION = "A fixture business used to verify the registry emits the manifest description field.";

let tmp: string;
let root: string;
let output: string;
let result: ReturnType<typeof spawnSync>;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-biz-desc-"));
  root = path.join(tmp, "businesses");
  output = path.join(tmp, "registry.json");
  const biz = path.join(root, "fixture-biz");
  fs.mkdirSync(path.join(biz, "employees"), { recursive: true });
  fs.writeFileSync(path.join(biz, "business.yaml"), [
    "name: fixture-biz",
    "version: 1.0.0",
    'protocol: "1.0"',
    `description: ${DESCRIPTION}`,
    "domains:",
    "  - testing",
    "runtime_requirements:",
    "  minimum:",
    "    - runtime: claude-code",
    "",
  ].join("\n"));
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

  result = spawnSync(
    process.execPath,
    [REGISTRY_TS, "rebuild", "--roots", root, "--output", output, "--quiet"],
    { encoding: "utf8" },
  );
});

afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("businesses registry — name + description (routing-360 Phase 2.1)", () => {
  test("rebuild succeeds (write-schema accepts the new fields)", () => {
    expect(result.stderr || "").not.toContain("FAIL");
    expect(result.status).toBe(0);
    expect(fs.existsSync(output)).toBe(true);
  });

  test("registry entry carries the manifest description", () => {
    const reg = JSON.parse(fs.readFileSync(output, "utf8"));
    expect(reg.businesses["fixture-biz"].description).toBe(DESCRIPTION);
  });

  test("registry entry carries the manifest name", () => {
    const reg = JSON.parse(fs.readFileSync(output, "utf8"));
    expect(reg.businesses["fixture-biz"].name).toBe("fixture-biz");
  });
});
