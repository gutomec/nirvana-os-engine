// studio.test.ts — unit tests for Studio Protocol v1 libs.
//
// Covers: graph store (CRUD, structure validation, edge compatibility,
// cycle detection, topological order, brief reachability), protocol
// validation, and exporters.

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addEdge,
  addNode,
  buildOrder,
  deleteGraph,
  graphPath,
  inboundEdges,
  listGraphs,
  loadGraph,
  newGraph,
  nodesByType,
  reachableFromBriefs,
  resolveStudioScope,
  saveGraph,
  validateGraphStructure,
  type StudioGraph,
} from "../lib/graph-store.ts";
import { validateGraphProtocol } from "../lib/validators.ts";
import { planExport, scaffoldBusinessYaml, scaffoldSquadYaml, scaffoldCloneManifest, scaffoldEmployeeMd } from "../lib/exporters.ts";
import { mergePlanIntoGraph } from "../scripts/studio-server.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

function g(name = "test-graph"): StudioGraph {
  return newGraph(name);
}

function node(id: string, type: StudioGraph["nodes"][number]["type"], payload: Record<string, unknown> = {}): StudioGraph["nodes"][number] {
  return { id, type, position: { x: 100, y: 100 }, status: "draft", payload };
}

function edge(id: string, source: string, target: string, type: StudioGraph["edges"][number]["type"]): StudioGraph["edges"][number] {
  return { id, source, target, type };
}

// ── graph store ─────────────────────────────────────────────────────────────

