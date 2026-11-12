/**
 * judge.ts — runs the LLM judge against an artifact + rubric and returns a
 * structured verdict. Delegates the actual LLM call to host-agent-driver so
 * the harness stays runtime-agnostic.
 *
 * Phase 3 da nirvana-evolution.
 *
 * The judge prompt is constructed from the rubric body. The schema the judge
 * must return is documented in each rubric's markdown. We validate the
 * response against `JudgeOutput`; a malformed or failed call comes back with
 * `schema_valid: false`, which the gate reads as "no judge verdict" (it falls
 * back to the heuristic rubrics) rather than as a defect in the artifact.
 *
 * The verdict is not the model's to state: `ruleVerdict` derives it from the
 * critique severities and the score, so a deliverable fails only for a
 * material defect or a score below the rubric's threshold.
 *
 * Side effects: emits `judge_invoked` and `critique_generated` audit events.
 */

import type { RubricMeta } from "./rubric-selector.ts";

// Lazy-load audit + host-agent-driver because they're CommonJS / async respectively.
let _audit: { emit: (e: string, payload: unknown, ctx?: unknown) => void } | null = null;
function audit() {
  if (_audit) return _audit;
  try {
    _audit = require("./audit.js");
    return _audit!;
  } catch {
    _audit = { emit: () => {} };
    return _audit!;
  }
}

let _hostDriver: typeof import("../../_shared/lib/host-agent-driver.ts") | null = null;
async function hostDriver() {
  if (_hostDriver) return _hostDriver;
  try {
    _hostDriver = await import("../../_shared/lib/host-agent-driver.ts");
  } catch (e) {
    _hostDriver = null;
  }
  return _hostDriver;
}

/** First runtime on the driver's roster that is actually installed here. */
async function firstInstalledRuntime(driverOverride?: unknown): Promise<string | null> {
  try {
    const driver = (driverOverride as typeof import("../../_shared/lib/host-agent-driver.ts") | undefined) ?? await hostDriver();
    if (!driver || typeof driver.listRuntimes !== "function") return null;
    return driver.listRuntimes().map((r) => r.name).find((n) => driver.runtimeAvailable(n)) ?? null;
  } catch { return null; }
}

/**
 * Judge runtime selection: the judge runs on the SESSION's runtime — the one
 * the user is working in, found by `detectSessionHost` (env markers, then the
 * process tree) — unless the user's runtime rules (USE_* / NOT_USE_* in .env,
 * via runtime-rules.ts decideRuntime) say otherwise for this brief. Returns
 * the preferred runtime slug, or null when there is no real signal (no rules
 * AND no detectable session host): null keeps the driver's PATH scan.
 */
async function resolveJudgePreferredRuntime(
  input: JudgeInput,
  opts: JudgeOpts,
  available: (runtime: string) => boolean,
): Promise<string | null> {
  let rules_mod: any;
  try {
    rules_mod = opts.__testRuntimeRules ?? await import("./runtime-rules.ts");
  } catch {
    return null;
  }
  try {
    const projectRoot = process.env.NIRVANA_PROJECT_ROOT || process.cwd();
    const rules = rules_mod.loadRuntimeRules(projectRoot);
    const detect = rules_mod.detectSessionHost ?? rules_mod.detectCurrentHost;
    const currentHost = detect?.() ?? null;
    if ((!rules || rules.length === 0) && !currentHost) return null;
    // Without a session host the default is the first INSTALLED runtime, never
    // a vendor literal; with none installed there is nothing to prefer.
    const defaultRuntime = currentHost ?? (await firstInstalledRuntime(opts.__testDriver));
    if (!defaultRuntime) return null;
    const decision = rules_mod.decideRuntime({
      brief: input.brief ?? "",
      explicitRuntime: null,
      defaultRuntime,
      rules,
      mode: "fast",
      available,
    });
    if (!decision?.runtime) return null;
    // A "default" decision with no session host is only the first installed
    // runtime, not a signal: the driver's PATH scan decides instead.
    if (decision.source === "default" && !currentHost) return null;
    return decision.runtime;
  } catch (e) {
    console.error(`[judge] runtime-rules consultation failed (${(e as Error)?.message ?? e}) — falling back to PATH-scan host detection.`);
    return null;
  }
}

