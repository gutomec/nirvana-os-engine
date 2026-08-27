/**
 * verify-squad.test.ts — the squad catalog of `nrv validate`.
 *
 * The corpus is one squad per workflow dialect measured in the library, each
 * checked twice: once declaring `protocol: "5.0"` and once `"6.0"`. That pair
 * is the whole compatibility promise of this cut — the same broken workflow is
 * a warning for the 204 installed squads and an error for a squad that opted
 * into v6 — and it is stated here as a table rather than as prose.
 *
 * Everything runs against fixtures under mkdtemp with the CLI env pointed at
 * them; the installed library is never read or written.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";
import { CANONICAL_WORKFLOW, rmrf, runCli, squadFixture, tempRoot, treeDigest, writeSurfaceFor } from "./helpers/verify-fixture.ts";
import { criteria as squadCriteria, squadModule } from "../lib/verify/kinds/squad.ts";
import { WORKFLOW_LINT_IDS } from "../../squads/lib/workflow-reader.ts";

const require_ = createRequire(import.meta.url);
const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const fixers = require_(path.join(REPO, "skills", "squads", "lib", "mechanical-fixers.js"));
const criteria = require_(path.join(REPO, "skills", "squads", "lib", "squad-audit-criteria.js"));

const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) rmrf(r); });
function root(): string { const r = tempRoot(); ROOTS.push(r); return r; }

/** The gate's findings for one fixture, by id. */
function findings(r: string, slug: string, extra: string[] = []): Array<{ id: string; severity: string; where?: string }> {
  const out = runCli(r, ["squad", slug, "--no-retrieval", "--json", ...extra]);
  expect(out.json).not.toBeNull();
  return out.json.findings;
}
const idsOf = (f: Array<{ id: string }>) => f.map((x) => x.id);
const severityOf = (f: Array<{ id: string; severity: string }>, id: string) => f.find((x) => x.id === id)?.severity;

// ── the dialect corpus ──────────────────────────────────────────────────────

const AGENT_SEQUENCE = "workflow_name: main\nagent_sequence:\n  - planner\n  - builder\n";
const WORKFLOW_SEQUENCE = 'workflow:\n  name: main\nsequence:\n  - step: 1\n    agent: planner\n    task: "plan.md"\n  - step: 2\n    agent: builder\n    task: "build.md"\n';
const FLOW_PHASES = "name: main\nflow:\n  type: dag\n  phases:\n    - phase: one\n      steps:\n        - id: plan\n          agent: planner\n    - phase: two\n      steps:\n        - id: build\n          agent: builder\n";
const STEPS_DEPENDS_ON = "name: main\nsteps:\n  - id: plan\n    agent: planner\n    task: plan\n  - id: build\n    agent: builder\n    task: build\n    depends_on: [plan]\n";
const INLINE_PROSE = "name: main\nsteps:\n  - id: plan\n    agent: planner\n    task: |\n      Write the plan.\n      Two paragraphs, no more.\n";
const DANGLING_REF = "name: main\nsteps:\n  - id: plan\n    agent: ghost\n    task: phantom\n";
const CYCLE = "name: main\nsteps:\n  - id: plan\n    agent: planner\n    requires: [build]\n  - id: build\n    agent: builder\n    requires: [plan]\n";
const V6_MARKDOWN = `---\n${CANONICAL_WORKFLOW}---\n\n## plan\n\nRead the brief first.\n\n## build\n\nAssemble the artifact.\n`;

/** Every dialect, and the workflow finding it must produce. */
const DIALECTS: Array<{ name: string; workflow: string; file?: string; expect: string[] }> = [
  { name: "steps_depends_on", workflow: STEPS_DEPENDS_ON, expect: ["workflow_shape_legacy"] },
  { name: "agent_sequence", workflow: AGENT_SEQUENCE, expect: ["workflow_shape_legacy"] },
  { name: "workflow_sequence", workflow: WORKFLOW_SEQUENCE, expect: ["workflow_shape_legacy"] },
  { name: "flow_phases", workflow: FLOW_PHASES, expect: ["workflow_shape_legacy"] },
  { name: "inline_prose", workflow: INLINE_PROSE, expect: ["workflow_inline_prose"] },
  { name: "dangling_ref", workflow: DANGLING_REF, expect: ["workflow_ref_unresolved"] },
  { name: "cycle", workflow: CYCLE, expect: ["workflow_cycle"] },
];

