// jev-router.test.ts — the layered Jev decider over a fixture library, with a
// local Bun.serve standing in for TypeSafe (TYPESAFE_ENDPOINT points at it).
// No network, no tokens, a fixture key.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clauses, GATE, jevRoute, MAX_PARTS, PART } from "../lib/jev-router.ts";
import { VOICE } from "../lib/jev-voice.ts";
import { answering, choice, startFakeTypesafe, type FakeReply, type FakeTypesafe } from "./helpers/fake-typesafe.ts";

const KEY = "ts-fixture-key";
const provider = (squad: string, description: string, keywords: string[]) => ({ squad, description, keywords, domains: [], produces: [] });
const registries = {
  businesses: { businesses: {
    "launch-house": { description: "Launches finished games on Steam: store page, wishlists, festivals.", produces: ["steam-store-page-kit"], not_for: ["building the game"] },
    "crypto-foundry": { description: "Designs regulated tokens: tokenomics, vesting, legal memos.", produces: ["tokenomics"] },
  } },
  squads: {
    squads: {
      "sherlock-holmes-nirvana": { description: "Investigation squad.", capabilities: ["investigation.case"] },
      "token-forge": { description: "Solana tokens.", capabilities: ["crypto.token.design"], produces: ["tokenomics"] },
    },
    capabilities: {
      "investigation.case": [provider("sherlock-holmes-nirvana", "Investigate a case from fragments", ["investigar", "investigation", "vazamento"])],
      "crypto.token.design": [provider("token-forge", "Design a token and its tokenomics on Solana", ["token", "tokenomics", "solana"])],
    },
    domains: {},
  },
};

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-jev-router-")));
const HOME = path.join(ROOT, "home");
const PROJECT = path.join(ROOT, "project");
const saved = { scope: process.env.NIRVANA_SCOPE, root: process.env.NIRVANA_PROJECT_ROOT };
let fake: FakeTypesafe;
let reply: (body: any) => FakeReply = answering({});

beforeAll(() => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(path.join(PROJECT, ".nirvana"), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, ".nirvana", "project.yaml"), "schema_version: nirvana.project/v1alpha1\n");
  // The library the voice search reads: one person the request can describe without naming.
  const clone = (slug: string, display_name: string, one_liner: string, domains: string[]) => ({ slug, display_name, tags: [], match: { one_liner, domains } });
  fs.writeFileSync(path.join(PROJECT, ".nirvana", ".mind-clones-registry.json"), JSON.stringify({ mind_clones: {
    "vitalik-buterin": clone("vitalik-buterin", "Vitalik Buterin", "Ethereum co-founder: rollups, scaling, protocol design", ["ethereum", "rollups", "scaling", "whitepaper", "protocolo"]),
    "bia-games": clone("bia-games", "Bia Games", "Indie game designer", ["games", "indie"]),
  } }));
  process.env.NIRVANA_SCOPE = "project";
  process.env.NIRVANA_PROJECT_ROOT = PROJECT;
  fake = startFakeTypesafe((body) => reply(body));
});
afterAll(() => {
  fake.stop();
  if (saved.scope === undefined) delete process.env.NIRVANA_SCOPE; else process.env.NIRVANA_SCOPE = saved.scope;
  if (saved.root === undefined) delete process.env.NIRVANA_PROJECT_ROOT; else process.env.NIRVANA_PROJECT_ROOT = saved.root;
  fs.rmSync(ROOT, { recursive: true, force: true });
});
afterEach(() => { fake.requests.length = 0; reply = answering({}); });

const cloneRegistry = () => JSON.parse(fs.readFileSync(path.join(PROJECT, ".nirvana", ".mind-clones-registry.json"), "utf8")).mind_clones;
const route = (brief: string) => jevRoute({
  brief, cwd: PROJECT, registries, cloneRegistry: cloneRegistry(), home: HOME,
  env: { TYPESAFE_API_KEY: KEY, TYPESAFE_ENDPOINT: fake.url, NIRVANA_PROJECT_ROOT: PROJECT },
});

describe("the constants the measurement fixed", () => {
  test("GATE 0.8, PART 0.5, VOICE 0.5, MAX_PARTS 3", () => {
    expect([GATE, PART, VOICE, MAX_PARTS]).toEqual([0.8, 0.5, 0.5, 3]);
  });
});

