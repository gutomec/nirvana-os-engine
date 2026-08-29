// entity-graph.ts — typed ESM face of entity-graph.js.
//
// The implementation moved to the CJS sibling so a `.js` caller
// (business-fixers.js) can `require()` it directly, without crossing the ESM
// boundary that only Windows' Bun enforces as a hard error for a `.ts` whose
// dependency chain carries a top-level await (require() of an ESM module
// throws "require() async module" there, and tolerates it on macOS/ubuntu).
// This file re-exports the same values, typed, for the many ESM importers
// that already reference `entity-graph.ts` by that path — an ESM `import` of
// a CJS module never crosses the broken boundary, on any platform. Mirrors
// brief-excerpt.ts/.js, log-paths.ts/.js and dependency-graph.ts/.js.
//
// The graph is ALWAYS derived: the org state lives in the files
// (business.yaml dirs, employees/*.md frontmatter, dna/ symlinks, squad.yaml
// dirs), and any persisted graph is a plan, never a second source of truth.
// This module is the one reader; scripts/check-clone-bindings.ts consumes
// readCloneBindings() for its gate, and the installer + `nrv graph` consume
// buildEntityGraph() for ordering and closure queries.
//
// The declaration-reading functions (slugOf, refToSlug, declaredBy, the dna/
// symlink scan) moved here verbatim from scripts/check-clone-bindings.ts —
// including the two regressions their comments record (the "missing AGENT"
// misread of dna_reference paths, and README.md counted as a clone).

import type { DependencyGraph, GraphEdge } from "./dependency-graph.ts";
import * as impl from "./entity-graph.js";

export interface EntityRoots {
  businessesDir: string;
  clonesDir: string;
  squadsDir?: string;
}

export interface CloneBinding {
  business: string;
  employee: string;
  clone: string;
  source: "employee" | "dna/";
  /** A symlink that no longer resolves — a binding that already broke. */
  dangling?: boolean;
}

export interface CloneBindingScan {
  bindings: CloneBinding[];
  businesses: string[];
  availableClones: Set<string>;
}

export interface SquadCompositionIssue {
  /** `x_requires_ambiguous`, `x_requires_unresolved`, `x_consumes_*`. */
  code: string;
  kind: "requires" | "consumes";
  reason: "ambiguous" | "unresolved";
  squad: string;
  capability: string;
  /** The declaration verbatim, prefix included. */
  ref: string;
  /** Provider slugs found, sorted; empty when nothing declares the ref. */
  candidates: string[];
}

export interface SquadCompositionScan {
  edges: GraphEdge[];
  issues: SquadCompositionIssue[];
}

/** In a pack the kinds sit side by side; live, they are separate roots. */
export const resolveRoots: (packDir?: string | null) => EntityRoots = impl.resolveRoots;

/** A ref in `assigned_mind_clones` may be category-prefixed
 *  (`21-media-moguls/jane-friedman`) or flat. The slug is the last segment. */
export const slugOf: (ref: string) => string = impl.slugOf;

/**
 * `dna_reference` is a different shape: a path INTO the clone, not to it —
 * `dna/michael-thaut-music-therapist/agent/AGENT.md`. Reading its last segment
 * yields `AGENT`, which is not a clone and never will be; the first pass of
 * the bindings gate reported six businesses "missing AGENT" for exactly that
 * reason. The clone is the directory that follows the library marker.
 */
export const refToSlug: (ref: string) => string | null = impl.refToSlug;

export const declaredBy: (employeeFile: string) => string[] = impl.declaredBy;

/**
 * Every clone binding declared by every business under the roots, in stable
 * scan order (business readdir order; employees before dna/; a dangling
 * symlink appears as an extra row right after its own binding). The caller
 * decides what "missing" means against availableClones.
 */
export const readCloneBindings: (roots: EntityRoots) => CloneBindingScan = impl.readCloneBindings;

/**
 * Squad Protocol v6 §31, read off disk. `capabilities[].requires[]` names
 * capability ids (optionally `slug:`-prefixed) and becomes a `depends_on`
 * edge consumer → provider; `capabilities[].consumes[]` names `produces`
 * slugs and becomes a `feeds` edge provider → consumer. Both go through
 * dependencyPair() as "the provider exists first".
 *
 * An edge is created ONLY when the provider is unambiguous. Across the
 * installed library a capability id and a `produces` slug are both free to
 * repeat, and picking one of two providers would invent an execution order
 * nobody declared — so two providers yield no edge and an
 * `x_requires_ambiguous` / `x_consumes_ambiguous` row, while none at all
 * yields `x_..._unresolved`. A reference the declaring squad satisfies itself
 * is neither: a self-edge would be a cycle, and an intra-squad reference is
 * not a gap.
 */
export const readSquadComposition: (roots: EntityRoots) => SquadCompositionScan = impl.readSquadComposition;

/**
 * The derived entity graph. Nodes: one `company` per business dir, one
 * `employee` per declaring employee, one `mind_clone` per referenced clone —
 * present or not (missing ones carry payload.missing = true) — and one
 * `squad` per squad dir. Edges: `owns` (company → employee), `embodies`
 * (employee → mind_clone; company → mind_clone for dna/ bindings) and the
 * squad → squad composition of readSquadComposition(). Dangling-symlink rows
 * do not add edges — the binding they duplicate is already in the graph.
 */
export const buildEntityGraph: (roots: EntityRoots) => DependencyGraph = impl.buildEntityGraph;

/**
 * Collapse the node-level dependency order to installer kind order. With the
 * edges this reader produces, the result is squads → mind-clones →
 * businesses: an employee embodies a clone, the employee ships inside the
 * business directory, therefore the business unit requires its clones on
 * disk first. Returns has_cycle so the installer can fall back to its legacy
 * literal order with a named warning instead of ever throwing mid-install.
 */
export const installKindOrder: (graph: DependencyGraph) => { order: string[]; has_cycle: boolean } = impl.installKindOrder;
