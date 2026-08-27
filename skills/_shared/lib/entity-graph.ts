// entity-graph.ts — build the typed dependency graph from the prose
// declarations that already exist on disk.
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

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  dependencyPair,
  type DependencyGraph,
  type GraphEdge,
  type GraphNode,
} from "./dependency-graph.ts";

export interface EntityRoots {
  businessesDir: string;
  clonesDir: string;
  squadsDir?: string;
}

/** In a pack the kinds sit side by side; live, they are separate roots. */
export function resolveRoots(packDir?: string | null): EntityRoots {
  const HOME = homedir();
  if (packDir) {
    return {
      businessesDir: join(packDir, "businesses"),
      clonesDir: join(packDir, "mind-clones"),
      squadsDir: join(packDir, "squads"),
    };
  }
  return {
    businessesDir: join(HOME, "businesses"),
    clonesDir: join(HOME, "businesses", "_library", "dna"),
    squadsDir: join(HOME, "squads"),
  };
}

/** A ref in `assigned_mind_clones` may be category-prefixed
 *  (`21-media-moguls/jane-friedman`) or flat. The slug is the last segment. */
export const slugOf = (ref: string) =>
  ref.lastIndexOf("/") === -1 ? ref : ref.slice(ref.lastIndexOf("/") + 1);

/**
 * `dna_reference` is a different shape: a path INTO the clone, not to it —
 * `dna/michael-thaut-music-therapist/agent/AGENT.md`. Reading its last segment
 * yields `AGENT`, which is not a clone and never will be; the first pass of
 * the bindings gate reported six businesses "missing AGENT" for exactly that
 * reason. The clone is the directory that follows the library marker.
 */
export function refToSlug(ref: string): string | null {
  const parts = ref.replace(/^\$\{?DNA_LIBRARY\}?\/?/, "").split("/").filter(Boolean);
  const i = parts.indexOf("dna");
  const slug = i >= 0 ? parts[i + 1] : parts[0];
  if (!slug || /\.(md|ya?ml|json)$/.test(slug)) return null;
  return slug;
}

