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
//   bun quality-gate.ts --batch --with-revisions <artifact>...   # one judge session, many files
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
  /** Judge rubrics only: the rubric's critique holds a material (`high`) defect. */
  material?: boolean;
};

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));
const RUBRICS_DIR = path.join(SKILLS_ROOT, "harness", "rubrics");

/** One verdict schema across heuristic and judge modes (routing-360 Phase 4).
 * Extra mode-specific fields may ride along, but every verdict carries these. */
export type GateVerdict = {
  status: "PASS" | "FAIL" | "INDETERMINATE";
  mode: "heuristic" | "judge";
  score: number;
  results: RubricResult[];
  critique?: unknown[];
  artifact: string;
  timestamp: string;
  [k: string]: unknown;
};

/** The extensions the gate KNOWS how to judge — exactly the enumerated cases
 * of rubricsForExt below. The delivery pipeline uses this surface to decide
 * which produced files are gateable; anything else (e.g. .zip, .mp4) is
 * outside the gate and counts toward the INDETERMINATE outcome when it is
 * all a run produced. Exported for lib/delivery-pipeline.ts. */
export const GATEABLE_EXTS: ReadonlySet<string> = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml",
  ".png", ".jpg", ".jpeg", ".webp",
  ".html", ".css", ".ts", ".js", ".py",
  ".pdf",
]);

export function rubricsForExt(ext: string): string[] {
  switch (ext.toLowerCase()) {
    // secret-leak rides every text artifact: a deliverable never carries the
    // value of a credential this machine holds (withheld), and credential-shaped
    // content is flagged for redaction on the way out.
    case ".md":
    case ".txt":
      return ["correctness", "structure-bounds", "wiki-lint", "secret-leak"];
    case ".json":
      return ["json-valid", "secret-leak"];
    case ".yaml":
    case ".yml":
      return ["yaml-valid", "secret-leak"];
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".webp":
      return ["brief-fidelity"];
    case ".html":
      return ["html-valid", "html-layout", "secret-leak"];
    case ".css":
      return ["css-composite-alpha", "secret-leak"];
    case ".pdf":
      return ["pdf-valid"];
    case ".ts":
    case ".js":
    case ".py":
      return ["correctness", "secret-leak"];
    default:
      return ["correctness", "secret-leak"];
  }
}

/** The rubrics that run on a file whichever mode judges it: a leaked secret,
 *  a file that is not what its extension promises and a page that does not fit
 *  a phone are measured facts, not opinions, so the judge's verdict never
 *  replaces them. The delivery pipeline counts a failure among the first two
 *  kinds as serious (delivery-pipeline.ts SERIOUS_RUBRICS); a layout finding
 *  goes back for correction and is not. */
export const ALWAYS_RUBRICS: ReadonlySet<string> = new Set([
  "secret-leak", "json-valid", "html-valid", "html-layout", "pdf-valid", "yaml-valid", "brief-fidelity",
]);

/** The heuristic rubrics of `ext` that run beside the judge. */
export function alwaysRubricsForExt(ext: string): string[] {
  return rubricsForExt(ext).filter((r) => ALWAYS_RUBRICS.has(r));
}

const TEXT_RUBRICS = ["prose_longform", "prose_shortform", "data_research", "juridical", "mind_clone_voice_fidelity", "video"];

/** The judge rubrics a file of this extension may be graded by, and the one it
 *  gets when no `produces` slug picks among them. The EXTENSION decides the
 *  family first: a business that produces a landing page and a report used to
 *  have its .md report judged by the design rubric, because that was the first
 *  rubric its produces list matched. */
