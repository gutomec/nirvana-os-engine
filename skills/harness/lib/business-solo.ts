// business-solo.ts — how a business runs: ONE agent that is the whole business.
//
// Measured on a real run of the chain this replaced: 21 agents for one request
// (9 seats, 11 reviews, 1 mapping), each born with ~47k tokens of base context
// plus a ~10k seat prompt, each rebuilding its context by reading what the
// others wrote; 76% of the plan went to re-reading context, and the run took
// 7.5 hours of wall clock, mostly in series.
//
// One agent is the whole business: it reads the brief the orchestrator wrote
// for it, plays the seats itself (opening a seat's file when it works as that
// seat, a clone's persona when it writes in that voice), and uses a squad by
// reading the squad's card and working as its agents. It opens nothing: no
// subagent, no squad dispatch, no other business (the `solo` role has an empty
// allowance). It works in phases with its state on disk, so a context ceiling
// costs nothing it has not already written down, and it ends with a one-page
// summary for the orchestrator and claims for the reviewer, if a review is
// decided.
//
// Runtime-agnostic by construction: reading files, running commands and
// writing files is all it needs, so it runs the same on every runtime.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { AUTONOMOUS_DIRECTIVE, type Runtime } from "./host-agent-driver.ts";
import { runWithCascade } from "./cascade-runner.ts";
import { resolveEntityDir } from "../../_shared/lib/entity-resource-map.ts";
import { entityMemoryDir } from "../../_shared/lib/entity-memory.ts";
import { loadCloneRegistry, resolveClonePersona } from "../../_shared/lib/clone-resolver.ts";
import { scopeGuard } from "../../_shared/lib/scope-guard.ts";
import { runFolderOf } from "../../_shared/lib/run-workspace.ts";
import { writeSquadCards } from "../../_shared/lib/work-cards.ts";
import { findCloneForTask, type CloneHit } from "../../_shared/lib/clone-search.ts";
import { parseWorkBrief } from "./work-brief.ts";

export interface SeatVoice { slug: string; dir: string | null; files: string[] }

export interface Seat {
  slug: string;
  role: string;
  file: string;
  voices: SeatVoice[];
  /** The closed set of squads the seat declares, or null when it may use any. */
  squads: string[] | null;
}

type CloneLookup = (slug: string) => { dir: string; files: string[] } | null;

export interface BusinessSoloArgs {
  slug: string;
  bizDir: string;
  brief: string;
  /** The brief file the orchestrator wrote (work-brief.ts). The worker re-reads
   *  it at every phase, so decisions appended mid-run reach it. When absent the
   *  brief text is written to the run folder and pointed at instead. */
  briefFile?: string;
  projectId: string;
  projectDir: string;
  projectRoot: string;
  outputsRoot: string;
  runtime: Runtime;
  /** Squads the router picked, and the ones the request names. */
  mandatorySquads?: string[];
  optionalSquads?: string[];
  briefSquads?: string[];
  rulesDirective?: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  yolo?: boolean;
  ledgerRunId?: string | null;
  emit?: (event: string, payload: Record<string, unknown>) => void;
  /** Test seams. */
  runWithCascadeImpl?: typeof runWithCascade;
  cloneLookup?: CloneLookup;
  squadDirOf?: (slug: string) => string;
  memoryDirs?: string[];
  /** The clone library: its entries (for names a brief mentions) and its search. */
  cloneNames?: () => Array<{ slug: string; name: string }>;
  voiceSearch?: (query: string) => CloneHit[];
}

export interface SoloLaunch { cwd: string; addDirs: string[]; appendSystemPrompt: string; workspace?: string }

/** A clone offered for this request, beyond the voices the seats carry. */
export interface RequestVoice { slug: string; name: string; why: string; dir: string; files: string[] }

export interface PreparedSolo {
  prompt: string;
  briefFile: string;
  seats: Seat[];
  voices: RequestVoice[];
  squadCards: Record<string, string>;
  launch: SoloLaunch;
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
  /** Seats the worker declares it played (participation.json). */
  seatsPlayed: string[];
  summaryFile: string;
  claimsFile: string;
  /** The brief the worker read, for the review stage. */
  briefFile: string;
  /** What the resume of a revision needs to start the same way. */
  launch: SoloLaunch;
}

