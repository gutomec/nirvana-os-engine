// loop-guard-signature.test.ts — the loop guard counts repeats per target.
//
// The orchestrator skill told every revision to tick `--action revision`, so
// three seats revised once each read as one action repeated three times and
// tripped `repeated_action`, blocking a run that was not looping. The
// signature now names the target.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const { createLoopGuard } = createRequire(import.meta.url)("../../_shared/lib/loop-guard.js");
const SKILL = path.join(import.meta.dir, "..", "SKILL.md");

describe("loop guard signatures", () => {
  test("three different targets revised once each do not trip the guard", () => {
    const g = createLoopGuard();
    let progress = 0;
    for (const seat of ["brand-motion-director", "commercial-director", "motion-qa-lead"]) g.record(`revision:${seat}`, {}, ++progress);
    expect(g.check().stop).toBe(false);
  });

  test("the same target revised three times still does", () => {
    const g = createLoopGuard();
    let progress = 0;
    for (let i = 0; i < 3; i++) g.record("revision:motion-qa-lead", {}, ++progress);
    const r = g.check();
    expect(r.stop).toBe(true);
    expect(r.reason).toBe("repeated_action");
  });
});
