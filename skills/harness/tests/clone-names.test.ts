// clone-names.test.ts — who a request names, and the order voices are offered in.
// Zero-token: a fixture library shaped like the real one (role variants of one
// person, nicknames in parentheses, a role as display name, shared surnames).

import { describe, expect, test } from "bun:test";
import { buildPeople, cloneNamesOf, displayNameIssue, fold, scanNames } from "../lib/clone-names.ts";
import { selectVoices, voiceGate, voiceQuery } from "../lib/clone-voices.ts";
import { agentXVoices } from "../lib/dispatch-cascade.ts";

const NAMES = [
  { slug: "alex-hormozi", name: "Alex Hormozi" },
  { slug: "naval-ravikant", name: "Naval Ravikant" },
  { slug: "gary-vaynerchuk", name: "Gary Vaynerchuk" },
  { slug: "gary-vee-social", name: "Gary Vaynerchuk" },
  { slug: "brene-brown", name: "Brené Brown" },
  { slug: "icaro-de-carvalho", name: "Icaro de Carvalho" },
  { slug: "icaro-de-carvalho-copy", name: "Ícaro de Carvalho" },
  { slug: "washington-olivetto-cco", name: "Washington Olivetto" },
  { slug: "washington-olivetto-copy", name: "Copywriter Brand" },
  { slug: "washington-olivetto-brand-practice", name: "Washington Olivetto — Brand Practice Lead" },
  { slug: "david-droga-cco", name: "David Droga" },
  { slug: "david-droga-ceo", name: "David Droga" },
  { slug: "stanley-kubrick", name: "stanley-kubrick" },
  { slug: "cole-knaflic", name: "Cole Nussbaumer Knaflic" },
  { slug: "julian-cole-planner", name: "Julian Cole" },
  { slug: "dhh", name: "David Heinemeier Hansson (DHH)" },
  { slug: "mkbhd-creator", name: "Marques Brownlee (MKBHD)" },
  { slug: "cz-changpeng-zhao", name: "Changpeng Zhao (CZ)" },
  { slug: "roy-williams", name: "Roy H. Williams (O Wizard of Ads)" },
  { slug: "rory-sutherland", name: "Rory Sutherland" },
  { slug: "seth-godin", name: "Seth Godin" },
  { slug: "erico-rocha", name: "Erico Rocha" },
  { slug: "erico-rocha-cgo", name: "Erico Rocha" },
  { slug: "melina-rocha", name: "Melina Rocha" },
  { slug: "pedro-sobral", name: "Pedro Sobral" },
  { slug: "pedro-sobral-paid", name: "Pedro Sobral" },
  { slug: "ruy-albuquerque-sobral", name: "Ruy Albuquerque Sobral" },
  { slug: "emmanuel-lubezki", name: "Emmanuel Lubezki (Chivo)" },
  { slug: "simon-carless", name: "Simon Carless" },
  { slug: "yoshua-bengio", name: "Yoshua Bengio" },
];
const people = buildPeople(NAMES);
const personOfSlug = (s: string) => people.find((p) => p.slugs.includes(s))!.key;
const asked = (text: string) => scanNames(text, people).matches.map((m) => personOfSlug(m.slug));
const brief = (req: string, part = "Tudo.") => `## Request (verbatim)\n${req}\n\n## Decisions\n- None.\n\n## Your part\n${part}\n`;
const pick = (b: string, extra: Partial<Parameters<typeof selectVoices>[0]> = {}) =>
  selectVoices({ brief: b, names: NAMES, installed: () => true, search: () => [], limit: 3, ...extra });