export const workDir = (outputsRoot: string) => path.join(outputsRoot, "_work");
export const summaryFileOf = (outputsRoot: string) => path.join(outputsRoot, "_SUMMARY.md");
export const claimsFileOf = (outputsRoot: string) => path.join(outputsRoot, "_CLAIMS.json");
export const participationFile = (projectDir: string) => path.join(projectDir, "participation.json");

function listOf(v: unknown): string[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x ?? "").trim()).filter(Boolean);
}

/**
 * Installed squads a text names on purpose: the slug in backticks, next to the
 * word "squad" ("squad testing", "testing squad", `--squad testing`), or a
 * hyphenated slug on its own. A one-word slug alone is an ordinary word: "five
 * headlines for testing" does not ask for the `testing` squad.
 */
export function namedSquadsIn(text: string, slugs: Iterable<string>): string[] {
  const out: string[] = [];
  const before = "(^|[^A-Za-z0-9_-])", after = "($|[^A-Za-z0-9_-])";
  for (const slug of slugs) {
    const s = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const marked = new RegExp(`\`${s}\`|${before}(--)?squads?[\\s:=]+\`?${s}\`?${after}|${before}${s}\`?\\s+squad${after}`, "i");
    const bare = slug.includes("-") && new RegExp(`${before}${s}${after}`).test(text);
    if (bare || marked.test(text)) out.push(slug);
  }
  return out;
}

export function defaultCloneLookup(cwd: string): CloneLookup {
  let registry: Record<string, any> = {};
  try { registry = loadCloneRegistry({ cwd }); } catch { registry = {}; }
  return (slug) => {
    const entry = registry[slug];
    if (entry?.dir) {
      const files = Object.values(entry.persona_files ?? {}).filter((f): f is string => typeof f === "string" && fs.existsSync(f));
      return { dir: entry.dir, files };
    }
    const card = resolveClonePersona(slug, { depth: "reference", cwd });
    return card ? { dir: card.source, files: [] } : null;
  };
}

/** The business's seats, read from their own files. Tolerant: a seat whose
 *  frontmatter does not parse still appears, by its file name. */
export function readSeats(bizDir: string, cloneLookup: CloneLookup): Seat[] {
  const dir = path.join(bizDir, "employees");
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { return []; }
  return names.map((name) => {
    const file = path.join(dir, name);
    let fm: Record<string, any> = {};
    try {
      const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      const m = /^---\n([\s\S]*?)\n---/.exec(raw);
      const parsed = m ? parseYaml(m[1]) : null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fm = parsed;
    } catch { fm = {}; }
    const slug = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : path.basename(name, ".md");
    const refs = [...new Set([...listOf(fm.pinned_mind_clones), ...listOf(fm.assigned_mind_clones)].map((r) => r.slice(r.lastIndexOf("/") + 1)))];
    const voices = refs.map((s) => {
      const hit = cloneLookup(s);
      return { slug: s, dir: hit?.dir ?? null, files: hit?.files ?? [] };
    });
    // Business Protocol v2 §6.10: an empty list is the same as none, and both mean every squad.
    const authorized = listOf(fm.squads_authorized);
    return { slug, role: typeof fm.role === "string" ? fm.role.trim() : "", file, voices, squads: authorized.length ? authorized : null };
  });
}

/** The business's memory, as the directories it lives in. Pointed at, never pasted. */
export function defaultMemoryDirs(slug: string, bizDir: string, projectRoot: string): string[] {
  const dirs = [entityMemoryDir("businesses", slug, "global")];
  try { dirs.push(entityMemoryDir("businesses", slug, "project", projectRoot)); } catch { /* no project */ }
  const found = dirs.filter((d) => fs.existsSync(d));
  if (found.length) return found;
  const shipped = path.join(bizDir, "memory");
  return fs.existsSync(shipped) ? [shipped] : [];
}

/** The squads a business prefers (`squads_preferred` in business.yaml); [] when absent or unreadable. */
export function preferredSquads(bizDir: string | null): string[] {
  if (!bizDir) return [];
  try { return listOf(parseYaml(fs.readFileSync(path.join(bizDir, "business.yaml"), "utf8"))?.squads_preferred); }
  catch { return []; }
}

