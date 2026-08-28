/**
 * migrate-squad.test.ts — `nrv migrate <slug> --to 6`.
 *
 * The corpus is one squad per workflow dialect measured in the library, plus
 * the two documents the migration must NOT convert: the twin (`x.md` +
 * `x.yaml`, which is a merge) and `event_routes` (which is a router, not a
 * DAG). Four properties are asserted for every one of them, because they are
 * the whole safety argument of a command that rewrites a squad wholesale:
 *
 *   1. the dry run writes nothing (tree digest before == after);
 *   2. `--apply` leaves the admission gate with zero errors;
 *   3. a second `--apply` is a byte-level no-op;
 *   4. every sentence in the converted body exists VERBATIM in the source.
 *
 * Everything runs under mkdtemp with the CLI env pointed at it: the backup
 * root, the state dir and the squad library are all inside the temp root, so
 * the installed library is never read or written.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { cliEnv, rmrf, squadFixture, tempRoot, treeDigest, REPO } from "../../_shared/tests/helpers/verify-fixture.ts";
import { runCli } from "../../_shared/tests/helpers/verify-fixture.ts";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

const MIGRATE_CLI = path.join(REPO, "skills", "squads", "scripts", "migrate-squad.ts");

const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) rmrf(r); });
function root(): string { const r = tempRoot("nrv-migrate-"); ROOTS.push(r); return r; }

function runMigrate(r: string, args: string[]) {
  const out = spawnSync(process.execPath, [MIGRATE_CLI, ...args], { cwd: path.join(r, "cwd"), env: cliEnv(r), encoding: "utf8" });
  let json: any = null;
  if (args.includes("--json")) { try { json = JSON.parse(out.stdout); } catch { json = null; } }
  return { code: out.status ?? -1, stdout: out.stdout ?? "", stderr: out.stderr ?? "", json };
}

// ── the corpus ──────────────────────────────────────────────────────────────

/** A prompt long enough (>= 40 words) to become a task of its own. */
const LONG_PROMPT = [
  "Read the brief end to end before writing anything.",
  "Name the audience, the format and the deadline, in that order.",
  "Then draft the outline as a numbered list, one line per section, and stop there:",
  "the outline is the deliverable of this step, not the artifact itself.",
  "Do not start writing the artifact. Hand the outline to the builder and wait.",
].join(" ");

const STEPS_DEPENDS_ON = `name: main
description: Plan the artifact, then build it
steps:
  - id: plan
    agent: planner
    depends_on: []
    task: |
      ${LONG_PROMPT}
  - id: build
    agent: builder
    depends_on: [plan]
    action: Assemble the artifact from the outline.
success_criteria:
  - the artifact exists at the declared path
  - every section of the outline is covered
`;

const AGENT_SEQUENCE = `workflow_name: main
agent_sequence:
  - planner
  - builder
`;

const WORKFLOW_SEQUENCE = `workflow:
  name: main
sequence:
  - step: plan
    agent: planner
    task: "plan.md"
  - step: build
    agent: builder
    task: "build.md"
`;

const FLOW_PHASES = `name: main
flow:
  type: dag
  phases:
    - phase: one
      steps:
        - id: plan
          agent: planner
    - phase: two
      steps:
        - id: build
          agent: builder
`;

const PIPELINE_STEPS = `name: main
pipeline:
  steps:
    - id: plan
      agent: planner
      outputs: [outline]
    - id: build
      agent: builder
      deps: [plan]
`;

const EVENT_ROUTES = `name: main
event_routes:
  - on: brief_received
    run: planner
  - on: outline_ready
    run: builder
`;

const TWIN_MD = `---
name: main
description: The Markdown half of a twin — prose only, no graph
---

## plan

The planner reads the brief and writes the outline.
`;

const SNAKE_REFS = `name: main
steps:
  - id: plan
    agent: PLANNER
    task: PLAN
  - id: build
    agent: builder
    requires: [plan]
    task: build
`;

