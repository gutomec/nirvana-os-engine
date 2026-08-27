// verify-hooks.test.ts — the four moments an entity enters the system.
//
// The gate is only useful if it is wired in; it is only safe if wiring it in
// cannot break a machine that already has content installed. Both halves are
// asserted here: with the rollout flags at their defaults every hook reports
// and proceeds, with the flag on the same finding refuses, the documented
// escape returns without touching disk, and a machine with no debt baseline
// gets one recorded (grandfathering) instead of a refusal.
//
// Every fixture lives under mkdtemp; the baseline path is a fixture file and
// the entity is addressed by DIRECTORY, so no installed library is consulted.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { businessFixture, cloneFixture, rmrf, squadFixture, tempRoot } from "./helpers/verify-fixture.ts";
import { enforcesAt, verifyHook, type HookSettings } from "../lib/verify/hooks.ts";

const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) rmrf(r); });
function root(): string { const r = tempRoot(); ROOTS.push(r); return r; }

const OFF: HookSettings = { mode: "report", enforceOnInstall: false, enforceOnActivate: false };
const events: Array<[string, Record<string, unknown>]> = [];
const collect = (e: string, p: Record<string, unknown>) => { events.push([e, p]); };

function hookOpts(r: string, extra: Record<string, unknown> = {}) {
  return {
    baselinePath: path.join(r, "baseline.json"),
    stateDir: null as null,
    emit: null,
    retrieval: false,
    ...extra,
  };
}

/** A squad missing its surface file: one HARD error, nothing baselineable. */
function brokenSquad(r: string, slug: string): string {
  return squadFixture(r, slug, { surface: false });
}

describe("the flag decides, and the default never blocks", () => {
  test("an entity with an error installs anyway while the flag is off", async () => {
    const r = root();
    const dir = brokenSquad(r, "broken-squad");
    const out = await verifyHook({ kind: "squad", target: dir, gate: "install", settings: OFF, ...hookOpts(r) });
    expect(out.ran).toBe(true);
    expect(out.enforcing).toBe(false);
    expect(out.blocked).toBe(false);
    expect(out.errors.map((f) => f.id)).toContain("surface_missing");
    expect(out.lines.join("\n")).toContain("proceeding anyway");
  });

  test("the same entity is refused with verify.enforce_on_install on", async () => {
    const r = root();
    const dir = brokenSquad(r, "broken-squad");
    const out = await verifyHook({
      kind: "squad", target: dir, gate: "install",
      settings: { ...OFF, enforceOnInstall: true }, ...hookOpts(r),
    });
    expect(out.enforcing).toBe(true);
    expect(out.blocked).toBe(true);
    expect(out.lines.join("\n")).toContain("refused");
    expect(out.lines.join("\n")).toContain("--skip-validate");
  });

  test("--skip-validate returns without checking anything", async () => {
    const r = root();
    const dir = brokenSquad(r, "broken-squad");
    const out = await verifyHook({
      kind: "squad", target: dir, gate: "install", skip: true,
      settings: { ...OFF, enforceOnInstall: true }, ...hookOpts(r),
    });
    expect(out.ran).toBe(false);
    expect(out.blocked).toBe(false);
    expect(out.report).toBeNull();
    expect(out.lines.join("\n")).toContain("skipped by --skip-validate");
  });

  test("activation answers to its own flag, never to the install one", async () => {
    const r = root();
    const dir = brokenSquad(r, "broken-squad");
    const install = await verifyHook({
      kind: "squad", target: dir, gate: "activate",
      settings: { ...OFF, enforceOnInstall: true }, ...hookOpts(r),
    });
    expect(install.blocked).toBe(false);
    const activate = await verifyHook({
      kind: "squad", target: dir, gate: "activate",
      settings: { ...OFF, enforceOnActivate: true }, ...hookOpts(r),
    });
    expect(activate.blocked).toBe(true);
    expect(activate.lines.join("\n")).toContain("--skip-verify");
  });

  test("verify.mode: block enforces every gate at once; report and warn do not", () => {
    const block: HookSettings = { mode: "block", enforceOnInstall: false, enforceOnActivate: false };
    for (const gate of ["install", "activate", "pack"] as const) {
      expect(enforcesAt(gate, block)).toBe(true);
      expect(enforcesAt(gate, OFF)).toBe(false);
      expect(enforcesAt(gate, { ...OFF, mode: "warn" })).toBe(false);
    }
    // Creation judges a scaffold the engine itself just wrote: always.
    expect(enforcesAt("create", OFF)).toBe(true);
  });

  test("a clean entity is silent in report mode and speaks in warn mode", async () => {
    const r = root();
    const dir = businessFixture(r, "clean-co");
    const quiet = await verifyHook({ kind: "business", target: dir, gate: "install", settings: OFF, ...hookOpts(r) });
    expect(quiet.errors).toEqual([]);
    expect(quiet.lines).toEqual([]);
    const loud = await verifyHook({ kind: "business", target: dir, gate: "install", settings: { ...OFF, mode: "warn" }, ...hookOpts(r) });
    expect(loud.lines.join("\n")).toContain("ADMITTED");
  });
});

