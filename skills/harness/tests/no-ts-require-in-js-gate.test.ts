// no-ts-require-in-js-gate.test.ts — scripts/check-no-ts-require-in-js.ts,
// exercised the same way engine-purity-run-artifacts.test.ts exercises its
// gate: spawn the real script, assert on its exit code, on a real tree and on
// a hermetic fixture tree.
//
// Two things this pins:
//   1. The CURRENT tree passes --strict (the fixed instances stay fixed).
//   2. A fresh `.js` requiring a `.ts`, and a fresh hand-rolled project-root
//      walk, are both DETECTED — the gate fails on a fixture that reproduces
//      each shape, and passes once the fixture is fixed the same way the real
//      files were (a .js sibling / delegating to project-root.js).
//
// Runs with: bun test skills/harness/tests
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempRoot } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const GATE = path.join(ROOT, "scripts", "check-no-ts-require-in-js.ts");

const runGate = (cwdOverrideScanDir?: string) =>
  spawnSync(process.execPath, [GATE, "--strict"], { encoding: "utf8", cwd: cwdOverrideScanDir ?? ROOT });

describe("check-no-ts-require-in-js.ts — the real engine tree", () => {
  test("the current tree passes --strict", () => {
    const result = runGate();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("no unlisted .js → .ts require() found");
    expect(result.stdout).toContain("no project-root walk found outside project-root.js");
  }, spawnBudgetMs(1));
});

// The gate scans `skills/` and `scripts/` relative to ITS OWN location
// (two levels up from scripts/check-no-ts-require-in-js.ts), so a fixture
// tree needs that same shape to be scanned at all: <fixture>/scripts/<gate>,
// <fixture>/skills/**. Copy the real gate script in rather than re-derive its
// scan roots — this test would otherwise silently stop proving anything the
// day the gate's own path arithmetic changes.
describe("check-no-ts-require-in-js.ts — detects a fresh instance of each class", () => {
  const roots: string[] = [];
  afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

  function fixtureTree(): { root: string; gate: string; skillsDir: string } {
    const root = makeTempRoot("nrv-ts-require-gate-");
    roots.push(root);
    const scriptsDir = path.join(root, "scripts");
    const skillsDir = path.join(root, "skills");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    const gate = path.join(scriptsDir, "check-no-ts-require-in-js.ts");
    fs.writeFileSync(gate, fs.readFileSync(GATE, "utf8"));
    return { root, gate, skillsDir };
  }

  test("a fresh `.js` requiring a `.ts` fails, and fixing it (a .js sibling) passes", () => {
    const { root, skillsDir } = fixtureTree();
    fs.writeFileSync(path.join(skillsDir, "victim.ts"), "export const x = 1;\n");
    const offender = path.join(skillsDir, "offender.js");
    fs.writeFileSync(offender, "const { x } = require(require('path').join(__dirname, 'victim.ts'));\nmodule.exports = { x };\n");

    const before = spawnSync(process.execPath, [path.join(root, "scripts", "check-no-ts-require-in-js.ts"), "--strict"], { encoding: "utf8", cwd: root });
    expect(before.status).toBe(1);
    expect(before.stdout).toContain("offender.js requires 'victim.ts'");

    fs.writeFileSync(offender, "const { x } = require(require('path').join(__dirname, 'victim.js'));\nmodule.exports = { x };\n");
    const after = spawnSync(process.execPath, [path.join(root, "scripts", "check-no-ts-require-in-js.ts"), "--strict"], { encoding: "utf8", cwd: root });
    expect(after.status, after.stdout + after.stderr).toBe(0);
  }, spawnBudgetMs(2));

  test("a fresh hand-rolled project-root walk fails, and delegating to project-root.js passes", () => {
    const { root, skillsDir } = fixtureTree();
    const offender = path.join(skillsDir, "walker.js");
    const handRolled = [
      "const fs = require('fs');",
      "const path = require('path');",
      "function findIt(start) {",
      "  let dir = start;",
      "  while (true) {",
      "    if (fs.existsSync(path.join(dir, '.nirvana'))) return dir;",
      "    const parent = path.dirname(dir);",
      "    if (parent === dir) return null;",
      "    dir = parent;",
      "  }",
      "}",
      "module.exports = { findIt };",
      "",
    ].join("\n");
    fs.writeFileSync(offender, handRolled);

    const before = spawnSync(process.execPath, [path.join(root, "scripts", "check-no-ts-require-in-js.ts"), "--strict"], { encoding: "utf8", cwd: root });
    expect(before.status).toBe(1);
    expect(before.stdout).toContain("walker.js");

    const delegated = [
      "const { findProjectRoot } = require('../../../project-root-stub.js');",
      "function findIt(start) { return findProjectRoot(start, { markers: ['.nirvana'] }); }",
      "module.exports = { findIt };",
      "",
    ].join("\n");
    fs.writeFileSync(offender, delegated);
    const after = spawnSync(process.execPath, [path.join(root, "scripts", "check-no-ts-require-in-js.ts"), "--strict"], { encoding: "utf8", cwd: root });
    expect(after.status, after.stdout + after.stderr).toBe(0);
  }, spawnBudgetMs(2));
});