describe("graph store", () => {
  test("newGraph creates a valid empty document", () => {
    const graph = g();
    expect(graph.schema_version).toBe("1.0.0");
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(validateGraphStructure(graph)).toEqual([]);
  });

  test("name is slugified", () => {
    const graph = newGraph("Podcast Empire — Great!");
    expect(graph.name).toBe("podcast-empire-great");
  });

  test("addNode rejects duplicates", () => {
    const graph = g();
    addNode(graph, node("company-a", "company"));
    expect(() => addNode(graph, node("company-a", "company"))).toThrow(/already exists/);
  });

  test("addEdge enforces type compatibility", () => {
    const graph = g();
    addNode(graph, node("brief-1", "brief", { instruction: "build a company" }));
    addNode(graph, node("company-a", "company"));
    addEdge(graph, edge("e1", "brief-1", "company-a", "briefs"));
    expect(() => addEdge(graph, edge("e2", "company-a", "brief-1", "briefs"))).toThrow(/not allowed/);
  });

  test("addEdge rejects cycles", () => {
    const graph = g();
    addNode(graph, node("a", "company"));
    addNode(graph, node("b", "squad"));
    addEdge(graph, edge("e1", "a", "b", "depends_on"));
    expect(() => addEdge(graph, edge("e2", "b", "a", "depends_on"))).toThrow(/cycle/);
  });

  test("addEdge uses effective dependency direction, not canvas direction", () => {
    const graph = g();
    addNode(graph, node("company", "company"));
    addNode(graph, node("employee", "employee"));
    addEdge(graph, edge("e1", "company", "employee", "owns"));
    // The employee depends on the company already; this is redundant, not a cycle.
    expect(() => addEdge(graph, edge("e2", "employee", "company", "depends_on"))).not.toThrow();
  });

  test("addEdge rejects duplicates", () => {
    const graph = g();
    addNode(graph, node("a", "company"));
    addNode(graph, node("b", "employee"));
    addEdge(graph, edge("e1", "a", "b", "owns"));
    expect(() => addEdge(graph, edge("e2", "a", "b", "owns"))).toThrow(/already exists/);
  });

  test("edge compatibility table (Studio Protocol §2.2)", () => {
    // One graph per edge class to avoid accidental cycle detection on the
    // shared node set (cycle check is type-agnostic and runs on the whole
    // edge set of that graph).
    const pair = (
      fromType: StudioGraph["nodes"][number]["type"],
      toType: StudioGraph["nodes"][number]["type"],
    ): StudioGraph => {
      const graph = g();
      addNode(graph, node("a", fromType));
      addNode(graph, node("b", toType));
      return graph;
    };
    // valid directions
    for (const [src, tgt, type] of [
      ["brief", "company", "briefs"], ["brief", "squad", "briefs"], ["brief", "mind_clone", "briefs"],
      ["company", "employee", "owns"], ["employee", "squad", "staffs"], ["employee", "mind_clone", "embodies"], ["company", "mind_clone", "embodies"],
      ["squad", "company", "covers"], ["material", "mind_clone", "feeds"], ["material", "company", "feeds"], ["material", "squad", "feeds"],
      ["company", "deliverable", "yields"], ["squad", "deliverable", "yields"],
    ] as const) {
      expect(() => addEdge(pair(src, tgt), edge("e", "a", "b", type))).not.toThrow();
    }
    // depends_on allows any pair
    expect(() => addEdge(pair("squad", "squad"), edge("e", "a", "b", "depends_on"))).not.toThrow();
    // invalid directions
    expect(() => addEdge(pair("mind_clone", "company"), edge("e", "a", "b", "owns"))).toThrow();
    expect(() => addEdge(pair("company", "company"), edge("e", "a", "b", "embodies"))).toThrow();
    expect(() => addEdge(pair("deliverable", "company"), edge("e", "a", "b", "briefs"))).toThrow();
    expect(() => addEdge(pair("employee", "deliverable"), edge("e", "a", "b", "yields"))).toThrow();
  });

  test("buildOrder honors dependency direction and implicit edges", () => {
    const graph = g();
    addNode(graph, node("b", "brief", { instruction: "build everything" }));
    addNode(graph, node("c", "company"));
    addNode(graph, node("e", "employee"));
    addNode(graph, node("s", "squad"));
    addNode(graph, node("m", "mind_clone"));
    addEdge(graph, edge("1", "b", "c", "briefs"));
    addEdge(graph, edge("2", "c", "e", "owns"));
    addEdge(graph, edge("3", "e", "s", "staffs"));
    addEdge(graph, edge("4", "b", "m", "briefs"));
    addEdge(graph, edge("5", "e", "m", "embodies"));
    addEdge(graph, edge("6", "m", "s", "depends_on"));
    const order = buildOrder(graph).map((n) => n.id);
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("m"));
    expect(order.indexOf("s")).toBeLessThan(order.indexOf("m"));
    expect(order.indexOf("m")).toBeLessThan(order.indexOf("e"));
    expect(order.indexOf("s")).toBeLessThan(order.indexOf("e"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("e"));
  });

  test("buildOrder fails on a depends_on cycle", () => {
    // The interactive API (addEdge) rejects cycles up front, so the only way
    // a cyclic graph reaches buildOrder is a hand-crafted document — this is
    // exactly what the headless --from-file path must still guard against.
    const graph: StudioGraph = {
      schema_version: "1.0.0",
      name: "cyclic",
      nodes: [node("a", "squad"), node("b", "squad")],
      edges: [edge("1", "a", "b", "depends_on"), edge("2", "b", "a", "depends_on")],
    };
    expect(() => buildOrder(graph)).toThrow(/cycle/);
  });

  test("reachableFromBriefs finds orphans", () => {
    const graph = g();
    addNode(graph, node("b", "brief", { instruction: "x" }));
    addNode(graph, node("c", "company"));
    addNode(graph, node("orphan", "squad"));
    addEdge(graph, edge("1", "b", "c", "briefs"));
    const r = reachableFromBriefs(graph);
    expect(r.has("b") && r.has("c")).toBeTrue();
    expect(r.has("orphan")).toBeFalse();
  });
});

// ── structure validation ────────────────────────────────────────────────────

describe("validateGraphStructure", () => {
  test("rejects wrong schema version", () => {
    const errors = validateGraphStructure({ schema_version: "0.9.0", name: "g", nodes: [], edges: [] });
    expect(errors.some((e) => e.path === "/schema_version")).toBeTrue();
  });

  test("rejects duplicate node ids", () => {
    const graph = g();
    graph.nodes.push(node("a", "company"), node("a", "squad"));
    expect(validateGraphStructure(graph).some((e) => e.message.includes("duplicate"))).toBeTrue();
  });

  test("rejects edges pointing at unknown nodes", () => {
    const graph = g();
    graph.edges.push(edge("e", "a", "ghost", "depends_on"));
    expect(validateGraphStructure(graph).some((e) => e.path.includes("/target"))).toBeTrue();
  });

  test("rejects an incompatible edge in a hand-authored graph", () => {
    const graph = g();
    graph.nodes.push(node("company", "company"), node("clone", "mind_clone"));
    graph.edges.push(edge("e", "company", "clone", "staffs"));
    expect(validateGraphStructure(graph).some((e) => e.message.includes("not allowed"))).toBeTrue();
  });

  test("rejects a dependency cycle hidden by a typed ownership edge", () => {
    const graph = g();
    graph.nodes.push(node("brief", "brief", { instruction: "build safely" }), node("company", "company"), node("employee", "employee"));
    graph.edges.push(
      edge("briefs-company", "brief", "company", "briefs"),
      edge("company-employee", "company", "employee", "owns"),
      edge("company-after-employee", "company", "employee", "depends_on"),
    );
    expect(validateGraphStructure(graph).some((e) => e.message.includes("cycle"))).toBeTrue();
  });

  test("rejects traversal-shaped graph names before any store path is computed", () => {
    expect(() => graphPath("../../../.hermes/config")).toThrow(/graph name/);
    expect(validateGraphStructure({ schema_version: "1.0.0", name: "../../outside", nodes: [], edges: [] })
      .some((e) => e.path === "/name")).toBeTrue();
  });
});