describe("catalog integrity", () => {
  test("every lint rule has a criterion, every criterion's fixer exists, and ids are unique", () => {
    const ids = squadCriteria.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of WORKFLOW_LINT_IDS) expect(ids).toContain(id);
    const fixers = new Set(Object.keys(squadModule.fixers));
    for (const c of squadCriteria) if (c.fixer) expect(fixers.has(c.fixer)).toBe(true);
    for (const f of fixers) expect(squadModule.fixOrder).toContain(f);
    // The surface is always regenerated last: a fixer that rewrote the
    // manifest after it would leave the entity reporting surface_stale.
    expect(squadModule.fixOrder[squadModule.fixOrder.length - 1]).toBe("surface_regen");
  });
});

describe("the dialect corpus, judged by protocol", () => {
  for (const d of DIALECTS) {
    test(`${d.name}: warning under 5.0 (ADMITTED), error under 6.0 (REJECTED)`, () => {
      const r = root();
      const file = d.file ?? "main.yaml";
      for (const protocol of ["5.0", "6.0"]) {
        const slug = `${d.name.replace(/_/g, "-")}-${protocol.replace(".", "")}`;
        // v6 refs a workflow without its encoding (§28.6), so the only thing
        // that can reject these fixtures is the dialect under test.
        const ref = protocol === "6.0" ? "main" : file;
        squadFixture(r, slug, { protocol, workflows: { [file]: d.workflow }, workflowComponent: ref, invokeRef: `workflows/${ref}` });
        const f = findings(r, slug);
        for (const id of d.expect) {
          expect(idsOf(f)).toContain(id);
          expect(severityOf(f, id)).toBe(protocol === "6.0" ? "error" : "warning");
        }
        const code = runCli(r, ["squad", slug, "--no-retrieval"]).code;
        expect(code).toBe(protocol === "6.0" ? 1 : 0);
      }
    });
  }

  test("a v6 Markdown workflow with a canonical graph is admitted with no workflow finding", () => {
    const r = root();
    squadFixture(r, "clean-v6", {
      protocol: "6.0", workflows: { "main.md": V6_MARKDOWN },
      workflowComponent: "main", invokeRef: "workflows/main",
      capabilityExtra: [
        "    acceptance:",
        "      - id: artifact_built",
        "        description: the artifact exists after the build step",
        "        blocking: true",
      ],
    });
    const f = findings(r, "clean-v6");
    expect(idsOf(f).filter((id) => id.startsWith("workflow_"))).toEqual([]);
    expect(idsOf(f)).not.toContain("protocol_below_6");
    expect(runCli(r, ["squad", "clean-v6", "--no-retrieval"]).code).toBe(0);
  });

  test("`event_routes` is advice under either protocol: reported, never guessed at", () => {
    const r = root();
    for (const protocol of ["5.0", "6.0"]) {
      const slug = `router-${protocol.replace(".", "")}`;
      const ref = protocol === "6.0" ? "main" : "main.yaml";
      squadFixture(r, slug, { protocol, workflows: { "main.yaml": "name: main\nevent_routes:\n  on_push: rebuild\n" }, workflowComponent: ref, invokeRef: `workflows/${ref}` });
      const f = findings(r, slug);
      expect(severityOf(f, "workflow_unnormalizable")).toBe("warning");
      expect(runCli(r, ["squad", slug, "--no-retrieval"]).code).toBe(0);
    }
  });

  test("a twin, an orphan and an over-long body each get their own finding", () => {
    const r = root();
    squadFixture(r, "twins", {
      workflows: {
        "main.yaml": CANONICAL_WORKFLOW,
        "main.md": `---\nname: main\n---\n\n## plan\n\n${"word ".repeat(3000)}\n`,
        "spare.yaml": CANONICAL_WORKFLOW.replace("name: main", "name: spare"),
      },
    });
    const f = findings(r, "twins");
    expect(idsOf(f)).toContain("workflow_twin");
    expect(f.find((x) => x.id === "workflow_twin")!.where).toBe("main.md");
    expect(idsOf(f)).toContain("workflow_orphan");
    expect(f.find((x) => x.id === "workflow_orphan")!.where).toBe("spare.yaml");
    expect(severityOf(f, "workflow_body_too_long")).toBe("warning");
  });

  test("a capitalised stem is named, and only under 6.0 does it reject", () => {
    const r = root();
    squadFixture(r, "case-v6", { protocol: "6.0", workflows: { "Main.yaml": CANONICAL_WORKFLOW }, workflowComponent: "Main", invokeRef: "workflows/Main" });
    expect(severityOf(findings(r, "case-v6"), "workflow_stem_case")).toBe("error");
    squadFixture(r, "case-v5", { workflows: { "Main.yaml": CANONICAL_WORKFLOW }, workflowComponent: "Main.yaml", invokeRef: "workflows/Main.yaml" });
    expect(severityOf(findings(r, "case-v5"), "workflow_stem_case")).toBe("warning");
  });
});

