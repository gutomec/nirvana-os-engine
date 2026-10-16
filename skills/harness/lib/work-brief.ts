// work-brief.ts — the brief the orchestrator writes for one business.
//
// The orchestrator is the only agent that talked to the user, so it is the one
// that turns the conversation into "what and why" for each business. How the
// brief is written is a template (lib/brief-templates.ts): `slim` (labelled
// lines, the user's words by path), `standard` (the six `##` sections) or
// `detailed`, or one the user wrote. This module reads every one of them, and
// every brief written before the templates existed, into the same labels:
//
//   Goal       ← "Your part"            Request ← "Request (verbatim)"
//   Deliver    ← "Output"               Decisions, Inputs, Done when, Session,
//                                       Suggested structure, Method, Explain back
//
// The engine writes none of the content; it checks the labels a template
// requires, reads "Done when" as criteria d1..dn, resolves a Request given by
// path, and appends a decision the user makes mid-run.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BriefAltitude } from "./brief-altitude.ts";

/** The six sections of the standard brief, as their headings read. */
export const BRIEF_SECTIONS = ["Request (verbatim)", "Decisions", "Your part", "Inputs", "Done when", "Output"] as const;

/** Every label the engine reads, in its canonical name. */
export const BRIEF_LABELS = ["Goal", "Request", "Decisions", "Inputs", "Suggested structure", "Method", "Deliver", "Explain back", "Done when", "Session"] as const;
export type BriefLabel = (typeof BRIEF_LABELS)[number];

/** The older names of a label: the six-section brief's headings. */
const ALIASES: Record<string, BriefLabel> = { "request (verbatim)": "Request", "your part": "Goal", "output": "Deliver" };

/** Labels that may say "None." but must be present when a template requires them. */
const MAY_BE_NONE: ReadonlySet<BriefLabel> = new Set<BriefLabel>(["Decisions", "Inputs"]);

/** What each format requires when no template says otherwise. */
export const DEFAULT_REQUIRED: Record<"sections" | "labels", string[]> = {
  sections: [...BRIEF_SECTIONS],
  labels: ["Request", "Done when"],
};

export type BriefFormat = "sections" | "labels" | "none";

export interface ParsedBrief {
  /** `sections`: `## Heading` blocks; `labels`: `Label: value` lines; `none`: neither. */
  format: BriefFormat;
  sections: Partial<Record<BriefLabel, string>>;
  /** Against the format's default requirement (DEFAULT_REQUIRED). */
  missing: string[];
  empty: string[];
}

/** The canonical label a heading or a label names, or null. */
export function canonicalLabel(title: string): BriefLabel | null {
  const t = title.trim().replace(/\s+/g, " ").toLowerCase();
  if (ALIASES[t]) return ALIASES[t];
  return BRIEF_LABELS.find((s) => s.toLowerCase() === t) ?? null;
}

const HEADING = /^##\s+(.+?)\s*$/;
const LABEL_LINE = new RegExp(`^(${[...BRIEF_LABELS, "Request \\(verbatim\\)", "Your part", "Output"].map((l) => l.replace(/ /g, "\\s+")).join("|")})\\s*:\\s?(.*)$`, "i");

interface Entry { label: BriefLabel; header: number; form: "heading" | "label"; inline: string; start: number; end: number }

/** The format of a brief: labels when a `Request:` line comes before any known
 *  heading (a router or `--continue-from` may append `## ...` blocks to a
 *  labelled brief), sections when a known heading exists, labels when only
 *  label lines do. */
function detectFormat(lines: string[]): BriefFormat {
  let firstHeading = -1;
  let firstRequestLabel = -1;
  let anyLabel = false;
  lines.forEach((line, i) => {
    const h = HEADING.exec(line);
    if (h && canonicalLabel(h[1]) && firstHeading === -1) firstHeading = i;
    const l = LABEL_LINE.exec(line);
    if (l) {
      anyLabel = true;
      if (canonicalLabel(l[1]) === "Request" && firstRequestLabel === -1) firstRequestLabel = i;
    }
  });
  if (firstRequestLabel !== -1 && (firstHeading === -1 || firstRequestLabel < firstHeading)) return "labels";
  if (firstHeading !== -1) return "sections";
  return anyLabel ? "labels" : "none";
}