export function judgeRubricFamily(ext: string): { allowed: ReadonlySet<string>; fallback: string } {
  switch (ext.toLowerCase()) {
    case ".ts": case ".js": case ".py": case ".css":
      return { allowed: new Set(["code"]), fallback: "code" };
    case ".png": case ".jpg": case ".jpeg": case ".webp":
      return { allowed: new Set(["image"]), fallback: "image" };
    case ".md":
      return { allowed: new Set(TEXT_RUBRICS), fallback: "prose_longform" };
    case ".html":
      return { allowed: new Set([...TEXT_RUBRICS, "design"]), fallback: "prose_longform" };
    case ".json": case ".yaml": case ".yml":
      return { allowed: new Set([...TEXT_RUBRICS, "code"]), fallback: "prose_shortform" };
    default:
      return { allowed: new Set(TEXT_RUBRICS), fallback: "prose_shortform" };
  }
}

/** The name of the judge rubric for `ext`: the first rubric the produces slugs
 *  matched that belongs to the extension's family, else the family's fallback. */
export function pickJudgeRubricName(ext: string, matched: readonly string[]): string {
  const family = judgeRubricFamily(ext);
  return matched.find((name) => family.allowed.has(name)) ?? family.fallback;
}

/** Every judge rubric a file is graded by. An HTML page is read twice: for what
 *  it says (the rubric its family or produces picks) and for how it is built
 *  (design), and it passes only when both pass. Other files get one rubric. */
