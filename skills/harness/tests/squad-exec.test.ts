// squad-exec.test.ts — the squad headless runner of a squad-only dispatch.
//
// Pins: prompt content, audit chain, session reuse with the one-cold-retry
// fallback, and the missing-squad failure. Zero-token via the runWithCascade
// seam.
// Runs with: bun test skills/harness/tests
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSquadHeadless, squadCloneInjection, buildSquadPrompt, capabilityContext, promptPath, executorManifest } from "../lib/squad-exec.ts";
import { sessionKey, putSession } from "../lib/session-store.ts";
import { SCOPE_GUARD_EN, scopeBoundary } from "../../_shared/lib/scope-guard.ts";
import { LIMITS } from "../../_shared/validators/limits.ts";

let tmp: string;
const savedLogsDir = process.env.HARNESS_LOGS_DIR;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-squadexec-"));
  process.env.HARNESS_LOGS_DIR = path.join(tmp, "logs");
});
afterEach(() => {
  if (savedLogsDir === undefined) delete process.env.HARNESS_LOGS_DIR;
  else process.env.HARNESS_LOGS_DIR = savedLogsDir;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

function scaffoldSquad(root: string, slug: string): string {
  const dir = path.join(root, slug);
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "squad.yaml"), `name: ${slug}\nMANIFEST-MARKER: yes\n`);
  fs.writeFileSync(path.join(dir, "agents", "lead.md"), "# Lead agent AGENT-MARKER");
  fs.writeFileSync(path.join(dir, "tasks", "do-it.md"), "# Do it TASK-MARKER");
  return dir;
}

function okCascadeResult(opts: any, sessionId: string | null = "sess-sq-1") {
  return {
    ok: true, runtime: opts.runtime, sessionId, result: "",
    costUsd: 0.02, exitCode: 0, stderr: "", durationMs: 7,
    handoffs: [], finalRuntime: opts.runtime,
  };
}

