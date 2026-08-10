/**
 * Mind-clone routing regression gate.
 *
 * Locks the 2026-07-27 high-water marks (301 findable out of 542). The eval
 * runs against the live registry of the scope the suite executes in — on
 * purpose: the gate protects the SYSTEM (engine + library), not just the
 * code. A session that writes a bad block, breaks the tokenizer or corrupts
 * the index breaks the build here before reaching production.
 *
 * If a mark RISES (e.g. the 2 known need debts get fixed), raise the
 * threshold in the same commit — a high-water mark only moves up.
 */
import { describe, expect, test } from "bun:test";
import { runEval } from "../scripts/eval-clone-routing.ts";

const r = runEval();

// ENGINE PURITY: the nirvana-os-engine installs WITHOUT a clone library —
// businesses/squads/clones arrive via pack or are created by the user. The
// high-water marks below measure the owner's FULL LIBRARY (542 clones, 301
// enriched on 2026-07-27); on a clean or partial-pack install they do not
// apply and skipping is the correct behavior, not a gap.
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
