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
// Precedence: explicit arg (--mode) > env NIRVANA_ROUTING_MODE > harness
// config.yaml routing.mode > default 'agentic'. Unknown values fall back to
// 'agentic' (the safe, higher-quality default) and emit a warning.
//
// Lives in _shared because BOTH harness (dispatch) and businesses
// (employee-prompt) consume it.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";

export type RoutingMode = "agentic" | "fast";

const VALID: RoutingMode[] = ["agentic", "fast"];

// Mirrored structure in source tree and installed (~/.nirvana/skills): harness
// config sits two levels up from _shared/lib. Fall back to the installed home path.
const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));
const CONFIG_CANDIDATES = [
  path.join(import.meta.dir, "..", "..", "harness", "config.yaml"),
  path.join(SKILLS_ROOT, "harness", "config.yaml"),
];

function normalize(value: string | null | undefined): RoutingMode | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (VALID.includes(v as RoutingMode)) return v as RoutingMode;
  console.error(`[routing-mode] unknown mode '${value}', falling back to 'agentic'`);
  return null;
}

function fromConfig(): RoutingMode | null {
  for (const p of CONFIG_CANDIDATES) {
    try {
      if (!fs.existsSync(p)) continue;
      const cfg = YAML.parse(fs.readFileSync(p, "utf8"));
      const m = normalize(cfg?.routing?.mode);
      if (m) return m;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/**
 * Resolve the active routing mode.
 * @param explicit value from a --mode flag (takes precedence over env/config).
 */
export function resolveRoutingMode(explicit?: string | null): RoutingMode {
  return (
    normalize(explicit) ??
    normalize(process.env.NIRVANA_ROUTING_MODE) ??
    fromConfig() ??
    "agentic"
  );
}

export function isFastMode(explicit?: string | null): boolean {
  return resolveRoutingMode(explicit) === "fast";
}