/** Where each label sits in the text: its header line and its body. */
function scan(lines: string[], format: BriefFormat): Entry[] {
  const out: Entry[] = [];
  let current: Entry | null = null;
  const close = (i: number) => { if (current) { current.end = i; out.push(current); current = null; } };
  lines.forEach((line, i) => {
    const h = HEADING.exec(line);
    if (h) {
      close(i);
      const label = canonicalLabel(h[1]);
      if (label) current = { label, header: i, form: "heading", inline: "", start: i + 1, end: lines.length };
      return;
    }
    if (format === "labels") {
      const l = LABEL_LINE.exec(line);
      if (l) {
        close(i);
        current = { label: canonicalLabel(l[1])!, header: i, form: "label", inline: l[2].trim(), start: i + 1, end: lines.length };
      }
    }
  });
  close(lines.length);
  return out;
}

function linesOf(text: string): string[] {
  return (text ?? "").replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n");
}

/** The labels of a brief in any of its formats, and what its format requires that is missing or empty. */
export function parseWorkBrief(text: string): ParsedBrief {
  const lines = linesOf(text);
  const format = detectFormat(lines);
  const sections: Partial<Record<BriefLabel, string>> = {};
  if (format !== "none") {
    for (const e of scan(lines, format)) {
      const body = [e.inline, ...lines.slice(e.start, e.end)].join("\n").trim();
      const prior = sections[e.label];
      sections[e.label] = prior !== undefined && prior !== "" ? (body ? `${prior}\n${body}` : prior) : body;
    }
  }
  const parsed: ParsedBrief = { format, sections, missing: [], empty: [] };
  const req = requirementGaps(parsed, DEFAULT_REQUIRED[format === "labels" ? "labels" : "sections"]);
  parsed.missing = req.missing;
  parsed.empty = req.empty;
  return parsed;
}

function requirementGaps(parsed: ParsedBrief, required: string[]): { missing: string[]; empty: string[] } {
  const missing: string[] = [];
  const empty: string[] = [];
  for (const name of required) {
    const label = canonicalLabel(name);
    if (!label) continue;
    const body = parsed.sections[label];
    if (body === undefined) missing.push(name);
    else if (!MAY_BE_NONE.has(label) && !body.trim()) empty.push(name);
  }
  return { missing, empty };
}

/** What a brief lacks against a template's required labels (default: its format's). */
export function briefProblems(parsed: ParsedBrief, required?: string[]): string[] {
  const asLabels = parsed.format === "labels";
  const { missing, empty } = required
    ? requirementGaps(parsed, required)
    : { missing: parsed.missing, empty: parsed.empty };
  const show = (n: string) => asLabels ? `${n}:` : `## ${n}`;
  return [
    ...missing.map((s) => `missing ${asLabels ? "label" : "section"}: ${show(s)}`),
    ...empty.map((s) => `empty ${asLabels ? "label" : "section"}: ${show(s)}`),
  ];
}

export interface Criterion { id: string; description: string; blocking: boolean }

/**
 * The "Done when" bullets as review criteria, ids d1..dn in order. A bullet
 * that ends in "(blocking)" or starts with "must" is blocking; the rest count
 * toward the score only.
 */
// i18n-user-facing: blocking markers matched against the brief, in the user's language
const BLOCKING_TAIL = /\s*(?:\*\*)?\(\s*(?:blocking|bloqueante)\s*\)(?:\*\*)?\s*[.;]?\s*$/i;
// i18n-user-facing: a criterion that opens with "must" / "deve" is blocking
const BLOCKING_HEAD = /^(?:\*\*)?(?:must|deve)\b/i;
// i18n-user-facing: an explicit "(non-blocking)" mark is dropped from the description and never blocks
const NON_BLOCKING_TAIL = /\s*(?:\*\*)?\(\s*(?:non-blocking|n[aã]o bloqueante)\s*\)(?:\*\*)?\s*[.;]?\s*$/i;
/** A top-level bullet: no indentation beyond one space. A nested bullet
 *  details its parent and is not a criterion of its own. */