// ── protocol validation ─────────────────────────────────────────────────────

describe("validateGraphProtocol", () => {
  test("empty graph fails: no brief", () => {
    const graph = g();
    const { ok, checks } = validateGraphProtocol(graph);
    expect(ok).toBeFalse();
    expect(checks.find((c) => c.name === "entry-brief")?.ok).toBeFalse();
  });

  test("brief without instruction fails", () => {
    const graph = g();
    graph.nodes.push(node("b", "brief", { instruction: "" }));
    expect(validateGraphProtocol(graph).ok).toBeFalse();
  });

  test("company without employees fails", () => {
    const graph = g();
    graph.nodes.push(node("b", "brief", { instruction: "build a company" }));
    graph.nodes.push(node("c", "company"));
    graph.edges.push(edge("1", "b", "c", "briefs"));
    const { checks } = validateGraphProtocol(graph);
    expect(checks.find((c) => c.name === "company-has-employees")?.ok).toBeFalse();
  });

  test("valid minimal company graph passes", () => {
    const graph = g();
    graph.nodes.push(node("b", "brief", { instruction: "build podcast-empire" }));
    graph.nodes.push(node("c", "company", { slug: "podcast-empire", description: "3 podcasts at once" }));
    graph.nodes.push(node("e", "employee", { slug: "ceo", role: "CEO", title: "Chief Executive" }));
    graph.edges.push(edge("1", "b", "c", "briefs"));
    graph.edges.push(edge("2", "c", "e", "owns"));
    expect(validateGraphProtocol(graph).ok).toBeTrue();
  });

  test("clone without source fails (permanent artifact)", () => {
    const graph = g();
    graph.nodes.push(node("b", "brief", { instruction: "clone an expert" }));
    graph.nodes.push(node("m", "mind_clone", { slug: "guru", source: "" }));
    graph.edges.push(edge("1", "b", "m", "briefs"));
    expect(validateGraphProtocol(graph).ok).toBeFalse();
  });

  test("company may embody a culture-level mind-clone", () => {
    const graph = g();
    graph.nodes.push(node("b", "brief", { instruction: "create an organization" }));
    graph.nodes.push(node("c", "company", { slug: "company" }));
    graph.nodes.push(node("e", "employee", { slug: "lead" }));
    graph.nodes.push(node("m", "mind_clone", { slug: "culture", source: "user-provided material" }));
    graph.edges.push(edge("1", "b", "c", "briefs"), edge("2", "c", "e", "owns"), edge("3", "b", "m", "briefs"), edge("4", "c", "m", "embodies"));
    expect(validateGraphProtocol(graph).checks.find((c) => c.name === "embodies-typing")?.ok).toBeTrue();
  });

  test("undotted capability id fails", () => {
    const graph = g();
    graph.nodes.push(node("b", "brief", { instruction: "need a squad" }));
    graph.nodes.push(node("s", "squad", { slug: "copy-squad", capabilities: ["badid"] }));
    graph.edges.push(edge("1", "b", "s", "briefs"));
    const { checks } = validateGraphProtocol(graph);
    expect(checks.find((c) => c.name === "capability-ids")?.ok).toBeFalse();
  });

  test("fails closed when a graph needs unavailable relationship adapters", () => {
    const graph = g();
    graph.nodes.push(node("b", "brief", { instruction: "create a team" }), node("c", "company"), node("e", "employee", { slug: "ceo" }), node("s", "squad"));
    graph.edges.push(edge("1", "b", "c", "briefs"), edge("2", "b", "s", "briefs"), edge("3", "c", "e", "owns"), edge("4", "e", "s", "staffs"));
    const check = validateGraphProtocol(graph).checks.find((c) => c.name === "materialization-adapter");
    expect(check?.ok).toBeFalse();
    expect(check?.message).toContain("relationship edges");
  });
});

