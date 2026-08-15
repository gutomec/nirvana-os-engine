// validators.ts — protocol-level validation of a Studio graph.
//
// Structural validity is handled by graph-store.validateGraphStructure();
// this module enforces the STUDIO_PROTOCOL_V1 rules that decide whether a
// graph can be built:
//   1. at least one `brief` node exists and carries a non-empty instruction
//   2. every company has >= 1 employee; every employee belongs to a company
//   3. embodies edges respect type semantics
//   4. squad capabilities use dotted hierarchical ids
//   5. slugs are unique across companies/squads/clones (avoid collisions in
//      the shared user library)
//   6. mind-clone creation nodes have a source declared (permanent artifact)
//
// All checks are read-only over the graph document.

import type { StudioGraph, StudioNode, ValidationError } from "./graph-store.ts";
import { inboundEdges, outboundEdges, nodesByType, reachableFromBriefs } from "./graph-store.ts";

const DOTTED_CAPABILITY = /^[a-z0-9_]+(\.[a-z0-9_]+)+\.[a-z0-9_]+$/;

export interface GraphCheck { ok: boolean; checks: { name: string; ok: boolean; message: string }[] }

export function validateGraphProtocol(graph: Partial<StudioGraph> | undefined): GraphCheck {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return { ok: false, checks: [{ name: "graph-shape", ok: false, message: "graph is missing nodes/edges — save a graph first" }] };
  }
  const checks: { name: string; ok: boolean; message: string }[] = [];
  const errors: ValidationError[] = [];
  const byId = new Map((graph as StudioGraph).nodes.map((n) => [n.id, n]));

  // C1 — entry: at least one brief with an instruction
  const briefs = nodesByType(graph as StudioGraph, "brief");
  const briefsOk = briefs.length >= 1 && briefs.every((b) => {
    const bag = (b.payload ?? b.props) as Record<string, unknown> | undefined;
    const instr = (bag?.instruction as string | undefined) ?? "";
    return instr.trim().length >= 3;
  });
  checks.push({
    name: "entry-brief",
    ok: briefsOk,
    message: briefs.length === 0
      ? "a `brief` node is required — the build block is the entry point of the graph"
      : "every brief node must carry an `instruction` of at least 3 characters",
  });

  // C2 — companies need employees; employees need a company
  const companies = nodesByType(graph as StudioGraph, "company");
  const employees = nodesByType(graph as StudioGraph, "employee");
  const companiesOk = companies.every((c) => {
    const owned = outboundEdges(graph as StudioGraph, c.id).filter((e) => e.type === "owns");
    return owned.length >= 1;
  });
  checks.push({
    name: "company-has-employees",
    ok: companiesOk,
    message: "every company must own at least one employee (org chart cannot be empty)",
  });
  const employeesOk = employees.every((e) =>
    inboundEdges(graph as StudioGraph, e.id).some((ed) => ed.type === "owns" && byId.get(ed.source)?.type === "company"));
  checks.push({
    name: "employee-belongs-to-company",
    ok: employeesOk,
    message: "every employee must be owned by exactly one company",
  });

  // C3 — embodies: employee|company→mind_clone
  const embodiesBad = graph.edges.filter((e) => e.type === "embodies" &&
    (!["employee", "company"].includes(byId.get(e.source)?.type ?? "") || byId.get(e.target)?.type !== "mind_clone"));
  checks.push({
    name: "embodies-typing",
    ok: embodiesBad.length === 0,
    message: "embodies edges only connect employees or companies to mind-clones",
  });

  // C4 — squad capabilities are dotted ids
  const squads = nodesByType(graph as StudioGraph, "squad");
  const capsBad = squads.flatMap((s) =>
    (Array.isArray(s.payload?.capabilities) ? s.payload.capabilities : Array.isArray(s.props?.capabilities) ? s.props.capabilities : []).filter((c) => !DOTTED_CAPABILITY.test(c)));
  checks.push({
    name: "capability-ids",
    ok: capsBad.length === 0,
    message: "squad capabilities must be dotted hierarchical ids (domain.subdomain.verb)",
  });

  // C5 — slug uniqueness across library entities
  const slugs = graph.nodes
    .filter((n) => ["company", "squad", "mind_clone"].includes(n.type))
    .map((n) => String((n.payload as Record<string, unknown> | undefined)?.slug ?? n.id));
  const dupes = new Set(slugs.filter((s, i) => slugs.indexOf(s) !== i));
  checks.push({
    name: "slug-uniqueness",
    ok: dupes.size === 0,
    message: dupes.size === 0 ? "ok" : `duplicate slugs across companies/squads/clones: ${[...dupes].join(", ")}`,
  });

  // C6 — mind-clone creation nodes need a declared source
  const clones = nodesByType(graph as StudioGraph, "mind_clone");
  const clonesOk = clones.every((c) => {
    const bag = (c.payload ?? c.props) as Record<string, unknown> | undefined;
    const src = (bag?.source as string | undefined) ?? "";
    return src.trim().length >= 3;
  });
  checks.push({
    name: "clone-source-declared",
    ok: clonesOk,
    message: "every mind-clone node must declare its source (persona DNA is a permanent artifact)",
  });

  // C7 — reachability: no orphan buildable node
  const reachable = reachableFromBriefs(graph as StudioGraph);
  const orphans = (graph as StudioGraph).nodes.filter((n) => n.type !== "deliverable" && !reachable.has(n.id));
  checks.push({
    name: "no-orphans",
    ok: orphans.length === 0,
    message: orphans.length === 0 ? "ok" : `${orphans.map((n) => n.id).join(", ")} not reachable from any brief`,
  });

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}
