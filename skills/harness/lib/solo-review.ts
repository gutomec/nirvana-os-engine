// solo-review.ts — the review of a solo delivery, decided by a rule.
//
// One reviewer for the whole delivery, and whether there is one at all is a
// rule over plain signals, not a model's call:
//
//   always      every delivery
//   rule        the user asked, the business manifest marks the work sensitive,
//               or the deterministic precheck failed
//   on-request  the user asked, or the precheck failed
//   never       only when the user asks (the user is in command)
//
// `--no-review` from the user wins over everything. The reviewer runs on the
// session's runtime (review.runtime: same), or on another installed runtime no
// NOT_USE_* rule vetoes when the user asks for one (other). It reads the
// worker's claims and checks each pointer, and answers with what it CONFIRMED;
// the engine scores it (silence rejects, and a brief with no "Done when" to
// check is never approved). A rejection goes back to the worker in its own
// session, at most review.max_rounds times; a blocking criterion still missed
// gets up to SERIOUS_EXTRA_ROUNDS more, and the delivery pipeline treats what
// is left of it as serious. Everything else that never held lands in
// _QA-RESERVATIONS.md.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { runHeadless, runtimeAvailable, type Runtime, type RunHeadlessResult } from "./host-agent-driver.ts";
import { extractJsonObject } from "../../_shared/lib/model-json.ts";
import { isRunStateFile } from "../../_shared/lib/run-plumbing.ts";
import { doneWhenCriteria, type Criterion } from "./work-brief.ts";
import { soloDirective } from "./business-solo.ts";
import { loadRuntimeRules, matchedVetoes, type RuntimeRule } from "./runtime-rules.ts";

export type ReviewPolicy = "always" | "rule" | "on-request" | "never";

/** Correction rounds a SERIOUS finding gets beyond the normal limit (owner
 *  rule, shared with the delivery pipeline): a style note stops at the limit
 *  and ships with reservations; a serious one keeps being corrected, and what
 *  is still serious after these rounds is withheld. */
export const SERIOUS_EXTRA_ROUNDS = 3;

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

/** Whether a business manifest asks for review: `review: required` in business.yaml. */
export function businessWantsReview(bizDir: string): boolean {
  try { return parseYaml(fs.readFileSync(path.join(bizDir, "business.yaml"), "utf8"))?.review === "required"; }
  catch { return false; }
}

/** Runtimes in the order a different reviewer is preferred. */
const REVIEW_ORDER: Runtime[] = ["codex", "claude-code", "gemini-cli", "antigravity-cli", "grok-cli", "pi", "kimi-cli", "qwen-code", "opencode"];

/** The reviewer's runtime: the worker's own (the session's) by default; with
 *  `other`, the first installed runtime that is not the worker's and that no
 *  NOT_USE_* rule vetoes for this brief, else the worker's own. */
export function pickReviewRuntime(
  pref: "other" | "same",
  worker: Runtime,
  available: (rt: Runtime) => boolean = runtimeAvailable,
  vetoed: (rt: Runtime) => boolean = () => false,
): Runtime {
  if (pref === "same") return worker;
  return REVIEW_ORDER.find((rt) => rt !== worker && available(rt) && !vetoed(rt)) ?? worker;
}

// ── the brief's criteria ──────────────────────────────────────────────────


/**
 * The "Done when" items of a work brief as review criteria, ids d1..dn in
 * order. Only top-level bullets count. An item is blocking when it ends in
 * "(blocking)" / "(bloqueante)" or opens with "must" / "deve". An empty list
 * means the brief gives nothing to check: no section, or no bullet in it.
 */
export function criteriaFromBrief(text: string): Criterion[] {
  return doneWhenCriteria(text);
}

// ── the worker's claims ───────────────────────────────────────────────────

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

/** The file references an evidence string carries: backticked spans and
 *  path-shaped tokens, with a `:12`, `:10-40` or `#L12` line suffix removed.
 *  Either separator; relative or absolute. */
