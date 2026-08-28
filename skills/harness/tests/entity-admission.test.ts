/**
 * The admission bar: new content enters whole, or it does not enter.
 *
 * Every other pack gate asks a relational question — does a fence fire, does a
 * binding resolve, do copies agree. None reads the entity's OWN metadata, which
 * is how three clones with no `routing:` block walked into the flagship on
 * 2026-08-16: internally consistent, no previous state to regress from, every
 * gate green. This gate is the absolute bar for that slice, with the fence
 * gate's debt pattern: HARD problems always fail; metadata the validation
 * pipeline produces (verdict, source_material) is baselined — recorded debt may
 * only shrink, and an entity the baseline never saw enters complete.
 *
 * Every case here plants the defect and demands exit 1. That rule exists
 * because this gate's sibling spent its first day wired in without --strict,
 * printing 46% dead in red and exiting 0.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const GATE = join(REPO, "scripts", "check-entity-admission.ts");
const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) try { rmSync(r, { recursive: true, force: true }); } catch {} });

/** A minimal pack content dir. Every entity is complete unless the caller
 *  breaks it on purpose. */
function pack(mutate: (root: string) => void = () => {}): string {
  const root = mkdtempSync(join(tmpdir(), "admission-"));
  ROOTS.push(root);
  const clone = join(root, "mind-clones", "jane-doe");
  mkdirSync(clone, { recursive: true });
  writeFileSync(join(clone, "MANIFEST.yaml"), [
    "category: storytelling-narrative",
    "validation_verdict: APPROVED",
    "source_material:",
    "  primary: [a-book]",
    "routing:",
    '  one_liner: "Jane Doe — the choice for planted-fixture storytelling"',
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(clone, ".nirvana-surface.json"), "{}", "utf8");
  const squad = join(root, "squads", "one-squad");
  mkdirSync(squad, { recursive: true });
  writeFileSync(join(squad, "squad.yaml"), "name: one-squad\nversion: 1.0.0\n", "utf8");
  writeFileSync(join(squad, ".nirvana-surface.json"), "{}", "utf8");
  mutate(root);
  return root;
}

/** Run with a fixture baseline so the machine's is never read or written. */
function run(root: string, opts: { baseline?: Record<string, string[]>; record?: boolean } = {}) {
  const bl = join(root, "baseline.json");
  if (opts.baseline) writeFileSync(bl, JSON.stringify({ recorded_at: "test", entities: opts.baseline }), "utf8");
  const args = [GATE, "--pack", root, "--baseline", bl];
  if (opts.record) args.push("--record");
  const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("hard problems always fail", () => {
  test("a clone with no routing block does not enter", () => {
    const root = pack((r) => {
      writeFileSync(join(r, "mind-clones", "jane-doe", "MANIFEST.yaml"),
        "category: storytelling-narrative\nvalidation_verdict: APPROVED\nsource_material: {primary: [x]}\n", "utf8");
    });
    const r = run(root, { baseline: {} });
    expect(r.code).toBe(1);
    expect(r.out).toContain("no routing.one_liner");
  }, spawnBudgetMs(2));

  test("a numbered legacy category does not enter", () => {
    const root = pack((r) => {
      writeFileSync(join(r, "mind-clones", "jane-doe", "MANIFEST.yaml"), [
        "category: 06-storytelling-narrative",
        "validation_verdict: APPROVED",
        "source_material: {primary: [x]}",
        "routing:",
        '  one_liner: "Jane Doe — fixture"',
      ].join("\n"), "utf8");
    });
    const r = run(root, { baseline: {} });
    expect(r.code).toBe(1);
    expect(r.out).toContain("numbered legacy category");
  }, spawnBudgetMs(2));

  test("a missing surface file does not enter", () => {
    const root = pack((r) => rmSync(join(r, "squads", "one-squad", ".nirvana-surface.json")));
    const r = run(root, { baseline: {} });
    expect(r.code).toBe(1);
    expect(r.out).toContain("no .nirvana-surface.json");
  }, spawnBudgetMs(2));
});

describe("metadata debt is baselined — shrink only, and new content enters complete", () => {
  const noVerdict = (r: string) =>
    writeFileSync(join(r, "mind-clones", "jane-doe", "MANIFEST.yaml"), [
      "category: storytelling-narrative",
      "source_material: {primary: [x]}",
      "routing:",
      '  one_liner: "Jane Doe — fixture"',
    ].join("\n"), "utf8");

  test("a NEW clone missing validation_verdict does not enter", () => {
    const root = pack(noVerdict);
    const r = run(root, { baseline: {} });
    expect(r.code).toBe(1);
    expect(r.out).toContain("new content enters complete");
  }, spawnBudgetMs(2));

  test("the same gap on a BASELINED clone passes — recorded debt", () => {
    const root = pack(noVerdict);
    const r = run(root, { baseline: { "jane-doe": ["no_verdict"] } });
    expect(r.code).toBe(0);
    expect(r.out).toContain("recorded metadata debt");
  }, spawnBudgetMs(2));

  test("a NEW gap on a baselined clone still fails", () => {
    const root = pack((r) =>
      writeFileSync(join(r, "mind-clones", "jane-doe", "MANIFEST.yaml"), [
        "category: storytelling-narrative",
        "routing:",
        '  one_liner: "Jane Doe — fixture"',
      ].join("\n"), "utf8"));
    const r = run(root, { baseline: { "jane-doe": ["no_verdict"] } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("NEW gap on a known entity");
  }, spawnBudgetMs(2));

  test("--record refuses to add debt without --allow-regression", () => {
    const root = pack(noVerdict);
    const r = run(root, { baseline: {}, record: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain("would gain NEW debt");
  }, spawnBudgetMs(2));

  test("a clean pack passes, and no baseline at all refuses rather than approves", () => {
    expect(run(pack(), { baseline: {} }).code).toBe(0);
    const r = run(pack());
    expect(r.code).toBe(1);
    expect(r.out).toContain("No debt baseline recorded");
  }, spawnBudgetMs(2));
});
