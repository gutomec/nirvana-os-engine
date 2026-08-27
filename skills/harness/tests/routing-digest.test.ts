// routing-digest.test.ts — the compact routing digest builder (Phase 3.1).
//
// Pure-function tests over tiny in-memory registries: format grammar (every
// line parses), the budget degradation ladder (entries are NEVER dropped),
// capability-collision correctness, and the keyword alias-group extraction
// (the .keyword-aliases.json contract with the amplification bridge:
// JSON array of string arrays). One CLI test runs the real script against
// fixture registry files. Zero tokens spent.
// Runs with: bun test skills/harness/tests
import { describe, expect, test, beforeEach, afterEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildDigest, buildKeywordAliases, splitKeywordGroups, foldKey, detectLang,
  estimateTokens, trunc, TOKEN_BUDGET, loadDigestInput,
  type DigestInput,
} from "../scripts/build-routing-digest.ts";

const BUILDER = path.join(import.meta.dir, "..", "scripts", "build-routing-digest.ts");

function fixtureInput(): DigestInput {
  return {
    businesses: {
      "acme-web": {
        name: "Acme Web",
        description: "Builds complete landing pages and marketing sites: design system, frontend implementation, conversion copy, deployment. Inputs: a product brief; outputs: a deployed page with analytics wired.",
        domains: ["design", "engineering"],
        produces: ["landing-page", "site", "style-guide", "seo-report", "copy-deck", "analytics-setup", "extra-artifact"],
        capabilities: ["web.landing.build", "web.site.build"],
        example_briefs: [
          "Build a landing page for my dental clinic with online booking",
          "Quero uma página de vendas para meu curso de fotografia",
        ],
        keywords: ["landing page", "página de destino", "pagina de destino", "sales page", "página de vendas"],
        // Business-level not_for (Business Protocol 2.0 §6.9). The registry now
        // carries it, so the digest's `not:` segment finally has an input.
        not_for: ["fiction ghostwriting", "video promocional"],
      },
      "acme-books": {
        name: "Acme Books",
        description: "Writes complete non-fiction ebooks from a topic brief: chapter plan, full manuscript, cover copy.",
        domains: ["book_creation"],
        produces: ["ebook"],
        capabilities: [],
        example_briefs: ["Write an ebook about personal finance for couples", "Escreva um ebook sobre finanças pessoais"],
        keywords: ["ebook", "e-book", "livro digital"],
      },
    },
    squads: {
      "squad-a": {
        description: "Delivers landing pages end to end and runs SEO audits on existing pages.",
        // 11 domains and 7 produces: the digest caps them at 10 and 6, the same
        // way the business line does.
        domains: ["design", "engineering", "seo", "copywriting", "analytics", "conversion", "frontend", "content", "research", "accessibility", "extra-domain"],
        produces: ["landing-page", "seo-report", "copy-deck", "style-guide", "analytics-setup", "sitemap", "extra-artifact"],
        capabilities: ["web.landing.build", "seo.audit.run"],
        example_briefs: ["Preciso de uma landing page premium", "Audit my page for SEO issues"],
      },
      "squad-b": {
        description: "Alternative landing-page provider focused on webflow exports.",
        capabilities: ["web.landing.build"],
        example_briefs: ["Export my design to webflow"],
      },
    },
    capabilities: {
      "web.landing.build": [
        { squad: "squad-a", description: "Full landing-page build with copy and analytics baked in from the brief", not_for: ["fiction ghostwriting", "video promocional"], keywords: ["landing page", "página de destino"] },
        { squad: "squad-b", description: "Webflow-flavored landing build", keywords: [] },
      ],
      "seo.audit.run": [
        { squad: "squad-a", description: "Technical SEO audit with prioritized fixes", not_for: ["paid ads"], keywords: ["code review", "revisão de código", "revisao de codigo"] },
      ],
      "web.site.build": [
        { squad: "squad-b", description: "Multi-page marketing site build" },
      ],
    },
    mindClones: {
      "jane-doe": {
        match: {
          one_liner: "Jane Doe, book typography director — the answer for page grids, type pairing and print-ready layout decisions.",
          domains: ["typography", "tipografia", "book layout", "diagramação de livro", "type pairing", "pareamento tipográfico", "grids", "extra-domain"],
        },
      },
      "john-roe": { match: { one_liner: "John Roe, conversion copy chief — pricing-page and offer-copy calls.", domains: ["copywriting", "copy de conversão"] } },
      "bare-clone": { match: { one_liner: null, domains: [] } },
    },
    registryPaths: {
      businesses: "/tmp/fixture/.businesses-registry.json",
      squads: "/tmp/fixture/.squads-registry.json",
      mindClones: "/tmp/fixture/.mind-clones-registry.json",
    },
  };
}

