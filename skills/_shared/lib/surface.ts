// surface.ts — extracts the CONTRACT SURFACE of an artifact (squad, business,
// mind-clone).
//
// The problem it solves: today a change to an artifact can only be narrated,
// never computed. The `version` field exists on all of them and is dead (132 of
// the 178 squads stuck at 5.0.0) precisely because nothing derives it or holds
// it accountable. Hand-written changelogs rot for the same reason, only faster.
//
// The surface is the set of STABLE IDENTIFIERS a consuming agent binds to —
// capability id, invocation ref, task/workflow/agent name, employee slug —
// plus the hash of each one's body. Two surfaces are mechanically comparable,
// so change becomes derived.
//
// DETERMINISM IS A REQUIREMENT, NOT A DETAIL. The generated file becomes part
// of the artifact's content and therefore of install.ts's hashDir(). If it
// carried a timestamp or unstable ordering, every rebuild would mark every
// artifact as "updated" and the signal would die in the noise. Hence: no
// generation date, sorted keys, and the surface file itself excluded from
// what it measures.

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

export const SURFACE_FILE = ".nirvana-surface.json";
/** Outputs of the generator itself. Measuring these as content creates a
 *  feedback loop: a change writes CHANGES.json/CHANGELOG.md, which on the next
 *  run count as new content, which produces another change, forever. Only the
 *  mind-clone surface walks the whole directory, so the defect was exclusive
 *  to it. */
export const GENERATED_FILES = [SURFACE_FILE, "CHANGES.json", "CHANGELOG.md", ".nirvana-behavior.md"];
/** 3: workflow keys and bindings drop the file extension (`workflow:workflows/x`),
 *  `.md` workflows are listed, stem collisions are flagged. See `normalizeSurface`. */
export const SURFACE_SCHEMA = 3;

export type ArtifactKind = "squad" | "business" | "mind-clone";

export type EntryType =
  | "capability"
  | "task"
  | "workflow"
  | "agent"
  | "employee"
  | "domain"
  | "produces"
  | "org-chart"
  | "routing"
  | "dna-artifact";

export interface SurfaceEntry {
  type: EntryType;
  /** Binding target: `workflow:workflows/x` (no extension: the encoding of a
   *  workflow is not contract), `task:tasks/y.md`. Changing this breaks
   *  invokers, even with the id intact. */
  binding?: string;
  /** Workflow entries only: other files in `workflows/` sharing this stem
   *  (`x.md` + `x.yaml`). The `.md` wins the entry; the rest are listed here
   *  for the lint to fail on. Metadata, never part of the surface hash. */
  collision?: string[];
  /** Routing labels (the capability's domains/produces). */
  routing?: string[];
  /** Hash of the entry's own body (YAML node or file). */
  hash: string;
}

export interface Surface {
  schema: number;
  kind: ArtifactKind;
  slug: string;
  /** Semver derived from the diff history. Seeded from the declared version at
   *  first generation; from then on only the diff moves it. */
  contract_version: string;
  /** Hash of identifiers + bindings only. Changed = the contract moved. */
  surface_hash: string;
  /** Hash of the discovery prose (description/examples/keywords). Changing
   *  alone = PATCH: routing may improve, but nothing breaks. */
  prose_hash: string;
  entries: Record<string, SurfaceEntry>;
}

// ───────────────────────────── utilities ─────────────────────────────

function sha(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** Canonical JSON: keys sorted at every depth. Without this, iteration order
 *  leaks into the hash and the diff turns into noise. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

function readYaml(file: string): any {
  try { return parseYaml(fs.readFileSync(file, "utf8")) ?? {}; } catch { return {}; }
}

function listFiles(dir: string, exts: string[]): string[] {
  try {
    return fs.readdirSync(dir)
      .filter((f) => exts.some((e) => f.endsWith(e)))
      .sort();
  } catch { return []; }
}

function fileHash(file: string): string {
  try { return sha(fs.readFileSync(file)); } catch { return "missing"; }
}

/** Workflow encodings, in precedence order: the `.md` wins a stem collision. */
const WORKFLOW_EXTS = [".md", ".yaml", ".yml"];
const WORKFLOW_EXT_RE = /\.(ya?ml|md)$/i;
function stripWorkflowExt(name: string): string { return name.replace(WORKFLOW_EXT_RE, ""); }
function workflowRank(file: string): number {
  const i = WORKFLOW_EXTS.findIndex((e) => file.toLowerCase().endsWith(e));
  return i === -1 ? WORKFLOW_EXTS.length : i;
}

/** Discovery prose: changes semantic routing, never the binding. */
const PROSE_KEYS = ["description", "examples", "example_briefs", "keywords", "not_for"];

function splitProse(node: Record<string, unknown>): { contract: Record<string, unknown>; prose: Record<string, unknown> } {
  const contract: Record<string, unknown> = {};
  const prose: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (PROSE_KEYS.includes(k)) prose[k] = v;
    else contract[k] = v;
  }
  return { contract, prose };
}

// ───────────────────────────── kind detection ─────────────────────────────

