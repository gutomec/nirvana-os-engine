// self-retrieval-gate.test.ts — the gate against a synthetic fixture registry.
//
// Covers: hit path (squad, capability, business, clone), miss path (an entity
// whose example_briefs describe a neighbor's territory), --lenient (top-3
// accepted), and the no-briefs failure. All registries are injected — no disk
// registry, no reindex spawn, fully deterministic.

import { describe, expect, test } from "bun:test";
import { runGate, resolveEntity } from "../scripts/self-retrieval-gate.ts";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

// ── fixture registries ──────────────────────────────────────────────────────

function capability(squad: string, over: Record<string, any> = {}) {
  return {
    squad,
    description: "placeholder description overwritten per capability",
    domains: ["content"],
    examples: ["do the thing"],
    invoke: { type: "workflow", ref: "workflows/main.yaml" },
    not_for: [],
    score_boost: 1.0,
    ...over,
  };
}

const squadsRegistry = {
  squads: {},
  domains: {},
  _v4_inferred_capabilities: {},
  capabilities: {
    "content.ebook.write": [
      capability("ebook-forge", {
        description: "Writes complete non-fiction ebooks from a topic brief: chapter plan, manuscript, cover copy.",
        keywords: ["ebook", "e-book", "livro digital", "manuscrito", "manuscript", "chapters", "capitulos", "capítulos"],
        example_briefs: [
          "Write a complete ebook about intermittent fasting with ten chapters and a title",
          "Escreva um ebook completo sobre jejum intermitente com dez capítulos e título",
          "Quero escrever um livro digital sobre nutrição para iniciantes",
        ],
        produces: ["ebook", "manuscript"],
      }),
    ],
    "media.promo.render": [
      capability("promo-video-forge", {
        description: "Renders cinematic promo videos from a script: storyboard, motion design, final mp4 render.",
        keywords: ["promo video", "video promocional", "vídeo promocional", "render", "motion design", "storyboard", "mp4"],
        example_briefs: [
          "Render a cinematic promo video for our new sneaker line with motion design",
          "Preciso de um vídeo promocional com storyboard e render final em mp4",
        ],
        produces: ["promo-video", "storyboard"],
      }),
    ],
    // Miss path: declares briefs that are pure promo-video territory — the
    // promo-video-forge doc (keywords x3 + briefs x2) must outrank it.
    "media.promo.misdeclared": [
      capability("misdeclared-squad", {
        description: "Generic media helper with weak self-description.",
        keywords: ["helper"],
        example_briefs: [
          "Render a cinematic promo video with motion design and a storyboard in mp4",
        ],
        produces: ["misc-file"],
      }),
    ],
  },
};

const businessesRegistry = {
  _business_routing: {},
  businesses: {
    "aurum-books": {
      description: "Publishing house business: acquires topics, produces ebooks and print-ready manuscripts end to end.",
      domains: ["content", "publishing"],
      capabilities: [],
      keywords: ["publishing", "editora", "book production", "producao editorial", "produção editorial"],
      example_briefs: [
        "Run the full publishing pipeline for a recipe book from outline to print-ready manuscript",
        "Rode o pipeline editorial completo para um livro de receitas até o manuscrito final",
      ],
      produces: ["ebook", "print-manuscript"],
    },
  },
};

const registries = { squads: squadsRegistry, businesses: businessesRegistry, warnings: [] };

const cloneRegistry = {
  "ada-editrix": {
    slug: "ada-editrix",
    display_name: "Ada Editrix",
    tags: ["editing"],
    match: {
      one_liner: "Developmental editor for narrative non-fiction manuscripts and chapter structure",
      domains: ["developmental editing", "edição de desenvolvimento", "chapter structure", "estrutura de capítulos"],
      serves: "Choose her when a manuscript drags and the chapter order fights the argument.",
      refuses: [],
    },
  },
  "rex-colorist": {
    slug: "rex-colorist",
    display_name: "Rex Colorist",
    tags: ["color"],
    match: {
      one_liner: "Film colorist for cinematic color grading and LUT design in promo videos",
      domains: ["color grading", "correção de cor", "LUT design"],
      serves: "Choose him for grading footage and building LUTs.",
      refuses: [],
    },
  },
  "no-block-clone": {
    slug: "no-block-clone",
    display_name: "No Block Clone",
    tags: [],
    match: {},
  },
};

const base = { registries, cloneRegistry, reindex: false as const };

// ── kind resolution ─────────────────────────────────────────────────────────