export interface JudgeInput {
  rubric: RubricMeta;
  artifact: string;
  artifact_kind?: string;
  brief?: string;
  context?: Record<string, unknown>;
  trace_id?: string;
  business_slug?: string;
  squad_name?: string;
}

export interface CriteriaScore {
  name: string;
  score: number;
  weight: number;
  rationale: string;
  severity: "low" | "medium" | "high" | null;
  fixable: boolean;
}

export interface CritiqueItem {
  id: string;
  severity: "low" | "medium" | "high";
  issue: string;
  suggested_fix: string;
}

export interface JudgeOutput {
  verdict: "pass" | "fail";
  total_score: number;
  criteria_scores: CriteriaScore[];
  critique: CritiqueItem[];
  rubric_name: string;
  judge_runtime: string;
  raw_response_chars?: number;
  schema_valid: boolean;
  schema_errors?: string[];
}

/**
 * The verdict, from the critique and the score. A deliverable fails when it has
 * a material defect (a `high` critique item) or scores below the rubric's
 * threshold; a score AT the threshold passes. Style, polish and nits are `low`
 * or `medium` items and reach the author as notes, never as a fail on their own.
 *
 * It used to be the model's own `verdict`, under a persona told to prefer
 * "fail" at the threshold: real text deliverables scoring exactly 70 against a
 * threshold of 70 were failed and sent back for revision over wording.
 */
export function ruleVerdict(out: Pick<JudgeOutput, "total_score" | "critique">, passThreshold: number): "pass" | "fail" {
  const material = out.critique.some((c) => c.severity === "high");
  return material || out.total_score < passThreshold ? "fail" : "pass";
}

/** How a critique item is graded: the same scale for one file or a batch. */
const SEVERITY_LINES = [
  `Severity of each critique item:`,
  `- "high": a MATERIAL defect. A part the brief asked for is missing or unusable;`,
  `  a fact, number, name or citation is wrong or invented; the deliverable`,
  `  contradicts the brief, or contradicts itself in a way that would mislead the`,
  `  person who uses it; it claims work that was not done; a criterion the rubric`,
  `  marks as a hard gate is broken for the deliverable as a whole or on a claim it`,
  `  depends on.`,
  `- "medium": a real quality problem worth fixing that does not stop the`,
  `  deliverable from doing its job.`,
  `- "low": style, polish, wording, structure preferences, and anything a competent`,
  `  editor would call a matter of taste.`,
  `Not defects: professional defaults the executor declared as assumptions (for`,
  `example under an "## Assumptions" heading, in any language), anything the brief`,
  `did not ask for, and choices of method, format or length the brief left open.`,
];

function verdictLines(threshold: string): string[] {
  return [
    `Verdict: "fail" only when there is at least one "high" item or the total score`,
    `is below the pass threshold (${threshold}); otherwise "pass". A score AT the`,
    `threshold passes. Style, polish and nits never make the verdict fail on their`,
    `own: list them as "low" items so they reach the author as notes.`,
    `Score each criterion on what is there, and do not deduct twice for one problem.`,
  ];
}

function buildPersona(rubric: RubricMeta): string {
  return [
    `You are the quality judge of an autonomous multi-agent system.`,
    `You apply ONE rubric: "${rubric.display_name}".`,
    `You decide whether the deliverable does what the brief asked, and you name`,
    `what would make it better.`,
    ``,
    `You MUST return ONLY a single JSON object matching the schema declared at`,
    `the end of the rubric. No prose, no markdown fences, no preamble. JSON only.`,
    ``,
    ...SEVERITY_LINES,
    ``,
    ...verdictLines(String(rubric.pass_threshold)),
    ``,
    `========================`,
    `RUBRIC BODY:`,
    `========================`,
    rubric.body,
  ].join("\n");
}

/** Above this an artifact is worth flagging to the judge, so a long deliverable
 *  is not graded as if its opening were the whole of it. It is a NOTICE, never a
 *  cut: the artifact always travels whole. */
export const JUDGE_LARGE_ARTIFACT_CHARS = 30_000;