export function detectKind(dir: string): ArtifactKind | null {
  if (fs.existsSync(path.join(dir, "squad.yaml"))) return "squad";
  if (fs.existsSync(path.join(dir, "business.yaml"))) return "business";
  if (fs.existsSync(path.join(dir, "MANIFEST.yaml"))) return "mind-clone";
  return null;
}

// ───────────────────────────── extraction ─────────────────────────────

function squadSurface(dir: string, slug: string): { entries: Record<string, SurfaceEntry>; prose: string[] } {
  const manifest = readYaml(path.join(dir, "squad.yaml"));
  const entries: Record<string, SurfaceEntry> = {};
  const prose: string[] = [];

  for (const cap of (manifest.capabilities ?? []) as any[]) {
    const id = String(cap?.id ?? "").trim();
    if (!id) continue;
    const { contract, prose: p } = splitProse(cap);
    // The `id` is the entry's KEY, not part of the body. Keeping it inside the
    // hash would make every rename change the hash too, and the rename detector
    // (which matches by identical body) would never recognize one — it would
    // report removal + addition, hiding exactly the trivial swap-the-id migration.
    delete (contract as Record<string, unknown>).id;
    const invoke = cap?.invoke ?? {};
    entries[`capability:${id}`] = {
      type: "capability",
      binding: invoke?.type && invoke?.ref
        ? `${invoke.type}:${invoke.type === "workflow" ? stripWorkflowExt(String(invoke.ref)) : invoke.ref}`
        : undefined,
      routing: [
        ...((cap?.domains ?? []) as string[]).map((d) => `domain:${d}`),
        ...((cap?.produces ?? []) as string[]).map((d) => `produces:${d}`),
      ].sort(),
      hash: sha(canonical(contract)),
    };
    // Only the prose CONTENT enters the hash, never the id. Including the id
    // would make every rename fire a "prose_changed" alongside the real break,
    // mixing routing noise with the signal that matters.
    prose.push(canonical(p));
  }

  // File components: the name is the identifier workflows and capabilities
  // reference, so renaming is a break even with identical content.
  for (const [sub, type] of [["tasks", "task"], ["agents", "agent"]] as const) {
    const subdir = path.join(dir, sub);
    for (const f of listFiles(subdir, [".md"])) {
      entries[`${type}:${sub}/${f}`] = { type, hash: fileHash(path.join(subdir, f)) };
    }
  }

  // Workflows are keyed by STEM, never by file name: `.yaml` and `.md` are two
  // encodings of one graph, and an invoker does not bind to the encoding.
  // Keys use a literal `/` (never path.join) so they are identical on Windows;
  // stems are lowercased because the file systems that matter are
  // case-insensitive. When two files share a stem, the `.md` wins the entry
  // and the others are flagged in `collision` for the lint to reject.
  const wfDir = path.join(dir, "workflows");
  const byStem = new Map<string, string[]>();
  for (const f of listFiles(wfDir, WORKFLOW_EXTS)) {
    const stem = stripWorkflowExt(f).toLowerCase();
    byStem.set(stem, [...(byStem.get(stem) ?? []), f]);
  }
  for (const [stem, files] of byStem) {
    const ranked = [...files].sort((a, b) => workflowRank(a) - workflowRank(b) || a.localeCompare(b));
    const entry: SurfaceEntry = { type: "workflow", hash: fileHash(path.join(wfDir, ranked[0])) };
    if (ranked.length > 1) entry.collision = ranked.slice(1);
    entries[`workflow:workflows/${stem}`] = entry;
  }
  return { entries, prose };
}

function businessSurface(dir: string, slug: string): { entries: Record<string, SurfaceEntry>; prose: string[] } {
  const manifest = readYaml(path.join(dir, "business.yaml"));
  const entries: Record<string, SurfaceEntry> = {};
  const prose: string[] = [];

  // Domains and produces are the business's routing surface: the orchestrator
  // selects by them. Losing a domain is a break for whoever routed by it.
  for (const d of (manifest.domains ?? []) as string[]) {
    entries[`domain:${d}`] = { type: "domain", hash: sha(String(d)) };
  }
  for (const p of (manifest.produces ?? []) as string[]) {
    entries[`produces:${p}`] = { type: "produces", hash: sha(String(p)) };
  }

  const empDir = path.join(dir, "employees");
  for (const f of listFiles(empDir, [".md"])) {
    entries[`employee:${f.replace(/\.md$/, "")}`] = { type: "employee", hash: fileHash(path.join(empDir, f)) };
  }

  for (const [file, type] of [["org-chart.yaml", "org-chart"], ["routing.yaml", "routing"]] as const) {
    const full = path.join(dir, file);
    if (fs.existsSync(full)) entries[`${type}:${file}`] = { type, hash: fileHash(full) };
  }

  const { prose: p } = splitProse(manifest);
  prose.push(canonical(p));
  return { entries, prose };
}

