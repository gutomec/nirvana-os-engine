// routing-mode.ts — single source of truth for the system-wide routing mode.
//
// Routing mode is a PROPAGATING system property: the maestro uses it at the top
// level (business-or-squad selection), and business employees use it to find
// squads. Three modes:
//
//   agentic (default) — an agent inspects the registries and reasons about the
//                       best target. Higher quality, costs tokens.
//   cards             — one tool-less call over compiled one-line cards
//                       (harness/lib/cards-router.ts). Costs tokens, answers
//                       in one turn; the router does not open any file.
//   fast              — BM25/keyword matching over the registry indexes
//                       (harness/lib/router.js). Zero-token, deterministic,
//                       lower quality. Opt-in for cost-sensitive runs.
//
// Businesses and the Glance compose their own routing and read only whether
// the mode is `fast`; to them `cards` is the agentic default.
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

export type RoutingMode = "agentic" | "cards" | "fast";

const VALID: RoutingMode[] = ["agentic", "cards", "fast"];

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

/**
 * Where the routing mode came from, which is the difference between a choice
 * and an inheritance.
 *
 * The keyword router is not advertised to agents any more — it is not in the
 * help, not in the protocol, not in a seat's prompt. Concealment alone would be
 * worse than the advertising it replaced: a machine that has `routing.mode:
 * fast` in a config file (inherited, copied from an old tutorial, set months
 * ago and forgotten) would route by keyword forever while the agent driving it
 * has never heard the mode exists and cannot explain what it is seeing.
 *
 * So the mode is silent when it is chosen and loud when it is inherited.
 */
export function routingModeOrigin(explicit?: string | null): "flag" | "env" | "config" | "default" {
  if (normalize(explicit)) return "flag";
  const r = resolveSetting("routing.mode");
  if (r.source === "env") return "env";
  // `engine-default` is the value shipped in the engine config — nobody on this
  // machine chose it, so it is a default and not an inheritance to warn about.
  return r.source === "default" || r.source === "engine-default" ? "default" : "config";
}

export function isFastMode(explicit?: string | null): boolean {
  return resolveRoutingMode(explicit) === "fast";
}
