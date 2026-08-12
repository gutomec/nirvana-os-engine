/**
 * harness-config.ts — minimal typed reader for skills/harness/config.yaml.
 *
 * Owns two config surfaces (routing-360 Phase 3.4):
 *
 *   routing.dense — "off" | "fallback". Governs the router's dense NO_MATCH
 *     fallback slot (router.js Stage 3.5). "fallback" means: consult the
 *     neural (multilingual MiniLM) arm ONLY when BM25's coverage gate yields
 *     NO_MATCH, and surface a clearing candidate as an AMBIGUOUS suggestion —
 *     never a dispatch. Default "off" (measured 2026-08-05: no cosine
 *     threshold both recovers the majority of multilingual probes AND holds
 *     the negatives NO_MATCH floor; see baselines/golden-multilingual-probes.json).
 *     `nrv embeddings enable` flips it to "fallback" after verifying the
 *     neural backend actually loads.
 *
 *   routing.on_router_failure — "cascade" | "fail" (routing-360 Phase 4).
 *     Governs dispatch.ts when the agentic router fails at the transport
 *     level even after one retry. Default "cascade" (BM25 → agent-x ladder).
 *
 *   quality_gate.* — typed passthrough for the Phase 4 enforcement work.
 *     `judge_enabled` (default false) turns the LLM-judge path of the
 *     delivery pipeline on; heuristics remain the offline default.
 *
 * Precedence for the dense mode: env NIRVANA_ROUTER_DENSE ("1" → fallback,
 * "0" → off) > config.yaml routing.dense > default "off". Env stays as the
 * per-run override; the config file is the persistent state.
 *
 * Budget/baselines keys are deliberately NOT read here — lib/budget.js owns
 * them; routing.mode is owned by _shared/lib/routing-mode.ts. One key, one owner.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type DenseRoutingMode = "off" | "fallback";

/** What dispatch.ts does when the agentic router fails at the TRANSPORT level
 *  (ok:false) even after one retry (routing-360 Phase 4):
 *    "cascade" (default) — fall down the ladder: fast BM25 route, then agent-x
 *                          with a loud warning. The brief never stalls.
 *    "fail"              — exit non-zero and surface the router error. */
export type RouterFailurePolicy = "cascade" | "fail";

export interface QualityGateConfig {
  judge_enabled: boolean;
  max_revisions: number;
  escalate_after: number;
  rubric_fallback: string;
  default_judge_model: string;
  [key: string]: unknown;
}

export interface HarnessConfig {
  routing: { dense: DenseRoutingMode; on_router_failure: RouterFailurePolicy };
  quality_gate: QualityGateConfig;
  /** Path the config was read from; null when no candidate file exists. */
  config_path: string | null;
}

const QUALITY_GATE_DEFAULTS: QualityGateConfig = {
  judge_enabled: false,
  max_revisions: 2,
  escalate_after: 2,
  rubric_fallback: "prose_shortform",
  default_judge_model: "inherit",
};

// Mirrored layout in the source tree and the installed tree (~/.nirvana/skills):
// this file lives in harness/lib, so the sibling config is one level up. The
// SKILLS_ROOT fallback covers callers that load a copied lib outside the tree.
const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills"))
    ? path.join(os.homedir(), ".nirvana", "skills")
    : path.join(os.homedir(), ".claude", "skills"));

export const CONFIG_CANDIDATES = [
  path.join(import.meta.dir, "..", "config.yaml"),
  path.join(SKILLS_ROOT, "harness", "config.yaml"),
];

/** First existing candidate — the file the router actually reads, and the one
 *  `nrv embeddings enable/disable` edits. Null on a config-less install. */
export function resolveConfigPath(): string | null {
  for (const p of CONFIG_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* next */ }
  }
  return null;
}

function normalizeDense(value: unknown): DenseRoutingMode | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "off" || v === "fallback") return v;
  return null;
}

function normalizeRouterFailure(value: unknown): RouterFailurePolicy | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "cascade" || v === "fail") return v;
  return null;
}

interface CacheEntry { path: string; mtimeMs: number; config: HarnessConfig; }
let _cache: CacheEntry | null = null;

