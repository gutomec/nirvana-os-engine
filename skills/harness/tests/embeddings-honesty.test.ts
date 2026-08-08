// embeddings-honesty.test.ts — regression for `nrv embeddings enable` output.
//
// History: enable() once printed "O roteador fast agora funde BM25 + denso
// (RRF)" — false then (nothing set the fusion env vars) and structurally false
// now (Phase 3.4 retired BM25+dense fusion after it measured 29% vs 100%
// top-1). The honest contract this file pins:
//   - enable never claims fusion; it describes the NO_MATCH fallback slot:
//     suggestion-only (AMBIGUOUS), never a dispatch (never HIGH);
//   - a neural backend that fails to load is surfaced as degradation AND does
//     not activate routing.dense — no config state that would silently no-op;
//   - the script verifies the backend via resolveEmbedder() and persists the
//     state via harness-config.setRoutingDense, not via env vars.
// Runs with: bun test skills/harness/tests
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { enableSummary } from "../scripts/embeddings.ts";

const SCRIPT = path.resolve(import.meta.dir, "../scripts/embeddings.ts");

describe("nrv embeddings enable — honest output", () => {
  test("never claims fusion; describes the fallback slot as suggestion-only", () => {
    const { info } = enableSummary(true);
    const text = info.join("\n");
    expect(text).not.toMatch(/agora funde|now fuses|ATIVO/i);
    expect(text).toContain("NO_MATCH");
    expect(text).toContain("AMBIGUOUS");
    expect(text).toMatch(/never dispatched|never HIGH/);
    expect(text).toMatch(/NO BM25\+dense fusion/i);
  });

  test("activates routing.dense only when the neural backend actually loads", () => {
    expect(enableSummary(true).activate).toBe(true);
    expect(enableSummary(false).activate).toBe(false);
  });

  test("warns about silent degradation when the neural backend does not load", () => {
    const { warn } = enableSummary(false);
    const text = warn.join("\n");
    expect(text).toMatch(/degraded/i);
    expect(text).toContain("hash_tfidf");
    expect(text).toMatch(/left at "off"/);
  });

  test("no degradation warning when the neural backend loads", () => {
    expect(enableSummary(true).warn).toEqual([]);
  });

  test("the script verifies the backend and persists state via harness-config", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    expect(src).not.toContain("funde BM25 + denso (RRF)"); // old false claim
    expect(src).toMatch(/await resolveEmbedder\(\)/);       // verification step
    expect(src).toMatch(/setRoutingDense\("fallback"\)/);   // enable persists config
    expect(src).toMatch(/setRoutingDense\("off"\)/);        // disable reverses it
  });
});
