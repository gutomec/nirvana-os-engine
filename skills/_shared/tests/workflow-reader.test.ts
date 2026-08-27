/**
 * workflow-reader.test.ts — the reader, the normalization table and the lint.
 *
 * The library writes one graph in eight dialects. This file is the corpus:
 * one case per dialect measured in `~/squads`, each stating what it normalizes
 * to and what it must not lose. Two invariants carry the whole cut:
 *
 *   1. **Nothing is dropped.** A dialect round-trips through
 *      `normalizeWorkflow` → `renderCanonicalMarkdown` → `normalizeWorkflow`
 *      to the same canonical object, with every unknown key still present in
 *      `extensions` / `step.meta`. That is also what makes `--fix` idempotent.
 *   2. **Severity follows the protocol.** The same broken workflow is an error
 *      under `protocol: "6.0"` and a warning under `"5.0"`, so the 204
 *      installed squads keep the verdict they have today.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { WorkflowSchema } from "../validators/validators.ts";
import {
  bodyWordCount, componentStems, CANONICAL_ID, lintWorkflow, listWorkflowFiles, normalizeWorkflow,
  readWorkflow, referencedComponents, renderCanonicalMarkdown, renderProseBody, resolveWorkflowRef,
  splitFrontmatter, type CanonicalWorkflow, type LintContext,
} from "../../squads/lib/workflow-reader.ts";

const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) try { fs.rmSync(r, { recursive: true, force: true }); } catch {} });
function root(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-wf-reader-"));
  ROOTS.push(r);
  return r;
}

/** A squad directory holding only `workflows/`, for the file-level API. */
function squadWith(files: Record<string, string>, extra: { agents?: string[]; tasks?: string[] } = {}): string {
  const dir = path.join(root(), "squad");
  fs.mkdirSync(path.join(dir, "workflows"), { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, "workflows", name), content, "utf8");
  for (const [sub, names] of [["agents", extra.agents ?? []], ["tasks", extra.tasks ?? []]] as const) {
    if (!names.length) continue;
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    for (const n of names) fs.writeFileSync(path.join(dir, sub, `${n}.md`), `# ${n}\n`, "utf8");
  }
  return dir;
}

// ── the corpus: one document per dialect measured in the library ────────────

/** `api-development`: the canonical-adjacent shape, `depends_on` and `on_fail`. */
const STEPS_DEPENDS_ON = [
  "name: alpha",
  "description: Plan then build",
  "steps:",
  "  - id: plan",
  "    agent: planner",
  "    task: plan",
  "    creates: [plan.md]",
  "    validation:",
  "      schema: schemas/plan.json",
  "  - id: build",
  "    agent: builder",
  "    task: build",
  "    depends_on: [plan]",
  "    on_fail: abort",
  "success_criteria:",
  "  - the artifact exists",
  "harness:",
  "  budget_usd: 5",
  "",
].join("\n");

/** `adaptive-tutor-k12`: a bare list of agent names, no I/O, no failure, no gate. */
const AGENT_SEQUENCE = [
  "workflow_name: seq",
  "agent_sequence:",
  "  - planner",
  "  - builder",
  "transitions:",
  "  planner: builder",
  "key_commands: [go]",
  "",
].join("\n");

/** The template's own shape: a `workflow:` header plus `sequence[]`. */
const WORKFLOW_SEQUENCE = [
  "workflow:",
  "  name: tmpl",
  "  description: The templated pipeline",
  "sequence:",
  "  - step: 1",
  "    agent: planner",
  '    task: "plan.md"',
  "  - step: 2",
  "    agent: builder",
  '    task: "build.md"',
  "    on_success: publish",
  "gates:",
  "  approval: manual",
  "",
].join("\n");

