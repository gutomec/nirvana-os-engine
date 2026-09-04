#!/usr/bin/env bun
// team-orchestrator.ts — harness-driven multi-employee chain for a business.
//
// Solves the "single LLM single-shot" failure: instead of trusting the intake
// employee to delegate via Bash (which it almost never does), the harness
// itself decides the chain and runs each specialist as a separate claude -p
// with DNA-injected persona. Each step audits dispatch_business +
// mind_clone_injected + agent_executed — provable orchestration.
//
// Flow:
//   1. Director call (cheap, tool-less LLM): given the brief + the list of
//      employees of this business, returns the ordered chain {employee,task}.
//   2. Sequential executor: for each step, builds the employee prompt via
//      employee-prompt.ts (full DNA injection), runs runHeadless, captures
//      outputs into _team/<employee>/. The LAST step is the intake/synthesizer
//      and writes the FINAL deliverables to outputs_root.
//   3. Returns the last session_id (used by `nrv revise`).

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { runHeadless, AUTONOMOUS_DIRECTIVE, type Runtime } from "./host-agent-driver.ts";
import { runWithCascade } from "./cascade-runner.ts";
import { sessionKey, getSession, putSession, dropSession, type EntityKind } from "./session-store.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { stamp } from "../../_shared/lib/audit-provenance.ts";
import { scopeGuard } from "../../_shared/lib/scope-guard.ts";
import { runSquadHeadless } from "./squad-exec.ts";
import { resolveEntityDir } from "../../_shared/lib/entity-resource-map.ts";

const SKILLS = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

export interface TeamRunArgs {
  slug: string;
  brief: string;
  projectId: string;
  projectDir: string;
  projectRoot: string;
  outputsRoot: string;
  runtime: Runtime;
  intakeEmployee: string;
  /** Squads the user explicitly asked for (from the agentic router). Each runs
   * as `nrv dispatch <slug> "<task>" --exec` right before the synthesizer; its
   * outputs land under <outputsRoot>/_squads/<slug>/ for the synthesizer to
   * read. Each emits dispatch_squad in the audit. */
  mandatorySquads?: string[];
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** The user's USE_* rules block (formatRulesForDirective) — appended to each
   * step's AUTONOMOUS_DIRECTIVE so the maestro honors it when delegating. */
  rulesDirective?: string;
  /** Where the businesses library lives, overriding scope resolution. Mirrors
   *  `SquadExecArgs.squadsRoot`, and exists for the same reason: `paths` is
   *  memoized on first access, so a test that points `BUSINESSES_DIR` at a
   *  fixture only wins if it is the first thing in the process to touch it —
   *  which makes the outcome depend on test file order, and makes the env write
   *  leak into every other file sharing the runner. An argument is honest where
   *  a process-wide mutation is a race. */
  businessesRoot?: string;
  /** `--team`: the user already decided there is a chain, so the director is
   *  asked for 3 to 6 seats instead of being free to answer "one". Without it
   *  the number of steps is the director's call, which is the point — a flag
   *  nobody passes is not a decision, it is a default wearing a disguise. */
  forceChain?: boolean;
  /** Full trust (the engine default) unless the user asked for `--safe`. The
   *  director and every step run with the tools of their runtime and no
   *  permission prompts, because a decision-maker with no tools decides on
   *  hearsay. `--safe` is the user saying otherwise, and the user's order wins
   *  over the default — which is the only reason this is a field and not a
   *  constant. */
  yolo?: boolean;
  /** Test seam: canned cascade runner (zero-token tests). Same shape
   *  `SquadExecArgs.runWithCascadeImpl` already uses, so one idiom covers both
   *  executors. The chain had no test file at all before this — only
   *  `buildStepBrief` was pinned — so every behaviour of the loop itself was
   *  unprotected. */
  runWithCascadeImpl?: typeof runWithCascade;
  /** Test seam: canned director. Without it `pickChain` reaches a real runtime,
   *  which is why the chain could not be tested at all. */
  runHeadlessImpl?: typeof runHeadless;
}

