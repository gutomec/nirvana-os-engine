// entity-graph.test.ts — the declaration reader that builds the typed graph.
//
// Locks the two regressions the original gate's comments record: (1) a
// `dna_reference` path read by its last segment yields "AGENT" — six
// businesses were once reported "missing AGENT" for that; (2) a dna/ holding
// only a README.md once counted as a clone named "README". Fixtures live in
// mkdtemp because check-engine-purity walks the whole repo tree and a fixture
// business.yaml inside it would fail the gate.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEntityGraph, readCloneBindings, refToSlug, slugOf } from "../lib/entity-graph.ts";
import { buildOrderOrThrow, closure } from "../lib/dependency-graph.ts";

const roots: string[] = [];
function packFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "entity-graph-"));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function business(dir: string, slug: string, employees: Record<string, string>) {
  const b = join(dir, "businesses", slug);
  mkdirSync(join(b, "employees"), { recursive: true });
  writeFileSync(join(b, "business.yaml"), `name: ${slug}\n`);
  for (const [name, fm] of Object.entries(employees)) {
    writeFileSync(join(b, "employees", `${name}.md`), `---\n${fm}\n---\n\n# ${name}\n`);
  }
  return b;
}
function clone(dir: string, slug: string) {
  mkdirSync(join(dir, "mind-clones", slug), { recursive: true });
}

describe("readCloneBindings", () => {
  test("category-prefixed refs, dna_reference paths and dna/ symlink dirs all resolve to slugs", () => {
    const pack = packFixture();
    clone(pack, "jane-friedman");
    clone(pack, "michael-thaut-music-therapist");
    const b = business(pack, "biz-a", {
      "writer": "assigned_mind_clones:\n  - 21-media-moguls/jane-friedman",
      "therapist": "dna_reference: dna/michael-thaut-music-therapist/agent/AGENT.md",
    });
    // dna/ with only a README must contribute nothing (the medwork360 regression)
    mkdirSync(join(b, "dna"));
    writeFileSync(join(b, "dna", "README.md"), "not a clone\n");

    const scan = readCloneBindings({
      businessesDir: join(pack, "businesses"),
      clonesDir: join(pack, "mind-clones"),
    });
    expect(scan.businesses).toEqual(["biz-a"]);
    expect(scan.bindings.map((x) => x.clone).sort()).toEqual([
      "jane-friedman",
      "michael-thaut-music-therapist",
    ]);
    // the AGENT regression stays dead
    expect(scan.bindings.some((x) => x.clone === "AGENT")).toBeFalse();
    expect(scan.availableClones.has("jane-friedman")).toBeTrue();
  });

  test("a clone the pack does not carry is a binding, not an omission", () => {
    const pack = packFixture();
    business(pack, "biz-b", { "ceo": "assigned_mind_clones:\n  - ghost-expert" });
    const scan = readCloneBindings({
      businessesDir: join(pack, "businesses"),
      clonesDir: join(pack, "mind-clones"),
    });
    expect(scan.bindings.length).toBe(1);
    expect(scan.availableClones.has("ghost-expert")).toBeFalse();
  });

  test("a dangling dna/ symlink is reported as its own broken binding", () => {
    const pack = packFixture();
    const b = business(pack, "biz-c", {});
    mkdirSync(join(b, "dna"));
    try {
      symlinkSync(join(pack, "nowhere", "gone-expert"), join(b, "dna", "gone-expert"));
    } catch {
      // Runner without symlink privilege (some Windows setups): nothing to assert.
      return;
    }
    const scan = readCloneBindings({
      businessesDir: join(pack, "businesses"),
      clonesDir: join(pack, "mind-clones"),
    });
    const rows = scan.bindings.filter((x) => x.clone === "gone-expert");
    expect(rows.length).toBe(2);
    expect(rows[0].dangling).toBeUndefined();
    expect(rows[1].dangling).toBeTrue();
  });

  test("slug helpers", () => {
    expect(slugOf("21-media-moguls/jane-friedman")).toBe("jane-friedman");
    expect(slugOf("flat-slug")).toBe("flat-slug");
    expect(refToSlug("dna/michael-thaut-music-therapist/agent/AGENT.md")).toBe("michael-thaut-music-therapist");
    expect(refToSlug("AGENT.md")).toBeNull();
  });
});

describe("buildEntityGraph", () => {
  test("the tracking-360 shape: closure of a business names every clone, missing ones flagged", () => {
    const pack = packFixture();
    // 3 employees → 3 clones; the pack carries only 1 (the live defect, scaled down)
    clone(pack, "expert-a");
    business(pack, "t360", {
      "emp-1": "assigned_mind_clones:\n  - expert-a",
      "emp-2": "assigned_mind_clones:\n  - expert-b",
      "emp-3": "dna_reference: dna/expert-c/agent/AGENT.md",
    });
    const g = buildEntityGraph({
      businessesDir: join(pack, "businesses"),
      clonesDir: join(pack, "mind-clones"),
    });
    const c = closure(g, ["business:t360"]);
    const clones = c.nodes.filter((n) => n.type === "mind_clone");
    expect(clones.map((n) => n.payload?.slug).sort()).toEqual(["expert-a", "expert-b", "expert-c"]);
    expect(clones.filter((n) => n.payload?.missing).map((n) => n.payload?.slug).sort())
      .toEqual(["expert-b", "expert-c"]);
    // dependency order: every clone before its employee, employees after the business exists
    const order = buildOrderOrThrow(g).map((n) => n.id);
    for (const emp of ["employee:t360/emp-1", "employee:t360/emp-2", "employee:t360/emp-3"]) {
      expect(order.indexOf("business:t360")).toBeLessThan(order.indexOf(emp));
    }
    expect(order.indexOf("clone:expert-a")).toBeLessThan(order.indexOf("employee:t360/emp-1"));
  });

  test("squads enter as dependency-free nodes when a squads root exists", () => {
    const pack = packFixture();
    mkdirSync(join(pack, "squads", "my-squad"), { recursive: true });
    writeFileSync(join(pack, "squads", "my-squad", "squad.yaml"), "name: my-squad\n");
    const g = buildEntityGraph({
      businessesDir: join(pack, "businesses"),
      clonesDir: join(pack, "mind-clones"),
      squadsDir: join(pack, "squads"),
    });
    expect(g.nodes.map((n) => n.id)).toEqual(["squad:my-squad"]);
    expect(g.edges).toEqual([]);
  });
});
