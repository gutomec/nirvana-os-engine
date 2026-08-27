// plan-compiler.test.ts — a plan graph compiles to the multi-target manifest;
// it never becomes a second executor.
//
// Locks the projection constraint at its narrowest point: the compiler's
// output is exactly the manifest shape the orchestration loop already runs
// (phases[].depends_on / consumed_by / parallel_waves), so a drawn plan and a
// hand-written multi-target run are indistinguishable downstream.

import { describe, expect, test } from "bun:test";
import { compileManifest } from "../lib/plan-compiler.ts";
import type { DependencyGraph } from "../../_shared/lib/dependency-graph.ts";

const n = (id: string, type: DependencyGraph["nodes"][number]["type"]) => ({ id, type });
const e = (id: string, source: string, target: string, type: DependencyGraph["edges"][number]["type"]) =>
  ({ id, source, target, type });

describe("compileManifest", () => {
  test("a chain compiles to ordered phases with depends_on and consumed_by", () => {
    const g: DependencyGraph = {
      nodes: [n("brief-1", "brief"), n("company-a", "company"), n("employee-a", "employee")],
      edges: [e("e1", "brief-1", "company-a", "briefs"), e("e2", "company-a", "employee-a", "owns")],
    };
    const { manifest, issues } = compileManifest(g);
    expect(issues).toEqual([]);
    const byId = Object.fromEntries(manifest!.phases.map((p) => [p.id, p]));
    expect(byId["company-a"].depends_on).toEqual(["brief-1"]);
    expect(byId["company-a"].consumed_by).toEqual(["employee-a"]);
    expect(byId["employee-a"].depends_on).toEqual(["company-a"]);
    expect(manifest!.parallel_waves.flat().length).toBe(3);
  });

  test("a diamond yields a wave with two parallel targets", () => {
    const g: DependencyGraph = {
      nodes: [n("brief-1", "brief"), n("company-a", "company"), n("squad-b", "squad"), n("deliv-1", "deliverable")],
      edges: [
        e("e1", "brief-1", "company-a", "briefs"),
        e("e2", "brief-1", "squad-b", "briefs"),
        e("e3", "company-a", "deliv-1", "yields"),
        e("e4", "squad-b", "deliv-1", "yields"),
      ],
    };
    // both arms feed the same deliverable: company and squad share a wave.
    const { manifest, issues } = compileManifest(g);
    expect(issues).toEqual([]);
    const wave2 = manifest!.parallel_waves[1];
    expect(wave2.sort()).toEqual(["company-a", "squad-b"]);
  });

  test("the reversed edge orders the clone phase first", () => {
    const g: DependencyGraph = {
      nodes: [n("employee-a", "employee"), n("clone-x", "mind_clone")],
      edges: [e("e1", "employee-a", "clone-x", "embodies")],
    };
    const { manifest } = compileManifest(g);
    expect(manifest!.phases.map((p) => p.id)).toEqual(["clone-x", "employee-a"]);
    expect(manifest!.phases[1].depends_on).toEqual(["clone-x"]);
  });

  test("a cycle is an issue, never a throw, and no manifest ships", () => {
    const g: DependencyGraph = {
      nodes: [n("squad-a", "squad"), n("squad-b", "squad")],
      edges: [
        e("e1", "squad-a", "squad-b", "depends_on"),
        e("e2", "squad-b", "squad-a", "depends_on"),
      ],
    };
    const { manifest, issues } = compileManifest(g);
    expect(manifest).toBeNull();
    expect(issues.some((i) => i.message.includes("cycle"))).toBeTrue();
  });
});

describe("compileManifest with agent nodes", () => {
  test("an agent node compiles to target agent/<id> under agents/<id>/outputs/, ordered like a squad", () => {
    const g: DependencyGraph = {
      nodes: [n("brief-1", "brief"), n("squad-a", "squad"), n("role-writer", "agent"), n("squad-b", "squad"), n("deliv-1", "deliverable")],
      edges: [
        e("e1", "brief-1", "squad-a", "briefs"),
        e("e2", "role-writer", "squad-a", "depends_on"),
        e("e3", "squad-b", "role-writer", "depends_on"),
        e("e4", "squad-b", "deliv-1", "yields"),
      ],
    };
    const { manifest, issues } = compileManifest(g);
    expect(issues).toEqual([]);
    const role = manifest!.phases.find((p) => p.id === "role-writer")!;
    expect(role).toEqual({
      id: "role-writer", target: "agent/role-writer", status: "pending",
      depends_on: ["squad-a"], consumed_by: ["squad-b"], outputs_path: "agents/role-writer/outputs/",
    });
    expect(manifest!.parallel_waves).toEqual([["brief-1"], ["squad-a"], ["role-writer"], ["squad-b"], ["deliv-1"]]);
  });
});

