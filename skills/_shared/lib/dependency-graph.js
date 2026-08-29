/**
 * dependency-graph.js — CommonJS implementation of the dependency-graph
 * algebra for Nirvana entities. dependency-graph.ts re-exports this file,
 * typed, so every ESM importer keeps working unchanged (mirrors
 * brief-excerpt.js/.ts and log-paths.js/.ts).
 *
 * Moved here so a `.js` caller (business-fixers.js, via entity-graph.js) can
 * `require()` it — directly or transitively — without crossing the CJS/ESM
 * boundary that only Windows' Bun enforces as a hard error for a `.ts`
 * (require() of an ESM module throws "require() async module" there, and
 * tolerates it on macOS/ubuntu).
 *
 * Derived from PR #41 (skills/studio/lib/graph-store.ts) by @marciobisognin:
 * the pure graph algebra extracted verbatim where possible; persistence and
 * canvas concerns (schema_version, graph names, positions, node status, the
 * studio store) removed. The domain vocabulary is the engine's own, written
 * down for the first time: a company owns employees, an employee embodies a
 * mind-clone, a squad covers a company — with a compatibility table saying
 * which edges are legal, a cycle check saying which graphs are not, and a
 * topological order that is, without modification, install order.
 *
 * An `agent` node is a role executed by the runtime's generalist (agent-x):
 * its id is the role name, a free slug that exists in no registry. It is
 * briefed, depends and yields like a squad.
 *
 * The load-bearing subtlety is dependencyPair(): for the edge types
 * `depends_on`, `staffs` and `embodies` the BUILD direction is the reverse of
 * the drawn direction — `employee embodies mind_clone` means the clone must
 * exist first. Every ordering function in this file goes through it.
 *
 * Cycle policy (differs from PR #41 deliberately): buildOrder() returns
 * cycles AS DATA ({ has_cycle, cycle_nodes }) following the precedent of
 * skills/harness/lib/dag-planner.ts, because installer callers must degrade
 * gracefully, never stack-trace during a buyer's `nrv update`. Interactive
 * validation keeps throwing (addEdge with checkCycles), and
 * buildOrderOrThrow() preserves the PR #41 semantics for callers that want it.
 *
 * Pure module: no fs, no env, no engine imports. Safe to require from any
 * script without side effects.
 */

'use strict';

const NODE_TYPES = ["brief", "company", "squad", "mind_clone", "employee", "material", "deliverable", "agent"];
const EDGE_TYPES = ["briefs", "owns", "staffs", "embodies", "covers", "feeds", "depends_on", "yields"];

function emptyGraph() {
  return { nodes: [], edges: [] };
}

/** Protocol table: which edge types may connect which node types. */
function isCompatibleEdge(type, from, to) {
  switch (type) {
    case "briefs": return from === "brief" && ["company", "squad", "mind_clone", "agent"].includes(to);
    case "owns": return from === "company" && to === "employee";
    case "staffs": return from === "employee" && to === "squad";
    case "embodies": return ["employee", "company"].includes(from) && to === "mind_clone";
    case "covers": return from === "squad" && to === "company";
    // A squad is a legal `feeds` source since Squad Protocol v6 §31: a
    // capability's `consumes[]` names a `produces` slug, and what produces it
    // is another squad, not a material.
    case "feeds": return ["material", "squad"].includes(from) && ["mind_clone", "company", "squad"].includes(to);
    case "depends_on": return true;
    case "yields": return ["company", "squad", "agent"].includes(from) && to === "deliverable";
  }
}

/**
 * Returns [node that must exist first, node that comes after]. For
 * `depends_on`, `staffs` and `embodies` the dependency direction is the
 * REVERSE of the drawn direction: `employee embodies mind_clone` yields
 * [mind_clone, employee] — the clone installs first.
 */
function dependencyPair(edge) {
  return ["depends_on", "staffs", "embodies"].includes(edge.type)
    ? [edge.target, edge.source]
    : [edge.source, edge.target];
}

