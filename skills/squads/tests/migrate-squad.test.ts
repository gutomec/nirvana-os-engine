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
import { foldKey } from "../scripts/migrate-squad.ts";
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

/** The v5 template dialect: the task is the agent under another name. */
const AGENT_NAMED_TASKS = `name: main
steps:
  - id: plan
    agent: planner
    task: planner
  - id: build
    agent: builder
    requires: [plan]
    task: execute_builder
  - id: ship
    agent: builder
    requires: [build]
    task: executeBuilder
  - id: done
    agent: planner
    requires: [ship]
    task: execute
`;

/** Glued names and missing squad prefixes, as the v5 templates wrote them. */
const GLUED_AND_PREFIXED = `name: main
steps:
  - id: planner
    agent: planner
    task: planner
  - id: build
    agent: builder
    requires: [planner]
    task: BUILD
`;

/** A step id with a capital, and a depends_on that wrote it as authored. */
const CAPITAL_ID_REQUIRES = `name: main
steps:
  - id: chunkN
    agent: planner
    task: plan
  - id: tags
    agent: builder
    depends_on: [chunkN]
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

describe("--map-refs understands the v5 template dialects", () => {
  test("a task that names the step's own agent is dropped, not stubbed", () => {
    const r = root();
    const dir = fixture(r, "agent-named", { workflows: { "main.yaml": AGENT_NAMED_TASKS } });
    const without = runMigrate(r, ["agent-named", "--to", "6", "--json"]);
    expect(without.json.files[0].unresolved_refs.length).toBe(4);
    const withFlag = runMigrate(r, ["agent-named", "--to", "6", "--apply", "--map-refs", "--json"]);
    expect(withFlag.code).toBe(0);
    expect(withFlag.json.gate.errors).toBe(0);
    expect(withFlag.json.files[0].unresolved_refs).toEqual([]);
    expect(withFlag.json.refs_mapped.filter((l: string) => l.includes("names the agent")).length).toBe(4);
    const graph: any = parseYaml(fs.readFileSync(path.join(dir, "workflows", "main.md"), "utf8").split("---")[1]);
    expect(graph.steps.map((s: any) => s.task ?? null)).toEqual([null, null, null, null]);
    expect(graph.steps.map((s: any) => s.agent)).toEqual(["planner", "builder", "builder", "planner"]);
    expect(fs.readdirSync(path.join(dir, "tasks")).sort()).toEqual(["build.md", "plan.md"]);
  }, spawnBudgetMs(2));

  test("a glued name and a squad-prefixed stem still resolve", () => {
    const r = root();
    const dir = fixture(r, "glued", { workflows: { "main.yaml": GLUED_AND_PREFIXED } });
    // the fixture's agents are `planner` and `builder`; rename them to carry a
    // squad prefix and reference them without it, glued and folded.
    for (const [from, to] of [["planner", "sq-planner"], ["builder", "sq-builder"]]) {
      fs.renameSync(path.join(dir, "agents", `${from}.md`), path.join(dir, "agents", `${to}.md`));
    }
    const manifest = path.join(dir, "squad.yaml");
    fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace("agents: [planner, builder]", "agents: [sq-planner, sq-builder]"), "utf8");
    fs.writeFileSync(path.join(dir, "workflows", "main.yaml"), `name: main
steps:
  - id: plan
    agent: planner
    task: sqplanner
  - id: build
    agent: sqbuilder
    requires: [plan]
    task: BUILD
`, "utf8");
    const withFlag = runMigrate(r, ["glued", "--to", "6", "--apply", "--map-refs", "--json"]);
    expect(withFlag.code).toBe(0);
    expect(withFlag.json.files[0].unresolved_refs).toEqual([]);
    const graph: any = parseYaml(fs.readFileSync(path.join(dir, "workflows", "main.md"), "utf8").split("---")[1]);
    expect(graph.steps[0].agent).toBe("sq-planner");   // prefix added by the unique suffix match
    expect(graph.steps[0].task ?? null).toBeNull();    // `sqplanner` names the agent, glued
    expect(graph.steps[1].agent).toBe("sq-builder");   // glued key
    expect(graph.steps[1].task).toBe("build");
  }, spawnBudgetMs(1));

  test("a prefixed agent ref, an agent ref with .md, and a label that is no document", () => {
    const r = root();
    const dir = fixture(r, "labels", { workflows: { "main.yaml": `name: main
steps:
  - id: plan
    agent: sq-planner
    task: plan
  - id: build
    agent: builder.md
    requires: [plan]
    task: setupFrontendProject
  - id: ship
    agent: builder
    requires: [build]
    task: test-checklist-flow
