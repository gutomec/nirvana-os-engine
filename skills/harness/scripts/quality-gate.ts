#!/usr/bin/env bun
// quality-gate.ts — Run rubrics over an artifact and emit a PASS/FAIL verdict.
//
// Closes F9 from NIRVANA-OS-CORRECTION-REPORT. Previously, gate_passed events
// were emitted manually with no rubric ever executed. This driver loads the
// rubrics from ../rubrics/ and runs them over the artifact, producing a
// consolidated JSON verdict that the maestro can act on.
//
// Usage:
//   bun quality-gate.ts <artifact_path>                          # auto-pick rubrics
//   bun quality-gate.ts <artifact_path> --rubrics correctness,structure-bounds
//   bun quality-gate.ts <artifact_path> --auto                   # explicit auto
//   bun quality-gate.ts <artifact_path> --offline                # skip LLM rubrics
//
// Exit codes:
//   0 = PASS (all selected rubrics passed)
//   1 = FAIL (at least one rubric failed)
//   2 = artifact not found or no rubrics applicable

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type RubricResult = {
  name: string;
  passed: boolean;
  score: number;
  reasoning: string;
  fix_list: string[];
  skipped?: boolean;
};

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));
const RUBRICS_DIR = path.join(SKILLS_ROOT, "harness", "rubrics");

function rubricsForExt(ext: string): string[] {
  switch (ext.toLowerCase()) {
    case ".md":
    case ".txt":
      return ["correctness", "structure-bounds", "wiki-lint"];
    case ".json":
      return ["json-valid"];
    case ".yaml":
    case ".yml":
      return ["yaml-valid"];
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".webp":
      return ["brief-fidelity"];
    case ".html":
      return ["html-valid"];
    case ".ts":
    case ".js":
    case ".py":
      return ["correctness"];
    default:
      return ["correctness"];
  }
}

async function runRubric(name: string, artifact: string, content: string, opts: { offline: boolean }): Promise<RubricResult> {
  const rubricPath = path.join(RUBRICS_DIR, `${name}.ts`);
  if (!fs.existsSync(rubricPath)) {
    return {
      name,
      passed: false,
      score: 0,
      reasoning: `Rubric '${name}' not implemented yet at ${rubricPath}`,
      fix_list: [`Implement ${rubricPath}`],
      skipped: true,
    };
  }
  try {
    const mod = await import(rubricPath);
    const result: RubricResult = await mod.evaluate({ artifact, content, offline: opts.offline });
    return { ...result, name };
  } catch (e: any) {
    return {
      name,
      passed: false,
      score: 0,
      reasoning: `Rubric '${name}' threw: ${e.message}`,
      fix_list: [`Debug rubric at ${rubricPath}`],
    };
  }
}

// --with-revisions: run the nirvana-evolution LLM judge + revision loop
// instead of the heuristic rubrics. The judge selects a domain rubric (.md)
// by --produces, calls the host LLM runtime (codex/claude/gemini via
// host-agent-driver), and loops judge→critique→revise up to --max-revisions.
// Falls back to heuristics with a warning if no runtime is available.
async function runWithRevisions(artifact: string, content: string, args: string[]): Promise<number> {
  const producesArg = args.find(a => a.startsWith("--produces="));
  const produces = producesArg ? producesArg.slice("--produces=".length).split(",").map(s => s.trim()) : [];
  const maxRev = parseInt(args.find(a => a.startsWith("--max-revisions="))?.split("=")[1] || "2", 10);

  let selector: typeof import("../lib/rubric-selector.ts");
  let revision: typeof import("../lib/revision-dispatch.ts");
  try {
    selector = await import("../lib/rubric-selector.ts");
    revision = await import("../lib/revision-dispatch.ts");
  } catch (e: any) {
    console.error(`--with-revisions unavailable (${e.message}); falling back to heuristic rubrics.`);
    return -1; // signal fallback
  }

  // Pick the rubric. If --produces given, select by produces-slug mapping.
  // Otherwise infer a rubric NAME from the file extension and fetch it directly.
  const ext = path.extname(artifact).toLowerCase();
  let rubric: import("../lib/rubric-selector.ts").RubricMeta | null = null;
  if (produces.length) {
    rubric = selector.selectRubricsForProduces(produces)[0] || null;
    if (!rubric) console.error(`No .md rubric matches produces=[${produces.join(",")}]; trying extension inference.`);
  }
  if (!rubric) {
    // Rubric names in frontmatter use underscores (prose_longform, etc.)
    const inferredName = ext === ".md" ? "prose_longform"
      : [".ts", ".js", ".py"].includes(ext) ? "code"
      : [".png", ".jpg", ".jpeg"].includes(ext) ? "image"
      : "prose_shortform";
    rubric = selector.getRubric(inferredName);
  }
  if (!rubric) {
    console.error(`No .md rubric resolvable; falling back to heuristics.`);
    return -1;
  }

  // The revise callback: for the CLI we don't auto-regenerate (that needs the
  // dispatching agent's context). Instead we run a single judge pass and, if it
  // fails, surface the critique for the agent to act on. A maestro embedding
  // this can pass a real ReviseFn that re-dispatches.
  const judgeMod = await import("../lib/judge.ts");
  const result = await judgeMod.judge(
    { rubric, artifact: content, trace_id: process.env.NIRVANA_TRACE_ID || undefined,
      business_slug: process.env.NIRVANA_BUSINESS_SLUG || undefined },
  );

  const out = {
    artifact,
    mode: "with-revisions",
    rubric: rubric.name,
    verdict: result.verdict,
    total_score: result.total_score,
    criteria: result.criteria_scores,
    critique: result.critique,
    judge_runtime: result.judge_runtime,
    max_revisions: maxRev,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(out, null, 2));

  // Audit
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(require(path.join(SKILLS_ROOT, "_shared/lib/log-paths.ts")).harnessLogsDir({ cwd: path.dirname(path.resolve(artifact)) }), today);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify({
      ts: out.timestamp,
      event: result.verdict === "pass" ? "gate_passed" : "gate_failed",
      mode: "with-revisions",
      trace_id: process.env.NIRVANA_TRACE_ID || null,
      project_id: process.env.NIRVANA_PROJECT_ID || null,
      business_slug: process.env.NIRVANA_BUSINESS_SLUG || null,
      artifact, rubric: rubric.name, score: out.total_score,
      judge_runtime: out.judge_runtime,
    }) + "\n");
  } catch { /* non-fatal */ }

  return result.verdict === "pass" ? 0 : 1;
}