function mindCloneSurface(dir: string, slug: string): { entries: Record<string, SurfaceEntry>; prose: string[] } {
  // A clone has no invocable contract: nobody "calls" it, it is injected. The
  // useful surface is which persona artifacts exist. Change here is almost
  // always additive or behavioral, so the treatment is deliberately light.
  const entries: Record<string, SurfaceEntry> = {};
  const walk = (rel: string) => {
    const full = path.join(dir, rel);
    let items: string[] = [];
    try { items = fs.readdirSync(full).sort(); } catch { return; }
    for (const it of items) {
      if (GENERATED_FILES.includes(it) || it.startsWith(".")) continue;
      const child = path.join(full, it);
      const childRel = rel ? `${rel}/${it}` : it;
      if (fs.statSync(child).isDirectory()) walk(childRel);
      else entries[`dna-artifact:${childRel}`] = { type: "dna-artifact", hash: fileHash(child) };
    }
  };
  walk("");
  return { entries, prose: [] };
}

// ───────────────────────────── API ─────────────────────────────

/** Version declared in the manifest, used only to seed the first generation. */
function declaredVersion(dir: string, kind: ArtifactKind): string {
  const file = kind === "squad" ? "squad.yaml" : kind === "business" ? "business.yaml" : "MANIFEST.yaml";
  const v = String(readYaml(path.join(dir, file))?.version ?? "").trim();
  return /^\d+\.\d+\.\d+$/.test(v) ? v : "1.0.0";
}

/**
 * Brings a surface written under schema ≤ 2 to the schema-3 key form: workflow
 * keys and `workflow:` bindings lose their extension, stems are lowercased.
 * The schema number is NOT touched: `diffSurfaces` must still see the
 * transition and re-establish the baseline (surface-diff.ts). What this buys
 * is that whoever reads an old file sees the identifiers a fresh extraction
 * produces, so a `.yaml → .md` migration compared under one schema is
 * `content_changed`, never `removed + added + rebound`.
 */
export function normalizeSurface(s: Surface): Surface {
  if (typeof s.schema !== "number" || s.schema > 2) return s;
  const entries: Record<string, SurfaceEntry> = {};
  for (const k of Object.keys(s.entries).sort()) {
    const e: SurfaceEntry = { ...s.entries[k] };
    if (e.binding?.startsWith("workflow:")) e.binding = `workflow:${stripWorkflowExt(e.binding.slice("workflow:".length))}`;
    let key = k;
    if (e.type === "workflow" && k.startsWith("workflow:workflows/")) {
      const file = k.slice("workflow:workflows/".length);
      key = `workflow:workflows/${stripWorkflowExt(file).toLowerCase()}`;
      if (key in entries) {
        entries[key].collision = [...(entries[key].collision ?? []), file].sort();
        continue;
      }
    }
    entries[key] = e;
  }
  const ordered: Record<string, SurfaceEntry> = {};
  for (const k of Object.keys(entries).sort()) ordered[k] = entries[k];
  return { ...s, entries: ordered };
}

export function readSurface(dir: string): Surface | null {
  const file = path.join(dir, SURFACE_FILE);
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as Surface;
    return s && typeof s === "object" && s.entries ? normalizeSurface(s) : null;
  } catch { return null; }
}

/**
 * Extracts the artifact's current surface from disk. `contract_version` comes
 * out as the seeded version; the diff applies the bump, not the extraction.
 */
export function extractSurface(dir: string, kindHint?: ArtifactKind): Surface {
  const kind = kindHint ?? detectKind(dir);
  if (!kind) throw new Error(`not a recognizable Nirvana artifact: ${dir}`);
  const slug = path.basename(dir);

  const { entries, prose } =
    kind === "squad" ? squadSurface(dir, slug)
    : kind === "business" ? businessSurface(dir, slug)
    : mindCloneSurface(dir, slug);

  const ordered: Record<string, SurfaceEntry> = {};
  for (const k of Object.keys(entries).sort()) ordered[k] = entries[k];

  // surface_hash covers only identity and binding. Each entry's BODY hash goes
  // in separately, because a changed body with an untouched id is a PATCH, not
  // a break.
  const bindingOnly = Object.fromEntries(
    Object.entries(ordered).map(([k, v]) => [k, { binding: v.binding ?? null, routing: v.routing ?? null }]),
  );

  const previous = readSurface(dir);
  return {
    schema: SURFACE_SCHEMA,
    kind,
    slug,
    contract_version: previous?.contract_version ?? declaredVersion(dir, kind),
    surface_hash: sha(canonical(bindingOnly)),
    prose_hash: sha(prose.sort().join("\n")),
    entries: ordered,
  };
}

/** Deterministic serialization: same input, same bytes, always. */
export function serializeSurface(s: Surface): string {
  return JSON.stringify(
    {
      schema: s.schema,
      kind: s.kind,
      slug: s.slug,
      contract_version: s.contract_version,
      surface_hash: s.surface_hash,
      prose_hash: s.prose_hash,
      entries: s.entries,
    },
    null,
    2,
  ) + "\n";
}

export function writeSurface(dir: string, s: Surface): void {
  fs.writeFileSync(path.join(dir, SURFACE_FILE), serializeSurface(s), "utf8");
}
