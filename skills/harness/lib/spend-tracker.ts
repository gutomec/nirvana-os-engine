// spend-tracker.ts — per-project accumulator of USD spent per cascade entry.
//
// File: <projectRoot>/.nirvana/state/cascade-spend.json
// Shape:
//   { "claude-code:opus": { spend_usd: 4.23, dispatches: 7, last_iso: "..." }, ... }
//
// Each LLM_CASCADE entry has an INDEPENDENT bucket keyed by entry-key
// (runtime[:model][@provider]). A budget-exhaustion on entry "codex:gpt-5.5"
// does NOT affect "codex:qwen3-coder@openrouter" — they're different bucketed
// budgets even though the same CLI binary executes them.
//
// Why per-project: matches the LLM_CASCADE itself, which is per-project. A
// fresh project starts with zero spend. Override via NIRVANA_SPEND_FILE if
// you want global accounting.

import * as fs from "node:fs";
import * as path from "node:path";

interface SpendEntry {
  spend_usd: number;
  dispatches: number;
  last_iso: string;
}
type Registry = Record<string, SpendEntry>;

function fileFor(projectRoot: string): string {
  if (process.env.NIRVANA_SPEND_FILE) return path.resolve(process.env.NIRVANA_SPEND_FILE);
  return path.join(projectRoot, ".nirvana", "state", "cascade-spend.json");
}

function load(projectRoot: string): Registry {
  const f = fileFor(projectRoot);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, "utf8")) as Registry; }
  catch { return {}; }
}

function save(projectRoot: string, reg: Registry): void {
  const f = fileFor(projectRoot);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(reg, null, 2));
}

/** Add USD to an entry's accumulator. No-op if cost is null/undefined/NaN. */
export function addSpend(projectRoot: string, key: string, costUsd: number | null | undefined): void {
  if (costUsd == null || !Number.isFinite(costUsd) || costUsd <= 0) return;
  const reg = load(projectRoot);
  const cur = reg[key] ?? { spend_usd: 0, dispatches: 0, last_iso: "" };
  reg[key] = {
    spend_usd: +(cur.spend_usd + costUsd).toFixed(6),
    dispatches: cur.dispatches + 1,
    last_iso: new Date().toISOString(),
  };
  save(projectRoot, reg);
}

export function getSpend(projectRoot: string, key: string): number {
  const reg = load(projectRoot);
  return reg[key]?.spend_usd ?? 0;
}

/** True iff this entry has a budget AND accumulated spend >= budget. */
export function isBudgetExhausted(projectRoot: string, key: string, budgetUsd: number | null): boolean {
  if (budgetUsd == null) return false;
  return getSpend(projectRoot, key) >= budgetUsd;
}

/** Reset an entry (e.g. user-initiated cascade reset). */
export function resetSpend(projectRoot: string, key?: string): void {
  if (!key) { save(projectRoot, {}); return; }
  const reg = load(projectRoot);
  delete reg[key];
  save(projectRoot, reg);
}

/** Snapshot for telemetry / nrv glance. */
export function snapshot(projectRoot: string): Registry {
  return load(projectRoot);
}
