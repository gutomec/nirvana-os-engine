// business-liveness.test.ts — a business that delegates is alive.
//
// Measured on 2026-08-26 in ~/.nirvana/run-ledger.sqlite: of the 39 business runs
// withheld since 2026-08-01, 35 carried `supervisor: agentic run stopped reporting
// (no heartbeat, no file activity)`, across 15 businesses on 10 different days.
// None of them had failed a gate. The employee had dispatched a squad (a child
// ledger row in the same project, writing under the squad's own dir), the
// agent's hooks were logging tool_invoked / artifact_touched / bash_completed
// for the trace, and the handoff scripts kept advancing — but the supervisor
// only ever read the outputs dir of the business row itself, so the business
// was escalated while it was working.
//
// These tests pin the liveness rule at both ends:
//   1. any of the trace's signals — an active or freshly delivered child run,
//      hook activity, a beat from the scripts the employee runs anyway — keeps
//      the business alive (the reproduction, inverted by the fix);
//   2. a business with no signal at all is still escalated (the control: the
//      gate must never go blind).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-business-liveness-"));
const SKILLS = path.resolve(import.meta.dir, "..", "..");
process.env.HARNESS_LOGS_DIR = path.join(TMP, "harness-logs");
process.env.NIRVANA_STATE_DB = path.join(TMP, "state.db");
process.env.NIRVANA_SKILLS_DIR = SKILLS;
process.env.NIRVANA_RUN_LEDGER_DB = path.join(TMP, "default.sqlite");
process.env.NIRVANA_NO_DESKTOP_NOTIFY = "1";

import { sweep, type RecoveryResult, type SalvageVerdict } from "../scripts/supervisor.ts";
import { openLedger, openRun, getRun, markState, type LedgerHandle, type RunRow } from "../lib/run-ledger.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const MIN = 60_000;
/** Older than the agentic liveness window (AGENTIC_LEASE_SEC = 1800s). */
const STALE_MS = 40 * MIN;

let dbSeq = 0;
function freshLedger(): LedgerHandle {
  return openLedger(path.join(TMP, `case-${dbSeq++}.sqlite`));
}

/** The project layout brief-business scaffolds: <outputs>/<project>/brief.md and
 *  <outputs>/<project>/businesses/<slug>/ — the business row's outputs root. */
function projectLayout(projectId: string, slug = "acme"): { projectDir: string; briefPath: string; outputsRoot: string } {
  const projectDir = path.join(TMP, "outputs", projectId);
  const outputsRoot = path.join(projectDir, "businesses", slug);
  fs.mkdirSync(outputsRoot, { recursive: true });
  const briefPath = path.join(projectDir, "brief.md");
  fs.writeFileSync(briefPath, "# Brief\n");
  return { projectDir, briefPath, outputsRoot };
}

/** Age every timestamp of a row by `ms`: the row is born with a fresh heartbeat
 *  and a valid lease, and a genuinely silent 40-minute-old run cannot be faked
 *  any other way without moving the sweep's clock (which would also age the
 *  signals under test). */
function backdate(h: LedgerHandle, runId: string, ms: number): void {
  const then = new Date(Date.now() - ms).toISOString();
  h.db.run(
    "UPDATE runs SET heartbeat_at = ?, updated_at = ?, created_at = ?, lease_expires_at = ?, terminal_at = CASE WHEN terminal_at IS NULL THEN NULL ELSE ? END WHERE run_id = ?",
    [then, then, then, then, then, runId],
  );
}

/** Make the outputs root look untouched for STALE_MS. */
function ageDir(dir: string): void {
  const when = new Date(Date.now() - STALE_MS);
  const f = path.join(dir, "artifact.md");
  fs.writeFileSync(f, "# artifact\n");
  fs.utimesSync(f, when, when);
  fs.utimesSync(dir, when, when);
}

/** A business row exactly as brief-business opens it (agentic, no pid), then
 *  aged past its lease with nothing written under its outputs root. */
