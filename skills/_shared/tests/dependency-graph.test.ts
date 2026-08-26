// dependency-graph.test.ts — the typed entity-graph algebra.
//
// The real failure this file prevents: tracking-360 shipped with 5 of the 17
// mind-clones it needed, because nothing in the engine modeled the
// employee→clone dependency edge — the pack build resolved clones by grepping
// employee prose for 556 slugs and missed 12. The algebra under test is what
// replaces that guess with a declared, validated, orderable graph.
//
// Tests in the first two describe blocks are ported from PR #41
// (skills/studio/tests/studio.test.ts, @marciobisognin), minus the
// persistence assertions (schema_version, slug names, store paths) that
// stayed in Studio. Cycle-policy tests reflect this repo's deliberate
// divergence: buildOrder() reports cycles as data; buildOrderOrThrow() keeps
// the PR #41 throwing semantics.

import { describe, expect, test } from "bun:test";
import {
  addEdge,
  addNode,
  buildOrder,
  buildOrderOrThrow,
  closure,
  dependencyPair,
  emptyGraph,
  inboundEdges,
  isCompatibleEdge,
  nodesByType,
  outboundEdges,
  reachableFromBriefs,
  toDagNodes,
  validateGraph,
  type DependencyGraph,
  type GraphEdge,
  type GraphNode,
  type NodeType,
} from "../lib/dependency-graph.ts";
import { planDag } from "../../harness/lib/dag-planner.ts";

function node(id: string, type: NodeType, payload: Record<string, unknown> = {}): GraphNode {
  return { id, type, payload };
}
function edge(id: string, source: string, target: string, type: GraphEdge["type"]): GraphEdge {
  return { id, source, target, type };
}

// ── ported from PR #41: graph algebra ───────────────────────────────────────

