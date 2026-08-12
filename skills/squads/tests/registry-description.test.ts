// registry-description.test.ts — squads registry emits squad-level description
// (routing-360 Phase 2.1). Before this, squad-level entries only carried
// {version, protocol, manifest_path, manifest_hash, domains, capabilities,
// keywords, produces, example_briefs} — the squad.yaml description never
// reached the corpus, so squad-level consumers (router, `nrv search`,
// concierge catalog) read `sq.description || ""` as always empty.
//
// Runs with: bun test skills/squads/tests
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const registry = require("../lib/registry.js");

let tmp: string;
let root: string;

const DESCRIPTION = "A fixture squad used to verify the registry emits the squad-level description field.";

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-sq-desc-"));
  root = path.join(tmp, "squads");
  fs.mkdirSync(path.join(root, "fixture-squad"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "fixture-squad", "squad.yaml"),
    [
      "name: fixture-squad",
      "version: 1.0.0",
      'protocol: "5.0"',
      `description: ${DESCRIPTION}`,
      "capabilities: []",
      "",
    ].join("\n"),
  );
  fs.mkdirSync(path.join(root, "no-desc-squad"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "no-desc-squad", "squad.yaml"),
    ["name: no-desc-squad", "version: 1.0.0", 'protocol: "5.0"', "capabilities: []", ""].join("\n"),
  );
  fs.mkdirSync(path.join(root, "long-desc-squad"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "long-desc-squad", "squad.yaml"),
    [
      "name: long-desc-squad",
      "version: 1.0.0",
      'protocol: "5.0"',
      `description: ${"x".repeat(2000)}`,
      "capabilities: []",
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("squads registry — squad-level description (routing-360 Phase 2.1)", () => {
  test("build() emits the squad.yaml description on the squad-level entry", () => {
    const reg = registry.build([root]);
    expect(reg.squads["fixture-squad"].description).toBe(DESCRIPTION);
  });

  test("missing description emits '' (same convention as capability entries)", () => {
    const reg = registry.build([root]);
    expect(reg.squads["no-desc-squad"].description).toBe("");
  });

  test("description is truncated at 1500 chars (registry payload discipline)", () => {
    const reg = registry.build([root]);
    expect(reg.squads["long-desc-squad"].description.length).toBe(1500);
  });
});
