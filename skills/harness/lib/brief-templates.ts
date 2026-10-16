// brief-templates.ts — how the orchestrator is told to write a brief.
//
// A brief template is one markdown file: a short instruction, and the skeleton
// in the fenced block under "## The brief". Its frontmatter names the format
// (`labels` or `sections`) and the labels the engine needs (`required`). The
// engine ships three (references/brief-templates/): slim, standard, detailed.
// A user adds or overrides one by name:
//
//   <project>/.nirvana/brief-templates/<name>.md
//   > <NIRVANA_HOME|~>/.nirvana/brief-templates/<name>.md
//   > skills/harness/references/brief-templates/<name>.md
//
// `briefing.template` names the active one (default slim). `briefing.altitude`
// is its legacy alias: outcome → standard, guided → standard plus a suggested
// structure, prescriptive → detailed, used only while briefing.template is unset.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";
import { describeSettingSource, discoverProjectRoot, resolveSetting, type ResolveOptions } from "../../_shared/lib/settings.ts";
import { canonicalLabel, DEFAULT_REQUIRED, requestFile, requestWords, withSuggestedStructure } from "./work-brief.ts";
import type { BriefAltitude } from "./brief-altitude.ts";

export const ENGINE_TEMPLATES_DIR = path.join(import.meta.dir, "..", "references", "brief-templates");
export const DEFAULT_TEMPLATE = "slim";
export const TEMPLATE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type TemplateOrigin = "project" | "global" | "engine";

export interface BriefTemplate {
  name: string;
  origin: TemplateOrigin;
  path: string;
  text: string;
  sha256: string;
  description: string;
  format: "labels" | "sections";
  /** Labels the engine needs, as the template writes them. */
  required: string[];
  /** The fenced block under "## The brief", ending in a newline. */
  skeleton: string;
}

export interface TemplateOptions extends ResolveOptions {
  /** Engine templates folder (tests). */
  engineDir?: string;
}

export class BriefTemplateError extends Error {}

function homeOf(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  return env.NIRVANA_HOME || os.homedir();
}

/** The project whose `.nirvana/brief-templates/` counts: the declared project,
 *  else the cwd when it holds that folder (never the home, whose `.nirvana` is global). */
export function templatesProjectRoot(opts: TemplateOptions = {}): string | null {
  if (opts.projectRoot !== undefined) return opts.projectRoot;
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const declared = discoverProjectRoot(env, cwd);
  if (declared) return declared;
  const home = path.resolve(homeOf(env));
  if (path.resolve(cwd) !== home && path.resolve(cwd) !== path.resolve(os.homedir())
      && fs.existsSync(path.join(cwd, ".nirvana", "brief-templates"))) return path.resolve(cwd);
  return null;
}