function buildUserMessage(input: JudgeInput): string {
  const briefBlock = input.brief ? `\n## Brief\n${input.brief}\n` : "";
  const kindBlock = input.artifact_kind ? `\n## Artifact kind\n${input.artifact_kind}\n` : "";
  const ctxBlock = input.context ? `\n## Context\n${JSON.stringify(input.context, null, 2)}\n` : "";
  return [
    `## Artifact to evaluate`,
    // The whole artifact. This used to be `.slice(0, 30_000)` with a
    // `[…truncated…]` marker, which made the gate certify what it had not read:
    // `quality-gate.ts` hands over a file's full content, so a 300 KB report was
    // graded on its first ten percent and `gate_passed` was emitted for the file.
    // A 120-page opinion could pass on its introduction. A judge that reads part
    // of a deliverable and returns a verdict on all of it is worse than no judge,
    // because the verdict is believed. When an artifact is large enough to be
    // worth flagging, the size is stated below and on `judge_invoked`, and the
    // model is told to weigh coverage — never silently handed a fragment.
    `\`\`\``,
    input.artifact,
    `\`\`\``,
    input.artifact.length > JUDGE_LARGE_ARTIFACT_CHARS
      ? `\n> This artifact has ${input.artifact.length} characters, above ${JUDGE_LARGE_ARTIFACT_CHARS}. It was delivered WHOLE above: judge the whole, not only the beginning.\n`
      : ``,
    briefBlock,
    kindBlock,
    ctxBlock,
    ``,
    `## Your task`,
    `Return the verdict JSON. No other text.`,
  ].join("\n");
}

function validateJudgeOutput(parsed: unknown, rubric: RubricMeta): { ok: true; data: JudgeOutput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!parsed || typeof parsed !== "object") return { ok: false, errors: ["response_not_object"] };
  const o = parsed as Record<string, unknown>;
  if (o.verdict !== "pass" && o.verdict !== "fail") errors.push("verdict_invalid");
  if (typeof o.total_score !== "number" || o.total_score < 0 || o.total_score > 100) errors.push("total_score_out_of_range");
  if (!Array.isArray(o.criteria_scores)) errors.push("criteria_scores_not_array");
  if (!Array.isArray(o.critique)) errors.push("critique_not_array");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    data: {
      verdict: o.verdict as "pass" | "fail",
      total_score: o.total_score as number,
      criteria_scores: (o.criteria_scores as CriteriaScore[]).map((c) => ({
        name: String(c.name ?? ""),
        score: Number(c.score ?? 0),
        weight: Number(c.weight ?? 0),
        rationale: String(c.rationale ?? ""),
        severity: ((c.severity ?? null) as CriteriaScore["severity"]),
        fixable: Boolean(c.fixable ?? false),
      })),
      critique: (o.critique as CritiqueItem[]).map((it, i) => ({
        id: String(it.id ?? `c${i + 1}`),
        severity: ((it.severity ?? "medium") as CritiqueItem["severity"]),
        issue: String(it.issue ?? ""),
        suggested_fix: String(it.suggested_fix ?? ""),
      })),
      rubric_name: rubric.name,
      judge_runtime: "",
      schema_valid: true,
    },
  };
}

