// dependency-graph.ts — typed ESM face of dependency-graph.js.
//
// The implementation moved to the CJS sibling so a `.js` caller
// (business-fixers.js, via entity-graph.js) can `require()` it — directly or
// transitively — without crossing the ESM boundary that only Windows' Bun
// enforces as a hard error (require() of an ESM module throws "require()
// async module" there, and tolerates it on macOS/ubuntu). This file
// re-exports the same values, typed, for the many ESM importers that already
// reference `dependency-graph.ts` by that path — an ESM `import` of a CJS
// module never crosses the broken boundary, on any platform. Mirrors
// brief-excerpt.ts/.js and log-paths.ts/.js.
//
// Derived from PR #41 (skills/studio/lib/graph-store.ts) by @marciobisognin:
// the pure graph algebra extracted verbatim where possible; persistence and
// canvas concerns (schema_version, graph names, positions, node status, the
// studio store) removed. The domain vocabulary is the engine's own, written
// down for the first time: a company owns employees, an employee embodies a
// mind-clone, a squad covers a company — with a compatibility table saying
// which edges are legal, a cycle check saying which graphs are not, and a
// topological order that is, without modification, install order.
//
// An `agent` node is a role executed by the runtime's generalist (agent-x):
// its id is the role name, a free slug that exists in no registry. It is
// briefed, depends and yields like a squad.
//
// The load-bearing subtlety is dependencyPair(): for the edge types
// `depends_on`, `staffs` and `embodies` the BUILD direction is the reverse of
// the drawn direction — `employee embodies mind_clone` means the clone must
// exist first. Every ordering function in this file goes through it.
//
// Cycle policy (differs from PR #41 deliberately): buildOrder() returns
// cycles AS DATA ({ has_cycle, cycle_nodes }) following the precedent of
// skills/harness/lib/dag-planner.ts, because installer callers must degrade
// gracefully, never stack-trace during a buyer's `nrv update`. Interactive
// validation keeps throwing (addEdge with checkCycles), and
// buildOrderOrThrow() preserves the PR #41 semantics for callers that want it.
//
// Pure module: no fs, no env, no engine imports beyond dag-planner's DagNode
// type. Safe to import from any script without side effects.

import type { DagNode } from "../../harness/lib/dag-planner.ts";
import * as impl from "./dependency-graph.js";

export type NodeType =
  | "brief" | "company" | "squad" | "mind_clone" | "employee" | "material" | "deliverable" | "agent";
export type EdgeType =
  | "briefs" | "owns" | "staffs" | "embodies" | "covers" | "feeds" | "depends_on" | "yields";

export interface GraphNode {
  id: string;
  type: NodeType;
  payload?: Record<string, unknown>;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  meta?: Record<string, unknown>;
}
export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface OrderResult {
  order: GraphNode[];
  has_cycle: boolean;
  cycle_nodes: string[];
}

export interface GraphIssue { path: string; message: string }

export const emptyGraph: () => DependencyGraph = impl.emptyGraph;

/** Protocol table: which edge types may connect which node types. */
export const isCompatibleEdge: (type: EdgeType, from: NodeType, to: NodeType) => boolean = impl.isCompatibleEdge;

/**
 * Returns [node that must exist first, node that comes after]. For
 * `depends_on`, `staffs` and `embodies` the dependency direction is the
 * REVERSE of the drawn direction: `employee embodies mind_clone` yields
 * [mind_clone, employee] — the clone installs first.
 */
export const dependencyPair: (edge: GraphEdge) => [before: string, after: string] = impl.dependencyPair;

export const addNode: (graph: DependencyGraph, node: GraphNode) => void = impl.addNode;

/** Add an edge after type-compatibility and cycle checks (throws on invalid). */
export const addEdge: (graph: DependencyGraph, edge: GraphEdge, opts?: { checkCycles?: boolean }) => void = impl.addEdge;

/** Topological order over effective creation dependencies; cycles as data. */
export const buildOrder: (graph: DependencyGraph) => OrderResult = impl.buildOrder;

/** PR #41 semantics: throws when the graph contains a dependency cycle. */
export const buildOrderOrThrow: (graph: DependencyGraph) => GraphNode[] = impl.buildOrderOrThrow;

/** Every built-able node needs a brief upstream (transitively). */
export const reachableFromBriefs: (graph: DependencyGraph) => Set<string> = impl.reachableFromBriefs;

/**
 * The dispatch-facing primitive: everything that must exist for these roots
 * to run. Two expansions to a fixed point, starting from rootIds:
 *   - membership: follow outbound `owns` edges (a company brings its
 *     employees);
 *   - requirements: for every member, pull in each node that must exist
 *     before it (the `before` of dependencyPair — clones via `embodies`,
 *     squads via `staffs`, anything via `depends_on`).
 * Unknown root ids are ignored (callers report them from their own context).
 */
export const closure: (graph: DependencyGraph, rootIds: string[]) => { nodes: GraphNode[]; edges: GraphEdge[] } = impl.closure;

export const nodesByType: (graph: DependencyGraph, type: NodeType) => GraphNode[] = impl.nodesByType;

export const inboundEdges: (graph: DependencyGraph, nodeId: string) => GraphEdge[] = impl.inboundEdges;

export const outboundEdges: (graph: DependencyGraph, nodeId: string) => GraphEdge[] = impl.outboundEdges;

/**
 * Structural validation of a hand-authored graph document. The persistence
 * checks of PR #41 (schema_version, slug names, positions, status) stay in
 * Studio where they belong; here a graph is its nodes and edges. A cycle is
 * reported as an issue, never thrown.
 */
export const validateGraph: (graph: unknown) => GraphIssue[] = impl.validateGraph;

/**
 * Bridge to the orchestration planner: one DagNode per graph node, deps
 * computed from dependencyPair over every edge. Feed the result to
 * planDag() from skills/harness/lib/dag-planner.ts for wave layering.
 */
export const toDagNodes: (
  graph: DependencyGraph,
  opts?: { parallelSafe?: (n: GraphNode) => boolean }
) => DagNode[] = impl.toDagNodes;
