// business-solo.ts — a business run as ONE agent (execution.business_mode: solo).
//
// Measured on a real run of the chain: 21 agents for one request (9 seats, 11
// reviews, 1 mapping), each born with ~47k tokens of base context plus a ~10k
// seat prompt, each rebuilding its context by reading what the others wrote;
// 76% of the plan went to re-reading context, and the run took 7.5 hours of
// wall clock, mostly in series.
//
// This mode is the opposite shape. One agent is the whole business: it reads
// the brief the orchestrator wrote for it, plays the seats itself (opening a
// seat's file when it works as that seat, a clone's persona when it writes in
// that voice), and uses a squad by reading the squad's card and working as its
// agents. It opens nothing: no subagent, no squad dispatch, no other business
// (the `solo` role has an empty allowance). It works in phases with its state
// on disk, so a context ceiling costs nothing it has not already written down,
// and it ends with a one-page summary for the orchestrator and claims for the
// reviewer, if a review is decided.
//
// It is runtime-agnostic by construction: reading files, running commands and
// writing files is all it needs, so it runs the same on every runtime.

import * as fs from "node:fs";
import * as path from "node:path";
import { AUTONOMOUS_DIRECTIVE, type Runtime } from "./host-agent-driver.ts";
import { runWithCascade } from "./cascade-runner.ts";
import {
  ALLOWED_SQUADS_ENV, creditSessionSeats, defaultCloneLookup, defaultMemoryDirs, participationFile, readSeats, sessionGrants,
  type BusinessSessionArgs, type SessionReceipt, type SessionSeat,
} from "./business-session.ts";
import { resolveEntityDir } from "../../_shared/lib/entity-resource-map.ts";
import { scopeGuard } from "../../_shared/lib/scope-guard.ts";
import { runFolderOf } from "../../_shared/lib/run-workspace.ts";
import { writeSquadCards } from "../../_shared/lib/work-cards.ts";

export interface BusinessSoloArgs extends BusinessSessionArgs {
  /** The brief file the orchestrator wrote (work-brief.ts). The worker re-reads
   *  it at every phase, so decisions appended mid-run reach it. When absent the
   *  brief text is written to the run folder and pointed at instead. */
  briefFile?: string;
}

export interface BusinessSoloResult {
  ok: boolean;
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number;
  exitCode?: number;
  error?: string;
  stderr?: string;
  finalRuntime: Runtime;
  receipt: SessionReceipt;
  /** Where the worker was told to write its summary and claims. */
  summaryFile: string;
  claimsFile: string;
  /** The brief the worker read, for the review stage. */
  briefFile: string;
  /** What the resume of a revision needs to start the same way. */
  launch: { cwd: string; addDirs: string[]; appendSystemPrompt: string; workspace?: string };
}

export function isBusinessSolo(o: { forceTeam: boolean; forceSingle: boolean; requestedMode: string; businessMode: string }): boolean {
  return o.businessMode === "solo" && !o.forceTeam && !o.forceSingle && o.requestedMode !== "gauntlet";
}

export const workDir = (outputsRoot: string) => path.join(outputsRoot, "_work");
export const summaryFileOf = (outputsRoot: string) => path.join(outputsRoot, "_SUMMARY.md");
export const claimsFileOf = (outputsRoot: string) => path.join(outputsRoot, "_CLAIMS.json");

/** The squads this run may read: the router's picks, the ones the request
 *  names, and the closed sets the seats declare. A seat open to any squad adds
 *  none: listing the whole library would be the cost this mode removes. */
export function soloSquads(args: Pick<BusinessSessionArgs, "mandatorySquads" | "optionalSquads" | "briefSquads">, seats: SessionSeat[]): string[] {
  const out = [...(args.mandatorySquads ?? []), ...(args.optionalSquads ?? []), ...(args.briefSquads ?? [])];
  for (const s of seats) if (s.squads) out.push(...s.squads);
  return [...new Set(out)];
}