describe("exit codes", () => {
  test("a clean v5 squad is admitted (0); --strict turns its warnings into 2", () => {
    const r = root();
    squadFixture(r, "clean");
    expect(runCli(r, ["squad", "clean", "--no-retrieval"]).code).toBe(0);
    const strict = runCli(r, ["squad", "clean", "--no-retrieval", "--strict"]);
    expect(strict.code).toBe(2);
    expect(strict.stdout).toContain("protocol_below_6");
  });

  test("an error rejects (1): a manifest the schema refuses", () => {
    const r = root();
    squadFixture(r, "no-components", { manifest: 'name: no-components\nversion: 1.0.0\nprotocol: "5.0"\n' });
    const out = runCli(r, ["squad", "no-components", "--no-retrieval"]);
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("manifest_schema");
  });

  test("a capability invoking a workflow that is not on disk is an error under either protocol", () => {
    const r = root();
    squadFixture(r, "no-workflow", { invokeRef: "workflows/absent.yaml" });
    const f = findings(r, "no-workflow");
    expect(severityOf(f, "invoke_ref_unresolved")).toBe("error");
  });

  test("a declared component that is not on disk is an error", () => {
    const r = root();
    const dir = squadFixture(r, "ghost-component");
    fs.writeFileSync(path.join(dir, "squad.yaml"), fs.readFileSync(path.join(dir, "squad.yaml"), "utf8").replace("tasks: [plan, build]", "tasks: [plan, build, ghost]"), "utf8");
    writeSurfaceFor(dir, "squad");
    expect(severityOf(findings(r, "ghost-component"), "components_missing")).toBe("error");
  });

  test("a run-output directory inside the squad is an error", () => {
    const r = root();
    const dir = squadFixture(r, "polluted");
    fs.mkdirSync(path.join(dir, "outputs"));
    fs.writeFileSync(path.join(dir, "outputs", "run.md"), "leftover\n", "utf8");
    expect(severityOf(findings(r, "polluted"), "outputs_pollution")).toBe("error");
  });
});