describe("graph algebra (ported from PR #41)", () => {
  test("an empty graph validates clean", () => {
    expect(validateGraph(emptyGraph())).toEqual([]);
  });

  test("addNode rejects duplicates", () => {
    const g = emptyGraph();
    addNode(g, node("company-a", "company"));
    expect(() => addNode(g, node("company-a", "company"))).toThrow(/already exists/);
  });

  test("addEdge enforces type compatibility", () => {
    const g = emptyGraph();
    addNode(g, node("brief-1", "brief", { instruction: "build a company" }));
    addNode(g, node("company-a", "company"));
    addEdge(g, edge("e1", "brief-1", "company-a", "briefs"));
    expect(() => addEdge(g, edge("e2", "company-a", "brief-1", "briefs"))).toThrow(/not allowed/);
  });

  test("addEdge rejects cycles", () => {
    const g = emptyGraph();
    addNode(g, node("aaa", "company"));
    addNode(g, node("bbb", "squad"));
    addEdge(g, edge("e1", "aaa", "bbb", "depends_on"));
    expect(() => addEdge(g, edge("e2", "bbb", "aaa", "depends_on"))).toThrow(/cycle/);
  });

  test("addEdge uses effective dependency direction, not canvas direction", () => {
    const g = emptyGraph();
    addNode(g, node("company", "company"));
    addNode(g, node("employee", "employee"));
    addEdge(g, edge("e1", "company", "employee", "owns"));
    // The employee depends on the company already; this is redundant, not a cycle.
    expect(() => addEdge(g, edge("e2", "employee", "company", "depends_on"))).not.toThrow();
  });

  test("addEdge rejects duplicates", () => {
    const g = emptyGraph();
    addNode(g, node("aaa", "company"));
    addNode(g, node("bbb", "employee"));
    addEdge(g, edge("e1", "aaa", "bbb", "owns"));
    expect(() => addEdge(g, edge("e2", "aaa", "bbb", "owns"))).toThrow(/already exists/);
  });

  test("edge compatibility table (Studio Protocol §2.2)", () => {
    const pair = (fromType: NodeType, toType: NodeType): DependencyGraph => {
      const g = emptyGraph();
      addNode(g, node("aaa", fromType));
      addNode(g, node("bbb", toType));
      return g;
    };
    for (const [src, tgt, type] of [
      ["brief", "company", "briefs"], ["brief", "squad", "briefs"], ["brief", "mind_clone", "briefs"],
      ["company", "employee", "owns"], ["employee", "squad", "staffs"], ["employee", "mind_clone", "embodies"], ["company", "mind_clone", "embodies"],
      ["squad", "company", "covers"], ["material", "mind_clone", "feeds"], ["material", "company", "feeds"], ["material", "squad", "feeds"],
      ["company", "deliverable", "yields"], ["squad", "deliverable", "yields"],
    ] as const) {
      expect(() => addEdge(pair(src, tgt), edge("eee", "aaa", "bbb", type))).not.toThrow();
    }
    expect(() => addEdge(pair("squad", "squad"), edge("eee", "aaa", "bbb", "depends_on"))).not.toThrow();
    expect(() => addEdge(pair("mind_clone", "company"), edge("eee", "aaa", "bbb", "owns"))).toThrow();
    expect(() => addEdge(pair("company", "company"), edge("eee", "aaa", "bbb", "embodies"))).toThrow();
    expect(() => addEdge(pair("deliverable", "company"), edge("eee", "aaa", "bbb", "briefs"))).toThrow();
    expect(() => addEdge(pair("employee", "deliverable"), edge("eee", "aaa", "bbb", "yields"))).toThrow();
    expect(isCompatibleEdge("owns", "company", "employee")).toBeTrue();
    expect(isCompatibleEdge("owns", "employee", "company")).toBeFalse();
  });

  test("buildOrder honors dependency direction and implicit edges", () => {
    const g = emptyGraph();
    addNode(g, node("bri", "brief", { instruction: "build everything" }));
    addNode(g, node("com", "company"));
    addNode(g, node("emp", "employee"));
    addNode(g, node("sqd", "squad"));
    addNode(g, node("mcl", "mind_clone"));
    addEdge(g, edge("e1", "bri", "com", "briefs"));
    addEdge(g, edge("e2", "com", "emp", "owns"));
    addEdge(g, edge("e3", "emp", "sqd", "staffs"));
    addEdge(g, edge("e4", "bri", "mcl", "briefs"));
    addEdge(g, edge("e5", "emp", "mcl", "embodies"));
    addEdge(g, edge("e6", "mcl", "sqd", "depends_on"));
    const order = buildOrderOrThrow(g).map((n) => n.id);
    expect(order.indexOf("bri")).toBeLessThan(order.indexOf("com"));
    expect(order.indexOf("bri")).toBeLessThan(order.indexOf("mcl"));
    expect(order.indexOf("sqd")).toBeLessThan(order.indexOf("mcl"));
    expect(order.indexOf("mcl")).toBeLessThan(order.indexOf("emp"));
    expect(order.indexOf("sqd")).toBeLessThan(order.indexOf("emp"));
    expect(order.indexOf("com")).toBeLessThan(order.indexOf("emp"));
  });

  test("buildOrderOrThrow fails on a depends_on cycle (hand-crafted document)", () => {
    const g: DependencyGraph = {
      nodes: [node("aaa", "squad"), node("bbb", "squad")],
      edges: [edge("e1", "aaa", "bbb", "depends_on"), edge("e2", "bbb", "aaa", "depends_on")],
    };
    expect(() => buildOrderOrThrow(g)).toThrow(/cycle/);
  });

  test("reachableFromBriefs finds orphans", () => {
    const g = emptyGraph();
    addNode(g, node("bri", "brief", { instruction: "x" }));
    addNode(g, node("com", "company"));
    addNode(g, node("orphan", "squad"));
    addEdge(g, edge("e1", "bri", "com", "briefs"));
    const r = reachableFromBriefs(g);
    expect(r.has("bri") && r.has("com")).toBeTrue();
    expect(r.has("orphan")).toBeFalse();
  });

  test("nodesByType and edge accessors", () => {
    const g = emptyGraph();
    addNode(g, node("com", "company"));
    addNode(g, node("emp", "employee"));
    addEdge(g, edge("e1", "com", "emp", "owns"));
    expect(nodesByType(g, "company").map((n) => n.id)).toEqual(["com"]);
    expect(outboundEdges(g, "com").map((e) => e.id)).toEqual(["e1"]);
    expect(inboundEdges(g, "emp").map((e) => e.id)).toEqual(["e1"]);
  });
});

