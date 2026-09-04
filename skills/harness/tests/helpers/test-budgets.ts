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

/**
 * An `afterAll`/`afterEach` that deletes a temporary root holding a real engine
 * install. Bun's 5 s default applies to HOOKS too, and nothing here had ever
 * given one a budget, so the heaviest teardown in the suite ran on the same
 * allowance as an assertion.
 *
 * The failure it produces is deliberately hard to attribute: Bun reports it as
 * `(fail) (unnamed)` with `a beforeEach/afterEach hook timed out for this test`,
 * naming no test, so the only way to find the file is to walk back to the
 * enclosing `##[group]` in the CI log. Evidence, all windows-latest, all with
 * every named test in the file PASSING:
 *   - run 33885817681: windows-path-persist teardown 7428 ms. Same cleanup
 *     measured ~450 ms on three green main runs (33794184327, 33793067812,
 *     33754875788); that whole run was ~2.7x slower than a fast pass.
 *   - run 33789921562: same signature, revise-delivery.
 *   - run 33317102720: same signature, preflight-index.
 * Three runs, three different files: the runner's speed picks the victim, not
 * the test. `removeDir` already retries EBUSY/EPERM/EACCES/ENOTEMPTY, and a
 * budget INSIDE it would not help — `fs.rmSync` is synchronous and a single
 * slow call cannot be interrupted. The hook's own timeout is the only lever.
 *
 * Headroom, not slack: a teardown that truly wedges still fails, only later.
 */
export const TEARDOWN_BUDGET_MS = 60_000;