export interface ChainStep { employee: string; task: string; }
export interface StepResult {
  employee: string; ok: boolean; sessionId: string | null; costUsd: number | null;
  durationMs: number; outputsDir: string;
  /** 1 normally, 2 when the step was retried. */
  attempts?: number;
  /** Set when the step failed BOTH times and the chain went on without it. The
   *  string is what the colleagues downstream are told is missing. */
  failed?: string;
}
/** A seat that was asked and did not deliver. Named, never swallowed. */
export interface ChainGap { employee: string; task: string; }

export interface TeamResult { ok: boolean; steps: StepResult[]; chain: ChainStep[]; gaps: ChainGap[]; lastSessionId: string | null; totalCostUsd: number; totalDurationMs: number; error?: string; }

function appendAudit(payload: Record<string, any>, projectRoot?: string): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(harnessLogsDir({ cwd: projectRoot }), today);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify(stamp({ ts: new Date().toISOString(), ...payload })) + "\n");
  } catch { /* non-fatal */ }
}

/** The one place this module decides where the business lives.
 *
 *  Both callers must agree: `pickChain` lists the seats from it and `runStep`
 *  grants it to the dispatch. Resolving separately is how a run gets the roster
 *  of one tree and the key to another — the failure `entity-resource-map` names
 *  in its own header. */
function businessDir(args: TeamRunArgs): string {
  return args.businessesRoot
    ? path.join(args.businessesRoot, args.slug)
    : resolveEntityDir("businesses", args.slug, args.projectDir);
}

/** The seats the director gets to choose from.
 *
 *  The old `path.join(os.homedir(), "businesses")` ignored `BUSINESSES_DIR`,
 *  `NIRVANA_HOME` and the project scope alike: a business installed under a
 *  redirected home, or living in the project, listed zero seats — and
 *  `pickChain` then silently degraded the whole company to its single intake
 *  employee, which reads like a product decision rather than a missing path. */
