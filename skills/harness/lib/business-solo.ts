// business-solo.ts — how a business runs: ONE agent that is the whole business.
//
// Measured on a real run of the multi-agent model this replaced: 21 agents for
// one request (9 seats, 11 reviews, 1 mapping), each born with ~47k tokens of
// base context plus a ~10k seat prompt, each rebuilding its context by reading
// what the others wrote; 76% of the plan went to re-reading context, and the
// run took 7.5 hours of wall clock, mostly in series.
//
// One agent is the whole business: it reads the brief the orchestrator wrote
// for it, plays the seats itself (opening a seat's file when it works as that
// seat, a clone's persona when it writes in that voice), and uses a squad by
// reading the squad's card and working as its agents. It opens nothing: no
// subagent, no squad dispatch, no other business (the `solo` role has an empty
// allowance). It works in phases with its state on disk, so a context ceiling
// costs nothing it has not already written down, and it ends with a one-page
// summary for the orchestrator and claims for the reviewer.
//
// Runtime-agnostic by construction: reading files, running commands and
// writing files is all it needs, so it runs the same on every runtime.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import * as os from "node:os";
import { AUTONOMOUS_DIRECTIVE, type Runtime } from "./host-agent-driver.ts";
import { runWithCascade } from "./cascade-runner.ts";
import { resolveEntityDir } from "../../_shared/lib/entity-resource-map.ts";
import { readEntityMemory } from "../../_shared/lib/entity-memory.ts";
import { loadCloneRegistry, resolveClonePersona } from "../../_shared/lib/clone-resolver.ts";
import { scopeGuard } from "../../_shared/lib/scope-guard.ts";
import { runFolderOf } from "../../_shared/lib/run-workspace.ts";
import { writeSquadCards } from "../../_shared/lib/work-cards.ts";
import { squadRunEnv } from "../../_shared/lib/squad-env.ts";
import { findCloneForTask, type CloneHit } from "../../_shared/lib/clone-search.ts";
import { parseWorkBrief } from "./work-brief.ts";
import { missingVoiceNotice, selectVoices } from "./clone-voices.ts";

export interface SeatVoice { slug: string; name?: string; dir: string | null; files: string[] }

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
  /** Failures of a carded squad's environment (squad-env.ts), by slug: its card tells the worker. */
  squadEnvProblems?: Record<string, string[]>;
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

/** `env`: the carded squads' environments (squad-env.ts squadRunEnv), for this run's child only. */
export interface SoloLaunch { cwd: string; addDirs: string[]; appendSystemPrompt: string; workspace?: string; env?: Record<string, string> }

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
export function readSeats(bizDir: string, cloneLookup: CloneLookup, nameOf: (slug: string) => string | undefined = () => undefined): Seat[] {
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
      return { slug: s, name: nameOf(s), dir: hit?.dir ?? null, files: hit?.files ?? [] };
    });
    // Business Protocol v2 §6.10: an empty list is the same as none, and both mean every squad.
    const authorized = listOf(fm.squads_authorized);
    return { slug, role: typeof fm.role === "string" ? fm.role.trim() : "", file, voices, squads: authorized.length ? authorized : null };
  });
}

/** The business's memory: the directories that hold curated content, and the
 *  shipped files that no longer match the home they were seeded into. */
export interface BusinessMemory {
  dirs: string[];
  /** The business's own `memory/` folder when a file in it differs from the home; null otherwise. */
  newer: { dir: string; files: string[] } | null;
}

/**
 * The business's memory, pointed at and never pasted. Reading it seeds the
 * home from the shipped `memory/` once (entity-memory.ts), so a business that
 * ships a memory is not a business with none; a directory whose files are
 * stubs is skipped. When the shipped copy has moved on since the seed, the
 * business's own folder is named too: the home is what earlier runs honored,
 * the folder is what the author wrote after.
 */
export function businessMemory(slug: string, bizDir: string, projectRoot: string): BusinessMemory {
  try {
    const mem = readEntityMemory("businesses", slug, { projectRoot, entityDir: bizDir });
    return {
      dirs: mem.scopes.map((s) => s.dir),
      newer: mem.diverged.length ? { dir: path.join(bizDir, "memory"), files: mem.diverged } : null,
    };
  } catch { return { dirs: [], newer: null }; }
}