// ── grammar helpers ────────────────────────────────────────────────────

const SECTION_RE = /^## (businesses|squads|capability collisions|mind-clones)/;
const ENTRY_LINE_RE = /^[a-z0-9][\w.-]* \| .+/i;
const LABELED_SEG_RE = /^(domains|produces|caps|ex|not): .+$/;

function sectionLines(text: string, section: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const m = line.match(SECTION_RE);
    if (m) { inSection = m[1] === section; continue; }
    if (!inSection || !line.trim() || line.startsWith("#")) continue;
    out.push(line);
  }
  return out;
}

describe("routing digest — format grammar", () => {
  const r = buildDigest(fixtureInput(), { generatedAt: "2026-01-01T00:00:00.000Z" });

  test("header carries counts, generated_at and the three escalation paths", () => {
    expect(r.text).toContain("generated_at: 2026-01-01T00:00:00.000Z");
    expect(r.text).toContain("counts: businesses=2 | squads=2 | capability_ids=3 | capability_providers=4 | capability_collisions=1 | mind_clones=3 (2 with routing block)");
    expect(r.text).toContain("/tmp/fixture/.businesses-registry.json");
    expect(r.text).toContain("/tmp/fixture/.squads-registry.json");
    expect(r.text).toContain("/tmp/fixture/.mind-clones-registry.json");
    expect(r.text).toContain("degradation_level: 0");
  });

  test("every business/squad line parses: slug | description | labeled segments", () => {
    for (const section of ["businesses", "squads"]) {
      const lines = sectionLines(r.text, section);
      expect(lines.length).toBe(2);
      for (const line of lines) {
        expect(line).toMatch(ENTRY_LINE_RE);
        const segs = line.split(" | ");
        expect(segs.length).toBeGreaterThanOrEqual(2);
        for (const seg of segs.slice(2)) expect(seg).toMatch(LABELED_SEG_RE);
      }
    }
  });

  test("every enriched mind-clone line parses; bare clones land in the slug-only list", () => {
    const lines = sectionLines(r.text, "mind-clones");
    const entryLines = lines.filter((l) => l.includes(" | "));
    expect(entryLines.length).toBe(2);
    for (const line of entryLines) expect(line).toMatch(ENTRY_LINE_RE);
    expect(r.text).toContain("### without routing block");
    expect(lines.join("\n")).toContain("bare-clone");
  });

  test("clone domains are capped at top 6", () => {
    const jane = sectionLines(r.text, "mind-clones").find((l) => l.startsWith("jane-doe"))!;
    expect(jane).toContain("grids");
    expect(jane).not.toContain("extra-domain"); // 8 declared, 6 kept
  });

  test("business not_for renders as the not: segment (Business Protocol 2.0)", () => {
    const acme = sectionLines(r.text, "businesses").find((l) => l.startsWith("acme-web"))!;
    expect(acme).toContain("not: fiction ghostwriting; video promocional");
    // A business without fences gains no empty segment.
    const books = sectionLines(r.text, "businesses").find((l) => l.startsWith("acme-books"))!;
    expect(books).not.toContain("not:");
  });

  test("business produces are capped at top 6", () => {
    const acme = sectionLines(r.text, "businesses").find((l) => l.startsWith("acme-web"))!;
    expect(acme).toContain("analytics-setup");
    expect(acme).not.toContain("extra-artifact"); // 7 declared, 6 kept
  });

  // The router's own prompt says the OBJECT of a brief — what the entry
  // produces — decides most of the call, and businesses had been carrying both
  // segments since Phase 3.1 while squads carried neither. The registry has
  // aggregated them at squad level all along.
  test("squad domains are capped at top 10", () => {
    const squadA = sectionLines(r.text, "squads").find((l) => l.startsWith("squad-a"))!;
    expect(squadA).toContain("domains: design,engineering,seo,copywriting,analytics,conversion,frontend,content,research,accessibility");
    expect(squadA).not.toContain("extra-domain"); // 11 declared, 10 kept
  });

  test("squad produces are capped at top 6", () => {
    const squadA = sectionLines(r.text, "squads").find((l) => l.startsWith("squad-a"))!;
    expect(squadA).toContain("produces: landing-page,seo-report,copy-deck,style-guide,analytics-setup,sitemap");
    expect(squadA).not.toContain("extra-artifact"); // 7 declared, 6 kept
  });

  test("a squad declaring neither gains no empty segment", () => {
    const squadB = sectionLines(r.text, "squads").find((l) => l.startsWith("squad-b"))!;
    expect(squadB).not.toContain("domains:");
    expect(squadB).not.toContain("produces:");
  });

  test("the squads section header announces both new segments", () => {
    expect(r.text).toContain("## squads (slug | description | domains: | produces: top 6 | caps: id — one-liner | ex: briefs | not:)");
  });

  test("token estimate is chars/4 and reported", () => {
    expect(r.tokens).toBe(estimateTokens(r.text));
    expect(r.tokens).toBe(Math.ceil(r.text.length / 4));
  });
});