function listEmployees(args: TeamRunArgs): { name: string; role: string; description: string }[] {
  const dir = path.join(businessDir(args), "employees");
  if (!fs.existsSync(dir)) return [];
  const out: { name: string; role: string; description: string }[] = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const content = fs.readFileSync(path.join(dir, f), "utf8");
    const fm = content.match(/^---[\s\S]*?^---/m)?.[0] || content.slice(0, 2000);
    const name = fm.match(/^name:\s*(\S+)/m)?.[1] || path.basename(f, ".md");
    const role = (fm.match(/^role:\s*(.+)$/m)?.[1] || "").trim();
    const dm = fm.match(/^description:\s*["']?([\s\S]+?)["']?\s*$/m) || fm.match(/^description:\s*>?-?\s*\n((?:\s+.+\n?)+)/m);
    const description = (dm?.[1] || "").replace(/\s+/g, " ").trim().slice(0, 400);
    out.push({ name, role, description });
  }
  return out;
}

function pickChain(args: TeamRunArgs): { chain: ChainStep[]; reason: string } {
  const employees = listEmployees(args);
  if (employees.length <= 1) {
    return {
      chain: [{ employee: args.intakeEmployee, task: "Carry the brief end to end. You are the only employee of this business." }],
      reason: "the business has a single seat",
    };
  }

  const list = employees.map(e => `- ${e.name} (${e.role}): ${e.description}`).join("\n");
  const prompt = [
    `You are the orchestration director of the business "${args.slug}". Your only job is to decide the chain of employees that executes the brief below at the highest quality this system can reach.`,
    "",
    "HOW TO WRITE A SUB-TASK: say what has to EXIST when the employee is done, and what is non-negotiable about it. Do not say how to get there. Whoever executes is the specialist — they know the tools of their own craft better than you do, and a step-by-step written upstream only takes away their freedom to do it better. A requirement on the RESULT is legitimate (\"the images have to be real generated images, not placeholders\", \"the HTML has to open without a build step\"); a recipe for the METHOD is not (\"use library X\", \"first do A, then B\").",
    "",
    "CLIENT BRIEF:",
    args.brief,
    "",
    "AVAILABLE EMPLOYEES:",
    list,
    "",
    "RULES:",
    `- "${args.intakeEmployee}" is the intake/synthesizer and MUST be LAST in the chain (it consolidates the colleagues' outputs into the final deliverables).`,
    args.forceChain
      ? "- Include 3 to 6 employees in the chain (the synthesizer counts). Skip employees irrelevant to the brief."
      : "- THE ORG CHART IS THE CONTRACT, not a suggestion. If a seat's declared role covers part of this brief, THAT SEAT does that part. You are not judging who is capable: the same model sits in every chair, so \"the synthesizer could do this\" is always true and is never the question. Ask instead whose JOB it is. The synthesizer works alone only when NO seat's role covers the work.",
    args.forceChain ? "" : "- A seat is also how a mind-clone reaches the work: personas are ranked against the SEAT'S task, not against the company. Skip the seat and the persona the brief needed is never injected — a comedy screenplay written by the CEO because it could is a screenplay with no screenwriter's voice in it.",
    args.forceChain ? "" : "- Six seats at most, and skip any whose role the brief does not touch. Cost is the tie-breaker between two defensible chains, never the test for whether to delegate.",
    "- Order by logical dependency: whoever produces an input comes before whoever needs it.",
    "- Each sub-task: the expected result and what is mandatory about it. The path belongs to whoever executes.",
    "- The DELIVERABLE follows the language of the client brief above. These instructions are in English; what the business ships is not.",
    "",
    'Answer with ONE valid JSON object only: {"reason":"<one sentence: why THIS number of steps>","chain":[{"employee":"<exact-name>","task":"<1-2 sentences: what has to exist at the end, and what is non-negotiable>"}, ...]}',
    "No markdown, no fences, no comment before or after.",
    // The two mandate rules above are chain-only, so they render as "" under
    // --team; dropping the empties keeps the rule list from growing blank lines.
  ].filter(line => line !== "").join("\n");

  appendAudit({ event: "team_director_called", project_id: args.projectId, business_slug: args.slug, employees_available: employees.length }, args.projectRoot);
  // The director makes the most consequential call of the run — who works, and
  // how much the run costs — and it used to make it blindfolded: no tools, and a
  // temp directory for a working directory. All it could see was the one-line
  // description of each seat, pasted above. Every other decision-maker in this
  // system reads before deciding (the router gets Read/Glob/Grep/Bash), and this
  // one had less to go on than any of them.
  //
  // It now runs like the agents it dispatches: full trust, in the project, with
  // the business granted. If it wants to open a seat's method file before
  // deciding the seat is unnecessary, it can.
  const res = (args.runHeadlessImpl ?? runHeadless)({
    runtime: args.runtime, prompt, cwd: args.projectRoot,
    addDirs: [businessDir(args), args.projectDir],
    yolo: args.yolo ?? true,
    timeoutMs: 5 * 60 * 1000,
  });
  const txt = (res.result || "").trim();
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`director returned no JSON: ${txt.slice(0, 200)}`);
  let parsed: any;
  try { parsed = JSON.parse(m[0]); } catch (e: any) { throw new Error(`invalid director JSON: ${e.message}`); }
  if (!Array.isArray(parsed.chain) || !parsed.chain.length) throw new Error("director retornou cadeia vazia");

  const known = new Set(employees.map(e => e.name));
  let chain: ChainStep[] = parsed.chain
    .filter((s: any) => s && typeof s.employee === "string" && known.has(s.employee))
    .map((s: any) => ({ employee: s.employee, task: String(s.task || "Execute sua especialidade aplicada ao brief.").trim() }));
  if (!chain.length) throw new Error("director picked no valid employee");
  if (chain[chain.length - 1].employee !== args.intakeEmployee) {
    chain.push({ employee: args.intakeEmployee, task: `Final synthesis: read the colleagues' outputs under _team/* and consolidate the FINAL DELIVERABLES under ${args.outputsRoot}. State any assumptions under a "## Assumptions" heading.` });
  }
  const reason = String(parsed.reason || "").replace(/\s+/g, " ").trim().slice(0, 300)
    || "the director stated no reason";
  return { chain, reason };
}

/**
 * Runs through the cascade RESUMING this entity's previous session in this project.
 *
 * Why it exists: without this, the same business (or squad) called twice in the
 * same project restarts cold and rebuilds what it already knew. The gain is not
 * speed — it is the agent staying the same agent.
 *
 * The fallback is the part that cannot be missing: the driver passes `--resume <id>`
 * and does NOT handle an invalid id. A session expired, deleted by the CLI or from
 * another machine would fail a dispatch that works today. So: if the run failed AND
 * we had passed an id, drop the id and retry ONCE cold. This way reuse can only
 * improve the result, never degrade it — the worst case is today's behavior.
 */
