// deprescribe-tasks.test.ts — §36: a task states its outcome; the steps section goes.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deprescribeRoots, deprescribeTask, descriptionIsWeak, OUTCOME_HEADING, OUTCOME_PLACEHOLDER } from "../scripts/deprescribe-tasks.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "deprescribe-tasks.ts");
const LEGACY = [
  "---", "name: collect", 'description: "Collect the account data into one dataset"', "---", "",
  "# Collect", "", "## Input", "The account id.", "", "## Steps", "1. Open the account.", "2. Export the rows.", "",
  "### Notes on step 2", "Use the CSV export.", "",
  "## Output", "dataset.json", "", "## Acceptance Criteria", "- dataset.json exists.", "",
].join("\n");

describe("deprescribeTask", () => {
  test("adds the outcome from the description before the first section and removes the steps whole", () => {
    const r = deprescribeTask(LEGACY)!;
    expect(r.outcome_added).toBe(true);
    expect(r.outcome_source).toBe("description");
    expect(r.steps_removed).toBe(true);
    expect(r.weak).toBe(false);
    expect(r.next).toContain(`# Collect\n\n${OUTCOME_HEADING}\nCollect the account data into one dataset.\n\n## Input`);
    expect(r.next).not.toMatch(/^## Steps/m);
    expect(r.next).not.toContain("Open the account");
    expect(r.next).not.toContain("Notes on step 2");
    // Nothing else moves.
    expect(r.next).toContain("## Input\nThe account id.\n\n## Output\ndataset.json\n\n## Acceptance Criteria\n- dataset.json exists.\n");
  });

  test("a task already at altitude is left alone", () => {
    const done = deprescribeTask(LEGACY)!.next;
    expect(deprescribeTask(done)).toBeNull();
  });

  test("a weak description falls back to the paragraph after the title, then to output plus criterion, then to the placeholder", () => {
    expect(descriptionIsWeak("")).toBe(true);
    expect(descriptionIsWeak("What this accomplishes")).toBe(true);
    expect(descriptionIsWeak("Gerar roadmap")).toBe(true);
    expect(descriptionIsWeak("Gerar roadmap de produto trimestral baseado em priorização")).toBe(false);

    const para = deprescribeTask("---\nname: x\ndescription: \"Short one\"\n---\n\n# X\n\nProduce the outline the writer needs.\nOne page.\n\n## Steps\n1. a\n")!;
    expect(para.outcome_source).toBe("title-paragraph");
    expect(para.weak).toBe(true);
    expect(para.next).toBe(`---\nname: x\ndescription: "Short one"\n---\n\n# X\n\nProduce the outline the writer needs.\nOne page.\n\n${OUTCOME_HEADING}\nProduce the outline the writer needs. One page.\n`);

    const out = deprescribeTask("---\nname: y\n---\n\n# Y\n\n## Steps\n1. a\n\n## Output\nA ranked list of ten suppliers at output/suppliers.md\n\n## Acceptance Criteria\n- Every supplier has a source\n")!;
    expect(out.outcome_source).toBe("output");
    expect(out.next).toContain(`${OUTCOME_HEADING}\nA ranked list of ten suppliers at output/suppliers.md. Done when: Every supplier has a source.\n\n## Output`);

    const ph = deprescribeTask("---\nname: z\n---\n\n# Z\n\n## Steps\n1. a\n")!;
    expect(ph.outcome_source).toBe("placeholder");
    expect(ph.next).toContain(`${OUTCOME_HEADING}\n${OUTCOME_PLACEHOLDER}\n`);
  });

  test("a trailing attribution comment survives the removal of a steps section that ends the file", () => {
    const wm = "[//]: # (BXfF73sSN-lZjJKKNyEHGt)";
    const src = `---\nname: w\ndescription: "Block a contact on the business account"\n---\n\n# W\n\n## Input\nid\n\n## Steps\n1. a\n2. b\n${wm}\n`;
    const r = deprescribeTask(src)!;
    expect(r.steps_removed).toBe(true);
    expect(r.next.trimEnd().endsWith(wm)).toBe(true);
    expect(r.next).not.toContain("1. a");
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
    expect(parsed.changed[0]).toMatchObject({ outcome_added: true, outcome_source: "description", steps_removed: true, weak: false });
    expect(parsed.applied).toBe(false);
    expect(readFileSync(join(root, "sq", "tasks", "collect.md"), "utf8")).toBe(LEGACY);

    const applied = deprescribeRoots([root], { apply: true });
    expect(applied.changed.length).toBe(1);
    expect(readFileSync(join(root, "sq", "tasks", "collect.md"), "utf8")).toContain(OUTCOME_HEADING);
    expect(readFileSync(join(root, "sq", "README.md"), "utf8")).toBe("## Steps\nnot a task\n");
    expect(deprescribeRoots([root], { apply: true }).changed.length).toBe(0);
  });

  test("the installed library is refused unless --include-library is passed", () => {
    const lib = mkdtempSync(join(tmpdir(), "fake-squads-")); roots.push(lib);
    mkdirSync(join(lib, "sq", "tasks"), { recursive: true });
    writeFileSync(join(lib, "sq", "tasks", "t.md"), LEGACY, "utf8");
    const env = { ...process.env, SQUADS_DIR: lib };
    const refused = spawnSync(process.execPath, [SCRIPT, lib], { encoding: "utf8", env });
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain("installed library");
    const allowed = spawnSync(process.execPath, [SCRIPT, lib, "--include-library", "--json"], { encoding: "utf8", env });
    expect(allowed.status).toBe(0);
    expect(JSON.parse(allowed.stdout).changed.length).toBe(1);
    expect(readFileSync(join(lib, "sq", "tasks", "t.md"), "utf8")).toBe(LEGACY);
  });
});
