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
