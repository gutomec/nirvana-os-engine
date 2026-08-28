// graph-command.test.ts — `nrv graph` answers "what does this execution
// need?" exactly, and the graph layer stays OFF the dispatch hot path.
//
// The closure fixture reproduces the tracking-360 shape at small scale: a
// business whose employees declare N clones while the pack carries a subset.
// The old resolution (556 recursive greps against employee prose) found 5 of
// 17 on the real business; the closure query must return every declared
// clone with the absent ones flagged, not silently dropped.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const SCRIPT = join(REPO, "skills", "harness", "scripts", "graph.ts");

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graph-cmd-"));
  const biz = join(dir, "businesses", "t360");
  mkdirSync(join(biz, "employees"), { recursive: true });
  writeFileSync(join(biz, "business.yaml"), "name: t360\n");
  writeFileSync(join(biz, "employees", "emp-1.md"), "---\nassigned_mind_clones:\n  - expert-a\n---\n# e1\n");
  writeFileSync(join(biz, "employees", "emp-2.md"), "---\nassigned_mind_clones:\n  - expert-b\n  - expert-c\n---\n# e2\n");
  const clone = join(dir, "mind-clones", "expert-a");
  mkdirSync(clone, { recursive: true });
  writeFileSync(join(clone, "MANIFEST.yaml"), "name: expert-a\n");
  return dir;
}

function run(args: string[]): { out: string; code: number } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { out: `${r.stdout}`, code: r.status ?? 1 };
}

describe("nrv graph closure", () => {
  test("returns the full closure with missing clones flagged (the 17/17 property)", () => {
    const pack = fixture();
    try {
      const { out, code } = run(["closure", "--business", "t360", "--pack", pack, "--json"]);
      expect(code).toBe(0);
      const j = JSON.parse(out);
      const clones = j.nodes.filter((n: { type: string }) => n.type === "mind_clone");
      expect(clones.length).toBe(3);
      expect(j.missing.sort()).toEqual(["expert-b", "expert-c"]);
    } finally {
      rmSync(pack, { recursive: true, force: true });
    }
  });

  test("unknown business is a named error, exit 1", () => {
    const pack = fixture();
    try {
      const r = spawnSync(process.execPath, [SCRIPT, "closure", "--business", "ghost", "--pack", pack], { encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("not found");
    } finally {
      rmSync(pack, { recursive: true, force: true });
    }
  }, spawnBudgetMs(2));
});

describe("nrv graph order and check", () => {
  test("order puts mind-clones before businesses", () => {
    const pack = fixture();
    try {
      const { out, code } = run(["order", "--pack", pack, "--json"]);
      expect(code).toBe(0);
      const j = JSON.parse(out);
      expect(j.kind_order.indexOf("mind-clones")).toBeLessThan(j.kind_order.indexOf("businesses"));
      expect(j.has_cycle).toBeFalse();
    } finally {
      rmSync(pack, { recursive: true, force: true });
    }
  });

  test("check --strict exits 1 when bindings do not resolve", () => {
    const pack = fixture();
    try {
      const { out, code } = run(["check", "--pack", pack, "--strict", "--json"]);
      expect(code).toBe(1);
      const j = JSON.parse(out);
      expect(j.missing.map((m: { clone: string }) => m.clone).sort()).toEqual(["expert-b", "expert-c"]);
    } finally {
      rmSync(pack, { recursive: true, force: true });
    }
  });
});

describe("the graph layer stays off the dispatch hot path", () => {
  // Constraint 5 of the integration report: single-target briefs pay zero
  // graph tax. The static proof: no dispatch/route/index code path imports
  // the graph libs — only graph.ts, the installer and the bindings gate do.
  test("route, dispatch and index import no graph lib", () => {
    for (const f of [
      join(REPO, "skills", "harness", "scripts", "route.ts"),
      join(REPO, "skills", "harness", "lib", "dispatch.ts"),
      join(REPO, "skills", "harness", "lib", "dispatch-cascade.ts"),
      join(REPO, "skills", "harness", "scripts", "index.ts"),
      join(REPO, "skills", "harness", "lib", "delivery-pipeline.ts"),
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src.includes("dependency-graph") || src.includes("entity-graph")).toBeFalse();
    }
  });
});

// ── squad composition reporting ─────────────────────────────────────────────
// `requires` that resolves to nothing is a broken declaration: the squad says
// it needs a capability the library does not carry, and no ordering can fix it,
// so --strict fails. Ambiguity is a different animal — the capability EXISTS,
// twice — and it stays a report: erroring would fail the whole library on the
// duplicate ids it already carries.

function squadFixture(capabilities: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "graph-comp-"));
  for (const [slug, body] of Object.entries(capabilities)) {
    mkdirSync(join(dir, "squads", slug), { recursive: true });
    writeFileSync(join(dir, "squads", slug, "squad.yaml"), `name: ${slug}\nversion: 1.0.0\nprotocol: "6.0"\n${body}`);
  }
  return dir;
}

describe("nrv graph check reports squad composition", () => {
  test("an unresolved requires fails --strict and names the ref", () => {
    const pack = squadFixture({
      consumer: "capabilities:\n  - id: content.social.plan\n    requires:\n      - design.brand.identity\n",
    });
    try {
      const { out, code } = run(["check", "--pack", pack, "--strict", "--json"]);
      expect(code).toBe(1);
      const j = JSON.parse(out);
      expect(j.composition.map((c: { code: string; ref: string }) => [c.code, c.ref]))
        .toEqual([["x_requires_unresolved", "design.brand.identity"]]);
    } finally {
      rmSync(pack, { recursive: true, force: true });
    }
  });

  test("an ambiguous requires is reported, never fatal, and creates no edge", () => {
    const pack = squadFixture({
      "provider-a": "capabilities:\n  - id: design.brand.identity\n",
      "provider-b": "capabilities:\n  - id: design.brand.identity\n",
      consumer: "capabilities:\n  - id: content.social.plan\n    requires:\n      - design.brand.identity\n",
    });
    try {
      const { out, code } = run(["check", "--pack", pack, "--strict", "--json"]);
      expect(code).toBe(0);
      const j = JSON.parse(out);
      expect(j.issues).toEqual([]);
      expect(j.composition.map((c: { code: string; candidates: string[] }) => [c.code, c.candidates]))
        .toEqual([["x_requires_ambiguous", ["provider-a", "provider-b"]]]);
    } finally {
      rmSync(pack, { recursive: true, force: true });
    }
  });

  test("a resolved composition is silent and shows up in the order", () => {
    const pack = squadFixture({
      provider: "capabilities:\n  - id: design.brand.identity\n    produces:\n      - brand_kit\n",
      consumer: "capabilities:\n  - id: content.social.plan\n    consumes:\n      - brand_kit\n",
    });
    try {
      expect(run(["check", "--pack", pack, "--strict", "--json"]).code).toBe(0);
      expect(JSON.parse(run(["check", "--pack", pack, "--json"]).out).composition).toEqual([]);
      const order = JSON.parse(run(["order", "--pack", pack, "--json"]).out);
      expect(order.order).toEqual(["squad:provider", "squad:consumer"]);
    } finally {
      rmSync(pack, { recursive: true, force: true });
    }
  });
});