export function judgeRubricNames(ext: string, matched: readonly string[]): string[] {
  const first = pickJudgeRubricName(ext, matched);
  return ext.toLowerCase() === ".html" && first !== "design" ? [first, "design"] : [first];
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

/** The fixes a failed judge verdict hands to the revision: high, then medium. */
export function revisionFixes(critique: { severity: string; suggested_fix: string }[]): string[] {
  const work = [...critique.filter(c => c.severity === "high"), ...critique.filter(c => c.severity === "medium")];
  return (work.length ? work : critique).map(c => c.suggested_fix).filter(Boolean);
}

// --with-revisions: run the nirvana-evolution LLM judge + revision loop
// instead of the heuristic rubrics. The judge selects a domain rubric (.md)
// by --produces, calls the host LLM runtime (codex/claude/gemini via
// host-agent-driver), and loops judge→critique→revise up to --max-revisions.
// Falls back to heuristics with a warning if no runtime is available.

type SelectorMod = typeof import("../lib/rubric-selector.ts");
type JudgeMod = typeof import("../lib/judge.ts");
type Rubric = NonNullable<ReturnType<SelectorMod["getRubric"]>>;
type JudgeVerdict = Awaited<ReturnType<JudgeMod["judge"]>>;

/** What every judged file of one gate call shares: the produces slugs, the
 *  brief and the judge modules. null when the judge cannot be loaded. */
interface JudgeContext {
  produces: string[];
  maxRev: number;
  brief?: string;
  selector: SelectorMod;
  judgeMod: JudgeMod;
}

async function judgeContext(args: string[]): Promise<JudgeContext | null> {
  const producesArg = args.find(a => a.startsWith("--produces="));
  const produces = producesArg ? producesArg.slice("--produces=".length).split(",").map(s => s.trim()) : [];
  const maxRev = parseInt(args.find(a => a.startsWith("--max-revisions="))?.split("=")[1] || "2", 10);
  // The brief the artifact answers. The judge renders it above the artifact
  // (JudgeInput.brief) so a rubric can hold the work to what was asked; without
  // it the judge graded the artifact against the rubric alone.
  const briefFileArg = args.find(a => a.startsWith("--brief-file="))?.slice("--brief-file=".length);
  let brief: string | undefined;
  if (briefFileArg) { try { brief = fs.readFileSync(briefFileArg, "utf8").trim() || undefined; } catch { brief = undefined; } }
  try {
    const selector = await import("../lib/rubric-selector.ts");
    await import("../lib/revision-dispatch.ts");
    const judgeMod = await import("../lib/judge.ts");
    return { produces, maxRev, brief, selector, judgeMod };
  } catch (e: any) {
    console.error(`--with-revisions unavailable (${e.message}); falling back to heuristic rubrics.`);
    return null;
  }
}

/** The judge rubrics of one file: the file's extension names the family, and a
 *  produces slug chooses within it (pickJudgeRubricName). Empty when none resolves. */
function judgeRubricsFor(ctx: JudgeContext, artifact: string): Rubric[] {
  const ext = path.extname(artifact).toLowerCase();
  const matched = ctx.produces.length ? (() => {
    const sel = ctx.selector.selectRubricsForProduces(ctx.produces);
    return sel.fallback_used ? [] : sel.rubrics.map((r) => r.name);
  })() : [];
  const rubricNames = judgeRubricNames(ext, matched);
  if (ctx.produces.length && !matched.includes(rubricNames[0])) {
    console.error(`No ${ext} rubric matches produces=[${ctx.produces.join(",")}]; using ${rubricNames[0]}, the one the extension implies.`);
  }
  return rubricNames.map((name) => ctx.selector.getRubric(name)).filter((r): r is Rubric => !!r);
}

/** The gate verdict of a judged file, from its judge verdicts (one per judge
 *  rubric) and the checks no judge verdict replaces. Writes the file's audit line. */
async function judgedVerdict(artifact: string, content: string, verdicts: Array<{ rubric: Rubric; result: JudgeVerdict }>, maxRev: number): Promise<GateVerdict> {
  const ext = path.extname(artifact).toLowerCase();
  const rubric = { name: verdicts.map((v) => v.rubric.name).join("+") };
  const critique = verdicts.flatMap((v) => v.result.critique);
  const result = {
    verdict: verdicts.every((v) => v.result.verdict === "pass") ? "pass" : "fail",
    total_score: Math.min(...verdicts.map((v) => v.result.total_score)),
    critique,
    criteria_scores: Object.assign({}, ...verdicts.map((v) => v.result.criteria_scores)),
    judge_runtime: verdicts[0].result.judge_runtime,
  };

  // The checks no judge verdict replaces: secret-leak and the validity rubric
  // of the extension run on every file, and a failure among them fails the
  // file whatever the judge said.
  const always: RubricResult[] = [];
  for (const name of alwaysRubricsForExt(ext)) always.push(await runRubric(name, artifact, content, { offline: true }));
  const alwaysFailed = always.filter(r => !r.passed && !r.skipped);
  const judgePassed = result.verdict === "pass";

  // Normalized verdict schema {status, mode, score, results[], critique?} —
  // same shape the heuristic path prints, so callers (delivery-pipeline's
  // runGateOnce) parse ONE contract. Judge-specific fields ride along.
  const out: GateVerdict = {
    status: judgePassed && alwaysFailed.length === 0 ? "PASS" : "FAIL",
    mode: "judge",
    score: result.total_score,
    // One result per judge rubric. What a revision is asked to fix: the material
    // items first, then the medium ones. Low items (style, polish) stay in
    // `critique` as notes and never become revision work, unless nothing else
    // explains a low score. `material` says the rubric's own critique holds a
    // material defect, which the delivery pipeline counts as serious.
    results: [...verdicts.map((v) => ({
      name: v.rubric.name,
      passed: v.result.verdict === "pass",
      score: v.result.total_score,
      reasoning: v.result.critique.map(c => `[${c.severity}] ${c.issue}`).join("; ") || "judge verdict",
      fix_list: v.result.verdict === "pass" ? [] : revisionFixes(v.result.critique),
      material: v.result.critique.some(c => c.severity === "high"),
    })), ...always],
    critique: result.critique,
    artifact,
    timestamp: new Date().toISOString(),
    // legacy / diagnostic fields
    rubric: rubric.name,
    verdict: result.verdict,
    total_score: result.total_score,
    criteria: result.criteria_scores,
    judge_runtime: result.judge_runtime,
    max_revisions: maxRev,
  };

  // Audit
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(require(path.join(SKILLS_ROOT, "_shared/lib/log-paths.ts")).harnessLogsDir({ cwd: path.dirname(path.resolve(artifact)) }), today);
    fs.mkdirSync(dir, { recursive: true });
    const _stamp = require(path.join(SKILLS_ROOT, "_shared/lib/audit-provenance.ts")).stamp;
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify(_stamp({
      ts: out.timestamp,
      event: out.status === "PASS" ? "gate_passed" : "gate_failed",
      mode: "with-revisions",
      ...(alwaysFailed.length ? { failed_rubrics: alwaysFailed.map(r => r.name) } : {}),
      trace_id: process.env.NIRVANA_TRACE_ID || null,
      project_id: process.env.NIRVANA_PROJECT_ID || null,
      business_slug: process.env.NIRVANA_BUSINESS_SLUG || null,
      artifact, rubric: rubric.name, score: out.total_score,
      judge_runtime: out.judge_runtime,
      // A pass can still carry the judge's notes (style, polish): recorded
      // here so they reach whoever reads the run, without sending it back.
      ...(result.verdict === "pass" && result.critique.length
        ? { notes: result.critique.slice(0, 12).map(c => `[${c.severity}] ${c.issue}`.slice(0, 240)) }
        : {}),
    })) + "\n");
  } catch { /* non-fatal */ }

  return out;
}

