// routing-multilingual-probes.test.ts — pins the Phase 3.4 DECISION on the
// multilingual regime (baselines/golden-multilingual-probes.json).
//
// The decision the data forced (full tables in the probes file description):
//   1. Multilingual out-of-corpus briefs must NEVER dispatch HIGH — the router
//      abstains (NO_MATCH) or asks to confirm (AMBIGUOUS). This is the safety
//      contract the coverage gate provides and the fallback slot must respect.
//   2. routing.dense defaults to "off": with the default config, no dense
//      suggestion (via_dense_fallback) appears — the measured cosine bands of
//      correct targets overlap the out-of-domain negatives, so default-on
//      would trade the negatives NO_MATCH floor for partial recovery. Opt-in
//      via `nrv embeddings enable` / NIRVANA_ROUTER_DENSE=1.
//
// Runs against the LIVE registries (same pattern + guard as routing-eval):
// on a clean install / partial pack the probes' premise (a library that owns
// these domains) does not hold, and the skip is correct behavior.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { corpusGate } from "../../_shared/lib/corpus-gate.ts";

const require = createRequire(import.meta.url);
const router = require("../lib/router.js");
const registryLoader = require("../lib/registry-loader.js");

const PROBES_PATH = path.join(import.meta.dir, "..", "baselines", "golden-multilingual-probes.json");
const probes = JSON.parse(fs.readFileSync(PROBES_PATH, "utf8"));

const all = registryLoader.loadAll();
const providerCount = Object.values(all.squads.capabilities || {})
  .reduce((n: number, list: any) => n + (Array.isArray(list) ? list.length : 0), 0);
const businessCount = Object.keys(all.businesses.businesses || {}).length;
const FULL_LIBRARY = !!(all.squads.source_path && all.businesses.source_path)
  && providerCount >= 500 && businessCount >= 40;

// Route everything up front (same top-level-await pattern as routing-eval):
// amplify OFF for determinism; NIRVANA_ROUTER_DENSE forced empty so a
// developer's env cannot flip the pinned default — the committed config.yaml
// ("off") is the state under test.
const results: Array<{ kase: any; stage3: any }> = [];
if (FULL_LIBRARY) {
  const saved = process.env.NIRVANA_ROUTER_DENSE;
  delete process.env.NIRVANA_ROUTER_DENSE;
  try {
    for (const kase of probes.cases) {
      const r = await router.route(kase.brief, { registries: all, amplify: false });
      results.push({ kase, stage3: r.stage3 || {} });
    }
  } finally {
    if (saved === undefined) delete process.env.NIRVANA_ROUTER_DENSE;
    else process.env.NIRVANA_ROUTER_DENSE = saved;
  }
}

const d = corpusGate("routing-multilingual-probes", FULL_LIBRARY, { providers: providerCount, businesses: businessCount });

d("multilingual probes — Phase 3.4 decision pins (es/fr/it/de + zh/ja/ko)", () => {
  test("all probes routed", () => {
    expect(results.length).toBe(probes.cases.length);
    expect(results.length).toBe(15);
  });

  test("never a HIGH dispatch on an out-of-corpus-language brief", () => {
    const high = results.filter((r) => r.stage3.signal === "HIGH");
    expect(high.map((r) => `[${r.kase.language}] ${r.kase.brief}`)).toEqual([]);
    for (const { stage3 } of results) {
      expect(["NO_MATCH", "AMBIGUOUS"]).toContain(stage3.signal);
    }
  });

  test("default config keeps the dense fallback off — no dense suggestion appears", () => {
    for (const { stage3 } of results) {
      expect(stage3.via_dense_fallback).toBeUndefined();
      expect(stage3.route_tier).not.toBe("dense_fallback");
    }
  });

  test("the CJK smokes tokenize (segmenter path) and still never dispatch", () => {
    const cjk = results.filter((r) => ["zh", "ja", "ko"].includes(r.kase.language));
    expect(cjk.length).toBe(3);
    for (const { stage3 } of cjk) {
      expect(["NO_MATCH", "AMBIGUOUS"]).toContain(stage3.signal);
    }
  });
});