describe("the advisory catalog", () => {
  test("routing metadata: fewer than three briefs, or only one language", () => {
    const r = root();
    const dir = squadFixture(r, "thin-routing");
    const manifest = fs.readFileSync(path.join(dir, "squad.yaml"), "utf8")
      .replace('      - "preciso construir o artefato de fixture a partir deste brief"\n', "")
      .replace('      - "make the fixture artifact for our team"\n', "");
    fs.writeFileSync(path.join(dir, "squad.yaml"), manifest, "utf8");
    writeSurfaceFor(dir, "squad");
    const f = findings(r, "thin-routing");
    expect(severityOf(f, "routing_metadata_incomplete")).toBe("warning");
    expect(f.find((x) => x.id === "routing_metadata_incomplete")!.where).toBe("fixture.artifact.build");
  });

  test("a not_for entry longer than 25 chars: warning under 5.0, error under 6.0", () => {
    const r = root();
    for (const protocol of ["5.0", "6.0"]) {
      const slug = `fence-${protocol.replace(".", "")}`;
      const dir = squadFixture(r, slug, { protocol });
      fs.writeFileSync(path.join(dir, "squad.yaml"), fs.readFileSync(path.join(dir, "squad.yaml"), "utf8")
        .replace('not_for: ["logo design", "tax filing", "video editing"]',
          'not_for: ["use a different capability when the input is outside the declared domain"]'), "utf8");
      writeSurfaceFor(dir, "squad");
      const f = findings(r, slug);
      expect(severityOf(f, "not_for_too_long")).toBe(protocol === "6.0" ? "error" : "warning");
      expect(idsOf(f)).toContain("not_for_dead");
    }
  });

  test("fidelity validated with no ground truth on disk", () => {
    const r = root();
    squadFixture(r, "unproven", { capabilityExtra: ["    fidelity:", "      status: validated", "      ground_truth_dir: eval/ground-truth"] });
    expect(severityOf(findings(r, "unproven"), "fidelity_validated_unproven")).toBe("warning");
  });

  test("requires and consumes with no provider in reach", () => {
    const r = root();
    squadFixture(r, "composer", { capabilityExtra: ["    requires: [other-squad:fixture.beta.run]", "    consumes: [beta_artifact]"] });
    const f = findings(r, "composer").filter((x) => x.id === "requires_no_provider");
    expect(f).toHaveLength(2);
    expect(severityOf(f, "requires_no_provider")).toBe("warning");
  });

  test("component quality: a thin agent, a task with no acceptance criteria, no README, no dependency manifest", () => {
    const r = root();
    const dir = squadFixture(r, "thin-components");
    fs.writeFileSync(path.join(dir, "agents", "planner.md"), "# planner\n\nNo frontmatter here.\n", "utf8");
    fs.writeFileSync(path.join(dir, "tasks", "plan.md"), "# plan\n\nJust prose.\n", "utf8");
    fs.rmSync(path.join(dir, "README.md"));
    fs.rmSync(path.join(dir, "dependencies.yaml"));
    writeSurfaceFor(dir, "squad");
    const ids = idsOf(findings(r, "thin-components"));
    for (const id of ["agent_frontmatter_incomplete", "task_acceptance_missing", "readme_missing", "dependencies_missing"]) {
      expect(ids).toContain(id);
    }
    expect(runCli(r, ["squad", "thin-components", "--no-retrieval"]).code).toBe(0);
  });

  test("per-buyer distribution artifacts are reported, never rejected: an installed copy is legitimate", () => {
    const r = root();
    const dir = squadFixture(r, "installed-copy");
    fs.writeFileSync(path.join(dir, "PROVENANCE.json"), '{"license":"x"}\n', "utf8");
    fs.appendFileSync(path.join(dir, "agents", "planner.md"), "\n//AAAAAAAAAAAAAAAAAAAAAA\n", "utf8");
    writeSurfaceFor(dir, "squad");
    const f = findings(r, "installed-copy").find((x) => x.id === "distribution_artifacts")!;
    expect(f.severity).toBe("warning");
    expect(runCli(r, ["squad", "installed-copy", "--no-retrieval"]).code).toBe(0);
  });

  test("the evaluator capability without its block: warning under 5.0, error under 6.0", () => {
    const r = root();
    for (const protocol of ["5.0", "6.0"]) {
      const slug = `judge-${protocol.replace(".", "")}`;
      const dir = squadFixture(r, slug, { protocol });
      fs.writeFileSync(path.join(dir, "squad.yaml"), fs.readFileSync(path.join(dir, "squad.yaml"), "utf8")
        .replace("id: fixture.artifact.build", "id: quality.specification_conformance"), "utf8");
      writeSurfaceFor(dir, "squad");
      expect(severityOf(findings(r, slug), "evaluator_missing")).toBe(protocol === "6.0" ? "error" : "warning");
    }
  });
});

