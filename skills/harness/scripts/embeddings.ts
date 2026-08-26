#!/usr/bin/env bun
// embeddings.ts — manages the optional neural (dense) arm of the fast router.
//
// The base product is zero-dep (BM25 + hash_tfidf). This command is the opt-in
// that installs the neural backend (@huggingface/transformers, ONNX, local, no
// Python) and activates the router's dense NO_MATCH FALLBACK slot
// (config.yaml routing.dense: "fallback" — router.js Stage 3.5).
//
// What "active" honestly means (measured 2026-08-05, routing-360 Phase 3.4):
// the dense arm is consulted ONLY when BM25's coverage gate yields NO_MATCH,
// and a candidate clearing cosine >= 0.55 comes back as an AMBIGUOUS
// suggestion for the user to confirm — never an automatic dispatch (never
// HIGH). There is NO BM25+dense fusion mode: fusion measured 29% vs 100%
// top-1 and is retired.
//
// Usage: nrv embeddings <status|enable|disable|reindex>
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { requestedBackend, neuralEmbedderAvailable, resolveEmbedder } from "../lib/../../_shared/lib/embedder.ts";
import { setRoutingDense } from "../lib/harness-config.ts";
import { describeSettingSource, resolveSetting } from "../../_shared/lib/settings.ts";

const NIRVANA_HOME = process.env.NIRVANA_HOME || path.join(os.homedir(), ".nirvana");
const BACKEND_FILE = path.join(NIRVANA_HOME, "embedder-backend.txt");
const CACHE_DIR = path.join(NIRVANA_HOME, "cache");
const PKG = "@huggingface/transformers";

async function status() {
  const backend = requestedBackend() || "hash_tfidf (default)";
  console.log(`requested backend: ${backend}`);
  let installed = false;
  try { require.resolve(PKG); installed = true; } catch { /* not installed */ }
  console.log(`neural package:    ${installed ? PKG + " installed" : "missing (run `nrv embeddings enable`)"}`);
  if (requestedBackend() === "transformers" || requestedBackend() === "neural") {
    process.stdout.write("neural model:      checking…\r");
    const ok = await neuralEmbedderAvailable();
    console.log(`neural model:      ${ok ? "loads OK" : "unavailable → hash_tfidf fallback"}`);
  }
  const dense = resolveSetting("routing.dense");
  console.log(`routing.dense:     ${dense.value} (${describeSettingSource(dense)})`);
  let cached = 0;
  try { cached = fs.readdirSync(CACHE_DIR).filter((f) => f.startsWith("dense-")).length; } catch { /* none */ }
  console.log(`dense index:       ${cached} file(s) cached`);
}

/**
 * Honest post-enable summary. The dense arm never fuses with BM25 and never
 * dispatches on its own: when active (routing.dense: "fallback") it is
 * consulted ONLY on a BM25 NO_MATCH and its ceiling is an AMBIGUOUS
 * suggestion. When the neural backend fails to load, the config is left
 * untouched ("off") — recording an activation that would silently no-op is the
 * dishonesty this summary exists to prevent. Exported for tests.
 */
export function enableSummary(neuralLoaded: boolean): { info: string[]; warn: string[]; activate: boolean } {
  if (!neuralLoaded) {
    return {
      info: [],
      warn: [
        "⚠ WARNING: the neural backend did not load — the embedder silently degraded to hash_tfidf.",
        `  Check that ${PKG} is resolvable from the skills tree and the model can download on first use.`,
        '  routing.dense was left at "off": the fallback slot would be a no-op without the model.',
      ],
      activate: false,
    };
  }
  return {
    info: [
      "✓ Neural backend verified: the model loads and embeds.",
      '✓ routing.dense set to "fallback" (your global ~/.nirvana/config.yaml; survives nrv update).',
      "What that means — measured, not marketing (Phase 3.4, 2026-08-05):",
      "  - The dense arm is consulted ONLY when BM25 abstains (NO_MATCH).",
      "  - A candidate clearing cosine >= 0.55 is returned as an AMBIGUOUS",
      "    suggestion for you to confirm — never dispatched (never HIGH).",
      "  - Golden briefs are untouched (0/2963 reach NO_MATCH); abstention",
      "    floors hold; multilingual recovery is partial (3/12 probes).",
      "  - There is NO BM25+dense fusion mode (measured 29% vs 100% top-1).",
      "Revert anytime: `nrv embeddings disable` (or NIRVANA_ROUTER_DENSE=0).",
    ],
    warn: [],
    activate: true,
  };
}

async function enable() {
  console.log(`Installing ${PKG} (~150MB, once) in ${NIRVANA_HOME}…`);
  const r = spawnSync("bun", ["add", PKG], { cwd: NIRVANA_HOME, stdio: "inherit" });
  if (r.status !== 0) { console.error("failed to install the neural package."); process.exit(1); }
  fs.writeFileSync(BACKEND_FILE, "transformers\n", "utf8");
  console.log("Backend recorded. Verifying it actually loads (model downloads on first use)…");
  // Verify the recorded backend truly resolves — resolveEmbedder() falls back
  // to hash_tfidf silently, so surface that degradation here instead of
  // claiming the neural arm is active.
  const embedder = await resolveEmbedder();
  const neuralLoaded = embedder.name.startsWith("transformers:");
  const { info, warn, activate } = enableSummary(neuralLoaded);
  if (activate) console.log(`routing.dense: "fallback" written to ${setRoutingDense("fallback")}`);
  for (const line of info) console.log(line);
  for (const line of warn) console.error(line);
}

function disable() {
  try { fs.rmSync(BACKEND_FILE); } catch { /* já ausente */ }
  const written = setRoutingDense("off");
  console.log(`Neural backend disabled — back to BM25 + hash_tfidf (zero-dep).`);
  console.log(`routing.dense: "off" written to ${written}`);
}

function reindex() {
  let n = 0;
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (f.startsWith("dense-")) { fs.rmSync(path.join(CACHE_DIR, f)); n++; }
    }
  } catch { /* sem cache */ }
  console.log(`Dense index cache cleared (${n} file(s)). Recomputed on the next find.`);
}

// CLI entry — guarded so tests can import enableSummary() without running it.
if (import.meta.main) {
  const cmd = (process.argv[2] || "status").toLowerCase();
  switch (cmd) {
    case "status": await status(); break;
    case "enable": case "on": await enable(); break;
    case "disable": case "off": disable(); break;
    case "reindex": case "reset": reindex(); break;
    default:
      console.error("usage: nrv embeddings <status|enable|disable|reindex>");
      process.exit(2);
  }
}
