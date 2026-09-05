#!/usr/bin/env bun
/**
 * chain.ts — the business org chart, as data, for an executor that is not us.
 *
 * The engine had exactly one way to run a business's employees: `runTeam`, which
 * spawns a child runtime per step. On claude-code, codex and antigravity the
 * protocol says NOT to use that path — a child `claude -p` is killed at 20
 * minutes and truncates long deliverables — so the interactive maestro dispatches
 * through its own in-process subagents instead. Which left it with no way to run
 * the org chart at all, and the maestro did the only thing it could: hand the
 * whole business to a single subagent.
 *
 * Measured on a live run, 2026-09-04: two businesses with 23 seats between them
 * emitted ONE `dispatch_business` each and zero per-employee events — while the
 * deliverables named six of those seats as contributors. Work attributed to seats that never ran as audited agents is the
 * exact fiction the audit protocol exists to prevent, and it was not a bug in
 * anyone's code: no procedure existed.
 *
 * So this file does not execute anything. It splits the run in two:
 *
 *   the ENGINE decides and audits   →  `team plan`, `team step`
 *   the RUNTIME executes            →  the maestro's own subagent, in-session
 *
 * `plan` runs the same director `runTeam` uses (`planChain`) and leaves the same
 * three events behind. `step` builds the same employee prompt `runTeam` builds
 * (`employee-prompt.ts`, DNA injected, resource map, scope guard) and emits the
 * same `dispatch_business`. Both paths therefore decide the same way, speak the
 * same vocabulary and leave the same proof — which is the point: a reader could
 * not previously tell one path's silence from the other's absence.
 *
 * Usage:
 *   nrv team plan --business <slug> --brief <file> --project <dir> \
 *                  --outputs <dir> [--runtime <rt>] [--team|--single] [--safe] \
 *                  [--project-id <id>] [--save <plan.json>]
 *     → the plan on stdout as JSON. Emits x_chain_shape_decided +
 *       team_chain_selected (or team_director_failed, exit 1).
 *
 *   nrv team step --plan <plan.json> --index <n>
 *     → the employee's full prompt on stdout. Emits dispatch_business.
 *       Run that prompt in your own subagent; do not paraphrase it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { planChain, buildStepBrief, type ChainStep, type TeamRunArgs } from "../lib/team-orchestrator.ts";
import { resolveEntityDir } from "../../_shared/lib/entity-resource-map.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { stamp, provenanceOf } from "../../_shared/lib/audit-provenance.ts";
import type { Runtime } from "../lib/host-agent-driver.ts";
import * as YAML from "yaml";
import { readAcceptance } from "../../businesses/lib/acceptance.ts";

const SKILLS = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

const EXIT_OK = 0, EXIT_FAIL = 1, EXIT_ARGS = 4;

function emitAudit(payload: Record<string, any>, projectRoot?: string): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(harnessLogsDir({ cwd: projectRoot }), today);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify(stamp({ ts: new Date().toISOString(), ...payload })) + "\n");
  } catch { /* non-fatal */ }
}