describe("routing digest — capability collisions", () => {
  test("only ids with 2+ providers are listed, with all their providers", () => {
    const r = buildDigest(fixtureInput());
    const lines = sectionLines(r.text, "capability collisions");
    expect(lines).toEqual(["web.landing.build → squad-a, squad-b"]);
  });

  test("no collisions renders an explicit (none)", () => {
    const input = fixtureInput();
    input.capabilities = { "seo.audit.run": input.capabilities["seo.audit.run"] };
    const r = buildDigest(input);
    expect(sectionLines(r.text, "capability collisions")).toEqual(["(none)"]);
  });
});

describe("routing digest — budget degradation ladder", () => {
  const input = fixtureInput();
  const l0 = buildDigest(input, { budgetTokens: 10_000_000 });

  test("level 0 keeps 2 example briefs and capability one-liners", () => {
    expect(l0.degradationLevel).toBe(0);
    const acme = sectionLines(l0.text, "businesses").find((l) => l.startsWith("acme-web"))!;
    expect(acme).toContain("dental clinic");
    expect(acme).toContain("curso de fotografia"); // 2nd brief present
    const squadA = sectionLines(l0.text, "squads").find((l) => l.startsWith("squad-a"))!;
    expect(squadA).toContain("web.landing.build — Full landing-page build");
  });

  test("L1 drops the 2nd example brief (businesses AND squads keep 1)", () => {
    const r = buildDigest(input, { budgetTokens: l0.tokens }); // l0 no longer fits (< budget is strict)
    expect(r.degradationLevel).toBe(1);
    const acme = sectionLines(r.text, "businesses").find((l) => l.startsWith("acme-web"))!;
    expect(acme).toContain("dental clinic");
    expect(acme).not.toContain("curso de fotografia");
    const squadA = sectionLines(r.text, "squads").find((l) => l.startsWith("squad-a"))!;
    expect(squadA).toContain("landing page premium");
    expect(squadA).not.toContain("SEO issues");
    expect(squadA).toContain(" — "); // one-liners survive L1
  });

  test("L4 (last rung) drops clone domains but never an entry", () => {
    const r = buildDigest(input, { budgetTokens: 1 });
    expect(r.degradationLevel).toBe(4);
    const clones = sectionLines(r.text, "mind-clones");
    // every clone still has its line — entries are never dropped
    expect(clones.length).toBe(Object.keys(input.mindClones).length);
    for (const line of clones) expect(line).not.toContain("domains:");
  });

  test("L2 additionally drops capability one-liners (ids only)", () => {
    const l1 = buildDigest(input, { budgetTokens: l0.tokens });
    const r = buildDigest(input, { budgetTokens: l1.tokens });
    expect(r.degradationLevel).toBe(2);
    const squadA = sectionLines(r.text, "squads").find((l) => l.startsWith("squad-a"))!;
    expect(squadA).toContain("caps: web.landing.build; seo.audit.run");
    expect(squadA).not.toContain(" — Full landing-page build");
  });

  test("L3 additionally truncates descriptions (and clone one-liners) to 100c", () => {
    // budgetTokens:1 is unsatisfiable, so the ladder runs to its LAST rung —
    // level 4 since the enrichment waves outgrew level 3. L4 keeps L3's
    // truncation (90c ≤ 100c) and additionally drops clone domains, asserted
    // in the next test.
    const r = buildDigest(input, { budgetTokens: 1 });
    expect(r.degradationLevel).toBe(4);
    for (const section of ["businesses", "squads"]) {
      for (const line of sectionLines(r.text, section)) {
        const desc = line.split(" | ")[1];
        expect(desc.length).toBeLessThanOrEqual(100);
      }
    }
    const jane = sectionLines(r.text, "mind-clones").find((l) => l.startsWith("jane-doe"))!;
    expect(jane.split(" | ")[1].length).toBeLessThanOrEqual(100);
  });

  test("L3 additionally cuts squad produces from 6 to 3 (domains stay)", () => {
    const l1 = buildDigest(input, { budgetTokens: l0.tokens });
    const l2 = buildDigest(input, { budgetTokens: l1.tokens });
    const r = buildDigest(input, { budgetTokens: l2.tokens });
    expect(r.degradationLevel).toBe(3);
    const squadA = sectionLines(r.text, "squads").find((l) => l.startsWith("squad-a"))!;
    expect(squadA).toContain("produces: landing-page,seo-report,copy-deck");
    expect(squadA).not.toContain("style-guide");
    expect(squadA).toContain("domains: design,engineering,seo");
  });

  // The two squad segments cost more than the last rung had left on the
  // owner's library, so one of them yields there: `produces` is the OBJECT of
  // the brief and stays, `domains` averages 3.5 labels the description already
  // implies and goes, the same trade the rung already makes for clones.
  test("L4 drops squad domains and keeps produces — the entry is never dropped", () => {
    const r = buildDigest(input, { budgetTokens: 1 });
    expect(r.degradationLevel).toBe(4);
    const squadA = sectionLines(r.text, "squads").find((l) => l.startsWith("squad-a"))!;
    expect(squadA).not.toContain("domains:");
    expect(squadA).toContain("produces: landing-page,seo-report,copy-deck");
    expect(squadA).toContain("caps: web.landing.build; seo.audit.run");
  });

  test("entries are NEVER dropped, even hopelessly over budget", () => {
    const r = buildDigest(input, { budgetTokens: 1 });
    expect(r.overBudget).toBe(true);
    for (const slug of ["acme-web", "acme-books", "squad-a", "squad-b", "jane-doe", "john-roe", "bare-clone"]) {
      expect(r.text).toContain(slug);
    }
    expect(r.counts.businesses).toBe(2);
    expect(r.counts.squads).toBe(2);
    expect(r.counts.mindClones).toBe(3);
  });

  test("default budget is the documented 50k", () => {
    expect(TOKEN_BUDGET).toBe(50_000);
  });
});

