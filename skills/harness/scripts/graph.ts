#!/usr/bin/env bun
/**
 * graph.ts — read-only queries over the typed entity dependency graph.
 *
 * The graph is ALWAYS derived from the prose declarations on disk (see
 * skills/_shared/lib/entity-graph.ts); this command never writes anything.
 * It exists for one question the registries alone answer poorly: "what does
 * executing this business actually need?" — the exact closure of employees,
 * mind-clones and squads, with the missing ones named instead of silently
 * absent. Opt-in by construction: nothing on the dispatch hot path imports
 * this file or the graph libs.
 *
 * Usage:
 *   nrv graph closure --business <slug> [--pack <dir>] [--json]
 *   nrv graph order   [--pack <dir>] [--json]
 *   nrv graph check   [--pack <dir>] [--strict] [--json]
 */
import {
  buildOrder,
  closure,
  validateGraph,
  type GraphNode,
} from "../../_shared/lib/dependency-graph.ts";
import { buildEntityGraph, installKindOrder, readCloneBindings, readSquadComposition, resolveRoots } from "../../_shared/lib/entity-graph.ts";

const RED = "\x1b[31m", GRN = "\x1b[32m", YEL = "\x1b[33m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RST = "\x1b[0m";

const argv = process.argv.slice(2);
const sub = argv[0];
const flag = (name: string): string | null =>
  argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? null : null;
const asJson = argv.includes("--json");
const strict = argv.includes("--strict");
const packDir = flag("--pack");
const bizSlug = flag("--business");

if (!sub || !["closure", "order", "check"].includes(sub)) {
  console.error('usage: nrv graph <closure|order|check> [--business <slug>] [--pack <dir>] [--strict] [--json]');
  process.exit(4);
}

const roots = resolveRoots(packDir);
const graph = buildEntityGraph(roots);

const label = (n: GraphNode) => `${n.type}${n.payload?.missing ? " (MISSING)" : ""}`;

if (sub === "closure") {
  if (!bizSlug) {
    console.error("nrv graph closure: --business <slug> is required");
    process.exit(4);
  }
  const rootId = `business:${bizSlug}`;
  if (!graph.nodes.some((n) => n.id === rootId)) {
    console.error(`nrv graph closure: business '${bizSlug}' not found under ${roots.businessesDir}`);
    process.exit(1);
  }
  const c = closure(graph, [rootId]);
  const missing = c.nodes.filter((n) => n.payload?.missing).map((n) => String(n.payload?.slug ?? n.id));
  if (asJson) {
    console.log(JSON.stringify({ root: rootId, nodes: c.nodes, edges: c.edges, missing }, null, 2));
  } else {
    console.log(`\n${BOLD}CLOSURE — everything '${bizSlug}' needs to run${RST}`);
    for (const t of ["company", "employee", "mind_clone", "squad"] as const) {
      const rows = c.nodes.filter((n) => n.type === t);
      if (!rows.length) continue;
      console.log(`  ${DIM}${t}${RST}`);
      for (const n of rows) {
        const miss = n.payload?.missing ? ` ${RED}MISSING${RST}` : "";
        console.log(`    ${n.payload?.missing ? YEL : GRN}${String(n.payload?.slug ?? n.id)}${RST}${miss}`);
      }
    }
    console.log(`\n  ${c.nodes.length} entities · ${c.edges.length} edges · ${missing.length} missing\n`);
  }
  process.exitCode = missing.length && strict ? 1 : 0;
} else if (sub === "order") {
  const r = buildOrder(graph);
  const kinds = installKindOrder(graph);
  if (asJson) {
    console.log(JSON.stringify({
      kind_order: kinds.order,
      has_cycle: r.has_cycle,
      cycle_nodes: r.cycle_nodes,
      order: r.order.map((n) => n.id),
    }, null, 2));
  } else {
    console.log(`\n${BOLD}INSTALL ORDER${RST} ${DIM}(dependency before dependent)${RST}`);
    console.log(`  kinds: ${kinds.order.join(" → ")}${r.has_cycle ? ` ${RED}(cycle: ${r.cycle_nodes.join(", ")})${RST}` : ""}`);
    console.log(`  ${r.order.length} nodes ordered\n`);
  }
  process.exitCode = r.has_cycle && strict ? 1 : 0;
} else {
  const issues = validateGraph(graph);
  const scan = readCloneBindings(roots);
  const missing = scan.bindings.filter((b) => !b.dangling && !scan.availableClones.has(b.clone));
  // Composition (Squad Protocol v6 §31). A `requires` that resolves to nothing
  // is a broken declaration — the capability is not in the library and no
  // ordering can supply it — so --strict fails on it. Ambiguity is a different
  // finding: the capability exists, twice, and the library already carries
  // duplicate ids, so it is reported and never fatal.
  const composition = readSquadComposition(roots).issues;
  const orphans = composition.filter((c) => c.kind === "requires" && c.reason === "unresolved");
  if (asJson) {
    console.log(JSON.stringify({ issues, missing, composition }, null, 2));
  } else {
    console.log(`\n${BOLD}GRAPH CHECK${RST}`);
    console.log(`  ${graph.nodes.length} nodes · ${graph.edges.length} edges · ${issues.length} structural issue(s) · ${missing.length} unresolved binding(s) · ${composition.length} composition finding(s)`);
    for (const i of issues.slice(0, 12)) console.log(`  ${RED}✗${RST} ${i.path} — ${i.message}`);
    for (const m of missing.slice(0, 12)) console.log(`  ${YEL}?${RST} ${m.clone} ${DIM}← ${m.business}/${m.employee}${RST}`);
    for (const c of composition.slice(0, 12)) {
      const where = `${DIM}← ${c.squad}/${c.capability}${RST}`;
      const hint = c.candidates.length ? ` ${DIM}(${c.candidates.join(", ")})${RST}` : "";
      console.log(`  ${c.reason === "unresolved" && c.kind === "requires" ? `${RED}✗${RST}` : `${YEL}?${RST}`} ${c.code} ${c.ref} ${where}${hint}`);
    }
    console.log("");
  }
  process.exitCode = strict && (issues.length || missing.length || orphans.length) ? 1 : 0;
}
