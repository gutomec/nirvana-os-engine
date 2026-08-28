// context-guard.test.ts — `nrv guard context`: the orchestrator's own rollover.
//
// Phase 0 always had the maestro declare an operating budget, and nothing ever
// read that number back. Measured consequence in a real 13-target run
// (galinha-dos-ovos-de-ouro, 2026-08-12): context grew from 55k to 275k tokens
// across 105 messages, 19.07M tokens of context processed. Simulating a rollover
// at 70% over the same message sequence gives 9.95M — the run paid ~48% of its
// cost to re-read an accumulation nothing ever shed.
//
// The guard is prose-enforcement, same shape as `nrv guard tick`: a deterministic
// step the protocol tells the orchestrator to run, whose exit code carries the
// verdict and whose state lands in the HANDOFF so the decision is auditable
// rather than merely claimed.
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-ctx-guard-"));
const SKILLS = path.resolve(import.meta.dir, "..", "..");
const GUARD = path.join(SKILLS, "harness", "scripts", "guard.ts");
const LOGS = path.join(TMP, "harness-logs");

let seq = 0;
function freshProject(): string {
  const dir = path.join(TMP, `proj-${seq++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function guard(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [GUARD, ...args], {
    encoding: "utf8",
    env: { ...process.env, HARNESS_LOGS_DIR: LOGS, NIRVANA_SKILLS_DIR: SKILLS, ...env },
  });
}

function handoffState(dir: string): any {
  const p = path.join(dir, "HANDOFF.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")).context_guard_state ?? null;
}

function auditEvents(): any[] {
  const out: any[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "audit.jsonl") {
        for (const l of fs.readFileSync(p, "utf8").split("\n")) {
          if (l.trim()) { try { out.push(parseAuditLine(l)); } catch { /* partial line */ } }
        }
      }
    }
  };
  walk(LOGS);
  return out;
}

beforeEach(() => { try { fs.rmSync(LOGS, { recursive: true, force: true }); } catch { /* first run */ } });
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe("nrv guard context — the verdict", () => {
  test("under budget continues, and says how much room is left", () => {
    const dir = freshProject();
    const r = guard(["context", "--project", dir, "--used", "50000", "--window", "200000"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("25%");
  }, spawnBudgetMs(2));

  test("at the threshold it orders a rollover — exit 8, not a warning to ignore", () => {
    const dir = freshProject();
    // Exactly 70%: the boundary belongs to the roll side. A guard that fires at
    // 70.001% and not at 70% would be a coin flip at the one value people test.
    const r = guard(["context", "--project", dir, "--used", "140000", "--window", "200000"]);
    expect(r.status).toBe(8);
    expect(r.stderr).toContain("CONTEXT GUARD");
    expect(r.stderr).toContain("HANDOFF");
    expect(r.stderr).toContain(dir);          // tells you how to resume THIS run
  }, spawnBudgetMs(2));

  test("exit 8 is distinct from the loop guard's exit 7", () => {
    // Both guards stop the prose, for different reasons and with different
    // remedies (roll over vs escalate to a human). One exit code for both would
    // make the protocol unable to tell them apart.
    const dir = freshProject();
    const roll = guard(["context", "--project", dir, "--used", "999999", "--window", "200000"]);
    expect(roll.status).toBe(8);
    expect(roll.status).not.toBe(7);
  }, spawnBudgetMs(2));

  test("the threshold is configurable, and the default window is documented", () => {
    const dir = freshProject();
    // Same usage, tighter policy → now a roll.
    const tight = guard(["context", "--project", dir, "--used", "60000", "--window", "200000"], { NIRVANA_CONTEXT_ROLL_AT: "0.25" });
    expect(tight.status).toBe(8);
    // No --window given: falls back to the 200k the protocol tells you to assume.
    const dflt = guard(["context", "--project", freshProject(), "--used", "150000"]);
    expect(dflt.status).toBe(8);
    expect(dflt.stderr).toContain("200,000");
  }, spawnBudgetMs(2));
});

describe("nrv guard context — the record", () => {
  test("the decision lands in the HANDOFF, so it is auditable after the fact", () => {
    const dir = freshProject();
    guard(["context", "--project", dir, "--used", "150000", "--window", "200000"]);
    const st = handoffState(dir);
    expect(st).not.toBeNull();
    expect(st.window).toBe(200000);
    expect(st.budget).toBe(140000);
    expect(st.used).toBe(150000);
    expect(st.ratio).toBeCloseTo(0.75, 2);
    expect(st.rollovers).toBe(1);
    expect(typeof st.checked_at).toBe("string");
  }, spawnBudgetMs(2));

  test("rollovers accumulate; a check under budget does not inflate the count", () => {
    const dir = freshProject();
    guard(["context", "--project", dir, "--used", "150000", "--window", "200000"]);
    guard(["context", "--project", dir, "--used", "50000", "--window", "200000"]);   // fresh session, under budget
    guard(["context", "--project", dir, "--used", "180000", "--window", "200000"]);  // filled again
    expect(handoffState(dir).rollovers).toBe(2);
  }, spawnBudgetMs(3));

  test("a rollover emits context_budget_warning — the event the cockpit already renders", () => {
    const dir = freshProject();
    guard(["context", "--project", dir, "--used", "150000", "--window", "200000"]);
    const ev = auditEvents().filter((e) => e.event === "context_budget_warning");
    expect(ev.length).toBe(1);
    expect(ev[0].used_tokens).toBe(150000);
    expect(ev[0].budget_tokens).toBe(140000);
    expect(ev[0].action).toBe("rollover_required");
  }, spawnBudgetMs(2));

  test("staying under budget emits nothing — silence is the normal state", () => {
    guard(["context", "--project", freshProject(), "--used", "10000", "--window", "200000"]);
    expect(auditEvents().filter((e) => e.event === "context_budget_warning").length).toBe(0);
  }, spawnBudgetMs(2));
});

describe("nrv guard context — refusing to guess", () => {
  test("a missing or nonsensical --used is invalid args, never a silent pass", () => {
    // The dangerous failure is a guard that answers "ok" when it was told
    // nothing: the run would read that as permission to keep growing.
    for (const args of [["context", "--project", TMP], ["context", "--project", TMP, "--used", "abc"], ["context", "--project", TMP, "--used", "-5"]]) {
      const r = guard(args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("usage:");
    }
  }, spawnBudgetMs(2));

  test("a window of zero is rejected rather than dividing by it", () => {
    const r = guard(["context", "--project", TMP, "--used", "100", "--window", "0"]);
    expect(r.status).toBe(2);
  }, spawnBudgetMs(2));

  test("an unknown subcommand still prints both usages", () => {
    const r = guard(["nonsense"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("guard tick");
    expect(r.stderr).toContain("guard context");
  }, spawnBudgetMs(2));

  test("an unwritable project dir degrades to a warning, never loses the verdict", () => {
    // Losing the record is bad; losing the ROLLOVER because the record failed
    // would be worse — the run would keep growing on a technicality.
    const r = guard(["context", "--project", "/proc/nonexistent-nirvana", "--used", "150000", "--window", "200000"]);
    expect(r.status).toBe(8);
    expect(r.stderr).toContain("CONTEXT GUARD");
  }, spawnBudgetMs(2));
});