function die(msg: string, code = EXIT_FAIL): never {
  console.error(`nrv team: ${msg}`);
  process.exit(code);
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** The plan is the contract between the two halves: everything `step` needs to
 *  rebuild a step exactly as `runTeam` would, without re-deciding anything. */
interface ChainPlan {
  business: string;
  project_id: string;
  project_dir: string;
  project_root: string;
  outputs_root: string;
  brief_file: string;
  businesses_root?: string;
  intake: string;
  reason: string;
  /** Each step plus the seat that reviews it, from the org chart. A step with no
   *  `reviewer` is the root: it signs, it is not signed off. */
  chain: Array<ChainStep & { reviewer?: string }>;
}

/** The seat that consolidates. Resolved through the businesses loader — the same
 *  owner `brief-business.ts` asks, so a business cannot have two answers. */
function intakeEmployee(bizDir: string): string {
  const loader = path.join(SKILLS, "businesses", "lib", "loader.ts");
  const r = spawnSync("bun", [loader, bizDir, "--field", "intake_employee"], { encoding: "utf8" });
  const name = (r.stdout || "").trim();
  if (name) return name;

  // The loader validates the whole manifest, so an empty answer has two very
  // different causes and only one of them is a missing intake seat. Blaming the
  // seat for an invalid `business.yaml` sends the reader to edit the right
  // directory for the wrong reason — pass its own words through instead.
  //
  // Note the loader refuses a business with no intake seat itself, with its own
  // integrity error — so there is no "missing intake" branch to write here. Its
  // wording is not always actionable ("Integrity check falhou"), which is why
  // the repair command goes in the same breath rather than being left for the
  // reader to remember.
  const why = (r.stderr || "").trim();
  const fix = `  Repair it with: nrv validate business ${path.basename(bizDir)} --fix`;
  if (why) die(`business at ${bizDir} could not be loaded:\n  ${why.split("\n").join("\n  ")}\n${fix}`);
  die(`business at ${bizDir} named no intake employee.\n${fix}`);
}

// ── review: the immediate superior, bound to what the seat declared ────────

/** The seat that reviews `employee`, read from the org chart — never invented.
 *
 *  `reports[0]` is the immediate superior. The chart is validated on every
 *  business and, until this, read by nothing: `fromOrgChart` in dag-planner maps
 *  `deps = reports[]`, which is backwards for execution and exactly right here,
 *  because the result rises through `reports`. Measured across the installed
 *  library: 65/65 businesses carry a chart, 64/65 have a single root, and no
 *  business has an orphan seat — so this resolves for every one of them. */
function reviewerOf(bizDir: string, employee: string): string | null {
  try {
    const chart = YAML.parse(fs.readFileSync(path.join(bizDir, "org-chart.yaml"), "utf8"))?.chart ?? [];
    const row = chart.find((e: any) => e?.employee === employee);
    const up = (row?.reports ?? [])[0];
    return typeof up === "string" && up !== employee ? up : null;
  } catch { return null; }
}

/** One criterion the reviewer must answer for, as the seat declared it. */
interface ReviewCriterion { id: string; description: string; blocking: boolean; employee: string; }

function criteriaFor(bizDir: string, employee: string): ReviewCriterion[] {
  try {
    return readAcceptance(bizDir, [employee]).entries.map(e => ({
      id: e.id, description: e.description, blocking: e.blocking, employee: e.employee,
    }));
  } catch { return []; }
}

/** The floor a review has to clear. Not 1.0 on purpose: one unconfirmable
 *  micro-check should not sink a good delivery. A criterion the author marked
 *  `blocking` is the escape hatch in the other direction — it must be confirmed
 *  whatever the score says. `readAcceptance` defaults its own floor to 0.92; this
 *  is the same idea, one notch more forgiving, and overridable per business. */
const REVIEW_SCORE_FLOOR = 0.90;

function cmdPlan(argv: string[]): void {
  const slug = arg(argv, "--business");
  const briefFile = arg(argv, "--brief");
  const projectDir = arg(argv, "--project");
  const outputsRoot = arg(argv, "--outputs");
  if (!slug || !briefFile || !projectDir || !outputsRoot) {
    die("plan needs --business, --brief, --project and --outputs.", EXIT_ARGS);
  }
  if (!fs.existsSync(briefFile)) die(`brief file not found: ${briefFile}`, EXIT_ARGS);

  const projectRoot = arg(argv, "--project-root") ?? projectDir;
  const projectId = arg(argv, "--project-id") ?? path.basename(projectDir);
  const businessesRoot = arg(argv, "--businesses-root");
  const bizDir = businessesRoot ? path.join(businessesRoot, slug) : resolveEntityDir("businesses", slug, projectDir);
  if (!fs.existsSync(bizDir)) die(`business '${slug}' not found at ${bizDir}`);

  const brief = fs.readFileSync(briefFile, "utf8");
  const intake = intakeEmployee(bizDir);

  const args: TeamRunArgs = {
    slug, brief, projectId, projectDir, projectRoot, outputsRoot,
    runtime: (arg(argv, "--runtime") ?? "claude-code") as Runtime,
    intakeEmployee: intake,
    forceChain: argv.includes("--team"),
    // `--single` skips the director outright: the user already decided, and
    // paying for a decision call to be told what you just said is waste.
    yolo: !argv.includes("--safe"),
    ...(businessesRoot ? { businessesRoot } : {}),
  };

  let chain: ChainStep[], reason: string;
  if (argv.includes("--single")) {
    chain = [{ employee: intake, task: "Carry the brief end to end." }];
    reason = "--single: the caller chose one seat";
    emitAudit({
      event: "x_chain_shape_decided", project_id: projectId, business_slug: slug,
      steps: 1, reason, forced: "single",
    }, projectRoot);
  } else {
    try { ({ chain, reason } = planChain(args)); }
    catch (e: any) { die(`director: ${e?.message || e}`); }
  }

  // Each step carries WHO REVIEWS IT, resolved from the org chart rather than
  // decided here. A step whose seat is the root has no reviewer: the head of the
  // house signs for the delivery instead of being reviewed by someone above it.
  const chainWithReviewers = chain.map(step => {
    const reviewer = reviewerOf(bizDir, step.employee);
    return reviewer ? { ...step, reviewer } : { ...step };
  });

  const plan: ChainPlan = {
    business: slug, project_id: projectId, project_dir: projectDir, project_root: projectRoot,
    outputs_root: outputsRoot, brief_file: path.resolve(briefFile),
    ...(businessesRoot ? { businesses_root: businessesRoot } : {}),
    intake, reason, chain: chainWithReviewers,
  };

  // The convention every verifier already expects: `brief.md` at the outputs
  // root. Teaching each checker a second layout is how a convention becomes two
  // conventions; writing the file the existing one asks for costs a line and
  // makes `verify-deliverable` and the completeness ceiling work on a chain run
  // without knowing it is one.
  try {
    fs.mkdirSync(outputsRoot, { recursive: true });
    const dest = path.join(outputsRoot, "brief.md");
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, brief);
  } catch { /* an unwritable outputs root fails later, louder, on the first step */ }

  const save = arg(argv, "--save");
  if (save) {
    fs.mkdirSync(path.dirname(save), { recursive: true });
    fs.writeFileSync(save, JSON.stringify(plan, null, 2));
  }
  console.log(JSON.stringify(plan, null, 2));
}

