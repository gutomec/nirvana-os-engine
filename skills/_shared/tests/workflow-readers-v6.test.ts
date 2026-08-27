/**
 * Readers stop depending on the workflow file extension.
 *
 * Squad Protocol v6 moves workflows to Markdown (frontmatter graph + prose
 * body). Before any content can move, every engine reader that assumed
 * `workflows/*.yaml` has to accept `.md` and keep returning exactly what it
 * returned for `.yaml`. The cases here state that as invariants over one graph
 * written in both encodings (see fixtures/protocol-entities.ts), so a v5 squad
 * cannot change behavior without a test changing result.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { contractBreaks } from "../lib/contract-breaks.ts";
import { extractSurface, writeSurface } from "../lib/surface.ts";
import { diffSurfaces } from "../lib/surface-diff.ts";
import { checkPortability } from "../../squads/lib/squad-doctor.ts";
import {
  collisionSquad, markdownWorkflow, ALPHA_GRAPH, migratedToMarkdown, schema2Surface, tmpRoot,
  v4Squad, v5AgentSequenceSquad, v5StepsSquad, v6MarkdownSquad,
} from "./fixtures/protocol-entities.ts";

const require_ = createRequire(import.meta.url);
const REPO = join(import.meta.dir, "..", "..", "..");
const SKILLS = join(REPO, "skills");
const bodyIndex = require_(join(SKILLS, "_shared", "lib", "body-index.js"));
const assetMeta = require_(join(SKILLS, "_shared", "lib", "asset-meta.js"));
const criteria = require_(join(SKILLS, "squads", "lib", "squad-audit-criteria.js"));
const fixers = require_(join(SKILLS, "squads", "lib", "mechanical-fixers.js"));
const inferrer = require_(join(SKILLS, "squads", "lib", "v4-capability-inferrer.js"));

const ROOTS: string[] = [];
function root(): string { const r = tmpRoot(); ROOTS.push(r); return r; }
afterAll(() => { for (const r of ROOTS) try { rmSync(r, { recursive: true, force: true }); } catch {} });

/**
 * The squads libs resolve `validators.ts` from NIRVANA_SKILLS_DIR when they are
 * loaded, and `bun test` loads every file into one process. A child process is
 * the only way to point them at this checkout without leaking the variable into
 * whichever test file loads next.
 */
