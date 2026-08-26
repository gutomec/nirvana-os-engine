// routing-mode.ts — single source of truth for the system-wide routing mode.
//
// Routing mode is a PROPAGATING system property: the maestro uses it at the top
// level (business-or-squad selection), and business employees use it to find
// squads. Two modes:
//
//   agentic (default) — an agent inspects the registries and reasons about the
//                       best target. Higher quality, costs tokens.
//   fast              — BM25/keyword matching over the registry indexes
//                       (harness/lib/router.js). Zero-token, deterministic,
//                       lower quality. Opt-in for cost-sensitive runs.
//
// Precedence: explicit arg (--mode) > the `routing.mode` setting, resolved by
// _shared/lib/settings.ts (env NIRVANA_ROUTING_MODE > project config > global
// config > harness config.yaml > 'agentic'). An unknown explicit value falls
// back to the resolved setting (the safe, higher-quality default) with a
// warning; an unknown value in a variable or a file is a clear error there.
//
// Lives in _shared because BOTH harness (dispatch) and businesses
// (employee-prompt) consume it.

import { resolveSetting } from "./settings.ts";

export type RoutingMode = "agentic" | "fast";

const VALID: RoutingMode[] = ["agentic", "fast"];

function normalize(value: string | null | undefined): RoutingMode | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (VALID.includes(v as RoutingMode)) return v as RoutingMode;
  console.error(`[routing-mode] unknown mode '${value}', falling back to the configured mode`);
  return null;
}

/**
 * Resolve the active routing mode.
 * @param explicit value from a --mode flag (takes precedence over env/config).
 */
export function resolveRoutingMode(explicit?: string | null): RoutingMode {
  return normalize(explicit) ?? resolveSetting("routing.mode").value;
}

export function isFastMode(explicit?: string | null): boolean {
  return resolveRoutingMode(explicit) === "fast";
}