/** The folders searched, in order of precedence. */
export function templateDirs(opts: TemplateOptions = {}): Array<{ origin: TemplateOrigin; dir: string }> {
  const env = opts.env ?? process.env;
  const out: Array<{ origin: TemplateOrigin; dir: string }> = [];
  const project = templatesProjectRoot(opts);
  if (project) out.push({ origin: "project", dir: path.join(project, ".nirvana", "brief-templates") });
  out.push({ origin: "global", dir: path.join(homeOf(env), ".nirvana", "brief-templates") });
  out.push({ origin: "engine", dir: opts.engineDir ?? ENGINE_TEMPLATES_DIR });
  return out;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The fenced block under "## The brief", else the first fenced block, else the body. */
function skeletonOf(body: string): string {
  const lines = body.split("\n");
  const fenceAfter = (from: number): string | null => {
    const open = lines.findIndex((l, i) => i >= from && /^```/.test(l));
    if (open === -1) return null;
    const close = lines.findIndex((l, i) => i > open && /^```\s*$/.test(l));
    if (close === -1) return null;
    return lines.slice(open + 1, close).join("\n");
  };
  const heading = lines.findIndex((l) => /^##\s+the brief\s*$/i.test(l));
  const block = (heading !== -1 ? fenceAfter(heading) : null) ?? fenceAfter(0) ?? body.trim();
  return `${block.replace(/\s+$/, "")}\n`;
}

/** A template file read: frontmatter, skeleton, digest. */
export function parseTemplate(text: string, file: string, origin: TemplateOrigin, name: string): BriefTemplate {
  const clean = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  let meta: Record<string, unknown> = {};
  let body = clean;
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(clean);
  if (fm) {
    try { meta = (YAML.parse(fm[1]) as Record<string, unknown>) ?? {}; } catch { meta = {}; }
    body = clean.slice(fm[0].length);
  }
  const skeleton = skeletonOf(body);
  const format = meta.format === "sections" || meta.format === "labels" ? meta.format
    : /^##\s+\S/m.test(skeleton) ? "sections" : "labels";
  const required = Array.isArray(meta.required) && meta.required.length
    ? meta.required.map(String)
    : DEFAULT_REQUIRED[format];
  return {
    name, origin, path: file, text, sha256: sha256(text),
    description: typeof meta.description === "string" ? meta.description : "",
    format, required, skeleton,
  };
}

/** The template a name resolves to, by precedence; null when no folder has it. */
export function findTemplate(name: string, opts: TemplateOptions = {}): BriefTemplate | null {
  if (!TEMPLATE_NAME.test(name)) return null;
  for (const { origin, dir } of templateDirs(opts)) {
    const file = path.join(dir, `${name}.md`);
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    return parseTemplate(text, file, origin, name);
  }
  return null;
}

/** One of the engine's own templates; throws when it is missing (a broken install). */
export function engineTemplate(name: string, opts: TemplateOptions = {}): BriefTemplate {
  const file = path.join(opts.engineDir ?? ENGINE_TEMPLATES_DIR, `${name}.md`);
  return parseTemplate(fs.readFileSync(file, "utf8"), file, "engine", name);
}

export interface ListedTemplate { name: string; origin: TemplateOrigin; path: string; description: string; overrides: TemplateOrigin[] }

/** Every name available, with the file that wins and the origins it overrides. */
export function listTemplates(opts: TemplateOptions = {}): ListedTemplate[] {
  const byName = new Map<string, ListedTemplate>();
  for (const { origin, dir } of templateDirs(opts)) {
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { continue; }
    for (const f of files.sort()) {
      const name = f.slice(0, -3);
      if (!TEMPLATE_NAME.test(name)) continue;
      const seen = byName.get(name);
      if (seen) { seen.overrides.push(origin); continue; }
      const t = findTemplate(name, opts);
      if (t) byName.set(name, { name, origin: t.origin, path: t.path, description: t.description, overrides: [] });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** What a template lacks for the engine to read the briefs written with it. */
export function templateProblems(t: BriefTemplate): string[] {
  const labels = new Set(t.required.map((r) => canonicalLabel(r)));
  const out: string[] = [];
  for (const need of ["Request", "Done when"] as const) {
    if (!labels.has(need)) out.push(`template ${t.name} (${t.path}) does not require "${need}": the judges read the user's words from Request and the review checks Done when.`);
  }
  for (const r of t.required) if (!canonicalLabel(r)) out.push(`template ${t.name} requires "${r}", a label the engine does not read.`);
  return out;
}

const ALTITUDE_TEMPLATE: Record<BriefAltitude, string> = { outcome: "standard", guided: "standard", prescriptive: "detailed" };

export interface ActiveTemplate {
  name: string;
  /** Where the name came from, for the one line `nrv brief template` prints. */
  source: string;
  /** The file, or null when no folder has that name. */
  template: BriefTemplate | null;
  /** The behaviour the worker prompts and the delivery check keep from the altitude. */
  altitude: BriefAltitude;
  /** A one-line note: a deprecated altitude in use, or an unknown name. */
  note?: string;
}

/** The active template: an explicit name (`--template`), else briefing.template
 *  when set, else a stored briefing.altitude mapped, else slim. */
export function resolveActiveTemplate(opts: TemplateOptions & { override?: string } = {}): ActiveTemplate {
  const pick = (name: string, source: string, altitude: BriefAltitude, note?: string): ActiveTemplate => {
    const template = findTemplate(name, opts);
    const missing = template ? undefined : unknownTemplateMessage(name, opts);
    return { name, source, template, altitude, ...(note || missing ? { note: [note, missing].filter(Boolean).join(" ") } : {}) };
  };
  const altitudeOf = (name: string): BriefAltitude => (name === "detailed" ? "prescriptive" : "outcome");
  if (opts.override) return pick(opts.override, "--template", altitudeOf(opts.override));
  const set = (source: string) => source !== "default" && source !== "engine-default";
  try {
    const t = resolveSetting("briefing.template", opts);
    const name = String(t.value ?? "").trim();
    if (name) return pick(name, `briefing.template, ${describeSettingSource(t)}`, altitudeOf(name));
  } catch { /* a broken settings file never stops a brief */ }
  try {
    const a = resolveSetting("briefing.altitude", opts);
    const altitude = String(a.value) as BriefAltitude;
    if (set(String(a.source)) && ALTITUDE_TEMPLATE[altitude]) {
      const name = ALTITUDE_TEMPLATE[altitude];
      return pick(name, `briefing.altitude = ${altitude}, ${describeSettingSource(a)}`, altitude,
        `briefing.altitude is deprecated: ${altitude} selects the ${name} template${altitude === "guided" ? " with a suggested structure" : ""}; use nrv config set briefing.template ${name} instead.`);
    }
  } catch { /* default below */ }
  return pick(DEFAULT_TEMPLATE, "default", "outcome");
}

export function unknownTemplateMessage(name: string, opts: TemplateOptions = {}): string {
  const names = listTemplates(opts).map((t) => t.name);
  return `no brief template named "${name}" in ${templateDirs(opts).map((d) => d.dir).join(", ")}. Available: ${names.join(", ") || "none"}.`;
}

/** The skeleton `nrv brief template` prints for the active template. */
export function activeSkeleton(active: ActiveTemplate): string {
  if (!active.template) return "";
  // guided kept its suggested structure: the standard skeleton plus that block.
  if (active.altitude === "guided") {
    return withSuggestedStructure(active.template.skeleton);
  }
  return active.template.skeleton;
}

export interface TemplateRecord {
  template: string;
  origin: TemplateOrigin | null;
  path: string | null;
  sha256: string | null;
  copy: string | null;
  source: string;
}

/** Copy the active template into a run folder and say which it was: the record
 *  `x_brief_template` carries, so a run can be reproduced from its folder. */
export function recordBriefTemplate(runDir: string, active: ActiveTemplate): TemplateRecord {
  const t = active.template;
  let copy: string | null = null;
  if (t) {
    try {
      fs.mkdirSync(runDir, { recursive: true });
      copy = path.join(runDir, "brief-template.md");
      fs.writeFileSync(copy, t.text, "utf8");
    } catch { copy = null; }
  }
  return { template: active.name, origin: t?.origin ?? null, path: t?.path ?? null, sha256: t?.sha256 ?? null, copy, source: active.source };
}

/** Copy the user's words into the run folder (`request.md`). The file the brief
 *  names when it names one, else the Request text; null without a Request. */
export function recordRequest(runDir: string, brief: string, opts: { briefFile?: string; baseDirs?: string[] } = {}): { file: string | null; copy: string | null; sha256: string | null } {
  const words = requestWords(brief, opts);
  if (words === null) return { file: null, copy: null, sha256: null };
  const file = requestFile(brief, opts);
  try {
    fs.mkdirSync(runDir, { recursive: true });
    const copy = path.join(runDir, "request.md");
    const text = `${words.trim()}\n`;
    fs.writeFileSync(copy, text, "utf8");
    return { file, copy, sha256: sha256(text) };
  } catch {
    return { file, copy: null, sha256: null };
  }
}