function readAudit(): any[] {
  const day = new Date().toISOString().slice(0, 10);
  const p = path.join(tmp, "logs", day, "audit.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => parseAuditLine(l));
}

describe("buildSquadPrompt — framing", () => {
  test("squad-only framing addresses the end user, not a synthesizer", () => {
    const squadsRoot = path.join(tmp, "squads");
    const squadDir = scaffoldSquad(squadsRoot, "brandcraft");
    const p = buildSquadPrompt({
      squadSlug: "brandcraft", squadDir, brief: "the brief",
      outDir: "/out/dir",
      cloneInjection: { block: "", decision: "DEFAULT" },
    });
    expect(p).toContain("end to end");
    expect(p).toContain("FINAL DELIVERABLE");
    expect(p).not.toContain("synthesizer do business");
  });

  test("the output ends with _SUMMARY.md, and work the brief places elsewhere is done there", () => {
    const squadDir = scaffoldSquad(path.join(tmp, "squads"), "brandcraft");
    const p = buildSquadPrompt({ squadSlug: "brandcraft", squadDir, brief: "the brief", outDir: "/out/dir", cloneInjection: { block: "", decision: "DEFAULT" } });
    expect(p.slice(p.indexOf("## OUTPUT"))).toContain(path.join("/out/dir", "_SUMMARY.md"));
    expect(p.slice(p.indexOf("## OUTPUT"))).toContain("Do not print a summary to stdout");
    expect(p).toContain("When the brief's work lives in another folder (a project to review or fix, a new project to create), do that work there");
    expect(p).not.toContain("nothing anywhere else");
  });

  test("the framing carries the scope guard, inside the sub-task block", () => {
    const squadDir = scaffoldSquad(path.join(tmp, "squads"), "brandcraft");
    const p = buildSquadPrompt({ squadSlug: "brandcraft", squadDir, brief: "the brief", outDir: "/out/dir", cloneInjection: { block: "", decision: "DEFAULT" } });
    const subTask = p.slice(p.indexOf("## YOUR SUB-TASK"), p.indexOf("## OUTPUT"));
    expect(subTask).toContain(SCOPE_GUARD_EN);
  });

  // The whole string, not a set of substrings: without a resolved capability the
  // prompt is the one the engine has always sent — plus the resource map, which
  // is the ONE deliberate departure from that invariant.
  //
  // This path is the fallback, and the fallback is the worst one: it carries an
  // alphabetical first-three of the squad's agents and tasks under a "(top 3)"
  // heading that never says three OF HOW MANY. A squad with eight agents showed
  // three and named none of the rest, and it is the path every hand-written
  // squad without `capabilities[]` lands on. Withholding the map here to keep
  // the pin green would have kept the invariant by keeping the defect.
  test("no capability: the prompt is the historical one plus the resource map", () => {
    const squadDir = scaffoldSquad(path.join(tmp, "squads"), "brandcraft");
    const expected = `You ARE the squad "brandcraft", running the client's brief end to end. Your output is the FINAL DELIVERABLE for the user.

## YOUR IDENTITY (squad.yaml)
\`\`\`yaml
name: brandcraft
MANIFEST-MARKER: yes

\`\`\`

## YOUR AGENTS (top 3)
--- lead.md ---
# Lead agent AGENT-MARKER

## YOUR TASKS (top 3)
--- do-it.md ---
# Do it TASK-MARKER

## WHAT ELSE THIS SQUAD CARRIES
Everything below exists in \`${squadDir}\` and is **not** in this prompt. Open what you need, when you need it, one level at a time. Nothing here is mandatory, and nothing here was summarized: the file on disk is the content. A name ending in \`/\` is a subdirectory, descend into it.

This directory is the source of the squad, shared by every project on this machine and read by every future run: **it is read-only for you**. Do not edit, create or delete anything here, not even to "fix" a template or note a result. Every file you produce goes to the output directory named in your sub-task.

- \`agents/\` — \`lead.md\`
- \`tasks/\` — \`do-it.md\`

## MIND-CLONES YOU EMBODY (decision: DEFAULT)
> Embody it fully; deliver AS IF the clone had produced it, under the squad's specialty.
(no clone for this task: operate with the squad's default specialty)

## CLIENT'S ORIGINAL BRIEF
the brief

## YOUR SUB-TASK
Run YOUR specialty applied to the brief above. Write your deliverables under \`/out/dir\`, in the format your specialty calls for. When the brief's work lives in another folder (a project to review or fix, a new project to create), do that work there and list every path you created or changed. If the deliverable includes images, they are really generated images, never a placeholder or a generic SVG. Method and tools are yours. Deliverables follow the language of the request. Do not invoke the harness skill, and do not run \`nrv run\`/\`nrv dispatch\` for this same brief (anti-loop).

If the brief mentions you by name (e.g. "use the brandcraft squad"), prioritize doing EXACTLY what the user asked in that paragraph. The user decides.

${SCOPE_GUARD_EN} Scope is the brief above and the acceptance criteria of your sub-task. ${scopeBoundary()}

## OUTPUT
Files in the directory above, then \`${path.join("/out/dir", "_SUMMARY.md")}\`: one page at most with what you delivered and where, the decisions you took, what is still open and the out-of-scope notes. Do not print a summary to stdout: the deliverables and that file are the output. Finish when the work is ready to hand to the user.`;
    const args = { squadSlug: "brandcraft", squadDir, brief: "the brief", outDir: "/out/dir", cloneInjection: { block: "", decision: "DEFAULT" } };
    expect(buildSquadPrompt(args)).toBe(expected);
    // The three ways of saying "no capability" all land on the same bytes.
    expect(buildSquadPrompt({ ...args, capabilityId: null })).toBe(expected);
    expect(buildSquadPrompt({ ...args, capabilityId: "squad.execute" })).toBe(expected);
    // As does a capability id the manifest does not declare.
    expect(buildSquadPrompt({ ...args, capabilityId: "branding.nothing.here" })).toBe(expected);
  });
});

// ── the capability sections (Squad Protocol v6 §32) ─────────────────────────

/** A squad whose capability names a workflow, with two agents and two tasks on
 *  disk of which the workflow runs one each. */
function scaffoldCapabilitySquad(root: string, slug = "guided", opts: { workflow?: string; body?: string } = {}): string {
  const dir = path.join(root, slug);
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(dir, "workflows"), { recursive: true });
  fs.writeFileSync(path.join(dir, "squad.yaml"), `name: ${slug}
version: 1.0.0
protocol: "6.0"
capabilities:
  - id: analysis.report.produce
    description: Produce the guided analysis report for one account.
    produces:
      - report.md
      - dataset.json
    acceptance:
      - id: ac-sources
        description: Every claim cites a dated source.
        blocking: true
        minimumScore: 0.9
      - id: ac-length
        description: The report stays under twelve pages.
    invoke:
      type: workflow
      ref: workflows/guided-analysis
  - id: analysis.dataset.extract
    description: Extract the raw dataset only.
    invoke:
      type: workflow
      ref: workflows/extract-only
`);
  fs.writeFileSync(path.join(dir, "agents", "analyst.md"), "# Analyst ANALYST-MARKER");
  fs.writeFileSync(path.join(dir, "agents", "aardvark.md"), "# Aardvark AARDVARK-MARKER");
  fs.writeFileSync(path.join(dir, "agents", "writer.md"), "# Writer WRITER-MARKER");
  fs.writeFileSync(path.join(dir, "tasks", "collect.md"), "# Collect COLLECT-MARKER");
  fs.writeFileSync(path.join(dir, "tasks", "aaa-first.md"), "# Alphabetically first AAA-MARKER");
  fs.writeFileSync(path.join(dir, "workflows", "guided-analysis.md"), opts.workflow ?? `---
name: guided-analysis
steps:
  - id: collect
    agent: analyst
    task: collect
    creates: [dataset.json]
  - id: write
    agent: writer
    requires: [collect]
    creates: [report.md]
---

## collect

BODY-COLLECT-MARKER: read the account and write the dataset.
`);
  fs.writeFileSync(path.join(dir, "workflows", "extract-only.yaml"), `name: extract-only
steps:
  - id: extract
    agent: analyst
    task: collect
`);
  return dir;
}