` } });
    const withFlag = runMigrate(r, ["labels", "--to", "6", "--apply", "--map-refs", "--json"]);
    expect(withFlag.code).toBe(0);
    expect(withFlag.json.gate.errors).toBe(0);
    expect(withFlag.json.files[0].unresolved_refs).toEqual([]);
    const md = fs.readFileSync(path.join(dir, "workflows", "main.md"), "utf8");
    const graph: any = parseYaml(md.split("---")[1]);
    expect(graph.steps.map((s: any) => s.agent)).toEqual(["planner", "builder", "builder"]);
    expect(graph.steps.map((s: any) => s.task ?? null)).toEqual(["plan", null, null]);
    expect(md).toContain("setup frontend project");
    expect(md).toContain("test checklist flow");
    expect(fs.readdirSync(path.join(dir, "tasks")).sort()).toEqual(["build.md", "plan.md"]);
  }, spawnBudgetMs(1));

  test("camelCase folds to the kebab-case file", () => {
    expect(foldKey("validateMarketFit")).toBe("validate-market-fit");
    expect(foldKey("execute_ncm_classifier")).toBe("execute-ncm-classifier");
    expect(foldKey("generateHTMLMockup")).toBe("generate-htmlmockup");
  });
});

describe("requires that name a label, a directory or a duplicate id resolve to steps", () => {
  test("a group label, a directory prefix over a creates mapping, and an annotated file all resolve", () => {
    const r = root();
    const dir = fixture(r, "requires-dialects", { workflows: { "main.yaml": `name: main
steps:
  - id: audit
    agent: planner
    task: plan
    group: phase-1-coleta
    creates:
      artifact: outputs/audit/report.json
  - id: sped
    agent: builder
    task: build
    group: phase-1-coleta
    creates: [02-bookkeeping/sped/]
  - id: esocial
    agent: builder
    task: build
    creates: [02-bookkeeping/esocial/]
  - id: statements
    agent: planner
    task: plan
    requires: [02-bookkeeping/]
  - id: report
    agent: builder
    task: build
    requires: [phase-1-coleta, "report.json (opcional)"]
` } });
    const applied = runMigrate(r, ["requires-dialects", "--to", "6", "--apply", "--json"]);
    expect(applied.code).toBe(0);
    expect(applied.json.gate.errors).toBe(0);
    const graph: any = parseYaml(fs.readFileSync(path.join(dir, "workflows", "main.md"), "utf8").split("---")[1]);
    const byId = Object.fromEntries(graph.steps.map((st: any) => [st.id, st]));
    expect(byId.statements.requires.sort()).toEqual(["esocial", "sped"]);
    expect(byId.report.requires.sort()).toEqual(["audit", "sped"]);
  }, spawnBudgetMs(1));

  test("a duplicate id in a depends_on dialect is renamed and the chain stays acyclic", () => {
    const r = root();
    const dir = fixture(r, "dup-ids", { workflows: { "main.yaml": `name: main
steps:
  - id: handler
    agent: planner
    task: plan
  - id: budget
    agent: builder
    task: build
    depends_on: [handler]
  - id: handler
    agent: planner
    task: plan
    depends_on: [budget]
  - id: handler
    agent: planner
    task: plan
    depends_on: [handler]
  - id: reporter
    agent: builder
    task: build
    depends_on: [handler]
` } });
    const applied = runMigrate(r, ["dup-ids", "--to", "6", "--apply", "--json"]);
    expect(applied.code).toBe(0);
    expect(applied.json.gate.errors).toBe(0);
    const graph: any = parseYaml(fs.readFileSync(path.join(dir, "workflows", "main.md"), "utf8").split("---")[1]);
    expect(graph.steps.map((st: any) => st.id)).toEqual(["handler", "budget", "handler-2", "handler-3", "reporter"]);
    expect(graph.steps[3].requires).toEqual(["handler-2"]);
    expect(graph.steps[4].requires).toEqual(["handler-3"]);
  }, spawnBudgetMs(1));
});

describe("a step id that would start with a digit gets a letter", () => {
  test("`1GerarRelatorio` becomes `step-1gerar-relatorio` and the squad migrates", () => {
    const r = root();
    const dir = fixture(r, "digit-id", { workflows: { "main.yaml": `name: main
steps:
  - id: 1GerarRelatorio
    agent: planner
    task: plan
  - id: 2Publicar
    agent: builder
    depends_on: [1GerarRelatorio]
    task: build