async function main() {
  const args = process.argv.slice(2);
  const artifact = args.find(a => !a.startsWith("--"));
  if (!artifact || !fs.existsSync(artifact)) {
    console.error("Uso: bun quality-gate.ts <artifact_path> [--rubrics list] [--auto] [--offline]");
    console.error("     bun quality-gate.ts <artifact_path> --with-revisions [--produces=slug] [--max-revisions=N]");
    if (artifact) console.error(`Artifact not found: ${artifact}`);
    process.exit(2);
  }

  const offline = args.includes("--offline");

  // --with-revisions path: LLM judge + revision loop (nirvana-evolution).
  if (args.includes("--with-revisions") && !offline) {
    const ext0 = path.extname(artifact).toLowerCase();
    const isBin0 = [".png", ".jpg", ".jpeg", ".webp", ".pdf"].includes(ext0);
    const content0 = isBin0 ? "" : fs.readFileSync(artifact, "utf8");
    const code = await runWithRevisions(artifact, content0, args);
    if (code >= 0) process.exit(code);
    // code === -1 → fall through to heuristic path below
  }
  const rubricsArg = args.find(a => a.startsWith("--rubrics="));
  let rubrics: string[];
  if (rubricsArg) {
    rubrics = rubricsArg.slice("--rubrics=".length).split(",").map(s => s.trim()).filter(Boolean);
  } else {
    rubrics = rubricsForExt(path.extname(artifact));
    // The _SUMMARY handoff gets the WARNING-only context-budget check.
    if (path.basename(artifact) === "_SUMMARY.md" && !rubrics.includes("summary-bounds")) {
      rubrics.push("summary-bounds");
    }
  }

  if (rubrics.length === 0) {
    console.error("No rubrics applicable. Use --rubrics= explicitly.");
    process.exit(2);
  }

  // Read content. For binary (images), we still load — rubrics may stat instead.
  const ext = path.extname(artifact).toLowerCase();
  const isBinary = [".png", ".jpg", ".jpeg", ".webp", ".pdf"].includes(ext);
  const content = isBinary ? "" : fs.readFileSync(artifact, "utf8");

  const results: RubricResult[] = [];
  for (const r of rubrics) {
    results.push(await runRubric(r, artifact, content, { offline }));
  }

  const nonSkipped = results.filter(r => !r.skipped);
  const allPass = nonSkipped.length > 0 && nonSkipped.every(r => r.passed);
  const avg = nonSkipped.length > 0 ? nonSkipped.reduce((s, r) => s + r.score, 0) / nonSkipped.length : 0;

  const verdict = {
    artifact,
    rubrics_evaluated: rubrics,
    results,
    status: allPass ? "PASS" : (nonSkipped.length === 0 ? "INDETERMINATE" : "FAIL"),
    score_avg: Math.round(avg * 100) / 100,
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(verdict, null, 2));

  // Audit emit
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(require(path.join(SKILLS_ROOT, "_shared/lib/log-paths.ts")).harnessLogsDir({ cwd: path.dirname(path.resolve(artifact)) }), today);
    fs.mkdirSync(dir, { recursive: true });
    const event: Record<string, any> = {
      ts: verdict.timestamp,
      event: verdict.status === "PASS" ? "gate_passed" : "gate_failed",
      trace_id: process.env.NIRVANA_TRACE_ID || null,
      project_id: process.env.NIRVANA_PROJECT_ID || null,
      business_slug: process.env.NIRVANA_BUSINESS_SLUG || null,
      artifact,
      rubrics: rubrics,
      score_avg: verdict.score_avg,
      failed_rubrics: results.filter(r => !r.passed && !r.skipped).map(r => r.name),
    };
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify(event) + "\n");
  } catch {
    // non-fatal
  }

  process.exit(allPass ? 0 : 1);
}

await main();