describe("a person, however the request names them", () => {
  test.each([
    ["com a voz do Yoshua Bengio", "yoshua bengio"],
    ["escreva no estilo Hormozi uma oferta", "alex hormozi"],
    ["como o Naval pensaria sobre alavancagem", "naval ravikant"],
    ["um post do Gary Vee sobre conteúdo", "gary vaynerchuk"],
    ["texto na voz da BRENÉ BROWN", "brene brown"],
    ["texto na voz da Brene Brown", "brene brown"],
    ["análise como o Ícaro de Carvalho faria", "icaro de carvalho"],
    ["campanha como faria o Olivetto", "washington olivetto"],
    ["roteiro estilo Kubrick", "stanley kubrick"],
    ["dados como a Cole Knaflic", "cole nussbaumer knaflic"],
    ["review à la DHH", "david heinemeier hansson"],
    ["vídeo tipo MKBHD", "marques brownlee"],
    ["estratégia segundo o CZ", "changpeng zhao"],
    ["anúncio do Roy H. Williams", "roy h williams"],
    ["na linha do Sutherland", "rory sutherland"],
    ["à moda do Godin", "seth godin"],
    ["como o Érico Rocha venderia", "erico rocha"],
    ["usando o Hormozi's value equation", "alex hormozi"],
    ["luz como o Chivo", "emmanuel lubezki"],
  ])("%s", (text, person) => {
    expect(asked(text)).toEqual([person]);
  });

  test("a full name never becomes another person's surname match", () => {
    expect(asked("dados como a Cole Nussbaumer Knaflic")).toEqual(["cole nussbaumer knaflic"]);
  });

  test("a surname two people carry is reported, not guessed", () => {
    const scan = scanNames("no estilo do Sobral", people);
    expect(scan.matches).toEqual([]);
    expect(scan.ambiguous).toEqual([{ name: "sobral", candidates: expect.arrayContaining(["pedro-sobral", "ruy-albuquerque-sobral"]) }]);
  });

  test("a first name followed by another surname is someone else", () => {
    const scan = scanNames("escreva com a voz do Simon Sinek sobre propósito", people);
    expect(scan.matches).toEqual([]);
    expect(scan.unknown).toEqual(["Simon Sinek"]);
  });

  test("names in ordinary requests are not asks", () => {
    for (const text of [
      "Me ajude com o site da loja do Rafael, no estilo das lojas da Apple",
      "Monte a apresentação no estilo Instagram Stories para o cliente Pedro",
      "Faça como o Marcos pediu na reunião: um relatório de vendas por região",
      "a rocha da estratégia e o porto da logística",
    ]) expect(scanNames(text, people)).toEqual({ matches: [], unknown: [], ambiguous: [] });
  });

  test("a name inside another entity's slug is that entity, not the person", () => {
    const withSherlock = buildPeople([...NAMES, { slug: "sherlock-holmes", name: "Sherlock Holmes" }]);
    expect(scanNames("Roda o sherlock-holmes-nirvana nesses logs", withSherlock).matches).toEqual([]);
    expect(scanNames("Investigue como o Sherlock Holmes faria", withSherlock).matches.map((m) => m.slug)).toEqual(["sherlock-holmes"]);
    expect(scanNames("clone sherlock-holmes, por favor", withSherlock).matches.map((m) => m.slug)).toEqual(["sherlock-holmes"]);
  });

  test("fold drops accents, case and punctuation", () => {
    expect(fold("Brené BROWN's")).toBe("brene brown");
  });
});

describe("the order voices are offered in", () => {
  test("one slug per person, and asks past the limit are reported", () => {
    const s = pick(brief("Ícaro de Carvalho, Érico Rocha, David Droga e Washington Olivetto revisando a copy"));
    expect(s.voices).toHaveLength(3);
    expect(new Set(s.voices.map((v) => personOfSlug(v.slug))).size).toBe(3);
    expect(s.overflow).toHaveLength(1);
  });

  test("a person whose usual slug is not installed is offered under another of their slugs", () => {
    const s = pick(brief("campanha como faria o Washington Olivetto"), { installed: (slug) => slug === "washington-olivetto-copy" });
    expect(s.voices.map((v) => v.slug)).toEqual(["washington-olivetto-copy"]);
    expect(s.missing).toEqual([]);
  });

  test("an ask that names nobody installed is missing, and the search does not stand in", () => {
    const s = pick(brief("um capítulo na voz do Malcolm Gladwell"), { search: () => [{ slug: "simon-carless", display_name: "Simon Carless", coverage: { matched: 5, total: 6 }, below_gate: false } as any] });
    expect(s.voices).toEqual([]);
    expect(s.missing).toEqual(["Malcolm Gladwell"]);
  });

  test("the router's choice comes before the search, and only installed known slugs", () => {
    const search = () => [{ slug: "seth-godin", display_name: "Seth Godin", coverage: { matched: 4, total: 6 }, below_gate: false } as any];
    const s = pick(brief("Uma carta de vendas"), { suggested: ["alex-hormozi", "ghost-clone"], search });
    expect(s.how).toBe("suggested");
    expect(s.voices.map((v) => v.slug)).toEqual(["alex-hormozi"]);
  });

  test("the user's ask beats the router's choice", () => {
    const s = pick(brief("na voz do Naval Ravikant"), { suggested: ["alex-hormozi"] });
    expect(s.voices.map((v) => v.slug)).toEqual(["naval-ravikant"]);
  });

  test("a voice nobody asked for needs two terms and a third of the request", () => {
    expect(voiceGate({ coverage: { matched: 3, total: 16 } } as any)).toBe(false);
    expect(voiceGate({ coverage: { matched: 1, total: 1 } } as any)).toBe(false);
    expect(voiceGate({ coverage: { matched: 3, total: 6 } } as any)).toBe(true);
  });

  test("the search reads this run's part when it says enough, else the request too", () => {
    const long = "A tokenomics do token, a estratégia de listagem em exchange e o plano de liquidez inicial.";
    expect(voiceQuery(brief("Lance o jogo na Steam e crie o token", long))).toBe(long);
    expect(voiceQuery(brief("Lance o jogo na Steam e crie o token", "O token."))).toContain("Lance o jogo");
  });
});