describe("resolveEntity", () => {
  test("auto-detects business, squad, capability and clone", () => {
    expect(resolveEntity("aurum-books", registries, cloneRegistry)?.kind).toBe("business");
    expect(resolveEntity("ebook-forge", registries, cloneRegistry)?.kind).toBe("squad");
    expect(resolveEntity("content.ebook.write", registries, cloneRegistry)?.kind).toBe("capability");
    expect(resolveEntity("ada-editrix", registries, cloneRegistry)?.kind).toBe("clone");
    expect(resolveEntity("does-not-exist", registries, cloneRegistry)).toBeNull();
  });

  test("provider-scoped capability id narrows to one squad", () => {
    const r = resolveEntity("ebook-forge:content.ebook.write", registries, cloneRegistry);
    expect(r?.kind).toBe("capability");
    expect(r?.cases.every((c) => c.squad === "ebook-forge")).toBe(true);
    expect(resolveEntity("promo-video-forge:content.ebook.write", registries, cloneRegistry)).toBeNull();
  });
});

// ── hit paths ───────────────────────────────────────────────────────────────

describe("runGate hits", () => {
  test("squad whose briefs match its own declaration passes strict top-1", async () => {
    const r = await runGate("ebook-forge", base);
    expect(r.kind).toBe("squad");
    expect(r.briefs.length).toBe(3);
    for (const b of r.briefs) {
      expect(b.rank).toBe(1);
      expect(b.hit).toBe(true);
    }
    expect(r.passed).toBe(true);
  }, spawnBudgetMs(2));

  test("capability id passes with exact squad+capability matching", async () => {
    const r = await runGate("media.promo.render", base);
    expect(r.kind).toBe("capability");
    expect(r.passed).toBe(true);
  }, spawnBudgetMs(2));

  test("business briefs route back to the business", async () => {
    const r = await runGate("aurum-books", base);
    expect(r.kind).toBe("business");
    expect(r.passed).toBe(true);
    for (const b of r.briefs) expect(b.rank).toBe(1);
  }, spawnBudgetMs(2));

  test("clone one_liner self-retrieves top-1", async () => {
    const r = await runGate("ada-editrix", base);
    expect(r.kind).toBe("clone");
    expect(r.briefs.length).toBe(1);
    expect(r.briefs[0].signal).toBe("CLONE_BM25");
    expect(r.passed).toBe(true);
  }, spawnBudgetMs(2));
});

// ── miss paths ──────────────────────────────────────────────────────────────

describe("runGate misses", () => {
  test("entity declaring a neighbor's territory misses top-1 and fails", async () => {
    const r = await runGate("misdeclared-squad", base);
    expect(r.kind).toBe("squad");
    expect(r.passed).toBe(false);
    const miss = r.briefs.find((b) => !b.hit);
    expect(miss).toBeDefined();
    expect(miss!.rank === null || miss!.rank > 1).toBe(true);
    // The report carries the actual top-3 for diagnosis.
    expect(miss!.top3.length).toBeGreaterThan(0);
  }, spawnBudgetMs(2));

  test("--lenient accepts a top-3 rank the strict gate rejects", async () => {
    const strict = await runGate("misdeclared-squad", base);
    const lenient = await runGate("misdeclared-squad", { ...base, lenient: true });
    expect(strict.passed).toBe(false);
    // The misdeclared brief still lands in top-3 of this tiny corpus.
    expect(lenient.briefs.every((b) => b.rank !== null && b.rank <= 3)).toBe(true);
    expect(lenient.passed).toBe(true);
  }, spawnBudgetMs(2));

  test("entity without example_briefs fails with an explicit reason", async () => {
    const bare = {
      ...base,
      registries: {
        squads: {
          squads: {}, domains: {}, _v4_inferred_capabilities: {},
          capabilities: {
            "misc.bare.execute": [capability("bare-squad", { description: "Bare squad with no example_briefs declared at all." })],
          },
        },
        businesses: { businesses: {}, _business_routing: {} },
        warnings: [],
      },
    };
    const r = await runGate("bare-squad", bare);
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("example_briefs");
    expect(r.briefs.length).toBe(0);
  }, spawnBudgetMs(2));

  test("clone without one_liner fails with an explicit reason", async () => {
    const r = await runGate("no-block-clone", base);
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("one_liner");
  }, spawnBudgetMs(2));

  test("unknown entity fails with a not-found reason", async () => {
    const r = await runGate("ghost-entity", base);
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("not found");
  }, spawnBudgetMs(2));
});
