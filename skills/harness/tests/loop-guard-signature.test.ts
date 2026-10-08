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

// A client kept a 3/3 STOP for weeks and needed to see it without spending
// another tick: `status` reads the state and records nothing.
describe("nrv guard status", () => {
  test("reports the state and a standing ceiling, and records nothing", async () => {
    const { spawnSync } = await import("node:child_process");
    const os = await import("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-guard-status-"));
    const GUARD = path.join(import.meta.dir, "..", "scripts", "guard.ts");
    const run = (...a: string[]) => spawnSync(process.execPath, [GUARD, ...a, "--project", dir], { encoding: "utf8" });
    for (let i = 0; i < 3; i++) run("tick", "--action", "revision", "--progress", String(i));
    const handoff = fs.readFileSync(path.join(dir, "HANDOFF.json"), "utf8");
    const out = run("status");
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("revision::bf21a9e8fbc5: 3");
    expect(out.stdout).toContain("stands at a ceiling: repeated_action");
    expect(fs.readFileSync(path.join(dir, "HANDOFF.json"), "utf8")).toBe(handoff);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
