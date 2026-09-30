// solo-review.ts — the review of a solo delivery, decided by a rule.
//
// The chain reviewed every seat with another full agent, and re-reviewed on
// every rejection: one real run carried 11 reviews for 9 seats, and one seat
// was reviewed five times. Here there is at most one reviewer for the whole
// delivery, and whether there is one at all is a rule over plain signals, not
// a model's call:
//
//   always      every delivery
//   rule        the user asked, the business manifest marks the work sensitive,
//               or the deterministic precheck failed
//   on-request  the user asked, or the precheck failed
//   never       only when the user asks (the user is in command)
//
// `--no-review` from the user wins over everything. The reviewer runs on
// another runtime when one is available (review.runtime: other), reads the
// worker's claims and checks each pointer, and answers with what it CONFIRMED;
// the engine scores it (silence rejects). A rejection goes back to the worker
// in its own session, at most review.max_rounds times, and then the delivery
// goes on with _QA-RESERVATIONS.md naming what was never confirmed.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { runHeadless, runtimeAvailable, type Runtime, type RunHeadlessResult } from "./host-agent-driver.ts";
import { extractJsonObject } from "../../_shared/lib/model-json.ts";
import { doneWhenCriteria, type Criterion } from "./work-brief.ts";

export type ReviewPolicy = "always" | "rule" | "on-request" | "never";

export interface ReviewSignals {
  policy: ReviewPolicy;
  /** The user asked for a review (`--review`). */
  userAsked: boolean;
  /** The user asked for none (`--no-review`). Wins over everything. */
  userDeclined: boolean;
  /** The business manifest marks its work as needing review. */
  sensitive: boolean;
  /** The deterministic precheck failed. */
  precheckFailed: boolean;
}

export interface ReviewDecision { review: boolean; reason: string }

export function decideReview(s: ReviewSignals): ReviewDecision {
  if (s.userDeclined) return { review: false, reason: "the user declined review" };
  if (s.userAsked) return { review: true, reason: "the user asked for review" };
  switch (s.policy) {
    case "always": return { review: true, reason: "review.policy is always" };
    case "never": return { review: false, reason: "review.policy is never" };
    case "rule":
      if (s.sensitive) return { review: true, reason: "the business marks this work as sensitive" };
      if (s.precheckFailed) return { review: true, reason: "the deterministic precheck failed" };
      return { review: false, reason: "no rule asked for review" };
    case "on-request":
      if (s.precheckFailed) return { review: true, reason: "the deterministic precheck failed" };
      return { review: false, reason: "review only on request" };
  }
}

/** Whether a business manifest asks for review: `review: required` or `review_required: true` in business.yaml. */
export function businessWantsReview(bizDir: string): boolean {
  try {
    const doc = parseYaml(fs.readFileSync(path.join(bizDir, "business.yaml"), "utf8"));
    return doc?.review === "required" || doc?.review_required === true;
  } catch { return false; }
}

/** Runtimes in the order a different reviewer is preferred. */
const REVIEW_ORDER: Runtime[] = ["codex", "claude-code", "gemini-cli", "antigravity-cli", "grok-cli", "pi", "kimi-cli", "qwen-code", "opencode"];

/** The reviewer's runtime: another available one when asked for, else the worker's own. */
export function pickReviewRuntime(pref: "other" | "same", worker: Runtime, available: (rt: Runtime) => boolean = runtimeAvailable): Runtime {
  if (pref === "same") return worker;
  return REVIEW_ORDER.find((rt) => rt !== worker && available(rt)) ?? worker;
}

export interface Claim { id: string; evidence: string }

export function readClaims(file: string): Claim[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.claims) ? raw.claims : null;
    if (!list) return null;
    return list
      .map((c: any) => ({ id: String(c?.id ?? "").trim(), evidence: String(c?.evidence ?? "").trim() }))
      .filter((c: Claim) => c.id);
  } catch { return null; }
}

