#!/usr/bin/env bun
// guard.ts — `nrv guard tick`: circuit breaker para o loop do maestro em prosa.
//
// O maestro é prosa (SKILL.md), então não há como impor um teto de loop por
// código a não ser que a prosa execute um passo determinístico a cada iteração —
// o mesmo padrão que o SKILL.md já usa para verify-deliverable / quality-gate.
// Cada `nrv guard tick` rehidrata o loop-guard do HANDOFF, registra a iteração,
// checa os tetos (max_steps / max_repeat / max_flat_steps) e persiste de volta.
// Sai 7 quando manda parar — a prosa é instruída a parar e subir ao humano.
//
// Uso:
//   nrv guard tick --project <dir> --action <sig> [--progress <marker>]
// Exit: 0 segue · 7 STOP (teto batido) · 2 args inválidos

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
const progress = arg("--progress"); // string|undefined — passe um hash/contagem de artefatos real

let snap: any = null;
try { snap = readHandoff(projectDir)?.loop_guard_state || null; } catch { /* sem handoff — guard fresco */ }

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