const BINARY_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".pdf"];

function readArtifact(artifact: string): string {
  return BINARY_EXTS.includes(path.extname(artifact).toLowerCase()) ? "" : fs.readFileSync(artifact, "utf8");
}

async function runWithRevisions(artifact: string, content: string, args: string[]): Promise<number> {
  const ctx = await judgeContext(args);
  if (!ctx) return -1; // signal fallback
  const rubrics = judgeRubricsFor(ctx, artifact);
  if (!rubrics.length) {
    console.error(`No .md rubric resolvable; falling back to heuristics.`);
    return -1;
  }

  // The revise callback: for the CLI we don't auto-regenerate (that needs the
  // dispatching agent's context). Instead we run a single judge pass and, if it
  // fails, surface the critique for the agent to act on. A maestro embedding
  // this can pass a real ReviseFn that re-dispatches.
  const verdicts: Array<{ rubric: Rubric; result: JudgeVerdict }> = [];
  for (const rubric of rubrics) {
    const result = await ctx.judgeMod.judge(
      { rubric, artifact: content, brief: ctx.brief, trace_id: process.env.NIRVANA_TRACE_ID || undefined,
        business_slug: process.env.NIRVANA_BUSINESS_SLUG || undefined },
    );
    if (result.schema_valid) verdicts.push({ rubric, result });
    else console.error(`[gate] judge gave no usable ${rubric.name} verdict (${(result.schema_errors ?? []).join(", ") || result.judge_runtime}).`);
  }
  // No verdict came back (no runtime, a failed call, an answer that is not the
  // schema). That says nothing about the artifact, so it is not a fail: the
  // heuristic rubrics decide this file, as they do with the judge off, and the
  // verdict says `mode: "heuristic"`.
  if (!verdicts.length) {
    console.error(`[gate] the heuristic rubrics decide ${path.basename(artifact)}.`);
    return -1;
  }
  const out = await judgedVerdict(artifact, content, verdicts, ctx.maxRev);
  console.log(JSON.stringify(out, null, 2));
  return out.status === "PASS" ? 0 : 1;
}

/** What `--batch` prints: a verdict per file it could decide, and the files it
 *  could not (the batched answer did not parse, or skipped them), which the
 *  caller judges one by one. */
export type GateBatchOutput = {
  mode: "batch";
  verdicts: Record<string, GateVerdict>;
  unjudged: string[];
};

/**
 * --batch: judge several files in ONE judge session (judge.ts judgeBatch).
 * Every file gets the same verdict shape as a single-file call. A batched
 * answer that does not parse leaves its files `unjudged`, for one call each; a
 * judge that cannot be reached at all sends them to the heuristics, as the
 * single-file path does, since a second call would fail the same way.
 */