function cmdStep(argv: string[]): void {
  const planFile = arg(argv, "--plan");
  const indexRaw = arg(argv, "--index");
  if (!planFile || indexRaw === undefined) die("step needs --plan and --index.", EXIT_ARGS);
  if (!fs.existsSync(planFile)) die(`plan file not found: ${planFile}`, EXIT_ARGS);

  const plan: ChainPlan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const idx = Number(indexRaw);
  const total = plan.chain.length;
  if (!Number.isInteger(idx) || idx < 0 || idx >= total) {
    die(`--index ${indexRaw} is out of range: this plan has ${total} step(s), so 0..${total - 1}.`, EXIT_ARGS);
  }

  const step = plan.chain[idx];
  const isLast = idx === total - 1;
  // Same layout `runTeam` uses: colleagues write under `_team/<employee>/`, the
  // synthesizer writes the finals to the outputs root itself.
  const outDir = isLast ? plan.outputs_root : path.join(plan.outputs_root, "_team", step.employee);
  fs.mkdirSync(outDir, { recursive: true });

  // What the earlier seats produced, as they actually exist on disk. A seat that
  // was planned and did not run contributes nothing — the same rule the chain
  // applies, so a later step is never told to read a directory that is empty.
  const priorOutputs = plan.chain.slice(0, idx)
    .map(s => ({ employee: s.employee, dir: path.join(plan.outputs_root, "_team", s.employee) }))
    .filter(p => { try { return fs.readdirSync(p.dir).some(f => !f.startsWith(".")); } catch { return false; } });

  const brief = fs.readFileSync(plan.brief_file, "utf8");
  const stepBrief = buildStepBrief(step, idx, total, { brief, outputsRoot: plan.outputs_root }, priorOutputs, outDir);
  const stepBriefFile = path.join(outDir, ".step-brief.md");
  fs.writeFileSync(stepBriefFile, stepBrief);

  const bizDir = plan.businesses_root
    ? path.join(plan.businesses_root, plan.business)
    : resolveEntityDir("businesses", plan.business, plan.project_dir);

  const ep = spawnSync("bun", [
    path.join(SKILLS, "businesses/lib/employee-prompt.ts"),
    plan.business, step.employee, plan.project_dir, stepBriefFile, outDir,
  ], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    // The child resolves the business independently; handing it the library root
    // this plan settled on removes the second opinion.
    env: { ...process.env, BUSINESSES_DIR: path.dirname(bizDir) },
  });
  if (ep.status !== 0) {
    emitAudit({
      event: "team_step_failed", project_id: plan.project_id, business_slug: plan.business,
      employee: step.employee, reason: "employee-prompt build failed", error: ep.stderr?.slice(0, 500),
    }, plan.project_root);
    die(`could not build the prompt for ${step.employee}: ${ep.stderr?.slice(0, 300) || `exit ${ep.status}`}`);
  }

  // The proof. Emitted HERE rather than by the caller, because a caller that
  // must remember to audit is a caller that will eventually forget — which is
  // how two businesses and 23 seats produced one dispatch event between them.
  // Asking for the prompt twice is not dispatching twice. Measured on the first
  // real org-chart run (2026-09-04): the caller ran `team step --index 0` twice
  // and the audit showed two dispatches for one seat's work, because the event
  // fired when the PROMPT WAS BUILT. The repeat is still information — the
  // caller asked again for a reason — so it is recorded as a repeat.
  const marker = path.join(outDir, ".dispatched");
  const reissue = fs.existsSync(marker);
  emitAudit({
    event: reissue ? "x_seat_prompt_reissued" : "dispatch_business",
    trace_id: plan.project_id, project_id: plan.project_id,
    business_slug: plan.business, employee: step.employee,
    mode: "chain-step", step: idx + 1, total,
  }, plan.project_root);
  try { fs.writeFileSync(marker, new Date().toISOString()); } catch { /* best effort */ }

  process.stdout.write(ep.stdout);
  // Where to write, on stderr so it never contaminates the prompt on stdout.
  console.error(`[chain] step ${idx + 1}/${total} · ${step.employee} → ${outDir}`);
}


