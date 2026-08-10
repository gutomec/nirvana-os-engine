// clone-resolver.ts — the SINGLE canonical mind-clone persona resolver.
//
// Replaces the two divergent injection paths (the `dna/` walk that preferred the
// irregular LEGACY-SIMPLIFIED.md, and the assigned_mind_clones path that
// concatenated AGENT+SOUL+MANIFEST). Both the business loader (employee-prompt)
// and the squad loader resolve a clone's persona through THIS function, so the
// same clone always yields the same, complete embodiment.
//
// depth="full"    → AGENT.md + SOUL.md + dna/dna-schema.md  (complete embodiment)
// depth="concise" → AGENT.md only                            (catalog / preview)
//
// Resolution: read the clone's persona_files from the registry (fast); fall back
// to a scope-aware filesystem probe of scope.mindCloneDirs when the clone is not
// yet in the registry (fresh install before `nrv index`).

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveScope } from "./scope.ts";
import { parseDnaSchema, type LayerKey } from "./dna-schema-parser.ts";

export type CloneDepth = "full" | "concise" | "fragments";

export type ClonePersona = {
  slug: string;
  display_name: string;
  content: string;
  files_used: string[];
  bytes: number;
  source: string;
  // Provenance (additive): where the persona was resolved from and whether it degraded.
  resolved_by?: "registry" | "fs-probe";
  degraded?: boolean;
  reason?: string;
  // Fragments mode (additive): effective depth, injected layers and the cost a
  // full dump would have (for audit/context savings).
  depth?: CloneDepth;
  layers_injected?: LayerKey[];
  full_bytes?: number;
};

export function cloneRegistryPath(): string {
  const scope = resolveScope();
  const dir = scope.projectRoot
    ? path.join(scope.projectRoot, ".nirvana")
    : path.join(os.homedir(), ".nirvana");
  return path.join(dir, ".mind-clones-registry.json");
}

export function loadCloneRegistry(): Record<string, any> {
  try {
    const p = cloneRegistryPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8")).mind_clones || {};
    }
  } catch {
    /* fall through to empty — callers fall back to filesystem */
  }
  return {};
}