` } });
    const applied = runMigrate(r, ["digit-id", "--to", "6", "--apply", "--json"]);
    expect(applied.code).toBe(0);
    expect(applied.json.refusals).toEqual([]);
    expect(applied.json.gate.errors).toBe(0);
    const graph: any = parseYaml(fs.readFileSync(path.join(dir, "workflows", "main.md"), "utf8").split("---")[1]);
    expect(graph.steps.map((st: any) => st.id)).toEqual(["step-1gerarrelatorio", "step-2publicar"]);
    expect(graph.steps[1].requires).toEqual(["step-1gerarrelatorio"]);
  }, spawnBudgetMs(1));
});

describe("a step id the normalizer slugified is followed by its requires", () => {
  test("chunkN → chunkn, and depends_on: [chunkN] follows", () => {
    const r = root();
    const dir = fixture(r, "capital-id", { workflows: { "main.yaml": CAPITAL_ID_REQUIRES } });
    const applied = runMigrate(r, ["capital-id", "--to", "6", "--apply", "--json"]);
    expect(applied.code).toBe(0);
    expect(applied.json.gate.errors).toBe(0);
    const graph: any = parseYaml(fs.readFileSync(path.join(dir, "workflows", "main.md"), "utf8").split("---")[1]);
    expect(graph.steps[0].id).toBe("chunkn");
    expect(graph.steps[1].requires).toEqual(["chunkn"]);
  }, spawnBudgetMs(1));
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

// ── shapes the schema calls a normalizer bug ─────────────────────────────────
//
// Five library squads rolled back with `steps.N.agent: Too small`: a step the
// schema refuses is never authored content, it is a dialect the normalizer did
// not read. Gates (`type: approval`, `type: human-gate`) have nobody to run
// them; a `type: parallel` group is a layer, not a step; a phase may list its
// `agents:`; and an event router whose routes carry an `agent_chain` is a forest.

const graphOf = (dir: string, file = "main.md"): any =>
  parseYaml(fs.readFileSync(path.join(dir, "workflows", file), "utf8").split("---")[1]);

describe("a gate step folds into the edge", () => {
  test("`type: approval` between two steps: the follower inherits the wait and carries the gate", () => {
    const r = root();
    const dir = fixture(r, "gate-steps", { workflows: { "main.yaml": `name: main
steps:
  - id: design
    agent: planner
    task: plan
  - id: design-approval
    type: approval
    depends_on: [design]
    message: Review the design before the build starts.
    on_reject:
      route_to: design
  - id: build
    agent: builder
    task: build
    depends_on: [design-approval]
  - id: final-review
    type: approval
    depends_on: [build]
` } });
    const applied = runMigrate(r, ["gate-steps", "--to", "6", "--apply", "--json"]);
    expect(applied.json.refusals).toEqual([]);
    expect(applied.json.gate.errors).toBe(0);
    const graph = graphOf(dir);
    expect(graph.steps.map((s: any) => s.id)).toEqual(["design", "build"]);
    expect(graph.steps[1].requires).toEqual(["design"]);
    expect(graph.steps[1].meta.gate_before).toEqual([{ id: "design-approval", type: "approval", message: "Review the design before the build starts.", on_reject: { route_to: "design" } }]);
    expect(graph.extensions.trailing_gates).toEqual([{ id: "final-review", type: "approval" }]);
  }, spawnBudgetMs(1));

  test("`type: human-gate` inside a linear `workflow.sequence` chains around itself", () => {
    const r = root();
    const dir = fixture(r, "human-gate", { workflows: { "main.yaml": `workflow:
  id: main
  sequence:
    - agent: planner
      task: plan
    - type: human-gate
      id: confirm-analysis
      prompt: Confirm the analysis.
    - agent: builder
      task: build
` } });
    const applied = runMigrate(r, ["human-gate", "--to", "6", "--apply", "--json"]);
    expect(applied.json.refusals).toEqual([]);
    const graph = graphOf(dir);
    expect(graph.steps.map((s: any) => s.id)).toEqual(["planner", "builder"]);
    expect(graph.steps[1].requires).toEqual(["planner"]);
    expect(graph.steps[1].meta.gate_before[0].id).toBe("confirm-analysis");
  }, spawnBudgetMs(1));
});

describe("a parallel group is a layer", () => {
  test("children require the step before the group; the step after requires every child", () => {
    const r = root();
    const dir = fixture(r, "nested-group", { workflows: { "main.yaml": `workflow:
  id: main
  sequence:
    - agent: planner
      task: plan
    - type: parallel
      id: production
      steps:
        - agent: builder
          task: build
          id: build-a
        - agent: builder
          task: build
          id: build-b
    - agent: planner
      task: plan
      id: review