async function runBatch(artifacts: string[], args: string[]): Promise<GateBatchOutput> {
  const out: GateBatchOutput = { mode: "batch", verdicts: {}, unjudged: [] };
  const ctx = await judgeContext(args);
  const heuristic = async (a: string) => { out.verdicts[a] = await heuristicVerdict(a, defaultRubrics(a), false); };
  if (!ctx) { for (const a of artifacts) await heuristic(a); return out; }

  // Labels relative to the files' common folder: the judge needs names, not this machine's paths.
  const dirs = artifacts.map(a => path.dirname(path.resolve(a)));
  let common = dirs[0] ?? "";
  while (common && !dirs.every(d => d === common || d.startsWith(common + path.sep))) {
    const up = path.dirname(common);
    if (up === common) break;
    common = up;
  }
  const items: Array<{ id: string; label: string; artifact: string; rubrics: Rubric[]; file: string }> = [];
  for (const a of artifacts) {
    const rubrics = judgeRubricsFor(ctx, a);
    if (!rubrics.length) { await heuristic(a); continue; }
    items.push({ id: `F${items.length + 1}`, label: path.relative(common, path.resolve(a)).replace(/\\/g, "/"), artifact: readArtifact(a), rubrics, file: a });
  }
  if (!items.length) return out;

  const res = await ctx.judgeMod.judgeBatch({
    items, brief: ctx.brief,
    trace_id: process.env.NIRVANA_TRACE_ID || undefined, business_slug: process.env.NIRVANA_BUSINESS_SLUG || undefined,
  });
  if (!res.ok) console.error(`[gate] the batched judge gave no verdict (${res.reason}: ${res.error}).`);
  for (const it of items) {
    if (!res.ok) {
      if (res.reason === "unparseable") out.unjudged.push(it.file);
      else await heuristic(it.file);
      continue;
    }
    const got = res.verdicts.get(it.id);
    const verdicts = it.rubrics.flatMap(rubric => { const result = got?.get(rubric.name); return result ? [{ rubric, result }] : []; });
    if (verdicts.length !== it.rubrics.length) { out.unjudged.push(it.file); continue; }
    out.verdicts[it.file] = await judgedVerdict(it.file, it.artifact, verdicts, ctx.maxRev);
  }
  return out;
}

/** The heuristic rubrics of a file when none are named on the command line. */
function defaultRubrics(artifact: string): string[] {
  const rubrics = rubricsForExt(path.extname(artifact));
  // The _SUMMARY handoff gets the WARNING-only context-budget check.
  if (path.basename(artifact) === "_SUMMARY.md" && !rubrics.includes("summary-bounds")) rubrics.push("summary-bounds");
  return rubrics;
}