function runWithSession(
  kind: EntityKind,
  slug: string,
  args: TeamRunArgs,
  cascadeArgs: Parameters<typeof runWithCascade>[0],
): ReturnType<typeof runWithCascade> {
  const cascade = args.runWithCascadeImpl ?? runWithCascade;
  const key = sessionKey(args.runtime, kind, slug);
  const prior = getSession(args.projectDir, key);

  let res = cascade(prior ? { ...cascadeArgs, sessionId: prior } : cascadeArgs);

  if (!res.ok && prior) {
    // The session may have died outside our control. There is no reliable way
    // to tell "invalid resume" from "the task failed" by the error text across
    // 6 runtimes, so the policy is simple and safe: one cold attempt before
    // giving up.
    appendAudit({
      event: "session_resume_failed", trace_id: args.projectId, project_id: args.projectId,
      business_slug: args.slug, entity: `${kind}:${slug}`, runtime: args.runtime, session_id: prior,
    }, args.projectRoot);
    dropSession(args.projectDir, key);
    res = cascade(cascadeArgs);
  } else if (prior && res.ok) {
    appendAudit({
      event: "session_resumed", trace_id: args.projectId, project_id: args.projectId,
      business_slug: args.slug, entity: `${kind}:${slug}`, runtime: args.runtime, session_id: prior,
    }, args.projectRoot);
  }

  putSession(args.projectDir, key, res.finalRuntime ?? args.runtime, res.sessionId);
  return res;
}

/** The step brief handed to one employee of the chain: its sub-task, the client's
 * brief, the colleagues' outputs so far and where to write. Exported so the
 * scope-guard gate and the tests render it without running the chain. */
export function buildStepBrief(step: ChainStep, idx: number, total: number, args: Pick<TeamRunArgs, "brief" | "outputsRoot">, priorOutputs: { employee: string; dir: string }[], employeeOutDir: string, gaps: ChainGap[] = []): string {
  const isLast = idx === total - 1;
  const priorBlock = priorOutputs.length
    ? "## What your colleagues produced (read it before writing yours)\n" + priorOutputs.map(p => `- **${p.employee}** → ${p.dir}`).join("\n") + "\n\n"
    : "";
  // A colleague that was asked and did not deliver. The next seats are told
  // plainly, because the alternative is one of them assuming the material
  // exists and quietly building on nothing.
  const gapBlock = gaps.length
    ? "## What never arrived\nThese seats were dispatched and did not deliver. None of it exists on disk — do not go looking, and do not write as if you had read it:\n"
      + gaps.map(g => `- **${g.employee}** — was responsible for: ${g.task}`).join("\n")
      + "\nCarry on with what does exist. If the absence blocks part of your work, do all the rest and say which part was left out and why.\n\n"
    : "";
  const outputInstr = isLast
    ? `## Output\nWrite the FINAL DELIVERABLES as files under: \`${args.outputsRoot}\`\nRead everything the colleagues produced under \`_team/*\` and consolidate it. State your assumptions under "## Assumptions" in the main deliverable. Do NOT duplicate a colleague's work — synthesize, refine, complete.`
      + (gaps.length ? `\n\nAlso write \`${args.outputsRoot}/_QA-RESERVATIONS.md\`: what is missing from this delivery because of the seats that did not deliver, and what that practically costs whoever uses the material. If the file already exists, add to it instead of overwriting.` : "")
    : `## Output\nWrite YOUR work as well-named Markdown files under: \`${employeeOutDir}\`\nOne or more files with your analysis and the deliverable of your specialty. The colleagues after you will read it to continue — write with them in mind.`;

  return [
    `# Task for ${step.employee} — step ${idx + 1} of ${total}`,
    "",
    "## Your sub-task in this chain",
    step.task,
    "",
    "## The client's original brief",
    args.brief,
    "",
    // These instructions are English; the deliverable is not. Without saying so,
    // an English prompt quietly turns a Portuguese brief into an English
    // delivery — the language of the instruction leaking into the work.
    "## Language\nThese instructions are in English. What you DELIVER follows the language of the client brief above.",
    "",
    // A seat is handed a RANKED LIST of mind-clones and told to choose; nothing
    // is auto-injected unless the brief named one. On 2026-09-04 three seats
    // each picked a clone, logged a good reason, and then worked without ever
    // loading it — so the persona was a name in a log, not a voice in the work,
    // and the run read as if it had clone fidelity it never had. Rule 9 of the
    // protocol names that exact failure: never claim fidelity you did not load.
    "## If you pick a mind-clone, LOAD IT\nYour prompt lists candidates; nothing was injected for you. Choosing one and working from what you already know about that person is NOT embodying them — it is the failure the protocol calls claiming fidelity you did not load. If you pick one, run `nrv inspect-clone <slug>` — it prints `Path:` and the artifacts it holds — then READ `agent/AGENT.md`, `agent/SOUL.md` and `dna/dna-schema.md` under that path, and work from what they say. (Not `--dna`: that flag prints layer COUNTS, not the DNA.) If you decide none fits, say so in your output and work as yourself; that is honest and allowed.",
    "",
    priorBlock + gapBlock + outputInstr,
    scopeGuard("en"),
  ].join("\n");
}