/** The squads this run may read: the router's picks, the ones the request
 *  names, the business's preferred ones and the closed sets the seats declare.
 *  A seat open to any squad adds none: listing the whole library would be the
 *  cost this mode removes. */
/** What a request is about: its own words and this business's part, without
 *  the decisions and criteria around them. */
function voiceQuery(brief: string): string {
  const s = parseWorkBrief(brief).sections;
  return [s["Request (verbatim)"], s["Your part"]].filter(Boolean).join("\n") || brief;
}

/**
 * Clones that fit this request: the ones the brief asks for, else the library's
 * search above its coverage gate (the rule squads and the retired seat prompt
 * use). A business whose seats carry no voice still writes in one when the
 * library has a fit. At most `limit`; a clone a seat already carries is not
 * repeated, and an uninstalled one is skipped.
 */
export function requestVoices(
  brief: string, seats: Seat[], cloneLookup: CloneLookup,
  names: Array<{ slug: string; name: string }>, search: (query: string) => CloneHit[], limit = 3,
): RequestVoice[] {
  const taken = new Set(seats.flatMap((s) => s.voices.map((v) => v.slug)));
  const out: RequestVoice[] = [];
  const add = (slug: string, name: string, why: string) => {
    if (out.length >= limit || taken.has(slug)) return;
    const hit = cloneLookup(slug);
    if (!hit) return;
    taken.add(slug);
    out.push({ slug, name, why, dir: hit.dir, files: hit.files });
  };
  // Asked for, not merely mentioned: a clone in the user's own words, or one the
  // orchestrator marks as `clone <slug>`. A brief that lists clones as facts
  // about a product ("the pack ships Saul Bass and Paula Scher") asks for none.
  const request = (parseWorkBrief(brief).sections["Request (verbatim)"] ?? brief).toLowerCase();
  for (const c of names) {
    const name = c.name.toLowerCase();
    const slug = c.slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const inRequest = request.includes(c.slug) || request.includes(c.slug.replace(/-/g, " ")) || (name.length > 3 && request.includes(name));
    const marked = new RegExp(`(^|[^a-z0-9_-])clones?[\\s:=]+\`?${slug}\`?($|[^a-z0-9_-])`, "i").test(brief);
    if (inRequest || marked) add(c.slug, c.name, "asked for in the brief");
  }
  if (out.length) return out;
  for (const h of search(voiceQuery(brief))) {
    if (h.below_gate === false) add(h.slug, h.display_name, `matches ${h.coverage.matched}/${h.coverage.total} of the request's terms`);
  }
  return out;
}

export function soloSquads(args: Pick<BusinessSoloArgs, "mandatorySquads" | "optionalSquads" | "briefSquads">, seats: Seat[], preferred: string[] = []): string[] {
  const out = [...(args.mandatorySquads ?? []), ...(args.optionalSquads ?? []), ...(args.briefSquads ?? []), ...preferred];
  for (const s of seats) if (s.squads) out.push(...s.squads);
  return [...new Set(out)];
}