/** The prompt of the one agent that is the business: a map, never pasted content. */
export function buildSoloPrompt(
  args: BusinessSoloArgs & { briefFile: string },
  seats: SessionSeat[],
  memoryDirs: string[],
  squadCards: Record<string, string>,
): string {
  const lines: string[] = [];
  const progress = path.join(workDir(args.outputsRoot), "PROGRESS.md");
  lines.push(`# Business: ${args.slug}`, "");
  lines.push("You are this business, the whole of it, for one request. You play its seats yourself in this one session. Everything below is a map: open a file when the work needs it.", "");

  lines.push("## Your brief", "");
  lines.push(`\`${args.briefFile}\`. Read it first, and again at the start of every phase: the orchestrator appends decisions the user makes while you work.`, "");

  lines.push("## The business", "");
  lines.push(`- Folder: \`${args.bizDir}\` (business.yaml, org-chart.yaml, employees/). Read what you need; do not change it.`);
  if (memoryDirs.length) lines.push(`- Memory from earlier runs: ${memoryDirs.map((d) => `\`${d}\``).join(", ")}. Honor what it records.`);
  lines.push("");

  lines.push("## Seats", "", "To work as a seat, open its file first. To write in a clone's voice, open that clone's persona files first; never claim a voice you did not load.", "");
  for (const s of seats) {
    const voices = s.voices.length
      ? s.voices.map((v) => v.files.length ? `\`${v.slug}\` (${v.files.map((f) => `\`${f}\``).join(", ")})` : v.dir ? `\`${v.slug}\` (\`${v.dir}\`)` : `\`${v.slug}\` (not installed)`).join(", ")
      : "none";
    lines.push(`- \`${s.slug}\`${s.role ? ` (${s.role})` : ""}: \`${s.file}\` · voices: ${voices}`);
  }
  lines.push("");

  lines.push("## Squads", "");
  const cards = Object.entries(squadCards);
  if (cards.length) {
    lines.push("You use a squad by reading its card and working as its agents. You never dispatch it.", "");
    for (const [slug, file] of cards) lines.push(`- \`${slug}\`: card \`${file}\``);
    lines.push("");
  } else {
    lines.push("None was picked for this request. If a part needs one, `nrv cards squad <slug>` prints the card of an installed squad, and `nrv list-squads` lists them.", "");
  }

  lines.push("## How you work", "");
  lines.push(
    `1. Work in phases. Keep \`${progress}\` current: decisions taken, what is done (with paths), what is next. Update it at every milestone. If your context is compacted, the brief and PROGRESS.md are how you carry on.`,
    "2. Read with purpose: locate with a search, then read the part you need. Put independent reads in the same turn. Do not print back a file you just wrote.",
    `3. Deliverables go under \`${args.outputsRoot}\`, working files under \`${workDir(args.outputsRoot)}\`. Write nothing anywhere else.`,
    "4. Deliverables follow the language of the request.",
    "5. Deliver the whole of your part and nothing beyond it. Anything beyond it goes in the summary as a note.",
    "",
  );

  lines.push("## When you finish", "", "Write these, then end your turn:", "");
  lines.push(
    `- \`${summaryFileOf(args.outputsRoot)}\`: one page at most. What you delivered and where, the decisions you took, what is still open. The orchestrator reads only this.`,
    `- \`${claimsFileOf(args.outputsRoot)}\`: a JSON array with one entry per "Done when" item of the brief, in order: \`{"id": "d1", "evidence": "<file>:<lines>, <what it shows>"}\`.`,
    `- \`${participationFile(args.projectDir)}\`: \`{"seats": [{"seat": "<slug>", "how": "self", "files": ["<path>"]}], "squads": ["<slug>"], "clones": ["<slug>"]}\`, naming only what you actually used.`,
  );
  return lines.join("\n");
}

/** The autonomous directive, reshaped for an agent that opens nothing. */
export const SOLO_INTAKE_LINE = "- You ARE the business, already dispatched, and you play its seats yourself. Do not invoke the `harness` skill, do not run `nrv run`, `nrv dispatch` or `nrv team`, and never start another runtime: the engine refuses every dispatch from this role. A squad is used by reading its card and working as its agents.";
const PREMISE_SPECIALIST = /and the specialist whenever one exists[^;]*;[^.]*\./;
export const SOLO_SPECIALIST_CLAUSE = "and the specialist whenever one exists: for you that is a squad whose card you work from, never a dispatch.";
const SESSION_LIFETIME = /^- HEADLESS SESSION LIFETIME:/;
export const SOLO_LIFETIME_LINE = "- HEADLESS SESSION LIFETIME: this session dies the instant your final turn ends. Never launch background work (`bash ... &`) and end your turn waiting for it. Your turn is over only when every phase's files are on disk.";

export function soloDirective(rulesDirective = ""): string {
  const lines = AUTONOMOUS_DIRECTIVE.split("\n").map((l) => {
    if (l.includes("You ARE the intake")) return SOLO_INTAKE_LINE;
    if (l.startsWith("FUNDAMENTAL PREMISE")) return l.replace(PREMISE_SPECIALIST, SOLO_SPECIALIST_CLAUSE);
    if (SESSION_LIFETIME.test(l)) return SOLO_LIFETIME_LINE;
    return l;
  });
  return lines.join("\n") + rulesDirective;
}