/** Design squads: `flow.type: dag` with phases instead of edges. */
const FLOW_PHASES = [
  "name: phased",
  "flow:",
  "  type: dag",
  "  phases:",
  "    - phase: discover",
  "      steps:",
  "        - id: plan",
  "          agent: planner",
  "    - phase: deliver",
  "      steps:",
  "        - id: build",
  "          agent: builder",
  "        - id: check",
  "          agent: planner",
  "",
].join("\n");

/** `outreach-ai-squad`: the prompt itself in the `task:` field. */
const INLINE_PROSE = [
  "name: inline",
  "steps:",
  "  - id: draft",
  "    agent: planner",
  "    task: |",
  "      Write the outreach sequence.",
  "      Three touches, one CTA each.",
  "",
].join("\n");

/** `la-bottega`: a Markdown workflow whose graph is a list of agents. */
const LA_BOTTEGA = [
  "---",
  "workflow:",
  "  agents:",
  "    - director",
  "    - all-as-needed",
  "  command: /bottega",
  "---",
  "",
  "## director",
  "",
  "The director reads the brief and assigns the room.",
  "",
].join("\n");

/** `la-bottega`: `depends_on` naming another step's OUTPUT, not its id. */
const REQUIRES_BY_OUTPUT = [
  "name: byoutput",
  "steps:",
  "  - id: plan",
  "    agent: planner",
  "    output: plan.md",
  "  - id: build",
  "    agent: builder",
  "    depends_on: [plan.md]",
  "",
].join("\n");

const EVENT_ROUTES = [
  "name: router",
  "event_routes:",
  "  on_push: rebuild",
  "  on_release: publish",
  "",
].join("\n");

const CYCLE = [
  "name: loop",
  "steps:",
  "  - id: a",
  "    agent: planner",
  "    requires: [b]",
  "  - id: b",
  "    agent: builder",
  "    requires: [a]",
  "",
].join("\n");

const norm = (text: string, stem = "alpha") => normalizeWorkflow(parseYaml(text), { stem });