/** The prompt of the one agent that is the business: a map, never pasted content. */
export function buildSoloPrompt(
  args: BusinessSoloArgs & { briefFile: string },
  seats: Seat[],
  memoryDirs: string[],
  squadCards: Record<string, string>,
  voices: RequestVoice[] = [],
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

  if (voices.length) {
    lines.push("## Voices for this request", "", "These clones fit this request. A seat whose work they serve writes in one after opening its persona files; name the ones you used in participation.json.", "");
    for (const v of voices) {
      const where = v.files.length ? v.files.map((f) => `\`${f}\``).join(", ") : `\`${v.dir}\``;
      lines.push(`- \`${v.slug}\` (${v.name}): ${where} · ${v.why}`);
    }
    lines.push("");
  }

  lines.push("## Squads", "");
  const cards = Object.entries(squadCards);
  lines.push("You use a squad by reading its card and working as its agents. You never dispatch it.", "");
  if (cards.length) {
    for (const [slug, file] of cards) lines.push(`- \`${slug}\`: card \`${file}\``);
    lines.push("");
  }
  lines.push(`${cards.length ? "For another squad" : "None was picked for this request. If a part needs one"}: \`nrv find "<the need>"\` ranks the installed squads and \`nrv cards squad <slug>\` prints a card. Do not browse squad folders.`, "");

  lines.push("## How you work", "");
  lines.push(
    `1. Work in phases. Keep \`${progress}\` current: decisions taken, what is done (with paths), what is next. Update it at every milestone. If your context is compacted, the brief and PROGRESS.md are how you carry on.`,
    "2. Read with purpose: locate with a search, then read the part you need. Put independent reads in the same turn. Do not print back a file you just wrote.",
    `3. Deliverables go under \`${args.outputsRoot}\`, working files under \`${workDir(args.outputsRoot)}\`. Write nothing anywhere else, even where the brief names another folder.`,
    "4. Deliverables follow the language of the request.",
    "5. Deliver the whole of your part and nothing beyond it. Anything beyond it goes in the summary as a note.",
    "",
  );

  lines.push("## When you finish", "", "Write these, then end your turn:", "");
  lines.push(
    `- \`${summaryFileOf(args.outputsRoot)}\`: one page at most. What you delivered and where, the decisions you took, what is still open. The orchestrator reads only this.`,
    `- \`${claimsFileOf(args.outputsRoot)}\`: a JSON array with one entry per "Done when" item of the brief, in order: \`{"id": "d1", "evidence": "<file>:<lines>, <what it shows>"}\`.`,
    `- \`${participationFile(args.projectDir)}\`: \`{"seats": [{"seat": "<slug>", "files": ["<path>"]}], "squads": ["<slug>"], "clones": ["<slug>"]}\`, naming only what you actually used.`,
  );
  return lines.join("\n");
}

/** The autonomous directive, reshaped for an agent that opens nothing. */
export const SOLO_INTAKE_LINE = "- You ARE the business, already dispatched, and you play its seats yourself. Do not invoke the `harness` skill, do not run `nrv run` or `nrv dispatch`, and never start another runtime: the engine refuses every dispatch from this role. A squad is used by reading its card and working as its agents.";
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

/** Seats the worker declares it played, from participation.json; unknown names are dropped. */
export function seatsPlayed(projectDir: string, seats: Seat[]): string[] {
  const known = new Set(seats.map((s) => s.slug));
  try {
    const d = JSON.parse(fs.readFileSync(participationFile(projectDir), "utf8"));
    const listed = (Array.isArray(d?.seats) ? d.seats : []).map((s: any) => String(typeof s === "string" ? s : s?.seat ?? s?.slug ?? ""));
    return [...new Set(listed.filter((s: string) => known.has(s)))] as string[];
  } catch { return []; }
}

/** Clones the worker declares it wrote in, from participation.json. */
export function clonesUsed(projectDir: string): string[] {
  try {
    const d = JSON.parse(fs.readFileSync(participationFile(projectDir), "utf8"));
    const listed = (Array.isArray(d?.clones) ? d.clones : []).map((c: any) => String(typeof c === "string" ? c : c?.clone ?? c?.slug ?? "").trim());
    return [...new Set(listed.filter(Boolean))] as string[];
  } catch { return []; }
}

/** Everything a run needs, written to the run folder: the brief, the squad
 *  cards and the prompt. Shared by the run, the scaffold-only path and the
 *  gauntlet producer, so the three hand the worker the same map. */
