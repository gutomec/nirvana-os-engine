/**
 * Protocol fixtures, generated on demand in a temp dir.
 *
 * They live here as code, never as files: `check-engine-purity` forbids a
 * `squad.yaml` / `business.yaml` / mind-clone manifest anywhere outside
 * `templates/**`, `schemas/**` and `examples/**`, and the pattern the admission
 * test already uses (`entity-admission.test.ts`) is to plant the entity in
 * `mkdtemp` and delete it after the run.
 *
 * One graph, two encodings. `ALPHA_GRAPH` is the workflow used by the v5 squad
 * (as `workflows/alpha.yaml`) and by its migrated twin (as the frontmatter of
 * `workflows/alpha.md`). Keeping the bytes identical is what lets the tests
 * state invariants ("same graph, same body text", "rename is a patch") instead
 * of examples.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { extractSurface, type Surface, type SurfaceEntry } from "../../lib/surface.ts";

export function tmpRoot(prefix = "nrv-protocol-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** The `api-development` shape: `steps[]` with `depends_on`, `creates`, `on_failure`. */
export const ALPHA_GRAPH = [
  "name: alpha",
  "description: Plan the alpha artifact, then build it",
  "steps:",
  "  - id: plan",
  "    agent: planner",
  "    task: plan",
  "    creates: [plan.md]",
  "  - id: build",
  "    agent: builder",
  "    task: build",
  "    depends_on: [plan]",
  "    on_failure: abort",
  "success_indicators:",
  "  - the alpha artifact exists and the build step reports success",
  "",
].join("\n");

/** The `adaptive-tutor-k12` shape: a bare list of agent names. */
export const SEQ_GRAPH = [
  "workflow_name: seq",
  "agent_sequence:",
  "  - planner",
  "  - builder",
  "",
].join("\n");

export const ALPHA_BODY = [
  "## plan",
  "",
  "Read the brief and write the plan before anything is built.",
  "",
  "## build",
  "",
  "Assemble the deliverable from the plan, one artifact per step.",
  "",
].join("\n");

const agentDoc = (name: string) => [
  "---",
  `name: ${name}`,
  `description: ${name} persona of the protocol fixture`,
  "maxTurns: 12",
  "---",
  "",
  `# ${name}`,
  "",
  `The ${name} owns one step of the alpha workflow and nothing else.`,
  "",
].join("\n");

const taskDoc = (name: string) => [
  "---",
  `name: ${name}`,
  `description: ${name} step of the alpha workflow`,
  "---",
  "",
  `# ${name}`,
  "",
  `Perform the ${name} step. Distinctive token: quokka-${name}.`,
  "",
  "## Acceptance Criteria",
  "",
  `- [ ] the ${name} output exists`,
  "",
].join("\n");

interface SquadSpec {
  slug: string;
  protocol: string;
  /** file name inside workflows/ → content */
  workflows: Record<string, string>;
  /** entries of components.workflows as authored */
  workflowComponents: string[];
  /** capability invoke.ref as authored */
  invokeRef: string;
  /** extra YAML lines appended under the capability (already indented by 4) */
  capabilityExtra?: string[];
  /** extra top-level YAML lines */
  manifestExtra?: string[];
}

function writeSquad(root: string, spec: SquadSpec): string {
  const dir = join(root, spec.slug);
  for (const sub of ["agents", "tasks", "workflows"]) mkdirSync(join(dir, sub), { recursive: true });
  for (const a of ["planner", "builder"]) writeFileSync(join(dir, "agents", `${a}.md`), agentDoc(a), "utf8");
  for (const t of ["plan", "build"]) writeFileSync(join(dir, "tasks", `${t}.md`), taskDoc(t), "utf8");
  for (const [file, content] of Object.entries(spec.workflows)) {
    writeFileSync(join(dir, "workflows", file), content, "utf8");
  }
  const manifest = [
    `name: ${spec.slug}`,
    "version: 1.2.3",
    `protocol: "${spec.protocol}"`,
    "description: Fixture squad that plans and builds one artifact",
    "experimental_domains: true",
    "components:",
    "  agents: [planner, builder]",
    "  tasks: [plan, build]",
    `  workflows: [${spec.workflowComponents.join(", ")}]`,
    "capabilities:",
    "  - id: fixture.alpha.run",
    "    description: Plans and builds the alpha artifact end to end",
    "    domains: [fixture_domain]",
    "    produces: [alpha_artifact]",
    '    examples: ["build the alpha artifact from a brief"]',
    "    invoke:",
    "      type: workflow",
    `      ref: ${spec.invokeRef}`,
    ...(spec.capabilityExtra ?? []),
    ...(spec.manifestExtra ?? []),
    "",
  ].join("\n");
  writeFileSync(join(dir, "squad.yaml"), manifest, "utf8");
  return dir;
}

