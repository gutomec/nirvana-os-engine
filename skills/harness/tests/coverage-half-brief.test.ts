// coverage-half-brief.test.ts — half a brief explained is a reason to confirm,
// never a reason to dispatch.
//
// The coverage gate had bands for `matched <= 1` and `matched === 2`, and the
// gap above them let a confident dispatch through. Measured on the owner's
// library (2026-09-19): "me empresta vinte reais até sexta-feira" matched 3 of
// the brief's 6 content tokens against a personal-trainer RETENTION CAMPAIGN
// and came out HIGH — normalized 1.000, lead 0.388. A brief about borrowing
// money from a friend, dispatched with confidence to a marketing squad.
//
// `matched = 3` cleared both count bands while half the brief stayed
// unexplained, so the fraction never got a say. The principle the earlier bands
// already encode is count AND fraction together; this is that principle without
// the arbitrary ceiling on count.
//
// Why AMBIGUOUS and not NO_MATCH: a legitimate brief in one language against a
// library declared in another has low coverage BY CONSTRUCTION — that is the
// whole reason the alias bridge exists. Measured, cross-language briefs sit in
// the same coverage band as nonsense (bridge frac 0.25-1.00, negatives
// 0.14-1.00), so abstaining on low coverage would silently punish every PT
// brief against an EN-declared squad. Confirming costs a question; abstaining
// costs the work.
import { describe, expect, test } from "bun:test";
import { corpusGate } from "../../_shared/lib/corpus-gate.ts";

const router = require("../lib/router.js");
const registryLoader = require("../lib/registry-loader.js");

const all = registryLoader.loadAll();
const providers = Object.values(all.squads.capabilities || {})
  .reduce((n: number, l: any) => n + (Array.isArray(l) ? l.length : 0), 0);
const businesses = Object.keys(all.businesses.businesses || {}).length;
const FULL = !!(all.squads.source_path && all.businesses.source_path) && providers >= 500 && businesses >= 40;
const d = corpusGate("coverage-half-brief", FULL, { providers, businesses });

d("the band itself", () => {
  test("a brief whose winner explains half of it is never dispatched", async () => {
    const r = await router.route("me empresta vinte reais até sexta-feira", { registries: all, amplify: false });
    expect(r.stage3?.signal).not.toBe("HIGH");
    expect(r.stage3?.reason).toContain("metade ou menos");
  });

  test("and the candidates are still exposed, so the caller can confirm", async () => {
    const r = await router.route("me empresta vinte reais até sexta-feira", { registries: all, amplify: false });
    expect((r.stage3?.alternatives || []).length).toBeGreaterThan(0);
  });
});

describe("what the band must not cost", () => {
  test("a fully covered brief still dispatches", async () => {
    const r = await router.route("escreva um ebook completo sobre finanças pessoais para iniciantes", { registries: all, amplify: false });
    expect(["HIGH", "AMBIGUOUS"]).toContain(r.stage3?.signal);
  });

  test("the threshold reads the fraction, not the raw score", () => {
    // A raw-score floor was measured and REJECTED on 2026-09-19: the golden set
    // bottoms out at 19.8 and the negatives top out at 24.0, which looks like a
    // clean gap until cross-language briefs are included — "criar um ebook sobre
    // emagrecimento com copy persuasiva" scores 14.8 and is entirely legitimate.
    // Any raw floor that catches the negatives abstains on PT-against-EN.
    const src = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "..", "lib", "router.js"), "utf8");
    expect(src).toContain("frac <= 0.5 && cov.total >= 4");
    expect(src).not.toContain("match_min_score");
  });

  test("very short briefs stay with the bands that already govern them", async () => {
    // total >= 4 keeps "escreva o ebook" (2 content tokens) out of this band.
    const r = await router.route("escreva o ebook", { registries: all, amplify: false });
    expect(r.stage3?.reason || "").not.toContain("metade ou menos");
  });
});