/** Files a delivery produced, leaving out the working folder and the worker's own reports. */
export function deliverableFiles(outputsRoot: string): string[] {
  const skip = new Set(["_SUMMARY.md", "_CLAIMS.json", "_QA-RESERVATIONS.md"]);
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!rel && (e.name === "_work" || e.name === "_review")) continue; walk(path.join(dir, e.name), r); }
      else if (!(!rel && skip.has(e.name))) out.push(r);
    }
  };
  walk(outputsRoot, "");
  return out;
}

export interface Precheck { ok: boolean; problems: string[] }

/** What can be checked without a model: there is a delivery, a summary, and a claim with evidence for every blocking criterion. */
export function precheckSolo(outputsRoot: string, criteria: Criterion[]): Precheck {
  const problems: string[] = [];
  if (!deliverableFiles(outputsRoot).length) problems.push("no deliverable file under the outputs root");
  if (!fs.existsSync(path.join(outputsRoot, "_SUMMARY.md"))) problems.push("_SUMMARY.md is missing");
  const claims = readClaims(path.join(outputsRoot, "_CLAIMS.json"));
  if (!claims) problems.push("_CLAIMS.json is missing or not a JSON array");
  else {
    for (const c of criteria.filter((x) => x.blocking)) {
      const claim = claims.find((x) => x.id === c.id);
      if (!claim || claim.evidence.length < 12) problems.push(`no evidence claimed for blocking criterion ${c.id}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** The reviewer's prompt: the brief, the criteria, the worker's claims, and the rule that silence rejects. */
export function buildSoloReviewPrompt(o: { business: string; briefFile: string; outputsRoot: string; criteria: Criterion[]; claims: Claim[] | null }): string {
  const list = o.criteria.length
    ? o.criteria.map((c) => `- \`${c.id}\`${c.blocking ? " **(blocking)**" : ""}: ${c.description}`).join("\n")
    : "- (the brief has no \"Done when\" items; judge against the brief and say so in `notes`)";
  const claims = o.claims?.length
    ? o.claims.map((c) => `- \`${c.id}\`: ${c.evidence}`).join("\n")
    : "- (the worker claimed nothing; find the evidence yourself)";
  return [
    `# Review of the ${o.business} delivery`,
    "",
    "You did not do this work; you check it. Open the files, never judge from the summary alone.",
    "",
    `- Brief: \`${o.briefFile}\``,
    `- Delivery: \`${o.outputsRoot}\` (the worker's summary is \`_SUMMARY.md\` there)`,
    "",
    "## Criteria",
    list,
    "",
    "## What the worker claims",
    "Start from these pointers, and check each one where it points.",
    claims,
    "",
    "## Your answer: ONE JSON object, nothing else",
    "```json",
    '{"confirmed":[{"id":"<criterion id>","evidence":"<file:line, or a quote>"}],',
    ' "unconfirmed":[{"id":"<criterion id>","why":"<what is missing, concretely>"}],',
    ' "notes":"<one line, optional>"}',
    "```",
    "",
    "- An id that is not in the list above is dropped.",
    "- A criterion is confirmed only with real evidence: a path, a line, a quote.",
    "- Anything you do not mention counts as unconfirmed.",
    "- Do not write a verdict or a score; the engine computes both.",
  ].join("\n");
}

export const REVIEW_SCORE_FLOOR = 0.9;

export interface ReviewScore {
  approved: boolean;
  score: number;
  confirmed: string[];
  gaps: { id: string; blocking: boolean; why: string }[];
  blockingMissed: string[];
  invented: string[];
}

/** The same scoring the chain's `nrv team verdict` applies: silence rejects, a shrug is not evidence. */
export function scoreSoloReview(raw: any, criteria: Criterion[], floor = REVIEW_SCORE_FLOOR): ReviewScore {
  const known = new Set(criteria.map((c) => c.id));
  const confirmed = new Set<string>();
  const invented: string[] = [];
  for (const c of Array.isArray(raw?.confirmed) ? raw.confirmed : []) {
    const id = typeof c?.id === "string" ? c.id : "";
    if (!known.has(id)) { if (id) invented.push(id); continue; }
    if (String(c?.evidence ?? "").trim().length >= 12) confirmed.add(id);
  }
  const score = criteria.length === 0 ? 1 : confirmed.size / criteria.length;
  const blockingMissed = criteria.filter((c) => c.blocking && !confirmed.has(c.id)).map((c) => c.id);
  const gaps = criteria.filter((c) => !confirmed.has(c.id)).map((c) => {
    const said = (Array.isArray(raw?.unconfirmed) ? raw.unconfirmed : []).find((u: any) => u?.id === c.id);
    return { id: c.id, blocking: c.blocking, why: String(said?.why ?? "not mentioned by the reviewer").slice(0, 300) };
  });
  return { approved: score >= floor && blockingMissed.length === 0, score, confirmed: [...confirmed], gaps, blockingMissed, invented };
}

export function buildRevisionPrompt(gaps: ReviewScore["gaps"], criteria: Criterion[]): string {
  const byId = new Map(criteria.map((c) => [c.id, c]));
  return [
    "The review did not confirm these criteria of your brief. Fix the delivery so each one holds, then update _CLAIMS.json and _SUMMARY.md, and end your turn.",
    "",
    ...gaps.map((g) => `- \`${g.id}\`${g.blocking ? " (blocking)" : ""}: ${byId.get(g.id)?.description ?? ""}. Reviewer: ${g.why}`),
  ].join("\n");
}

/** Append what was never confirmed to _QA-RESERVATIONS.md, keeping what is already there. */
export function writeReservations(outputsRoot: string, gaps: ReviewScore["gaps"], criteria: Criterion[], reason: string): string {
  const file = path.join(outputsRoot, "_QA-RESERVATIONS.md");
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const block = [
    fs.existsSync(file) ? "" : "# QA reservations\n",
    `## Review (${reason})`,
    "",
    ...gaps.map((g) => `- ${g.blocking ? "**blocking** " : ""}${byId.get(g.id)?.description ?? g.id}: ${g.why}`),
    "",
    "The review itself can be the wrong side of a disagreement; read the delivery before discarding it.",
    "",
  ].join("\n");
  fs.appendFileSync(file, block, "utf8");
  return file;
}

export interface SoloReviewArgs {
  business: string;
  bizDir: string;
  briefFile: string;
  outputsRoot: string;
  projectRoot: string;
  worker: { runtime: Runtime; sessionId: string | null; launch: { cwd: string; addDirs: string[]; appendSystemPrompt: string; workspace?: string } };
  policy: ReviewPolicy;
  runtimePref: "other" | "same";
  maxRounds: number;
  userAsked: boolean;
  userDeclined: boolean;
  yolo?: boolean;
  timeoutMs?: number;
  emit?: (event: string, payload: Record<string, unknown>) => void;
  log?: (message: string) => void;
  /** Test seams. */
  runImpl?: (opts: Parameters<typeof runHeadless>[0]) => RunHeadlessResult;
  available?: (rt: Runtime) => boolean;
}

export interface SoloReviewOutcome {
  decision: ReviewDecision;
  precheck: Precheck;
  reviewer: Runtime | null;
  rounds: number;
  approved: boolean | null;
  reservations: string | null;
}

/** Decide, review, send back at most maxRounds times, and leave reservations for what never held. */
export function runSoloReviewStage(a: SoloReviewArgs): SoloReviewOutcome {
  const emit = a.emit ?? (() => {});
  const log = a.log ?? (() => {});
  const run = a.runImpl ?? runHeadless;
  const briefText = (() => { try { return fs.readFileSync(a.briefFile, "utf8"); } catch { return ""; } })();
  const criteria = doneWhenCriteria(briefText);
  let precheck = precheckSolo(a.outputsRoot, criteria);
  const decision = decideReview({
    policy: a.policy, userAsked: a.userAsked, userDeclined: a.userDeclined,
    sensitive: businessWantsReview(a.bizDir), precheckFailed: !precheck.ok,
  });
  emit("x_solo_review_decided", { business_slug: a.business, review: decision.review, reason: decision.reason, precheck_problems: precheck.problems });
  log(`  review: ${decision.review ? "yes" : "no"} (${decision.reason})${precheck.ok ? "" : ` · precheck: ${precheck.problems.join("; ")}`}`);
  if (!decision.review) return { decision, precheck, reviewer: null, rounds: 0, approved: null, reservations: null };

  const reviewer = pickReviewRuntime(a.runtimePref, a.worker.runtime, a.available);
  const reviewDir = path.join(a.outputsRoot, "_review");
  fs.mkdirSync(reviewDir, { recursive: true });
  let rounds = 0;
  let score: ReviewScore | null = null;
  for (;;) {
    const prompt = buildSoloReviewPrompt({
      business: a.business, briefFile: a.briefFile, outputsRoot: a.outputsRoot, criteria,
      claims: readClaims(path.join(a.outputsRoot, "_CLAIMS.json")),
    });
    fs.writeFileSync(path.join(reviewDir, `prompt-${rounds}.md`), prompt);
    const r = run({
      runtime: reviewer, prompt, cwd: a.outputsRoot, addDirs: [a.outputsRoot, path.dirname(a.briefFile)],
      allowedTools: ["Read", "Grep", "Glob"], dispatchRole: "planner", yolo: a.yolo ?? true, timeoutMs: a.timeoutMs,
    } as Parameters<typeof runHeadless>[0]);
    fs.writeFileSync(path.join(reviewDir, `answer-${rounds}.txt`), r.result ?? "");
    let raw: any = null;
    try { raw = extractJsonObject(r.result ?? "") ?? JSON.parse(r.result ?? ""); } catch { raw = null; }
    score = scoreSoloReview(raw ?? {}, criteria);
    emit(score.approved ? "x_review_approved" : "x_review_rejected", {
      business_slug: a.business, reviewer_runtime: reviewer, round: rounds, score: Number(score.score.toFixed(3)),
      confirmed: score.confirmed, ...(score.gaps.length ? { gaps: score.gaps } : {}), ...(score.invented.length ? { invented_ids: score.invented } : {}),
    });
    log(`  review round ${rounds} on ${reviewer}: ${score.approved ? "approved" : "rejected"} (score ${score.score.toFixed(2)})`);
    if (score.approved || rounds >= a.maxRounds || !a.worker.sessionId) break;
    rounds++;
    const fix = run({
      runtime: a.worker.runtime, prompt: buildRevisionPrompt(score.gaps, criteria), sessionId: a.worker.sessionId,
      cwd: a.worker.launch.cwd, addDirs: a.worker.launch.addDirs, appendSystemPrompt: a.worker.launch.appendSystemPrompt,
      ...(a.worker.launch.workspace ? { workspace: a.worker.launch.workspace } : {}),
      dispatchRole: "solo", yolo: a.yolo ?? true, timeoutMs: a.timeoutMs,
    } as Parameters<typeof runHeadless>[0]);
    emit("x_solo_revision", { business_slug: a.business, round: rounds, ok: fix.ok, runtime: a.worker.runtime });
    if (!fix.ok) { log(`  revision round ${rounds} failed: ${fix.error ?? "unknown"}`); break; }
    precheck = precheckSolo(a.outputsRoot, criteria);
  }
  const reservations = score && !score.approved
    ? writeReservations(a.outputsRoot, score.gaps, criteria, `${rounds} correction round(s), reviewer ${reviewer}`)
    : null;
  return { decision, precheck, reviewer, rounds, approved: score?.approved ?? null, reservations };
}