/** v5, `steps` + `depends_on`, workflow in YAML, refs carry the extension. */
export function v5StepsSquad(root: string, slug = "fixture-alpha"): string {
  return writeSquad(root, {
    slug, protocol: "5.0",
    workflows: { "alpha.yaml": ALPHA_GRAPH },
    workflowComponents: ["alpha.yaml"],
    invokeRef: "workflows/alpha.yaml",
  });
}

/** v5, `agent_sequence` dialect. */
export function v5AgentSequenceSquad(root: string, slug = "fixture-seq"): string {
  return writeSquad(root, {
    slug, protocol: "5.0",
    workflows: { "seq.yaml": SEQ_GRAPH },
    workflowComponents: ["seq.yaml"],
    invokeRef: "workflows/seq.yaml",
  });
}

export function markdownWorkflow(graph: string, body: string, opts: { crlf?: boolean } = {}): string {
  const text = `---\n${graph}---\n${body ? `\n${body}` : ""}`;
  return opts.crlf ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * The v5 steps squad after a pure migration: the same graph as frontmatter of
 * `workflows/alpha.md`, no prose added, refs without the extension where the
 * component list allows it. `body` and `crlf` exist for the tests that need
 * prose or Windows line endings; the default is the byte-faithful rename.
 */
export function migratedToMarkdown(root: string, slug = "fixture-alpha", opts: { body?: string; crlf?: boolean; protocol?: string } = {}): string {
  return writeSquad(root, {
    slug, protocol: opts.protocol ?? "6.0",
    workflows: { "alpha.md": markdownWorkflow(ALPHA_GRAPH, opts.body ?? "", { crlf: opts.crlf }) },
    workflowComponents: ["alpha"],
    invokeRef: "workflows/alpha.md",
  });
}

/** Minimal v6: markdown workflow with prose, and the optional v6 capability fields. */
export function v6MarkdownSquad(root: string, slug = "fixture-v6"): string {
  return writeSquad(root, {
    slug, protocol: "6.0",
    workflows: { "alpha.md": markdownWorkflow(ALPHA_GRAPH, ALPHA_BODY) },
    workflowComponents: ["alpha"],
    invokeRef: "workflows/alpha.md",
    capabilityExtra: [
      "    acceptance:",
      "      - id: artifact_built",
      "        description: the alpha artifact exists after the build step",
      "        blocking: true",
      "        minimumScore: 0.8",
      "    requires: [other-squad:fixture.beta.run]",
      "    consumes: [beta_artifact]",
    ],
  });
}

/** Mixed: `x.md` and `x.yaml` share a stem (the la-bottega case), plus a capitalised stem. */
export function collisionSquad(root: string, slug = "fixture-twins"): string {
  return writeSquad(root, {
    slug, protocol: "5.0",
    workflows: {
      "x.yaml": ALPHA_GRAPH.replace("name: alpha", "name: x"),
      "x.md": markdownWorkflow(ALPHA_GRAPH.replace("name: alpha", "name: x"), ALPHA_BODY),
      "Beta.yaml": SEQ_GRAPH.replace("workflow_name: seq", "workflow_name: beta"),
    },
    workflowComponents: ["x.yaml"],
    invokeRef: "workflows/x.yaml",
  });
}

/** v4 manifest with no capabilities: what the inferrer reads. */
export function v4Squad(root: string, workflowFile: string, slug = "fixture-v4"): string {
  const dir = join(root, slug);
  mkdirSync(join(dir, "workflows"), { recursive: true });
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", "planner.md"), agentDoc("planner"), "utf8");
  const content = workflowFile.endsWith(".md") ? markdownWorkflow(ALPHA_GRAPH, ALPHA_BODY) : ALPHA_GRAPH;
  writeFileSync(join(dir, "workflows", workflowFile), content, "utf8");
  writeFileSync(join(dir, "squad.yaml"), [
    `name: ${slug}`,
    "version: 1.0.0",
    'protocol: "4.0"',
    "description: Legacy fixture squad without capabilities",
    "components:",
    "  agents: [planner]",
    "  workflows: [alpha]",
    "",
  ].join("\n"), "utf8");
  return dir;
}

// ── businesses ───────────────────────────────────────────────────────────────

function writeBusiness(root: string, slug: string, manifestLines: string[], employeeLines: string[]): string {
  const dir = join(root, slug);
  mkdirSync(join(dir, "employees"), { recursive: true });
  writeFileSync(join(dir, "business.yaml"), manifestLines.join("\n") + "\n", "utf8");
  writeFileSync(join(dir, "employees", "intake.md"), [
    "---",
    ...employeeLines,
    "---",
    "",
    "# Intake",
    "",
    "Receives every brief of the fixture business and answers it.",
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(dir, "org-chart.yaml"), "chart:\n  - id: intake\n    reports_to: null\n", "utf8");
  return dir;
}

const BUSINESS_BASE = (slug: string, protocol: string) => [
  `name: ${slug}`,
  "version: 1.0.0",
  `protocol: "${protocol}"`,
  "description: Fixture business with a single intake employee",
  "domains: [fixture_domain]",
  "produces: [fixture_report]",
  "runtime_requirements:",
  "  policy: declared",
  "  minimum:",
  "    - runtime: claude-code",
];

const EMPLOYEE_BASE = [
  "name: intake",
  "role: Intake",
  "description: Receives the brief and answers it with the fixture report",
  "is_brief_intake: true",
];

export function businessV1(root: string, slug = "fixture-biz-v1"): string {
  return writeBusiness(root, slug, BUSINESS_BASE(slug, "1.0"), EMPLOYEE_BASE);
}

/** Minimal v2: the new optional fields, all of them without semantics in this cut. */
export function businessV2(root: string, slug = "fixture-biz-v2"): string {
  return writeBusiness(root, slug, [
    ...BUSINESS_BASE(slug, "2.0"),
    "squads_preferred: [fixture-alpha]",
    "not_for: [legal advice, tax filing]",
    "run_budget_usd: 5",
  ], [
    ...EMPLOYEE_BASE,
    "pinned_mind_clones: [jane-doe]",
    "squads_preferred: [fixture-alpha]",
    "acceptance:",
    "  - id: report_delivered",
    "    description: the fixture report exists and is longer than a stub",
    "    blocking: true",
    "    minimum_score: 0.8",
    "    path: outputs/report.md",
    "    min_bytes: 200",
  ]);
}

// ── mind-clone ───────────────────────────────────────────────────────────────

export function mindClone(root: string, slug = "jane-doe"): string {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MANIFEST.yaml"), [
    `name: ${slug}`,
    "category: storytelling-narrative",
    "validation_verdict: APPROVED",
    "source_material:",
    "  primary: [a-book]",
    "routing:",
    '  one_liner: "Jane Doe — the choice for planted-fixture storytelling"',
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(dir, "AGENT.md"), "# Jane Doe\n\n## Voice\n\nShort sentences.\n", "utf8");
  writeFileSync(join(dir, "SOUL.md"), "# Soul\n\nCuriosity first.\n", "utf8");
  return dir;
}

// ── legacy surface ───────────────────────────────────────────────────────────

/**
 * What the schema-2 extractor wrote for this directory: workflow keys and
 * capability bindings carrying the file extension, `.md` workflows unlisted.
 * Hashes are copied from the schema-3 extraction because the per-file hash
 * function did not change; only the keys did.
 */
export function schema2Surface(dir: string): Surface {
  const current = extractSurface(dir);
  const manifest = parseYaml(readFileSync(join(dir, "squad.yaml"), "utf8")) as any;
  const bindings = new Map<string, string>();
  for (const cap of manifest.capabilities ?? []) bindings.set(`capability:${cap.id}`, `${cap.invoke.type}:${cap.invoke.ref}`);
  const yamlFiles = readdirSync(join(dir, "workflows")).filter((f) => /\.ya?ml$/.test(f)).sort();
  const entries: Record<string, SurfaceEntry> = {};
  for (const [key, entry] of Object.entries(current.entries)) {
    if (entry.type === "workflow") continue;
    const e: SurfaceEntry = { ...entry };
    if (bindings.has(key)) e.binding = bindings.get(key);
    entries[key] = e;
  }
  for (const f of yamlFiles) {
    const stem = f.replace(/\.ya?ml$/, "").toLowerCase();
    const e = current.entries[`workflow:workflows/${stem}`];
    entries[`workflow:workflows/${f}`] = { type: "workflow", hash: e?.hash ?? "missing" };
  }
  const ordered: Record<string, SurfaceEntry> = {};
  for (const k of Object.keys(entries).sort()) ordered[k] = entries[k];
  return { ...current, schema: 2, entries: ordered };
}