describe("squadCloneInjection, the rule the business path shares", () => {
  test("a marked clone that is not installed is reported in the prompt block, not dropped", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-squad-voices-"));
    try {
      const r = squadCloneInjection("## Request (verbatim)\nWrite it\n\n## Decisions\n- clone ghost-expert-xyz\n", cwd);
      expect(r.decision).toBe("REQUESTED by the user");
      expect(r.missingClones).toEqual(["ghost-expert-xyz"]);
      expect(r.block).toContain("MIND-CLONE MISSING: ghost-expert-xyz");
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  test("nothing asked for and nothing above the coverage gate: no clone", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-squad-voices-"));
    try {
      const r = squadCloneInjection("zzqx wibble frobnicate the hydraulic pump", cwd);
      expect(r.block).toBe("");
      expect(r.missingClones).toEqual([]);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});

describe("promptPath — the workflow reference reads the same on every platform", () => {
  // The Windows runner failed both capability cases of this file: `path.relative`
  // answers `workflows\guided-analysis.md` there, and the prompt then showed a
  // reference no `invoke.ref` ever declared. Forcing a literal backslash proves
  // the normalization off Windows too, instead of trusting the runner to catch it.
  test("a Windows separator becomes the POSIX one; a POSIX path is untouched", () => {
    expect(promptPath("workflows\\guided-analysis.md")).toBe("workflows/guided-analysis.md");
    expect(promptPath("workflows/guided-analysis.md")).toBe("workflows/guided-analysis.md");
    expect(promptPath(["workflows", "extract-only.yaml"].join(path.sep))).toBe("workflows/extract-only.yaml");
    expect(promptPath(promptPath("a\\b/c"))).toBe("a/b/c");
  });

  test("the context carries the reference the capability declares, never a native path", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"));
    const ctx = capabilityContext(squadDir, "analysis.report.produce")!;
    expect(ctx.workflow!.file).toBe("workflows/guided-analysis.md");
    expect(ctx.workflow!.file).not.toContain("\\");
  });
});

describe("buildSquadPrompt — the manifest the executor reads", () => {
  // Routing fields are what the router matches on; the squad that executes never
  // reads them, and they were 40–53% of a real squad.yaml pasted into every run.
  test("a resolved capability keeps its own contract and drops the routing fields", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads-manifest"));
    const yamlPath = path.join(squadDir, "squad.yaml");
    fs.writeFileSync(yamlPath, fs.readFileSync(yamlPath, "utf8")
      .replace("    produces:\n      - report.md", "    keywords: [KEYWORD-MARKER]\n    example_briefs: [\"BRIEF-MARKER\"]\n    not_for: [NOTFOR-MARKER]\n    produces:\n      - report.md")
      .replace("  - id: analysis.dataset.extract\n    description: Extract the raw dataset only.", "  - id: analysis.dataset.extract\n    description: Extract the raw dataset only.\n    keywords: [OTHER-KEYWORD-MARKER]\n    acceptance:\n      - id: other-ac\n        description: OTHER-ACCEPTANCE-MARKER"));
    for (const marker of ["KEYWORD-MARKER", "BRIEF-MARKER", "NOTFOR-MARKER", "OTHER-KEYWORD-MARKER", "OTHER-ACCEPTANCE-MARKER"]) {
      expect(fs.readFileSync(yamlPath, "utf8")).toContain(marker);
    }
    const p = buildSquadPrompt({
      squadSlug: "guided", squadDir, brief: "analise a conta", outDir: "/out/dir",
      cloneInjection: { block: "", decision: "DEFAULT" }, capabilityId: "analysis.report.produce",
    });
    const identity = p.slice(p.indexOf("## YOUR IDENTITY"), p.indexOf("## YOUR CAPABILITY"));
    for (const gone of ["KEYWORD-MARKER", "BRIEF-MARKER", "NOTFOR-MARKER", "OTHER-KEYWORD-MARKER", "OTHER-ACCEPTANCE-MARKER"]) expect(p).not.toContain(gone);
    expect(identity).toContain("workflows/guided-analysis");
    expect(identity).toContain("analysis.dataset.extract");
    expect(identity).toContain("Extract the raw dataset only.");
  });

  test("the raw file stays when the manifest does not parse", () => {
    expect(executorManifest("name: [unclosed", "x.y.z")).toBe("name: [unclosed");
  });
});

describe("buildSquadPrompt — the event-contract block (event-contract cut)", () => {
  // Cut 1 (#157) measured the gap this closes: 286 rogue event types across
  // 964 occurrences, and zero correctly `x_`-prefixed sites in the library —
  // because nothing the dispatched agent reads told it the vocabulary exists.
  test("a prompt built for a squad with a resolved capability contains the contract", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"));
    const p = buildSquadPrompt({
      squadSlug: "guided", squadDir, brief: "analise a conta", outDir: "/out/dir",
      cloneInjection: { block: "", decision: "DEFAULT" },
      capabilityId: "analysis.report.produce", traceId: "01HZ-trace-x",
    });
    expect(p).toContain("## HOW TO REPORT EVENTS");
    expect(p).toContain("nrv audit emit");
    expect(p).toContain("--squad=guided");
    expect(p).toContain("--trace=01HZ-trace-x");
    expect(p).toContain("`x_` prefix");
    // No payload/secret guidance, stated explicitly rather than implied.
    expect(p).toContain("never the whole brief, a full output or a secret");
    // Rides right after the capability block, before the agents/tasks sections.
    expect(p.indexOf("## YOUR CAPABILITY")).toBeLessThan(p.indexOf("## HOW TO REPORT EVENTS"));
    expect(p.indexOf("## HOW TO REPORT EVENTS")).toBeLessThan(p.indexOf("## YOUR AGENTS"));
  });

  test("without a trace id, the example command falls back to a placeholder instead of dropping the block", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"));
    const p = buildSquadPrompt({
      squadSlug: "guided", squadDir, brief: "b", outDir: "/o",
      cloneInjection: { block: "", decision: "DEFAULT" },
      capabilityId: "analysis.report.produce",
    });
    expect(p).toContain("## HOW TO REPORT EVENTS");
    expect(p).toContain("--trace=<trace_id>");
  });

  test("a squad with no resolved capability gets no contract block — the historical prompt is untouched", () => {
    const squadDir = scaffoldSquad(path.join(tmp, "squads"), "brandcraft");
    const p = buildSquadPrompt({
      squadSlug: "brandcraft", squadDir, brief: "the brief", outDir: "/out/dir",
      cloneInjection: { block: "", decision: "DEFAULT" },
    });
    expect(p).not.toContain("## HOW TO REPORT EVENTS");
  });
});