function runBun(script: string, args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: REPO, encoding: "utf8",
    env: { ...process.env, NIRVANA_SKILLS_DIR: SKILLS, ...extraEnv },
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const manifestOf = (dir: string) => join(dir, "squad.yaml");
const workflowInvoke = (ref: string) => ({ type: "workflow", ref });

describe("body-index: one graph, one body text, whatever the encoding", () => {
  test("bodyTextFor(yaml) === bodyTextFor(md) for an identical graph with no new prose", () => {
    const r = root();
    const fromYaml = bodyIndex.bodyTextFor(manifestOf(v5StepsSquad(r)), workflowInvoke("workflows/alpha.yaml"));
    const fromMd = bodyIndex.bodyTextFor(manifestOf(migratedToMarkdown(r)), workflowInvoke("workflows/alpha.md"));
    expect(fromYaml.length).toBeGreaterThan(0);
    expect(fromMd).toBe(fromYaml);
    // The expansion still reaches the tasks and agents behind the graph.
    expect(fromMd).toContain("quokka-plan");
    expect(fromMd).toContain("quokka-build");
    // The graph itself is retained for a Markdown file exactly as for YAML:
    // the frontmatter is unwrapped, not stripped as front matter noise.
    expect(fromMd).toContain("Plan the alpha artifact");
  });

  test("an extensionless ref resolves; with twins on disk, .md wins the bare ref and an explicit ref stays explicit", () => {
    const dir = collisionSquad(root());
    const explicit = bodyIndex.bodyTextFor(manifestOf(dir), workflowInvoke("workflows/x.yaml"));
    const bare = bodyIndex.bodyTextFor(manifestOf(dir), workflowInvoke("workflows/x"));
    expect(explicit).not.toContain("Assemble the deliverable");
    expect(bare).toContain("Assemble the deliverable");
  });

  test("prose in the Markdown body enters the body text", () => {
    const text = bodyIndex.bodyTextFor(manifestOf(v6MarkdownSquad(root())), workflowInvoke("workflows/alpha.md"));
    expect(text).toContain("Assemble the deliverable from the plan");
  });

  test("CRLF frontmatter yields the same body text as its LF twin", () => {
    const r = root();
    const lf = bodyIndex.bodyTextFor(manifestOf(migratedToMarkdown(r, "fixture-lf")), workflowInvoke("workflows/alpha"));
    const crlf = bodyIndex.bodyTextFor(manifestOf(migratedToMarkdown(r, "fixture-crlf", { crlf: true })), workflowInvoke("workflows/alpha"));
    expect(crlf).toBe(lf);
  });

  test("the agent_sequence dialect keeps its (regex-only) expansion", () => {
    const text = bodyIndex.bodyTextFor(manifestOf(v5AgentSequenceSquad(root())), workflowInvoke("workflows/seq.yaml"));
    expect(text).toContain("planner");
    expect(text).toContain("builder");
  });
});

describe("asset-meta: a workflow is a workflow in either encoding", () => {
  test("workflows/*.md is typed workflow, frontmatter parsed, body kept", () => {
    const meta = assetMeta.loadMeta(join(v6MarkdownSquad(root()), "workflows", "alpha.md"));
    expect(meta.error).toBeNull();
    expect(meta.type).toBe("workflow");
    expect(meta.format).toBe("frontmatter");
    expect(meta.raw.name).toBe("alpha");
    expect(meta.raw.steps).toHaveLength(2);
    expect(meta.body).toContain("## plan");
  });

  test("workflows/*.yaml keeps its type; tasks and agents keep theirs", () => {
    const dir = v5StepsSquad(root());
    const wf = assetMeta.loadMeta(join(dir, "workflows", "alpha.yaml"));
    expect(wf.type).toBe("workflow");
    expect(wf.format).toBe("yaml");
    expect(wf.raw.steps).toHaveLength(2);
    expect(assetMeta.loadMeta(join(dir, "tasks", "plan.md")).type).toBe("task");
    expect(assetMeta.loadMeta(join(dir, "agents", "planner.md")).type).toBe("agent");
  });

  test("CRLF frontmatter parses", () => {
    const dir = migratedToMarkdown(root(), "fixture-crlf", { crlf: true, body: "## plan\r\n\r\nWindows prose.\r\n" });
    const meta = assetMeta.loadMeta(join(dir, "workflows", "alpha.md"));
    expect(meta.error).toBeNull();
    expect(meta.type).toBe("workflow");
    expect(meta.raw.name).toBe("alpha");
    expect(meta.raw.steps.map((s: any) => s.id)).toEqual(["plan", "build"]);
    expect(meta.body).toContain("Windows prose.");
  });
});

describe("capability-validator: components and refs resolve to .md", () => {
  const validator = join(SKILLS, "squads", "lib", "capability-validator.js");

  test("a v6 squad with workflows/alpha.md and a bare component name is valid, with no unknown-protocol warning", () => {
    const r = runBun(validator, ["squad", v6MarkdownSquad(root())]);
    const out = JSON.parse(r.stdout);
    expect(out.errors).toEqual([]);
    expect(out.valid).toBe(true);
    expect(out.warnings.filter((w: string) => /unknown protocol/i.test(w))).toEqual([]);
    expect(out.warnings.filter((w: string) => /does not resolve on disk/i.test(w))).toEqual([]);
    expect(out.referenced_files.workflows[0].exists).toBe(true);
    expect(out.referenced_files.workflows[0].path.endsWith("alpha.md")).toBe(true);
    expect(r.code).toBe(0);
  });

  test("the v5 squad validates as before, resolving to alpha.yaml", () => {
    const r = runBun(validator, ["squad", v5StepsSquad(root())]);
    const out = JSON.parse(r.stdout);
    expect(out.valid).toBe(true);
    expect(out.referenced_files.workflows[0].path.endsWith("alpha.yaml")).toBe(true);
  });

  test("a bare component with twins on disk resolves to the .md", () => {
    const dir = collisionSquad(root());
    const manifest = readFileSync(manifestOf(dir), "utf8").replace("workflows: [x.yaml]", "workflows: [x]");
    writeFileSync(manifestOf(dir), manifest, "utf8");
    const out = JSON.parse(runBun(validator, ["squad", dir]).stdout);
    expect(out.referenced_files.workflows[0].exists).toBe(true);
    expect(out.referenced_files.workflows[0].path.endsWith("x.md")).toBe(true);
  });
});

describe("squad-doctor: portability scans workflows in YAML and in Markdown", () => {
  test("a leak in workflows/alpha.yaml is found (it used to be skipped), and one in a .md too", () => {
    const dir = v5StepsSquad(root());
    appendFileSync(join(dir, "workflows", "alpha.yaml"), "# see ~/.claude/skills for the runner\n", "utf8");
    writeFileSync(join(dir, "workflows", "leak.md"), markdownWorkflow(ALPHA_GRAPH, "## plan\n\nRead CLAUDE.md first.\n"), "utf8");
    const where = checkPortability(dir).map((f) => f.where);
    expect(where).toContain("workflows/alpha.yaml");
    expect(where).toContain("workflows/leak.md");
  });

  test("a clean squad has no portability findings in either encoding", () => {
    const r = root();
    expect(checkPortability(v5StepsSquad(r))).toEqual([]);
    expect(checkPortability(v6MarkdownSquad(r))).toEqual([]);
  });
});

describe("contract surface: a v5 install meets its Markdown twin without a single break", () => {
  test("contractBreaks(installed with schema 2 surface, incoming with schema 3 surface) === []", () => {
    const installed = v5StepsSquad(root());
    writeSurface(installed, schema2Surface(installed));
    const incoming = migratedToMarkdown(root());
    writeSurface(incoming, extractSurface(incoming));
    expect(contractBreaks(installed, incoming, "squads/fixture-alpha")).toEqual([]);
  });

  test("with both surfaces on schema 3 the migration is a patch, still no break", () => {
    const installed = v5StepsSquad(root());
    writeSurface(installed, extractSurface(installed));
    const incoming = migratedToMarkdown(root());
    writeSurface(incoming, extractSurface(incoming));
    expect(contractBreaks(installed, incoming, "squads/fixture-alpha")).toEqual([]);
    expect(diffSurfaces(extractSurface(installed), extractSurface(incoming)).bump).toBe("patch");
  });
});

describe("audit criteria, fixers and the v4 inferrer see .md workflows", () => {
  const criterion = (dir: string, id: number) => criteria.scoreSquad(dir).breakdown.find((b: any) => b.id === id);

  test("c1 scores protocol 6.0 as 5.0 and proposes no protocol patch", () => {
    const c1 = criterion(v6MarkdownSquad(root()), 1);
    expect(c1.score).toBe(c1.max);
    expect(c1.evidence).toContain("protocol=6.0");
    expect(c1.fixable_diff).toBeNull();
    expect(criterion(v5StepsSquad(root()), 1).score).toBe(8);
  });

  test("c7 lists .md workflows and resolves their refs; .yaml scores as before", () => {
    const md = criterion(v6MarkdownSquad(root()), 7);
    expect(md.evidence).toContain("1/1 workflows resolve");
    expect(md.score).toBe(md.max);
    const yaml = criterion(v5StepsSquad(root()), 7);
    expect(yaml.evidence).toContain("1/1 workflows resolve");
    expect(yaml.score).toBe(yaml.max);
    expect(criterion(collisionSquad(root()), 7).evidence).toContain("3/3 workflows resolve");
  });

  test("components_files_stub leaves an existing .md or .yml alone and only ever creates .yaml", () => {
    const dir = migratedToMarkdown(root());
    writeFileSync(join(dir, "workflows", "delta.yml"), ALPHA_GRAPH.replace("name: alpha", "name: delta"), "utf8");
    const manifest = readFileSync(manifestOf(dir), "utf8").replace("workflows: [alpha]", "workflows: [alpha, delta, gamma]");
    writeFileSync(manifestOf(dir), manifest, "utf8");
    const results = fixers.applyMechanicalFixes(dir, { patches: [{ kind: "components_files_stub" }] });
    expect(results[0].result.created).toEqual(["workflows/gamma.yaml"]);
    expect(existsSync(join(dir, "workflows", "alpha.yaml"))).toBe(false);
    expect(existsSync(join(dir, "workflows", "delta.yaml"))).toBe(false);
    expect(existsSync(join(dir, "workflows", "gamma.yaml"))).toBe(true);
  });

  test("the inferrer accepts .md and .yml on disk and keeps emitting .yaml when that is what exists", () => {
    const r = root();
    const md = v4Squad(r, "alpha.md", "fixture-v4-md");
    const mdCaps = inferrer.inferCapabilities(parseYaml(readFileSync(manifestOf(md), "utf8")), md);
    expect(mdCaps[0].invoke).toEqual({ type: "workflow", ref: "workflows/alpha.md" });
    expect(mdCaps[0].description).toContain("Plan the alpha artifact");
    const yaml = v4Squad(r, "alpha.yaml", "fixture-v4-yaml");
    const yamlCaps = inferrer.inferCapabilities(parseYaml(readFileSync(manifestOf(yaml), "utf8")), yaml);
    expect(yamlCaps[0].invoke).toEqual({ type: "workflow", ref: "workflows/alpha.yaml" });
    // The namespace comes from the squad slug; the workflow-derived tail is what the encoding must not change.
    for (const caps of [mdCaps, yamlCaps]) expect(caps[0].capability_id.endsWith(".alpha.execute")).toBe(true);
    expect(inferrer.slugifyWorkflowId("alpha.md")).toBe("alpha");
    expect(inferrer.slugifyWorkflowId("alpha.yaml")).toBe("alpha");
  });
});

describe("validate-squad: protocol 6.0 takes the capabilities branch", () => {
  const script = join(SKILLS, "squads", "scripts", "validate-squad.ts");

  test("a v6 squad passes through the capability validator", () => {
    const r = runBun(script, [v6MarkdownSquad(root())], { NIRVANA_PROJECT_ROOT: root() });
    expect(r.stdout).toContain("Protocol: 6.0");
    expect(r.stdout).toContain("[PASS] v6 manifest valid");
    expect(r.code).toBe(0);
  });

  test("a v5 squad prints exactly what it printed before", () => {
    const r = runBun(script, [v5StepsSquad(root())], { NIRVANA_PROJECT_ROOT: root() });
    expect(r.stdout).toContain("[PASS] v5 manifest valid");
    expect(r.code).toBe(0);
  });
});
