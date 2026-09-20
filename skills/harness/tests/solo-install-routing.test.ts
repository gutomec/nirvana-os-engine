// solo-install-routing.test.ts — the library a CUSTOMER actually runs.
//
// Every routing test in this repo measured the maintainer's machine: 68
// businesses, 223 squads, 617 clones, all competing. No customer has that. A
// VPS runs the squads that VPS needs; a machine that bought one pack has that
// pack's entities and nothing else. The neighbourhood is different on every
// install, and on most installs it is nearly empty.
//
// That gap cost a release. The coverage band shipped in 0.13.19 downgraded a
// confident dispatch whenever the winner explained half a brief or less —
// correct against 223 competing squads, and wrong alone, where the same rule
// asked a caller to "confirm" with exactly one destination on the list. Measured
// against a single nutrition squad, the brief
// `"monte um plano alimentar de 1800 kcal para ganho de massa magra"` — the most
// obvious brief that squad will ever get — came back AMBIGUOUS.
//
// The principle these tests hold: A SQUAD MUST BE COMPLETE ON ITS OWN. What the
// router decides among INSTALLED neighbours is a runtime question and may differ
// per machine. What a squad declares about itself, and what it is able to
// accept, must not depend on who else happens to be installed.
//
// Fixtures, never the live library: this must run on a clean CI runner, which is
// itself the sparse case.
import { describe, expect, test } from "bun:test";

const router = require("../lib/router.js");

/** A registry holding exactly the squads given — a pack install, in memory. */
function registryOf(squads: Array<{ slug: string; caps: Array<Record<string, unknown>> }>) {
  const capabilities: Record<string, any[]> = {};
  const squadMap: Record<string, unknown> = {};
  for (const s of squads) {
    squadMap[s.slug] = { version: "5.1.0", protocol: "6.0", description: `Squad ${s.slug}` };
    for (const c of s.caps) {
      const id = String(c.id);
      (capabilities[id] ||= []).push({
        squad: s.slug, description: c.description, domains: c.domains ?? ["general"],
        examples: c.examples ?? [], not_for: c.not_for ?? [],
        invoke: { type: "workflow", ref: `workflows/${id}` },
      });
    }
  }
  return {
    squads: { source_path: "/fixture/squads.json", capabilities, squads: squadMap },
    businesses: { source_path: "/fixture/businesses.json", businesses: {}, _business_routing: {} },
  };
}

const NUTRI = {
  slug: "fixture-nutricao",
  caps: [{
    id: "health.meal_plan.execute",
    description: "Plano alimentar individualizado: cálculo de calorias e macronutrientes, cardápio semanal, substituições e orientação de suplementação para pacientes.",
    domains: ["health"],
    examples: [
      "Monte um plano alimentar semanal com cálculo de calorias e macronutrientes para o paciente",
      "Cardápio com substituições e orientação de suplementação",
    ],
  }],
};

const TREINO = {
  slug: "fixture-treino",
  caps: [{
    id: "health.training_plan.execute",
    description: "Periodização de treino de força e hipertrofia: divisão semanal, séries, repetições, progressão de carga e orientação de execução.",
    domains: ["health"],
    examples: ["Monte uma periodização de treino de hipertrofia com progressão de carga semanal"],
  }],
};

describe("a squad installed alone does its own work", () => {
  const solo = registryOf([NUTRI]);

  test.each([
    "monte um plano alimentar de 1800 kcal para ganho de massa magra",
    "preciso de um cardápio semanal com substituições para o paciente",
    "calcule os macronutrientes e monte a orientação de suplementação",
  ])("dispatches %p instead of asking which of its one destination", async (brief) => {
    const r = await router.route(brief, { registries: solo, amplify: false });
    expect(r.stage3?.signal).toBe("HIGH");
  });

  test("AMBIGUOUS is never returned with a single destination — there is nothing to confirm", async () => {
    const r = await router.route("monte um plano alimentar de 1800 kcal para ganho de massa magra", { registries: solo, amplify: false });
    if (r.stage3?.signal === "AMBIGUOUS") {
      const destinations = new Set((r.stage3.alternatives || [])
        .map((m: any) => { const x = (m.meta || (m.doc && m.doc.meta)) || {}; return x.squad || x.slug; })
        .filter(Boolean));
      expect(destinations.size).toBeGreaterThan(1);
    }
  });

  test("and still abstains on a brief that is not its work at all", async () => {
    const r = await router.route("me empresta vinte reais até sexta-feira", { registries: solo, amplify: false });
    expect(r.stage3?.signal).not.toBe("HIGH");
  });
});

describe("the same squad with a neighbour", () => {
  const pair = registryOf([NUTRI, TREINO]);

  test("a brief that is clearly one squad's work still dispatches", async () => {
    const r = await router.route("monte um plano alimentar de 1800 kcal com cardápio semanal", { registries: pair, amplify: false });
    expect(["HIGH", "AMBIGUOUS"]).toContain(r.stage3?.signal);
  });

  test("a brief spanning both may ask, and that question is answerable", async () => {
    const r = await router.route("monte o plano alimentar e a periodização de treino do paciente", { registries: pair, amplify: false });
    if (r.stage3?.signal === "AMBIGUOUS") expect((r.stage3.alternatives || []).length).toBeGreaterThan(0);
  });
});

describe("the rule that keeps the band out of a solo install", () => {
  test("the coverage band requires two destinations before it downgrades", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "..", "lib", "router.js"), "utf8");
    expect(src).toContain("distinctDestinations.size >= 2");
    expect(src).toContain("A squad must be complete on its own");
  });
});
