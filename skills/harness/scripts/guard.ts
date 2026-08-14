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
// The same reasoning covers the maestro's OWN context window. Phase 0 has it
// declare an operating budget, and until now nothing ever read that number
// back: the orchestrator of a 13-target run accumulated dispatch instructions,
// tool results and reasoning until every message re-read a quarter-million
// tokens of context. `nrv guard context` closes that loop the only way prose
// can be closed — a deterministic step the prose is told to run.
//
// Usage:
//   nrv guard tick    --project <dir> --action <sig> [--progress <marker>]
//   nrv guard context --project <dir> --used <tokens> [--window <tokens>]
// Exit: 0 continue · 7 STOP (loop ceiling) · 8 ROLL (context budget) · 2 invalid args

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
if (sub !== "tick" && sub !== "context") {
  console.error("usage: nrv guard tick    --project <dir> --action <sig> [--progress <marker>]");
  console.error("       nrv guard context --project <dir> --used <tokens> [--window <tokens>]");
  process.exit(2);
}

/** Fraction of the window at which the orchestrator must checkpoint and continue
 *  in a fresh session. 0.7 leaves room to write the HANDOFF and hand over —
 *  a rollover decided at 95% is a rollover that runs out of room mid-write. */
const ROLL_AT = Number(process.env.NIRVANA_CONTEXT_ROLL_AT || 0.7);

if (sub === "context") {
  const projectDir = arg("--project") || process.cwd();
  const used = Number(arg("--used") || NaN);
  const window = Number(arg("--window") || process.env.NIRVANA_CONTEXT_WINDOW || 200_000);
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(window) || window <= 0) {
    console.error("usage: nrv guard context --project <dir> --used <tokens> [--window <tokens>]");
    process.exit(2);
  }
  const ratio = used / window;
  const budget = Math.floor(window * ROLL_AT);

  // Persisted so a resumed session knows it already rolled, and so the decision
  // is auditable after the fact instead of being a claim in a chat message.
  try {
    const prev = (() => { try { return readHandoff(projectDir)?.context_guard_state || {}; } catch { return {}; } })();
    writeHandoff(projectDir, {
      context_guard_state: {
        window, budget, used, ratio: Number(ratio.toFixed(3)),
        rollovers: (prev.rollovers || 0) + (ratio >= ROLL_AT ? 1 : 0),
        checked_at: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error(`  ⚠ guard: could not persist context_guard_state: ${(e as Error).message}`);
  }

  if (ratio >= ROLL_AT) {
    try {
      const audit = requireCjs("../lib/audit.js");
      audit.emit("context_budget_warning", {
        used_tokens: used, window_tokens: window, budget_tokens: budget,
        ratio: Number(ratio.toFixed(3)), action: "rollover_required",
      }, { cwd: projectDir });
    } catch { /* audit down must never block the rollover advice */ }
    console.error(
      `🔄 CONTEXT GUARD: ${used.toLocaleString()} / ${window.toLocaleString()} tokens ` +
      `(${(ratio * 100).toFixed(0)}%, teto ${budget.toLocaleString()}).\n` +
      `   Escreva o HANDOFF e continue numa sessão nova — não siga acumulando.\n` +
      `   Retomar com: nrv resume ${projectDir}`,
    );
    process.exit(8);
  }
  console.log(`context guard ok — ${used.toLocaleString()}/${window.toLocaleString()} (${(ratio * 100).toFixed(0)}%, rola em ${(ROLL_AT * 100).toFixed(0)}%)`);
  process.exit(0);
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
catch (e) { console.error(`  ⚠ guard: could not persist loop_guard_state: ${(e as Error).message}`); }

if (verdict.stop) {
  console.error(`🛑 LOOP GUARD: ${verdict.reason} (step ${g.snapshot().step_count}). Stop iterating, write the HANDOFF and escalate to the human — do not re-dispatch.`);
  process.exit(7);
}
console.log(`loop guard ok — step ${verdict.step_count}, action="${action}"`);
process.exit(0);