/** The brief the reviewer reads: what the company was asked for, what THIS seat
 *  was asked for, where its work is, and the criteria it declared for itself.
 *
 *  The verdict form is the whole defence against a rubber stamp. A reviewer that
 *  writes `{"verdict":"approved"}` and nothing else scores zero and fails, because
 *  anything unmentioned counts as unconfirmed — so the lazy path rejects instead
 *  of approving. That inversion is the point; a checklist that is cheap to sign
 *  is a checklist that gets signed. */
function buildReviewBrief(plan: ChainPlan, idx: number, criteria: ReviewCriterion[], outDir: string): string {
  const step = plan.chain[idx];
  const brief = fs.readFileSync(plan.brief_file, "utf8");
  const list = criteria.length
    ? criteria.map(c => `- \`${c.id}\`${c.blocking ? " **(blocking)**" : ""} — ${c.description}`).join("\n")
    : "- (this seat declared no acceptance criteria; judge against the brief and say so in `notes`)";

  return [
    `# Review — ${step.reviewer} reviewing ${step.employee}`,
    "",
    "You are this seat's immediate superior. You did not do the work; you answer for it.",
    "",
    "## What the client asked the company for",
    brief,
    "",
    `## What ${step.employee} was asked to do`,
    step.task,
    "",
    `## Where its work is`,
    `\`${outDir}\` — read the files before judging. A verdict on work you did not open is worthless.`,
    "",
    `## The criteria ${step.employee} declared for itself`,
    list,
    "",
    "## Your answer: ONE JSON object, nothing else",
    "```json",
    '{"confirmed":[{"id":"<criterion id, verbatim>","evidence":"<file:line, or a quote — what PROVES it>"}],',
    ' "unconfirmed":[{"id":"<criterion id>","why":"<what is missing, concretely>"}],',
    ' "notes":"<one line, optional>"}',
    "```",
    "",
    "Rules, and they are enforced by the engine that reads this:",
    "- An `id` that is not in the list above is DROPPED. Do not invent criteria.",
    "- A criterion goes under `confirmed` only with real evidence — a path, a line, a quote. Evidence like \"looks good\" moves it to `unconfirmed`.",
    "- **Anything you do not mention counts as unconfirmed.** Silence is not approval.",
    "- Do not write the verdict or the score: the engine computes both from what you confirmed. Your job is observation, not arithmetic.",
    "- Judging your subordinate generously does not help them. An approval that does not survive the next reader costs the company more than a rejection that names the gap.",
  ].join("\n");
}