// ── inherited squad composition (Squad Protocol v6 §31) ──────────────────────
// The plan reads the protocol instead of demanding manual authorship: when the
// entity graph already says squad A requires a capability squad B provides, a
// plan naming both gets that order for free. It never overrides the author, and
// a plan whose squads declare no composition compiles exactly as before.

const composition = (...pairs: [string, string][]): DependencyGraph => ({
  nodes: [...new Set(pairs.flat())].map((slug) => ({ id: `squad:${slug}`, type: "squad" as const, payload: { slug } })),
  edges: pairs.map(([consumer, provider]) => ({
    id: `depends_on:${consumer}->${provider}`,
    source: `squad:${consumer}`,
    target: `squad:${provider}`,
    type: "depends_on" as const,
  })),
});

describe("compileManifest inherits squad→squad composition", () => {
  const plan: DependencyGraph = {
    nodes: [n("brief-1", "brief"), n("squad:consumer", "squad"), n("squad:provider", "squad")],
    edges: [e("e1", "brief-1", "squad:consumer", "briefs"), e("e2", "brief-1", "squad:provider", "briefs")],
  };

  test("an undeclared pair inherits the order the protocol already knows", () => {
    const { manifest, issues } = compileManifest(plan, { composition: composition(["consumer", "provider"]) });
    expect(issues).toEqual([]);
    const byId = Object.fromEntries(manifest!.phases.map((p) => [p.id, p]));
    expect(byId["squad:consumer"].depends_on).toEqual(["brief-1", "squad:provider"]);
    expect(byId["squad:provider"].consumed_by).toEqual(["squad:consumer"]);
    expect(manifest!.parallel_waves).toEqual([["brief-1"], ["squad:provider"], ["squad:consumer"]]);
  });

  test("a node id without the squad: prefix matches by payload slug", () => {
    const bySlug: DependencyGraph = {
      nodes: [
        { id: "phase-a", type: "squad", payload: { slug: "consumer" } },
        { id: "phase-b", type: "squad", payload: { slug: "provider" } },
      ],
      edges: [],
    };
    const { manifest } = compileManifest(bySlug, { composition: composition(["consumer", "provider"]) });
    expect(manifest!.phases.map((p) => p.id)).toEqual(["phase-b", "phase-a"]);
  });

  test("the author wins: a declared edge is never duplicated nor reversed", () => {
    const authored: DependencyGraph = {
      nodes: plan.nodes,
      edges: [...plan.edges, e("e3", "squad:provider", "squad:consumer", "depends_on")],
    };
    // the composition says the opposite direction; the plan keeps its own.
    const { manifest, issues } = compileManifest(authored, { composition: composition(["consumer", "provider"]) });
    expect(issues).toEqual([]);
    const byId = Object.fromEntries(manifest!.phases.map((p) => [p.id, p]));
    expect(byId["squad:provider"].depends_on).toEqual(["brief-1", "squad:consumer"]);
    expect(byId["squad:consumer"].depends_on).toEqual(["brief-1"]);
  });

  test("a plan whose squads declare no composition compiles byte-identically", () => {
    const before = compileManifest(plan);
    const withGraph = compileManifest(plan, { composition: composition(["other-a", "other-b"]) });
    expect(withGraph.issues).toEqual(before.issues);
    expect(JSON.stringify(withGraph.manifest)).toBe(JSON.stringify(before.manifest));
    // and with no composition option at all, which is every caller today
    expect(JSON.stringify(compileManifest(plan, {}).manifest)).toBe(JSON.stringify(before.manifest));
  });

  test("only squad nodes inherit: a company pair with the same slugs is untouched", () => {
    const companies: DependencyGraph = {
      nodes: [n("squad:consumer", "company"), n("squad:provider", "company")],
      edges: [],
    };
    const { manifest } = compileManifest(companies, { composition: composition(["consumer", "provider"]) });
    expect(manifest!.phases.every((p) => p.depends_on.length === 0)).toBeTrue();
  });
});