describe("--fix", () => {
  test("a second run does not change a byte", () => {
    const r = root();
    const dir = squadFixture(r, "fixable", {
      protocol: "6.0",
      workflows: { "main.md": `---\n${INLINE_PROSE}---\n\n## intro\n\nExisting prose.\n` },
      workflowComponent: "main.md", invokeRef: "workflows/main.md",
    });
    fs.writeFileSync(path.join(dir, "agents", "planner.md"), "---\nname: planner\ndescription: planner\n---\n\n# planner\n", "utf8");
    fs.writeFileSync(path.join(dir, "tasks", "plan.md"), "# plan\n\nJust prose.\n", "utf8");
    fs.rmSync(path.join(dir, "README.md"));
    fs.rmSync(path.join(dir, "dependencies.yaml"));
    writeSurfaceFor(dir, "squad");

    const first = runCli(r, ["squad", "fixable", "--no-retrieval", "--fix", "--json"]);
    expect(first.json.fix_outcome.rolled_back).toBe(false);
    expect(first.json.fixes.some((x: any) => x.applied)).toBe(true);
    const after = treeDigest(dir);
    const second = runCli(r, ["squad", "fixable", "--no-retrieval", "--fix", "--json"]);
    expect(second.json.fix_outcome.rolled_back).toBe(false);
    expect(treeDigest(dir)).toEqual(after);
    expect(second.json.fixes.filter((x: any) => x.applied)).toEqual([]);
  });

  test("workflow_inline_prose_to_body moves the prose to `## <step.id>` verbatim and keeps what was there", () => {
    const r = root();
    const dir = squadFixture(r, "prose", {
      protocol: "6.0",
      workflows: { "main.md": `---\n${INLINE_PROSE}---\n\n## intro\n\nExisting prose.\n` },
      workflowComponent: "main.md", invokeRef: "workflows/main.md",
    });
    runCli(r, ["squad", "prose", "--no-retrieval", "--fix"]);
    const text = fs.readFileSync(path.join(dir, "workflows", "main.md"), "utf8");
    expect(text).toContain("## intro");
    expect(text).toContain("Existing prose.");
    expect(text).toContain("## plan");
    expect(text).toContain("Two paragraphs, no more.");
    // The graph no longer carries the prompt.
    const graph = parseYaml(text.split("---")[1]);
    expect(graph.steps[0].task).toBeUndefined();
    expect(idsOf(findings(r, "prose"))).not.toContain("workflow_inline_prose");
  });

  test("invoke_ref_extension strips the encoding from a v6 ref and from components", () => {
    const r = root();
    const dir = squadFixture(r, "extension", { protocol: "6.0" });
    expect(idsOf(findings(r, "extension"))).toContain("invoke_ref_extension");
    runCli(r, ["squad", "extension", "--no-retrieval", "--fix"]);
    const manifest = parseYaml(fs.readFileSync(path.join(dir, "squad.yaml"), "utf8"));
    expect(manifest.capabilities[0].invoke.ref).toBe("workflows/main");
    expect(manifest.components.workflows).toEqual(["main"]);
    expect(idsOf(findings(r, "extension"))).not.toContain("invoke_ref_extension");
  });

  test("outputs_shape_repair promotes a singular `output` and drops the keys the schema refuses", () => {
    const r = root();
    const dir = squadFixture(r, "outputs", {
      capabilityExtra: ["    output:", "      name: report", "      type: markdown", "      humanize: true"],
    });
    writeSurfaceFor(dir, "squad");
    expect(idsOf(findings(r, "outputs"))).toContain("capability_outputs_shape");
    runCli(r, ["squad", "outputs", "--no-retrieval", "--fix"]);
    const cap = parseYaml(fs.readFileSync(path.join(dir, "squad.yaml"), "utf8")).capabilities[0];
    expect(cap.output).toBeUndefined();
    expect(cap.outputs).toEqual([{ name: "report", type: "markdown" }]);
    expect(idsOf(findings(r, "outputs"))).not.toContain("capability_outputs_shape");
  });

  test("twin_merge keeps the YAML graph and the Markdown body, and only when it is a merge", () => {
    const r = root();
    const dir = squadFixture(r, "merge", {
      workflows: { "main.yaml": CANONICAL_WORKFLOW, "main.md": "---\nname: main\n---\n\n## plan\n\nThe body that survives.\n" },
    });
    runCli(r, ["squad", "merge", "--no-retrieval", "--fix"]);
    expect(fs.existsSync(path.join(dir, "workflows", "main.yaml"))).toBe(false);
    const merged = fs.readFileSync(path.join(dir, "workflows", "main.md"), "utf8");
    expect(merged).toContain("The body that survives.");
    expect(parseYaml(merged.split("---")[1]).steps.map((s: any) => s.id)).toEqual(["plan", "build"]);

    // Two real graphs: the fixer declines instead of choosing.
    const other = squadFixture(r, "two-graphs", {
      workflows: { "main.yaml": CANONICAL_WORKFLOW, "main.md": `---\n${CANONICAL_WORKFLOW}---\n\n## plan\n\nBody.\n` },
    });
    const out = runCli(r, ["squad", "two-graphs", "--no-retrieval", "--fix", "--json"]);
    expect(fs.existsSync(path.join(other, "workflows", "main.yaml"))).toBe(true);
    expect(out.json.fixes.find((x: any) => x.fixer === "twin_merge").note).toContain("not mechanical");
  });

  test("workflow_refs_repair renames by case and separator, and never stubs a missing file", () => {
    const r = root();
    const dir = squadFixture(r, "renames", {
      workflows: { "main.yaml": "name: main\nsteps:\n  - id: plan\n    agent: planner\n    task: PLAN\n  - id: build\n    agent: Builder\n    task: nowhere\n" },
    });
    runCli(r, ["squad", "renames", "--no-retrieval", "--fix"]);
    const text = fs.readFileSync(path.join(dir, "workflows", "main.yaml"), "utf8");
    expect(text).toContain("task: plan");
    expect(text).toContain("agent: builder");
    // The reference nothing matches stays a finding; no stub was written.
    expect(text).toContain("task: nowhere");
    expect(fs.existsSync(path.join(dir, "tasks", "nowhere.md"))).toBe(false);
    expect(idsOf(findings(r, "renames"))).toContain("workflow_ref_unresolved");
  });

  test("requires_by_output_name rewrites a dependency that named an output", () => {
    const r = root();
    const graph = "name: main\nsteps:\n  - id: plan\n    agent: planner\n    task: plan\n    creates: [plan.md]\n  - id: build\n    agent: builder\n    task: build\n    requires: [plan.md]\n";
    const dir = squadFixture(r, "byoutput", {
      protocol: "6.0", workflows: { "main.md": `---\n${graph}---\n` },
      workflowComponent: "main", invokeRef: "workflows/main",
    });
    expect(idsOf(findings(r, "byoutput"))).toContain("workflow_requires_by_output");
    runCli(r, ["squad", "byoutput", "--no-retrieval", "--fix"]);
    const graphAfter = parseYaml(fs.readFileSync(path.join(dir, "workflows", "main.md"), "utf8").split("---")[1]);
    expect(graphAfter.steps[1].requires).toEqual(["plan"]);
    expect(idsOf(findings(r, "byoutput"))).not.toContain("workflow_requires_by_output");
  });

  test("a YAML workflow keeps its encoding: the fixer declines and names the migration", () => {
    const r = root();
    const dir = squadFixture(r, "yaml-shape", { protocol: "6.0", workflows: { "main.yaml": AGENT_SEQUENCE } });
    const out = runCli(r, ["squad", "yaml-shape", "--no-retrieval", "--fix", "--json"]);
    const note = out.json.fixes.find((x: any) => x.fixer === "workflow_normalize_shape").note;
    expect(note).toContain("nrv migrate --to 6");
    expect(fs.readFileSync(path.join(dir, "workflows", "main.yaml"), "utf8")).toBe(AGENT_SEQUENCE);
  });
});