// ── ported from PR #41: hand-authored document validation ──────────────────

describe("validateGraph (ported from PR #41, persistence checks removed)", () => {
  test("rejects duplicate node ids", () => {
    const g = emptyGraph();
    g.nodes.push(node("aaa", "company"), node("aaa", "squad"));
    expect(validateGraph(g).some((e) => e.message.includes("duplicate"))).toBeTrue();
  });

  test("rejects edges pointing at unknown nodes", () => {
    const g = emptyGraph();
    g.edges.push(edge("eee", "aaa", "ghost", "depends_on"));
    expect(validateGraph(g).some((e) => e.path.includes("/target"))).toBeTrue();
  });

  test("rejects an incompatible edge in a hand-authored graph", () => {
    const g = emptyGraph();
    g.nodes.push(node("company", "company"), node("clone", "mind_clone"));
    g.edges.push(edge("eee", "company", "clone", "staffs"));
    expect(validateGraph(g).some((e) => e.message.includes("not allowed"))).toBeTrue();
  });

  test("rejects a dependency cycle hidden by a typed ownership edge", () => {
    const g = emptyGraph();
    g.nodes.push(node("brief", "brief", { instruction: "build safely" }), node("company", "company"), node("employee", "employee"));
    g.edges.push(
      edge("briefs-company", "brief", "company", "briefs"),
      edge("company-employee", "company", "employee", "owns"),
      edge("company-after-employee", "company", "employee", "depends_on"),
    );
    expect(validateGraph(g).some((e) => e.message.includes("cycle"))).toBeTrue();
  });
});

// ── this repo's additions ───────────────────────────────────────────────────

describe("dependency direction (the load-bearing reversal)", () => {
  test("staffs, embodies and depends_on reverse; the rest do not", () => {
    expect(dependencyPair(edge("e", "emp", "sqd", "staffs"))).toEqual(["sqd", "emp"]);
    expect(dependencyPair(edge("e", "emp", "mcl", "embodies"))).toEqual(["mcl", "emp"]);
    expect(dependencyPair(edge("e", "aaa", "bbb", "depends_on"))).toEqual(["bbb", "aaa"]);
    expect(dependencyPair(edge("e", "com", "emp", "owns"))).toEqual(["com", "emp"]);
    expect(dependencyPair(edge("e", "bri", "com", "briefs"))).toEqual(["bri", "com"]);
  });

  test("employee embodies mind_clone → the clone comes first in build order", () => {
    const g = emptyGraph();
    addNode(g, node("employee", "employee"));
    addNode(g, node("clone", "mind_clone"));
    addEdge(g, edge("e1", "employee", "clone", "embodies"));
    const order = buildOrderOrThrow(g).map((n) => n.id);
    expect(order).toEqual(["clone", "employee"]);
  });
});

describe("buildOrder cycle-as-data (this repo's policy)", () => {
  test("a cyclic document returns has_cycle with the members named", () => {
    const g: DependencyGraph = {
      nodes: [node("aaa", "squad"), node("bbb", "squad"), node("ccc", "company")],
      edges: [edge("e1", "aaa", "bbb", "depends_on"), edge("e2", "bbb", "aaa", "depends_on")],
    };
    const r = buildOrder(g);
    expect(r.has_cycle).toBeTrue();
    expect(r.cycle_nodes.sort()).toEqual(["aaa", "bbb"]);
    expect(r.order.map((n) => n.id)).toEqual(["ccc"]);
  });
});