function firstExisting(dir: string, rels: string[]): string | null {
  for (const r of rels) {
    const p = path.join(dir, r);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Locate a clone's directory + persona files by slug, scope-aware, without the
 *  registry. Used as the fallback path. First matching root wins (project over
 *  global). */
function probeClone(slug: string): { dir: string; files: Record<string, string | null> } | null {
  const scope = resolveScope();
  for (const root of scope.mindCloneDirs) {
    const cand = path.join(root, slug);
    if (fs.existsSync(path.join(cand, "MANIFEST.yaml")) || fs.existsSync(path.join(cand, "manifest.yaml"))) {
      return {
        dir: cand,
        files: {
          agent: firstExisting(cand, ["agent/AGENT.md", "AGENT.md"]),
          soul: firstExisting(cand, ["agent/SOUL.md", "SOUL.md"]),
          dna_schema: firstExisting(cand, ["dna/dna-schema.md"]),
        },
      };
    }
  }
  return null;
}

/** Resolve a clone slug into its full persona content for prompt injection.
 *  Returns null if the clone does not exist anywhere in scope. */
function readFileSafe(f: string | null | undefined, used: string[]): string {
  if (f && fs.existsSync(f)) {
    try { const s = fs.readFileSync(f, "utf8"); used.push(f); return s; } catch { /* unreadable — skip */ }
  }
  return "";
}

export function resolveClonePersona(
  slug: string,
  opts: { depth?: CloneDepth; layers?: LayerKey[]; byteBudget?: number } = {},
): ClonePersona | null {
  let depth = opts.depth || "full";
  const entry = loadCloneRegistry()[slug];
  let dir: string | null = entry?.dir || null;
  let files: Record<string, string | null> | null = entry?.persona_files || null;
  let resolved_by: "registry" | "fs-probe" = "registry";
  let degraded = false;
  let degradeReason = "";

  if (!dir || !files) {
    const probed = probeClone(slug);
    if (!probed) return null;
    dir = probed.dir;
    files = probed.files;
    resolved_by = "fs-probe";
    degraded = true;
    degradeReason = "clone fora do registry (fs-probe) — rode nrv index";
  }

  const used: string[] = [];
  // full_bytes: what a complete dump (agent+soul+dna) would cost — to audit the savings.
  const fullBytes = ["agent", "soul", "dna_schema"].reduce((n, k) => {
    const f = files![k];
    try { return f && fs.existsSync(f) ? n + fs.statSync(f).size : n; } catch { return n; }
  }, 0);

  let content = "";
  let layers_injected: LayerKey[] | undefined;

  if (depth === "fragments") {
    // AGENT.md is the persona's OPERATIONAL SPINE: Principles, named
    // Frameworks, Commands, `What You Refuse to Do` and `Limitations`. It is
    // NOT redundant with the dna-schema — the schema is a five-layer
    // derivation, not a substitute.
    //
    // Until 2026-07-27 the fragmented path did not read it, and that was not
    // "per-layer selection": it was swapping the agent's definition for the
    // summary derived from it. Measured: AGENT.md is 36% of everything full
    // injects, and in a blind test of 5 pairs the whole persona won 4 times —
    // with one judge deciding explicitly on `Limitations`, a section the
    // fragment had no way to see. The savings come from choosing schema LAYERS
    // by phase, never from amputating a whole artifact.
    const agent = readFileSafe(files["agent"], used);
    const soul = readFileSafe(files["soul"], used);
    const dnaPath = files["dna_schema"];
    const dnaRaw = dnaPath && fs.existsSync(dnaPath) ? fs.readFileSync(dnaPath, "utf8") : "";
    const parsed = dnaRaw ? parseDnaSchema(dnaRaw) : { ok: false, layers: {}, coherence_map: "" };
    if (parsed.ok) {
      // L1 (axioms) always + the requested layers; dedup preserving order.
      const want = (["L1", ...(opts.layers || ["L3"])] as LayerKey[]).filter((v, i, a) => a.indexOf(v) === i);

      // IDENTIFIED units, not an already-glued text. The budget may only
      // discard a whole unit; cutting mid-layer delivers half a method, which
      // is worse than an expensive method.
      type Unit = { kind: "agent" | "soul" | "layer" | "coherence"; key?: LayerKey; text: string };
      const units: Unit[] = [];
      if (agent) units.push({ kind: "agent", text: agent });
      if (soul) units.push({ kind: "soul", text: soul });
      for (const k of want) {
        const layer = parsed.layers[k];
        if (layer) units.push({ kind: "layer", key: k, text: layer.raw });
      }
      if (parsed.coherence_map) units.push({ kind: "coherence", text: parsed.coherence_map });

      const sizeOf = (u: Unit) => Buffer.byteLength(u.text, "utf8");
      const totalOf = (list: Unit[]) => list.reduce((n, u) => n + sizeOf(u), 0) + Math.max(0, list.length - 1) * 2;

      if (opts.byteBudget && totalOf(units) > opts.byteBudget) {
        // Only admissible discard: the coherence map, which is derived from
        // the layers and carries no method of its own.
        const i = units.findIndex((u) => u.kind === "coherence");
        if (i >= 0) units.splice(i, 1);
      }

      // If it still overflows, the fragment SHIPS COMPLETE anyway. The cap is
      // advisory, not scissors: delivering SOUL + the layers the phase asked
      // for above budget is still a fraction of full (average 9.2 KB versus
      // 20.4 KB), while amputating destroys exactly the layer the phase chose
      // — the cut was at the tail, and the tail is the specific layer.
      const overBudget = Boolean(opts.byteBudget && totalOf(units) > opts.byteBudget);
      if (overBudget) {
        degraded = true;
        degradeReason = degradeReason || `fragmento acima do orçamento (${totalOf(units)}B > ${opts.byteBudget}B), entregue íntegro`;
      }

      if (dnaPath) used.push(dnaPath);
      content = units.map((u) => u.text).join("\n\n");
      layers_injected = units.filter((u): u is Unit & { key: LayerKey } => u.kind === "layer").map((u) => u.key);
    } else {
      // Schema missing/unreadable → fall back to full (never lose the persona).
      depth = "full";
      degraded = true;
      degradeReason = degradeReason || (dnaRaw ? "dna-schema não parseável — fallback full" : "sem dna-schema.md — fallback full");
    }
    if (!content && depth === "fragments") depth = "full"; // empty soul+layers → falls back to full
  }

  if (depth !== "fragments") {
    const order = depth === "full" ? ["agent", "soul", "dna_schema"] : ["agent"];
    const parts: string[] = [];
    for (const k of order) {
      const s = readFileSafe(files[k], used);
      if (s) parts.push(s);
    }
    if (!parts.length) return null;
    content = parts.join("\n\n");
  }

  // Byte budget: truncates at a line break (avoids cutting mid-sentence).
  // The blind tail cut remains valid only for the NON-fragmented paths
  // (full/concise), where there is no semantic unit to discard. In the
  // fragmented one it would destroy the phase's layer and keep the one that
  // always goes in.
  if (depth !== "fragments" && opts.byteBudget && content.length > opts.byteBudget) {
    let cut = content.lastIndexOf("\n", opts.byteBudget);
    if (cut < opts.byteBudget * 0.6) cut = opts.byteBudget; // break too early → cut straight
    content = content.slice(0, cut).trimEnd() + "\n\n…(persona truncada ao orçamento)";
    degraded = true;
    degradeReason = degradeReason || "persona truncada (byteBudget)";
  }

  if (!content) return null;
  return {
    slug,
    display_name: entry?.display_name || slug,
    content,
    files_used: used,
    bytes: content.length,
    source: dir,
    resolved_by,
    degraded,
    reason: degradeReason,
    depth,
    layers_injected,
    full_bytes: fullBytes,
  };
}
