// verify-backup.test.ts — the --fix loop keeps the entity safe: a backup
// before any fixer runs, rollback when a fixer throws, when the manifest
// stops parsing or when a NEW error appears, byte-identical restore, a no-op
// second run, and five backups kept per entity.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BACKUP_KEEP, createBackup, listBackups, mindCloneModule, verifyEntity, type KindModule } from "../lib/verify/index.ts";
import { cloneFixture, rmrf, runCli, tempRoot, treeDigest } from "./helpers/verify-fixture.ts";

const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) rmrf(r); });
function root(): string { const r = tempRoot(); ROOTS.push(r); return r; }

const quiet = (r: string) => ({ retrieval: false, baselinePath: null, stateDir: null, emit: null, backupRoot: path.join(r, "backups") } as const);

/** The mind-clone module with one fixer swapped for a saboteur. */
function sabotaged(fixer: string, impl: KindModule["fixers"][string]): KindModule {
  return { ...mindCloneModule, fixers: { ...mindCloneModule.fixers, [fixer]: impl } };
}

describe("backup", () => {
  test("a backup holds the pre-fix bytes and lives under <root>/<kind>/<slug>.<ts>", async () => {
    const r = root();
    const dir = cloneFixture(r, "jane-doe", { routing: { delegates_to: ["someone"] } });
    const before = treeDigest(dir);
    const report = await verifyEntity("mind-clone", dir, { ...quiet(r), fix: "mechanical" });
    expect(report.fix_outcome?.rolled_back).toBe(false);
    expect(report.fixes.find((f) => f.fixer === "delegates_to_strip")?.applied).toBe(true);
    const backups = listBackups("mind-clone", "jane-doe", path.join(r, "backups"));
    expect(backups.length).toBe(1);
    expect(backups[0]).toStartWith(path.join(r, "backups", "mind-clone", "jane-doe."));
    expect(treeDigest(backups[0])).toEqual(before);
    expect(treeDigest(dir)).not.toEqual(before);
    expect(fs.readFileSync(path.join(dir, "MANIFEST.yaml"), "utf8")).not.toContain("delegates_to");
  });

  test("no fixer to run → no backup", async () => {
    const r = root();
    const dir = cloneFixture(r, "jane-doe");
    const report = await verifyEntity("mind-clone", dir, { ...quiet(r), fix: "mechanical" });
    expect(report.fix_outcome).toMatchObject({ mode: "mechanical", backup: null, rolled_back: false });
    expect(listBackups("mind-clone", "jane-doe", path.join(r, "backups"))).toEqual([]);
  });
});

