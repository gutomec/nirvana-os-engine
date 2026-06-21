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

export type CloneDepth = "full" | "concise";

export type ClonePersona = {
  slug: string;
  display_name: string;
  content: string;
  files_used: string[];
  bytes: number;
  source: string;
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
export function resolveClonePersona(slug: string, opts: { depth?: CloneDepth } = {}): ClonePersona | null {
  const depth = opts.depth || "full";
  const entry = loadCloneRegistry()[slug];
  let dir: string | null = entry?.dir || null;
  let files: Record<string, string | null> | null = entry?.persona_files || null;

  if (!dir || !files) {
    const probed = probeClone(slug);
    if (!probed) return null;
    dir = probed.dir;
    files = probed.files;
  }

  const order = depth === "full" ? ["agent", "soul", "dna_schema"] : ["agent"];
  const used: string[] = [];
  const parts: string[] = [];
  for (const k of order) {
    const f = files[k];
    if (f && fs.existsSync(f)) {
      try {
        parts.push(fs.readFileSync(f, "utf8"));
        used.push(f);
      } catch {
        /* unreadable — skip */
      }
    }
  }
  if (!parts.length) return null;

  const content = parts.join("\n\n");
  return {
    slug,
    display_name: entry?.display_name || slug,
    content,
    files_used: used,
    bytes: content.length,
    source: dir,
  };
}