function runStep(step: ChainStep, idx: number, total: number, args: TeamRunArgs, priorOutputs: { employee: string; dir: string }[], gaps: ChainGap[] = []): StepResult {
  const isLast = idx === total - 1;
  const employeeOutDir = isLast ? args.outputsRoot : path.join(args.outputsRoot, "_team", step.employee);
  fs.mkdirSync(employeeOutDir, { recursive: true });

  const stepBrief = buildStepBrief(step, idx, total, args, priorOutputs, employeeOutDir, gaps);

  const stepBriefFile = path.join(employeeOutDir, ".step-brief.md");
  fs.writeFileSync(stepBriefFile, stepBrief);

  const bizDir = businessDir(args);

  // The child resolves the business independently, and independently is how the
  // two disagree: this process may have resolved a project-scoped copy while the
  // subprocess, walking its own resolution, lands on the global one — then the
  // prompt describes one tree and the grant below opens another. Handing it the
  // library root this run already settled on removes the second opinion.
  const ep = spawnSync("bun", [
    path.join(SKILLS, "businesses/lib/employee-prompt.ts"),
    args.slug, step.employee, args.projectDir, stepBriefFile, employeeOutDir,
  ], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, BUSINESSES_DIR: path.dirname(bizDir) },
  });
  if (ep.status !== 0) {
    appendAudit({ event: "team_step_failed", project_id: args.projectId, business_slug: args.slug, employee: step.employee, reason: "employee-prompt build failed", error: ep.stderr?.slice(0, 500) }, args.projectRoot);
    return { employee: step.employee, ok: false, sessionId: null, costUsd: null, durationMs: 0, outputsDir: employeeOutDir };
  }

  appendAudit({ event: "dispatch_business", trace_id: args.projectId, project_id: args.projectId, business_slug: args.slug, employee: step.employee, mode: "team-step", step: idx + 1, total }, args.projectRoot);

  const res = runWithSession("employee", step.employee, args, {
    // bizDir is granted so the employee prompt's resource map is a door and not a
    // sign: `playbooks/`, `standards/`, `rubrics/` and `templates/` live under it,
    // and on claude-code and agy an ungranted path is simply refused. Same grant
    // squads already have, with the same caveat: `--add-dir` adds a WORKSPACE root
    // and this path runs with the permission bypass, so the directory is writable.
    // The prompt says in words that it is read-only, which is the instrument the
    // rest of the engine uses to keep deliverables where they belong.
    runtime: args.runtime, prompt: ep.stdout, cwd: args.projectRoot, addDirs: [args.projectDir, employeeOutDir, bizDir],
    // The chain never passed this, so `--safe` stopped at the business door and
    // every employee inside ran in full trust regardless.
    yolo: args.yolo ?? true,
    appendSystemPrompt: AUTONOMOUS_DIRECTIVE + (args.rulesDirective ?? ""),
    maxBudgetUsd: args.maxBudgetUsd, timeoutMs: args.timeoutMs,
    brief: args.brief, projectRoot: args.projectRoot, outputsRoot: employeeOutDir,
    taskHint: `team-step ${idx + 1}/${total} (${step.employee})`,
    projectId: args.projectId,
  });

  appendAudit({
    event: "agent_executed", trace_id: args.projectId, project_id: args.projectId, business_slug: args.slug,
    employee: step.employee, runtime: res.finalRuntime, session_id: res.sessionId,
    cost_usd: res.costUsd, duration_ms: res.durationMs, mode: "team-step", step: idx + 1, total,
    handoffs: res.handoffs.length ? res.handoffs : undefined,
  }, args.projectRoot);

  return { employee: step.employee, ok: res.ok, sessionId: res.sessionId, costUsd: res.costUsd, durationMs: res.durationMs, outputsDir: employeeOutDir };
}