describe("the generalist's voices", () => {
  const library = { names: NAMES, dirOf: (s: string) => `/clones/${s}` };
  test("agent-x gets the voice the request asks for", () => {
    const v = agentXVoices({ brief: "Escreva um ensaio com a voz do Yoshua Bengio", cloneLibrary: library, projectDir: "/p" });
    expect(v.slugs).toEqual(["yoshua-bengio"]);
    expect(v.dirs).toEqual(["/clones/yoshua-bengio"]);
  });
  test("agent-x gets the router's voices, and never a searched one", () => {
    expect(agentXVoices({ brief: "Escreva um ensaio sobre IA", suggestedClones: ["yoshua-bengio"], cloneLibrary: library, projectDir: "/p" }).slugs).toEqual(["yoshua-bengio"]);
    expect(agentXVoices({ brief: "Escreva um ensaio sobre IA", cloneLibrary: library, projectDir: "/p" }).slugs).toEqual([]);
  });
});

describe("aliases and canonical, declared in the manifest", () => {
  test("an alias is recognised like a nickname in parentheses", () => {
    const people = buildPeople([
      { slug: "nayib-bukele", name: "Nayib Bukele", aliases: ["Chivo"] },
      { slug: "gary-vaynerchuk", name: "Gary Vaynerchuk", aliases: ["Gary Vee"] },
    ]);
    expect(scanNames("um discurso tipo o Chivo faria", people).matches.map((m) => [m.slug, m.via])).toEqual([["nayib-bukele", "nickname"]]);
    expect(scanNames("posts no estilo Gary Vee", people).matches.map((m) => m.slug)).toEqual(["gary-vaynerchuk"]);
    // Without the alias the same text names nobody.
    expect(scanNames("um discurso tipo o Chivo faria", buildPeople([{ slug: "nayib-bukele", name: "Nayib Bukele" }])).matches).toEqual([]);
  });

  test("canonical: true picks the slug a person resolves to, over the inferred one", () => {
    const inferred = buildPeople([{ slug: "david-droga-cco", name: "David Droga" }, { slug: "david-droga-ceo", name: "David Droga" }]);
    expect(inferred[0].canonical).toBe("david-droga-cco");
    expect(inferred[0].canonicalDeclared).toBe(false);
    const declared = buildPeople([{ slug: "david-droga-cco", name: "David Droga" }, { slug: "david-droga-ceo", name: "David Droga", canonical: true }]);
    expect(declared).toHaveLength(1);
    expect(declared[0].canonical).toBe("david-droga-ceo");
    expect(declared[0].canonicalDeclared).toBe(true);
    expect(scanNames("na voz do David Droga", declared).matches.map((m) => m.slug)).toEqual(["david-droga-ceo"]);
  });

  test("canonical: <slug> files a slug under that slug's person and makes it canonical", () => {
    const people = buildPeople([
      { slug: "erico-rocha", name: "Erico Rocha" },
      { slug: "ignition-launch-strategist", name: "Launch Strategist", canonical: "erico-rocha" },
    ]);
    expect(people).toHaveLength(1);
    expect(people[0].slugs.sort()).toEqual(["erico-rocha", "ignition-launch-strategist"]);
    expect(people[0].canonical).toBe("erico-rocha");
    expect(people[0].canonicalDeclared).toBe(true);
    // A canonical pointing at a slug that is not installed changes nothing.
    const dangling = buildPeople([{ slug: "a-person", name: "A Person", canonical: "not-installed" }]);
    expect(dangling[0].canonical).toBe("a-person");
    expect(dangling[0].canonicalDeclared).toBe(false);
  });

  test("cloneNamesOf carries aliases and canonical from the registry, and drops what is not text", () => {
    expect(cloneNamesOf({
      "nayib-bukele": { display_name: "Nayib Bukele", aliases: ["Chivo", 3, " "], canonical: true },
      "plain": { display_name: "Plain Person", aliases: [], canonical: null },
      "pointer": { canonical: " nayib-bukele " },
    })).toEqual([
      { slug: "nayib-bukele", name: "Nayib Bukele", aliases: ["Chivo"], canonical: true },
      { slug: "plain", name: "Plain Person" },
      { slug: "pointer", name: "pointer", canonical: "nayib-bukele" },
    ]);
  });

  test("displayNameIssue: the slug as a name, and a role with no person", () => {
    expect(displayNameIssue("stanley-kubrick", "stanley-kubrick")).toBe("slug");
    expect(displayNameIssue("washington-olivetto-copy", "Copywriter Brand")).toBe("role");
    expect(displayNameIssue("washington-olivetto-brand-practice", "Washington Olivetto — Brand Practice Lead")).toBeNull();
    expect(displayNameIssue("steve-jobs", "Steve Jobs")).toBeNull();
  });
});

