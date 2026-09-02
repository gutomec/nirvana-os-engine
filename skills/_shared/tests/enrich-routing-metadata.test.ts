/**
 * Unit tests for the PURE parts of enrich-routing-metadata.ts (routing-360
 * Phase 2.4): shape validation, surgical YAML merge, backup/revert. All
 * fixtures are synthetic — no LLM, no live library, no registries.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendAutoRoutesBlock,
  appendTopLevelList,
  backupFile,
  buildBusinessPlan,
  detectLang,
  emitCloneRoutingYaml,
  extractJson,
  gateRegressed,
  hasUsableRoutingBlock,
  isTruncatedDescription,
  mergeCloneRouting,
  replaceTopLevelScalar,
  restoreBackup,
  routePatternFires,
  topLevelBlockSpan,
  upsertCloneRoutingBlock,
  validateBusinessGenerated,
  validateCloneBlock,
  verifyYamlSurgical,
  wrapFolded,
  type CloneRoutingBlock,
} from "../scripts/enrich-routing-metadata.ts";

const YAML = require("yaml");

// ── fixtures ────────────────────────────────────────────────────────────────

function validBlock(): CloneRoutingBlock {
  return {
    one_liner: "Estrategista de marca — a escolha quando o posicionamento precisa virar plataforma verbal",
    domains: [
      // 12 PT + 12 EN = 24 items, incl. symptom items
      "tom de voz de marca",
      "brand tone of voice",
      "posicionamento de marca",
      "brand positioning",
      "estratégia de narrativa",
      "narrative strategy",
      "propósito de marca",
      "brand purpose",
      "plataforma de marca",
      "brand platform",
      "identidade verbal da marca",
      "verbal identity",
      "arquitetura de portfólio de marca",
      "brand architecture",
      "naming de produto",
      "product naming",
      "manifesto de marca",
      "brand manifesto",
      "a marca parece genérica e ninguém lembra dela",
      "the brand sounds like every competitor",
      "o rebranding dividiu o time e a diretoria",
      "messaging framework",
      "guia de mensagens da marca",
      "brand voice guidelines",
    ],
    serves:
      "Escolha este clone quando a marca precisa de posicionamento e plataforma verbal com método: " +
      "diagnóstico em 3 camadas, matriz de arquétipos e teste de distintividade com 5 critérios. " +
      "A entrega padrão é a plataforma completa em 10 dias com guia de aplicação por canal.",
    not_for: "Design visual e logotipo são de outro clone; mídia paga é território de performance.",
    delegates_to: ["neighbor-x"],
    refuses: ["mídia paga", "design de logotipo"],
  };
}

const CLONE_MANIFEST = `manifest:
  name: test-clone
  display_name: "Clone de Teste"
  version: 1.0.0
  category: marketing
  tags:
    - criação
    - estratégia

artifacts:
  - path: agent/AGENT.md
    status: present

scores:
  coherence: 0.85

caveat: |
  Texto com acentuação preservada: ç, ã, é, õ.
`;

const BIZ_YAML = `name: test-biz
version: 1.0.0
protocol: '1.0'
description: 'Builds regulated fintech MVPs end to end.'
domains:
- engineering
produces:
- api-spec
example_briefs:
- "Especificação OpenAPI 3.1 para backend de pagamentos com event sourcing"
- "Build a monorepo scaffold with CI/CD on GitHub Actions"
- "Plano de sprint com 25 stories priorizadas e estimativas"
keywords:
- software
- desenvolvimento
ui:
  client_facing_name: Test Biz
  pitch: Premium software factory.
`;

// ═══════════════════════════════════════════════════════════════════════════
// shape validation — clones
// ═══════════════════════════════════════════════════════════════════════════

describe("validateCloneBlock", () => {
  test("valid block passes and is cleaned", () => {
    const r = validateCloneBlock(validBlock(), { knownSlugs: new Set(["neighbor-x"]) });
    expect(r.ok).toBe(true);
    expect(r.cleaned!.domains.length).toBe(24);
    // delegates_to is retired: the generator may still emit it, the cleaned
    // block never carries it.
    expect(r.cleaned!.delegates_to).toBeUndefined();
  });

  test("one_liner over 120 chars fails", () => {
    const b = { ...validBlock(), one_liner: "x".repeat(121) };
    const r = validateCloneBlock(b);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("one_liner");
  });

  test("fewer than 20 domains fails", () => {
    const b = { ...validBlock(), domains: validBlock().domains.slice(0, 10) };
    const r = validateCloneBlock(b);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("20-30");
  });

  test("negation inside a domain fails (rule 3a)", () => {
    const b = validBlock();
    b.domains[5] = "escalar sem explicar o clímax";
    const r = validateCloneBlock(b);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("negation");
  });

  test("slash inside a domain fails (PT and EN are separate items)", () => {
    const b = validBlock();
    b.domains[3] = "brand positioning / posicionamento";
    const r = validateCloneBlock(b);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("slashes");
  });

  test("domains ∩ refuses contradiction fails (rule 2)", () => {
    const b = validBlock();
    b.domains[23] = "mídia paga"; // also in refuses (accent-insensitive match)
    const r = validateCloneBlock(b);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("contradiction");
  });

  test("missing EN or PT side of the pairs fails", () => {
    const b = validBlock();
    // strip diacritics + PT stopwords so almost everything reads EN
    b.domains = b.domains.map((d, i) => (i % 2 === 0 ? `english concept ${i}` : d)).slice(0, 24);
    b.domains = b.domains.filter((d) => detectLang(d) !== "pt").concat(["estratégia de marca"]);
    while (b.domains.length < 20) b.domains.push(`another english item ${b.domains.length}`);
    const r = validateCloneBlock(b);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("EN+PT");
  });

  test("overlong serves fails (rule 3e)", () => {
    const b = { ...validBlock(), serves: Array(600).fill("palavra").join(" ") };
    const r = validateCloneBlock(b);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("serves");
  });

  test("delegates_to from the generator is discarded entirely (retired 2026-08-18)", () => {
    // The field used to be filtered against known slugs. Retired: a clone is
    // knowledge, not an actor — it cannot delegate. Whatever the LLM emits,
    // valid neighbors and ghosts alike, none of it reaches the cleaned block.
    const b = { ...validBlock(), delegates_to: ["neighbor-x", "ghost-clone", "me-myself"] };
    const r = validateCloneBlock(b, { knownSlugs: new Set(["neighbor-x", "me-myself"]), selfSlug: "me-myself" });
    expect(r.ok).toBe(true);
    expect(r.cleaned!.delegates_to).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// shape validation — businesses
// ═══════════════════════════════════════════════════════════════════════════

describe("validateBusinessGenerated", () => {
  const plan = { needDescription: true, needCapabilities: true, needKeywords: false, needExampleBriefs: false, needAutoRoutes: true };
  const ctx = {
    slug: "test-biz",
    employeeSlugs: ["tb-lead", "tb-engineer"],
    allBriefs: [
      "Especificação OpenAPI 3.1 para backend de pagamentos",
      "Build a monorepo scaffold with CI/CD",
    ],
  };

  test("valid generation passes with only the requested fields", () => {
    const r = validateBusinessGenerated(
      {
        description: "Builds regulated fintech MVPs: license path memo, KYC/AML stack, PRD, design tokens and backend scaffold in 90 days.",
        capabilities: ["fintech.regulatory_strategy.assess", "fintech.backend_api.build", "fintech.compliance_stack.audit"],
        auto_routes: [{ pattern: "\\b(especifica\\w*|openapi)\\b", route_to: "tb-engineer" }],
      },
      plan, ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.cleaned!.capabilities!.length).toBe(3);
    expect(r.cleaned!.keywords).toBeUndefined();
  });

  test("bad capability ids fail (needs >= 3 dot segments)", () => {
    const r = validateBusinessGenerated(
      { description: "Long enough valid description that ends properly.", capabilities: ["fintech.build", "Fintech.Api.Build"], auto_routes: [{ pattern: "openapi", route_to: "tb-engineer" }] },
      plan, ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("capabilities");
  });

  test("still-truncated description fails", () => {
    const cut = ("Incubator that builds regulated fintechs from zero to MVP in 90 days with a legal-first approach and " .repeat(5)).slice(0, 470) + " modelo de n";
    const r = validateBusinessGenerated({ description: cut, capabilities: ["a.b.c", "d.e.f", "g.h.i"], auto_routes: [{ pattern: "openapi", route_to: "tb-engineer" }] }, plan, ctx);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("mid-word");
  });

  test("auto_route whose pattern fires on no brief is rejected (§7)", () => {
    const r = validateBusinessGenerated(
      { description: "Valid complete description for the business.", capabilities: ["a.b.c", "d.e.f", "g.h.i"], auto_routes: [{ pattern: "\\bnunca-dispara\\b", route_to: "tb-engineer" }] },
      plan, ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("fires on none");
  });

  test("auto_route to a non-employee is rejected", () => {
    const r = validateBusinessGenerated(
      { description: "Valid complete description for the business.", capabilities: ["a.b.c", "d.e.f", "g.h.i"], auto_routes: [{ pattern: "openapi", route_to: "someone-else" }] },
      plan, ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("not an employee");
  });

  test("example_briefs containing the slug are rejected (§5)", () => {
    const p = { ...plan, needDescription: false, needCapabilities: false, needAutoRoutes: false, needExampleBriefs: true };
    const r = validateBusinessGenerated(
      { example_briefs: ["Use test-biz to build my fintech app please", "Especificação OpenAPI para pagamentos com PIX", "Build a monorepo scaffold now"] },
      p, ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("own slug");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// truncation + language + misc pure helpers
// ═══════════════════════════════════════════════════════════════════════════

describe("pure helpers", () => {
  test("isTruncatedDescription: mid-word 500-char cut detected; healthy text passes", () => {
    const cut = "Incubadora que constrói fintechs reguladas do zero ao MVP em 90 dias — estratégia regulatória primeiro. ".repeat(5).slice(0, 497).replace(/[.!?]$/, "") + " Modelo de n";
    expect(isTruncatedDescription(cut)).toBe(true);
    expect(isTruncatedDescription("Short description.")).toBe(false);
    expect(isTruncatedDescription("Long healthy description. ".repeat(30).trim())).toBe(false);
  });

  test("detectLang distinguishes PT diacritics/stopwords from plain-ASCII EN", () => {
    expect(detectLang("estratégia de marca")).toBe("pt");
    expect(detectLang("quero organizar as finanças")).toBe("pt");
    expect(detectLang("brand tone of voice")).toBe("en");
  });

  test("routePatternFires: verb-stem alternation fires; (?i) prefix stripped; invalid regex false", () => {
    const briefs = ["Escreva um ebook sobre finanças", "I want to write an e-book"];
    expect(routePatternFires("\\b(escrev\\w*|write|writing)\\b.*\\b(ebook|e-?book|livro)\\b", briefs)).toBe(true);
    expect(routePatternFires("(?i)ESCREVA.*EBOOK", briefs)).toBe(true);
    expect(routePatternFires("\\b(video|vídeo)\\b", briefs)).toBe(false);
    expect(routePatternFires("([", briefs)).toBe(false);
  });

  test("extractJson: fenced, prose-wrapped and invalid payloads", () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n{"a": "é"}\nDone.')).toEqual({ a: "é" });
    expect(extractJson("no json at all")).toBeNull();
  });

  test("extractJson: a string value carrying fenced code does not truncate the object", () => {
    // Measured 2026-09-02: a generated README with a ```bash block inside the
    // JSON made fence-first extraction cut at the README's own fence — two
    // attempts, $6.51, "no JSON object in the model output" while the object
    // was complete. Bare and fenced envelopes both have to survive it.
    const obj = { not_for: ["a"], readme: "# x\n\n```bash\nnrv run x\n```\n" };
    const bare = JSON.stringify(obj);
    expect(extractJson(bare)).toEqual(obj);
    expect(extractJson("```json\n" + bare + "\n```")).toEqual(obj);
    // Prose with braces before a fenced object still resolves through the fence.
    expect(extractJson('Note {this} first.\n```json\n{"a": 2}\n```')).toEqual({ a: 2 });
  });

  test("hasUsableRoutingBlock", () => {
    expect(hasUsableRoutingBlock({ routing: { one_liner: "x", domains: ["a"], serves: "y" } })).toBe(true);
    expect(hasUsableRoutingBlock({ routing: { one_liner: "x", domains: [] } })).toBe(false);
    expect(hasUsableRoutingBlock({})).toBe(false);
  });

  test("buildBusinessPlan flags missing capabilities and dead auto_routes", () => {
    const manifest = YAML.parse(BIZ_YAML);
    const plan = buildBusinessPlan(manifest, [{ pattern: "type:strategy|approval-gate" }] as any);
    expect(plan.needCapabilities).toBe(true);
    expect(plan.needKeywords).toBe(false);
    expect(plan.needExampleBriefs).toBe(false);
    expect(plan.needAutoRoutes).toBe(true); // the type: pattern fires on no brief
    const plan2 = buildBusinessPlan(manifest, [{ pattern: "\\bopenapi\\b" }] as any);
    expect(plan2.needAutoRoutes).toBe(false); // a live route already fires
  });

  test("wrapFolded round-trips through a YAML folded scalar", () => {
    const text = "Uma frase longa com acentuação: ção, é, õ, que precisa ser dobrada em várias linhas para caber no limite de largura estabelecido pelo emissor de YAML canônico do enriquecedor.";
    const yaml = "k: >-\n" + wrapFolded(text, "  ", 60);
    expect(YAML.parse(yaml).k.replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// surgical YAML merge — clones
// ═══════════════════════════════════════════════════════════════════════════

describe("clone MANIFEST merge is surgical", () => {
  test("insert: routing appended, every other key byte-preserved, diacritics intact", () => {
    // Mirror the production path: the intent verify receives is the merged
    // block, which never carries the retired delegates_to (mergeCloneRouting
    // drops it) — the fixture still emits it, as a legacy generator would.
    const { delegates_to: _retired, ...block } = validBlock();
    const { text, mode } = upsertCloneRoutingBlock(CLONE_MANIFEST, block as any);
    expect(mode).toBe("insert");
    // the original text is a verbatim prefix — diff is pure insertion
    expect(text.startsWith(CLONE_MANIFEST)).toBe(true);
    const v = verifyYamlSurgical(CLONE_MANIFEST, text, ["routing"], { routing: block as any });
    expect(v.errors).toEqual([]);
    const parsed = YAML.parse(text);
    expect(parsed.routing.one_liner).toBe(block.one_liner);
    expect(parsed.routing.domains).toEqual(block.domains);
    expect(parsed.manifest.tags).toEqual(["criação", "estratégia"]);
    expect(parsed.caveat).toContain("ç, ã, é, õ");
  });

  test("replace: existing partial routing block replaced in place, neighbors preserved", () => {
    const withPartial = CLONE_MANIFEST + "\nrouting:\n  one_liner: \"Frase antiga que deve vencer o merge\"\n\nsource_material:\n  primary: []\n";
    const generated = validBlock();
    const merged = mergeCloneRouting(YAML.parse(withPartial).routing, generated);
    // existing non-empty value wins (extend, never overwrite)
    expect(merged.one_liner).toBe("Frase antiga que deve vencer o merge");
    expect(merged.domains).toEqual(generated.domains);
    const { text, mode } = upsertCloneRoutingBlock(withPartial, merged);
    expect(mode).toBe("replace");
    const v = verifyYamlSurgical(withPartial, text, ["routing"], { routing: merged as any });
    expect(v.errors).toEqual([]);
    expect(YAML.parse(text).source_material).toEqual({ primary: [] });
    // no duplicate routing key
    expect(text.match(/^routing:/gm)!.length).toBe(1);
  });

  test("legacy when_to_use survives the merge", () => {
    const merged = mergeCloneRouting({ when_to_use: "texto legado" }, validBlock());
    expect(merged.when_to_use).toBe("texto legado");
    const { text } = upsertCloneRoutingBlock(CLONE_MANIFEST, merged);
    expect(YAML.parse(text).routing.when_to_use.replace(/\s+/g, " ")).toBe("texto legado");
  });

  test("the rendered block never carries delegates_to (retired)", () => {
    const block = { ...validBlock(), delegates_to: ["neighbor-x"] };
    const { text } = upsertCloneRoutingBlock(CLONE_MANIFEST, block);
    expect(YAML.parse(text).routing.delegates_to).toBeUndefined();
  });

  test("verifyYamlSurgical catches a mutated untouched key", () => {
    const { text } = upsertCloneRoutingBlock(CLONE_MANIFEST, validBlock());
    const corrupted = text.replace("coherence: 0.85", "coherence: 0.1");
    const v = verifyYamlSurgical(CLONE_MANIFEST, corrupted, ["routing"], { routing: validBlock() as any });
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toContain("scores");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// surgical YAML merge — businesses
// ═══════════════════════════════════════════════════════════════════════════

describe("business.yaml merge is surgical", () => {
  test("topLevelBlockSpan treats column-0 list items as part of the block", () => {
    const span = topLevelBlockSpan(BIZ_YAML, "example_briefs")!;
    const blockText = BIZ_YAML.slice(span.start, span.end);
    expect(blockText).toContain("Plano de sprint");
    expect(blockText).not.toContain("keywords:");
  });

  test("appendTopLevelList adds a new key without touching the rest", () => {
    const caps = ["fintech.regulatory_strategy.assess", "fintech.backend_api.build", "fintech.compliance_stack.audit"];
    const out = appendTopLevelList(BIZ_YAML, "capabilities", caps);
    expect(out.startsWith(BIZ_YAML)).toBe(true); // pure append
    const v = verifyYamlSurgical(BIZ_YAML, out, ["capabilities"], { capabilities: caps });
    expect(v.errors).toEqual([]);
  });

  test("appendTopLevelList replaces an existing empty key in place (no duplicate)", () => {
    const withEmpty = BIZ_YAML.replace("ui:", "capabilities: []\nui:");
    const caps = ["a.b.c", "d.e.f"];
    const out = appendTopLevelList(withEmpty, "capabilities", caps);
    expect(out.match(/^capabilities:/gm)!.length).toBe(1);
    const parsed = YAML.parse(out);
    expect(parsed.capabilities).toEqual(caps);
    expect(parsed.ui.pitch).toBe("Premium software factory.");
  });

  test("replaceTopLevelScalar rewrites only the description", () => {
    const fresh = "Builds regulated fintech MVPs end to end: license path memo, KYC and AML stack, PRD and backend scaffold, shipped in 90 days.";
    const out = replaceTopLevelScalar(BIZ_YAML, "description", fresh);
    const v = verifyYamlSurgical(BIZ_YAML, out, ["description"], { description: fresh });
    expect(v.errors).toEqual([]);
    expect(YAML.parse(out).example_briefs.length).toBe(3);
  });

  test("briefs with quotes/colons survive quoting in appendTopLevelList", () => {
    const briefs = ['Launch a US payments fintech: license memo and "KYC" stack', "Crie um plano de migração para o novo backend"];
    const out = appendTopLevelList(BIZ_YAML.replace(/example_briefs:[\s\S]*?keywords:/, "keywords:"), "example_briefs", briefs);
    expect(YAML.parse(out).example_briefs).toEqual(briefs);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// auto_routes append — routing.yaml
// ═══════════════════════════════════════════════════════════════════════════

const ROUTING_COL0 = `brief_intake:
  default_employee: tb-lead
  alternates: []
auto_routes:
- pattern: type:strategy|approval-gate
  route_to: tb-lead
  confidence_threshold: 0.95
mention_routing: []
`;

const ROUTING_INDENTED = `brief_intake:
  default_employee: tb-lead
auto_routes:
  - pattern: type:tracking-install
    route_to: tb-engineer
    confidence_threshold: 0.95
mention_routing: []
`;

describe("appendAutoRoutesBlock", () => {
  const newRoutes = [{ pattern: "\\b(especifica\\w*|openapi)\\b", route_to: "tb-engineer" }];

  test("appends inside a column-0 style block, before the next key", () => {
    const out = appendAutoRoutesBlock(ROUTING_COL0, newRoutes);
    const parsed = YAML.parse(out);
    expect(parsed.auto_routes.length).toBe(2);
    expect(parsed.auto_routes[0].pattern).toBe("type:strategy|approval-gate");
    expect(parsed.auto_routes[1].route_to).toBe("tb-engineer");
    expect(parsed.mention_routing).toEqual([]);
    expect(parsed.brief_intake.default_employee).toBe("tb-lead");
  });

  test("matches the 2-space indent style of existing entries", () => {
    const out = appendAutoRoutesBlock(ROUTING_INDENTED, newRoutes);
    expect(out).toContain('  - pattern: "\\\\b(especifica\\\\w*|openapi)\\\\b"');
    const parsed = YAML.parse(out);
    expect(parsed.auto_routes.length).toBe(2);
  });

  test("creates the file content when routing.yaml is absent", () => {
    const out = appendAutoRoutesBlock(null, newRoutes);
    const parsed = YAML.parse(out);
    expect(parsed.auto_routes.length).toBe(1);
    expect(parsed.auto_routes[0].confidence_threshold).toBe(0.95);
  });

  test("appends the key when the file exists without auto_routes", () => {
    const out = appendAutoRoutesBlock("brief_intake:\n  default_employee: tb-lead\n", newRoutes);
    const parsed = YAML.parse(out);
    expect(parsed.auto_routes.length).toBe(1);
    expect(parsed.brief_intake.default_employee).toBe("tb-lead");
  });

  test("inline empty `auto_routes: []` is converted to block form (cinema-machine bug)", () => {
    const routingInlineEmpty = "brief_intake:\n  default_employee: tb-lead\n  alternates: []\n\nauto_routes: []\nmention_routing: []\n";
    const out = appendAutoRoutesBlock(routingInlineEmpty, newRoutes);
    const parsed = YAML.parse(out); // must parse — the old code emitted invalid YAML here
    expect(parsed.auto_routes.length).toBe(1);
    expect(parsed.auto_routes[0].route_to).toBe("tb-engineer");
    expect(parsed.mention_routing).toEqual([]);
  });

  test("inline non-empty flow sequence is left untouched", () => {
    const inlineFull = "auto_routes: [{pattern: x, route_to: y}]\n";
    expect(appendAutoRoutesBlock(inlineFull, newRoutes)).toBe(inlineFull);
  });
});

describe("gateRegressed (causal per-entity gate)", () => {
  const g = (pairs: Array<[string, boolean]>): any => ({
    entity: "x", kind: "business", lenient: false, passed: pairs.every(([, h]) => h),
    briefs: pairs.map(([brief, hit]) => ({ brief, hit, rank: hit ? 1 : 2, signal: "HIGH", top3: [] })),
  });

  test("same pre-existing miss, no new miss — not a regression", () => {
    const before = g([["a", true], ["b", false], ["c", true]]);
    const after = g([["a", true], ["b", false], ["c", true]]);
    expect(gateRegressed(before, after)).toBe(false);
  });

  test("a brief that hit before and misses now — regression", () => {
    const before = g([["a", true], ["b", false]]);
    const after = g([["a", false], ["b", true]]);
    expect(gateRegressed(before, after)).toBe(true);
  });

  test("pre-existing miss fixed by the write — improvement, not regression", () => {
    const before = g([["a", true], ["b", false]]);
    const after = g([["a", true], ["b", true]]);
    expect(gateRegressed(before, after)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// backup / revert
// ═══════════════════════════════════════════════════════════════════════════

describe("backup and revert", () => {
  test("modified file restores byte-for-byte", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enrich-test-"));
    const file = path.join(dir, "MANIFEST.yaml");
    fs.writeFileSync(file, CLONE_MANIFEST, "utf8");
    const entry = backupFile(path.join(dir, "backups"), file);
    fs.writeFileSync(file, CLONE_MANIFEST + "\nrouting:\n  one_liner: \"quebrado\"\n", "utf8");
    restoreBackup(entry);
    expect(fs.readFileSync(file, "utf8")).toBe(CLONE_MANIFEST);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("file created after the backup is deleted on revert", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enrich-test-"));
    const file = path.join(dir, "routing.yaml");
    const entry = backupFile(path.join(dir, "backups"), file); // did not exist
    expect(entry.backupPath).toBeNull();
    fs.writeFileSync(file, "auto_routes:\n- pattern: x\n  route_to: y\n", "utf8");
    restoreBackup(entry);
    expect(fs.existsSync(file)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