describe("normalization table: every legacy dialect onto one graph", () => {
  test("steps[] + depends_on: requires, creates, on_failure, and the aliases", () => {
    const r = norm(STEPS_DEPENDS_ON);
    expect(r.dialects).toContain("legacy-dialect:steps_depends_on");
    expect(r.dialects).toContain("legacy-dialect:success_criteria");
    expect(r.canonical.steps.map((s) => s.id)).toEqual(["plan", "build"]);
    expect(r.canonical.steps[1].requires).toEqual(["plan"]);
    expect(r.canonical.steps[1].on_failure).toBe("abort");
    expect(r.canonical.steps[0].creates).toEqual(["plan.md"]);
    expect(r.canonical.success_indicators).toEqual(["the artifact exists"]);
    // Legacy keys keep their bytes instead of disappearing.
    expect(r.canonical.steps[0].meta).toEqual({ validation: { schema: "schemas/plan.json" } });
    expect(r.canonical.extensions).toEqual({ harness: { budget_usd: 5 } });
  });

  test("agent_sequence[]: a bare list becomes a chain, workflow_name becomes name", () => {
    const r = norm(AGENT_SEQUENCE, "seq");
    expect(r.dialects).toContain("legacy-dialect:agent_sequence");
    expect(r.canonical.name).toBe("seq");
    expect(r.canonical.steps.map((s) => [s.id, s.requires])).toEqual([["planner", []], ["builder", ["planner"]]]);
    expect(r.canonical.extensions).toEqual({ transitions: { planner: "builder" }, key_commands: ["go"] });
  });

  test("workflow: header + sequence[]: the header rises, `task: x.md` loses the extension", () => {
    const r = norm(WORKFLOW_SEQUENCE, "tmpl");
    expect(r.dialects).toContain("legacy-dialect:workflow_sequence");
    expect(r.canonical.name).toBe("tmpl");
    expect(r.canonical.description).toBe("The templated pipeline");
    expect(r.canonical.steps.map((s) => s.task)).toEqual(["plan", "build"]);
    expect(r.canonical.steps[1].requires).toEqual(["planner"]);
    expect(r.canonical.extensions.gates).toEqual({ approval: "manual" });
    // `on_success` has no canonical home and is kept rather than discarded.
    expect(r.canonical.steps[1].meta.on_success).toBe("publish");
  });

  test("flow.phases[]: flattened, phase n depends on the last ids of phase n-1", () => {
    const r = norm(FLOW_PHASES, "phased");
    expect(r.dialects).toContain("legacy-dialect:flow_phases");
    expect(r.canonical.extensions.flow_type).toBe("dag");
    expect(r.canonical.steps.map((s) => [s.id, s.requires])).toEqual([
      ["plan", []], ["build", ["plan"]], ["check", ["plan"]],
    ]);
    expect(r.canonical.steps.map((s) => s.meta.phase)).toEqual(["discover", "deliver", "deliver"]);
  });

  test("`task: |`: the prose leaves the graph verbatim and is reported, not deleted", () => {
    const r = norm(INLINE_PROSE, "inline");
    expect(r.inlineProse).toEqual(["draft"]);
    expect(r.canonical.steps[0].task).toBeUndefined();
    expect(r.prose.draft).toBe("Write the outreach sequence.\nThree touches, one CTA each.");
    expect(renderProseBody(r)).toContain("## draft");
    expect(renderProseBody(r)).toContain("Three touches, one CTA each.");
  });

  test("the la-bottega Markdown: `workflow.agents` becomes a chain, the placeholder is dropped", () => {
    const dir = squadWith({ "bottega.md": LA_BOTTEGA });
    const raw = readWorkflow(path.join(dir, "workflows", "bottega.md"));
    expect(raw.format).toBe("frontmatter");
    expect(raw.error).toBeNull();
    const r = normalizeWorkflow(raw.doc, { stem: "bottega" });
    expect(r.dialects).toContain("legacy-dialect:workflow_agents");
    expect(r.canonical.steps.map((s) => s.agent)).toEqual(["director"]);
    expect(r.canonical.extensions.command).toBe("/bottega");
    expect(raw.body).toContain("assigns the room");
  });

  test("`depends_on` naming an output maps to the step that creates it", () => {
    const r = norm(REQUIRES_BY_OUTPUT, "byoutput");
    expect(r.dialects).toContain("legacy-dialect:requires_by_output");
    expect(r.canonical.steps[1].requires).toEqual(["plan"]);
  });

  test("`event_routes` is unnormalizable, and says so instead of guessing an order", () => {
    const r = norm(EVENT_ROUTES, "router");
    expect(r.unnormalizable).toBe(true);
    expect(r.canonical.steps).toEqual([]);
    expect(r.canonical.extensions.event_routes).toEqual({ on_push: "rebuild", on_release: "publish" });
    expect(r.notes.join(" ")).toContain("router, not a DAG");
  });

  test("pipeline.steps and bare sequence[] are recognised too", () => {
    const pipeline = norm("name: p\npipeline:\n  steps:\n    - id: a\n      agent: planner\n", "p");
    expect(pipeline.dialects).toContain("legacy-dialect:pipeline_steps");
    expect(pipeline.canonical.steps).toHaveLength(1);
    const bare = norm("name: s\nsequence:\n  - agent: planner\n  - agent: builder\n", "s");
    expect(bare.dialects).toContain("legacy-dialect:sequence");
    expect(bare.canonical.steps[1].requires).toEqual(["planner"]);
  });
});