function extractJsonFromText(text: string): unknown | null {
  // Strip markdown fences if any.
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  // Find outermost { ... }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

export interface JudgeOpts {
  mock?: boolean;
  mockOutput?: Partial<JudgeOutput>;
  timeoutMs?: number;
  /** TEST-ONLY: replaces the lazily imported _shared host-agent-driver.
   * Must expose callHostAgentAsync (and optionally runtimeAvailable). */
  __testDriver?: unknown;
  /** TEST-ONLY: replaces the lazily imported runtime-rules module. Must
   * expose loadRuntimeRules, decideRuntime and detectSessionHost (or the
   * older detectCurrentHost). */
  __testRuntimeRules?: unknown;
}

/**
 * Mock judge — useful for unit tests and dry runs (no LLM cost).
 */
export function mockJudge(input: JudgeInput, override?: Partial<JudgeOutput>): JudgeOutput {
  const score = override?.total_score ?? 85;
  return {
    verdict: override?.verdict ?? (score >= input.rubric.pass_threshold ? "pass" : "fail"),
    total_score: score,
    criteria_scores: override?.criteria_scores ?? [
      { name: "mock", score: 8, weight: 10, rationale: "mocked", severity: null, fixable: true },
    ],
    critique: override?.critique ?? [],
    rubric_name: input.rubric.name,
    judge_runtime: "mock",
    schema_valid: true,
  };
}

/**
 * Real judge — invokes host-agent-driver. Async.
 */
export async function judge(input: JudgeInput, opts: JudgeOpts = {}): Promise<JudgeOutput> {
  audit().emit("judge_invoked", {
    rubric_name: input.rubric.name,
    artifact_chars: input.artifact.length,
    // So a verdict on a very large artifact can be told apart afterwards.
    artifact_large: input.artifact.length > JUDGE_LARGE_ARTIFACT_CHARS,
    pass_threshold: input.rubric.pass_threshold,
    target_model: input.rubric.target_model,
  }, {
    trace_id: input.trace_id,
    business_slug: input.business_slug,
    squad_name: input.squad_name,
  });

  if (opts.mock) return mockJudge(input, opts.mockOutput);

  const driver = (opts.__testDriver as typeof import("../../_shared/lib/host-agent-driver.ts") | undefined) ?? await hostDriver();
  if (!driver) {
    return {
      verdict: "fail",
      total_score: 0,
      criteria_scores: [],
      critique: [{ id: "infra", severity: "high", issue: "host-agent-driver unavailable", suggested_fix: "run judge in mock mode or install a supported host runtime" }],
      rubric_name: input.rubric.name,
      judge_runtime: "none",
      schema_valid: false,
      schema_errors: ["no_runtime_available"],
    };
  }

  const persona = buildPersona(input.rubric);
  const userMsg = buildUserMessage(input);

  // The session's runtime judges, unless a USE_*/NOT_USE_* rule says otherwise
  // for this brief; without a signal the driver keeps its PATH scan.
  const available = (r: string): boolean => {
    try { return typeof driver.runtimeAvailable === "function" ? driver.runtimeAvailable(r as never) : true; }
    catch { return true; }
  };
  const preferredHost = await resolveJudgePreferredRuntime(input, opts, available);

  const call = await driver.callHostAgentAsync(persona, userMsg, {
    // No floor of our own: the driver's budget is a budget of SILENCE, and a
    // judge grading a long artifact against a seven-criterion rubric routinely
    // thinks for more than the 60s this used to allow. `claude -p
    // --output-format json` prints nothing until it is done, so those 60s were
    // a wall clock, and the verdict they produced was a runtime error.
    ...(typeof opts.timeoutMs === "number" ? { timeoutMs: opts.timeoutMs } : {}),
    ...(preferredHost ? { preferredHost } : {}),
  });

  if ("error" in call) {
    return {
      verdict: "fail",
      total_score: 0,
      criteria_scores: [],
      critique: [{ id: "judge_runtime_error", severity: "high", issue: `judge LLM call failed: ${call.error}`, suggested_fix: "retry with backoff or fall back to mock" }],
      rubric_name: input.rubric.name,
      judge_runtime: "error",
      schema_valid: false,
      schema_errors: [call.error],
    };
  }

  const parsed = extractJsonFromText(call.text);
  const v = validateJudgeOutput(parsed, input.rubric);
  if (!v.ok) {
    audit().emit("critique_generated", {
      rubric_name: input.rubric.name,
      schema_valid: false,
      schema_errors: v.errors,
    }, { trace_id: input.trace_id });
    return {
      verdict: "fail",
      total_score: 0,
      criteria_scores: [],
      critique: [{ id: "schema_invalid", severity: "high", issue: `judge response did not match schema: ${v.errors.join(", ")}`, suggested_fix: "judge output rejected; treat as fail and request fresh generation" }],
      rubric_name: input.rubric.name,
      judge_runtime: call.host,
      schema_valid: false,
      schema_errors: v.errors,
      raw_response_chars: call.text.length,
    };
  }

  const result: JudgeOutput = {
    ...v.data,
    verdict: ruleVerdict(v.data, input.rubric.pass_threshold),
    judge_runtime: call.host,
    raw_response_chars: call.text.length,
  };

  audit().emit("critique_generated", {
    rubric_name: input.rubric.name,
    verdict: result.verdict,
    // What the model itself said, when the rule disagreed with it.
    ...(v.data.verdict !== result.verdict ? { model_verdict: v.data.verdict } : {}),
    total_score: result.total_score,
    critique_count: result.critique.length,
    material_count: result.critique.filter((c) => c.severity === "high").length,
    schema_valid: true,
    judge_runtime: result.judge_runtime,
  }, {
    trace_id: input.trace_id,
    business_slug: input.business_slug,
    squad_name: input.squad_name,
  });

  return result;
}

// ── batched judging ─────────────────────────────────────────────────────────
//
// One judge session per text deliverable made a software delivery with ten
// markdown documents cost ten full runtime sessions per gate round, and every
// correction round paid it again. A batch hands the judge every small text
// deliverable of the round in ONE session and takes back one verdict per
// (file, rubric) pair, in the same JudgeOutput the single-file path returns, so
// the gate's verdicts, fix lists and findings still name each file.
//
// Nothing is cut to fit: a file above JUDGE_BATCH_FILE_MAX_CHARS is judged on
// its own (whole), and the files of one batch add up to at most
// JUDGE_BATCH_MAX_CHARS, so a delivery larger than that takes more than one
// batch rather than an excerpt of each file.

/** Above this a file is judged on its own, never inside a batch. */
export const JUDGE_BATCH_FILE_MAX_CHARS = JUDGE_LARGE_ARTIFACT_CHARS;
/** What the files of one batched call add up to, at most. */
export const JUDGE_BATCH_MAX_CHARS = 120_000;

export interface JudgeBatchItem {
  /** Short id the judge answers with ("F1"). */
  id: string;
  /** What the judge reads as the file's name (a path relative to the delivery). */
  label: string;
  artifact: string;
  /** The rubrics this file is graded by (an HTML page: its content rubric and design). */
  rubrics: RubricMeta[];
}

export interface JudgeBatchInput {
  items: JudgeBatchItem[];
  brief?: string;
  trace_id?: string;
  business_slug?: string;
  squad_name?: string;
}

export type JudgeBatchResult =
  | { ok: true; judge_runtime: string; verdicts: Map<string, Map<string, JudgeOutput>> }
  /** `unparseable`: the answer held no usable verdict, so the caller judges the
   *  files one by one. The other reasons say nothing would answer a second call. */
  | { ok: false; reason: "no_runtime" | "call_failed" | "unparseable"; error: string };

function buildBatchPersona(rubrics: RubricMeta[]): string {
  return [
    `You are the quality judge of an autonomous multi-agent system.`,
    `You judge SEVERAL deliverables of one delivery in one pass. Each file names the`,
    `rubric(s) it is graded by. Grade each file by its own rubric(s) alone, as if it`,
    `were the only file: a defect of one file never lowers the score of another.`,
    `You decide whether each deliverable does what the brief asked, and you name`,
    `what would make it better.`,
    ``,
    `You MUST return ONLY a single JSON object {"verdicts": [ ... ]} with one entry`,
    `per (file, rubric) pair listed under "Your task". Each entry is`,
    `{"file": "<file id>", "rubric": "<rubric name>"} plus every field of the output`,
    `schema declared at the end of that rubric. No prose, no markdown fences, no`,
    `preamble. JSON only.`,
    ``,
    ...SEVERITY_LINES,
    ``,
    ...verdictLines("stated in the header of the rubric the entry applies"),
    ...rubrics.flatMap((r) => [
      ``,
      `========================`,
      `RUBRIC "${r.name}": ${r.display_name} (pass threshold ${r.pass_threshold})`,
      `========================`,
      r.body,
    ]),
  ].join("\n");
}

function buildBatchUserMessage(input: JudgeBatchInput): string {
  return [
    ...(input.brief ? [`## Brief`, input.brief, ``] : []),
    `## Files to evaluate`,
    `Each file is delivered WHOLE between its two markers.`,
    ...input.items.flatMap((it) => [
      ``,
      `### File ${it.id}: ${it.label} (rubrics: ${it.rubrics.map((r) => r.name).join(", ")})`,
      `<<<${it.id}`,
      it.artifact,
      `${it.id}>>>`,
    ]),
    ``,
    `## Your task`,
    `Return {"verdicts": [...]} with exactly these entries:`,
    ...input.items.flatMap((it) => it.rubrics.map((r) => `- file "${it.id}", rubric "${r.name}"`)),
    `No other text.`,
  ].join("\n");
}

/** The verdicts of a batched answer, by file id then rubric name. An entry that
 *  names no listed pair or fails the schema is dropped (its file is judged on
 *  its own); null when the answer holds no usable entry at all. */
function parseBatchAnswer(text: string, items: JudgeBatchItem[]): Map<string, Map<string, JudgeOutput>> | null {
  const parsed = extractJsonFromText(text) as { verdicts?: unknown } | null;
  const list = parsed && Array.isArray(parsed.verdicts) ? parsed.verdicts : null;
  if (!list) return null;
  const byId = new Map(items.map((it) => [it.id, it]));
  const out = new Map<string, Map<string, JudgeOutput>>();
  for (const entry of list as Record<string, unknown>[]) {
    const item = byId.get(String(entry?.file ?? "").trim());
    if (!item) continue;
    const named = String(entry?.rubric ?? "").trim();
    const rubric = item.rubrics.find((r) => r.name === named) ?? (item.rubrics.length === 1 && !named ? item.rubrics[0] : undefined);
    if (!rubric) continue;
    const v = validateJudgeOutput(entry, rubric);
    if (!v.ok) continue;
    const verdicts = out.get(item.id) ?? new Map<string, JudgeOutput>();
    verdicts.set(rubric.name, { ...v.data, verdict: ruleVerdict(v.data, rubric.pass_threshold), raw_response_chars: text.length });
    out.set(item.id, verdicts);
  }
  return out.size ? out : null;
}

/**
 * Judge several artifacts in ONE runtime session. Each verdict is derived by
 * `ruleVerdict` with its own rubric's threshold, exactly as `judge()` does, and
 * the audit records one `judge_invoked` for the session and one
 * `critique_generated` per verdict.
 */
export async function judgeBatch(input: JudgeBatchInput, opts: JudgeOpts = {}): Promise<JudgeBatchResult> {
  const rubrics = [...new Map(input.items.flatMap((it) => it.rubrics).map((r) => [r.name, r])).values()];
  const chars = input.items.reduce((n, it) => n + it.artifact.length, 0);
  const ctx = { trace_id: input.trace_id, business_slug: input.business_slug, squad_name: input.squad_name };
  audit().emit("judge_invoked", {
    rubric_name: rubrics.map((r) => r.name).join("+"),
    artifact_chars: chars,
    artifact_large: false,
    batch_files: input.items.length,
  }, ctx);

  if (opts.mock) {
    const verdicts = new Map(input.items.map((it) => [it.id, new Map(it.rubrics.map((r) => [r.name, mockJudge({ rubric: r, artifact: it.artifact }, opts.mockOutput)]))]));
    return { ok: true, judge_runtime: "mock", verdicts };
  }

  const driver = (opts.__testDriver as typeof import("../../_shared/lib/host-agent-driver.ts") | undefined) ?? await hostDriver();
  if (!driver) return { ok: false, reason: "no_runtime", error: "host-agent-driver unavailable" };
  const available = (r: string): boolean => {
    try { return typeof driver.runtimeAvailable === "function" ? driver.runtimeAvailable(r as never) : true; }
    catch { return true; }
  };
  const preferredHost = await resolveJudgePreferredRuntime({ rubric: rubrics[0], artifact: "", brief: input.brief }, opts, available);
  const call = await driver.callHostAgentAsync(buildBatchPersona(rubrics), buildBatchUserMessage(input), {
    ...(typeof opts.timeoutMs === "number" ? { timeoutMs: opts.timeoutMs } : {}),
    ...(preferredHost ? { preferredHost } : {}),
  });
  if ("error" in call) return { ok: false, reason: "call_failed", error: call.error };

  const verdicts = parseBatchAnswer(call.text, input.items);
  if (!verdicts) {
    audit().emit("critique_generated", { rubric_name: rubrics.map((r) => r.name).join("+"), schema_valid: false, schema_errors: ["batch_unparseable"], batch_files: input.items.length }, ctx);
    return { ok: false, reason: "unparseable", error: "the batched answer held no usable verdict" };
  }
  for (const [id, byRubric] of verdicts) {
    for (const v of byRubric.values()) {
      v.judge_runtime = call.host;
      audit().emit("critique_generated", {
        rubric_name: v.rubric_name, verdict: v.verdict, total_score: v.total_score,
        critique_count: v.critique.length, material_count: v.critique.filter((c) => c.severity === "high").length,
        schema_valid: true, judge_runtime: call.host, batch_file: id,
      }, ctx);
    }
  }
  return { ok: true, judge_runtime: call.host, verdicts };
}

export const __internal__ = { buildPersona, buildUserMessage, validateJudgeOutput, extractJsonFromText, buildBatchPersona, buildBatchUserMessage, parseBatchAnswer };