export function defaultMemoryDirs(slug: string, bizDir: string, projectRoot: string): string[] {
  return businessMemory(slug, bizDir, projectRoot).dirs;
}

/** The squads a business prefers (`squads_preferred` in business.yaml); [] when absent or unreadable. */
export function preferredSquads(bizDir: string | null): string[] {
  if (!bizDir) return [];
  try { return listOf(parseYaml(fs.readFileSync(path.join(bizDir, "business.yaml"), "utf8"))?.squads_preferred); }
  catch { return []; }
}

/**
 * Clones that fit this request, by the one rule squads share (clone-voices.ts):
 * the ones the request asks for, else the library's search above its coverage
 * gate, at most `limit`. A clone a seat already carries is not repeated. One
 * that was asked for and is not installed comes back in `missing`, so the
 * prompt says so instead of staying silent.
 */
export function requestVoices(
  brief: string, seats: Seat[], cloneLookup: CloneLookup,
  names: Array<{ slug: string; name: string }>, search: (query: string) => CloneHit[], limit = 3,
): { voices: RequestVoice[]; missing: string[] } {
  const sel = selectVoices({
    brief, names, search, limit,
    installed: (slug) => cloneLookup(slug) !== null,
    taken: seats.flatMap((s) => s.voices.map((v) => v.slug)),
  });
  const voices = sel.voices.map((v) => {
    const hit = cloneLookup(v.slug)!;
    return { ...v, dir: hit.dir, files: hit.files };
  });
  return { voices, missing: sel.missing };
}

/** The squads that get a card: the router's picks, the ones the request names
 *  and the business's preferred ones. */
export function soloSquads(args: Pick<BusinessSoloArgs, "mandatorySquads" | "optionalSquads" | "briefSquads">, preferred: string[] = []): string[] {
  return [...new Set([...(args.mandatorySquads ?? []), ...(args.optionalSquads ?? []), ...(args.briefSquads ?? []), ...preferred])];
}

/** The squads whose cards a solo run writes: the dispatch prepares their environments first. */
export function cardedSquads(args: Pick<BusinessSoloArgs, "bizDir" | "mandatorySquads" | "optionalSquads" | "briefSquads">): string[] {
  return soloSquads(args, preferredSquads(args.bizDir));
}

/** The squads the seats are authorized to use and that have no card: named, not carded.
 *  A seat open to any squad adds none: listing the whole library would be the
 *  cost this mode removes. */
export function authorizedSquads(seats: Seat[], carded: Iterable<string>): string[] {
  const has = new Set(carded);
  return [...new Set(seats.flatMap((s) => s.squads ?? []))].filter((q) => !has.has(q));
}

/** Paths a path list holds once: case-insensitive on Windows, where `C:\Proj` and `c:\proj` are one folder. */
export function uniquePaths(list: string[], platform: NodeJS.Platform = process.platform, api: typeof path = platform === "win32" ? path.win32 : path.posix): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of list) {
    const r = api.resolve(p);
    const key = platform === "win32" ? r.toLowerCase() : r;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** The folder to grant for an input: the input itself when it is one, else the folder holding it. */
function inputFolder(p: string): string {
  const isDir = (() => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })();
  return isDir ? p : path.dirname(p);
}

/**
 * Files and folders the brief's "## Inputs" section names that exist on this
 * machine: absolute (POSIX, drive letter or UNC), `~/...`, or relative to the
 * project root. They are resolved here because the worker runs in its own run
 * folder, where a relative path means something else.
 */