export function evidencePaths(evidence: string): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    let t = raw.trim().replace(/^["'(<[]+/, "").replace(/[>"')\],;.]+$/, "");
    t = t.replace(/#L\d+(?:-L?\d+)?$/i, "").replace(/:\d+(?:-\d+)?(?::\d+)?$/, "");
    if (/[^\\/]\.[A-Za-z0-9]{1,8}$/.test(t)) out.add(t);
  };
  for (const m of evidence.matchAll(/`([^`]+)`/g)) add(m[1]);
  for (const token of evidence.replace(/`[^`]*`/g, " ").split(/[\s,;]+/)) if (token) add(token);
  return [...out];
}

function realOrSame(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return p; }
}

/**
 * The deliverable an evidence string points at: the first named file that
 * exists under the outputs root and is work, not run state (`_SUMMARY.md` is
 * the worker's own claim, never its proof). null when there is none. Paths are
 * normalised from either separator and resolved against the outputs root.
 */
export function evidenceFileUnder(outputsRoot: string, evidence: string): string | null {
  const root = realOrSame(path.resolve(outputsRoot));
  for (const ref of evidencePaths(evidence)) {
    const norm = ref.replace(/\\/g, "/");
    const absolute = path.isAbsolute(norm) || /^[A-Za-z]:\//.test(norm);
    const candidate = absolute ? path.resolve(norm) : path.resolve(root, norm);
    let isFile = false;
    try { isFile = fs.statSync(candidate).isFile(); } catch { isFile = false; }
    if (!isFile) continue;
    const rel = path.relative(root, realOrSame(candidate));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (isRunStateFile(rel)) continue;
    return candidate;
  }
  return null;
}

export interface ClaimProblem { id: string; description: string; why: string }

/** Every blocking criterion without a claim whose evidence names a file that
 *  exists under the outputs root. The cheap, model-free half of a review, and
 *  the claims check the delivery pipeline runs on every business delivery. */
export function claimProblems(outputsRoot: string, criteria: Criterion[]): ClaimProblem[] {
  const blocking = criteria.filter((c) => c.blocking);
  if (!blocking.length) return [];
  const claims = readClaims(path.join(outputsRoot, "_CLAIMS.json"));
  const out: ClaimProblem[] = [];
  for (const c of blocking) {
    const claim = claims?.find((x) => x.id === c.id);
    if (!claims) out.push({ id: c.id, description: c.description, why: "_CLAIMS.json is missing or not a JSON array" });
    else if (!claim || !claim.evidence) out.push({ id: c.id, description: c.description, why: "no claim for it in _CLAIMS.json" });
    else if (!evidenceFileUnder(outputsRoot, claim.evidence)) {
      out.push({ id: c.id, description: c.description, why: `its evidence ("${claim.evidence.slice(0, 160)}") names no file that exists under the outputs root` });
    }
  }
  return out;
}

/** Files a delivery produced: everything under the outputs root that is not run state. */
export function deliverableFiles(outputsRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!isRunStateFile(`${r}/`)) walk(path.join(dir, e.name), r); }
      else if (!isRunStateFile(r)) out.push(r);
    }
  };
  walk(outputsRoot, "");
  return out;
}

export interface Precheck { ok: boolean; problems: string[] }

export const NO_DELIVERABLE = "no deliverable file under the outputs root";

/** What can be checked without a model: there is a delivery, a summary, and,
 *  for every blocking criterion, a claim whose evidence names a file that
 *  exists under the outputs root. */
