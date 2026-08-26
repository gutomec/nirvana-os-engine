// test-budgets.ts — explicit per-test timeouts for the tests that leave the process or drive the
// Run Kernel, sized from the smoke runner rather than from Bun's default.
//
// Bun gives every test 5 s. On windows-latest that is what one cold `bun <script>.ts` costs (a
// 0.6 MB bundle transpiled under the runner's antivirus), and when the disk is busy it is also
// what a handful of Run Kernel transactions cost: `PRAGMA synchronous = FULL` makes every event an
// fsync, and the runner has been measured 20-35x slower than usual at that. Evidence:
//   - run 32928964511: three multi-target-cli tests that spawn two engines each timed out at
//     5.0-5.1 s; the same tests take 1.4-1.7 s on a normal Windows run.
//   - run 32929953479, attempt 1: an in-process Gauntlet cutover test timed out at 5.5 s, its
//     neighbours took 2.9-4.6 s and the suite took 186 s instead of ~150 s; the same tests take
//     150-350 ms on a normal Windows run.
// The budgets below are wall-clock reality with headroom, not slack for a hang: a hang still
// fails, only later.

/** A test that spawns `processes` Bun processes (engines, fake dispatch children, doctor runs).
 * A cold first spawn has cost 7.8 s on the runner, a warm one 0.4-2.5 s. */
export function spawnBudgetMs(processes: number): number {
  return 10_000 + 5_000 * processes;
}

/** A test that drives the Run Kernel or a Gauntlet in-process: fsync-bound SQLite, measured up to
 * 5.5 s per test on the slowest runner against 150-350 ms normally. */
export const KERNEL_BUDGET_MS = 30_000;