export function declaredBy(employeeFile: string): string[] {
  const text = readFileSync(employeeFile, "utf8");
  const fm = text.match(/^---[\s\S]*?^---/m)?.[0] ?? "";
  const out: string[] = [];
  const list = fm.match(/^assigned_mind_clones\s*:\s*\n((?:[ \t]*-\s.+\n?)+)/m);
  if (list) {
    for (const line of list[1].split("\n")) {
      const s = line.replace(/^[ \t]*-\s*/, "").trim();
      if (s) out.push(slugOf(s));
    }
  }
  for (const m of fm.matchAll(/^dna_reference\s*:\s*(\S+)/gm)) {
    const slug = refToSlug(m[1]);
    if (slug) out.push(slug);
  }
  return out;
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

/**
 * Every clone binding declared by every business under the roots, in stable
 * scan order (business readdir order; employees before dna/; a dangling
 * symlink appears as an extra row right after its own binding). The caller
 * decides what "missing" means against availableClones.
 */
export function readCloneBindings(roots: EntityRoots): CloneBindingScan {
  const bindings: CloneBinding[] = [];
  const businesses: string[] = [];
  const availableClones = new Set<string>(
    existsSync(roots.clonesDir) ? readdirSync(roots.clonesDir) : []
  );

  for (const b of existsSync(roots.businessesDir) ? readdirSync(roots.businessesDir) : []) {
    if (b === "_library") continue;
    const dir = join(roots.businessesDir, b);
    if (!existsSync(join(dir, "business.yaml"))) continue;
    businesses.push(b);

    const empDir = join(dir, "employees");
    if (existsSync(empDir)) {
      for (const f of readdirSync(empDir).filter((x) => x.endsWith(".md"))) {
        for (const clone of declaredBy(join(empDir, f))) {
          bindings.push({ business: b, employee: f.replace(/\.md$/, ""), clone, source: "employee" });
        }
      }
    }

    // The symlink directory, where a business still has one. Only links and
    // directories are bindings: `medwork360/dna/` holds a README.md and
    // nothing else, which once counted as a clone named "README".
    const dnaDir = join(dir, "dna");
    if (existsSync(dnaDir)) {
      for (const e of readdirSync(dnaDir)) {
        let entry;
        try { entry = lstatSync(join(dnaDir, e)); } catch { continue; }
        if (!entry.isSymbolicLink() && !entry.isDirectory()) continue;
        const clone = e.replace(/\.md$/, "");
        bindings.push({ business: b, employee: "(business dna/)", clone, source: "dna/" });
        try {
          const p = join(dnaDir, e);
          if (lstatSync(p).isSymbolicLink() && !existsSync(p)) {
            bindings.push({ business: b, employee: "(business dna/)", clone, source: "dna/", dangling: true });
          }
        } catch { /* unreadable entry */ }
      }
    }
  }

  return { bindings, businesses, availableClones };
}

/** One capability's composition declarations, as read off a squad.yaml. */
interface DeclaredCapability {
  squad: string;
  id: string;
  produces: string[];
  requires: string[];
  consumes: string[];
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

/** `produces` slugs are authored prose, so they match on case and padding. */
const producesKey = (slug: string) => slug.trim().toLowerCase();

function readDeclaredCapabilities(squadsDir: string): DeclaredCapability[] {
  const out: DeclaredCapability[] = [];
  for (const slug of readdirSync(squadsDir).sort()) {
    const manifest = join(squadsDir, slug, "squad.yaml");
    if (!existsSync(manifest)) continue;
    let doc: unknown;
    // A manifest that does not parse costs the graph nothing. Before v6 this
    // reader only asked whether the file existed, and a squad nobody can read
    // must not start breaking an install order it never took part in.
    try { doc = parseYaml(readFileSync(manifest, "utf8")); } catch { continue; }
    const caps = (doc as { capabilities?: unknown } | null)?.capabilities;
    if (!Array.isArray(caps)) continue;
    for (const cap of caps) {
      if (!cap || typeof cap !== "object") continue;
      const c = cap as Record<string, unknown>;
      if (typeof c.id !== "string") continue;
      const list = (key: string) =>
        Array.isArray(c[key]) ? (c[key] as unknown[]).filter((v): v is string => typeof v === "string") : [];
      out.push({
        squad: slug,
        id: c.id,
        produces: list("produces"),
        requires: list("requires"),
        consumes: list("consumes"),
      });
    }
  }
  return out;
}

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
export function readSquadComposition(roots: EntityRoots): SquadCompositionScan {
  const edges: GraphEdge[] = [];
  const issues: SquadCompositionIssue[] = [];
  if (!roots.squadsDir || !existsSync(roots.squadsDir)) return { edges, issues };

  const declared = readDeclaredCapabilities(roots.squadsDir);
  const byCapability = new Map<string, Set<string>>();
  const byProduces = new Map<string, Set<string>>();
  const index = (map: Map<string, Set<string>>, key: string, slug: string) => {
    const set = map.get(key) ?? new Set<string>();
    set.add(slug);
    map.set(key, set);
  };
  for (const cap of declared) {
    index(byCapability, cap.id, cap.squad);
    for (const p of cap.produces) index(byProduces, producesKey(p), cap.squad);
  }

  const seen = new Set<string>();
  const link = (type: "depends_on" | "feeds", consumer: string, provider: string) => {
    const edge: GraphEdge = type === "depends_on"
      ? { id: `depends_on:${consumer}->${provider}`, source: `squad:${consumer}`, target: `squad:${provider}`, type }
      : { id: `feeds:${provider}->${consumer}`, source: `squad:${provider}`, target: `squad:${consumer}`, type };
    if (seen.has(edge.id)) return;
    seen.add(edge.id);
    edges.push(edge);
  };
  const report = (
    kind: SquadCompositionIssue["kind"],
    reason: SquadCompositionIssue["reason"],
    cap: DeclaredCapability,
    ref: string,
    candidates: string[]
  ) => issues.push({ code: `x_${kind}_${reason}`, kind, reason, squad: cap.squad, capability: cap.id, ref, candidates });

  const providesItself = (slug: string, id: string) => byCapability.get(id)?.has(slug) ?? false;

  for (const cap of declared) {
    for (const ref of cap.requires) {
      const sep = ref.indexOf(":");
      const explicit = sep === -1 ? null : ref.slice(0, sep);
      const id = sep === -1 ? ref : ref.slice(sep + 1);
      const providers = [...(byCapability.get(id) ?? [])].filter((s) => s !== cap.squad).sort();
      const resolved = explicit
        ? (providesItself(explicit, id) ? explicit : null)
        : (providers.length === 1 ? providers[0] : null);
      if (resolved && resolved !== cap.squad) link("depends_on", cap.squad, resolved);
      else if (resolved) continue;
      else if (!explicit && providers.length > 1) report("requires", "ambiguous", cap, ref, providers);
      else if (!explicit && providesItself(cap.squad, id)) continue;
      else report("requires", "unresolved", cap, ref, []);
    }
    for (const slug of cap.consumes) {
      const key = producesKey(slug);
      const providers = [...(byProduces.get(key) ?? [])].filter((s) => s !== cap.squad).sort();
      if (providers.length === 1) link("feeds", cap.squad, providers[0]);
      else if (providers.length > 1) report("consumes", "ambiguous", cap, slug, providers);
      else if (!byProduces.get(key)?.has(cap.squad)) report("consumes", "unresolved", cap, slug, []);
    }
  }
  return { edges, issues };
}

/**
 * The derived entity graph. Nodes: one `company` per business dir, one
 * `employee` per declaring employee, one `mind_clone` per referenced clone —
 * present or not (missing ones carry payload.missing = true) — and one
 * `squad` per squad dir. Edges: `owns` (company → employee), `embodies`
 * (employee → mind_clone; company → mind_clone for dna/ bindings) and the
 * squad → squad composition of readSquadComposition(). Dangling-symlink rows
 * do not add edges — the binding they duplicate is already in the graph.
 */
export function buildEntityGraph(roots: EntityRoots): DependencyGraph {
  const scan = readCloneBindings(roots);
  const nodes: GraphNode[] = [];
  const edges: DependencyGraph["edges"] = [];
  const seen = new Set<string>();

  const pushNode = (n: GraphNode) => {
    if (!seen.has(n.id)) { seen.add(n.id); nodes.push(n); }
  };

  for (const b of scan.businesses) {
    pushNode({ id: `business:${b}`, type: "company", payload: { slug: b } });
  }
  for (const bind of scan.bindings) {
    if (bind.dangling) continue;
    const cloneId = `clone:${bind.clone}`;
    pushNode({
      id: cloneId,
      type: "mind_clone",
      payload: { slug: bind.clone, missing: !scan.availableClones.has(bind.clone) },
    });
    if (bind.source === "employee") {
      const empId = `employee:${bind.business}/${bind.employee}`;
      pushNode({ id: empId, type: "employee", payload: { business: bind.business, slug: bind.employee } });
      const ownId = `owns:${bind.business}/${bind.employee}`;
      if (!seen.has(ownId)) {
        seen.add(ownId);
        edges.push({ id: ownId, source: `business:${bind.business}`, target: empId, type: "owns" });
      }
      const embId = `embodies:${bind.business}/${bind.employee}->${bind.clone}`;
      if (!seen.has(embId)) {
        seen.add(embId);
        edges.push({ id: embId, source: empId, target: cloneId, type: "embodies" });
      }
    } else {
      const embId = `embodies:${bind.business}->${bind.clone}`;
      if (!seen.has(embId)) {
        seen.add(embId);
        edges.push({ id: embId, source: `business:${bind.business}`, target: cloneId, type: "embodies" });
      }
    }
  }
  if (roots.squadsDir && existsSync(roots.squadsDir)) {
    for (const s of readdirSync(roots.squadsDir)) {
      if (existsSync(join(roots.squadsDir, s, "squad.yaml"))) {
        pushNode({ id: `squad:${s}`, type: "squad", payload: { slug: s } });
      }
    }
    edges.push(...readSquadComposition(roots).edges);
  }
  return { nodes, edges };
}

/**
 * Collapse the node-level dependency order to installer kind order. With the
 * edges this reader produces, the result is squads → mind-clones →
 * businesses: an employee embodies a clone, the employee ships inside the
 * business directory, therefore the business unit requires its clones on
 * disk first. Returns has_cycle so the installer can fall back to its legacy
 * literal order with a named warning instead of ever throwing mid-install.
 */
export function installKindOrder(graph: DependencyGraph): { order: string[]; has_cycle: boolean } {
  const LEGACY = ["squads", "businesses", "mind-clones"];
  const kindOf = (id: string): string | null => {
    const n = graph.nodes.find((x) => x.id === id);
    if (!n) return null;
    if (n.type === "squad") return "squads";
    if (n.type === "mind_clone") return "mind-clones";
    if (n.type === "company" || n.type === "employee") return "businesses";
    return null;
  };
  // kind-level dependency edges from node-level pairs
  const deps = new Map<string, Set<string>>([
    ["squads", new Set()], ["mind-clones", new Set()], ["businesses", new Set()],
  ]);
  for (const e of graph.edges) {
    const [before, after] = dependencyPair(e);
    const kb = kindOf(before), ka = kindOf(after);
    if (kb && ka && kb !== ka) deps.get(ka)?.add(kb);
  }
  const order: string[] = [];
  const placed = new Set<string>();
  for (let i = 0; i < 3; i++) {
    for (const k of ["squads", "mind-clones", "businesses"]) {
      if (placed.has(k)) continue;
      if ([...(deps.get(k) ?? [])].every((d) => placed.has(d))) {
        placed.add(k);
        order.push(k);
      }
    }
  }
  if (order.length !== 3) return { order: LEGACY, has_cycle: true };
  return { order, has_cycle: false };
}
