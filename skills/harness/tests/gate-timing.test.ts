// gate-timing.test.ts — the quality gate is anchored to a target's RETURN,
// not to the end of the run.
//
// Phase 6 used to open with "Before declaring done, run TWO checks in order".
// In a single-target brief that reads fine. In a multi-target run it batches:
// nothing is checked until everything is home. Measured on a real run
// (galinha-dos-ovos-de-ouro, 2026-08-13): first target returned 04:51:15, its
// sibling at 05:05:27, and both were gated in one loop at 05:06 — the first
// target's output sat fourteen minutes unverified.
//
// The wall clock is the small part. A failure found late cannot be fixed
// concurrently: a revision that could have run alongside still-working siblings
// becomes another serial round. So the trigger is the return, per target.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const harness = fs.readFileSync(path.join(ROOT, "skills/harness/SKILL.md"), "utf8");
const multi = fs.readFileSync(path.join(ROOT, "skills/harness/references/04-multi-target.md"), "utf8");

/** Phase 6's opening lines — where the timing is set. */
function phase6(): string {
  const start = harness.indexOf("### Phase 6 — Quality gate");
  const end = harness.indexOf("### Phase 7");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return harness.slice(start, end);
}

describe("Phase 6 fires on return", () => {
  test("the timing is stated in the heading area, not left to inference", () => {
    const p6 = phase6();
    expect(p6).toMatch(/the moment a target returns/i);
    expect(p6).toMatch(/not at the end of the run/i);
  });

  test("the old end-of-run anchor is gone", () => {
    // "Before declaring done" is what produced the batching: it names the end of
    // the whole run as the trigger, so a multi-target run naturally waits.
    expect(phase6()).not.toMatch(/\*\*MANDATORY\.\*\* Before declaring done/);
  });

  test("gating the next dispatch on the previous check is explicit", () => {
    // Without this the instruction reads as advisory and the orchestrator keeps
    // dispatching while unverified output piles up.
    expect(phase6()).toMatch(/before you dispatch anything else|only then does the next dispatch/i);
  });

  test("a wave gates each return rather than waiting for the slowest sibling", () => {
    expect(phase6()).toMatch(/gate each return as it lands/i);
    expect(multi).toMatch(/Gate each return, not the wave/);
  });

  test("the reason a late failure costs more is stated, not just the latency", () => {
    // The latency alone would not justify the rule; the serialisation of the fix
    // is the actual cost, and an instruction that omits its reason gets dropped
    // the first time it is inconvenient.
    const both = phase6() + multi;
    expect(both).toMatch(/concurrent|alongside its still-working siblings|while its siblings are still working/i);
    expect(both).toMatch(/serial round/i);
  });
});

describe("the rule keeps its evidence", () => {
  test("both documents cite the measurement that produced the rule", () => {
    // Rules whose evidence is stripped get re-litigated. These timestamps are
    // from the run that exposed the batching.
    expect(phase6()).toContain("04:51:15");
    expect(multi).toContain("05:05:27");
  });

  test("the two mandatory checks survived the rewrite", () => {
    const p6 = phase6();
    expect(p6).toContain("verify-deliverable.ts");
    expect(p6).toContain("quality-gate.ts");
    expect(p6).toMatch(/Without verify=PASS, no `gate_passed` is legitimate/);
  });
});