describe("keyword alias groups (.keyword-aliases.json contract)", () => {
  test("splitKeywordGroups follows the contract convention (one form per language + spelling variants)", () => {
    expect(splitKeywordGroups(["ebook", "e-book", "livro digital"])).toEqual([["ebook", "e-book", "livro digital"]]);
    expect(splitKeywordGroups(["code review", "revisão de código", "revisao de codigo", "landing page", "página de destino"]))
      .toEqual([["code review", "revisão de código", "revisao de codigo"], ["landing page", "página de destino"]]);
  });

  test("a repeated language starts a new concept group", () => {
    expect(splitKeywordGroups(["tutoria adaptativa", "adaptive tutoring", "learning gap", "lacuna de aprendizagem"]))
      .toEqual([["tutoria adaptativa", "adaptive tutoring"], ["learning gap", "lacuna de aprendizagem"]]);
    expect(splitKeywordGroups(["avaliação diagnóstica", "diagnostic assessment", "learning path", "trilha de aprendizagem"]))
      .toEqual([["avaliação diagnóstica", "diagnostic assessment"], ["learning path", "trilha de aprendizagem"]]);
  });

  test("foldKey merges accents, hyphens and case", () => {
    expect(foldKey("revisão de código")).toBe(foldKey("revisao de codigo"));
    expect(foldKey("e-book")).toBe(foldKey("ebook"));
    expect(foldKey("Landing Page")).toBe(foldKey("landing page"));
  });

  test("detectLang: pt via diacritics/stopwords/hint words, en via plain ascii", () => {
    expect(detectLang("revisão de código")).toBe("pt");
    expect(detectLang("livro digital")).toBe("pt"); // diacritic-free PT (hint list)
    expect(detectLang("landing page")).toBe("en");
  });

  test("buildKeywordAliases emits array-of-string-arrays with cross-entity accent-fold merge", () => {
    const groups = buildKeywordAliases(fixtureInput());
    expect(Array.isArray(groups)).toBe(true);
    for (const g of groups) {
      expect(Array.isArray(g)).toBe(true);
      expect(g.length).toBeGreaterThanOrEqual(2);
      for (const member of g) expect(typeof member).toBe("string");
    }
    // Business group and capability group both declare "landing page" /
    // "página de destino" — union-find merges them into one alias set that
    // also carries the unaccented spelling from the business list.
    const landing = groups.find((g) => g.includes("landing page"))!;
    expect(landing).toContain("página de destino");
    expect(landing).toContain("pagina de destino");
    // Capability-only group survives on its own.
    const review = groups.find((g) => g.includes("code review"))!;
    expect(review).toEqual(["code review", "revisão de código", "revisao de codigo"]);
    // ebook group from acme-books.
    const ebook = groups.find((g) => g.includes("ebook"))!;
    expect(ebook).toContain("livro digital");
  });

  test("singleton concepts are dropped (no alias signal)", () => {
    const groups = buildKeywordAliases({
      businesses: { solo: { keywords: ["mastery"] } },
      capabilities: {},
    });
    expect(groups).toEqual([]);
  });
});

