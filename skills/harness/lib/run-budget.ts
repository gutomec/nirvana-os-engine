// run-budget.ts — a ceiling the OWNER asked for, spent once across a whole run.
//
// `--max-budget` was passed to every child at its full value. A chain of six
// employees therefore got six times the ceiling, and a run the owner capped at
// US$ 2 spent US$ 4,90 on a customer VPS — the worst case being one ceiling per
// seat, which for a large org chart is an order of magnitude.
//
// The cap the owner names is for the RUN. So it is a balance that decreases:
// each child is offered what is left, and when nothing is left the run stops
// instead of starting a seat it cannot pay for.
//
// Two rules the rest of this file exists to keep:
//
//   · A budget is NEVER imputed. No ceiling unless the owner named a number
//     (`--max-budget`), a business manifest declares `run_budget_usd`, or a
//     serve key was minted with one. `open(undefined)` is the normal case and
//     it means unlimited, exactly like every other cap in this engine spells it.
//   · A ceiling is HARD, not advisory. The contract says so, and a run stopped
//     halfway costs everything it spent and delivers nothing — so the check
//     happens BEFORE a child starts, never after it has burned the overage.
//
// Persisted in the project's state directory so `nrv team step`, which runs one
// seat per process, accumulates across processes the way the in-process chain
// does — and so no client ever downloads the engine's accounting.
import * as fs from "node:fs";
import * as path from "node:path";

export interface RunBudget {
  /** What the owner named, or null when they named nothing. */
  readonly totalUsd: number | null;
  /** What this run has spent so far. */
  spentUsd: number;
}

// `<projectRoot>/.nirvana/state/`, beside the cascade spend tracker, which is
// the same kind of thing. NOT inside an outputs root: a run's outputs are what
// the client downloads, and a nested child — a Gauntlet candidate, an
// evaluation — gets an outputs root of its own, so accounting written there
// both pollutes a listing and splits the account the run is supposed to share.
// Keyed by the run so two runs in one project do not spend each other's money.
const fileFor = (projectRoot: string, runKey: string) =>
  path.join(projectRoot, ".nirvana", "state", `run-budget-${runKey.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);

/** Opens the budget of a run. `totalUsd` null or <= 0 means no ceiling. */
export function open(projectRoot: string, runKey: string, totalUsd: number | null | undefined): RunBudget {
  const total = typeof totalUsd === "number" && Number.isFinite(totalUsd) && totalUsd > 0 ? totalUsd : null;
  let spent = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(projectRoot, runKey), "utf8"));
    if (typeof raw?.spent_usd === "number" && Number.isFinite(raw.spent_usd)) spent = Math.max(0, raw.spent_usd);
  } catch { /* first child of this run */ }
  return { totalUsd: total, spentUsd: spent };
}

/** What the next child may spend. `undefined` means no ceiling to pass on. */
export function remaining(b: RunBudget): number | undefined {
  if (b.totalUsd === null) return undefined;
  return Math.max(0, b.totalUsd - b.spentUsd);
}

/** True when the ceiling exists and nothing is left. */
export function exhausted(b: RunBudget): boolean {
  return b.totalUsd !== null && b.totalUsd - b.spentUsd <= 0;
}

/**
 * Records what a child actually cost.
 *
 * `costUsd` null means the runtime could not tell us — several CLIs report no
 * figure at all. Unknown spend is NOT counted as zero, because that would let
 * an unmeasurable runtime run forever under a ceiling; it is counted as
 * `unknownChildUsd`, a declared assumption rather than a silent one.
 */
export function charge(projectRoot: string, runKey: string, b: RunBudget, costUsd: number | null | undefined, unknownChildUsd = 0): RunBudget {
  const amount = typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : unknownChildUsd;
  const next: RunBudget = { totalUsd: b.totalUsd, spentUsd: b.spentUsd + amount };
  if (b.totalUsd !== null) {
    try {
      fs.mkdirSync(path.dirname(fileFor(projectRoot, runKey)), { recursive: true });
      fs.writeFileSync(fileFor(projectRoot, runKey), JSON.stringify({
        total_usd: b.totalUsd, spent_usd: next.spentUsd, updated_at: new Date().toISOString(),
      }) + "\n");
    } catch { /* accounting must never be the reason a run dies */ }
  }
  return next;
}

/** What to tell the owner when the ceiling stops a run. Names both numbers. */
export function exhaustedMessage(b: RunBudget): string {
  return `run budget exhausted: the ceiling you set was $${(b.totalUsd ?? 0).toFixed(2)}`
    + ` and this run has spent $${b.spentUsd.toFixed(2)}.`
    + ` The work already produced stays on disk and is judged;`
    + ` raise --max-budget to continue the chain.`;
}