interface Case {
  name: string;
  workflows: Record<string, string>;
  /** As authored in `components.workflows` and `invoke.ref`. */
  component?: string;
  invokeRef?: string;
  /** Dialect tags the report must name. */
  dialects: string[];
}

const CASES: Case[] = [
  { name: "steps-depends-on", workflows: { "main.yaml": STEPS_DEPENDS_ON }, dialects: ["steps_depends_on"] },
  { name: "agent-sequence", workflows: { "main.yaml": AGENT_SEQUENCE }, dialects: ["agent_sequence"] },
  { name: "workflow-sequence", workflows: { "main.yaml": WORKFLOW_SEQUENCE }, dialects: ["workflow_sequence"] },
  { name: "flow-phases", workflows: { "main.yaml": FLOW_PHASES }, dialects: ["flow_phases"] },
  { name: "pipeline-steps", workflows: { "main.yaml": PIPELINE_STEPS }, dialects: ["pipeline_steps"] },
  { name: "twin", workflows: { "main.md": TWIN_MD, "main.yaml": STEPS_DEPENDS_ON }, component: "main.md", invokeRef: "workflows/main.md", dialects: ["steps_depends_on"] },
];

function fixture(r: string, slug: string, c: Partial<Case> & { workflows: Record<string, string> }): string {
  return squadFixture(r, slug, {
    protocol: "5.0",
    workflows: c.workflows,
    workflowComponent: c.component ?? "main.yaml",
    invokeRef: c.invokeRef ?? "workflows/main.yaml",
  });
}

/** Body paragraphs, without the `## <step.id>` headings the migration writes. */
function bodyLines(md: string): string[] {
  const after = md.replace(/^---[\s\S]*?\n---\n/, "");
  return after.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("## "));
}

// ── the corpus, end to end ──────────────────────────────────────────────────

describe("one squad per dialect: dry run writes nothing, --apply admits, a second run is a no-op", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const r = root();
      const dir = fixture(r, c.name, c);

      // 1. the dry run touches nothing.
      const before = treeDigest(dir);
      const dry = runMigrate(r, [c.name, "--to", "6", "--json"]);
      expect(dry.code).toBe(0);
      expect(dry.json?.mode).toBe("dry-run");
      expect(treeDigest(dir)).toEqual(before);
      for (const d of c.dialects) expect(dry.json.files[0].dialect_detected).toContain(d);
      expect(dry.json.files[0].to).toBe("workflows/main.md");

      // 2. --apply converts and the gate finds no error.
      const applied = runMigrate(r, [c.name, "--to", "6", "--apply", "--json"]);
      expect(applied.code).toBe(0);
      expect(applied.json.gate.errors).toBe(0);
      expect(applied.json.changed).toBe(true);
      expect(fs.existsSync(path.join(dir, "workflows", "main.md"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "workflows", "main.yaml"))).toBe(false);

      const manifest: any = parseYaml(fs.readFileSync(path.join(dir, "squad.yaml"), "utf8"));
      expect(manifest.protocol).toBe("6.0");
      expect(manifest.capabilities[0].invoke.ref).toBe("workflows/main");
      expect(manifest.components.workflows).toEqual(["main"]);

      // 3. running it again writes nothing.
      const after = treeDigest(dir);
      const again = runMigrate(r, [c.name, "--to", "6", "--apply", "--json"]);
      expect(again.code).toBe(0);
      expect(again.json.noop).toBe(true);
      expect(treeDigest(dir)).toEqual(after);

      // 4. the surface change a buyer sees is patch or minor, never breaking.
      expect(["patch", "minor", "none"]).toContain(applied.json.surface_diff.bump);
      expect(applied.json.surface_diff.breaking).toBe(0);
    }, spawnBudgetMs(3));
  }
});