describe("rollback", () => {
  test("a fixer that throws rolls the entity back byte for byte", async () => {
    const r = root();
    const dir = cloneFixture(r, "jane-doe", { routing: { delegates_to: ["x"] } });
    const before = treeDigest(dir);
    const module = sabotaged("delegates_to_strip", ({ dir: d }) => {
      fs.writeFileSync(path.join(d, "agent", "SOUL.md"), "", "utf8");
      throw new Error("boom");
    });
    const report = await verifyEntity("mind-clone", dir, { ...quiet(r), fix: "mechanical", module });
    expect(report.fix_outcome?.rolled_back).toBe(true);
    expect(report.fix_outcome?.rollback_reason).toContain("boom");
    expect(treeDigest(dir)).toEqual(before);
    expect(report.exit_code).toBe(0);
  });

  test("a fixer that breaks the manifest rolls back", async () => {
    const r = root();
    const dir = cloneFixture(r, "jane-doe", { routing: { delegates_to: ["x"] } });
    const before = treeDigest(dir);
    const module = sabotaged("delegates_to_strip", ({ dir: d, finding }) => {
      fs.writeFileSync(path.join(d, "MANIFEST.yaml"), "manifest: [unclosed\n", "utf8");
      return { fixer: "delegates_to_strip", finding: finding.id, applied: true, changed_files: ["MANIFEST.yaml"] };
    });
    const report = await verifyEntity("mind-clone", dir, { ...quiet(r), fix: "mechanical", module });
    expect(report.fix_outcome?.rolled_back).toBe(true);
    expect(report.fix_outcome?.rollback_reason).toContain("manifest");
    expect(treeDigest(dir)).toEqual(before);
    expect(report.findings.map((f) => f.id)).not.toContain("manifest_parse");
  });

  test("a NEW error after the fixers rolls back; an error that was already there does not", async () => {
    const r = root();
    const dir = cloneFixture(r, "jane-doe", { routing: { delegates_to: ["x"] } });
    const before = treeDigest(dir);
    const deletesSoul = sabotaged("delegates_to_strip", ({ dir: d, finding }) => {
      fs.rmSync(path.join(d, "agent", "SOUL.md"));
      return { fixer: "delegates_to_strip", finding: finding.id, applied: true, changed_files: ["agent/SOUL.md"] };
    });
    const rolled = await verifyEntity("mind-clone", dir, { ...quiet(r), fix: "mechanical", module: deletesSoul });
    expect(rolled.fix_outcome?.rolled_back).toBe(true);
    expect(rolled.fix_outcome?.rollback_reason).toContain("artifact_missing:agent/SOUL.md");
    expect(treeDigest(dir)).toEqual(before);

    // pre-existing error: the strip still lands and the error stays reported
    fs.rmSync(path.join(dir, "agent", "DNA-CONFIG.yaml"));
    const kept = await verifyEntity("mind-clone", dir, { ...quiet(r), fix: "mechanical" });
    expect(kept.fix_outcome?.rolled_back).toBe(false);
    expect(kept.summary.errors).toBe(1);
    expect(fs.readFileSync(path.join(dir, "MANIFEST.yaml"), "utf8")).not.toContain("delegates_to");
  });
});

describe("idempotence and retention", () => {
  test("the second --fix run applies nothing and changes no byte", () => {
    const r = root();
    const dir = cloneFixture(r, "jane-doe", { category: "09-marketing", name: "someone-else", dnaLayers: { L1_philosophies: 9 }, routing: { delegates_to: ["x"] }, artifacts: [
      { path: "agent/AGENT.md", status: "missing" }, { path: "agent/SOUL.md", status: "present" }, { path: "agent/DNA-CONFIG.yaml" }, { path: "dna/dna-schema.md", status: "present" },
    ] });
    const first = runCli(r, ["mind-clone", dir, "--fix", "--json", "--no-retrieval"]);
    expect(first.code).toBe(0);
    const applied = first.json.fixes.filter((f: any) => f.applied).map((f: any) => f.fixer).sort();
    expect(applied).toEqual(["artifacts_status_sync", "category_bare", "delegates_to_strip", "dna_layers_sync", "manifest_name_sync", "surface_regen"]);
    const manifest = fs.readFileSync(path.join(dir, "MANIFEST.yaml"), "utf8");
    expect(manifest).toContain("# fixture manifest — this comment must survive a --fix");
    expect(manifest).toContain("  category: marketing");
    expect(manifest).toContain("  name: jane-doe");
    expect(manifest).toContain("  L1_philosophies: 3");
    const after = treeDigest(dir);
    const second = runCli(r, ["mind-clone", dir, "--fix", "--json", "--no-retrieval"]);
    expect(second.code).toBe(0);
    expect(second.json.fixes.filter((f: any) => f.applied)).toEqual([]);
    expect(second.json.fix_outcome.backup).toBeNull();
    expect(treeDigest(dir)).toEqual(after);
  });

  test(`only the newest ${BACKUP_KEEP} backups of an entity are kept`, () => {
    const r = root();
    const dir = cloneFixture(r, "jane-doe");
    const made: string[] = [];
    for (let i = 0; i < BACKUP_KEEP + 2; i++) made.push(createBackup(dir, "mind-clone", "jane-doe", path.join(r, "backups")));
    const kept = listBackups("mind-clone", "jane-doe", path.join(r, "backups"));
    expect(kept.length).toBe(BACKUP_KEEP);
    expect(kept).toEqual(made.slice(-BACKUP_KEEP));
    expect(fs.existsSync(made[0])).toBe(false);
  });
});
