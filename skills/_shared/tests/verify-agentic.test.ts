// verify-agentic.test.ts — `--fix=agentic`, with a fake runtime.
//
// Zero tokens: `runHeadless` is an injected seam that edits the staging copy
// the way a model would (or fails, or makes things worse), so every branch of
// the acceptance rule is exercised without a CLI, a network or a bill.
//
// The rule under test, in one line: the library is only overwritten when the
// errors did not grow AND a targeted finding is actually gone — and when the
// target was routing metadata, when the entity can still be found.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";
import { cloneFixture, rmrf, tempRoot } from "./helpers/verify-fixture.ts";
import { AgenticConfirmationRequired, agenticFix, buildBrief, type AgenticOptions } from "../lib/verify/agentic.ts";
import { mindCloneModule } from "../lib/verify/kinds/mind-clone.ts";
import type { CheckContext, Finding } from "../lib/verify/types.ts";

const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) rmrf(r); });
function root(): string { const r = tempRoot(); ROOTS.push(r); return r; }

/** A clone missing `routing.not_for` — one agentic finding, nothing else. */
function subject(r: string): { dir: string; ctx: CheckContext } {
  const dir = cloneFixture(r, "jane-doe", { routing: { not_for: undefined } });
  return { dir, ctx: { kind: "mind-clone", slug: "jane-doe", dir, retrieval: false } };
}

/** Writes `routing.not_for` into the staging copy, as a good run would. */
function goodRun(seen: { cwd?: string; prompt?: string }) {
  return (opts: any) => {
    seen.cwd = opts.cwd; seen.prompt = opts.prompt;
    const mf = path.join(opts.cwd, "MANIFEST.yaml");
    const doc = parseDocument(fs.readFileSync(mf, "utf8"));
    doc.setIn(["routing", "not_for"], "Visual identity and logo design (see a design clone).");
    fs.writeFileSync(mf, String(doc), "utf8");
    return { ok: true, runtime: "claude-code", sessionId: null, result: "done", costUsd: 0.42, exitCode: 0, stderr: "", durationMs: 1200 };
  };
}

function base(extra: Partial<AgenticOptions> = {}): AgenticOptions {
  return {
    confirmed: true,
    runtimeAvailableImpl: (rt) => rt === "claude-code",
    openRunImpl: () => ({ runId: "run-fake" }),
    emit: null,
    ...extra,
  };
}

async function findings(ctx: CheckContext): Promise<Finding[]> {
  return mindCloneModule.check(ctx);
}

