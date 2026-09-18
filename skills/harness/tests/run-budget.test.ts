// run-budget.test.ts — a ceiling belongs to the run, and only the owner sets one.
//
// `--max-budget` was handed to every child at full value, so a chain of six
// employees got six ceilings: a run the owner capped at US$ 2 spent US$ 4,90 on
// a customer VPS, and the worst case is one ceiling per seat. And the Glance
// maestro applied a US$ 5 ceiling nobody had asked for, which is the engine
// putting a number on someone else's money.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { charge, exhausted, exhaustedMessage, open, remaining } from "../lib/run-budget.ts";

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-budget-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

describe("no ceiling is the normal case", () => {
  test.each([undefined, null, 0, -1, Number.NaN])("%p means unlimited, and nothing is written to disk", (v) => {
    const d = tmp();
    const b = open(d, "k", v as number | null | undefined);
    expect(b.totalUsd).toBeNull();
    expect(remaining(b)).toBeUndefined();
    expect(exhausted(b)).toBe(false);
    charge(d, "k", b, 12.5);
    expect(fs.existsSync(path.join(d, ".nirvana", "state"))).toBe(false);
  });
});

describe("a ceiling the owner named is spent once, across the run", () => {
  test("each child is offered what is left, not the whole ceiling", () => {
    const d = tmp();
    expect(remaining(open(d, "k", 2))).toBe(2);
    charge(d, "k", open(d, "k", 2), 0.8);
    expect(remaining(open(d, "k", 2))).toBeCloseTo(1.2, 5);
    charge(d, "k", open(d, "k", 2), 0.9);
    expect(remaining(open(d, "k", 2))).toBeCloseTo(0.3, 5);
  });

  test("the six-seat chain that spent 4.90 under a 2.00 cap now stops", () => {
    const d = tmp();
    // Six employees at 0.8 each. Before, every one of them saw a $2 ceiling.
    let stoppedAfter = 0;
    for (let seat = 1; seat <= 6; seat++) {
      if (exhausted(open(d, "k", 2))) break;
      charge(d, "k", open(d, "k", 2), 0.8);
      stoppedAfter = seat;
    }
    expect(stoppedAfter).toBe(3);
    expect(open(d, "k", 2).spentUsd).toBeCloseTo(2.4, 5);
    // Not 4.80: the run stops at the ceiling rather than paying it per seat.
    expect(open(d, "k", 2).spentUsd).toBeLessThan(4.8);
  });

  test("it never goes negative, so a caller is never offered a nonsense number", () => {
    const d = tmp();
    charge(d, "k", open(d, "k", 1), 5);
    expect(remaining(open(d, "k", 1))).toBe(0);
    expect(exhausted(open(d, "k", 1))).toBe(true);
  });

  test("the accounting survives across processes, which is how `nrv team step` runs", () => {
    const d = tmp();
    charge(d, "k", open(d, "k", 10), 3);
    // A fresh open() is a fresh process reading the same run.
    expect(open(d, "k", 10).spentUsd).toBe(3);
    expect(remaining(open(d, "k", 10))).toBe(7);
  });
});

describe("a cost the runtime could not report", () => {
  test("is not counted as zero by accident, but as a declared assumption", () => {
    const d = tmp();
    charge(d, "k", open(d, "k", 5), null, 0.25);
    expect(open(d, "k", 5).spentUsd).toBe(0.25);
  });

  test("and with no assumption named, an unmeasurable runtime does not consume the ceiling", () => {
    const d = tmp();
    charge(d, "k", open(d, "k", 5), null);
    expect(open(d, "k", 5).spentUsd).toBe(0);
  });
});

describe("what the owner is told", () => {
  test("the refusal names the ceiling, the spend, and what happens to the work", () => {
    const d = tmp();
    charge(d, "k", open(d, "k", 2), 2.4);
    const m = exhaustedMessage(open(d, "k", 2));
    expect(m).toContain("$2.00");
    expect(m).toContain("$2.40");
    expect(m).toContain("stays on disk");
    expect(m).toContain("--max-budget");
  });
});

describe("the engine never names a ceiling by itself", () => {
  test("the Glance maestro turn defaults to none, like every other cap here", async () => {
    const { SETTINGS } = await import("../../_shared/lib/settings-schema.ts");
    expect(SETTINGS["glance.maestro_max_budget_usd"].default).toBe(0);
    expect(SETTINGS["budget.default_max_cost_usd"].default).toBe(0);
  });

  test("the dispatcher's ceiling comes from the flag or the manifest, and nowhere else", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "..", "scripts", "dispatch.ts"), "utf8");
    expect(src).toContain("function ownerCeilingUsd()");
    expect(src).toContain("The ceiling the OWNER named");
    // and the per-child value is the remainder, never the whole cap
    expect(src).toContain("runBudget.remaining(runBudget.open(PROJECT_ROOT, runBudgetKey(), ceiling))");
  });
});