describe("round trip: normalize → render → normalize loses nothing", () => {
  const corpus: Record<string, string> = {
    steps_depends_on: STEPS_DEPENDS_ON,
    agent_sequence: AGENT_SEQUENCE,
    workflow_sequence: WORKFLOW_SEQUENCE,
    flow_phases: FLOW_PHASES,
    inline_prose: INLINE_PROSE,
    requires_by_output: REQUIRES_BY_OUTPUT,
    event_routes: EVENT_ROUTES,
  };

  for (const [name, text] of Object.entries(corpus)) {
    test(`${name} survives the round trip and the canonical form is a fixed point`, () => {
      const first = norm(text, name.replace(/_/g, "-"));
      const rendered = renderCanonicalMarkdown(first.canonical, renderProseBody(first));
      const { frontmatter, body } = splitFrontmatter(rendered);
      expect(frontmatter).not.toBeNull();
      const second = normalizeWorkflow(parseYaml(frontmatter!), { stem: name.replace(/_/g, "-") });
      expect(second.canonical).toEqual(first.canonical);
      // Once canonical, no dialect is left to report — this is what makes a
      // second `--fix` a no-op.
      expect(second.dialects).toEqual([]);
      if (Object.keys(first.prose).length) expect(body).toContain("## ");
    });
  }

  test("a canonical graph passes the strict WorkflowSchema", () => {
    for (const [name, text] of Object.entries(corpus)) {
      const r = norm(text, name.replace(/_/g, "-"));
      if (r.unnormalizable) continue;
      const parsed = WorkflowSchema.safeParse(r.canonical);
      expect(parsed.success ? "ok" : JSON.stringify(parsed.error.issues)).toBe("ok");
      expect(CANONICAL_ID.test(r.canonical.name)).toBe(true);
    }
  });
});

describe("readWorkflow: both encodings, BOM and CRLF", () => {
  test("YAML is the whole document; Markdown is frontmatter plus body", () => {
    const dir = squadWith({ "a.yaml": STEPS_DEPENDS_ON, "b.md": `---\n${STEPS_DEPENDS_ON}---\n\n## plan\n\nProse.\n` });
    const yaml = readWorkflow(path.join(dir, "workflows", "a.yaml"));
    const md = readWorkflow(path.join(dir, "workflows", "b.md"));
    expect(yaml.format).toBe("yaml");
    expect(yaml.body).toBe("");
    expect(md.format).toBe("frontmatter");
    expect(md.body).toContain("Prose.");
    expect(normalizeWorkflow(md.doc, { stem: "b" }).canonical.steps).toEqual(normalizeWorkflow(yaml.doc, { stem: "b" }).canonical.steps);
  });

  test("a CRLF Markdown workflow with a BOM parses to the same graph as its LF twin", () => {
    const lf = `---\n${STEPS_DEPENDS_ON}---\n\n## plan\n\nProse.\n`;
    const dir = squadWith({ "lf.md": lf, "crlf.md": "﻿" + lf.replace(/\n/g, "\r\n") });
    const a = readWorkflow(path.join(dir, "workflows", "lf.md"));
    const b = readWorkflow(path.join(dir, "workflows", "crlf.md"));
    expect(b.error).toBeNull();
    expect(normalizeWorkflow(b.doc, { stem: "x" }).canonical).toEqual(normalizeWorkflow(a.doc, { stem: "x" }).canonical);
    expect(b.body.replace(/\r/g, "")).toBe(a.body);
  });

  test("a Markdown file with no frontmatter is an error, never a silent empty graph", () => {
    const dir = squadWith({ "plain.md": "# Just prose\n\nNo graph here.\n" });
    const raw = readWorkflow(path.join(dir, "workflows", "plain.md"));
    expect(raw.doc).toBeNull();
    expect(raw.error).toContain("frontmatter");
  });
});

