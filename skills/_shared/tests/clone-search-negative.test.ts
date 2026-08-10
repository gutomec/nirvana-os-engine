/**
 * Clone-search negative coverage gate (routing-360 Phase 3.3).
 *
 * The old usefulness gate was `normalized >= 0.5` — vacuous by construction:
 * BM25 normalizes by the max score, so the top hit of ANY query is 1.0, and an
 * out-of-domain brief ("consertar a bomba hidráulica do trator") always
 * injected some clone. The gate is now the router-mirroring coverage gate
 * (bm25.coverage + bm25.coverageBelowGate, carried on each CloneHit as
 * `below_gate`): out-of-domain briefs must yield NO hit clearing the gate,
 * while legitimate need-phrased briefs must keep clearing it.
 *
 * Runs against the live registry on purpose (same policy as
 * clone-routing-eval.test.ts): the gate protects the SYSTEM. On a clean
 * install / partial pack the vocabulary truth differs — skip.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { findCloneForTask } from "../lib/clone-search.ts";
import { loadCloneRegistry } from "../lib/clone-resolver.ts";

// Order-independence: clone-fragments.test.ts points NIRVANA_SCOPE /
// NIRVANA_PROJECT_ROOT at a tmp fixture AT MODULE SCOPE and never restores,
// so any registry read after that file loads resolves an EMPTY fixture
// library. This suite must read the real scope (cwd walk-up), whatever the
// load order — clear the override for the guard and for the test bodies,
// restore afterwards.
const SCOPE_ENV_KEYS = ["NIRVANA_SCOPE", "NIRVANA_PROJECT_ROOT"] as const;
const savedEnv = new Map<string, string | undefined>();
function clearScopeOverride() {
  for (const k of SCOPE_ENV_KEYS) {
    if (!savedEnv.has(k)) savedEnv.set(k, process.env[k]);
    delete process.env[k];
  }
}
function restoreScopeOverride() {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

clearScopeOverride();
const FULL_LIBRARY = Object.keys(loadCloneRegistry()).length >= 300;
restoreScopeOverride();

const d = FULL_LIBRARY ? describe : describe.skip;

beforeAll(clearScopeOverride);
afterAll(restoreScopeOverride);

// Out-of-domain briefs: no clone in the library owns this vocabulary. Every
// returned hit must carry below_gate=true, so injection consumers
// (team-orchestrator squadCloneInjection, employee-prompt resolveClonesByPriority)
// inject NOTHING and fall through to "PADRÃO — nenhum clone útil".
const OUT_OF_DOMAIN = [
  "consertar a bomba hidráulica do trator",
  "receita de bolo de cenoura com cobertura de chocolate",
  "qual o melhor pneu para caminhonete andar na lama",
  "trocar a resistência do chuveiro que parou de esquentar",
  "adestrar um filhote de pastor alemão a não puxar a guia",
];

// In-domain sanity: the gate must NOT starve legitimate need-phrased briefs
// (mirrors two NEED-axis cases of eval-clone-routing.ts).
const IN_DOMAIN = [
  "preciso conseguir mais links apontando para o meu site",
  "avaliação heurística com severity rating",
];

d("clone-search — coverage gate (negativos fora de domínio)", () => {
  for (const brief of OUT_OF_DOMAIN) {
    test(`fora de domínio injeta NADA: "${brief.slice(0, 44)}"`, () => {
      const hits = findCloneForTask(brief, { limit: 5 });
      const clearing = hits.filter((h) => h.below_gate === false);
      expect(clearing).toEqual([]);
    });
  }

  for (const brief of IN_DOMAIN) {
    test(`em domínio segue passando o gate: "${brief.slice(0, 44)}"`, () => {
      const hits = findCloneForTask(brief, { limit: 5 });
      expect(hits.some((h) => h.below_gate === false)).toBe(true);
    });
  }

  test("todo hit carrega coverage {matched, total} e below_gate booleano", () => {
    const hits = findCloneForTask("plano de mídia paga para o lançamento", { limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(typeof h.below_gate).toBe("boolean");
      expect(typeof h.coverage.total).toBe("number");
    }
  });
});