export function precheckSolo(outputsRoot: string, criteria: Criterion[]): Precheck {
  const problems: string[] = [];
  if (!deliverableFiles(outputsRoot).length) problems.push(NO_DELIVERABLE);
  if (!fs.existsSync(path.join(outputsRoot, "_SUMMARY.md"))) problems.push("_SUMMARY.md is missing");
  const claims = readClaims(path.join(outputsRoot, "_CLAIMS.json"));
  if (!claims) problems.push("_CLAIMS.json is missing or not a JSON array");
  else {
    for (const p of claimProblems(outputsRoot, criteria)) {
      problems.push(p.why.startsWith("no claim")
        ? `no evidence claimed for blocking criterion ${p.id}`
        : `the evidence for blocking criterion ${p.id} names no file that exists under the outputs root`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// ── the reviewer ──────────────────────────────────────────────────────────

/** The reviewer's prompt: the brief, the criteria, the worker's claims, and the rule that silence rejects. */
export function buildSoloReviewPrompt(o: { business: string; briefFile: string; outputsRoot: string; criteria: Criterion[]; claims: Claim[] | null }): string {
  const list = o.criteria.length
    ? o.criteria.map((c) => `- \`${c.id}\`${c.blocking ? " **(blocking)**" : ""}: ${c.description}`).join("\n")
    : "- (the brief has no \"Done when\" items, so nothing can be confirmed against it; judge against the brief and say what you found in `notes`)";
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
    "## Statements nobody can trace",
    "List every figure, price, date, guarantee, promise or factual claim in the delivery that neither the brief nor a source you can open (a file, or a source the delivery cites) supports. An invented number is a defect even when every criterion holds.",
    "",
    "## Your answer: ONE JSON object, nothing else",
    "```json",
    '{"confirmed":[{"id":"<criterion id>","evidence":"<file:line, or a quote>"}],',
    ' "unconfirmed":[{"id":"<criterion id>","why":"<what is missing, concretely>"}],',
    ' "untraceable":[{"where":"<file:line>","what":"<the statement, and why nothing supports it>"}],',
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

export interface Untraceable { where: string; what: string }

export interface ReviewScore {
  approved: boolean;
  score: number;
  confirmed: string[];
  gaps: { id: string; blocking: boolean; why: string }[];
  blockingMissed: string[];
  invented: string[];
  untraceable: Untraceable[];
}

/** Silence rejects, a shrug is not evidence, an untraceable statement is a
 *  gap, and a brief with nothing to check is never approved. */
export function scoreSoloReview(raw: any, criteria: Criterion[], floor = REVIEW_SCORE_FLOOR): ReviewScore {
  const known = new Set(criteria.map((c) => c.id));
  const confirmed = new Set<string>();
  const invented: string[] = [];
  for (const c of Array.isArray(raw?.confirmed) ? raw.confirmed : []) {
    const id = typeof c?.id === "string" ? c.id : "";
    if (!known.has(id)) { if (id) invented.push(id); continue; }
    if (String(c?.evidence ?? "").trim().length >= 12) confirmed.add(id);
  }
  const untraceable = (Array.isArray(raw?.untraceable) ? raw.untraceable : [])
    .map((u: any) => ({ where: String(u?.where ?? "").trim().slice(0, 200), what: String(u?.what ?? "").trim().slice(0, 300) }))
    .filter((u: Untraceable) => u.where || u.what);
  if (criteria.length === 0) {
    return {
      approved: false, score: 0, confirmed: [], blockingMissed: [], invented, untraceable,
      gaps: [{ id: "done-when", blocking: false, why: "the brief has no \"Done when\" items, so the review could confirm nothing against it" }],
    };
  }
  const score = confirmed.size / criteria.length;
  const blockingMissed = criteria.filter((c) => c.blocking && !confirmed.has(c.id)).map((c) => c.id);
  const gaps = criteria.filter((c) => !confirmed.has(c.id)).map((c) => {
    const said = (Array.isArray(raw?.unconfirmed) ? raw.unconfirmed : []).find((u: any) => u?.id === c.id);
    return { id: c.id, blocking: c.blocking, why: String(said?.why ?? "not mentioned by the reviewer").slice(0, 300) };
  });
  return {
    approved: score >= floor && blockingMissed.length === 0 && untraceable.length === 0,
    score, confirmed: [...confirmed], gaps, blockingMissed, invented, untraceable,
  };
}

export function buildRevisionPrompt(gaps: ReviewScore["gaps"], criteria: Criterion[], untraceable: Untraceable[] = []): string {
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const known = gaps.filter((g) => byId.has(g.id));
  return [
    "The review did not confirm your delivery. Fix it, then update _CLAIMS.json and _SUMMARY.md, and end your turn.",
    ...(known.length ? ["", "Criteria of your brief the review could not confirm:",
      ...known.map((g) => `- \`${g.id}\`${g.blocking ? " (blocking)" : ""}: ${byId.get(g.id)?.description ?? ""}. Reviewer: ${g.why}`)] : []),
    ...(untraceable.length ? ["", "Statements the review could not trace to the brief or to a source: remove each one, or cite where it comes from in the delivery.",
      ...untraceable.map((u) => `- ${u.where ? `${u.where}: ` : ""}${u.what}`)] : []),
  ].join("\n");
}

/** What a worker is told when the precheck found no deliverable at all: there
 *  is nothing for a reviewer to open yet. */
export function buildPrecheckRevisionPrompt(problems: string[], outputsRoot: string): string {
  return [
    `Your delivery is not on disk: the engine found no deliverable under ${outputsRoot}. Write the deliverables your brief asks for there, then _SUMMARY.md and _CLAIMS.json, and end your turn.`,
    "",
    ...problems.map((p) => `- ${p}`),
  ].join("\n");
}

/** Append what was never confirmed to _QA-RESERVATIONS.md, keeping what is already there. */
export function writeReservations(outputsRoot: string, gaps: ReviewScore["gaps"], criteria: Criterion[], reason: string, untraceable: Untraceable[] = []): string {
  const file = path.join(outputsRoot, "_QA-RESERVATIONS.md");
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const block = [
    fs.existsSync(file) ? "" : "# QA reservations\n",
    `## Review (${reason})`,
    "",
    ...gaps.map((g) => `- ${g.blocking ? "**blocking** " : ""}${byId.get(g.id)?.description ?? g.id}: ${g.why}`),
    ...untraceable.map((u) => `- untraceable ${u.where ? `(${u.where}) ` : ""}${u.what}`),
    "",
    "The review itself can be the wrong side of a disagreement; read the delivery before discarding it.",
    "",
  ].join("\n");
  fs.mkdirSync(outputsRoot, { recursive: true });
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
  /** The run's spend ceiling, passed to the reviewer and to every correction run. */
  maxBudgetUsd?: number;
  /** The run's ledger row: the reviewer and the corrections heartbeat it, so
   *  the supervisor never takes a run under review for a dead one. */
  ledger?: { runId: string; watchDir?: string };
  /** The project's runtime rules, for a correction run's solo directive when the launch carries none. */
  rulesDirective?: string;
  emit?: (event: string, payload: Record<string, unknown>) => void;
  log?: (message: string) => void;
  /** Test seams. */
  runImpl?: (opts: Parameters<typeof runHeadless>[0]) => RunHeadlessResult;
  available?: (rt: Runtime) => boolean;
  /** The NOT_USE_* rules to honour when picking another runtime (default: the project's). */
  rules?: RuntimeRule[];
}

export interface SoloReviewOutcome {
  decision: ReviewDecision;
  precheck: Precheck;
  reviewer: Runtime | null;
  rounds: number;
  /** null when no review verdict exists: none was due, or it was skipped. */
  approved: boolean | null;
  reservations: string | null;
  /** Blocking criteria the last review did not confirm. The delivery pipeline
   *  counts each as SERIOUS (`reviewBlockingMissed`). */
  blockingMissed: string[];
  /** Why the review did not run although it was due. */
  skipped: "no-deliverable" | "reviewer-failed" | null;
}

/** Decide, review, send back within the round limits, and leave reservations for what never held. */
export function runSoloReviewStage(a: SoloReviewArgs): SoloReviewOutcome {
  const emit = a.emit ?? (() => {});
  const log = a.log ?? (() => {});
  const run = a.runImpl ?? runHeadless;
  const briefText = (() => { try { return fs.readFileSync(a.briefFile, "utf8"); } catch { return ""; } })();
  const criteria = criteriaFromBrief(briefText);
  let precheck = precheckSolo(a.outputsRoot, criteria);
  const decision = decideReview({
    policy: a.policy, userAsked: a.userAsked, userDeclined: a.userDeclined,
    sensitive: businessWantsReview(a.bizDir), precheckFailed: !precheck.ok,
  });
  emit("x_solo_review_decided", { business_slug: a.business, review: decision.review, reason: decision.reason, precheck_problems: precheck.problems, criteria: criteria.length });
  log(`  review: ${decision.review ? "yes" : "no"} (${decision.reason})${precheck.ok ? "" : ` · precheck: ${precheck.problems.join("; ")}`}`);
  const outcome = (o: Partial<SoloReviewOutcome>): SoloReviewOutcome => ({
    decision, precheck, reviewer: null, rounds: 0, approved: null, reservations: null, blockingMissed: [], skipped: null, ...o,
  });
  if (!decision.review) return outcome({});

  // A correction continues the worker's own run: same session, same role, the
  // solo directive (never the generic one, which would let it dispatch).
  const launch = a.worker.launch;
  const directive = launch.appendSystemPrompt?.startsWith(soloDirective("")) ? launch.appendSystemPrompt : soloDirective(a.rulesDirective ?? "");
  const ledger = a.ledger ? { ledger: { runId: a.ledger.runId, watchDir: a.ledger.watchDir ?? a.outputsRoot } } : {};
  const correct = (prompt: string) => run({
    runtime: a.worker.runtime, prompt, sessionId: a.worker.sessionId ?? undefined,
    cwd: launch.cwd, addDirs: launch.addDirs, appendSystemPrompt: directive,
    ...(launch.workspace ? { workspace: launch.workspace } : {}),
    dispatchRole: "solo", yolo: a.yolo ?? true, timeoutMs: a.timeoutMs, maxBudgetUsd: a.maxBudgetUsd, ...ledger,
  } as Parameters<typeof runHeadless>[0]);

  let rounds = 0;
  // Nothing on disk: a reviewer would open an empty folder and reject it. The
  // worker gets the precheck directly instead, within the same round limit.
  while (precheck.problems.includes(NO_DELIVERABLE) && rounds < a.maxRounds && a.worker.sessionId) {
    rounds++;
    const fix = correct(buildPrecheckRevisionPrompt(precheck.problems, a.outputsRoot));
    emit("x_solo_revision", { business_slug: a.business, round: rounds, ok: fix.ok, runtime: a.worker.runtime, reason: "no-deliverable" });
    if (!fix.ok) { log(`  revision round ${rounds} failed: ${fix.error ?? "unknown"}`); break; }
    precheck = precheckSolo(a.outputsRoot, criteria);
  }
  if (precheck.problems.includes(NO_DELIVERABLE)) {
    emit("x_review_skipped", { business_slug: a.business, reason: "no deliverable under the outputs root", rounds });
    log("  review skipped: there is no deliverable to review");
    return outcome({ rounds, skipped: "no-deliverable" });
  }

  const vetoes: Set<string> = a.runtimePref === "other"
    ? (() => {
      try { return new Set(matchedVetoes(briefText, a.rules ?? loadRuntimeRules(a.projectRoot)).map((v) => String(v.rule.runtime))); }
      catch { return new Set<string>(); }
    })()
    : new Set<string>();
  const reviewer = pickReviewRuntime(a.runtimePref, a.worker.runtime, a.available, (rt) => vetoes.has(rt));
  const reviewDir = path.join(a.outputsRoot, "_review");
  fs.mkdirSync(reviewDir, { recursive: true });
  let score: ReviewScore | null = null;
  let pass = 0;
  for (;;) {
    const prompt = buildSoloReviewPrompt({
      business: a.business, briefFile: a.briefFile, outputsRoot: a.outputsRoot, criteria,
      claims: readClaims(path.join(a.outputsRoot, "_CLAIMS.json")),
    });
    fs.writeFileSync(path.join(reviewDir, `prompt-${pass}.md`), prompt, "utf8");
    const r = run({
      runtime: reviewer, prompt, cwd: a.outputsRoot, addDirs: [a.outputsRoot, path.dirname(a.briefFile)],
      allowedTools: ["Read", "Grep", "Glob"], dispatchRole: "planner", yolo: a.yolo ?? true, timeoutMs: a.timeoutMs,
      maxBudgetUsd: a.maxBudgetUsd, ...ledger,
    } as Parameters<typeof runHeadless>[0]);
    fs.writeFileSync(path.join(reviewDir, `answer-${pass}.txt`), r.result ?? "", "utf8");
    if (!r.ok) {
      // A reviewer that died said nothing about the work. Counting it as a
      // rejection sent sound deliveries back for correction; the claims check
      // of the delivery pipeline still holds every blocking criterion.
      emit("x_review_skipped", { business_slug: a.business, reason: "the reviewer run failed", reviewer_runtime: reviewer, round: pass, error: r.error ?? null });
      log(`  review skipped: the reviewer on ${reviewer} failed (${r.error ?? "unknown"})`);
      return outcome({ reviewer, rounds, skipped: "reviewer-failed" });
    }
    let raw: any = null;
    try { raw = extractJsonObject(r.result ?? "") ?? JSON.parse(r.result ?? ""); } catch { raw = null; }
    score = scoreSoloReview(raw ?? {}, criteria);
    emit(score.approved ? "x_review_approved" : "x_review_rejected", {
      business_slug: a.business, reviewer_runtime: reviewer, round: pass, score: Number(score.score.toFixed(3)),
      confirmed: score.confirmed, ...(score.gaps.length ? { gaps: score.gaps } : {}), ...(score.invented.length ? { invented_ids: score.invented } : {}),
      ...(score.untraceable.length ? { untraceable: score.untraceable.length } : {}),
    });
    log(`  review round ${pass} on ${reviewer}: ${score.approved ? "approved" : "rejected"} (score ${score.score.toFixed(2)})`);
    if (score.approved || !a.worker.sessionId) break;
    // A brief with nothing to check gives the worker nothing to fix.
    if (!criteria.length && !score.untraceable.length) break;
    const limit = a.maxRounds + (score.blockingMissed.length && a.maxRounds > 0 ? SERIOUS_EXTRA_ROUNDS : 0);
    if (rounds >= limit) break;
    rounds++;
    const fix = correct(buildRevisionPrompt(score.gaps, criteria, score.untraceable));
    emit("x_solo_revision", { business_slug: a.business, round: rounds, ok: fix.ok, runtime: a.worker.runtime, ...(score.blockingMissed.length ? { serious: true } : {}) });
    if (!fix.ok) { log(`  revision round ${rounds} failed: ${fix.error ?? "unknown"}`); break; }
    precheck = precheckSolo(a.outputsRoot, criteria);
    pass++;
  }
  const reservations = score && !score.approved
    ? writeReservations(a.outputsRoot, score.gaps, criteria, `${rounds} correction round(s), reviewer ${reviewer}`, score.untraceable)
    : null;
  return outcome({ reviewer, rounds, approved: score?.approved ?? null, reservations, blockingMissed: score?.blockingMissed ?? [] });
}