describe("the audit scorer after `humanize`", () => {
  test("the total is still 100 and criterion 9 is the acceptance contract", () => {
    expect(criteria.TOTAL_MAX).toBe(100);
    expect(criteria.CRITERIA).toHaveLength(13);
    expect(criteria.CRITERIA.find((c: any) => c.id === 9).name).toBe("acceptance");
    expect(criteria.CRITERIA.some((c: any) => c.name === "humanize")).toBe(false);
  });

  test("c9 scores acceptance[] and the acceptance criteria of an invoked task", () => {
    const r = root();
    const none = squadFixture(r, "c9-none");
    expect(criteria.scoreSquad(none).breakdown.find((b: any) => b.id === 9).score).toBe(0);

    const declared = squadFixture(r, "c9-acceptance", {
      capabilityExtra: ["    acceptance:", "      - id: built", "        description: the artifact exists"],
    });
    const c9 = criteria.scoreSquad(declared).breakdown.find((b: any) => b.id === 9);
    expect(c9.score).toBe(6);
    expect(c9.evidence).toContain("1/1");

    const viaTask = squadFixture(r, "c9-task");
    fs.writeFileSync(path.join(viaTask, "squad.yaml"), fs.readFileSync(path.join(viaTask, "squad.yaml"), "utf8")
      .replace("      type: workflow\n      ref: workflows/main.yaml", "      type: task\n      ref: tasks/plan.md"), "utf8");
    expect(criteria.scoreSquad(viaTask).breakdown.find((b: any) => b.id === 9).score).toBe(6);
  });

  test("no mechanical fixer writes `humanize` any more, and the patch kind is gone", () => {
    const r = root();
    const dir = squadFixture(r, "retired-fixer", {
      capabilityExtra: ["    output:", "      name: report", "      type: markdown", "      humanize: true"],
    });
    const results = fixers.applyMechanicalFixes(dir, { patches: [{ kind: "humanize_default_true" }, { kind: "outputs_shape_repair" }] });
    expect(results[0].result.ok).toBe(false);
    expect(results[0].result.reason).toBe("unknown patch kind");
    expect(results[1].result.ok).toBe(true);
    const text = fs.readFileSync(path.join(dir, "squad.yaml"), "utf8");
    expect(text).not.toContain("humanize");
    expect(parseYaml(text).capabilities[0].outputs).toEqual([{ name: "report", type: "markdown" }]);
  });

  test("agents_frontmatter_repair writes a frontmatter block that still parses", () => {
    const r = root();
    const dir = squadFixture(r, "agent-repair");
    fs.writeFileSync(path.join(dir, "agents", "planner.md"), "---\nname: planner\ndescription: planner\n---\n\n# planner\n", "utf8");
    fixers.applyMechanicalFixes(dir, { patches: [{ kind: "agents_frontmatter_repair" }] });
    const text = fs.readFileSync(path.join(dir, "agents", "planner.md"), "utf8");
    expect(text).not.toContain("\\r?");
    const front = /^---\n([\s\S]*?)\n---/.exec(text)![1];
    expect(parseYaml(front).tools).toEqual(["Read", "Write", "Edit", "Bash", "Grep", "Glob"]);
    expect(parseYaml(front).maxTurns).toBe(12);
  });
});