describe("acceptance: better, or nothing", () => {
  test("a run that repairs the finding is copied back, backed up and audited", async () => {
    const r = root();
    const { dir, ctx } = subject(r);
    const seen: { cwd?: string; prompt?: string } = {};
    const events: Array<[string, Record<string, unknown>]> = [];
    const out = await agenticFix(mindCloneModule, ctx, await findings(ctx), base({
      runHeadlessImpl: goodRun(seen),
      stagingRoot: path.join(r, "staging"), backupRoot: path.join(r, "backups"),
      emit: (e, p) => { events.push([e, p]); },
    }));

    expect(out.outcome.rolled_back).toBe(false);
    expect(out.fixes[0].applied).toBe(true);
    expect(out.findings.map((f) => f.id)).not.toContain("not_for_missing");
    expect(parseYaml(fs.readFileSync(path.join(dir, "MANIFEST.yaml"), "utf8")).routing.not_for).toContain("Visual identity");

    // The model never saw the library: it edited a staging copy.
    expect(seen.cwd).toStartWith(path.join(r, "staging"));
    expect(seen.cwd).not.toBe(dir);
    expect(fs.existsSync(seen.cwd!)).toBe(false);           // cleaned up
    expect(out.outcome.backup).toBeTruthy();
    expect(fs.existsSync(out.outcome.backup!)).toBe(true);  // the way back

    expect(events.map(([e]) => e)).toEqual(["x_verify_fix_started", "x_verify_fix_finished"]);
    expect(events[0][1].findings).toContain("not_for_missing");
    expect(events[0][1].run_id).toBe("run-fake");
    expect(events[1][1].accepted).toBe(true);
    expect(events[1][1].cost_usd).toBe(0.42);
  });

  test("the brief names the findings, the manifest and the scope guard", async () => {
    const r = root();
    const { ctx } = subject(r);
    const brief = buildBrief(mindCloneModule, "jane-doe", (await findings(ctx)).filter((f) => f.id === "not_for_missing"));
    expect(brief).toContain("not_for_missing");
    expect(brief).toContain("MANIFEST.yaml");
    expect(brief).toContain("out of scope: do not act on them");
    expect(brief).toContain("Never invent a source");
  });

  test("a run that repairs nothing is discarded and the entity is byte-identical", async () => {
    const r = root();
    const { dir, ctx } = subject(r);
    const before = fs.readFileSync(path.join(dir, "MANIFEST.yaml"), "utf8");
    const out = await agenticFix(mindCloneModule, ctx, await findings(ctx), base({
      runHeadlessImpl: (o: any) => {
        fs.writeFileSync(path.join(o.cwd, "NOTES.md"), "I thought about it.\n", "utf8");
        return { ok: true, runtime: "claude-code", sessionId: null, result: "", costUsd: 0, exitCode: 0, stderr: "", durationMs: 5 };
      },
      stagingRoot: path.join(r, "staging"), backupRoot: path.join(r, "backups"),
    }));
    expect(out.outcome.rolled_back).toBe(true);
    expect(out.outcome.rollback_reason).toContain("no targeted finding was repaired");
    expect(fs.readFileSync(path.join(dir, "MANIFEST.yaml"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(dir, "NOTES.md"))).toBe(false);
  });

  test("a run that grows the errors is discarded even though it repaired the target", async () => {
    const r = root();
    const { dir, ctx } = subject(r);
    const before = fs.readFileSync(path.join(dir, "MANIFEST.yaml"), "utf8");
    const out = await agenticFix(mindCloneModule, ctx, await findings(ctx), base({
      runHeadlessImpl: (o: any) => {
        goodRun({})(o);
        fs.rmSync(path.join(o.cwd, "agent", "SOUL.md"));   // a new HARD error
        return { ok: true, runtime: "claude-code", sessionId: null, result: "", costUsd: 0, exitCode: 0, stderr: "", durationMs: 5 };
      },
      stagingRoot: path.join(r, "staging"), backupRoot: path.join(r, "backups"),
    }));
    expect(out.outcome.rolled_back).toBe(true);
    expect(out.outcome.rollback_reason).toContain("errors grew");
    expect(fs.readFileSync(path.join(dir, "MANIFEST.yaml"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(dir, "agent", "SOUL.md"))).toBe(true);
  });

  test("a failed runtime run leaves nothing behind", async () => {
    const r = root();
    const { dir, ctx } = subject(r);
    const before = fs.readFileSync(path.join(dir, "MANIFEST.yaml"), "utf8");
    const out = await agenticFix(mindCloneModule, ctx, await findings(ctx), base({
      runHeadlessImpl: () => ({ ok: false, runtime: "claude-code", sessionId: null, result: "", costUsd: null, exitCode: 1, stderr: "boom", durationMs: 3, error: "boom" }),
      stagingRoot: path.join(r, "staging"), backupRoot: path.join(r, "backups"),
    }));
    expect(out.outcome.rolled_back).toBe(true);
    expect(out.outcome.rollback_reason).toContain("boom");
    expect(fs.readFileSync(path.join(dir, "MANIFEST.yaml"), "utf8")).toBe(before);
    expect(fs.readdirSync(path.join(r, "staging", "mind-clone"))).toEqual([]);
  });
});

describe("routing metadata has to survive retrieval", () => {
  /** A clone with no `one_liner` — the field the router actually reads. */
  function unrouted(r: string): { dir: string; ctx: CheckContext } {
    const dir = cloneFixture(r, "jane-doe", { routing: { one_liner: undefined } });
    return { dir, ctx: { kind: "mind-clone", slug: "jane-doe", dir, retrieval: false } };
  }
  const writeOneLiner = (opts: any) => {
    const mf = path.join(opts.cwd, "MANIFEST.yaml");
    const doc = parseDocument(fs.readFileSync(mf, "utf8"));
    doc.setIn(["routing", "one_liner"], "Jane Doe — the choice for brand tone of voice and verbal identity");
    fs.writeFileSync(mf, String(doc), "utf8");
    return { ok: true, runtime: "claude-code", sessionId: null, result: "done", costUsd: 0.1, exitCode: 0, stderr: "", durationMs: 30 };
  };

  test("a repaired clone the gate cannot retrieve is rolled back to the backup", async () => {
    const r = root();
    const { dir, ctx } = unrouted(r);
    const before = fs.readFileSync(path.join(dir, "MANIFEST.yaml"), "utf8");
    const out = await agenticFix(mindCloneModule, ctx, await findings(ctx), base({
      runHeadlessImpl: writeOneLiner,
      retrievalCheck: () => false,
      stagingRoot: path.join(r, "staging"), backupRoot: path.join(r, "backups"),
    }));
    expect(out.outcome.rolled_back).toBe(true);
    expect(out.outcome.rollback_reason).toContain("self-retrieval");
    expect(fs.readFileSync(path.join(dir, "MANIFEST.yaml"), "utf8")).toBe(before);
  });

  test("the same run is kept when retrieval passes", async () => {
    const r = root();
    const { dir, ctx } = unrouted(r);
    const out = await agenticFix(mindCloneModule, ctx, await findings(ctx), base({
      runHeadlessImpl: writeOneLiner,
      retrievalCheck: () => true,
      stagingRoot: path.join(r, "staging"), backupRoot: path.join(r, "backups"),
    }));
    expect(out.outcome.rolled_back).toBe(false);
    expect(parseYaml(fs.readFileSync(path.join(dir, "MANIFEST.yaml"), "utf8")).routing.one_liner).toContain("Jane Doe");
  });

  test("a fence (`not_for`) is not a retrieval signal: no gate is consulted", async () => {
    const r = root();
    const { dir, ctx } = subject(r);
    let consulted = false;
    const out = await agenticFix(mindCloneModule, ctx, await findings(ctx), base({
      runHeadlessImpl: goodRun({}),
      retrievalCheck: () => { consulted = true; return false; },
      stagingRoot: path.join(r, "staging"), backupRoot: path.join(r, "backups"),
    }));
    expect(consulted).toBe(false);
    expect(out.outcome.rolled_back).toBe(false);
    expect(parseYaml(fs.readFileSync(path.join(dir, "MANIFEST.yaml"), "utf8")).routing.not_for).toBeTruthy();
  });
});

describe("the doors that stay shut", () => {
  test("no confirmation, no run", async () => {
    const r = root();
    const { ctx } = subject(r);
    const boom = () => { throw new Error("the runtime must not be called"); };
    await expect(agenticFix(mindCloneModule, ctx, await findings(ctx), { ...base(), confirmed: false, runHeadlessImpl: boom as any }))
      .rejects.toBeInstanceOf(AgenticConfirmationRequired);
  });

  test("--pack is off, and so is a machine with no runtime", async () => {
    const r = root();
    const { ctx } = subject(r);
    const f = await findings(ctx);
    const boom = () => { throw new Error("the runtime must not be called"); };
    const packed = await agenticFix(mindCloneModule, ctx, f, { ...base(), pack: true, runHeadlessImpl: boom as any });
    expect(packed.fixes[0].applied).toBe(false);
    expect(packed.fixes[0].note).toContain("--pack");

    const bare = await agenticFix(mindCloneModule, ctx, f, { ...base(), runtimeAvailableImpl: () => false, runHeadlessImpl: boom as any });
    expect(bare.fixes[0].note).toContain("no agent runtime on PATH");
  });

  test("an entity with nothing agentic to repair never spends", async () => {
    const r = root();
    const dir = cloneFixture(r, "complete-clone");
    const ctx: CheckContext = { kind: "mind-clone", slug: "complete-clone", dir, retrieval: false };
    const boom = () => { throw new Error("the runtime must not be called"); };
    const out = await agenticFix(mindCloneModule, ctx, await findings(ctx), { ...base(), runHeadlessImpl: boom as any });
    expect(out.fixes[0].note).toContain("nothing to repair");
    expect(out.outcome.rolled_back).toBe(false);
  });
});