function cmdReview(argv: string[]): void {
  const planFile = arg(argv, "--plan");
  const indexRaw = arg(argv, "--index");
  if (!planFile || indexRaw === undefined) die("review needs --plan and --index.", EXIT_ARGS);
  const plan: ChainPlan = JSON.parse(fs.readFileSync(planFile!, "utf8"));
  const idx = Number(indexRaw);
  if (!Number.isInteger(idx) || idx < 0 || idx >= plan.chain.length) {
    die(`--index ${indexRaw} is out of range: this plan has ${plan.chain.length} step(s).`, EXIT_ARGS);
  }
  const step = plan.chain[idx];
  if (!step.reviewer) {
    die(`${step.employee} is the root of the org chart — it signs for the delivery, it is not reviewed. `
      + "There is nobody above it to ask.", EXIT_ARGS);
  }

  const bizDir = plan.businesses_root
    ? path.join(plan.businesses_root, plan.business)
    : resolveEntityDir("businesses", plan.business, plan.project_dir);
  const isLast = idx === plan.chain.length - 1;
  const workDir = isLast ? plan.outputs_root : path.join(plan.outputs_root, "_team", step.employee);
  const criteria = criteriaFor(bizDir, step.employee);

  // The reviewer runs as itself — its own persona and its own mind-clone, ranked
  // against the review task. A generic judge is what this replaces.
  const reviewDir = path.join(plan.outputs_root, "_review", step.employee);
  fs.mkdirSync(reviewDir, { recursive: true });
  const briefFile = path.join(reviewDir, ".review-brief.md");
  fs.writeFileSync(briefFile, buildReviewBrief(plan, idx, criteria, workDir));

  const ep = spawnSync("bun", [
    path.join(SKILLS, "businesses/lib/employee-prompt.ts"),
    plan.business, step.reviewer, plan.project_dir, briefFile, reviewDir,
  ], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, BUSINESSES_DIR: path.dirname(bizDir) },
  });
  if (ep.status !== 0) die(`could not build the prompt for ${step.reviewer}: ${ep.stderr?.slice(0, 300) || `exit ${ep.status}`}`);

  emitAudit({
    event: "x_review_requested", trace_id: plan.project_id, project_id: plan.project_id,
    business_slug: plan.business, employee: step.employee, reviewer: step.reviewer,
    step: idx + 1, total: plan.chain.length, criteria: criteria.length,
  }, plan.project_root);

  process.stdout.write(ep.stdout);
  console.error(`[review] ${step.reviewer} reviewing ${step.employee} · ${criteria.length} criteria · work in ${workDir}`);
  console.error(`[review] write the verdict JSON, then: nrv team verdict --plan ${planFile} --index ${idx} --verdict <file.json>`);
}

/** Read the reviewer's answer, and decide — here, not there.
 *
 *  The reviewer reports observations; the engine does the arithmetic. That split
 *  exists because a reviewer that grades itself grades generously, and because a
 *  score computed from confirmed criteria is checkable by anyone who reads the
 *  same two files afterwards.
 *
 *  Exit code IS the loop: 0 approved, 3 rejected, so the caller branches on it
 *  without parsing anything. */
