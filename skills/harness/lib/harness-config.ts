/**
 * harness-config.ts — the harness view over the settings core
 * (_shared/lib/settings.ts).
 *
 * Kept for its consumers (dispatch, revise, supervisor, embeddings, router):
 * `loadHarnessConfig()` returns the routing / quality_gate shape they read,
 * resolved through settings.ts (env > project > global > engine default >
 * default), never beside it. `denseRoutingMode()` and `setRoutingDense()` keep
 * their signatures: the dense mode is the `routing.dense` setting, and
 * `nrv embeddings enable` now persists it in the user's global config, which
 * survives engine updates (the engine's own config.yaml is overwritten by
 * every update and is only the engine-default layer).
 *
 *   routing.dense — "off" | "fallback". Governs the router's dense NO_MATCH
 *     fallback slot (router.js Stage 3.5). "fallback" means: consult the
 *     neural (multilingual MiniLM) arm ONLY when BM25's coverage gate yields
 *     NO_MATCH, and surface a clearing candidate as an AMBIGUOUS suggestion —
 *     never a dispatch. Default "off" (measured 2026-08-05: no cosine
 *     threshold both recovers the majority of multilingual probes AND holds
 *     the negatives NO_MATCH floor; see baselines/golden-multilingual-probes.json).
 *
 *   routing.on_router_failure — "cascade" | "fail" (routing-360 Phase 4).
 *     Governs dispatch.ts when the agentic router fails at the transport
 *     level even after one retry. Default "cascade" (BM25 → agent-x ladder).
 *
 *   quality_gate.* — `judge_enabled` (default false) turns the LLM-judge path
 *     of the delivery pipeline on; heuristics remain the offline default.
 *
 * Explicit paths remain the test hook: `loadHarnessConfig(file)` and
 * `denseRoutingMode(file)` read that file as the only file layer,
 * `setRoutingDense(mode, file)` edits it in place.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import {
  editSettingInFile, engineConfigPath, resolveAllSettings, resolveSetting, setSetting,
  type ResolveOptions, type SettingsAudit,
} from "../../_shared/lib/settings.ts";

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
  /** The engine-default file (or the explicit file); null when it does not exist. */
  config_path: string | null;
}

/** The engine's config.yaml: the engine-default layer. Null on a config-less install. */
export function resolveConfigPath(): string | null {
  return engineConfigPath();
}

/** An explicit file is the only file layer; the environment still applies. */
function fileOnly(explicitPath: string): ResolveOptions {
  return { projectRoot: null, globalPath: null, enginePath: explicitPath };
}

/**
 * The harness shape of the effective settings. With `explicitPath` the file
 * is read alone (no project, global or engine layer, no environment).
 * A malformed file or an invalid value is a clear error naming the file.
 */
export function loadHarnessConfig(explicitPath?: string): HarnessConfig {
  const values: Record<string, unknown> = {};
  for (const resolved of resolveAllSettings(explicitPath ? { ...fileOnly(explicitPath), env: {} } : {})) values[resolved.key] = resolved.value;
  return {
    routing: {
      dense: values["routing.dense"] as DenseRoutingMode,
      on_router_failure: values["routing.on_router_failure"] as RouterFailurePolicy,
    },
    quality_gate: {
      judge_enabled: values["quality_gate.judge_enabled"] as boolean,
      max_revisions: values["quality_gate.max_revisions"] as number,
      escalate_after: values["quality_gate.escalate_after"] as number,
      rubric_fallback: values["quality_gate.rubric_fallback"] as string,
      default_judge_model: values["quality_gate.default_judge_model"] as string,
    },
    config_path: explicitPath ? (fs.existsSync(explicitPath) ? explicitPath : null) : engineConfigPath(),
  };
}

/**
 * The effective dense routing mode: env NIRVANA_ROUTER_DENSE (1 → fallback,
 * 0 → off) > project > global > engine default > "off".
 * This is THE function router.js consults for its Stage 3.5 fallback slot.
 */
export function denseRoutingMode(explicitPath?: string): DenseRoutingMode {
  return resolveSetting("routing.dense", explicitPath ? fileOnly(explicitPath) : {}).value;
}

const auditEmit: SettingsAudit = (event, payload) => {
  try { createRequire(import.meta.url)("./audit.js").emit(event, payload); } catch { /* the file change is the record; the audit is best effort */ }
};

/**
 * Persist routing.dense with a comment-preserving line edit (settings.ts
 * editSettingInFile): only the `dense:` line inside the `routing:` block
 * moves. Without `explicitPath` the value lands in the user's global config
 * (created when absent) and is audited as `x_settings_changed`; with it, that
 * file is edited in place and null is returned when it does not exist.
 */
export function setRoutingDense(mode: DenseRoutingMode, explicitPath?: string): string | null {
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) return null;
    return editSettingInFile(explicitPath, "routing.dense", mode).path;
  }
  return setSetting("routing.dense", mode, { scope: "global", ignoreEnv: true, audit: auditEmit }).path;
}