describe("nothing is invented", () => {
  test("every sentence of the converted body exists verbatim in the source", () => {
    const r = root();
    const dir = fixture(r, "verbatim", { workflows: { "main.yaml": STEPS_DEPENDS_ON } });
    const source = fs.readFileSync(path.join(dir, "workflows", "main.yaml"), "utf8");
    expect(runMigrate(r, ["verbatim", "--to", "6", "--apply"]).code).toBe(0);

    const md = fs.readFileSync(path.join(dir, "workflows", "main.md"), "utf8");
    const lines = bodyLines(md);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(source).toContain(line);

    // The prompt that became a task is verbatim too — only the scaffold around
    // it (frontmatter, the `## Acceptance Criteria` placeholder) is authored.
    const task = fs.readFileSync(path.join(dir, "tasks", "main-plan.md"), "utf8");
    expect(task).toContain(LONG_PROMPT);
    expect(task).toContain("## Acceptance Criteria");
  });

  test("a short prompt stays in the body; a long one becomes a task", () => {
    const r = root();
    const dir = fixture(r, "split", { workflows: { "main.yaml": STEPS_DEPENDS_ON } });
    const out = runMigrate(r, ["split", "--to", "6", "--apply", "--json"]);
    expect(out.json.files[0].tasks_extracted).toEqual(["tasks/main-plan.md"]);
    expect(out.json.files[0].prose_words_moved).toBeGreaterThan(40);

    const md = fs.readFileSync(path.join(dir, "workflows", "main.md"), "utf8");
    expect(md).toContain("## build");
    expect(md).toContain("Assemble the artifact from the outline.");
    expect(md).not.toContain("## plan\n");
    const graph: any = parseYaml(md.split("---")[1]);
    expect(graph.steps.find((s: any) => s.id === "plan").task).toBe("main-plan");
  }, spawnBudgetMs(2));

  test("--no-extract-tasks keeps the prompt in the body", () => {
    const r = root();
    const dir = fixture(r, "no-extract", { workflows: { "main.yaml": STEPS_DEPENDS_ON } });
    expect(runMigrate(r, ["no-extract", "--to", "6", "--apply", "--no-extract-tasks"]).code).toBe(0);
    const md = fs.readFileSync(path.join(dir, "workflows", "main.md"), "utf8");
    expect(md).toContain("## plan");
    expect(md).toContain(LONG_PROMPT);
    expect(fs.existsSync(path.join(dir, "tasks", "main-plan.md"))).toBe(false);
  });
});

describe("the twin", () => {
  test("the YAML's graph and the Markdown's body become one file", () => {
    const r = root();
    const dir = fixture(r, "twin-merge", { workflows: { "main.md": TWIN_MD, "main.yaml": STEPS_DEPENDS_ON }, component: "main.md", invokeRef: "workflows/main.md" });
    const out = runMigrate(r, ["twin-merge", "--to", "6", "--apply", "--json"]);
    expect(out.code).toBe(0);
    expect(out.json.files[0].twin_merged).toBe("workflows/main.yaml");
    expect(fs.readdirSync(path.join(dir, "workflows"))).toEqual(["main.md"]);

    const md = fs.readFileSync(path.join(dir, "workflows", "main.md"), "utf8");
    expect(md).toContain("The planner reads the brief and writes the outline.");  // the .md's body survived
    const graph: any = parseYaml(md.split("---")[1]);
    expect(graph.steps.map((s: any) => s.id)).toEqual(["plan", "build"]);         // the .yaml's graph won
  }, spawnBudgetMs(2));
});

