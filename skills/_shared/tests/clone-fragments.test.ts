// Regressão do orçamento de fragmento do clone-resolver.
//
// O defeito que estes testes guardam: o corte era `lastIndexOf("\n", budget)`
// sobre o texto já colado. Como a ordem de montagem é SOUL → L1 → camadas da
// fase → coherence_map, a cauda cortada era sempre a ÚLTIMA camada pedida, ou
// seja exatamente a que a política de fase escolheu, enquanto o L1 (que entra em
// toda fase) sobrevivia intacto. Medido em 2026-07-26: 175 dos 548 clones eram
// amputados assim, e nenhum erro era emitido.
//
// Invariante que não pode voltar a quebrar: no caminho fragmentado, o orçamento
// descarta UNIDADE INTEIRA ou não descarta nada. Nunca corta no meio.

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const MARCA_DE_CORTE = "persona truncada";

// O resolver localiza clones por ESCOPO e exige MANIFEST.yaml. Montamos um
// projeto isolado em tmp e apontamos o escopo para ele ANTES de importar o
// resolver, para o teste não depender da biblioteca real do usuário.
const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-scope-"));
fs.mkdirSync(path.join(RAIZ, "mind-clones"), { recursive: true });
process.env.NIRVANA_SCOPE = "project";
process.env.NIRVANA_PROJECT_ROOT = RAIZ;
process.env.NIRVANA_SCOPE_QUIET = "1";

const { resolveClonePersona } = await import("../lib/clone-resolver.ts");

let seq = 0;
/** Cria um clone-fixture no escopo e devolve o slug. */
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
  // L1 entra sempre, além das pedidas.
  expect(r!.layers_injected).toEqual(["L1", "L3", "L4"]);
});

test("fragmento ACIMA do orçamento sai completo, nunca cortado no meio", () => {
  const dir = tmpClone(20000);
  const r = resolveDir(dir, { depth: "fragments", layers: ["L3", "L4"], byteBudget: 4000 });
  expect(r).not.toBeNull();
  expect(r!.content).not.toContain(MARCA_DE_CORTE);
  expect(r!.bytes).toBeGreaterThan(4000);
  // A camada que a fase pediu tem que estar lá — era ela que morria antes.
  expect(r!.content).toContain("item de framework");
  expect(r!.layers_injected).toContain("L4");
});

test("a camada específica da fase sobrevive tanto quanto a camada sempre-injetada", () => {
  const dir = tmpClone(20000);
  const r = resolveDir(dir, { depth: "fragments", layers: ["L4"], byteBudget: 3000 })!;
  // O corte antigo preservava L1 (primeiro) e matava L4 (último). Ambos devem estar.
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
  // O caminho fragmentado não lia o AGENT.md, e isso não era "seleção por
  // camada": era trocar a definição operacional do agente pelo schema derivado.
  // Medido em 2026-07-27: o AGENT.md é 36% de tudo que o full injeta, e é onde
  // vivem Limitations, Commands e `What You Refuse to Do`. Num teste cego de 5
  // pares, a persona inteira venceu 4x1 — e um juiz decidiu explicitamente por
  // `Limitations`, seção que o fragmento não tinha como enxergar.
  const slug = tmpClone(300);
  const r = resolveDir(slug, { depth: "fragments", layers: ["L3", "L4"], byteBudget: 16000 })!;
  expect(r.depth).toBe("fragments");
  expect(r.content).toContain("corpo do agente");   // AGENT.md presente
  expect(r.content).toContain("voz da persona");    // SOUL.md presente
  expect(r.content).toContain("item de heuristica"); // camada da fase presente
});