export function briefInputPaths(
  brief: string, projectRoot: string,
  o: { exists?: (p: string) => boolean; home?: string; api?: typeof path } = {},
): string[] {
  const api = o.api ?? path;
  const exists = o.exists ?? fs.existsSync;
  const home = o.home ?? os.homedir();
  const body = parseWorkBrief(brief).sections["Inputs"] ?? "";
  const pathLike = /^(?:~|\.{1,2})?[\\/]|^~$|^[A-Za-z]:[\\/]|[\\/]/;
  const found: string[] = [];
  for (const line of body.split("\n")) {
    const bare = line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "");
    const candidates = [
      ...[...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
      bare.split(/\s+[\u2014\u2013-]\s+|\s+\(/)[0],
      ...bare.split(/\s+/),
    ];
    for (const raw of candidates) {
      const t = raw.trim().replace(/^["'(<]+|["')>,;.:]+$/g, "");
      if (!t || !pathLike.test(t)) continue;
      const resolved = /^~(?:[\\/]|$)/.test(t) ? api.join(home, t.slice(1)) : api.resolve(projectRoot, t);
      if (exists(resolved)) found.push(resolved);
    }
  }
  return uniquePaths(found, api === path.win32 ? "win32" : process.platform, api);
}

/** What the prompt carries beyond the seats, the squads and the memory it is handed. */
export interface SoloExtras {
  /** The business's own memory folder, when it is newer than the home the memory is read from. */
  memoryNewer?: { dir: string; files: string[] } | null;
  /** Inputs the brief names that exist on this machine, resolved. */
  inputs?: string[];
  /** Clones the request asked for that are not installed. */
  missingVoices?: string[];
  /** Squads the seats may use that have no card. */
  authorizedSquads?: string[];
}

/** The prompt of the one agent that is the business: a map, never pasted content. */
export function buildSoloPrompt(
  args: BusinessSoloArgs & { briefFile: string },
  seats: Seat[],
  memoryDirs: string[],
  squadCards: Record<string, string>,
  voices: RequestVoice[] = [],
  extras: SoloExtras = {},
): string {
  const lines: string[] = [];
  const progress = path.join(workDir(args.outputsRoot), "PROGRESS.md");
  lines.push(`# Business: ${args.slug}`, "");
  lines.push("You are this business, the whole of it, for one request. You play its seats yourself in this one session. Everything below is a map: open a file when the work needs it.", "");

  lines.push("## Your brief", "");
  lines.push(`\`${args.briefFile}\`. Read it first, and again at the start of every phase: the orchestrator appends decisions the user makes while you work.`);
  if (extras.inputs?.length) lines.push(`Inputs it names, resolved: ${extras.inputs.map((p) => `\`${p}\``).join(", ")}.`);
  lines.push("");

  lines.push("## The business", "");
  lines.push(`- Folder: \`${args.bizDir}\` (business.yaml, org-chart.yaml, employees/). Read what you need; do not change it.`);
  if (memoryDirs.length) lines.push(`- Memory from earlier runs: ${memoryDirs.map((d) => `\`${d}\``).join(", ")}. Honor what it records.`);
  if (extras.memoryNewer) lines.push(`- The business's own \`${extras.memoryNewer.dir}\` is newer than, or different from, that memory (${extras.memoryNewer.files.join(", ")}): read it too, and where the two disagree say which you followed.`);
  lines.push(`- To record a lesson for later runs: \`nrv memory add ${args.slug} "<fact>" --scope global|project\` (global: true of the business in any project; project: only this engagement).`);
  lines.push("");

  lines.push("## Seats", "", "To work as a seat, open its file first.", "");
  for (const s of seats) {
    const own = s.voices.length ? s.voices.map((v) => `\`${v.slug}\``).join(", ") : "none";
    lines.push(`- \`${s.slug}\`${s.role ? ` (${s.role})` : ""}: \`${s.file}\` · voices: ${own}`);
  }
  lines.push("");

  // Each clone once, wherever it comes from: a seat carries it or the request fits it.
  const clones = new Map<string, { name?: string; dir: string | null; note: string }>();
  for (const s of seats) for (const v of s.voices) if (!clones.has(v.slug)) clones.set(v.slug, { name: v.name, dir: v.dir, note: "seat voice" });
  for (const v of voices) if (!clones.has(v.slug)) clones.set(v.slug, { name: v.name, dir: v.dir, note: `fits this request, ${v.why}` });
  if (clones.size || extras.missingVoices?.length) {
    lines.push("## Voices", "", "To write in a clone's voice, open its persona files first; never claim a voice you did not load. Name the ones you used in participation.json.", "");
    for (const [slug, c] of clones) {
      lines.push(c.dir
        ? `- \`${slug}\`${c.name && c.name !== slug ? ` (${c.name})` : ""}: \`${c.dir}\`, AGENT.md and SOUL.md inside · ${c.note}`
        : `- \`${slug}\`: not installed · ${c.note}`);
    }
    if (extras.missingVoices?.length) lines.push(`- ${missingVoiceNotice(extras.missingVoices)}`);
    lines.push("");
  }

  lines.push("## Squads", "");
  const cards = Object.entries(squadCards);
  lines.push("You use a squad by reading its card and working as its agents. You never dispatch it.", "");
  if (cards.length) {
    for (const [slug, file] of cards) lines.push(`- \`${slug}\`: card \`${file}\``);
    lines.push("");
  }
  if (extras.authorizedSquads?.length) lines.push(`Also authorized for the seats, with no card written: ${extras.authorizedSquads.map((q) => `\`${q}\``).join(", ")}.`, "");
  lines.push(`${cards.length ? "For another squad" : "None was picked for this request. If a part needs one"}: \`nrv find "<the need>"\` ranks the installed squads and \`nrv cards squad <slug>\` prints a card. Do not browse squad folders.`, "");

  lines.push("## How you work", "");
  lines.push(
    `1. Work in phases. Keep \`${progress}\` current: decisions taken, what is done (with paths), what is next. Update it at every milestone. If your context is compacted, the brief and PROGRESS.md are how you carry on.`,
    "2. Read with purpose: locate with a search, then read the part you need. Put independent reads in the same turn. Do not print back a file you just wrote.",
    `3. Deliverables go under \`${args.outputsRoot}\`, working files under \`${workDir(args.outputsRoot)}\`; a copy of the brief or of an input is a working file, never a deliverable (the gate judges every file beside the deliverables as one). When the brief's work lives in another folder (a project to review or fix, a new project to create), do that work there and list every path you created or changed in the summary. participation.json goes where the end of this prompt names it.`,
    "4. Deliverables follow the language of the request.",
    "5. Deliver the whole of your part and nothing beyond it. Anything beyond it goes in the summary as a note.",
    "",
  );

  lines.push("## When you finish", "", "Write these, then end your turn:", "");
  lines.push(
    `- \`${summaryFileOf(args.outputsRoot)}\`: one page at most. What you delivered and where, the decisions you took, what is still open. The orchestrator reads only this.`,
    `- \`${claimsFileOf(args.outputsRoot)}\`: a JSON array with one entry per "Done when" item of the brief, in order: \`{"id": "d1", "evidence": "<file>:<lines>, <what it shows>"}\`.`,
    `- \`${participationFile(args.projectDir)}\` (outside the deliverables on purpose): \`{"seats": [{"seat": "<slug>", "files": ["<path>"]}], "squads": ["<slug>"], "clones": ["<slug>"]}\`, naming only what you actually used.`,
  );
  return lines.join("\n");
}

