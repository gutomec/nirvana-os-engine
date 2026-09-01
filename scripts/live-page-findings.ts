/**
 * live-page-findings.ts — the live storefront page has to say what the
 * catalog says.
 *
 * Extracted out of the owner's pack-auditing tooling (which moved to a
 * private repo, since most of what it checks is per-buyer attribution
 * detail that has no business being readable in a public engine repo) —
 * this one piece is generic and non-sensitive: comparing a version string
 * and three counts against a page's HTML. It stays here because the engine's
 * own test suite already pins the real incident it exists to catch.
 *
 * On 2026-08-08 a deploy was approved on the strength of a catalog file on
 * disk, while the live page still served the previous version in six
 * languages — the runner's ssh timed out before the build step, so nothing
 * ever re-fetched what was actually served. Pure so it can be tested by
 * planting a stale page; the fetch wiring is the caller's job.
 */

export interface LivePageProduct {
  version: string;
  squads: number;
  businesses: number;
  clones: number;
}

export function livePageFindings(p: LivePageProduct, html: string): string[] {
  const out: string[] = [];
  if (!html.includes(p.version)) out.push(`live page does not mention v${p.version} — the deploy may not have landed`);
  for (const [label, n] of [["squads", p.squads], ["businesses", p.businesses], ["mind-clones", p.clones]] as const) {
    if (n >= 0 && !new RegExp(`(?<!\\d)${n}(?!\\d)`).test(html)) {
      out.push(`live page never shows the count ${n} (${label}) the catalog declares`);
    }
  }
  return out;
}
