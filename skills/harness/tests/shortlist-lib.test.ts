// shortlist-lib.test.ts — lib/shortlist.ts: one BM25 pass, the router's own
// explicit-mention detector, and the clone index built once per registry.
//
// `nrv find` used to run the whole router a second time only to learn which
// target the request named (~0.25 s of a ~0.8 s command). The named target now
// comes from `detectTargetMention`, and these tests pin that it answers what
// the full router's Stage 0.5 answered. No model, no network, fixture library.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { namedTarget, peopleFor, shortlist } from "../lib/shortlist.ts";
import { findCloneForTask } from "../../_shared/lib/clone-search.ts";

const require_ = createRequire(import.meta.url);
const router = require_(path.join(import.meta.dir, "..", "lib", "router.js"));

const provider = (squad: string, description: string, keywords: string[]) => ({ squad, description, keywords, domains: [], produces: [] });
const registries = {
  businesses: { businesses: {
    "investigation-bureau": { description: "Investigates what really happened.", produces: ["case-dossier"] },
    "launch-house": { description: "Launches finished games on Steam.", produces: ["steam-store-page-kit"] },
  } },
  squads: {
    squads: {
      "sherlock-holmes-nirvana": { description: "Investigation squad.", capabilities: ["investigation.case"] },
      "token-forge": { description: "Solana tokens.", capabilities: ["crypto.token.design"] },
    },
    capabilities: {
      "investigation.case": [provider("sherlock-holmes-nirvana", "Investigate a case from fragments", ["investigar", "investigation", "evidence"])],
      "crypto.token.design": [provider("token-forge", "Design a token and its tokenomics", ["token", "tokenomics", "solana"])],
    },
    domains: {},
  },
};

describe("the named target", () => {
  const briefs = [
    "roda o sherlock-holmes-nirvana para investigar o vazamento",
    "use a empresa investigation-bureau neste caso",
    "quero lançar meu jogo na Steam",
    "use o token-forge e o sherlock-holmes-nirvana",
  ];
  for (const brief of briefs) {
    test(`matches the full router's Stage 0.5: ${brief}`, async () => {
      const decision = await router.route(brief, { registries, amplify: false });
      const target = decision?.stage3?.route_tier === "explicit_mention" ? decision.stage3.target : null;
      const expected = target?.meta?.type === "business" ? { kind: "business", slug: target.meta.slug }
        : target?.meta?.squad ? { kind: "squad", slug: target.meta.squad } : null;
      expect(namedTarget(brief, registries)).toEqual(expected);
    });
  }

  test("a squad named by slug is the target, and two named targets are none", () => {
    expect(namedTarget("roda o sherlock-holmes-nirvana", registries)).toEqual({ kind: "squad", slug: "sherlock-holmes-nirvana" });
    expect(namedTarget("use o token-forge e o sherlock-holmes-nirvana", registries)).toBeNull();
  });

  test("the router no longer runs whole inside shortlist()", async () => {
    const original = router.route;
    let calls = 0;
    router.route = (...a: unknown[]) => { calls++; return original(...a); };
    try {
      const s = await shortlist("roda o sherlock-holmes-nirvana para investigar", registries, { cloneRegistry: {} });
      expect(s.named).toEqual({ kind: "squad", slug: "sherlock-holmes-nirvana" });
      expect(s.squads.map((q) => q.slug)).toContain("sherlock-holmes-nirvana");
    } finally {
      router.route = original;
    }
    expect(calls).toBe(0);
  });

  test("the clones the request names come from the registry it is given", async () => {
    const cloneRegistry = { "alex-hormozi": { slug: "alex-hormozi", display_name: "Alex Hormozi" } };
    const s = await shortlist("uma oferta estilo Hormozi", registries, { cloneRegistry });
    expect(s.clones.named).toEqual(["alex-hormozi"]);
    expect(peopleFor(cloneRegistry)).toBe(peopleFor(cloneRegistry));
  });
});

describe("the clone index is built once per registry content", () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-clone-index-"));
  const saved = { scope: process.env.NIRVANA_SCOPE, root: process.env.NIRVANA_PROJECT_ROOT };
  const registryFile = path.join(TMP, ".nirvana", ".mind-clones-registry.json");
  const clone = (slug: string, one_liner: string, domains: string[]) => ({ slug, display_name: slug, match: { one_liner, domains } });
  const write = (clones: any[]) => {
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(registryFile, JSON.stringify({ mind_clones: Object.fromEntries(clones.map((c) => [c.slug, c])) }), "utf8");
  };
  afterAll(() => {
    if (saved.scope === undefined) delete process.env.NIRVANA_SCOPE; else process.env.NIRVANA_SCOPE = saved.scope;
    if (saved.root === undefined) delete process.env.NIRVANA_PROJECT_ROOT; else process.env.NIRVANA_PROJECT_ROOT = saved.root;
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  test("the same answer twice, and a rewritten registry is read again", () => {
    process.env.NIRVANA_SCOPE = "project";
    process.env.NIRVANA_PROJECT_ROOT = TMP;
    write([clone("ana-tokenomics", "designs token economies", ["tokenomics", "crypto"]), clone("bia-games", "designs indie games", ["games"])]);
    const q = "design the tokenomics for a crypto token economy";
    const first = findCloneForTask(q, { cwd: TMP });
    expect(first[0].slug).toBe("ana-tokenomics");
    expect(findCloneForTask(q, { cwd: TMP })).toEqual(first);
    // Same size on purpose: the cache keys on content, not on mtime or length.
    write([clone("ana-tokenomics", "designs indie games", ["games"]), clone("bia-games", "designs token economies", ["tokenomics", "crypto"])]);
    expect(findCloneForTask(q, { cwd: TMP })[0].slug).toBe("bia-games");
    // A subset (a business's seat voices) gets its own index.
    expect(findCloneForTask(q, { cwd: TMP, only: ["ana-tokenomics"] }).map((h) => h.slug)).toEqual(["ana-tokenomics"]);
  });
});
