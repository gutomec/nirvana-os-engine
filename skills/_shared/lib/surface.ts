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
export const SURFACE_SCHEMA = 2;

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
  /** Binding target: `workflow:workflows/x.yaml`, `task:tasks/y.md`. Changing
   *  this breaks invokers, even with the id intact. */
  binding?: string;
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
      binding: invoke?.type && invoke?.ref ? `${invoke.type}:${invoke.ref}` : undefined,
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
  for (const [sub, type, exts] of [
    ["tasks", "task", [".md"]],
    ["workflows", "workflow", [".yaml", ".yml"]],
    ["agents", "agent", [".md"]],
  ] as const) {
    const subdir = path.join(dir, sub);
    for (const f of listFiles(subdir, exts as unknown as string[])) {
      entries[`${type}:${sub}/${f}`] = { type, hash: fileHash(path.join(subdir, f)) };
    }
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

export function readSurface(dir: string): Surface | null {
  const file = path.join(dir, SURFACE_FILE);
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as Surface;
    return s && typeof s === "object" && s.entries ? s : null;
  } catch { return null; }
}

/**
 * Extracts the artifact's current surface from disk. `contract_version` comes
 * out as the seeded version; the diff applies the bump, not the extraction.
 */
export function extractSurface(dir: string, kindHint?: ArtifactKind): Surface {
  const kind = kindHint ?? detectKind(dir);
  if (!kind) throw new Error(`não é um artefato Nirvana reconhecível: ${dir}`);
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