describe("listWorkflowFiles and resolveWorkflowRef", () => {
  test("stems dedupe, the .md wins the twin, and the loser is reported", () => {
    const dir = squadWith({ "x.yaml": STEPS_DEPENDS_ON, "x.md": `---\n${STEPS_DEPENDS_ON}---\n`, "Beta.yaml": AGENT_SEQUENCE });
    const files = listWorkflowFiles(dir);
    expect(files.map((f) => f.stem)).toEqual(["beta", "x"]);
    const x = files.find((f) => f.stem === "x")!;
    expect(x.file).toBe("x.md");
    expect(x.twins).toEqual(["x.yaml"]);
  });

  test("a ref resolves with or without its extension, and with or without the directory", () => {
    const dir = squadWith({ "x.yaml": STEPS_DEPENDS_ON });
    for (const ref of ["workflows/x", "workflows/x.yaml", "x", "x.yaml"]) {
      expect(resolveWorkflowRef(dir, ref)?.endsWith("x.yaml")).toBe(true);
    }
    expect(resolveWorkflowRef(dir, "workflows/nope")).toBeNull();
    expect(resolveWorkflowRef(dir, "")).toBeNull();
  });

  test("with twins on disk a bare ref resolves to the .md, as the surface keys it", () => {
    const dir = squadWith({ "x.yaml": STEPS_DEPENDS_ON, "x.md": `---\n${STEPS_DEPENDS_ON}---\n` });
    expect(resolveWorkflowRef(dir, "workflows/x")?.endsWith("x.md")).toBe(true);
    expect(resolveWorkflowRef(dir, "workflows/x.yaml")?.endsWith("x.yaml")).toBe(true);
  });
});

describe("referencedComponents", () => {
  test("agents and tasks in step order, deduped", () => {
    const r = norm(STEPS_DEPENDS_ON);
    expect(referencedComponents(r.canonical)).toEqual({ agents: ["planner", "builder"], tasks: ["plan", "build"] });
  });

  test("componentStems reads what is on disk", () => {
    const dir = squadWith({ "x.yaml": STEPS_DEPENDS_ON }, { agents: ["planner"], tasks: ["plan", "build"] });
    expect([...componentStems(dir, "agents")]).toEqual(["planner"]);
    expect([...componentStems(dir, "tasks")].sort()).toEqual(["build", "plan"]);
  });
});

// ── lint ────────────────────────────────────────────────────────────────────

function lintCtx(over: Partial<LintContext> = {}): LintContext {
  return {
    protocol: "6.0", file: "alpha.md", stem: "alpha", twins: [],
    agents: new Set(["planner", "builder"]), tasks: new Set(["plan", "build"]),
    dialects: [], unnormalizable: false, inlineProse: [], bodyWords: 0, orphan: false,
    ...over,
  };
}

const idsOf = (canonical: CanonicalWorkflow, ctx: Partial<LintContext>) => lintWorkflow(canonical, lintCtx(ctx)).map((f) => f.id);

describe("lint: severity follows the protocol", () => {
  test("the same broken workflow is an error under 6.0 and a warning under 5.0", () => {
    const r = norm(INLINE_PROSE, "inline");
    const v6 = lintWorkflow(r.canonical, lintCtx({ inlineProse: r.inlineProse }));
    const v5 = lintWorkflow(r.canonical, lintCtx({ protocol: "5.0", inlineProse: r.inlineProse }));
    expect(v6.find((f) => f.id === "workflow_inline_prose")!.severity).toBe("error");
    expect(v5.find((f) => f.id === "workflow_inline_prose")!.severity).toBe("warning");
    expect(v6.map((f) => f.id)).toEqual(v5.map((f) => f.id));
  });

  test("the body ceiling and the orphan are advice under either protocol", () => {
    const r = norm(STEPS_DEPENDS_ON);
    for (const protocol of ["5.0", "6.0"]) {
      const f = lintWorkflow(r.canonical, lintCtx({ protocol, bodyWords: 3000, bodyWordsMax: 2500, orphan: true }));
      expect(f.find((x) => x.id === "workflow_body_too_long")!.severity).toBe("warning");
      expect(f.find((x) => x.id === "workflow_orphan")!.severity).toBe("warning");
    }
  });

  test("`event_routes` is advice too: the gate reports it, the migration decides", () => {
    const r = norm(EVENT_ROUTES, "router");
    const f = lintWorkflow(r.canonical, lintCtx({ stem: "router", file: "router.yaml", unnormalizable: true, dialects: r.dialects }));
    expect(f.find((x) => x.id === "workflow_unnormalizable")!.severity).toBe("warning");
    // Unnormalizable replaces the shape finding: there is no shape to fix.
    expect(f.map((x) => x.id)).not.toContain("workflow_shape_legacy");
  });
});