/** What a business-solo worker adds to the base directive: only what is true of a business. */
export const SOLO_ROLE_LINE = "- You are this business: you play its seats yourself (a seat's file, a clone's persona files) and use a squad by reading its card and working as its agents.";

export function soloDirective(rulesDirective = ""): string {
  return `${AUTONOMOUS_DIRECTIVE}\n${SOLO_ROLE_LINE}${rulesDirective}`;
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

/**
 * Credit what the worker declares in participation.json: the seats it played
 * and the clones it wrote in, each with where it came from (a seat's own, one
 * the engine offered for the request, or one the worker found). Shared by
 * runBusinessSolo and the Gauntlet producer, which runs the same worker. Returns
 * the seats credited.
 */
export function creditSoloRun(o: {
  emit: (event: string, payload: Record<string, unknown>) => void;
  projectId: string; projectDir: string; slug: string; runtime: Runtime;
  seats: Seat[]; voices: RequestVoice[];
}): string[] {
  const base = { trace_id: o.projectId, project_id: o.projectId, business_slug: o.slug };
  const played = seatsPlayed(o.projectDir, o.seats);
  for (const seat of played) o.emit("x_seat_credited", { ...base, employee: seat, evidence: "declared", runtime: o.runtime });
  const seatVoices = new Set(o.seats.flatMap((s) => s.voices.map((v) => v.slug)));
  const offered = new Set(o.voices.map((v) => v.slug));
  for (const clone of clonesUsed(o.projectDir)) {
    const source = seatVoices.has(clone) ? "seat" : offered.has(clone) ? "request" : "own-choice";
    o.emit("x_clone_credited", { ...base, clone, source, evidence: "declared", runtime: o.runtime });
  }
  return played;
}

/** Everything a run needs, written to the run folder: the brief, the squad
 *  cards and the prompt. Shared by the run, the scaffold-only path and the
 *  Gauntlet producer, so the three hand the worker the same map. It also
 *  clears the previous participation.json, so a stale file never credits this run. */
export function prepareBusinessSolo(args: BusinessSoloArgs): PreparedSolo {
  const cloneLookup = args.cloneLookup ?? defaultCloneLookup(args.projectDir);
  const squadDirOf = args.squadDirOf ?? ((q: string) => resolveEntityDir("squads", q, args.projectDir));
  let displayNames = new Map<string, string>();
  const names = args.cloneNames ?? (() => Object.entries(loadCloneRegistry({ cwd: args.projectDir }) as Record<string, any>)
    .map(([slug, c]) => ({ slug, name: String(c?.display_name ?? slug) })));
  try { displayNames = new Map(names().map((c) => [c.slug, c.name])); } catch { /* names are a courtesy */ }
  const seats = readSeats(args.bizDir, cloneLookup, (slug) => displayNames.get(slug));
  const memory = args.memoryDirs ? { dirs: args.memoryDirs, newer: null } : businessMemory(args.slug, args.bizDir, args.projectRoot);
  fs.mkdirSync(workDir(args.outputsRoot), { recursive: true });
  try { fs.rmSync(participationFile(args.projectDir), { force: true }); } catch { /* best effort */ }
  let briefFile = args.briefFile;
  if (!briefFile) {
    briefFile = path.join(args.projectDir, "brief.md");
    fs.writeFileSync(briefFile, args.brief.trim() + "\n");
  }
  // Cards only for what this run is likely to use; the seats' closed sets are named.
  const squads = cardedSquads(args);
  const squadCards = writeSquadCards(path.join(args.projectDir, "cards"), squads, squadDirOf, args.squadEnvProblems);
  const authorized = authorizedSquads(seats, Object.keys(squadCards));
  const briefText = (() => { try { return fs.readFileSync(briefFile, "utf8"); } catch { return args.brief; } })();
  let voices: RequestVoice[] = [];
  let missingVoices: string[] = [];
  try {
    const search = args.voiceSearch ?? ((q: string) => findCloneForTask(q, { limit: 6, cwd: args.projectDir }));
    ({ voices, missing: missingVoices } = requestVoices(briefText, seats, cloneLookup, names(), search));
  } catch { voices = []; } // a library that cannot be read leaves the seats' own voices
  const inputs = briefInputPaths(briefText, args.projectRoot);
  const prompt = buildSoloPrompt({ ...args, briefFile }, seats, memory.dirs, squadCards, voices, {
    memoryNewer: memory.newer, inputs, missingVoices, authorizedSquads: authorized,
  }) + "\n\n" + scopeGuard();
  fs.writeFileSync(path.join(args.projectDir, "solo-prompt.md"), prompt);
  // What the worker may touch: the run, the business, its voices, the squads
  // on its cards and those its seats may use, its memory, the folder of the
  // brief and the inputs the brief names.
  const dirs = [args.projectDir, args.outputsRoot, args.bizDir, ...memory.dirs, path.dirname(briefFile)];
  for (const s of seats) for (const v of s.voices) if (v.dir) dirs.push(v.dir);
  for (const v of voices) dirs.push(v.dir);
  for (const q of [...Object.keys(squadCards), ...authorized]) {
    const d = squadDirOf(q);
    if (fs.existsSync(d)) dirs.push(d);
  }
  dirs.push(...inputs.map(inputFolder));
  const workspace = runFolderOf(args.projectDir, args.projectRoot) ?? undefined;
  // The packages and Python of the carded squads, reached through variables on
  // the worker's run (squad-env.ts squadRunEnv).
  const env = squadRunEnv(Object.keys(squadCards));
  return {
    prompt, briefFile, seats, voices, squadCards,
    launch: {
      cwd: args.projectRoot, addDirs: uniquePaths(dirs),
      appendSystemPrompt: soloDirective(args.rulesDirective), ...(workspace ? { workspace } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    },
  };
}

/** Run the business as one agent, then read which seats it declares it played. */
export function runBusinessSolo(args: BusinessSoloArgs): BusinessSoloResult {
  const emit = args.emit ?? (() => {});
  const prep = prepareBusinessSolo(args);

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
  const played = creditSoloRun({ emit, projectId: args.projectId, projectDir: args.projectDir, slug: args.slug, runtime: finalRuntime, seats: prep.seats, voices: prep.voices });
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