function cmdVerdict(argv: string[]): void {
  const planFile = arg(argv, "--plan");
  const indexRaw = arg(argv, "--index");
  const verdictFile = arg(argv, "--verdict");
  if (!planFile || indexRaw === undefined || !verdictFile) die("verdict needs --plan, --index and --verdict.", EXIT_ARGS);
  if (!fs.existsSync(verdictFile!)) die(`verdict file not found: ${verdictFile}`, EXIT_ARGS);

  const plan: ChainPlan = JSON.parse(fs.readFileSync(planFile!, "utf8"));
  const idx = Number(indexRaw);
  if (!Number.isInteger(idx) || idx < 0 || idx >= plan.chain.length) {
    die(`--index ${indexRaw} is out of range: this plan has ${plan.chain.length} step(s).`, EXIT_ARGS);
  }
  const step = plan.chain[idx];

  let raw: any;
  try {
    const text = fs.readFileSync(verdictFile!, "utf8");
    // The reviewer is an LLM; a fenced block or a sentence around the object is
    // ordinary, and failing the whole review over punctuation would teach the
    // wrong lesson. The object itself is what must be well formed.
    raw = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text);
  } catch (e: any) { die(`the verdict is not JSON: ${e.message}`); }

  const bizDir = plan.businesses_root
    ? path.join(plan.businesses_root, plan.business)
    : resolveEntityDir("businesses", plan.business, plan.project_dir);
  const criteria = criteriaFor(bizDir, step.employee);
  const known = new Map(criteria.map(c => [c.id, c]));

  // Confirmed means: a real id, and evidence that is not a shrug. Everything
  // else — including everything the reviewer simply did not mention — is
  // unconfirmed. That asymmetry is the design: silence rejects.
  const invented: string[] = [];
  const confirmed = new Set<string>();
  for (const c of Array.isArray(raw?.confirmed) ? raw.confirmed : []) {
    const id = typeof c?.id === "string" ? c.id : "";
    if (!known.has(id)) { if (id) invented.push(id); continue; }
    const ev = String(c?.evidence ?? "").trim();
    if (ev.length >= 12) confirmed.add(id);
  }

  const total = criteria.length;
  const score = total === 0 ? 1 : confirmed.size / total;
  const blockingMissed = criteria.filter(c => c.blocking && !confirmed.has(c.id)).map(c => c.id);
  const floor = REVIEW_SCORE_FLOOR;
  const approved = score >= floor && blockingMissed.length === 0;

  const gaps = criteria.filter(c => !confirmed.has(c.id)).map(c => {
    const said = (Array.isArray(raw?.unconfirmed) ? raw.unconfirmed : []).find((u: any) => u?.id === c.id);
    return { id: c.id, blocking: c.blocking, why: String(said?.why ?? "not mentioned by the reviewer").slice(0, 300) };
  });

  emitAudit({
    event: approved ? "x_review_approved" : "x_review_rejected",
    trace_id: plan.project_id, project_id: plan.project_id, business_slug: plan.business,
    employee: step.employee, reviewer: step.reviewer, step: idx + 1, total: plan.chain.length,
    score: Number(score.toFixed(3)), floor, confirmed: [...confirmed],
    ...(gaps.length ? { gaps } : {}), ...(blockingMissed.length ? { blocking_missed: blockingMissed } : {}),
    ...(invented.length ? { invented_ids: invented } : {}),
  }, plan.project_root);

  console.log(JSON.stringify({
    employee: step.employee, reviewer: step.reviewer,
    verdict: approved ? "approved" : "rejected",
    score: Number(score.toFixed(3)), floor, confirmed: [...confirmed], gaps,
    ...(blockingMissed.length ? { blocking_missed: blockingMissed } : {}),
    ...(invented.length ? { invented_ids: invented } : {}),
  }, null, 2));

  if (invented.length) {
    console.error(`[verdict] ${invented.length} id(s) not in ${step.employee}'s acceptance were dropped: ${invented.join(", ")}`);
  }
  if (!approved) {
    console.error(`[verdict] REJECTED — score ${score.toFixed(2)} < ${floor}${blockingMissed.length ? `; blocking unconfirmed: ${blockingMissed.join(", ")}` : ""}`);
    console.error(`[verdict] send it back to ${step.employee} IN THE SAME SESSION with the gaps above named.`);
    process.exit(3);
  }
  console.error(`[verdict] approved — score ${score.toFixed(2)} ≥ ${floor}`);
}