/** Run the business as one agent, then credit the seats it declares it played. */
export function runBusinessSolo(args: BusinessSoloArgs): BusinessSoloResult {
  const emit = args.emit ?? (() => {});
  const cloneLookup = args.cloneLookup ?? defaultCloneLookup(args.projectDir);
  const squadDirOf = args.squadDirOf ?? ((q: string) => resolveEntityDir("squads", q, args.projectDir));
  const seats = readSeats(args.bizDir, cloneLookup);
  const memoryDirs = args.memoryDirs ?? defaultMemoryDirs(args.slug, args.bizDir, args.projectRoot);

  fs.mkdirSync(workDir(args.outputsRoot), { recursive: true });
  let briefFile = args.briefFile;
  if (!briefFile) {
    briefFile = path.join(args.projectDir, "brief.md");
    fs.writeFileSync(briefFile, args.brief.trim() + "\n");
  }
  const squads = soloSquads(args, seats);
  const squadCards = writeSquadCards(path.join(args.projectDir, "cards"), squads, squadDirOf);
  const prompt = buildSoloPrompt({ ...args, briefFile }, seats, memoryDirs, squadCards) + "\n\n" + scopeGuard("en");
  // The squads' folders are granted read access through the same list the
  // session mode uses, so a card's paths open.
  const addDirs = [...new Set([...sessionGrants({ ...args, mandatorySquads: squads, optionalSquads: [], briefSquads: [] }, seats, memoryDirs, squadDirOf), path.dirname(briefFile)])];
  try { fs.rmSync(participationFile(args.projectDir), { force: true }); } catch { /* a stale file would credit this run */ }
  fs.writeFileSync(path.join(args.projectDir, "solo-prompt.md"), prompt);
  const workspace = runFolderOf(args.projectDir, args.projectRoot) ?? undefined;
  const appendSystemPrompt = soloDirective(args.rulesDirective);

  emit("x_business_solo_started", {
    trace_id: args.projectId, project_id: args.projectId, business_slug: args.slug, runtime: args.runtime,
    seats: seats.length, prompt_chars: prompt.length, squad_cards: Object.keys(squadCards), brief_file: briefFile,
  });

  const startedMs = Date.now();
  const run = args.runWithCascadeImpl ?? runWithCascade;
  // An empty allowance on the environment as well as on the role: every squad
  // dispatch this process could attempt is refused (squadsRefusedHere).
  const previousAllowed = process.env[ALLOWED_SQUADS_ENV];
  process.env[ALLOWED_SQUADS_ENV] = "";
  let res: ReturnType<typeof runWithCascade>;
  try {
    res = run({
      dispatchRole: "solo",
      runtime: args.runtime,
      prompt,
      cwd: args.projectRoot,
      addDirs,
      appendSystemPrompt,
      maxBudgetUsd: args.maxBudgetUsd,
      timeoutMs: args.timeoutMs,
      yolo: args.yolo ?? true,
      brief: args.brief, projectRoot: args.projectRoot, outputsRoot: args.outputsRoot,
      taskHint: `business solo · ${args.slug}`,
      label: args.slug,
      workspace,
      projectId: args.projectId,
      ...(args.ledgerRunId ? { ledger: { runId: args.ledgerRunId, watchDir: args.outputsRoot } } : {}),
    });
  } finally {
    if (previousAllowed === undefined) delete process.env[ALLOWED_SQUADS_ENV];
    else process.env[ALLOWED_SQUADS_ENV] = previousAllowed;
  }

  const finalRuntime = res.finalRuntime ?? args.runtime;
  const receipt = creditSessionSeats({
    projectId: args.projectId, projectRoot: args.projectRoot, projectDir: args.projectDir,
    runtime: finalRuntime, seats, sinceMs: startedMs,
  });
  for (const c of receipt.credited) {
    emit("x_seat_credited", {
      trace_id: args.projectId, project_id: args.projectId, business_slug: args.slug, employee: c.seat,
      evidence: c.evidence, runtime: finalRuntime, ...(c.how ? { how: c.how } : {}),
    });
  }
  if (res.ok) {
    emit("agent_executed", {
      trace_id: args.projectId, project_id: args.projectId, business_slug: args.slug, mode: "business-solo",
      runtime: finalRuntime, session_id: res.sessionId, cost_usd: res.costUsd, duration_ms: res.durationMs,
    });
  }

  return {
    ok: res.ok, sessionId: res.sessionId, costUsd: res.costUsd, durationMs: res.durationMs,
    exitCode: res.exitCode, error: res.error, stderr: res.stderr, finalRuntime, receipt,
    summaryFile: summaryFileOf(args.outputsRoot), claimsFile: claimsFileOf(args.outputsRoot), briefFile,
    launch: { cwd: args.projectRoot, addDirs, appendSystemPrompt, ...(workspace ? { workspace } : {}) },
  };
}
