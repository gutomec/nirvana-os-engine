// graph-store.ts — persistence layer for Studio Protocol v1 graphs.
//
// Storage: ~/.nirvana/studio/graphs/<slug>.json (global) or
// <project>/.nirvana/studio/graphs/<slug>.json when NIRVANA_SCOPE=project.
// This module owns ONLY its own directory: it never touches the business or
// squad registries, the audit log, or any file outside the studio store.
//
// Bun-only runtime (top-level await, Bun.file).

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const STUDIO_SCHEMA_VERSION = "1.0.0";
export const GRAPH_NAME_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

export type NodeType = "brief" | "company" | "squad" | "mind_clone" | "employee" | "material" | "deliverable";
export type EdgeType = "briefs" | "owns" | "staffs" | "embodies" | "covers" | "feeds" | "depends_on" | "yields";
export type NodeStatus = "draft" | "queued" | "building" | "built" | "failed";

export interface Position { x: number; y: number }
export interface StudioNode {
  id: string;
  type: NodeType;
  position: Position;
  status?: NodeStatus;
  payload: Record<string, unknown>;
  meta?: Record<string, unknown>;
  built_at?: string;
  artifact_path?: string;
  error?: string;
}
export interface StudioEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  meta?: Record<string, unknown>;
}
export interface StudioGraph {
  schema_version: string;
  name: string;
  created_at?: string;
  updated_at?: string;
  canvas?: { x?: number; y?: number; zoom?: number };
  nodes: StudioNode[];
  edges: StudioEdge[];
}

// ── paths ───────────────────────────────────────────────────────────────────

export interface ScopeResult { scope: "global" | "project"; root: string }

export function resolveStudioScope(cwd: string = process.cwd()): ScopeResult {
  const scopeEnv = (process.env.NIRVANA_SCOPE ?? "global").toLowerCase();
  if (scopeEnv === "project" || scopeEnv === "merge") {
    // walk up from cwd looking for .nirvana/ or a project marker
    let dir = resolve(cwd);
    const stopAt = sep === "/" ? "/" : "";
    while (dir && dir !== stopAt) {
      if (existsSync(join(dir, ".nirvana")) || existsSync(join(dir, ".git")) || existsSync(join(dir, "package.json"))) {
        return { scope: "project", root: dir };
      }
      dir = dirname(dir);
    }
  }
  return { scope: "global", root: process.env.HOME ?? "/tmp" };
}

export function studioStoreDir(cwd: string = process.cwd()): string {
  const { root } = resolveStudioScope(cwd);
  return join(root, ".nirvana", "studio", "graphs");
}