describe("the decision", () => {
  test("at or above the gate the Jev's answer is the decision, in the routers' contract", async () => {
    reply = answering({ business: choice("launch-house", 0.92, { "crypto-foundry": 0.05 }), squad: choice("none", 0.8), shape: choice("one_business", 0.9) }, 3_000);
    const r = await route("Quero lançar meu jogo indie na Steam com página da loja e wishlists");
    expect(r.escalate).toBe(false);
    expect(r.confidence).toBeCloseTo(0.9, 5);
    expect(r.decision).toMatchObject({ ok: true, kind: "decision", primary_business: "launch-house", mandatory_squads: [], parts: [], runtime: null });
    expect(r.decision.cost_usd).toBeGreaterThan(0);
    const q = fake.requests[0].body.questions;
    expect(Object.keys(q)).toEqual(expect.arrayContaining(["business", "shape"]));
    expect(Object.keys(q.business.criteria)).toEqual(expect.arrayContaining(["launch-house", "none"]));
    expect(q.business.criteria["launch-house"].not_for).toContain("building the game");
  });

  test("the rationale is built from the probabilities, since the Jev writes none", async () => {
    reply = answering({ business: choice("launch-house", 0.92, { "crypto-foundry": 0.05 }), shape: choice("one_business", 0.9) });
    const r = await route("Quero lançar meu jogo indie na Steam com página da loja e wishlists");
    expect(r.decision.rationale).toContain("business launch-house 0.92 (next crypto-foundry 0.05)");
    expect(r.decision.rationale).toContain("shape one_business 0.90");
    expect(r.decision.rationale).toContain(`>= gate ${GATE}`);
  });

  test("below the gate it says to escalate", async () => {
    reply = answering({ business: choice("launch-house", 0.6), shape: choice("one_business", 0.9) });
    const r = await route("Quero lançar meu jogo indie na Steam com página da loja e wishlists");
    expect(r.escalate).toBe(true);
    expect(r.confidence).toBeCloseTo(0.6, 5);
    expect(r.decision.rationale).toContain(`< gate ${GATE}`);
  });

  test("a squad alone, and nothing in the library", async () => {
    reply = answering({ business: choice("none", 0.9), squad: choice("token-forge", 0.95), shape: choice("one_squad", 0.9) });
    const sq = await route("Crie um token na Solana com tokenomics simples");
    expect(sq.decision).toMatchObject({ kind: "decision", primary_business: null, mandatory_squads: ["token-forge"] });
    reply = answering({ business: choice("none", 0.95), squad: choice("none", 0.95), shape: choice("nothing", 0.97) });
    const none = await route("Me passe uma receita de escondidinho de carne seca");
    expect(none.decision).toMatchObject({ kind: "no_match", primary_business: null, mandatory_squads: [] });
    expect(none.escalate).toBe(false);
  });

  test("several, with two clauses, gives two parts, each clause to its owner", async () => {
    reply = answering({
      shape: choice("several", 0.9), business: choice("launch-house", 0.7),
      partb0: choice("launch-house", 0.92), parts0: choice("none", 0.8),
      partb1: choice("none", 0.7), parts1: choice("token-forge", 0.85),
    });
    const brief = "Quero lançar meu jogo indie na Steam com página e wishlists. Ao mesmo tempo, preciso de um token na Solana com tokenomics para a comunidade.";
    const r = await route(brief);
    expect(r.decision.parts!.map((p) => [p.kind, p.slug])).toEqual([["business", "launch-house"], ["squad", "token-forge"]]);
    expect(r.decision.parts![0].part).toContain("Steam");
    expect(r.decision.parts![1].part).toContain("Solana");
    expect(r.decision.primary_business).toBe("launch-house");
    expect(r.confidence).toBeCloseTo(0.85, 5);
    expect(r.escalate).toBe(false);
  });

  test("a target the request names is a command: the Jev is never asked about it", async () => {
    reply = answering({ business: choice("launch-house", 0.99), shape: choice("one_business", 0.99) });
    const r = await route("roda o sherlock-holmes-nirvana para investigar o vazamento de dados");
    expect(r.named).toEqual({ kind: "squad", slug: "sherlock-holmes-nirvana" });
    expect(r.decision).toMatchObject({ ok: true, kind: "decision", mandatory_squads: ["sherlock-holmes-nirvana"] });
    expect(r.confidence).toBe(1);
    for (const req of fake.requests) {
      for (const k of Object.keys(req.body.questions)) expect(k).toBe("voice");
    }
  });

  test("a choice outside the shortlist cannot be dispatched", async () => {
    reply = answering({ business: choice("ghost-business", 0.99), shape: choice("one_business", 0.99) });
    const r = await route("Quero lançar meu jogo indie na Steam com página da loja e wishlists");
    expect(r.escalate).toBe(true);
  });

  test("an error, a timeout or a refused connection escalates, with the error kept", async () => {
    reply = () => ({ status: 500, text: "boom" });
    const r = await route("Quero lançar meu jogo indie na Steam com página da loja e wishlists");
    expect(r.escalate).toBe(true);
    expect(r.decision.ok).toBe(false);
    expect(r.call.error).toContain("HTTP 500");
    const refused = await jevRoute({ brief: "Quero lançar meu jogo", cwd: PROJECT, registries, cloneRegistry: cloneRegistry(), home: HOME, env: { TYPESAFE_API_KEY: KEY, TYPESAFE_ENDPOINT: "http://127.0.0.1:9/v1/systemone" } });
    expect(refused.escalate).toBe(true);
  });
});