/** The receipt the head hands back to the orchestrator — COMPUTED, not narrated.
 *
 *  Asking the head to write "everyone did their part" is asking for the failure
 *  this whole line of work started from: a deliverable crediting six seats with
 *  one dispatch event behind them. A receipt built from the audit cannot credit a
 *  seat that has no `dispatch_business`, because there is nothing to read.
 *
 *  Exit 0 when every planned seat dispatched and every reviewed seat was
 *  approved; exit 3 otherwise, with the gaps named. */
function cmdReceipt(argv: string[]): void {
  const planFile = arg(argv, "--plan");
  if (!planFile) die("receipt needs --plan.", EXIT_ARGS);
  if (!fs.existsSync(planFile!)) die(`plan file not found: ${planFile}`, EXIT_ARGS);
  const sign = argv.includes("--sign");
  const plan: ChainPlan = JSON.parse(fs.readFileSync(planFile!, "utf8"));

  // Read the run's own events. Same resolution the writers use, so a reader can
  // never be looking at a different file than the one being written.
  const day = new Date().toISOString().slice(0, 10);
  const auditFile = path.join(harnessLogsDir({ cwd: plan.project_root }), day, "audit.jsonl");
  let events: any[] = [];
  let narrated: Array<{ event: string; why: string }> = [];
  try {
    const all = fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && (e.trace_id === plan.project_id || e.project_id === plan.project_id));
    // Only what the ENGINE signed counts. An unsigned or altered line is a claim
    // someone typed, and a receipt that counts claims is the thing this receipt
    // exists to replace: on 2026-09-04 an agent wrote its own dispatch_business
    // and its own gate_passed into a run's audit, minutes before the real
    // pipeline emitted the same names. Nothing in their shape told them apart.
    for (const e of all) {
      const p = provenanceOf(e);
      if (p === "engine") events.push(e);
      else narrated.push({ event: String(e.event ?? "(unnamed)"), why: p });
    }
  } catch { /* no events yet — every seat reads as not dispatched, which is true */ }

  const seatOf = (e: any) => e?.employee;
  const dispatched = new Set(events.filter(e => e.event === "dispatch_business").map(seatOf).filter(Boolean));
  const approved = new Map(events.filter(e => e.event === "x_review_approved").map(e => [seatOf(e), e]));
  const rejected = new Map(events.filter(e => e.event === "x_review_rejected").map(e => [seatOf(e), e]));

  const rows = plan.chain.map((step, i) => {
    const isLast = i === plan.chain.length - 1;
    const dir = isLast ? plan.outputs_root : path.join(plan.outputs_root, "_team", step.employee);
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter(f => !f.startsWith(".")); } catch { /* nothing written */ }
    const ok = approved.get(step.employee);
    const no = rejected.get(step.employee);
    return {
      seat: step.employee,
      dispatched: dispatched.has(step.employee),
      reviewer: step.reviewer ?? null,
      review: ok ? "approved" : no ? "rejected" : step.reviewer ? "not reviewed" : "signs (no superior)",
      score: (ok ?? no)?.score ?? null,
      files: files.length,
      output_dir: dir,
    };
  });

  const missing = rows.filter(r => !r.dispatched).map(r => r.seat);
  const unresolved = rows.filter(r => r.reviewer && r.review !== "approved").map(r => r.seat);
  const complete = missing.length === 0 && unresolved.length === 0;

  console.log(JSON.stringify({
    business: plan.business, trace_id: plan.project_id, outputs_root: plan.outputs_root,
    chain_reason: plan.reason, seats: rows,
    complete,
    ...(missing.length ? { never_dispatched: missing } : {}),
    ...(unresolved.length ? { review_unresolved: unresolved } : {}),
    ...(narrated.length ? { not_counted: narrated } : {}),
  }, null, 2));

  // Consulting a receipt must not change the log it reads. Running `team
  // receipt` to LOOK emitted a second x_business_signed_off into a real run on
  // 2026-09-04 — mine, next to the maestro's — so an inspector was altering the
  // evidence it inspected. `--sign` is the act; without it this only reports.
  if (sign) emitAudit({
    event: complete ? "x_business_signed_off" : "x_business_incomplete",
    trace_id: plan.project_id, project_id: plan.project_id, business_slug: plan.business,
    seats: rows.length, dispatched: rows.filter(r => r.dispatched).length,
    approved: rows.filter(r => r.review === "approved").length,
    ...(missing.length ? { never_dispatched: missing } : {}),
    ...(unresolved.length ? { review_unresolved: unresolved } : {}),
  }, plan.project_root);

  if (narrated.length) {
    console.error(`[receipt] ${narrated.length} event(s) in this trace were NOT written by the engine and were not counted: `
      + narrated.map(n => `${n.event} (${n.why})`).join(", "));
  }
  if (!complete) {
    if (missing.length) console.error(`[receipt] ${missing.length} seat(s) in the plan never ran: ${missing.join(", ")}`);
    if (unresolved.length) console.error(`[receipt] ${unresolved.length} seat(s) not approved by their superior: ${unresolved.join(", ")}`);
    console.error("[receipt] do NOT report this business as delivered, and do not credit a seat listed above.");
    process.exit(3);
  }
  console.error(`[receipt] ${plan.business}: ${rows.length} seat(s), all dispatched, all reviews resolved.`);
}