export function graphPath(slug: string, cwd: string = process.cwd()): string {
  const dir = studioStoreDir(cwd);
  if (!GRAPH_NAME_RE.test(slug)) {
    throw new Error("graph name must be a lowercase slug (a-z, 0-9, hyphen; max 60 characters)");
  }
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${slug}.json`);
  const root = `${resolve(dir)}${sep}`;
  if (!file.startsWith(root)) throw new Error("graph path escapes the Studio store");
  return file;
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export function newGraph(name: string, cwd: string = process.cwd()): StudioGraph {
  const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "studio-graph";
  const now = new Date().toISOString();
  return {
    schema_version: STUDIO_SCHEMA_VERSION,
    name: safe,
    created_at: now,
    updated_at: now,
    canvas: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  };
}

export function saveGraph(graph: StudioGraph, cwd: string = process.cwd()): string {
  const file = graphPath(graph.name, cwd);
  graph.updated_at = new Date().toISOString();
  writeFileSync(file, JSON.stringify(graph, null, 2) + "\n");
  return file;
}

export function loadGraph(name: string, cwd: string = process.cwd()): StudioGraph | null {
  const file = graphPath(name, cwd);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as StudioGraph;
  if (parsed.schema_version !== STUDIO_SCHEMA_VERSION) return null;
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
  return parsed;
}

export function listGraphs(cwd: string = process.cwd()): string[] {
  const dir = studioStoreDir(cwd);
  mkdirSync(dir, { recursive: true });
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && GRAPH_NAME_RE.test(f.replace(/\.json$/, "")))
    .map((f) => f.replace(/\.json$/, ""));
}

export function deleteGraph(name: string, cwd: string = process.cwd()): boolean {
  const file = graphPath(name, cwd);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

// ── structural validation (schema-level, before protocol rules) ─────────────

const NODE_TYPES: NodeType[] = ["brief", "company", "squad", "mind_clone", "employee", "material", "deliverable"];
const EDGE_TYPES: EdgeType[] = ["briefs", "owns", "staffs", "embodies", "covers", "feeds", "depends_on", "yields"];
const STATUS_OK: NodeStatus[] = ["draft", "queued", "building", "built", "failed"];

export interface ValidationError { path: string; message: string }

export function validateGraphStructure(graph: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  const g = graph as Partial<StudioGraph> | null | undefined;
  if (!g || typeof g !== "object") return [{ path: "/", message: "graph must be an object" }];
  if (g.schema_version !== STUDIO_SCHEMA_VERSION) {
    errors.push({ path: "/schema_version", message: `must be "${STUDIO_SCHEMA_VERSION}"` });
  }
  if (typeof g.name !== "string" || !GRAPH_NAME_RE.test(g.name)) {
    errors.push({ path: "/name", message: "name must be a lowercase slug (a-z, 0-9, hyphen; max 60 characters)" });
  }
  if (!Array.isArray(g.nodes)) errors.push({ path: "/nodes", message: "must be an array" });
  if (!Array.isArray(g.edges)) errors.push({ path: "/edges", message: "must be an array" });
  if (errors.length) return errors;

  const ids = new Set<string>();
  for (const [i, n] of (g.nodes as StudioNode[]).entries()) {
    const p = `/nodes/${i}`;
    if (typeof n.id !== "string" || n.id.length < 3) errors.push({ path: `${p}/id`, message: "invalid id" });
    if (!NODE_TYPES.includes(n.type as NodeType)) errors.push({ path: `${p}/type`, message: "unknown node type" });
    if (!n.position || typeof n.position.x !== "number" || typeof n.position.y !== "number") {
      errors.push({ path: `${p}/position`, message: "position {x,y} required" });
    }
    if (n.status !== undefined && !STATUS_OK.includes(n.status)) {
      errors.push({ path: `${p}/status`, message: "unknown status" });
    }
    if (!n.payload || typeof n.payload !== "object") errors.push({ path: `${p}/payload`, message: "payload object required" });
    if (ids.has(n.id)) errors.push({ path: `${p}/id`, message: "duplicate node id" });
    ids.add(n.id);
  }

  for (const [i, e] of (g.edges as StudioEdge[]).entries()) {
    const p = `/edges/${i}`;
    if (typeof e.id !== "string" || e.id.length < 3) errors.push({ path: `${p}/id`, message: "invalid id" });
    if (!ids.has(e.source)) errors.push({ path: `${p}/source`, message: `unknown node "${e.source}"` });
    if (!ids.has(e.target)) errors.push({ path: `${p}/target`, message: `unknown node "${e.target}"` });
    if (!EDGE_TYPES.includes(e.type as EdgeType)) errors.push({ path: `${p}/type`, message: "unknown edge type" });
    const source = (g.nodes as StudioNode[]).find((n) => n.id === e.source);
    const target = (g.nodes as StudioNode[]).find((n) => n.id === e.target);
    if (source && target && EDGE_TYPES.includes(e.type as EdgeType) && !isCompatibleEdge(e.type as EdgeType, source.type, target.type)) {
      errors.push({ path: `${p}/type`, message: `edge type "${e.type}" is not allowed from ${source.type} to ${target.type}` });
    }
  }
  if (errors.length === 0) {
    try {
      buildOrder(g as StudioGraph);
    } catch (err) {
      errors.push({ path: "/edges", message: err instanceof Error ? err.message : "graph contains a dependency cycle" });
    }
  }
  return errors;
}

// ── graph-level convenience ─────────────────────────────────────────────────

export function nodesByType(graph: StudioGraph, type: NodeType): StudioNode[] {
  return graph.nodes.filter((n) => n.type === type);
}

export function inboundEdges(graph: StudioGraph, nodeId: string): StudioEdge[] {
  return graph.edges.filter((e) => e.target === nodeId);
}

export function outboundEdges(graph: StudioGraph, nodeId: string): StudioEdge[] {
  return graph.edges.filter((e) => e.source === nodeId);
}

export function addNode(graph: StudioGraph, node: StudioNode): void {
  if (graph.nodes.some((n) => n.id === node.id)) {
    throw new Error(`node id already exists: ${node.id}`);
  }
  graph.nodes.push(node);
}

/** Add an edge after type-compatibility and cycle checks (throws on invalid). */
export function addEdge(graph: StudioGraph, edge: StudioEdge, opts: { checkCycles?: boolean } = {}): void {
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
    // A cycle is evaluated over dependency direction, which intentionally
    // reverses `depends_on`, `staffs`, and `embodies` relative to the canvas.
    const tentative = [...graph.edges, edge];
    const [before, after] = dependencyPair(edge);
    if (canReach(tentative, after, before)) {
      throw new Error("adding this edge would create a cycle");
    }
  }
  graph.edges.push(edge);
}

/** Protocol table: which edge types may connect which node types. */
export function isCompatibleEdge(type: EdgeType, from: NodeType, to: NodeType): boolean {
  switch (type) {
    case "briefs": return from === "brief" && ["company", "squad", "mind_clone"].includes(to);
    case "owns": return from === "company" && to === "employee";
    case "staffs": return from === "employee" && to === "squad";
    case "embodies": return ["employee", "company"].includes(from) && to === "mind_clone";
    case "covers": return from === "squad" && to === "company";
    case "feeds": return from === "material" && ["mind_clone", "company", "squad"].includes(to);
    case "depends_on": return true;
    case "yields": return ["company", "squad"].includes(from) && to === "deliverable";
  }
}

/** Returns [node that must be built first, node built afterwards]. */
function dependencyPair(edge: StudioEdge): [string, string] {
  return ["depends_on", "staffs", "embodies"].includes(edge.type)
    ? [edge.target, edge.source]
    : [edge.source, edge.target];
}

function canReach(edges: StudioEdge[], from: string, to: string): boolean {
  // BFS over effective build-dependency direction.
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const [before, after] = dependencyPair(e);
    const list = adj.get(before) ?? [];
    list.push(after);
    adj.set(before, list);
  }
  const visited = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === to) return true;
    for (const next of adj.get(cur) ?? []) {
      if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
  }
  return false;
}

/** Build order: topological sort over effective creation dependencies. */
export function buildOrder(graph: StudioGraph): StudioNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) {
    inDeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of graph.edges) {
    const [before, after] = dependencyPair(e);
    adj.get(before)!.push(after);
    inDeg.set(after, inDeg.get(after)! + 1);
  }
  const queue = graph.nodes.filter((n) => inDeg.get(n.id) === 0).map((n) => n.id);
  const result: StudioNode[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    const node = byId.get(id)!;
    result.push(node);
    for (const next of adj.get(id)!) {
      const d = inDeg.get(next)! - 1;
      inDeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (result.length !== graph.nodes.length) {
    throw new Error("graph contains a dependency cycle (topological sort incomplete)");
  }
  return result;
}

/** Every built-able node needs a brief upstream (transitively). */
export function reachableFromBriefs(graph: StudioGraph): Set<string> {
  const briefIds = new Set(graph.nodes.filter((n) => n.type === "brief").map((n) => n.id));
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (["briefs", "owns", "feeds", "yields"].includes(e.type)) {
      const list = adj.get(e.source) ?? [];
      list.push(e.target);
      adj.set(e.source, list);
    }
  }
  const visited = new Set<string>(briefIds);
  const queue = [...briefIds];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
  }
  return visited;
}