function defaults(configPath: string | null): HarnessConfig {
  return {
    routing: { dense: "off", on_router_failure: "cascade" },
    quality_gate: { ...QUALITY_GATE_DEFAULTS },
    config_path: configPath,
  };
}

/**
 * Read and parse the harness config. Tolerates absence, malformed YAML and a
 * missing `yaml` package — every failure degrades to defaults (dense "off"),
 * never a throw. Cached by path+mtime: route() may run thousands of times per
 * eval and must not re-parse on every call.
 *
 * @param explicitPath test hook / caller override; bypasses the cache.
 */
export function loadHarnessConfig(explicitPath?: string): HarnessConfig {
  const p = explicitPath ?? resolveConfigPath();
  if (!p) return defaults(null);
  let mtimeMs: number;
  try { mtimeMs = fs.statSync(p).mtimeMs; } catch { return defaults(null); }
  if (!explicitPath && _cache && _cache.path === p && _cache.mtimeMs === mtimeMs) {
    return _cache.config;
  }

  let parsed: any = null;
  try {
    const YAML = require("yaml");
    parsed = YAML.parse(fs.readFileSync(p, "utf8"));
  } catch { parsed = null; }

  const config = defaults(p);
  if (parsed && typeof parsed === "object") {
    const dense = normalizeDense(parsed.routing?.dense);
    if (dense) config.routing.dense = dense;
    const onFail = normalizeRouterFailure(parsed.routing?.on_router_failure);
    if (onFail) config.routing.on_router_failure = onFail;
    if (parsed.quality_gate && typeof parsed.quality_gate === "object") {
      config.quality_gate = { ...QUALITY_GATE_DEFAULTS, ...parsed.quality_gate };
    }
  }
  if (!explicitPath) _cache = { path: p, mtimeMs, config };
  return config;
}

/**
 * The effective dense routing mode: env override > config > "off".
 * This is THE function router.js consults for its Stage 3.5 fallback slot.
 */
export function denseRoutingMode(explicitPath?: string): DenseRoutingMode {
  const env = (process.env.NIRVANA_ROUTER_DENSE || "").trim();
  if (env === "1") return "fallback";
  if (env === "0") return "off";
  return loadHarnessConfig(explicitPath).routing.dense;
}

/**
 * Persist routing.dense in config.yaml with a comment-preserving line edit:
 * only the `dense:` line inside the top-level `routing:` block is rewritten
 * (keeping any inline comment); when the key is absent it is inserted right
 * after the `routing:` line. Every other byte of the file is untouched — the
 * config carries curated comments a YAML re-serialize would destroy.
 *
 * Returns the path written, or null when no config file exists to edit.
 */
export function setRoutingDense(mode: DenseRoutingMode, explicitPath?: string): string | null {
  const p = explicitPath ?? resolveConfigPath();
  if (!p || !fs.existsSync(p)) return null;
  const src = fs.readFileSync(p, "utf8");
  const lines = src.split("\n");

  let inRouting = false;
  let routingLineIdx = -1;
  let denseLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const topLevel = /^[A-Za-z0-9_]+\s*:/.test(line);
    if (topLevel) inRouting = /^routing\s*:/.test(line);
    if (inRouting && /^routing\s*:/.test(line)) routingLineIdx = i;
    if (inRouting && /^\s+dense\s*:/.test(line)) { denseLineIdx = i; break; }
  }

  const quoted = `"${mode}"`; // quoted so YAML 1.1 parsers never read `off` as boolean
  if (denseLineIdx !== -1) {
    const m = lines[denseLineIdx].match(/^(\s+dense\s*:\s*)(?:"[^"]*"|'[^']*'|[^#\s]+)?\s*(#.*)?$/);
    lines[denseLineIdx] = m
      ? `${m[1]}${quoted}${m[2] ? "   " + m[2] : ""}`
      : `  dense: ${quoted}`;
  } else if (routingLineIdx !== -1) {
    lines.splice(routingLineIdx + 1, 0, `  dense: ${quoted}`);
  } else {
    lines.push("routing:", `  dense: ${quoted}`);
  }

  fs.writeFileSync(p, lines.join("\n"), "utf8");
  _cache = null; // invalidate — next read sees the new state
  return p;
}