function silentBusiness(h: LedgerHandle, projectId: string): RunRow {
  const { briefPath, outputsRoot } = projectLayout(projectId);
  ageDir(outputsRoot);
  const row = openRun(h, {
    projectId, traceId: projectId, targetSlug: "acme", targetKind: "business", childPid: null,
    meta: { path: "agentic", opened_by: "brief-business", outputs_root: outputsRoot, project_dir: outputsRoot, project_root: outputsRoot, brief_path: briefPath },
  });
  markState(h, row.run_id, "running");
  backdate(h, row.run_id, STALE_MS);
  return getRun(h, row.run_id)!;
}

/** A squad row the employee opened in the same project (brief-squad, agentic). */
function childSquad(h: LedgerHandle, projectId: string, state: "running" | "delivered" = "running"): RunRow {
  const outputs = path.join(TMP, "outputs", projectId, "squads", "brandcraft");
  fs.mkdirSync(outputs, { recursive: true });
  const row = openRun(h, {
    projectId, traceId: projectId, targetSlug: "brandcraft", targetKind: "squad", childPid: null,
    meta: { path: "agentic", opened_by: "brief-squad", outputs_root: outputs },
  });
  markState(h, row.run_id, "running");
  if (state === "delivered") {
    markState(h, row.run_id, "verifying");
    markState(h, row.run_id, "gated");
    markState(h, row.run_id, "delivered");
  }
  return getRun(h, row.run_id)!;
}

const auditFile = () => path.join(process.env.HARNESS_LOGS_DIR!, new Date().toISOString().slice(0, 10), "audit.jsonl");

/** What the harness hooks write (audit-emit-from-hook.ts) while the agent works. */
function hookEvent(event: string, fields: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(auditFile()), { recursive: true });
  fs.appendFileSync(auditFile(), JSON.stringify({ ts: new Date().toISOString(), event, host: "claude-code-hook", stage: "post", ...fields }) + "\n");
}

