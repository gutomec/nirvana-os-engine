#!/usr/bin/env bun
/**
 * preflight-index.ts — staleness pre-flight for router entrypoints.
 *
 * find.ts / route.ts / dispatch.ts call this before routing (routing-360
 * Phase 2.5): when any routing registry (squads / businesses / mind-clones)
 * is older than its content roots, it synchronously runs
 * `index.ts --if-stale --quiet` so the router never scores against a stale
 * corpus. When everything is fresh the check is mtime stats only (<50ms)
 * and nothing is spawned.
 *
 * Recursion guard: the spawned indexer (and everything it spawns) inherits
 * NRV_IN_PREFLIGHT=1, and this function is a no-op while that marker is set —
 * index.ts can never trigger another pre-flight. NRV_PREFLIGHT=0 is the
 * user-facing opt-out.
 */

import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { BUN_BIN } from "../../_shared/lib/bun-helpers.ts";
import { allRegistriesFresh } from "../scripts/index.ts";

/** Returns true when a reindex was actually spawned. */
export function preflightReindex(): boolean {
  if (process.env.NRV_PREFLIGHT === "0" || process.env.NRV_IN_PREFLIGHT === "1") return false;
  let fresh: boolean;
  try { fresh = allRegistriesFresh(); } catch { return false; } // never block routing
  if (fresh) return false;
  const indexScript = path.join(import.meta.dir, "..", "scripts", "index.ts");
  spawnSync(BUN_BIN, [indexScript, "--if-stale", "--quiet"], {
    // stdout ignored so routing scripts keep machine-parseable output clean;
    // indexer failures still surface on stderr.
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, NRV_IN_PREFLIGHT: "1" },
    timeout: 120_000,
  });
  return true;
}