describe("lint: what it names", () => {
  test("a reference that resolves to nothing", () => {
    const r = norm("name: a\nsteps:\n  - id: x\n    agent: ghost\n    task: phantom\n");
    const f = lintWorkflow(r.canonical, lintCtx())[0];
    expect(f.id).toBe("workflow_ref_unresolved");
    expect(f.evidence).toContain("agent `ghost`");
    expect(f.evidence).toContain("task `phantom`");
  });

  test("a step with no agent at all", () => {
    const r = norm("name: a\nsteps:\n  - id: x\n    task: plan\n");
    expect(idsOf(r.canonical, {})).toContain("workflow_ref_unresolved");
  });

  test("duplicate step ids", () => {
    const canonical: CanonicalWorkflow = {
      name: "dup", extensions: {},
      steps: [
        { id: "plan", agent: "planner", requires: [], creates: [], meta: {} },
        { id: "plan", agent: "builder", requires: [], creates: [], meta: {} },
      ],
    };
    expect(idsOf(canonical, {})).toContain("workflow_step_id_duplicate");
  });

  test("a requires that names no step", () => {
    const r = norm("name: a\nsteps:\n  - id: x\n    agent: planner\n    requires: [nowhere]\n");
    const f = lintWorkflow(r.canonical, lintCtx()).find((x) => x.id === "workflow_dangling_requires")!;
    expect(f.evidence).toContain("x → nowhere");
  });

  test("a cycle", () => {
    const r = norm(CYCLE, "loop");
    const f = lintWorkflow(r.canonical, lintCtx({ stem: "loop", file: "loop.yaml" })).find((x) => x.id === "workflow_cycle")!;
    expect(f.message).toContain("cycle");
    expect(f.evidence).toContain("a");
  });

  test("a twin on disk", () => {
    const r = norm(STEPS_DEPENDS_ON);
    const f = lintWorkflow(r.canonical, lintCtx({ file: "x.md", stem: "x", twins: ["x.yaml"] })).find((x) => x.id === "workflow_twin")!;
    expect(f.evidence).toBe("x.md + x.yaml");
  });

  test("a stem outside `^[a-z][a-z0-9_-]*$`", () => {
    const r = norm(AGENT_SEQUENCE, "Beta");
    expect(idsOf(r.canonical, { stem: "Beta", file: "Beta.yaml", agents: new Set(["planner", "builder"]) })).toContain("workflow_stem_case");
  });

  test("a legacy dialect names which one", () => {
    const r = norm(AGENT_SEQUENCE, "seq");
    const f = lintWorkflow(r.canonical, lintCtx({ stem: "seq", file: "seq.yaml", dialects: r.dialects })).find((x) => x.id === "workflow_shape_legacy")!;
    expect(f.evidence).toContain("legacy-dialect:agent_sequence");
  });

  test("a canonical, resolved, invoked workflow lints clean", () => {
    const canonical: CanonicalWorkflow = {
      name: "alpha", extensions: {},
      steps: [
        { id: "plan", agent: "planner", task: "plan", requires: [], creates: ["plan.md"], meta: {} },
        { id: "build", agent: "builder", task: "build", requires: ["plan"], creates: [], meta: {} },
      ],
    };
    expect(lintWorkflow(canonical, lintCtx())).toEqual([]);
  });

  test("bodyWordCount counts words, not lines", () => {
    expect(bodyWordCount("")).toBe(0);
    expect(bodyWordCount("  one\n\ntwo three  ")).toBe(3);
  });
});