describe("routing digest — CLI against fixture registry files", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-digest-cli-")); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

  function writeFixtureRegistries(): { biz: string; sq: string; cl: string } {
    const input = fixtureInput();
    const biz = path.join(tmp, ".businesses-registry.json");
    const sq = path.join(tmp, ".squads-registry.json");
    const cl = path.join(tmp, ".mind-clones-registry.json");
    fs.writeFileSync(biz, JSON.stringify({ businesses: input.businesses }));
    fs.writeFileSync(sq, JSON.stringify({ squads: input.squads, capabilities: input.capabilities }));
    fs.writeFileSync(cl, JSON.stringify({ mind_clones: input.mindClones }));
    return { biz, sq, cl };
  }

  test("writes digest + aliases next to each other; --check-budget passes on a tiny library", () => {
    const { biz, sq, cl } = writeFixtureRegistries();
    const out = path.join(tmp, ".routing-digest.md");
    const r = spawnSync(process.execPath, [
      BUILDER, "--businesses", biz, "--squads", sq, "--clones", cl, "--out", out, "--quiet",
    ], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
    const aliases = JSON.parse(fs.readFileSync(path.join(tmp, ".keyword-aliases.json"), "utf8"));
    expect(Array.isArray(aliases)).toBe(true);
    expect(aliases.every((g: unknown) => Array.isArray(g))).toBe(true);

    const check = spawnSync(process.execPath, [
      BUILDER, "--businesses", biz, "--squads", sq, "--clones", cl, "--out", out, "--check-budget", "--quiet",
    ], { encoding: "utf8" });
    expect(check.status).toBe(0);
  });

  test("fails loudly when no registry is readable", () => {
    const r = spawnSync(process.execPath, [
      BUILDER,
      "--businesses", path.join(tmp, "missing-b.json"),
      "--squads", path.join(tmp, "missing-s.json"),
      "--clones", path.join(tmp, "missing-c.json"),
      "--out", path.join(tmp, "digest.md"),
    ], { encoding: "utf8" });
    expect(r.status).toBe(1);
  });
});

describe("trunc", () => {
  test("keeps short strings, cuts long ones with ellipsis inside the budget", () => {
    expect(trunc("short", 10)).toBe("short");
    const cut = trunc("a".repeat(200), 100);
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("empty library vs unreadable registry", () => {
  // A content-free install is the engine's DESIGNED starting state, but the
  // digest treated "zero entries" and "could not parse" as the same thing. The
  // first command a new install is told to run (`nrv index`) therefore exited 1
  // with "run `nrv index` first" — advice for the command just run.
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-digest-empty-"));
  const SCRIPT = path.join(import.meta.dir, "..", "scripts", "build-routing-digest.ts");
  afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

  const write = (name: string, body: unknown) => {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, JSON.stringify(body));
    return p;
  };
  const run = (args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

  test("registries that parse but hold nothing produce a digest, exit 0", () => {
    const out = path.join(TMP, "digest.md");
    const r = run([
      `--businesses=${write("biz.json", { businesses: {} })}`,
      `--squads=${write("sq.json", { squads: {}, capabilities: {} })}`,
      `--clones=${write("cl.json", { mind_clones: {} })}`,
      `--out=${out}`,
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("library is empty");
    expect(fs.existsSync(out)).toBe(true);
  });

  test("registries that cannot be read still fail, exit 1", () => {
    const r = run([
      `--businesses=${path.join(TMP, "nope-1.json")}`,
      `--squads=${path.join(TMP, "nope-2.json")}`,
      `--clones=${path.join(TMP, "nope-3.json")}`,
      `--out=${path.join(TMP, "unused.md")}`,
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no registry could be read");
  });

  test("loadDigestInput reports WHICH registries parsed", () => {
    const input = loadDigestInput({
      businessesRegistry: write("biz2.json", { businesses: {} }),
      squadsRegistry: path.join(TMP, "missing.json"),
      mindClonesRegistry: write("cl2.json", { mind_clones: {} }),
    });
    expect(input.readable).toEqual({ businesses: true, squads: false, mindClones: true });
  });
});