describe("closure — everything an execution needs", () => {
  test("company root pulls employees (owns), their clones (embodies) and squads (staffs)", () => {
    const g = emptyGraph();
    addNode(g, node("company", "company"));
    addNode(g, node("emp-1", "employee"));
    addNode(g, node("emp-2", "employee"));
    addNode(g, node("clone-1", "mind_clone"));
    addNode(g, node("squad-1", "squad"));
    addNode(g, node("unrelated", "company"));
    addEdge(g, edge("e1", "company", "emp-1", "owns"));
    addEdge(g, edge("e2", "company", "emp-2", "owns"));
    addEdge(g, edge("e3", "emp-1", "clone-1", "embodies"));
    addEdge(g, edge("e4", "emp-2", "squad-1", "staffs"));
    const c = closure(g, ["company"]);
    expect(c.nodes.map((n) => n.id).sort()).toEqual(["clone-1", "company", "emp-1", "emp-2", "squad-1"]);
    expect(c.edges.length).toBe(4);
  });

  test("unknown roots are ignored, not fatal", () => {
    const g = emptyGraph();
    addNode(g, node("company", "company"));
    expect(closure(g, ["ghost"]).nodes).toEqual([]);
  });
});

describe("toDagNodes bridges into planDag", () => {
  test("wave layering matches the dependency order", () => {
    const g = emptyGraph();
    addNode(g, node("com", "company"));
    addNode(g, node("emp", "employee"));
    addNode(g, node("mcl", "mind_clone"));
    addEdge(g, edge("e1", "com", "emp", "owns"));
    addEdge(g, edge("e2", "emp", "mcl", "embodies"));
    const plan = planDag(toDagNodes(g, { parallelSafe: () => true }));
    expect(plan.has_cycle).toBeFalse();
    expect(plan.layers[0].sort()).toEqual(["com", "mcl"]);
    expect(plan.layers[1]).toEqual(["emp"]);
  });
});

describe("agent nodes", () => {
  // A role no squad covers: briefed, depending and yielding like a squad; nothing else may touch it.
  test("an agent node accepts briefs, depends_on and yields, and nothing else", () => {
    const g = emptyGraph();
    addNode(g, node("brief-1", "brief"));
    addNode(g, node("squad-a", "squad"));
    addNode(g, node("role-writer", "agent"));
    addNode(g, node("deliv-1", "deliverable"));
    addEdge(g, edge("e1", "brief-1", "role-writer", "briefs"));
    addEdge(g, edge("e2", "role-writer", "squad-a", "depends_on"));
    addEdge(g, edge("e3", "role-writer", "deliv-1", "yields"));
    expect(validateGraph(g)).toEqual([]);
    expect(buildOrder(g).order.map((n) => n.id)).toEqual(["brief-1", "squad-a", "role-writer", "deliv-1"]);
    expect(reachableFromBriefs(g).has("role-writer")).toBeTrue();

    expect(isCompatibleEdge("briefs", "brief", "agent")).toBeTrue();
    expect(isCompatibleEdge("yields", "agent", "deliverable")).toBeTrue();
    expect(isCompatibleEdge("owns", "company", "agent")).toBeFalse();
    expect(isCompatibleEdge("staffs", "employee", "agent")).toBeFalse();
    expect(isCompatibleEdge("covers", "agent", "company")).toBeFalse();
    expect(isCompatibleEdge("feeds", "material", "agent")).toBeFalse();
    expect(isCompatibleEdge("embodies", "agent", "mind_clone")).toBeFalse();
    const issues = validateGraph({ nodes: [node("company-a", "company"), node("role-writer", "agent")], edges: [edge("bad", "company-a", "role-writer", "owns")] });
    expect(issues.map((i) => i.message)).toEqual(['edge type "owns" is not allowed from company to agent']);
  });
});
