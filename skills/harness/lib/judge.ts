/**
 * judge.ts — runs the LLM judge against an artifact + rubric and returns a
 * structured verdict. Delegates the actual LLM call to host-agent-driver so
 * the harness stays runtime-agnostic.
 *
 * Phase 3 da nirvana-evolution.
 *
 * The judge prompt is constructed from the rubric body. The schema the judge
 * must return is documented in each rubric's markdown. We validate the
 * response against `JudgeOutput` and fall back to a soft "schema_invalid"
 * verdict (fail) when malformed.
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

/**
 * Judge runtime selection — consult the user's runtime rules (USE_* /
 * NOT_USE_* in .env, via runtime-rules.ts decideRuntime) instead of blindly
 * taking the first CLI on PATH. Returns the preferred runtime slug, or null
 * when there is no real signal (no rules AND no detectable session host) —
 * null keeps the driver's historical PATH-scan fallback.
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
    const currentHost = rules_mod.detectCurrentHost?.() ?? null;
    if ((!rules || rules.length === 0) && !currentHost) return null;
    const decision = rules_mod.decideRuntime({
      brief: input.brief ?? "",
      explicitRuntime: null,
      defaultRuntime: currentHost ?? "claude-code",
      rules,
      mode: "fast",
      available,
    });
    if (!decision?.runtime) return null;
    // A "default" decision built on the synthetic claude-code placeholder
    // (no detectable session host) is not a real signal — PATH scan instead.
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

export interface HardGateResult {
  name: string;
  passed: boolean;
  rationale: string;
}

export interface JudgeOutput {
  verdict: "pass" | "fail";
  total_score: number;
  criteria_scores: CriteriaScore[];
  critique: CritiqueItem[];
  hard_gate_results: HardGateResult[];
  rubric_name: string;
  judge_runtime: string;
  raw_response_chars?: number;
  schema_valid: boolean;
  schema_errors?: string[];
}

function buildPersona(rubric: RubricMeta): string {
  const hardGates = rubric.hard_gates ?? [];
  const hardGateContract = hardGates.length ? [
    ``,
    `The engine declares these non-negotiable hard gates:`,
    ...hardGates.map((name) => `- ${name}`),
    `Return a hard_gate_results array with exactly one object per declared name and no other names:`,
    `{"name":"<exact name>","passed":true|false,"rationale":"<evidence>"}.`,
    `rationale must be a non-empty string containing the evidence for that gate.`,
    `Unknown names, duplicates and malformed entries invalidate the response.`,
    `A missing or false hard gate means verdict: "fail", regardless of total score.`,
  ] : [];
  return [
    `You are an impartial quality judge for an autonomous multi-agent system.`,
    `You apply ONE rubric strictly: "${rubric.display_name}".`,
    `You evaluate produced artifacts against the rubric's criteria.`,
    ``,
    `You MUST return ONLY a single JSON object matching the schema declared at`,
    `the end of the rubric. No prose, no markdown fences, no preamble. JSON only.`,
    ``,
    `You are calibrated, not lenient. Avoid grade inflation. Pass threshold is`,
    `${rubric.pass_threshold}. Total score below the threshold → verdict: "fail".`,
    `When score is exactly at the threshold, prefer "fail" — the bar is the floor.`,
    ...hardGateContract,
    ``,
    `========================`,
    `RUBRIC BODY:`,
    `========================`,
    rubric.body,
  ].join("\n");
}

function evaluateHardGateResults(raw: unknown, rubric: RubricMeta): {
  results: HardGateResult[];
  failed: HardGateResult[];
  errors: string[];
} {
  const declared = rubric.hard_gates ?? [];
  if (declared.length === 0) return { results: [], failed: [], errors: [] };
  if (!Array.isArray(raw)) {
    return { results: [], failed: [], errors: ["hard_gate_results_not_array"] };
  }

  const byName = new Map<string, HardGateResult>();
  const errors: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object") {
      errors.push(`hard_gate_result_invalid:${i}`);
      continue;
    }
    const value = item as Record<string, unknown>;
    if (typeof value.name !== "string" || value.name.trim().length === 0 || value.name !== value.name.trim()) {
      errors.push(`hard_gate_result_name_invalid:${i}`);
      continue;
    }
    const name = value.name;
    if (!declared.includes(name)) {
      errors.push(`hard_gate_result_unknown:${name}`);
      continue;
    }
    if (byName.has(name)) {
      errors.push(`hard_gate_result_duplicate:${name}`);
      continue;
    }
    if (typeof value.passed !== "boolean") {
      errors.push(`hard_gate_result_passed_not_boolean:${name}`);
      continue;
    }
    if (typeof value.rationale !== "string" || value.rationale.trim().length === 0) {
      errors.push(`hard_gate_result_rationale_invalid:${name}`);
      continue;
    }
    byName.set(name, {
      name,
      passed: value.passed,
      rationale: value.rationale.trim(),
    });
  }
  for (const name of declared) {
    if (!byName.has(name)) errors.push(`hard_gate_result_missing:${name}`);
  }
  const results = declared.flatMap((name) => byName.has(name) ? [byName.get(name)!] : []);
  return { results, failed: results.filter((gate) => !gate.passed), errors };
}

function buildUserMessage(input: JudgeInput): string {
  const briefBlock = input.brief ? `\n## Brief\n${input.brief}\n` : "";
  const kindBlock = input.artifact_kind ? `\n## Artifact kind\n${input.artifact_kind}\n` : "";
  const ctxBlock = input.context ? `\n## Context\n${JSON.stringify(input.context, null, 2)}\n` : "";
  return [
    `## Artifact to evaluate`,
    `\`\`\``,
    input.artifact.length > 30_000 ? input.artifact.slice(0, 30_000) + "\n[…truncated…]" : input.artifact,
    `\`\`\``,
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
  const hardGates = evaluateHardGateResults(o.hard_gate_results, rubric);
  errors.push(...hardGates.errors);
  if (errors.length > 0) return { ok: false, errors };
  const critique = (o.critique as CritiqueItem[]).map((it, i) => ({
    id: String(it.id ?? `c${i + 1}`),
    severity: ((it.severity ?? "medium") as CritiqueItem["severity"]),
    issue: String(it.issue ?? ""),
    suggested_fix: String(it.suggested_fix ?? ""),
  }));
  for (const gate of hardGates.failed) {
    critique.push({
      id: `hard_gate:${gate.name}`,
      severity: "high",
      issue: `Hard gate failed: ${gate.name}${gate.rationale ? ` — ${gate.rationale}` : ""}`,
      suggested_fix: `Correct ${gate.name} in the final artifact and re-run the gate.`,
    });
  }
  return {
    ok: true,
    data: {
      verdict: hardGates.failed.length ? "fail" : o.verdict as "pass" | "fail",
      total_score: o.total_score as number,
      criteria_scores: (o.criteria_scores as CriteriaScore[]).map((c) => ({
        name: String(c.name ?? ""),
        score: Number(c.score ?? 0),
        weight: Number(c.weight ?? 0),
        rationale: String(c.rationale ?? ""),
        severity: ((c.severity ?? null) as CriteriaScore["severity"]),
        fixable: Boolean(c.fixable ?? false),
      })),
      critique,
      hard_gate_results: hardGates.results,
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
   * expose loadRuntimeRules, detectCurrentHost, decideRuntime. */
  __testRuntimeRules?: unknown;
}