describe("the Jev's rerank, between the router's suggestion and the search", () => {
  const hit = (slug: string) => ({ slug, display_name: slug, score: 1, normalized: 1, coverage: { matched: 9, total: 20 }, below_gate: false }) as any;
  test("a named person or a router suggestion never reaches it; otherwise it decides before the search", () => {
    let calls = 0;
    const rerank = (c: string[]) => { calls++; return { ok: true, slug: c[0] }; };
    const base = { names: NAMES, installed: () => true, search: () => [hit("rory-sutherland"), hit("naval-ravikant")], limit: 3, rerank };
    expect(selectVoices({ ...base, brief: "escreva no estilo Hormozi" }).how).toBe("asked");
    expect(selectVoices({ ...base, brief: "uma oferta", suggested: ["naval-ravikant"] }).how).toBe("suggested");
    expect(calls).toBe(0);
    const r = selectVoices({ ...base, brief: "uma oferta irresistível", rerankCandidates: ["dhh"] });
    expect(calls).toBe(1);
    expect(r).toMatchObject({ how: "rerank", voices: [{ slug: "rory-sutherland" }] });
  });

  test("its pool: the search's hits and the extra candidates, one slot per person, nothing taken or uninstalled", () => {
    let pool: string[] = [];
    selectVoices({
      brief: "x", names: NAMES, installed: (s) => s !== "ghost", search: () => [hit("david-droga-cco"), hit("ghost"), hit("naval-ravikant")], taken: ["naval-ravikant"],
      rerank: (c) => { pool = c; return { ok: true, slug: null }; }, rerankCandidates: ["david-droga-ceo", "dhh"],
    });
    expect(pool).toEqual(["david-droga-cco", "dhh"]);
  });

  test("an answer outside the pool offers nothing; an error falls to the search; a throw too", () => {
    const base = { brief: "x", names: NAMES, installed: () => true, search: () => [hit("rory-sutherland")] };
    expect(selectVoices({ ...base, rerank: () => ({ ok: true, slug: "not-a-candidate" }) })).toMatchObject({ how: "none", voices: [] });
    expect(selectVoices({ ...base, rerank: () => ({ ok: false, slug: null }) })).toMatchObject({ how: "search" });
    expect(selectVoices({ ...base, rerank: () => { throw new Error("x"); } })).toMatchObject({ how: "search" });
  });
});