/** Run a mandatory squad as a sub-task of this business chain. The squad
 * headless runner (prompt build, clone injection, session reuse, audit chain)
 * lives in squad-exec.ts (routing-360 Phase 4.1 extraction) — this is a thin
 * adapter that keeps the team-mode contract: writes to
 * <outputsRoot>/_squads/<slug>/, emits dispatch_squad (mode: team-mandatory)
 * + agent_executed (mode: squad-mandatory). */
function runMandatorySquad(squadSlug: string, args: TeamRunArgs): StepResult {
  const outDir = path.join(args.outputsRoot, "_squads", squadSlug);
  const r = runSquadHeadless({
    squadSlug,
    brief: args.brief,
    projectId: args.projectId,
    projectDir: args.projectDir,
    projectRoot: args.projectRoot,
    outputsDir: outDir,
    runtime: args.runtime,
    businessSlug: args.slug,
    mode: "team-mandatory",
    maxBudgetUsd: args.maxBudgetUsd,
    timeoutMs: args.timeoutMs,
    rulesDirective: args.rulesDirective,
    autonomousDirective: AUTONOMOUS_DIRECTIVE,
    // The seam travels down: a mandatory squad dispatched from a chain must be
    // testable from the same fixture that tests the chain.
    ...(args.runWithCascadeImpl ? { runWithCascadeImpl: args.runWithCascadeImpl } : {}),
  });
  return { employee: `squad:${squadSlug}`, ok: r.ok, sessionId: r.sessionId, costUsd: r.costUsd, durationMs: r.durationMs, outputsDir: r.outputsDir };
}

/**
 * The chain, decided and audited — with no opinion about who executes it.
 *
 * Exported because there are TWO executors and only one of them was ever
 * getting a chain. `runTeam` (below) spawns a child runtime per step; the
 * interactive maestro spawns an in-process subagent per step and reaches this
 * through `nrv chain plan`. Both must decide the same way and leave the same
 * three events behind, or a reader cannot tell one path's silence from the
 * other's absence — measured on a live run 2026-09-04, where a business with 14
 * seats ran as one agent and the deliverable still named six of them.
 *
 * Throws on a director that returns nothing usable; the caller decides what a
 * failed decision means for it.
 */
export function planChain(args: TeamRunArgs): { chain: ChainStep[]; reason: string } {
  let chain: ChainStep[];
  let reason: string;
  try { ({ chain, reason } = pickChain(args)); }
  catch (e: any) {
    appendAudit({ event: "team_director_failed", project_id: args.projectId, business_slug: args.slug, error: e?.message || String(e) }, args.projectRoot);
    throw e;
  }
  // Why this run costs what it costs. The chain length is a decision rather
  // than a flag, so it owes the owner a reason: five dispatches on a brief one
  // seat could have carried is a bill, and reading it back from the audit is how
  // the director's judgement gets checked instead of assumed.
  appendAudit({
    event: "x_chain_shape_decided", project_id: args.projectId, business_slug: args.slug,
    steps: chain.length, reason, forced: args.forceChain ? "team" : "auto",
  }, args.projectRoot);
  appendAudit({ event: "team_chain_selected", project_id: args.projectId, business_slug: args.slug, chain: chain.map(s => ({ employee: s.employee, task: s.task.slice(0, 120) })) }, args.projectRoot);
  return { chain, reason };
}