/** The heuristic verdict of one file over `rubrics`. Writes the file's audit line. */
async function heuristicVerdict(artifact: string, rubrics: string[], offline: boolean): Promise<GateVerdict> {
  // Read content. For binary (images), we still load — rubrics may stat instead.
  const content = readArtifact(artifact);

  const results: RubricResult[] = [];
  for (const r of rubrics) {
    results.push(await runRubric(r, artifact, content, { offline }));
  }

  const nonSkipped = results.filter(r => !r.skipped);
  const allPass = nonSkipped.length > 0 && nonSkipped.every(r => r.passed);
  const avg = nonSkipped.length > 0 ? nonSkipped.reduce((s, r) => s + r.score, 0) / nonSkipped.length : 0;

  // Normalized verdict schema {status, mode, score, results[]} shared with the
  // judge path above. score_avg / rubrics_evaluated stay for legacy readers.
  const verdict: GateVerdict = {
    status: allPass ? "PASS" : (nonSkipped.length === 0 ? "INDETERMINATE" : "FAIL"),
    mode: "heuristic",
    score: Math.round(avg * 100) / 100,
    results,
    artifact,
    rubrics_evaluated: rubrics,
    score_avg: Math.round(avg * 100) / 100,
    timestamp: new Date().toISOString(),
  };

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
      score_avg: verdict.score,
      failed_rubrics: results.filter(r => !r.passed && !r.skipped).map(r => r.name),
    };
    const _stamp = require(path.join(SKILLS_ROOT, "_shared/lib/audit-provenance.ts")).stamp;
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify(_stamp(event)) + "\n");
    // A verdict nobody can join to a run is a verdict nobody can act on. The
    // delivery pipeline exports these; an agent invoking the gate by hand does
    // not, and on 2026-09-04 ten of twelve gate verdicts in a live run carried
    // trace_id: null. Silence made that invisible, so it says so now.
    if (!event.trace_id) {
      console.error("[gate] WARNING: no trace_id — this verdict cannot be joined to a run. "
        + "Export NIRVANA_TRACE_ID, NIRVANA_PROJECT_ID and NIRVANA_BUSINESS_SLUG before calling the gate.");
    }
  } catch {
    // non-fatal
  }
  return verdict;
}

async function main() {
  const args = process.argv.slice(2);
  // --batch <file>...: one judge session for every file (the delivery
  // pipeline's batched judging); prints a GateBatchOutput and exits 0.
  if (args.includes("--batch")) {
    const files = args.filter(a => !a.startsWith("--"));
    const missing = files.filter(f => !fs.existsSync(f));
    if (!files.length || missing.length) {
      console.error("Usage: bun quality-gate.ts --batch --with-revisions [--produces=slug] [--brief-file=path] <artifact>...");
      if (missing.length) console.error(`Artifact not found: ${missing.join(", ")}`);
      process.exit(2);
    }
    console.log(JSON.stringify(await runBatch(files, args), null, 2));
    process.exit(0);
  }
  const artifact = args.find(a => !a.startsWith("--"));
  if (!artifact || !fs.existsSync(artifact)) {
    console.error("Usage: bun quality-gate.ts <artifact_path> [--rubrics list] [--auto] [--offline]");
    console.error("       bun quality-gate.ts <artifact_path> --with-revisions [--produces=slug] [--max-revisions=N]");
    if (artifact) console.error(`Artifact not found: ${artifact}`);
    process.exit(2);
  }

  const offline = args.includes("--offline");

  // --with-revisions path: LLM judge + revision loop (nirvana-evolution).
  if (args.includes("--with-revisions") && !offline) {
    const code = await runWithRevisions(artifact, readArtifact(artifact), args);
    if (code >= 0) process.exit(code);
    // code === -1 → fall through to heuristic path below
  }
  const rubricsArg = args.find(a => a.startsWith("--rubrics="));
  const rubrics = rubricsArg
    ? rubricsArg.slice("--rubrics=".length).split(",").map(s => s.trim()).filter(Boolean)
    : defaultRubrics(artifact);

  if (rubrics.length === 0) {
    console.error("No rubrics applicable. Use --rubrics= explicitly.");
    process.exit(2);
  }

  const verdict = await heuristicVerdict(artifact, rubrics, offline);
  console.log(JSON.stringify(verdict, null, 2));
  process.exit(verdict.status === "PASS" ? 0 : 1);
}

// Guarded so lib consumers (delivery-pipeline imports rubricsForExt /
// GATEABLE_EXTS) can import this module without running the CLI.
//
// `main().catch(...)` and not `await main()`: a top-level await here makes this
// an ASYNC module, and that propagates through delivery-pipeline.ts to every
// consumer — a synchronous createRequire() of the pipeline then fails outright
// ("require() async module is unsupported"). The supervisor's lazy salvage load
// needs exactly that. main() ends in process.exit either way; the catch only
// covers a throw before it.
if (import.meta.main) main().catch((e) => { console.error(e); process.exit(2); });
