// deprescribe-tasks.test.ts — §36: a task states its outcome; steps become reference.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deprescribeRoots, deprescribeTask, OUTCOME_HEADING, STEPS_REFERENCE_HEADING } from "../scripts/deprescribe-tasks.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "deprescribe-tasks.ts");
const LEGACY = [
  "---", "name: collect", 'description: "Collect the account data into one dataset"', "---", "",
  "# Collect", "", "## Input", "The account id.", "", "## Steps", "1. Open the account.", "2. Export the rows.", "",
  "## Output", "dataset.json", "", "## Acceptance Criteria", "- dataset.json exists.", "",
].join("\n");

describe("deprescribeTask", () => {
  test("adds the outcome from the description before the first section and relabels the steps", () => {
    const r = deprescribeTask(LEGACY)!;
    expect(r.outcome_added).toBe(true);
    expect(r.steps_relabelled).toBe(true);
    expect(r.next).toContain(`# Collect\n\n${OUTCOME_HEADING}\nCollect the account data into one dataset.\n\n## Input`);
    expect(r.next).toContain(STEPS_REFERENCE_HEADING);
    expect(r.next).not.toMatch(/^## Steps\s*$/m);
    // Nothing else moves.
    expect(r.next).toContain("1. Open the account.\n2. Export the rows.");
    expect(r.next).toContain("## Acceptance Criteria\n- dataset.json exists.");
  });

  test("a task already at altitude is left alone", () => {
    const done = deprescribeTask(LEGACY)!.next;
    expect(deprescribeTask(done)).toBeNull();
  });

  test("without a description, the first paragraph after the title is the outcome", () => {
    const src = "---\nname: x\n---\n\n# X\n\nProduce the outline the writer needs.\nOne page.\n\n## Steps\n1. a\n";
    const r = deprescribeTask(src)!;
    expect(r.next).toContain(`${OUTCOME_HEADING}\nProduce the outline the writer needs. One page.\n\n${STEPS_REFERENCE_HEADING}`);
  });
});

describe("the CLI", () => {
  const roots: string[] = [];
  afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

  function scaffold(): string {
    const root = mkdtempSync(join(tmpdir(), "deprescribe-")); roots.push(root);
    mkdirSync(join(root, "sq", "tasks"), { recursive: true });
    writeFileSync(join(root, "sq", "tasks", "collect.md"), LEGACY, "utf8");
    writeFileSync(join(root, "sq", "README.md"), "## Steps\nnot a task\n", "utf8");
    return root;
  }

  test("reports without writing; --apply writes; the run is idempotent", () => {
    const root = scaffold();
    const report = spawnSync(process.execPath, [SCRIPT, root, "--json"], { encoding: "utf8" });
    expect(report.status).toBe(0);
    const parsed = JSON.parse(report.stdout);
    expect(parsed.scanned).toBe(1);
    expect(parsed.changed.length).toBe(1);
    expect(parsed.applied).toBe(false);
    expect(readFileSync(join(root, "sq", "tasks", "collect.md"), "utf8")).toBe(LEGACY);

    const applied = deprescribeRoots([root], { apply: true });
    expect(applied.changed.length).toBe(1);
    expect(readFileSync(join(root, "sq", "tasks", "collect.md"), "utf8")).toContain(OUTCOME_HEADING);
    expect(readFileSync(join(root, "sq", "README.md"), "utf8")).toBe("## Steps\nnot a task\n");
    expect(deprescribeRoots([root], { apply: true }).changed.length).toBe(0);
  });

  test("the installed library is refused", () => {
    const lib = mkdtempSync(join(tmpdir(), "fake-squads-")); roots.push(lib);
    const r = spawnSync(process.execPath, [SCRIPT, lib], { encoding: "utf8", env: { ...process.env, SQUADS_DIR: lib } });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("installed library");
  });
});