export function runTeam(args: TeamRunArgs): TeamResult {
  let chain: ChainStep[];
  try { ({ chain } = planChain(args)); }
  catch (e: any) {
    return { ok: false, steps: [], chain: [], gaps: [], lastSessionId: null, totalCostUsd: 0, totalDurationMs: 0, error: `director: ${e?.message || e}` };
  }

  const steps: StepResult[] = [];
  const priorOutputs: { employee: string; dir: string }[] = [];
  const gaps: ChainGap[] = [];
  const mandatorySquads = args.mandatorySquads ?? [];
  for (let i = 0; i < chain.length; i++) {
    // Right before the synthesizer (last step), dispatch each mandatory squad
    // so its output is available in priorOutputs for the synthesizer to read.
    if (i === chain.length - 1 && mandatorySquads.length) {
      for (const squadSlug of mandatorySquads) {
        const sr = runMandatorySquad(squadSlug, args);
        steps.push(sr);
        if (sr.ok) priorOutputs.push({ employee: `squad:${squadSlug}`, dir: sr.outputsDir });
        // Squad failure is non-fatal: synthesizer continues with the colleagues
        // it already has. The squad_run_failed event is in the audit.
      }
    }
    const isLast = i === chain.length - 1;
    let r = runStep(chain[i], i, chain.length, args, priorOutputs, gaps);
    let attempts = 1;

    // One retry, from a cold session. `runWithSession` already does this when a
    // session existed to resume; a first-ever step had no such second chance, so
    // a transport hiccup killed the whole chain on its first breath.
    if (!r.ok) {
      dropSession(args.projectDir, sessionKey(args.runtime, "employee", chain[i].employee));
      appendAudit({
        event: "x_chain_step_retried", trace_id: args.projectId, project_id: args.projectId,
        business_slug: args.slug, employee: chain[i].employee, step: i + 1, total: chain.length,
      }, args.projectRoot);
      r = runStep(chain[i], i, chain.length, args, priorOutputs, gaps);
      attempts = 2;
    }
    r.attempts = attempts;
    steps.push(r);

    if (r.ok) {
      priorOutputs.push({ employee: chain[i].employee, dir: r.outputsDir });
      continue;
    }

    // Twice failed. The chain used to stop here, which threw away every
    // colleague's finished work and never ran the seat whose whole job is to
    // consolidate it — the run ended with a full `_team/` on disk and nothing
    // assembled. It goes on instead, and what is missing travels with it: the
    // next steps are told, the synthesizer is told to record it in the
    // delivery, and the audit carries it.
    r.failed = `${chain[i].employee} did not deliver (2 attempts)`;
    gaps.push({ employee: chain[i].employee, task: chain[i].task });
    appendAudit({
      event: "x_chain_gap", trace_id: args.projectId, project_id: args.projectId,
      business_slug: args.slug, employee: chain[i].employee, step: i + 1, total: chain.length,
      attempts, task: chain[i].task.slice(0, 200),
    }, args.projectRoot);

    // The synthesizer is the exception: nothing downstream can cover for it, so
    // its failure is the run's failure.
    if (isLast) {
      const totalCost = steps.reduce((s, x) => s + (x.costUsd || 0), 0);
      const totalDur = steps.reduce((s, x) => s + x.durationMs, 0);
      return { ok: false, steps, chain, gaps, lastSessionId: r.sessionId, totalCostUsd: totalCost, totalDurationMs: totalDur, error: `step ${i + 1} (${chain[i].employee}) falhou` };
    }
  }

  const totalCost = steps.reduce((s, x) => s + (x.costUsd || 0), 0);
  const totalDur = steps.reduce((s, x) => s + x.durationMs, 0);
  // `gaps` rides on completion so "the chain finished" and "the chain finished
  // whole" stay two different statements in the log.
  appendAudit({
    event: "team_completed", project_id: args.projectId, business_slug: args.slug,
    steps: chain.length, total_cost_usd: totalCost, total_duration_ms: totalDur,
    ...(gaps.length ? { gaps: gaps.map(g => g.employee) } : {}),
  }, args.projectRoot);
  return { ok: true, steps, chain, gaps, lastSessionId: steps[steps.length - 1].sessionId, totalCostUsd: totalCost, totalDurationMs: totalDur };
}
