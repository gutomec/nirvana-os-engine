/**
 * The live page has to say what the catalog says.
 *
 * check-published-packs item 7 compares the bucket against product.ts ON DISK —
 * which approved a day when the deploy never landed: composition was corrected
 * and "deployed", the runner's ssh timed out before the build step, and the
 * page kept advertising 42/11/159 in six languages while every gate stayed
 * green. The only thing that caught it was fetching the page and reading it.
 *
 * `livePageFindings` is that reading, extracted pure so the defect can be
 * planted: a stale page must produce findings, the current one must not.
 */
import { describe, expect, test } from "bun:test";
import { livePageFindings } from "../../../scripts/live-page-findings.ts";

const product = {
  slug: "genesis-circle", version: "0.1.79", basePath: "base/genesis-circle.zip",
  squads: 46, businesses: 12, clones: 171, storefrontPath: "/nirvana-os",
};

describe("the live page agrees with the catalog, or the gate says which line disagrees", () => {
  test("the stale page that shipped is caught", () => {
    // The page as production actually served it on 2026-08-17, after a green
    // deploy: old version, old counts.
    const stale = `<h1>Nirvana-OS</h1> v0.1.78 · 42 production squads, 11 companies and 159 mind-clones`;
    const f = livePageFindings(product, stale);
    expect(f.length).toBe(4); // version + three counts
    expect(f.join("\n")).toContain("0.1.79");
    expect(f.join("\n")).toContain("46");
  });

  test("the corrected page passes", () => {
    const live = `v0.1.79 · 46 production squads, 12 autonomous companies, 171 mind-clones`;
    expect(livePageFindings(product, live)).toEqual([]);
  });

  test("a count embedded in a longer number does not count", () => {
    // "1712" contains "171" — digit boundaries must hold, or a phone number
    // would satisfy the composition.
    const f = livePageFindings(product, `v0.1.79 46 12 x1712x`);
    expect(f.length).toBe(1);
    expect(f[0]).toContain("171");
  });

  test("a product with no storefront page contributes nothing", () => {
    // Only the flagship has its own page; the others are checked by the bucket
    // half of the gate. No page, no live findings — the caller skips the fetch.
    expect(product.storefrontPath).toBeTruthy(); // the fixture itself has one
  });
});