export function prepareBusinessSolo(args: BusinessSoloArgs): PreparedSolo {
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
  const squads = soloSquads(args, seats, preferredSquads(args.bizDir));
  const squadCards = writeSquadCards(path.join(args.projectDir, "cards"), squads, squadDirOf);
  const briefText = (() => { try { return fs.readFileSync(briefFile, "utf8"); } catch { return args.brief; } })();
  let voices: RequestVoice[] = [];
  try {
    const names = args.cloneNames ?? (() => Object.entries(loadCloneRegistry({ cwd: args.projectDir }) as Record<string, any>)
      .map(([slug, c]) => ({ slug, name: String(c?.display_name ?? slug) })));
    const search = args.voiceSearch ?? ((q: string) => findCloneForTask(q, { limit: 6, cwd: args.projectDir }));
    voices = requestVoices(briefText, seats, cloneLookup, names(), search);
  } catch { voices = []; } // a library that cannot be read leaves the seats' own voices
  const prompt = buildSoloPrompt({ ...args, briefFile }, seats, memoryDirs, squadCards, voices) + "\n\n" + scopeGuard();
  fs.writeFileSync(path.join(args.projectDir, "solo-prompt.md"), prompt);
  // What the worker may touch: the run, the business, its voices, the squads
  // on its cards, its memory, and the folder of the brief.
  const dirs = [args.projectDir, args.outputsRoot, args.bizDir, ...memoryDirs, path.dirname(briefFile)];
  for (const s of seats) for (const v of s.voices) if (v.dir) dirs.push(v.dir);
  for (const v of voices) dirs.push(v.dir);
  for (const q of Object.keys(squadCards)) dirs.push(squadDirOf(q));
  const workspace = runFolderOf(args.projectDir, args.projectRoot) ?? undefined;
  return {
    prompt, briefFile, seats, voices, squadCards,
    launch: {
      cwd: args.projectRoot, addDirs: [...new Set(dirs.map((d) => path.resolve(d)))],
      appendSystemPrompt: soloDirective(args.rulesDirective), ...(workspace ? { workspace } : {}),
    },
  };
}

/** Run the business as one agent, then read which seats it declares it played. */
export function runBusinessSolo(args: BusinessSoloArgs): BusinessSoloResult {
  const emit = args.emit ?? (() => {});
  const prep = prepareBusinessSolo(args);
  try { fs.rmSync(participationFile(args.projectDir), { force: true }); } catch { /* a stale file would credit this run */ }

  emit("x_business_solo_started", {
    trace_id: args.projectId, project_id: args.projectId, business_slug: args.slug, runtime: args.runtime,
    seats: prep.seats.length, prompt_chars: prep.prompt.length, squad_cards: Object.keys(prep.squadCards), voices: prep.voices.map((v) => v.slug), brief_file: prep.briefFile,
  });

  const run = args.runWithCascadeImpl ?? runWithCascade;
  const res = run({
    dispatchRole: "solo",
    runtime: args.runtime,
    prompt: prep.prompt,
    ...prep.launch,
    maxBudgetUsd: args.maxBudgetUsd,
    timeoutMs: args.timeoutMs,
    yolo: args.yolo ?? true,
    brief: args.brief, projectRoot: args.projectRoot, outputsRoot: args.outputsRoot,
    taskHint: `business solo · ${args.slug}`,
    label: args.slug,
    projectId: args.projectId,
    ...(args.ledgerRunId ? { ledger: { runId: args.ledgerRunId, watchDir: args.outputsRoot } } : {}),
  });

  const finalRuntime = res.finalRuntime ?? args.runtime;
  const played = seatsPlayed(args.projectDir, prep.seats);
  for (const seat of played) {
    emit("x_seat_credited", { trace_id: args.projectId, project_id: args.projectId, business_slug: args.slug, employee: seat, evidence: "declared", runtime: finalRuntime });
  }
  // Which voices the work was written in, and where each came from: a seat's
  // own, one the engine offered for the request, or one the worker found.
  const seatVoices = new Set(prep.seats.flatMap((s) => s.voices.map((v) => v.slug)));
  const offered = new Set(prep.voices.map((v) => v.slug));
  for (const clone of clonesUsed(args.projectDir)) {
    const source = seatVoices.has(clone) ? "seat" : offered.has(clone) ? "request" : "own-choice";
    emit("x_clone_credited", { trace_id: args.projectId, project_id: args.projectId, business_slug: args.slug, clone, source, evidence: "declared", runtime: finalRuntime });
  }
  if (res.ok) {
    emit("agent_executed", {
      trace_id: args.projectId, project_id: args.projectId, business_slug: args.slug, mode: "business-solo",
      runtime: finalRuntime, session_id: res.sessionId, cost_usd: res.costUsd, duration_ms: res.durationMs,
    });
  }

  return {
    ok: res.ok, sessionId: res.sessionId, costUsd: res.costUsd, durationMs: res.durationMs,
    exitCode: res.exitCode, error: res.error, stderr: res.stderr, finalRuntime, seatsPlayed: played,
    summaryFile: summaryFileOf(args.outputsRoot), claimsFile: claimsFileOf(args.outputsRoot), briefFile: prep.briefFile,
    launch: prep.launch,
  };
}