/**
 * Mock judge — useful for unit tests and dry runs (no LLM cost).
 */
export function mockJudge(input: JudgeInput, override?: Partial<JudgeOutput>): JudgeOutput {
  const score = override?.total_score ?? 85;
  const hardGates = evaluateHardGateResults(override?.hard_gate_results, input.rubric);
  const hardGateCritique: CritiqueItem[] = hardGates.failed.map((gate) => ({
    id: `hard_gate:${gate.name}`,
    severity: "high",
    issue: `Hard gate failed: ${gate.name}${gate.rationale ? ` — ${gate.rationale}` : ""}`,
    suggested_fix: `Correct ${gate.name} in the final artifact and re-run the gate.`,
  }));
  const schemaValid = hardGates.errors.length === 0;
  return {
    verdict: !schemaValid || hardGates.failed.length
      ? "fail"
      : override?.verdict ?? (score >= input.rubric.pass_threshold ? "pass" : "fail"),
    total_score: score,
    criteria_scores: override?.criteria_scores ?? [
      { name: "mock", score: 8, weight: 10, rationale: "mocked", severity: null, fixable: true },
    ],
    critique: [...(override?.critique ?? []), ...hardGateCritique],
    hard_gate_results: hardGates.results,
    rubric_name: input.rubric.name,
    judge_runtime: "mock",
    schema_valid: schemaValid,
    ...(schemaValid ? {} : { schema_errors: hardGates.errors }),
  };
}

/**
 * Real judge — invokes host-agent-driver. Async.
 */
export async function judge(input: JudgeInput, opts: JudgeOpts = {}): Promise<JudgeOutput> {
  audit().emit("judge_invoked", {
    rubric_name: input.rubric.name,
    artifact_chars: input.artifact.length,
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
      hard_gate_results: [],
      rubric_name: input.rubric.name,
      judge_runtime: "none",
      schema_valid: false,
      schema_errors: ["no_runtime_available"],
    };
  }

  const persona = buildPersona(input.rubric);
  const userMsg = buildUserMessage(input);

  // Runtime-rules consultation (routing-360 Phase 4.4): USE_*/NOT_USE_* rules
  // and the detected session host pick the judge runtime; without a signal the
  // driver keeps its historical PATH-scan.
  const available = (r: string): boolean => {
    try { return typeof driver.runtimeAvailable === "function" ? driver.runtimeAvailable(r as never) : true; }
    catch { return true; }
  };
  const preferredHost = await resolveJudgePreferredRuntime(input, opts, available);

  const call = await driver.callHostAgentAsync(persona, userMsg, {
    timeoutMs: opts.timeoutMs ?? 60_000,
    ...(preferredHost ? { preferredHost } : {}),
  });

  if ("error" in call) {
    return {
      verdict: "fail",
      total_score: 0,
      criteria_scores: [],
      critique: [{ id: "judge_runtime_error", severity: "high", issue: `judge LLM call failed: ${call.error}`, suggested_fix: "retry with backoff or fall back to mock" }],
      hard_gate_results: [],
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
      hard_gate_results: [],
      rubric_name: input.rubric.name,
      judge_runtime: call.host,
      schema_valid: false,
      schema_errors: v.errors,
      raw_response_chars: call.text.length,
    };
  }

  const result: JudgeOutput = {
    ...v.data,
    judge_runtime: call.host,
    raw_response_chars: call.text.length,
  };

  audit().emit("critique_generated", {
    rubric_name: input.rubric.name,
    verdict: result.verdict,
    total_score: result.total_score,
    critique_count: result.critique.length,
    schema_valid: true,
    judge_runtime: result.judge_runtime,
  }, {
    trace_id: input.trace_id,
    business_slug: input.business_slug,
    squad_name: input.squad_name,
  });

  return result;
}

export const __internal__ = { buildPersona, buildUserMessage, validateJudgeOutput, extractJsonFromText, evaluateHardGateResults };
