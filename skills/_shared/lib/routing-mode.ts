// routing-mode.ts — single source of truth for the system-wide routing mode.
//
// Routing mode is a PROPAGATING system property: the maestro uses it at the top
// level (business-or-squad selection), and business employees use it to find
// squads. Two modes:
//
//   agentic (default) — an agent inspects the registries and reasons about the
//                       best target. Higher quality, costs tokens.
//   cards             — one tool-less call over compiled one-line cards
//                       (harness/lib/cards-router.ts). Costs tokens, answers
//                       in one turn; the router does not open any file.
//
// `fast` (BM25 over the registry indexes deciding the target) was retired: on
// 48 labeled requests (2026-10-13) it answered AMBIGUOUS for 42 and found the
// right business for 4 of 42. BM25 still builds shortlists (`nrv find`, the
// clone search, the capability tiebreak in a squad); it never decides who
// executes. A stored `fast` (a config file, NIRVANA_ROUTING_MODE) reads as
// unset, with one warning (settings.ts, `SettingSpec.retired`); `--mode=fast`
// is refused by the dispatcher.
//
// Precedence: explicit arg (--mode) > the `routing.mode` setting, resolved by
// _shared/lib/settings.ts (env NIRVANA_ROUTING_MODE > project config > global
// config > profile > harness config.yaml > 'agentic'). An unknown explicit
// value falls back to the resolved setting (the safe, higher-quality default)
// with a warning; an unknown value in a variable or a file is a clear error there.
//
// Lives in _shared because the harness and the squad runner both consume it.

import { resolveSetting } from "./settings.ts";

export type RoutingMode = "agentic" | "cards";

const VALID: RoutingMode[] = ["agentic", "cards"];

function normalize(value: string | null | undefined): RoutingMode | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (VALID.includes(v as RoutingMode)) return v as RoutingMode;
  // `--mode=fast` is refused by the dispatcher with its own message (exit 4).
  if (v !== "fast") console.error(`[routing-mode] unknown mode '${value}', falling back to the configured mode`);
  return null;
}

/**
 * Resolve the active routing mode.
 * @param explicit value from a --mode flag (takes precedence over env/config).
 */
export function resolveRoutingMode(explicit?: string | null): RoutingMode {
  return normalize(explicit) ?? resolveSetting("routing.mode").value;
}
