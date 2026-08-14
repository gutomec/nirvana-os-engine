/**
 * Amplification-bridge regression gate (routing-360 Phase 3.3).
 *
 * Runs the committed golden-bridge-cases.json through route() (amplify OFF —
 * deterministic; the bridge's LLM arm (c) never fires here, so what is being
 * gated is arm (b): coverage probe + alias re-coverage) against the LIVE
 * registries. Same skip policy as routing-eval.test.ts: on a clean install /
 * partial pack the corpus truth differs — skip. Cases marked
 * `requires_alias_file` additionally skip when `.keyword-aliases.json` has not
 * been emitted next to the squads registry yet (`nrv index` emits it).
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { corpusGate } from "../../_shared/lib/corpus-gate.ts";

const router = require("../lib/router.js");
const registryLoader = require("../lib/registry-loader.js");

const CASES_PATH = path.join(import.meta.dir, "..", "baselines", "golden-bridge-cases.json");

const all = registryLoader.loadAll();
const providerCount = Object.values(all.squads.capabilities || {})
  .reduce((n: number, list: any) => n + (Array.isArray(list) ? list.length : 0), 0);
const businessCount = Object.keys(all.businesses.businesses || {}).length;
const FULL_LIBRARY = !!(all.squads.source_path && all.businesses.source_path)
  && providerCount >= 500 && businessCount >= 40;
const ALIAS_FILE_PRESENT = !!(all.squads.source_path
  && fs.existsSync(path.join(path.dirname(all.squads.source_path), ".keyword-aliases.json")));

const d = corpusGate("bridge-cases", FULL_LIBRARY, { providers: providerCount, businesses: businessCount, alias_file: ALIAS_FILE_PRESENT });

/** Destination a candidate resolves to (same collapse rule as stage3Decide). */
function destinationOf(m: any): string | null {
  const meta = (m && (m.meta || (m.doc && m.doc.meta))) || {};
  if (meta.type === "business_route") return String(meta.route_to || "").split("::")[0] || meta.slug || null;
  if (meta.type === "squad_capability" || meta.type === "squad") return meta.squad || null;
  if (meta.type === "business") return meta.slug || null;
  return null;
}

function rankedList(s3: any): any[] {
  if (!s3) return [];
  if (s3.signal === "HIGH") return [s3.target, ...(s3.alternatives || [])].filter(Boolean);
  if (s3.signal === "AMBIGUOUS") return (s3.alternatives || []).filter(Boolean);
  return [];
}

const spec = JSON.parse(fs.readFileSync(CASES_PATH, "utf8"));

d("amplification bridge — golden bridge cases (live corpus, amplify OFF)", () => {
  for (const kase of spec.cases) {
    const needsAliases = kase.requires_alias_file === true;
    const t = needsAliases && !ALIAS_FILE_PRESENT ? test.skip : test;
    t(`${kase.id}: "${kase.brief.slice(0, 52)}"`, async () => {
      const r = await router.route(kase.brief, { registries: all, amplify: false });
      const s3 = r.stage3 || {};
      const ranked = rankedList(s3);
      const top1 = ranked.length ? destinationOf(ranked[0]) : null;

      if (kase.expect_signal) expect(s3.signal).toBe(kase.expect_signal);
      // Destination-first cases: the contract is WHERE the brief lands, not how
      // loudly. A corpus with several legitimate claimants within the ambiguity
      // window should confirm rather than dispatch blind (see the case note).
      if (kase.expect_signal_in) expect(kase.expect_signal_in).toContain(s3.signal);
      if (kase.expect_signal_not) expect(s3.signal).not.toBe(kase.expect_signal_not);
      if (kase.expect_top1) expect(top1).toBe(kase.expect_top1);
      if (Array.isArray(kase.accepted_top1)) expect(kase.accepted_top1).toContain(top1);
      // What the bridge actually owns: it re-scores coverage through the alias
      // groups, and never touches rank order (router.js:1815-1831). So assert
      // the lift, not the winner — pinning rank-1 tests the corpus, and the
      // corpus moves.
      //
      // `alias_adopted` IS the lift: it is set only when the alias-recomputed
      // coverage clears the gate the direct coverage did not (router.js:1826).
      // The two coverage numbers stay on the match objects and never reach
      // stage3, so this flag is the whole observable signal.
      if (kase.expect_alias_adopted) expect(r.stage_bridge?.alias_adopted).toBe(true);
    });
  }

  test("bridge plumbing: alias override hook adopts alias coverage only when the gate clears", async () => {
    // Fixture aliases through the context hook (no dependency on the emitted
    // file): the ebook group bridges "ebook"-briefs to "livro/book"-declared
    // docs; the out-of-domain brief has no groups and must not be rescued.
    const aliases = [["ebook", "e-book", "livro", "book", "publishing", "publicação"]];
    const rIn = await router.route("criar um ebook sobre emagrecimento com copy persuasiva", {
      registries: all, amplify: false, keywordAliases: aliases,
    });
    expect(rIn.stage_bridge?.engaged).toBe(true);

    const rOut = await router.route("consertar a bomba hidráulica do trator", {
      registries: all, amplify: false, keywordAliases: aliases,
    });
    expect(rOut.stage_bridge?.engaged).toBe(true);
    expect(rOut.stage_bridge?.alias_adopted).toBe(false);
    expect(rOut.stage3?.signal).not.toBe("HIGH");
  });
});