describe("grandfathering: a machine with no baseline gets one, not a refusal", () => {
  test("the first hook records the debt once and the second finds it recorded", async () => {
    const r = root();
    const dir = cloneFixture(r, "jane-doe", { verdict: null });
    const baselinePath = path.join(r, "baseline.json");
    expect(fs.existsSync(baselinePath)).toBe(false);

    events.length = 0;
    const first = await verifyHook({
      kind: "mind-clone", target: dir, gate: "install",
      settings: { ...OFF, enforceOnInstall: true }, baselinePath, stateDir: null, emit: collect, retrieval: false,
    });
    expect(first.blocked).toBe(false);
    expect(fs.existsSync(baselinePath)).toBe(true);
    const recorded = events.filter(([e]) => e === "x_verify_baseline_recorded");
    expect(recorded.length).toBe(1);
    expect(recorded[0][1].reason).toBe("hook_grandfathering");
    expect(recorded[0][1].debt).toContain("validation_verdict_missing");
    expect(first.report!.baseline.present).toBe(true);
    expect(first.warnings.map((f) => f.id)).not.toContain("validation_verdict_missing");

    events.length = 0;
    const second = await verifyHook({
      kind: "mind-clone", target: dir, gate: "install",
      settings: { ...OFF, enforceOnInstall: true }, baselinePath, stateDir: null, emit: collect, retrieval: false,
    });
    expect(events.filter(([e]) => e === "x_verify_baseline_recorded").length).toBe(0);
    expect(second.report!.summary.debt).toBeGreaterThan(0);
    expect(second.blocked).toBe(false);
  });

  test("a HARD error is never grandfathered — it is not baselineable", async () => {
    const r = root();
    const dir = cloneFixture(r, "jane-doe");
    fs.rmSync(path.join(dir, "agent", "SOUL.md"));
    const baselinePath = path.join(r, "baseline.json");
    const out = await verifyHook({
      kind: "mind-clone", target: dir, gate: "install",
      settings: { ...OFF, enforceOnInstall: true }, baselinePath, stateDir: null, emit: null, retrieval: false,
    });
    expect(out.blocked).toBe(true);
    expect(out.errors.map((f) => `${f.id}:${f.where}`)).toContain("artifact_missing:agent/SOUL.md");
    const recorded = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, "utf8")) : { entities: {} };
    expect(JSON.stringify(recorded.entities ?? {})).not.toContain("artifact_missing");
  });
});

describe("the hook never takes the caller down with it", () => {
  test("an unknown entity is reported, not thrown", async () => {
    const r = root();
    const out = await verifyHook({
      kind: "squad", target: path.join(r, "squads", "nobody"), gate: "install",
      settings: { ...OFF, enforceOnInstall: true }, ...hookOpts(r),
    });
    expect(out.ran).toBe(false);
    expect(out.blocked).toBe(false);
    expect(out.reason).toContain("unknown squad");
    expect(out.lines.join("\n")).toContain("proceeding");
  });
});
