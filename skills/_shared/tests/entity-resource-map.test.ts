// entity-resource-map.test.ts — the map an entity shows of what it carries.
//
// Written for squads first; businesses needed exactly the same thing, which is
// why there is one implementation. These pin the contract for both consumers,
// including the two asymmetries that exist on purpose: what each kind already
// inlines, and the run state each kind calls by a different name.
//
// The prompt text asserted below is PT-BR because the dispatched model reads it;
// these comments are English because whoever maintains this reads them.
// Runs with: bun test skills/_shared/tests
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderResourceMap } from "../lib/entity-resource-map.ts";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-resmap-")); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

// A fresh root per call: two trees in one test shared the directory, and the
// second saw what the first had created.
let seq = 0;
function tree(spec: Record<string, string[]>): string {
  const root = path.join(tmp, `entity-${seq++}`);
  for (const [dir, files] of Object.entries(spec)) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(root, dir, f), "x");
  }
  return root;
}

const BIZ = { kind: "businesses" as const, inlined: ["employees", "memory"], label: "ESTA EMPRESA", sourceNoun: "da empresa", outputsHint: "o `outputs_root` declarado nos caminhos do projeto" };
const SQ = { kind: "squads" as const, inlined: ["agents", "tasks", "workflows"], label: "ESTE SQUAD", sourceNoun: "do squad" };

describe("the map names what the prompt does not carry", () => {
  test("business: playbooks, standards and rubrics appear; employees and memory do not", () => {
    const dir = tree({
      employees: ["ceo.md", "cto.md"],
      memory: ["permanent.md"],
      playbooks: ["reuse-vs-create.md"],
      standards: ["PDF.md"],
      rubrics: ["gate.md"],
    });
    const m = renderResourceMap(dir, BIZ);
    expect(m).toContain("## O QUE MAIS ESTA EMPRESA CARREGA");
    expect(m).toContain("`playbooks/` — `reuse-vs-create.md`");
    expect(m).toContain("`standards/`");
    expect(m).toContain("`rubrics/`");
    // The seat is inlined in full; memory lives in `.nirvana` since the
    // architecture change, and what remains here is a seed already consumed.
    expect(m).not.toContain("`employees/`");
    expect(m).not.toContain("`memory/`");
  });

  test("squad: the same map, with a different inlined set", () => {
    const dir = tree({ agents: ["a.md"], tasks: ["t.md"], references: ["r.md"] });
    const m = renderResourceMap(dir, SQ);
    expect(m).toContain("## O QUE MAIS ESTE SQUAD CARREGA");
    expect(m).toContain("`references/`");
    expect(m).not.toContain("`agents/`");
  });

  test("nothing beyond the inlined: no section at all, rather than an empty one", () => {
    expect(renderResourceMap(tree({ employees: ["ceo.md"] }), BIZ)).toBe("");
    expect(renderResourceMap(tree({ agents: ["a.md"] }), SQ)).toBe("");
  });

  test("an empty directory is a directory with nothing to open", () => {
    const dir = tree({ employees: ["ceo.md"] });
    fs.mkdirSync(path.join(dir, "playbooks"), { recursive: true });
    expect(renderResourceMap(dir, BIZ)).toBe("");
  });
});

describe("what the map never names", () => {
  // Run state has ONE owner, `isRunStatePath`, and it answers differently per
  // kind: a business accumulates in `memory/projects` and `projects/`, a squad in
  // `.runs`. A local copy of that list here is the way back to advertising — and
  // then shipping — what must never travel.
  test("business: outputs and projects stay out", () => {
    const dir = tree({ employees: ["ceo.md"], playbooks: ["p.md"], projects: ["run-1.md"], outputs: ["o.md"] });
    const m = renderResourceMap(dir, BIZ);
    expect(m).toContain("`playbooks/`");
    expect(m).not.toContain("`projects/`");
    expect(m).not.toContain("`outputs/`");
  });

  test("squad: .runs stays out", () => {
    const dir = tree({ agents: ["a.md"], references: ["r.md"], ".runs": ["x.md"] });
    const m = renderResourceMap(dir, SQ);
    expect(m).toContain("`references/`");
    expect(m).not.toContain(".runs");
  });

  test("build and dependency output never enter", () => {
    const dir = tree({ employees: ["ceo.md"], playbooks: ["p.md"], node_modules: ["index.js"], dist: ["b.js"] });
    const m = renderResourceMap(dir, BIZ);
    expect(m).not.toContain("node_modules");
    expect(m).not.toContain("`dist/`");
  });
});

describe("the index ceiling", () => {
  // A real cap, and deliberately NOT the silent cut this codebase spent a day
  // undoing: a directory index is recoverable with one `ls` against a tree the
  // dispatch already grants, and the overflow line says exactly that.
  test("a huge directory is capped, and says how many are left and how to see them", () => {
    const many = Array.from({ length: 130 }, (_, i) => `f-${String(i).padStart(3, "0")}.md`);
    const dir = tree({ employees: ["ceo.md"], data: many });
    const m = renderResourceMap(dir, BIZ);
    expect(m).toContain("`f-000.md`");
    expect(m).toContain("e mais 80");
    expect(m).toContain("`ls`");
    expect(Buffer.byteLength(m, "utf8")).toBeLessThan(4_096);
  });
});

describe("the prose promises nothing it cannot keep", () => {
  test("it says which tree it means, and that the tree is read-only", () => {
    const dir = tree({ employees: ["ceo.md"], playbooks: ["p.md"] });
    const m = renderResourceMap(dir, BIZ);
    expect(m).toContain("a fonte da empresa");
    expect(m).toContain("**é somente leitura para você**");
    expect(m).toContain("outputs_root");
    expect(m).toContain(dir);
    // Nothing here was summarized: the index is names, the content is on disk.
    expect(m).toContain("o arquivo em disco é o conteúdo");
  });

  test("an unreadable directory does not take down the prompt", () => {
    expect(renderResourceMap(path.join(tmp, "does-not-exist"), BIZ)).toBe("");
  });
});