` } });
    const applied = runMigrate(r, ["nested-group", "--to", "6", "--apply", "--json"]);
    expect(applied.json.refusals).toEqual([]);
    expect(applied.json.gate.errors).toBe(0);
    const graph = graphOf(dir);
    expect(graph.steps.map((s: any) => s.id)).toEqual(["planner", "build-a", "build-b", "review"]);
    expect(graph.steps[1].requires).toEqual(["planner"]);
    expect(graph.steps[2].requires).toEqual(["planner"]);
    expect(graph.steps[1].meta.group).toBe("production");
    expect(graph.steps[3].requires).toEqual(["build-a", "build-b"]);
  }, spawnBudgetMs(1));
});

describe("a phase that lists its agents is one layer", () => {
  test("`phases[].agents[]` becomes one step per agent, all of them in the phase", () => {
    const r = root();
    const dir = fixture(r, "phase-agents", { workflows: { "main.yaml": `workflow_name: main
phases:
  - name: parse
    agent: planner
    task: plan
  - name: research
    parallel: true
    agents:
      - agent: builder
        task: build
      - agent: planner
        task: plan
  - name: synthesize
    agent: builder
    task: build
` } });
    const applied = runMigrate(r, ["phase-agents", "--to", "6", "--apply", "--json"]);
    expect(applied.json.refusals).toEqual([]);
    expect(applied.json.gate.errors).toBe(0);
    const graph = graphOf(dir);
    expect(graph.steps.map((s: any) => s.id)).toEqual(["parse", "builder", "planner", "synthesize"]);
    expect(graph.steps[1].requires).toEqual(["parse"]);
    expect(graph.steps[2].requires).toEqual(["parse"]);
    expect(graph.steps[2].meta.phase).toBe("research");
    expect(graph.steps[3].requires).toEqual(["builder", "planner"]);
  }, spawnBudgetMs(1));
});

describe("an event router with agent chains is a forest", () => {
  test("each route is its own chain; the trigger rides on the first step", () => {
    const r = root();
    const dir = fixture(r, "event-chains", { workflows: { "main.yaml": `workflow_name: main
event_routes:
  breakout:
    trigger_condition: event_type=breakout
    priority: HIGH
    agent_chain: [planner, builder]
  price_alert:
    trigger_condition: event_type=price_alert
    agent_chain: [builder]
` } });
    const applied = runMigrate(r, ["event-chains", "--to", "6", "--apply", "--json"]);
    expect(applied.json.refusals).toEqual([]);
    expect(applied.json.gate.errors).toBe(0);
    const graph = graphOf(dir);
    expect(graph.steps.map((s: any) => s.id)).toEqual(["breakout-planner", "breakout-builder", "price_alert-builder"]);
    expect(graph.steps[0].requires ?? []).toEqual([]);
    expect(graph.steps[0].meta.event).toEqual({ trigger_condition: "event_type=breakout", priority: "HIGH" });
    expect(graph.steps[0].meta.route).toBe("breakout");
    expect(graph.steps[1].requires).toEqual(["breakout-planner"]);
    expect(graph.steps[2].requires ?? []).toEqual([]);
  }, spawnBudgetMs(1));

  test("a route without an agent chain still refuses: there is no order to derive", () => {
    const r = root();
    fixture(r, "event-router", { workflows: { "main.yaml": `workflow_name: main
event_routes:
  breakout:
    trigger_condition: event_type=breakout
    agent: planner
` } });
    const out = runMigrate(r, ["event-router", "--to", "6", "--apply", "--json"]);
    expect(out.json.refusals.join("\n")).toContain("router, not a DAG");
  }, spawnBudgetMs(1));
});

describe("the backup skips what has no bytes", () => {
  test.skipIf(process.platform === "win32")("a unix socket inside the squad does not abort the migration", async () => {
    const net = await import("node:net");
    const r = root();
    const dir = fixture(r, "with-socket", { workflows: { "main.yaml": STEPS_DEPENDS_ON } });
    const sockDir = path.join(dir, "examples", "ledger");
    fs.mkdirSync(sockDir, { recursive: true });
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(path.join(sockDir, "admin.rpc"), resolve));
    try {
      const applied = runMigrate(r, ["with-socket", "--to", "6", "--apply", "--json"]);
      expect(applied.code).toBe(0);
      expect(applied.json.refusals).toEqual([]);
      expect(fs.existsSync(path.join(applied.json.backup, "examples", "ledger", "admin.rpc"))).toBe(false);
    } finally { server.close(); }
  }, spawnBudgetMs(1));
});
