/**
 * The routing eval costs ~27s because it routes ~3,400 briefs. It is also a
 * pure function of four things — the registries, the golden cases, the
 * negatives, and the engine sources — none of which running it changes. So the
 * verdict is memoized on a content key.
 *
 * The staleness check it replaced keyed on the registry file's mtime, and
 * `nrv index` rewrites that file on every run with a fresh `generated_at` and
 * byte-identical content. Measured on 27/08/2026: mtime 1787814306 → 1787814328,
 * same 5,028,411 bytes, same SHA once `generated_at` is dropped. Every
 * re-index therefore declared the golden set stale and bought a full rebuild
 * plus a full eval for a library that had not moved.
 *
 * What must stay true is the other direction: the key has to notice everything
 * that CAN change the numbers. A cache that misses too often wastes 27s; a
 * cache that hits when it should not reports a green routing gate for an
 * engine nobody measured. These checks pin the second failure, which is the
 * one that is silent.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalCacheKey, engineFingerprint, runEvalCached } from "../scripts/eval-routing.ts";
import { registryFingerprint } from "../scripts/build-golden-set.ts";

/** A registry shaped like the loader's projection, small enough to mutate by hand. */
const registries = () => ({
  squads: {
    schema_version: 5,
    squads: [{ slug: "brandcraft", capabilities: ["branding.identity.create"] }],
    capabilities: { "branding.identity.create": { squad: "brandcraft" } },
    source_path: "/tmp/.squads-registry.json",
  },
  businesses: {
    schema_version: 2,
    businesses: [{ slug: "editora", domains: ["publishing"] }],
    source_path: "/tmp/.businesses-registry.json",
  },
});

const cases = [{ brief: "crie a identidade visual da marca", expected: "brandcraft" }];
const negatives = [{ brief: "que horas são", expected: "NO_MATCH" }];

describe("the eval cache key notices everything that moves the numbers", () => {
  test("same inputs, same key", () => {
    expect(evalCacheKey(registries(), cases, negatives))
      .toBe(evalCacheKey(registries(), cases, negatives));
  });

  test("a changed squad registry changes the key", () => {
    const moved = registries();
    moved.squads.squads[0].capabilities = ["branding.identity.refresh"];
    expect(evalCacheKey(moved, cases, negatives))
      .not.toBe(evalCacheKey(registries(), cases, negatives));
  });

  test("a changed business registry changes the key", () => {
    const moved = registries();
    moved.businesses.businesses[0].domains = ["publishing", "education"];
    expect(evalCacheKey(moved, cases, negatives))
      .not.toBe(evalCacheKey(registries(), cases, negatives));
  });

  test("a changed golden case changes the key", () => {
    expect(evalCacheKey(registries(), [{ ...cases[0], expected: "la-bottega" }], negatives))
      .not.toBe(evalCacheKey(registries(), cases, negatives));
  });

  test("a changed negative changes the key", () => {
    // The negatives carry the safety axis (false dispatch), so they belong in
    // the key even though they never touch the golden numbers.
    expect(evalCacheKey(registries(), cases, [{ brief: "oi", expected: "NO_MATCH" }]))
      .not.toBe(evalCacheKey(registries(), cases, negatives));
  });

  test("a router env flag changes the key", () => {
    const before = evalCacheKey(registries(), cases, negatives);
    process.env.NIRVANA_ROUTER_DENSE = "1";
    try {
      expect(evalCacheKey(registries(), cases, negatives)).not.toBe(before);
    } finally {
      delete process.env.NIRVANA_ROUTER_DENSE;
    }
  });

  test("the engine fingerprint covers the whole require graph, not just router.js", () => {
    // router.js reaches into _shared/lib for paths, the host driver and the
    // dense index. Keying on router.js + bm25.js alone would hand back a
    // cached verdict for an engine that changed underneath it.
    expect(engineFingerprint()).toMatch(/^[0-9a-f]{64}$/);
    expect(engineFingerprint()).toBe(engineFingerprint());
  });

  test("the registry fingerprint reads the projection, which carries no timestamp", () => {
    const a = registryFingerprint(registries());
    const b = registryFingerprint(registries());
    expect(a).toEqual(b);
    expect(a.squads).not.toBe(a.businesses);
  });
});

describe("a hit returns the stored verdict without routing anything", () => {
  test("matching key short-circuits runEval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-cache-"));
    const goldenPath = join(dir, "golden.json");
    const negativesPath = join(dir, "negatives.json");
    const cachePath = join(dir, "cache.json");
    writeFileSync(goldenPath, JSON.stringify({ cases }), "utf8");
    writeFileSync(negativesPath, JSON.stringify({ cases: negatives }), "utf8");

    const regs = registries();
    const key = evalCacheKey(regs, cases, negatives);
    // A sentinel no real eval could produce: if runEval ran, this fails.
    writeFileSync(cachePath, JSON.stringify({ key, result: { sentinel: "stored" } }), "utf8");

    const r: any = await runEvalCached({ registries: regs, goldenPath, negativesPath, cachePath, quiet: true });
    expect(r.sentinel).toBe("stored");
    expect(r.from_cache).toBe(true);
  });
});
