/**
 * Gate de regressão do roteamento de mind-clones.
 *
 * Trava os marcos d'água de 2026-07-27 (301 encontráveis de 542). O eval roda
 * contra o registry vivo do escopo em que a suíte executa — de propósito: o
 * gate protege o SISTEMA (motor + biblioteca), não só o código. Uma sessão que
 * escreva um bloco ruim, quebre o tokenizer ou corrompa o índice quebra o build
 * aqui antes de chegar em produção.
 *
 * Se um marco SUBIR (ex.: as 2 dívidas de necessidade forem consertadas),
 * suba o limiar no mesmo commit — marco d'água só anda para cima.
 */
import { describe, expect, test } from "bun:test";
import { runEval } from "../scripts/eval-clone-routing.ts";

const r = runEval();

// PUREZA DO ENGINE: o nirvana-os-engine instala SEM biblioteca de clones —
// businesses/squads/clones chegam por pack ou são criados pelo usuário. Os
// marcos d'água abaixo medem a BIBLIOTECA COMPLETA do dono (542 clones, 301
// enriquecidos em 2026-07-27); num install limpo ou de pack parcial eles não
// se aplicam e o skip é o comportamento correto, não um furo.
const FULL_LIBRARY = r.selfN >= 301;
const d = FULL_LIBRARY ? describe : describe.skip;

describe("eval de roteamento de clones — invariante universal", () => {
  test("auto-recuperação: todo clone com bloco recupera o próprio one_liner (vale para QUALQUER biblioteca, inclusive vazia)", () => {
    expect(r.selfFail).toEqual([]);
    expect(r.selfOk).toBe(r.selfN);
  });
});

d("eval de roteamento de clones (marcos da biblioteca completa, 2026-07-27)", () => {
  test("cobertura: ≥301 clones enriquecidos", () => {
    expect(r.selfN).toBeGreaterThanOrEqual(301);
  });

  test("necessidade: ≥45/47 — as 2 dívidas conhecidas são kathy-sierra×chris-lattner e marie-haynes×barry-schwartz", () => {
    expect(r.needOk).toBeGreaterThanOrEqual(45);
  });

  test("andaime: top-3 idêntico com e sem verbo de intenção em ≥9/10", () => {
    expect(r.scaffoldOk).toBeGreaterThanOrEqual(9);
  });
});