function canReach(edges, from, to) {
  const adj = new Map();
  for (const e of edges) {
    const [before, after] = dependencyPair(e);
    const list = adj.get(before) ?? [];
    list.push(after);
    adj.set(before, list);
  }
  const visited = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === to) return true;
    for (const next of adj.get(cur) ?? []) {
      if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
  }
  return false;
}

function addNode(graph, node) {
  if (graph.nodes.some((n) => n.id === node.id)) {
    throw new Error(`node id already exists: ${node.id}`);
  }
  graph.nodes.push(node);
}

/** Add an edge after type-compatibility and cycle checks (throws on invalid). */
function addEdge(graph, edge, opts = {}) {
  const { checkCycles = true } = opts;
  const src = graph.nodes.find((n) => n.id === edge.source);
  const tgt = graph.nodes.find((n) => n.id === edge.target);
  if (!src) throw new Error(`source node not found: ${edge.source}`);
  if (!tgt) throw new Error(`target node not found: ${edge.target}`);
  if (!isCompatibleEdge(edge.type, src.type, tgt.type)) {
    throw new Error(`edge type "${edge.type}" not allowed from ${src.type} to ${tgt.type}`);
  }
  if (graph.edges.some((e) => e.source === edge.source && e.target === edge.target && e.type === edge.type)) {
    throw new Error("edge already exists");
  }
  if (checkCycles) {
    const tentative = [...graph.edges, edge];
    const [before, after] = dependencyPair(edge);
    if (canReach(tentative, after, before)) {
      throw new Error("adding this edge would create a cycle");
    }
  }
  graph.edges.push(edge);
}

/** Topological order over effective creation dependencies; cycles as data. */
function buildOrder(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const inDeg = new Map();
  const adj = new Map();
  for (const n of graph.nodes) {
    inDeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of graph.edges) {
    const [before, after] = dependencyPair(e);
    if (!byId.has(before) || !byId.has(after)) continue;
    adj.get(before).push(after);
    inDeg.set(after, inDeg.get(after) + 1);
  }
  const queue = graph.nodes.filter((n) => inDeg.get(n.id) === 0).map((n) => n.id).sort();
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(byId.get(id));
    for (const next of adj.get(id).sort()) {
      const d = inDeg.get(next) - 1;
      inDeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  const has_cycle = order.length !== graph.nodes.length;
  const placed = new Set(order.map((n) => n.id));
  return {
    order,
    has_cycle,
    cycle_nodes: has_cycle ? graph.nodes.filter((n) => !placed.has(n.id)).map((n) => n.id) : [],
  };
}

/** PR #41 semantics: throws when the graph contains a dependency cycle. */
function buildOrderOrThrow(graph) {
  const r = buildOrder(graph);
  if (r.has_cycle) {
    throw new Error("graph contains a dependency cycle (topological sort incomplete)");
  }
  return r.order;
}

/** Every built-able node needs a brief upstream (transitively). */
function reachableFromBriefs(graph) {
  const briefIds = new Set(graph.nodes.filter((n) => n.type === "brief").map((n) => n.id));
  const adj = new Map();
  for (const e of graph.edges) {
    if (["briefs", "owns", "feeds", "yields"].includes(e.type)) {
      const list = adj.get(e.source) ?? [];
      list.push(e.target);
      adj.set(e.source, list);
    }
  }
  const visited = new Set(briefIds);
  const queue = [...briefIds];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of adj.get(cur) ?? []) {
      if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
  }
  return visited;
}

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
function closure(graph, rootIds) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const inSet = new Set(rootIds.filter((id) => byId.has(id)));
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of graph.edges) {
      if (e.type === "owns" && inSet.has(e.source) && !inSet.has(e.target)) {
        inSet.add(e.target);
        grew = true;
      }
      const [before, after] = dependencyPair(e);
      if (inSet.has(after) && !inSet.has(before) && byId.has(before)) {
        inSet.add(before);
        grew = true;
      }
    }
  }
  return {
    nodes: graph.nodes.filter((n) => inSet.has(n.id)),
    edges: graph.edges.filter((e) => inSet.has(e.source) && inSet.has(e.target)),
  };
}