function auditEvents(event: string): Record<string, any>[] {
  if (!fs.existsSync(auditFile())) return [];
  return fs.readFileSync(auditFile(), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(e => e.event === event);
}

const noSalvage = (): SalvageVerdict => ({
  judged: false, skipReason: "no_artifacts", artifacts: 0, gateable: 0, gate: null,
  delivered: false, ceiling: null, outputsRoot: null, finalState: "stalled", detail: null,
});
const neverCalled = (label: string) => (): RecoveryResult => {
  throw new Error(`${label} must never run for an agentic run`);
};

/** Sweep with the scripted recoveries fenced off; returns the escalation
 *  message per run id (a silent child row is escalated too, on its own). */
function sweepAgentic(h: LedgerHandle): { summary: ReturnType<typeof sweep>; notified: Map<string, string> } {
  const notified = new Map<string, string>();
  const summary = sweep({
    handle: h,
    resumeImpl: neverCalled("resume"),
    redispatchImpl: neverCalled("redispatch"),
    notifyImpl: (r, message) => { notified.set(r.run_id, message); },
    salvageImpl: noSalvage,
  });
  return { summary, notified };
}

function expectAlive(h: LedgerHandle, row: RunRow, source: string): void {
  const { summary, notified } = sweepAgentic(h);
  expect(notified.has(row.run_id)).toBe(false);
  expect(summary.graced).toBe(1);
  const after = getRun(h, row.run_id)!;
  expect(after.state).toBe("running");
  expect(Date.parse(after.lease_expires_at!)).toBeGreaterThan(Date.now());
  // The audit says which signal kept the run alive, so Glance and a reader of
  // the trail can explain the grace instead of guessing.
  const grace = auditEvents("x_ledger_grace_extended").filter(e => e.run_id === row.run_id);
  expect(grace.length).toBe(1);
  expect(grace[0].liveness_source).toBe(source);
}

function expectEscalated(h: LedgerHandle, row: RunRow): void {
  const { summary, notified } = sweepAgentic(h);
  expect(summary.graced).toBe(0);
  expect(notified.get(row.run_id)).toContain("agentic run stopped reporting");
  expect(getRun(h, row.run_id)!.state).toBe("stalled");
}

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

// ── 1. reproduction: the signals the supervisor used to ignore ────────────

describe("supervisor — a business that delegates is alive", () => {
  test("an active child squad run in the same project keeps the business alive", () => {
    const h = freshLedger();
    const biz = silentBusiness(h, "p-child-active");
    const child = childSquad(h, "p-child-active");           // fresh: opened just now
    expectAlive(h, biz, "child_run");
    const grace = auditEvents("x_ledger_grace_extended").find(e => e.run_id === biz.run_id)!;
    expect(grace.child_run_id).toBe(child.run_id);
  });

  test("hook activity of the trace keeps the business alive", () => {
    const h = freshLedger();
    const biz = silentBusiness(h, "p-hooks");
    // The employee's session is writing — outside the business outputs root
    // (the squad dir, a handoff), so the mtime check never sees it.
    hookEvent("artifact_touched", { project_id: "p-hooks", trace_id: "session-1", action: "write", file_path: path.join(TMP, "elsewhere.md"), success: true });
    expectAlive(h, biz, "hook_activity");
  });

  test("hook activity is matched by path under the project when it carries no ids", () => {
    const h = freshLedger();
    const biz = silentBusiness(h, "p-hooks-path");
    const squadFile = path.join(TMP, "outputs", "p-hooks-path", "squads", "brandcraft", "draft.md");
    hookEvent("bash_completed", { trace_id: "session-2", cwd: path.dirname(squadFile), command: "bun brief-squad.ts", success: true });
    expectAlive(h, biz, "hook_activity");
  });

  test("a child that just delivered buys the business one window to integrate the delivery", () => {
    const h = freshLedger();
    const biz = silentBusiness(h, "p-child-delivered");
    childSquad(h, "p-child-delivered", "delivered");           // terminal_at: just now
    expectAlive(h, biz, "child_delivered");
  });

  test("after that window the normal rule applies: an old delivery is not proof of life", () => {
    const h = freshLedger();
    const biz = silentBusiness(h, "p-child-delivered-old");
    const child = childSquad(h, "p-child-delivered-old", "delivered");
    backdate(h, child.run_id, STALE_MS);
    expectEscalated(h, biz);
  });
});

// ── 2. control: the gate never goes blind ─────────────────────────────────

describe("supervisor — a business with no signal is still escalated", () => {
  test("no heartbeat, no child, no hook, no file activity → escalated on the first sweep", () => {
    const h = freshLedger();
    const biz = silentBusiness(h, "p-silent");
    expectEscalated(h, biz);
    expect(getRun(h, biz.run_id)!.last_error).toContain("agentic run stopped reporting");
  });

  test("a child that went silent along with it is not proof of life", () => {
    const h = freshLedger();
    const biz = silentBusiness(h, "p-silent-child");
    const child = childSquad(h, "p-silent-child");
    backdate(h, child.run_id, STALE_MS);
    // A hook event of ANOTHER trace, in another project, is not this run's life either.
    hookEvent("artifact_touched", { project_id: "p-other", trace_id: "session-9", file_path: path.join(TMP, "other.md") });
    expectEscalated(h, biz);
  });
});

// ── 3. heartbeat as a side effect of the scripts the employee already runs ──

describe("heartbeat as a side effect", () => {
  const { updateHandoffPhase, writeHandoff } = require(path.join(SKILLS, "_shared", "lib", "handoff.js"));

  test("updateHandoffPhase beats the agentic business row named by the handoff", () => {
    const h = openLedger(process.env.NIRVANA_RUN_LEDGER_DB!);   // the default ledger, as the script sees it
    const biz = silentBusiness(h, "p-handoff");
    const projectDir = path.join(TMP, "outputs", "p-handoff", "businesses", "acme");
    writeHandoff(projectDir, { project_id: "p-handoff", business_slug: "acme", run_id: biz.run_id, phase: "plan" });
    updateHandoffPhase(projectDir, "execute", { nextTaskId: "T-001" });
    const after = getRun(h, biz.run_id)!;
    expect(Date.parse(after.heartbeat_at!)).toBeGreaterThan(Date.now() - MIN);
    expect(Date.parse(after.lease_expires_at!)).toBeGreaterThan(Date.now());
  });

  test("without a run_id in the handoff, the business row is found by project_id", () => {
    const h = openLedger(process.env.NIRVANA_RUN_LEDGER_DB!);
    const biz = silentBusiness(h, "p-handoff-lookup");
    const projectDir = path.join(TMP, "outputs", "p-handoff-lookup", "businesses", "acme");
    writeHandoff(projectDir, { project_id: "p-handoff-lookup", business_slug: "acme", run_id: null, phase: "plan" });
    updateHandoffPhase(projectDir, "execute", {});
    expect(Date.parse(getRun(h, biz.run_id)!.heartbeat_at!)).toBeGreaterThan(Date.now() - MIN);
  });

  test("a broken ledger never breaks the handoff", () => {
    const prev = process.env.NIRVANA_RUN_LEDGER_DB;
    process.env.NIRVANA_RUN_LEDGER_DB = TMP;   // a directory: cannot be opened as a database
    try {
      const projectDir = path.join(TMP, "outputs", "p-broken-ledger", "businesses", "acme");
      writeHandoff(projectDir, { project_id: "p-broken-ledger", business_slug: "acme", run_id: "run-x", phase: "plan" });
      expect(() => updateHandoffPhase(projectDir, "execute", {})).not.toThrow();
    } finally {
      process.env.NIRVANA_RUN_LEDGER_DB = prev;
    }
  });

  describe("brief-squad", () => {
    const home = path.join(TMP, "home");
    const projectRoot = path.join(TMP, "projeto-da-empresa");
    const ledger = path.join(TMP, "brief-squad.sqlite");

    beforeAll(() => {
      const squad = path.join(home, "squads", "fixture-squad");
      fs.mkdirSync(path.join(squad, "agents"), { recursive: true });
      fs.writeFileSync(path.join(squad, "agents", "fixture.md"), "# fixture\n");
      fs.writeFileSync(path.join(squad, "squad.yaml"), [
        "name: fixture-squad",
        "version: 1.0.0",
        'protocol: "5.0"',
        "description: A fixture squad used by the business liveness tests.",
        "experimental_domains: true",
        "components:",
        "  agents: [fixture.md]",
        "  tasks: []",
        "  workflows: []",
        "capabilities:",
        "  - id: general.fixture.run",
        "    description: Do the fixture thing.",
        "    domains: [fixture]",
        "    produces: [nothing]",
        '    examples: ["rode o fixture"]',
        "    invoke:",
        "      type: agent",
        "      ref: fixture",
        "",
      ].join("\n"));
      fs.mkdirSync(projectRoot, { recursive: true });
    });

    test("delegating to a squad beats the business row of the same project", () => {
      const h = openLedger(ledger);
      const biz = silentBusiness(h, "p-delegates");
      const r = spawnSync(process.execPath, [
        path.join(SKILLS, "squads", "scripts", "brief-squad.ts"),
        "fixture-squad", "Uma landing page para uma clínica veterinária", "--project", "p-delegates",
      ], {
        encoding: "utf8",
        cwd: projectRoot,
        env: {
          ...process.env,
          SQUADS_DIR: path.join(home, "squads"),
          NIRVANA_HOME: home,
          NIRVANA_PROJECT_ROOT: projectRoot,
          NIRVANA_RUN_LEDGER_DB: ledger,
          NIRVANA_SKILLS_DIR: SKILLS,
        },
      });
      expect(r.status).toBe(0);
      const after = getRun(h, biz.run_id)!;
      expect(Date.parse(after.heartbeat_at!)).toBeGreaterThan(Date.now() - MIN);
      expect(Date.parse(after.lease_expires_at!)).toBeGreaterThan(Date.now());
      // The squad's own row is still opened: the beat is in addition, not instead.
      const squadRows = h.db.query("SELECT COUNT(*) AS n FROM runs WHERE target_kind = 'squad' AND project_id = 'p-delegates'").get() as { n: number };
      expect(squadRows.n).toBe(1);
    }, spawnBudgetMs(1));
  });
});