const TOP_LEVEL_BULLET = /^ ?(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;

export function doneWhenCriteria(text: string): Criterion[] {
  const parsed = parseWorkBrief(text ?? "");
  const body = parsed.sections["Done when"] ?? "";
  let items = body.split("\n").map((l) => TOP_LEVEL_BULLET.exec(l)?.[1]).filter((x): x is string => !!x);
  // A labelled brief may state its one check on the label line itself.
  if (!items.length && parsed.format === "labels" && body.trim() && !body.includes("\n")) items = [body.trim()];
  return items.map((raw, i) => {
    if (NON_BLOCKING_TAIL.test(raw)) return { id: `d${i + 1}`, description: raw.replace(NON_BLOCKING_TAIL, "").trim(), blocking: false };
    const blocking = BLOCKING_TAIL.test(raw) || BLOCKING_HEAD.test(raw);
    return { id: `d${i + 1}`, description: raw.replace(BLOCKING_TAIL, "").trim(), blocking };
  });
}

// ── the request, by path ────────────────────────────────────────────────────

export interface RequestOptions {
  /** Folders a relative path is resolved against, before the cwd. */
  baseDirs?: string[];
  /** The brief's own file: its folder, and the project above `.nirvana/briefs/`. */
  briefFile?: string;
  home?: string;
}

/** The Request value with its decoration removed: backticks, quotes, angle brackets. */
function requestValue(parsed: ParsedBrief): string | null {
  const v = parsed.sections.Request;
  if (v === undefined) return null;
  return v.trim().replace(/^[`"'<]+|[`"'>]+$/g, "").trim();
}

/** Does the Request value read as a path (one line, a separator or a text-file extension)? */
export function requestLooksLikePath(value: string): boolean {
  return !!value && !value.includes("\n") && (/[\\/]/.test(value) || /\.(md|txt)$/i.test(value));
}

/** The project above a brief kept in `<project>/.nirvana/briefs/`. */
function projectAbove(file: string): string | null {
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i < 6; i++) {
    if (path.basename(dir) === ".nirvana") return path.dirname(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** The file the brief's Request names, resolved, or null when it names none that exists. */
export function requestFile(text: string, opts: RequestOptions = {}): string | null {
  const value = requestValue(parseWorkBrief(text));
  if (!value || !requestLooksLikePath(value)) return null;
  const home = opts.home ?? os.homedir();
  if (/^~(?:[\\/]|$)/.test(value)) {
    const p = path.join(home, value.slice(1));
    return isFile(p) ? p : null;
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return isFile(value) ? path.resolve(value) : null;
  const bases = [...(opts.baseDirs ?? []), process.cwd()];
  if (opts.briefFile) {
    bases.push(path.dirname(path.resolve(opts.briefFile)));
    const project = projectAbove(opts.briefFile);
    if (project) bases.push(project);
  }
  for (const base of bases) {
    const p = path.resolve(base, value);
    if (isFile(p)) return p;
  }
  return null;
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** The user's words: the file the Request names, else the Request text; null without a Request. */
export function requestWords(text: string, opts: RequestOptions = {}): string | null {
  const parsed = parseWorkBrief(text);
  if (parsed.sections.Request === undefined) return null;
  const file = requestFile(text, opts);
  if (file) {
    try { return fs.readFileSync(file, "utf8").replace(/^﻿/, "").trim(); } catch { /* fall through */ }
  }
  return parsed.sections.Request;
}

/** The brief with the user's words appended when its Request names a file:
 *  for a reader that gets the text and cannot open the file (the gate's judge,
 *  a pasted prompt). Unchanged otherwise. */
export function briefWithRequest(text: string, opts: RequestOptions = {}): string {
  const file = requestFile(text, opts);
  if (!file) return text;
  let words = "";
  try { words = fs.readFileSync(file, "utf8").replace(/^﻿/, "").trim(); } catch { return text; }
  if (!words) return text;
  return `${text.trimEnd()}\n\n## The user's words (verbatim, from ${file})\n\n${words}\n`;
}

// ── the session ─────────────────────────────────────────────────────────────

export type BriefSession = { kind: "new" } | { kind: "continue"; project: string } | { kind: "invalid"; raw: string };

/** The Session line: `new`, or `continue <project>`; null when the brief has none. */
export function briefSession(text: string): BriefSession | null {
  const raw = parseWorkBrief(text).sections.Session;
  if (raw === undefined) return null;
  const v = raw.trim().replace(/`/g, "");
  if (/^new\.?$/i.test(v)) return { kind: "new" };
  const m = /^continue\s+([A-Za-z0-9._-]+)\.?$/i.exec(v);
  if (m) return { kind: "continue", project: m[1] };
  return { kind: "invalid", raw: v };
}

// ── the skeleton ────────────────────────────────────────────────────────────

const SUGGESTED_STRUCTURE = ["## Suggested structure", "<the structure you suggest: sections, order, outline; the worker may adapt it>", ""];

/** A skeleton with the suggested-structure block above "Done when", the shape
 *  `briefing.altitude: guided` asked for. Unchanged when it already has one. */
export function withSuggestedStructure(skeleton: string): string {
  if (/suggested structure/i.test(skeleton)) return skeleton;
  const lines = skeleton.split("\n");
  const at = lines.findIndex((l) => /^##\s+done when\s*$/i.test(l));
  if (at !== -1) return [...lines.slice(0, at), ...SUGGESTED_STRUCTURE, ...lines.slice(at)].join("\n");
  const label = lines.findIndex((l) => /^done when\s*:/i.test(l));
  if (label === -1) return skeleton;
  return [...lines.slice(0, label), "Suggested structure: <sections, order, outline; the worker may adapt it>", ...lines.slice(label)].join("\n");
}

/**
 * The legacy skeleton per `briefing.altitude`: outcome is the standard
 * template, guided the standard plus a suggested structure, prescriptive the
 * detailed template. Read from the engine's templates.
 */
export function briefTemplate(altitude: BriefAltitude = "outcome"): string {
  // Imported lazily: brief-templates imports this module.
  const { engineTemplate } = require("./brief-templates.ts") as typeof import("./brief-templates.ts");
  if (altitude === "prescriptive") return engineTemplate("detailed").skeleton;
  const standard = engineTemplate("standard").skeleton;
  return altitude === "guided" ? withSuggestedStructure(standard) : standard;
}

/** Put a request path on the skeleton's Request line (labels) or under its heading (sections). */
export function skeletonWithRequest(skeleton: string, requestPath: string): string {
  const lines = skeleton.split("\n");
  const label = lines.findIndex((l) => /^request\s*:/i.test(l));
  if (label !== -1) { lines[label] = `Request: ${requestPath}`; return lines.join("\n"); }
  const heading = lines.findIndex((l) => { const h = HEADING.exec(l); return !!h && canonicalLabel(h[1]) === "Request"; });
  if (heading !== -1 && heading + 1 < lines.length) lines[heading + 1] = requestPath;
  return lines.join("\n");
}

// ── decisions mid-run ───────────────────────────────────────────────────────

/**
 * Append a decision to the "Decisions" of a brief file, in place, in either
 * format. The worker re-reads the brief at every phase, so a decision the user
 * makes while the work runs reaches it without an interruption. A "None."
 * placeholder is replaced by the first real decision.
 */
export function appendDecision(file: string, decision: string): void {
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const format = detectFormat(lines);
  const entry = `- ${decision.trim().replace(/\s+/g, " ")}`;
  const entries = scan(lines, format);
  const found = entries.find((e) => e.label === "Decisions");
  const isNone = (l: string) => /^\s*-?\s*none\.?\s*$/i.test(l);
  if (!found) {
    if (format === "labels") {
      const done = entries.find((e) => e.label === "Done when");
      const at = done ? done.header : lines.length;
      const next = [...lines.slice(0, at), "Decisions:", entry, ...lines.slice(at)];
      fs.writeFileSync(file, next.join("\n"), "utf8");
      return;
    }
    fs.writeFileSync(file, `${text.trimEnd()}\n\n## Decisions\n${entry}\n`, "utf8");
    return;
  }
  const header = found.form === "label"
    ? (found.inline && !isNone(found.inline) ? [lines[found.header]] : ["Decisions:"])
    : [lines[found.header]];
  const body = lines.slice(found.start, found.end).filter((l) => !isNone(l));
  const trailing: string[] = [];
  while (body.length && !body[body.length - 1].trim()) trailing.push(body.pop()!);
  const tail = found.form === "heading" ? [""] : trailing;
  const next = [...lines.slice(0, found.header), ...header, ...body, entry, ...tail, ...lines.slice(found.end)];
  fs.writeFileSync(file, next.join("\n").replace(/\n{3,}/g, "\n\n"), "utf8");
}