const argv = process.argv.slice(2);
const sub = argv[0];
if (!sub || sub === "-h" || sub === "--help") {
  console.log(`nrv team — run a business's org chart from your own runtime.

  nrv team plan --business <slug> --brief <file> --project <dir> --outputs <dir>
                 [--project-id <id>] [--project-root <dir>] [--runtime <rt>]
                 [--team | --single] [--safe] [--save <plan.json>]

      The director reads the brief against the org chart and answers with a
      chain and a reason. --team asks for 3 to 6 seats; --single skips the
      director. Prints the plan as JSON.

  nrv team step --plan <plan.json> --index <n>

      Prints the full prompt for step <n> — persona, mind-clone DNA, resource
      map, the colleagues' output paths and the scope guard. Run it in your own
      subagent, verbatim. Emits dispatch_business for that seat.

  nrv team review --plan <plan.json> --index <n>

      Prints the prompt for that seat's IMMEDIATE SUPERIOR: the client brief,
      what the seat was asked, where its work is, and the criteria the seat
      declared for itself. The reviewer answers with a JSON object listing only
      what it CONFIRMED, with evidence.

  nrv team verdict --plan <plan.json> --index <n> --verdict <file.json>

      Judges that answer. Anything unmentioned counts as unconfirmed, evidence
      that is a shrug does not count, and an id the seat never declared is
      dropped. The engine computes the score, not the reviewer.
      Exit 0 approved · exit 3 rejected — send it back in the SAME session.

  Loop:
      nrv team plan … --save .nirvana/chain.json
      for each step i:
        nrv team step   --plan .nirvana/chain.json --index $i   → run it
        nrv team review --plan .nirvana/chain.json --index $i   → run it
        nrv team verdict --plan .nirvana/chain.json --index $i --verdict v.json
        exit 3 → hand the gaps back to step $i in its own session, then re-review`);
  process.exit(EXIT_OK);
}
if (sub === "plan") cmdPlan(argv.slice(1));
else if (sub === "step") cmdStep(argv.slice(1));
else if (sub === "review") cmdReview(argv.slice(1));
else if (sub === "verdict") cmdVerdict(argv.slice(1));
else if (sub === "receipt") cmdReceipt(argv.slice(1));
else die(`unknown subcommand '${sub}'. Try: plan, step, review, verdict, receipt.`, EXIT_ARGS);