describe("buildSquadPrompt — with a resolved capability", () => {
  test("the capability, its workflow and only the referenced components reach the prompt", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"));
    const p = buildSquadPrompt({
      squadSlug: "guided", squadDir, brief: "analise a conta", outDir: "/out/dir",
      cloneInjection: { block: "", decision: "DEFAULT" },
      capabilityId: "analysis.report.produce",
    });
    expect(p).toContain("## YOUR CAPABILITY");
    expect(p).toContain("- **id**: `analysis.report.produce`");
    expect(p).toContain("- **description**: Produce the guided analysis report for one account.");
    expect(p).toContain("- **produces**: report.md, dataset.json");
    expect(p).toContain("- `ac-sources` (blocking, minimum score 0.9) — Every claim cites a dated source.");
    expect(p).toContain("- `ac-length` — The report stays under twelve pages.");

    expect(p).toContain("## YOUR WORKFLOW (`workflows/guided-analysis.md`)");
    expect(p).toContain("| 1 | `collect` | `analyst` | `collect` | — | dataset.json |");
    expect(p).toContain("| 2 | `write` | `writer` | — | `collect` | report.md |");
    // The prose body of a Markdown workflow travels with the graph, as the author's
    // reference method: dependencies bind, the rest is the executor's.
    expect(p).toContain("BODY-COLLECT-MARKER");
    expect(p).toContain("the squad author's reference method");
    expect(p).not.toContain("Run the steps in this order");
    expect(p).toContain("- **done when** (acceptance criteria");

    // Referenced components only, in step order — never the alphabetical top 3.
    expect(p).toContain("## YOUR AGENTS\n");
    expect(p).not.toContain("(top 3)");
    expect(p).toContain("ANALYST-MARKER");
    expect(p).toContain("WRITER-MARKER");
    expect(p).not.toContain("AARDVARK-MARKER");
    expect(p).toContain("COLLECT-MARKER");
    expect(p).not.toContain("AAA-MARKER");
    expect(p.indexOf("ANALYST-MARKER")).toBeLessThan(p.indexOf("WRITER-MARKER"));
  });

  test("a legacy YAML workflow normalizes through the same reader", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"));
    const p = buildSquadPrompt({
      squadSlug: "guided", squadDir, brief: "b", outDir: "/o",
      cloneInjection: { block: "", decision: "DEFAULT" }, capabilityId: "analysis.dataset.extract",
    });
    expect(p).toContain("## YOUR WORKFLOW (`workflows/extract-only.yaml`)");
    expect(p).toContain("| 1 | `extract` | `analyst` | `collect` | — | — |");
    expect(p).toContain("ANALYST-MARKER");
    expect(p).not.toContain("WRITER-MARKER");
    // The framing is untouched by the capability sections.
    expect(p).toContain("Your output is the FINAL DELIVERABLE for the user.");
  });

  test("a capability whose invoke.ref resolves to nothing keeps the top-3 blocks and says so", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"));
    fs.rmSync(path.join(squadDir, "workflows", "extract-only.yaml"));
    const p = buildSquadPrompt({
      squadSlug: "guided", squadDir, brief: "b", outDir: "/o",
      cloneInjection: { block: "", decision: "DEFAULT" }, capabilityId: "analysis.dataset.extract",
    });
    expect(p).toContain("- **id**: `analysis.dataset.extract`");
    expect(p).toContain("does not point to a readable workflow");
    expect(p).toContain("## YOUR AGENTS (top 3)");
    expect(p).toContain("AARDVARK-MARKER");
  });

  test("the components ceiling is a target, not a cut: every document ships in full", () => {
    const max = Number(LIMITS.squad_prompt_components_bytes_max);
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"));
    fs.writeFileSync(path.join(squadDir, "agents", "analyst.md"), "A".repeat(max + 4096));
    fs.writeFileSync(path.join(squadDir, "agents", "writer.md"), "WRITER-MARKER");
    // A task big enough that the TASKS half would also have been cut by the old
    // ceiling: asserting only the agents half let a task-side regression pass.
    fs.writeFileSync(path.join(squadDir, "tasks", "collect.md"), "C".repeat(20_000) + "COLLECT-TAIL");
    const ctx = capabilityContext(squadDir, "analysis.report.produce")!;
    expect(ctx.components).not.toBeNull();
    // Over the ceiling, on purpose: no document on EITHER side is cut or dropped.
    expect(Buffer.byteLength(ctx.components!.agents, "utf8")).toBeGreaterThan(max);
    expect(ctx.components!.agents).toContain("A".repeat(max + 4096));
    expect(ctx.components!.agents).toContain("WRITER-MARKER");
    expect(ctx.components!.tasks).toContain("C".repeat(20_000));
    expect(ctx.components!.tasks).toContain("COLLECT-TAIL");
    for (const section of [ctx.components!.agents, ctx.components!.tasks]) {
      expect(section).not.toContain("truncated at the ceiling");
      expect(section).not.toContain("document(s) omitted");
    }
    // The crossing is flagged, not hidden — on the LAST section shown, so the
    // reader meets it after the content it measures, and exactly once across
    // the pair (a note emitted per section is the bug the sibling test pins).
    const both = `${ctx.components!.agents}\n${ctx.components!.tasks}`;
    expect(both.match(/above the ceiling of/g)).toHaveLength(1);
    expect(ctx.components!.tasks).toContain(`above the ceiling of ${max}`);
    // It answers for the ceiling only, so it never contradicts a missing-file note.
    expect(both).not.toContain("nothing was omitted");
  });

  // The regression this test exists for: the note used to be emitted from
  // inside the per-section renderer, which sees half the total. When the agents
  // section crossed the ceiling on its own, it reported ITS overage and silenced
  // the tasks section that would have counted the rest — understating by more
  // than 3x wherever the agents half was the large one.
  test("the overage counts BOTH sections, even when agents alone already crossed", () => {
    const max = Number(LIMITS.squad_prompt_components_bytes_max);
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"));
    fs.writeFileSync(path.join(squadDir, "agents", "analyst.md"), "A".repeat(max + 1_000));
    fs.writeFileSync(path.join(squadDir, "agents", "writer.md"), "W");
    fs.writeFileSync(path.join(squadDir, "tasks", "collect.md"), "C".repeat(50_000));
    const ctx = capabilityContext(squadDir, "analysis.report.produce")!;

    const real = Buffer.byteLength(ctx.components!.agents, "utf8")
      + Buffer.byteLength(ctx.components!.tasks, "utf8");
    const m = ctx.components!.tasks.match(/total (\d+) bytes, (\d+) above the ceiling of (\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![3])).toBe(max);
    // The reported total is the measured content; only the note's own bytes,
    // appended after the measurement, separate it from the rendered length.
    expect(Number(m![1])).toBeGreaterThan(max + 50_000);
    expect(real - Number(m![1])).toBeLessThan(256);
    expect(Number(m![2])).toBe(Number(m![1]) - max);
    // And the whole reason the note exists: nothing was lost to say it.
    expect(ctx.components!.agents).toContain("A".repeat(max + 1_000));
    expect(ctx.components!.tasks).toContain("C".repeat(50_000));
  });

  test("capabilityContext returns null on every path that must keep the historical prompt", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"));
    expect(capabilityContext(squadDir, "squad.execute")).toBeNull();
    expect(capabilityContext(squadDir, "analysis.nothing.here")).toBeNull();
    expect(capabilityContext(path.join(tmp, "squads", "no-such-squad"), "analysis.report.produce")).toBeNull();
  });
});