function nodesByType(graph, type) {
  return graph.nodes.filter((n) => n.type === type);
}

function inboundEdges(graph, nodeId) {
  return graph.edges.filter((e) => e.target === nodeId);
}

function outboundEdges(graph, nodeId) {
  return graph.edges.filter((e) => e.source === nodeId);
}

/**
 * Structural validation of a hand-authored graph document. The persistence
 * checks of PR #41 (schema_version, slug names, positions, status) stay in
 * Studio where they belong; here a graph is its nodes and edges. A cycle is
 * reported as an issue, never thrown.
 */
function validateGraph(graph) {
  const issues = [];
  const g = graph;
  if (!g || typeof g !== "object") return [{ path: "/", message: "graph must be an object" }];
  if (!Array.isArray(g.nodes)) issues.push({ path: "/nodes", message: "must be an array" });
  if (!Array.isArray(g.edges)) issues.push({ path: "/edges", message: "must be an array" });
  if (issues.length) return issues;

  const ids = new Set();
  for (const [i, n] of g.nodes.entries()) {
    const p = `/nodes/${i}`;
    if (typeof n.id !== "string" || n.id.length < 3) issues.push({ path: `${p}/id`, message: "invalid id" });
    if (!NODE_TYPES.includes(n.type)) issues.push({ path: `${p}/type`, message: "unknown node type" });
    if (ids.has(n.id)) issues.push({ path: `${p}/id`, message: "duplicate node id" });
    ids.add(n.id);
  }
  for (const [i, e] of g.edges.entries()) {
    const p = `/edges/${i}`;
    if (typeof e.id !== "string" || e.id.length < 1) issues.push({ path: `${p}/id`, message: "invalid id" });
    if (!ids.has(e.source)) issues.push({ path: `${p}/source`, message: `unknown node "${e.source}"` });
    if (!ids.has(e.target)) issues.push({ path: `${p}/target`, message: `unknown node "${e.target}"` });
    if (!EDGE_TYPES.includes(e.type)) issues.push({ path: `${p}/type`, message: "unknown edge type" });
    const source = g.nodes.find((n) => n.id === e.source);
    const target = g.nodes.find((n) => n.id === e.target);
    if (source && target && EDGE_TYPES.includes(e.type) && !isCompatibleEdge(e.type, source.type, target.type)) {
      issues.push({ path: `${p}/type`, message: `edge type "${e.type}" is not allowed from ${source.type} to ${target.type}` });
    }
  }
  if (issues.length === 0) {
    const r = buildOrder(g);
    if (r.has_cycle) {
      issues.push({ path: "/edges", message: `graph contains a dependency cycle (${r.cycle_nodes.join(", ")})` });
    }
  }
  return issues;
}

/**
 * Bridge to the orchestration planner: one DagNode per graph node, deps
 * computed from dependencyPair over every edge. Feed the result to
 * planDag() from skills/harness/lib/dag-planner.ts for wave layering.
 */
function toDagNodes(graph, opts = {}) {
  const deps = new Map(graph.nodes.map((n) => [n.id, new Set()]));
  for (const e of graph.edges) {
    const [before, after] = dependencyPair(e);
    deps.get(after)?.add(before);
  }
  return graph.nodes.map((n) => ({
    id: n.id,
    deps: [...(deps.get(n.id) ?? [])].sort(),
    ...(opts.parallelSafe ? { parallel_safe: opts.parallelSafe(n) } : {}),
  }));
}

module.exports = {
  emptyGraph,
  isCompatibleEdge,
  dependencyPair,
  addNode,
  addEdge,
  buildOrder,
  buildOrderOrThrow,
  reachableFromBriefs,
  closure,
  nodesByType,
  inboundEdges,
  outboundEdges,
  validateGraph,
  toDagNodes,
};
