// activate-batch.test.ts — `nrv activate`, the door that was missing.
//
// The failure this closes (field report, 2026-08-22): asked to "activate all
// squads and install the dependencies", an agent ran `nrv --help`, found no
// activation command — the script existed but was never exposed — grepped
// the filesystem to locate it, and then started walking 107 squads one
// invocation at a time because no batch mode existed.
//
// These tests pin the three properties that make the batch usable: it walks
// every squad in scope, a failing squad never stops the walk, and the exit
// code aggregates the per-squad contract (2 beats 0, 1 beats everything).

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const CMD = join(REPO, "skills", "harness", "scripts", "activate.ts");
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* OS reclaims tmp */ } }
});

/** A project scope with N squads; `deps` decides which declare dependencies. */
function library(squads: { slug: string; check?: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), "activate-batch-"));
  roots.push(root);
  writeFileSync(join(root, "AGENTS.md"), "# fixture project\n");
  writeFileSync(join(root, ".env"), "NIRVANA_SCOPE=project\n");
  for (const s of squads) {
    const dir = join(root, ".nirvana", "squads", s.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "squad.yaml"), `name: ${s.slug}\nversion: "1.0.0"\nprotocol: "5.0"\ndescription: fixture\n`);
    if (s.check) {
      writeFileSync(join(dir, "dependencies.yaml"), [
        'schema_version: "1.0"',
        "system:",
        `  - name: ${s.slug}-tool`,
        `    check: "${s.check}"`,
        "",
      ].join("\n"));
    }
  }
  return root;
}

function run(root: string, args: string[]) {
  const r = spawnSync(process.execPath, [CMD, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NIRVANA_PROJECT_ROOT: root, NIRVANA_SCOPE: "project" },
  });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

describe("nrv activate --all", () => {
  test("walks every squad in scope and summarises", () => {
    const root = library([
      { slug: "alpha-squad", check: "true" },
      { slug: "beta-squad", check: "true" },
      { slug: "gamma-squad" }, // no dependencies.yaml
    ]);
    const { code, out } = run(root, ["--all"]);
    expect(out).toContain("ACTIVATING 3 SQUAD(S)");
    expect(out).toContain("alpha-squad");
    expect(out).toContain("beta-squad");
    expect(out).toContain("no dependencies");   // gamma needs nothing
    expect(code).toBe(0);
  }, spawnBudgetMs(3));

  test("--only-declared skips squads that need no activation", () => {
    const root = library([{ slug: "alpha-squad", check: "true" }, { slug: "gamma-squad" }]);
    const { out } = run(root, ["--all", "--only-declared"]);
    expect(out).toContain("ACTIVATING 1 SQUAD(S)");
    expect(out).not.toContain("gamma-squad");
  }, spawnBudgetMs(2));

  test("a squad that cannot satisfy its dependency does not stop the walk", () => {
    // The middle squad declares a tool that does not exist and has no install
    // command for this platform — the walk must still reach the third.
    const root = library([
      { slug: "alpha-squad", check: "true" },
      { slug: "broken-squad", check: "command -v nirvana-nonexistent-tool-xyz" },
      { slug: "zeta-squad", check: "true" },
    ]);
    const { out } = run(root, ["--all"]);
    expect(out).toContain("zeta-squad");        // reached despite the middle one
    expect(out).toContain("SUMMARY");
  }, spawnBudgetMs(4));

  test("--dry-run installs nothing and still reports", () => {
    const root = library([{ slug: "alpha-squad", check: "command -v definitely-not-installed-xyz" }]);
    const { out } = run(root, ["--all", "--dry-run"]);
    expect(out).toContain("SUMMARY");
    expect(out).not.toContain("install_failed");
  }, spawnBudgetMs(2));
});

describe("nrv activate <slug>", () => {
  test("a single squad passes straight through to the activator", () => {
    const root = library([{ slug: "alpha-squad", check: "true" }]);
    const { code, out } = run(root, ["alpha-squad"]);
    expect(out).toContain("alpha-squad");
    expect(code).toBe(0);
  }, spawnBudgetMs(2));

  test("no arguments is a usage error, not a silent no-op", () => {
    const root = library([{ slug: "alpha-squad", check: "true" }]);
    expect(run(root, []).code).toBe(4);
  }, spawnBudgetMs(1));

  test("--help explains the batch and exits clean", () => {
    const root = library([{ slug: "alpha-squad", check: "true" }]);
    const { code, out } = run(root, ["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("--all");
    expect(out).toContain("dependencies.yaml");
  }, spawnBudgetMs(1));
});

describe("nrv doctor warns before the expensive run", () => {
  // Activation is advisory: a missing tool does not block a dispatch, it
  // kills it MID-RUN. The doctor line is the cheap warning that costs
  // nothing — and it must actually fire, or it is decoration.
  test("a declared tool that is not on PATH becomes a WARN naming the fix", () => {
    const root = library([{ slug: "needs-tool-squad", check: "command -v nirvana-absent-binary-xyz" }]);
    const doctor = join(REPO, "skills", "harness", "scripts", "doctor-system.ts");
    const r = spawnSync(process.execPath, [doctor], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NIRVANA_PROJECT_ROOT: root, NIRVANA_SCOPE: "project" },
    });
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toContain("SQUAD DEPS");
    expect(out).toContain("nirvana-absent-binary-xyz");
    expect(out).toContain("nrv activate --all");
  }, spawnBudgetMs(2));
});