// Everything a squad ships beyond agents/ and tasks/ used to be invisible to the
// agent running it: references/, checklists/, templates/, standards/, schemas/,
// config/, scripts/, data/, tools/ and lib/ are all common in real squads, and
// none of it was named in the prompt or reachable — the directory itself was
// never granted.
describe("buildSquadPrompt — the resource map", () => {
  /** Add authored directories to a scaffolded squad. */
  function withResources(squadDir: string): string {
    fs.mkdirSync(path.join(squadDir, "references"), { recursive: true });
    fs.mkdirSync(path.join(squadDir, "checklists"), { recursive: true });
    fs.mkdirSync(path.join(squadDir, "references", "deep"), { recursive: true });
    fs.mkdirSync(path.join(squadDir, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(path.join(squadDir, "references", "state-of-the-art.md"), "x");
    fs.writeFileSync(path.join(squadDir, "references", ".hidden"), "x");
    fs.writeFileSync(path.join(squadDir, "checklists", "pre-flight.md"), "x");
    fs.writeFileSync(path.join(squadDir, "node_modules", "left-pad", "index.js"), "x");
    // Run state, which a squad materializes by being run in and which must never
    // be advertised as content.
    fs.mkdirSync(path.join(squadDir, ".runs", "demo"), { recursive: true });
    fs.writeFileSync(path.join(squadDir, ".runs", "demo", "out.md"), "x");
    fs.mkdirSync(path.join(squadDir, "outputs"), { recursive: true });
    fs.writeFileSync(path.join(squadDir, "outputs", "leftover.md"), "x");
    return squadDir;
  }

  // The exclusion list for run state has one owner, `isRunStatePath`. A private
  // second copy here is how a path that must never travel starts travelling.
  test("run state is never advertised, and the list that decides is the shared one", () => {
    const squadDir = withResources(scaffoldCapabilitySquad(path.join(tmp, "squads")));
    const p = buildSquadPrompt({
      squadSlug: "guided", squadDir, brief: "b", outDir: "/o",
      cloneInjection: { block: "", decision: "DEFAULT" }, capabilityId: "analysis.report.produce",
    });
    const map = p.slice(p.indexOf("## WHAT ELSE THIS SQUAD CARRIES"));
    expect(map).not.toContain(".runs");
    expect(map).not.toContain("outputs/");
    expect(map).not.toContain("leftover.md");
    // Authored content beside it is untouched.
    expect(map).toContain("`references/`");
  });

  test("names every authored directory, one level deep, and never node_modules", () => {
    const squadDir = withResources(scaffoldCapabilitySquad(path.join(tmp, "squads")));
    const p = buildSquadPrompt({
      squadSlug: "guided", squadDir, brief: "b", outDir: "/o",
      cloneInjection: { block: "", decision: "DEFAULT" }, capabilityId: "analysis.report.produce",
    });
    expect(p).toContain("## WHAT ELSE THIS SQUAD CARRIES");
    expect(p).toContain("`references/` — `deep/`, `state-of-the-art.md`");
    expect(p).toContain("`checklists/` — `pre-flight.md`");
    // A subdirectory is named with a trailing slash so the agent knows to descend.
    expect(p).toContain("`deep/`");
    // Dependency output would bury the map it is listed in.
    expect(p).not.toContain("node_modules");
    // Dotfiles are not authored content.
    expect(p).not.toContain(".hidden");
    // The three the prompt already carries are never repeated as a path.
    expect(p).not.toContain("`agents/` —");
    expect(p).not.toContain("`tasks/` —");
    expect(p).not.toContain("`workflows/` —");
  });

  // The gate the map deliberately does NOT ride: a legacy squad's prompt carries
  // an arbitrary alphabetical top-3 of its agents and tasks, so it is the one
  // with most of itself missing.
  test("a squad with no resolved capability gets the map too", () => {
    const squadDir = withResources(scaffoldSquad(path.join(tmp, "squads"), "legacy"));
    const p = buildSquadPrompt({
      squadSlug: "legacy", squadDir, brief: "b", outDir: "/o",
      cloneInjection: { block: "", decision: "DEFAULT" },
    });
    expect(p).toContain("## YOUR AGENTS (top 3)");
    expect(p).toContain("## WHAT ELSE THIS SQUAD CARRIES");
    expect(p).toContain("`references/`");
  });

  // What keeps the byte-identical pin honest rather than merely passing: a squad
  // that ships nothing outside the three inlined directories gets no section.
  test("a squad that ships nothing extra gets no section at all", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"), "bare");
    const p = buildSquadPrompt({
      squadSlug: "bare", squadDir, brief: "b", outDir: "/o",
      cloneInjection: { block: "", decision: "DEFAULT" }, capabilityId: "analysis.report.produce",
    });
    expect(p).not.toContain("WHAT ELSE THIS SQUAD CARRIES");
  });

  // The cap the map DOES have, and why it is not the mistake this file just
  // undid: a directory index is recoverable with one `ls`, so capping it costs
  // nothing, while an uncapped one would push a `data/` of fifty thousand files
  // into every prompt the squad ever runs.
  test("a huge directory is capped, and the overflow says how to see the rest", () => {
    const squadDir = scaffoldSquad(path.join(tmp, "squads"), "bulky");
    fs.mkdirSync(path.join(squadDir, "data"), { recursive: true });
    for (let i = 0; i < 400; i++) {
      fs.writeFileSync(path.join(squadDir, "data", `row-${String(i).padStart(4, "0")}.csv`), "x");
    }
    const p = buildSquadPrompt({
      squadSlug: "bulky", squadDir, brief: "b", outDir: "/o",
      cloneInjection: { block: "", decision: "DEFAULT" },
    });
    const map = p.slice(p.indexOf("## WHAT ELSE THIS SQUAD CARRIES"));
    expect(map).toContain("`row-0000.csv`");
    expect(map).toContain("and 350 more");
    expect(map).toContain("`ls`");
    // Bounded: the index cannot grow without limit with the directory.
    expect(Buffer.byteLength(map, "utf8")).toBeLessThan(4_096);
    // And it never claims the listing is the content.
    expect(map).toContain("the file on disk is the content");
  });

  // An empty directory is a directory with nothing to open.
  test("an empty authored directory is not advertised", () => {
    const squadDir = scaffoldCapabilitySquad(path.join(tmp, "squads"), "hollow");
    fs.mkdirSync(path.join(squadDir, "references"), { recursive: true });
    const p = buildSquadPrompt({
      squadSlug: "hollow", squadDir, brief: "b", outDir: "/o",
      cloneInjection: { block: "", decision: "DEFAULT" }, capabilityId: "analysis.report.produce",
    });
    expect(p).not.toContain("WHAT ELSE THIS SQUAD CARRIES");
  });
});

describe("runSquadHeadless", () => {
  test("dispatches through the cascade seam and emits dispatch_squad + agent_executed", () => {
    const squadsRoot = path.join(tmp, "squads");
    scaffoldSquad(squadsRoot, "brandcraft");
    const seen: any[] = [];
    const r = runSquadHeadless({
      squadSlug: "brandcraft", brief: "make a brand",
      projectId: "proj-sq-1", projectDir: tmp, projectRoot: tmp,
      outputsDir: path.join(tmp, "out"), runtime: "claude-code",
     
      autonomousDirective: "DIRECTIVE-MARKER ",
      squadsRoot,
      runWithCascadeImpl: ((opts: any) => { seen.push(opts); return okCascadeResult(opts); }) as any,
    });
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe("sess-sq-1");
    expect(fs.existsSync(path.join(tmp, "out"))).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].prompt).toContain("MANIFEST-MARKER");
    expect(seen[0].appendSystemPrompt).toContain("DIRECTIVE-MARKER");
    const events = readAudit();
    const ds = events.find(e => e.event === "dispatch_squad");
    expect(ds).toBeTruthy();
    expect(ds.squad_slug).toBe("brandcraft");
    expect(ds.mode).toBe("squad-only");
    const ax = events.find(e => e.event === "agent_executed");
    expect(ax).toBeTruthy();
    expect(ax.mode).toBe("squad-only");
    expect(ax.employee).toBe("squad:brandcraft");
    // The size of what we just built, on the event where runs are inspected —
    // and the number that decides whether the run crossed the argv threshold.
    expect(ds.prompt_bytes).toBe(Buffer.byteLength(seen[0].prompt, "utf8"));
  });

  // The resource map names paths under the squad; on claude-code and agy an
  // ungranted path is refused, so without this the map would be a sign on a
  // locked door.
  test("the squad's own directory is granted, so the map it advertises can be opened", () => {
    const squadsRoot = path.join(tmp, "squads");
    const squadDir = scaffoldSquad(squadsRoot, "brandcraft");
    const seen: any[] = [];
    runSquadHeadless({
      squadSlug: "brandcraft", brief: "make a brand",
      projectId: "proj-sq-grant", projectDir: tmp, projectRoot: tmp,
      outputsDir: path.join(tmp, "out"), runtime: "claude-code",
     
      autonomousDirective: "D ",
      squadsRoot,
      runWithCascadeImpl: ((opts: any) => { seen.push(opts); return okCascadeResult(opts); }) as any,
    });
    expect(seen[0].addDirs).toContain(squadDir);
    // Without displacing the two it already granted.
    expect(seen[0].addDirs).toContain(tmp);
    expect(seen[0].addDirs).toContain(path.join(tmp, "out"));
  });

  test("missing squad dir → ok:false + squad_run_failed, cascade never invoked", () => {
    const seen: any[] = [];
    const r = runSquadHeadless({
      squadSlug: "no-such-squad", brief: "b",
      projectId: "proj-sq-3", projectDir: tmp, projectRoot: tmp,
      outputsDir: path.join(tmp, "out3"), runtime: "claude-code",
     
      autonomousDirective: "D",
      squadsRoot: path.join(tmp, "squads-empty"),
      runWithCascadeImpl: ((opts: any) => { seen.push(opts); return okCascadeResult(opts); }) as any,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("squad dir not found");
    expect(seen).toHaveLength(0);
    expect(readAudit().some(e => e.event === "squad_run_failed")).toBe(true);
  });

  test("session reuse: prior session is resumed; a failed resume retries ONCE cold", () => {
    const squadsRoot = path.join(tmp, "squads");
    scaffoldSquad(squadsRoot, "brandcraft");
    const key = sessionKey("claude-code", "squad", "brandcraft");
    putSession(tmp, key, "claude-code", "stale-session-id");
    const seen: any[] = [];
    const r = runSquadHeadless({
      squadSlug: "brandcraft", brief: "b",
      projectId: "proj-sq-4", projectDir: tmp, projectRoot: tmp,
      outputsDir: path.join(tmp, "out4"), runtime: "claude-code",
     
      autonomousDirective: "D",
      squadsRoot,
      runWithCascadeImpl: ((opts: any) => {
        seen.push(opts);
        if (opts.sessionId === "stale-session-id") {
          return { ...okCascadeResult(opts, null), ok: false, exitCode: 1, error: "resume failed" };
        }
        return okCascadeResult(opts, "fresh-session");
      }) as any,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0].sessionId).toBe("stale-session-id");
    expect(seen[1].sessionId).toBeUndefined(); // cold retry
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe("fresh-session");
    expect(readAudit().some(e => e.event === "session_resume_failed")).toBe(true);
  });
});

// A squad slug reaches runSquadHeadless unvalidated: the explicit-target layer
// of the dispatch cascade returns what the caller named with no registry lookup,
// and the target pattern admits dots and separators. `--squad=..` resolved to the
// parent of the squads root — the user's home on a default install — and both the
// resource map and the addDirs grant then treated it as the squad.
describe("runSquadHeadless — the slug cannot leave the squads root", () => {
  test("a traversing slug is refused before anything reads or grants it", () => {
    const squadsRoot = path.join(tmp, "squads");
    scaffoldSquad(squadsRoot, "brandcraft");
    // A sibling of the squads root, standing in for the user's home.
    fs.mkdirSync(path.join(tmp, "private"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "private", "id_rsa"), "SECRET-MARKER");

    const seen: any[] = [];
    const r = runSquadHeadless({
      squadSlug: path.join("..", "private"), brief: "b",
      projectId: "proj-esc", projectDir: tmp, projectRoot: tmp,
      outputsDir: path.join(tmp, "out"), runtime: "claude-code",
      autonomousDirective: "D ",
      squadsRoot,
      runWithCascadeImpl: ((opts: any) => { seen.push(opts); return okCascadeResult(opts); }) as any,
    });

    expect(r.ok).toBe(false);
    expect(r.error).toContain("escapes the squads root");
    // Never dispatched: nothing was granted and no prompt was built from it.
    expect(seen).toHaveLength(0);
    const failed = readAudit().find(e => e.event === "squad_run_failed");
    expect(failed?.reason).toBe("squad slug escapes the squads root");
  });

  test("an ordinary slug still resolves", () => {
    const squadsRoot = path.join(tmp, "squads");
    scaffoldSquad(squadsRoot, "brandcraft");
    const seen: any[] = [];
    const r = runSquadHeadless({
      squadSlug: "brandcraft", brief: "b",
      projectId: "proj-ok", projectDir: tmp, projectRoot: tmp,
      outputsDir: path.join(tmp, "out"), runtime: "claude-code",
      autonomousDirective: "D ",
      squadsRoot,
      runWithCascadeImpl: ((opts: any) => { seen.push(opts); return okCascadeResult(opts); }) as any,
    });
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(1);
  });
});