// ── exporters ───────────────────────────────────────────────────────────────

describe("exporters", () => {
  test("planExport splits the graph correctly", () => {
    const graph = g();
    graph.nodes.push(node("c", "company"), node("e", "employee"), node("s", "squad"), node("m", "mind_clone"));
    graph.edges.push(edge("1", "c", "e", "owns"));
    const plan = planExport(graph);
    expect(plan.businesses.length).toBe(1);
    expect(plan.squads.length).toBe(1);
    expect(plan.clones.length).toBe(1);
    expect(plan.employees.length).toBe(1);
    expect(plan.employees[0].parentType).toBe("company");
  });

  test("business.yaml scaffold carries the studio reference", () => {
    const n = node("c", "company", { slug: "podcast-empire", description: "Empire", domains: ["podcasts"], template: "custom" });
    const yaml = scaffoldBusinessYaml(n, { employees: ["ceo"] });
    expect(yaml).toContain("slug: \"podcast-empire\"");
    expect(yaml).toContain("studio:");
    expect(yaml).toContain("employees:");
  });

  test("squad scaffold uses dotted capabilities", () => {
    const n = node("s", "squad", { slug: "copy-squad", capabilities: ["marketing.copywriting.write"] });
    expect(scaffoldSquadYaml(n)).toContain("marketing.copywriting.write");
  });

  test("clone manifest carries layers", () => {
    const n = node("m", "mind_clone", { slug: "guru", source: "Famous author", one_liner: "deep thinker" });
    expect(scaffoldCloneManifest(n)).toContain("source: \"Famous author\"");
  });

  test("employee md includes mind_clone when embodied", () => {
    const n = node("e", "employee", { slug: "cto", role: "CTO", title: "Tech Lead", mind_clone: "guru" });
    const md = scaffoldEmployeeMd(n, "techco");
    expect(md).toContain("mind_clone: \"guru\"");
    expect(md).toContain("company: \"techco\"");
  });
});

// ── planner merge ───────────────────────────────────────────────────────────

describe("planner merge", () => {
  test("returns the persisted proposal without duplicating its brief", () => {
    const graph = g("planned-company");
    graph.nodes.push(node("brief-current", "brief", { instruction: "create a company" }));
    const proposal = {
      name: "ignored-renaming-attempt",
      reasoning: "minimal company",
      nodes: [
        node("brief-proposed", "brief", { instruction: "create a company" }),
        node("company-proposed", "company", { slug: "planned-company" }),
        node("employee-proposed", "employee", { slug: "ceo" }),
      ],
      edges: [
        edge("briefs-company", "brief-proposed", "company-proposed", "briefs"),
        edge("owns-employee", "company-proposed", "employee-proposed", "owns"),
      ],
    };
    const merged = mergePlanIntoGraph(graph, proposal);
    expect(merged.graph.name).toBe("planned-company");
    expect(merged.graph.nodes.map((n) => n.id)).toContain("company-proposed");
    expect(merged.graph.nodes.filter((n) => n.type === "brief").length).toBe(1);
    expect(merged.graph.edges.some((e) => e.source === "brief-current" && e.target === "company-proposed" && e.type === "briefs")).toBeTrue();
  });
});

// ── persistence round-trip ──────────────────────────────────────────────────

describe("persistence", () => {
  test("save and load round-trip", () => {
    const dir = join(tmpdir(), `nirvana-studio-test-${Date.now()}`);
    const prev = process.env.HOME;
    process.env.HOME = dir;
    try {
      const graph = g("round-trip");
      addNode(graph, node("b", "brief", { instruction: "round trip test" }));
      const file = saveGraph(graph, process.cwd());
      expect(file).toContain("round-trip.json");
      const loaded = loadGraph("round-trip", process.cwd());
      expect(loaded?.name).toBe("round-trip");
      expect(loaded?.nodes[0].payload.instruction).toBe("round trip test");
      expect(deleteGraph("round-trip", process.cwd())).toBeTrue();
      expect(loadGraph("round-trip", process.cwd())).toBeNull();
    } finally {
      process.env.HOME = prev;
      // cleanup
      try { import.meta.require("node:fs").rmSync(dir, { recursive: true, force: true });} catch {}
    }
  });
});
