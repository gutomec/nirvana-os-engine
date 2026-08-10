#!/usr/bin/env bun
// guard.ts — `nrv guard tick`: circuit breaker for the prose maestro's loop.
//
// The maestro is prose (SKILL.md), so there is no way to enforce a loop ceiling
// in code unless the prose runs a deterministic step on every iteration —
// the same pattern SKILL.md already uses for verify-deliverable / quality-gate.
// Each `nrv guard tick` rehydrates the loop-guard from the HANDOFF, records the
// iteration, checks the ceilings (max_steps / max_repeat / max_flat_steps) and
// persists it back. Exits 7 when it orders a stop — the prose is instructed to
// stop and escalate to the human.
//
// Usage:
//   nrv guard tick --project <dir> --action <sig> [--progress <marker>]
// Exit: 0 continue · 7 STOP (ceiling hit) · 2 invalid args

import { createRequire } from "node:module";
const requireCjs = createRequire(import.meta.url);
const { createLoopGuard } = requireCjs("../../_shared/lib/loop-guard.js");
const { readHandoff, writeHandoff } = requireCjs("../../_shared/lib/handoff.js");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return fallback;
  const a = process.argv[i];
  if (a.includes("=")) return a.split("=").slice(1).join("=");
  return process.argv[i + 1] || fallback;
}

const sub = process.argv[2];
if (sub !== "tick") {
  console.error("uso: nrv guard tick --project <dir> --action <sig> [--progress <marker>]");
  process.exit(2);
}

const projectDir = arg("--project") || process.cwd();
const action = arg("--action") || "iteration";
const progress = arg("--progress"); // string|undefined — pass a real artifact hash/count

let snap: any = null;
try { snap = readHandoff(projectDir)?.loop_guard_state || null; } catch { /* no handoff — fresh guard */ }

const g = createLoopGuard(snap?.cfg);
if (snap) {
  g.state.step_count = snap.step_count || 0;
  g.state.last_progress_step = snap.last_progress_step || 0;
  g.state.progress_marker = snap.progress_marker ?? null;
  g.state.seen_signatures = new Map(Object.entries(snap.seen_signatures || {}));
}

g.record(action, {}, progress);
const verdict = g.check();

try { writeHandoff(projectDir, { loop_guard_state: g.snapshot() }); }
catch (e) { console.error(`  ⚠ guard: não consegui persistir loop_guard_state: ${(e as Error).message}`); }

if (verdict.stop) {
  console.error(`🛑 LOOP GUARD: ${verdict.reason} (step ${g.snapshot().step_count}). Pare de iterar, escreva o HANDOFF e suba ao humano — não re-despache.`);
  process.exit(7);
}
console.log(`loop guard ok — step ${verdict.step_count}, action="${action}"`);
process.exit(0);