describe("event_routes", () => {
  test("is refused, and nothing is written", () => {
    const r = root();
    const dir = fixture(r, "routes", { workflows: { "main.yaml": EVENT_ROUTES } });
    const before = treeDigest(dir);
    const out = runMigrate(r, ["routes", "--to", "6", "--apply", "--json"]);
    expect(out.code).toBe(1);
    expect(out.json.refusals.join(" ")).toContain("event_routes");
    expect(treeDigest(dir)).toEqual(before);
    expect(out.json.backup).toBeNull();
  }, spawnBudgetMs(2));

  test("--force leaves that document alone and migrates the rest of the squad", () => {
    const r = root();
    const dir = fixture(r, "routes-force", {
      workflows: { "main.yaml": EVENT_ROUTES, "second.yaml": STEPS_DEPENDS_ON },
    });
    const out = runMigrate(r, ["routes-force", "--to", "6", "--apply", "--force", "--json"]);
    expect(out.code).toBe(0);
    expect(fs.existsSync(path.join(dir, "workflows", "main.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "workflows", "second.md"))).toBe(true);
    expect(parseYaml(fs.readFileSync(path.join(dir, "squad.yaml"), "utf8")).protocol).toBe("6.0");
  }, spawnBudgetMs(2));
});

describe("--map-refs", () => {
  test("renames a reference that matches exactly one component; leaves the rest a finding", () => {
    const r = root();
    const dir = fixture(r, "map-refs", { workflows: { "main.yaml": SNAKE_REFS } });

    const without = runMigrate(r, ["map-refs", "--to", "6", "--json"]);
    expect(without.json.files[0].unresolved_refs.length).toBe(2);
    expect(without.json.refs_mapped).toEqual([]);

    const withFlag = runMigrate(r, ["map-refs", "--to", "6", "--apply", "--map-refs", "--json"]);
    expect(withFlag.code).toBe(0);
    expect(withFlag.json.refs_mapped.length).toBe(2);
    expect(withFlag.json.files[0].unresolved_refs).toEqual([]);
    const graph: any = parseYaml(fs.readFileSync(path.join(dir, "workflows", "main.md"), "utf8").split("---")[1]);
    expect(graph.steps[0].agent).toBe("planner");
    expect(graph.steps[0].task).toBe("plan");
  }, spawnBudgetMs(2));
});

describe("acceptance", () => {
  test("is derived from success_indicators with blocking: false, and --no-derive-acceptance opts out", () => {
    const r = root();
    const dir = fixture(r, "acceptance", { workflows: { "main.yaml": STEPS_DEPENDS_ON } });
    expect(runMigrate(r, ["acceptance", "--to", "6", "--apply"]).code).toBe(0);
    const cap: any = parseYaml(fs.readFileSync(path.join(dir, "squad.yaml"), "utf8")).capabilities[0];
    expect(cap.acceptance.map((a: any) => a.description)).toEqual([
      "the artifact exists at the declared path",
      "every section of the outline is covered",
    ]);
    for (const a of cap.acceptance) {
      expect(a.blocking).toBe(false);
      expect(a.id).toMatch(/^[a-z][a-z0-9_-]*$/);
    }

    const r2 = root();
    const dir2 = fixture(r2, "acceptance-off", { workflows: { "main.yaml": STEPS_DEPENDS_ON } });
    expect(runMigrate(r2, ["acceptance-off", "--to", "6", "--apply", "--no-derive-acceptance"]).code).toBe(0);
    expect(parseYaml(fs.readFileSync(path.join(dir2, "squad.yaml"), "utf8")).capabilities[0].acceptance).toBeUndefined();
  });
});

describe("backup and rollback", () => {
  test("--rollback restores the squad byte for byte", () => {
    const r = root();
    const dir = fixture(r, "rollback", { workflows: { "main.yaml": STEPS_DEPENDS_ON } });
    const before = treeDigest(dir);

    const applied = runMigrate(r, ["rollback", "--to", "6", "--apply", "--json"]);
    expect(applied.code).toBe(0);
    expect(fs.existsSync(applied.json.backup)).toBe(true);
    expect(treeDigest(dir)).not.toEqual(before);

    const back = runMigrate(r, ["rollback", "--rollback", applied.json.at]);
    expect(back.code).toBe(0);
    expect(treeDigest(dir)).toEqual(before);
  }, spawnBudgetMs(2));

  test("--rollback refuses when the squad changed after the migration", () => {
    const r = root();
    const dir = fixture(r, "rollback-dirty", { workflows: { "main.yaml": STEPS_DEPENDS_ON } });
    const applied = runMigrate(r, ["rollback-dirty", "--to", "6", "--apply", "--json"]);
    expect(applied.code).toBe(0);
    fs.appendFileSync(path.join(dir, "README.md"), "\nAuthored after the migration.\n", "utf8");
    const migrated = treeDigest(dir);

    const refused = runMigrate(r, ["rollback-dirty", "--rollback", applied.json.at]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("changed after the migration");
    expect(treeDigest(dir)).toEqual(migrated);

    expect(runMigrate(r, ["rollback-dirty", "--rollback", applied.json.at, "--force"]).code).toBe(0);
  }, spawnBudgetMs(3));

  test("the report lands in the state dir, never inside the squad", () => {
    const r = root();
    const dir = fixture(r, "report", { workflows: { "main.yaml": STEPS_DEPENDS_ON } });
    const applied = runMigrate(r, ["report", "--to", "6", "--apply", "--json"]);
    const file = path.join(r, "state", "report", `migrate-${applied.json.at}.json`);
    expect(fs.existsSync(file)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.schema).toBe("nirvana.squad-migrate/v1");
    for (const key of ["from", "to", "dialect_detected", "steps_before", "steps_after", "unresolved_refs", "inline_prompts_extracted", "prose_words_moved"]) {
      expect(saved.files[0]).toHaveProperty(key);
    }
    expect(fs.readdirSync(dir).some((n) => n.startsWith("migrate-"))).toBe(false);
  }, spawnBudgetMs(2));
});

describe("the gate agrees", () => {
  test("a migrated squad is ADMITTED and no longer reports protocol_below_6", () => {
    const r = root();
    fixture(r, "gated", { workflows: { "main.yaml": STEPS_DEPENDS_ON } });
    const before = runCli(r, ["squad", "gated", "--no-retrieval", "--json"]);
    expect(before.json.findings.map((f: any) => f.id)).toContain("protocol_below_6");

    expect(runMigrate(r, ["gated", "--to", "6", "--apply"]).code).toBe(0);
    const after = runCli(r, ["squad", "gated", "--no-retrieval", "--json"]);
    expect(after.json.summary.errors).toBe(0);
    expect(after.json.findings.map((f: any) => f.id)).not.toContain("protocol_below_6");
    expect(after.json.verdict).toBe("ADMITTED");
  }, spawnBudgetMs(2));
});

describe("usage", () => {
  test("--to is required and only 6 is a target", () => {
    const r = root();
    fixture(r, "usage", { workflows: { "main.yaml": STEPS_DEPENDS_ON } });
    expect(runMigrate(r, ["usage"]).code).toBe(4);
    expect(runMigrate(r, ["usage", "--to", "5"]).code).toBe(4);
    expect(runMigrate(r, ["nope", "--to", "6"]).code).toBe(4);
    expect(runMigrate(r, ["squad", "usage", "--to", "6"]).code).toBe(0);
  });

  test("--all walks the library", () => {
    const r = root();
    fixture(r, "all-one", { workflows: { "main.yaml": STEPS_DEPENDS_ON } });
    fixture(r, "all-two", { workflows: { "main.yaml": AGENT_SEQUENCE } });
    const out = runMigrate(r, ["--all", "--to", "6", "--json"]);
    expect(out.code).toBe(0);
    expect(out.json.map((x: any) => x.slug).sort()).toEqual(["all-one", "all-two"]);
    expect(out.json.every((x: any) => x.mode === "dry-run")).toBe(true);
  }, spawnBudgetMs(2));
});