describe("the voice", () => {
  test("a described person is offered when the Jev is sure enough, never below VOICE", async () => {
    reply = answering({ business: choice("none", 0.9), squad: choice("none", 0.9), shape: choice("nothing", 0.9), voice: choice("vitalik-buterin", 0.99) });
    const brief = "Escreva um whitepaper sobre rollups e scaling de ethereum na linha do criador da rede";
    const r = await route(brief);
    expect(Object.keys(fake.requests[0].body.questions.voice.criteria)).toContain("vitalik-buterin");
    expect(r.decision.suggested_mind_clones).toEqual(["vitalik-buterin"]);
    reply = answering({ business: choice("none", 0.9), squad: choice("none", 0.9), shape: choice("nothing", 0.9), voice: choice("vitalik-buterin", 0.4) });
    expect((await route(brief)).decision.suggested_mind_clones).toEqual([]);
  });

  test("a request that names a clone asks no voice question", async () => {
    reply = answering({ business: choice("launch-house", 0.9), shape: choice("one_business", 0.9) });
    const r = await route("Um plano de lançamento na Steam no estilo do Vitalik Buterin");
    expect(r.decision.suggested_mind_clones).toEqual(["vitalik-buterin"]);
    expect(fake.requests[0].body.questions.voice).toBeUndefined();
  });
});

describe("clauses()", () => {
  // The six multi-business requests of bench/golden.json (2026-10-13).
  const MULTI: Array<[string, number, string[]]> = [
    ["Vou lançar um token de utilidade para um app de corrida: preciso da tokenomics com vesting do time e do memorando regulatório para Brasil e EUA. Em paralelo, quero uma campanha com dez influenciadores de corrida para o lançamento do app.", 2, ["tokenomics", "influenciadores"]],
    ["Escreva e publique na Amazon um livro de não-ficção sobre finanças para casais e, a partir dele, monte um curso de entrada e um curso avançado de upsell com material em PDF e página de vendas.", 2, ["livro", "curso"]],
    ["Minha fazenda de soja em Sorriso perdeu parte da safra e preciso renegociar o custeio vencido com o banco. Também quero um estudo de energia solar para alimentar os pivôs de irrigação.", 3, ["custeio", "solar"]],
    ["Nosso e-commerce de suplementos precisa se adequar à LGPD, com mapeamento de dados, RIPD e política de privacidade. Depois disso, quero implantar rastreamento server-side que devolva à Meta e ao Google quais pedidos foram pagos de verdade.", 2, ["LGPD", "server-side"]],
    ["Meu jogo de plataforma em Unity está em pré-alpha: quero levá-lo até o beta com plano de marcos e gate de QA. Ao mesmo tempo, preciso da página da Steam pronta e de um plano de wishlists para o Next Fest de fevereiro.", 2, ["Unity", "Steam"]],
    ["Estou abrindo uma clínica de fisioterapia com 12 funcionários em Goiânia. Preciso configurar prontuário e faturamento TISS para convênios, montar o PGR e o PCMSO da equipe e ter um calendário de conteúdo para o Instagram da clínica.", 4, ["TISS", "PGR", "Instagram"]],
  ];
  for (const [brief, n, words] of MULTI) {
    test(`splits a multi-business request: ${words.join(" / ")}`, () => {
      const c = clauses(brief);
      expect(c).toHaveLength(n);
      // Each deliverable lands in a clause of its own.
      const owner = words.map((w) => c.findIndex((x) => x.includes(w)));
      expect(owner.every((i) => i >= 0)).toBe(true);
      expect(new Set(owner).size).toBe(words.length);
    });
  }

  test("a one-part request stays one clause, a short one none, and never more than four", () => {
    expect(clauses("Crie uma landing page para meu curso de fotografia")).toEqual(["Crie uma landing page para meu curso de fotografia"]);
    expect(clauses("Write a launch plan for my indie game on Steam")).toHaveLength(1);
    expect(clauses("oi")).toEqual([]);
    expect(clauses("Faça um plano de marketing completo. Crie o site novo agora. Escreva os emails de lançamento. Monte o funil de vendas inteiro. Prepare o pitch para investidores.")).toHaveLength(4);
  });
});
