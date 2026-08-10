// Clone-resolver fragment budget regression.
//
// The defect these tests guard: the cut was `lastIndexOf("\n", budget)` over
// the already-joined text. Since the assembly order is SOUL → L1 → phase
// layers → coherence_map, the truncated tail was always the LAST requested
// layer, i.e. exactly the one the phase policy chose, while L1 (which enters
// every phase) survived intact. Measured on 2026-07-26: 175 of the 548 clones
// were amputated this way, and no error was emitted.
//
// Invariant that must never break again: on the fragmented path, the budget
// drops a WHOLE UNIT or drops nothing. It never cuts mid-way.

import { test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const MARCA_DE_CORTE = "persona truncada";

// The resolver locates clones by SCOPE and requires MANIFEST.yaml. We build an
// isolated project in tmp and point the scope at it BEFORE importing the
// resolver, so the test does not depend on the user's real library.
const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-scope-"));
fs.mkdirSync(path.join(RAIZ, "mind-clones"), { recursive: true });
// Module-scope env is process-wide: bun runs test FILES in one process, so a
// value set here and never restored leaks into every file that runs after,
// pointing them at this throwaway library. Snapshot and restore in afterAll.
const ENV_BEFORE = {
  NIRVANA_SCOPE: process.env.NIRVANA_SCOPE,
  NIRVANA_PROJECT_ROOT: process.env.NIRVANA_PROJECT_ROOT,
  NIRVANA_SCOPE_QUIET: process.env.NIRVANA_SCOPE_QUIET,
};
process.env.NIRVANA_SCOPE = "project";
process.env.NIRVANA_PROJECT_ROOT = RAIZ;
process.env.NIRVANA_SCOPE_QUIET = "1";

afterAll(() => {
  for (const [k, v] of Object.entries(ENV_BEFORE)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fs.rmSync(RAIZ, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const { resolveClonePersona } = await import("../lib/clone-resolver.ts");

let seq = 0;
/** Creates a clone fixture in the scope and returns the slug. */
function tmpClone(layerBytes: number, comSchema = true): string {
  const slug = `fixture-${++seq}`;
  const dir = path.join(RAIZ, "mind-clones", slug);
  fs.mkdirSync(path.join(dir, "dna"), { recursive: true });
  fs.writeFileSync(path.join(dir, "MANIFEST.yaml"), `manifest:\n  slug: ${slug}\n`);
  fs.writeFileSync(path.join(dir, "AGENT.md"), "# Fixture\n\ncorpo do agente.");
  fs.writeFileSync(path.join(dir, "SOUL.md"), "# Alma\n\nvoz da persona.");
  if (comSchema) {
    const corpo = (nome: string) =>
      "\n" + `- item de ${nome} suficientemente longo para ocupar espaco.\n`.repeat(Math.max(1, Math.floor(layerBytes / 60)));
    fs.writeFileSync(
      path.join(dir, "dna", "dna-schema.md"),
      ["# DNA",
        "## L1 - Filosofias" + corpo("filosofia"),
        "## L2 - Modelos Mentais" + corpo("modelo"),
        "## L3 - Heuristicas" + corpo("heuristica"),
        "## L4 - Frameworks" + corpo("framework"),
        "## L5 - Metodologias" + corpo("metodologia"),
      ].join("\n\n"),
    );
  }
  return slug;
}

const resolveDir = (slug: string, opts: any) => resolveClonePersona(slug, opts);

test("fragmento cabendo no orçamento sai íntegro e com as camadas pedidas", () => {
  const dir = tmpClone(300);
  const r = resolveDir(dir, { depth: "fragments", layers: ["L3", "L4"], byteBudget: 16000 });
  expect(r).not.toBeNull();
  expect(r!.depth).toBe("fragments");
  expect(r!.content).not.toContain(MARCA_DE_CORTE);
  // L1 always enters, on top of the requested ones.
  expect(r!.layers_injected).toEqual(["L1", "L3", "L4"]);
});

test("fragmento ACIMA do orçamento sai completo, nunca cortado no meio", () => {
  const dir = tmpClone(20000);
  const r = resolveDir(dir, { depth: "fragments", layers: ["L3", "L4"], byteBudget: 4000 });
  expect(r).not.toBeNull();
  expect(r!.content).not.toContain(MARCA_DE_CORTE);
  expect(r!.bytes).toBeGreaterThan(4000);
  // The layer the phase asked for has to be there — it was the one dying before.
  expect(r!.content).toContain("item de framework");
  expect(r!.layers_injected).toContain("L4");
});

test("a camada específica da fase sobrevive tanto quanto a camada sempre-injetada", () => {
  const dir = tmpClone(20000);
  const r = resolveDir(dir, { depth: "fragments", layers: ["L4"], byteBudget: 3000 })!;
  // The old cut preserved L1 (first) and killed L4 (last). Both must be present.
  expect(r.content).toContain("item de filosofia");
  expect(r.content).toContain("item de framework");
});

test("fase diferente seleciona camada diferente", () => {
  const dir = tmpClone(300);
  const plan = resolveDir(dir, { depth: "fragments", layers: ["L4", "L1"], byteBudget: 16000 })!;
  const verify = resolveDir(dir, { depth: "fragments", layers: ["L2", "L1"], byteBudget: 16000 })!;
  expect(plan.content).toContain("item de framework");
  expect(plan.content).not.toContain("item de modelo");
  expect(verify.content).toContain("item de modelo");
  expect(verify.content).not.toContain("item de framework");
});

test("caminho NÃO fragmentado mantém o corte por orçamento", () => {
  const dir = tmpClone(20000);
  const r = resolveDir(dir, { depth: "full", byteBudget: 5000 })!;
  expect(r.content).toContain(MARCA_DE_CORTE);
});

test("clone sem schema legível cai para full em vez de entregar persona vazia", () => {
  const slug = tmpClone(0, false);
  const r = resolveDir(slug, { depth: "fragments", layers: ["L3"], byteBudget: 16000 });
  expect(r).not.toBeNull();
  expect(r!.depth).toBe("full");
  expect(r!.content).toContain("corpo do agente");
});

test("fragmento inclui o AGENT.md — não é resumo da persona, é seleção de camadas", () => {
  // The fragmented path did not read AGENT.md, and that was no
  // "seleção por camada": it swapped the agent's operational definition for the
  // derived schema. Measured on 2026-07-27: AGENT.md is 36% of what full injects,
  // and it is where Limitations, Commands and `What You Refuse to Do` live. In
  // a blind test of 5 pairs, the whole persona won 4x1 — and one judge decided
  // explicitly on `Limitations`, a section the fragment had no way to see.
  const slug = tmpClone(300);
  const r = resolveDir(slug, { depth: "fragments", layers: ["L3", "L4"], byteBudget: 16000 })!;
  expect(r.depth).toBe("fragments");
  expect(r.content).toContain("corpo do agente");   // AGENT.md presente
  expect(r.content).toContain("voz da persona");    // SOUL.md presente
  expect(r.content).toContain("item de heuristica"); // camada da fase presente
});
