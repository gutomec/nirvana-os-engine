// agentic-run-tracking.test.ts — the never-forgotten guarantee, on the AGENTIC path.
//
// The scripted path (`nrv dispatch --exec`) was always ledgered and supervised.
// The agentic path — an agent orchestrating a dispatch inside its own session —
// was not: it emitted audit events and opened no ledger run, so the supervisor
// had nothing to sweep and the owner was never told the work had ended. A real
// project (teste-novo-brandcraft) ran 5 dispatches to 8 gate_passed with ZERO
// ledger rows.
//
// These tests pin the fix at both ends:
//   1. coverage is STRUCTURAL — running the mandatory prep step opens the run,
//      so no agent has to remember anything;
//   2. the supervisor treats an agentic run correctly — file activity is proof
//      of life, and an abandoned one escalates instead of being re-dispatched
//      through recoveries that cannot possibly apply to it.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-agentic-run-"));
const SKILLS = path.resolve(import.meta.dir, "..", "..");
process.env.HARNESS_LOGS_DIR = path.join(TMP, "harness-logs");
process.env.NIRVANA_STATE_DB = path.join(TMP, "state.db");
process.env.NIRVANA_SKILLS_DIR = SKILLS;
process.env.NIRVANA_RUN_LEDGER_DB = path.join(TMP, "default.sqlite");
process.env.NIRVANA_NO_DESKTOP_NOTIFY = "1";

import { sweep, type RecoveryResult, type SalvageVerdict } from "../scripts/supervisor.ts";
import { openLedger, openAgenticRun, openRun, getRun, markState, findNonTerminal, type LedgerHandle, type RunRow } from "../lib/run-ledger.ts";
import { SCOPE_GUARD_PT_BR } from "../../_shared/lib/scope-guard.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

let dbSeq = 0;
function freshLedger(): LedgerHandle {
  return openLedger(path.join(TMP, `case-${dbSeq++}.sqlite`));
}

/** An outputs dir whose newest mtime is exactly `atMs`.
 *
 *  The sweeps below run on a fast-forwarded clock, because a row is born with a
 *  fresh heartbeat_at and a real 40-minute-old run cannot be faked any other
 *  way. So "recently written" means recent relative to that fake now — which is
 *  in the future by wall-clock, and utimes is happy to write it. */
function outputsAt(name: string, atMs: number): string {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "artifact.md");
  fs.writeFileSync(f, "# artifact\n");
  const when = new Date(atMs);
  fs.utimesSync(f, when, when);
  fs.utimesSync(dir, when, when);
  return dir;
}

/** Far enough past the lease and the 5-minute stall budget that a row opened
 *  "now" looks genuinely silent. */
const LATER = Date.now() + 40 * 60_000;

const noNotify = () => {};
const noSalvage = (): SalvageVerdict => ({
  judged: false, skipReason: "no_artifacts", artifacts: 0, gateable: 0, gate: null,
  delivered: false, ceiling: null, outputsRoot: null, finalState: "stalled", detail: null,
});
const neverCalled = (label: string) => (): RecoveryResult => {
  throw new Error(`${label} must never run for an agentic run`);
};

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

// ── 1. structural coverage ────────────────────────────────────────────────

describe("brief-squad opens the ledger run by itself", () => {
  const home = path.join(TMP, "home");
  const projectRoot = path.join(TMP, "meu-projeto-com-hifens");
  const ledger = path.join(TMP, "brief-squad.sqlite");

  beforeAll(() => {
    const squad = path.join(home, "squads", "fixture-squad");
    fs.mkdirSync(path.join(squad, "agents"), { recursive: true });
    fs.writeFileSync(path.join(squad, "agents", "fixture.md"), "# fixture\n");
    fs.writeFileSync(path.join(squad, "squad.yaml"), [
      "name: fixture-squad",
      "version: 1.0.0",
      'protocol: "5.0"',
      "description: A fixture squad used by the agentic run-tracking tests.",
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

  test("the mandatory prep step is enough: one running agentic row, no agent cooperation", () => {
    const r = spawnSync(process.execPath, [
      path.join(SKILLS, "squads", "scripts", "brief-squad.ts"),
      "fixture-squad", "Uma landing page para uma clínica veterinária", "--project", "meu-projeto-com-hifens",
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

    // The brief file the executor is handed carries the scope guard.
    const briefFile = r.stdout.match(/Brief file:\s+(.+)/)?.[1]?.trim();
    expect(briefFile).toBeTruthy();
    expect(fs.readFileSync(briefFile!, "utf8")).toContain(SCOPE_GUARD_PT_BR);

    const rows = findNonTerminal(openLedger(ledger));
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.state).toBe("running");
    expect(row.target_kind).toBe("squad");
    expect(row.target_slug).toBe("fixture-squad");
    expect(row.meta?.path).toBe("agentic");
    expect(row.meta?.opened_by).toBe("brief-squad");

    // The project id keeps its hyphens. The old cwd-derived id turned
    // `teste-novo-brandcraft` into `teste/novo/brandcraft`, which no lookup matched.
    expect(row.project_id).toBe("meu-projeto-com-hifens");

    // No pid: nothing here is a child of ours, and a recycled pid would put a
    // stranger's process in range of the sweep's SIGTERM.
    expect(row.child_pid).toBeNull();

    // outputs_root is the run's only proof of life once there is no pid.
    expect(typeof row.meta?.outputs_root).toBe("string");
    expect(String(row.meta?.outputs_root).length).toBeGreaterThan(0);

    // The agent is told how to close it, in the output it already reads.
    expect(r.stdout).toContain("nrv run-track close");
    expect(r.stdout).toContain(row.run_id);
  }, spawnBudgetMs(1));

  test("under a scripted dispatch (NIRVANA_DISPATCH_TRACKS_RUN=1) the prep step opens no row: the dispatch tracks its own", () => {
    // `nrv dispatch --exec` spawns brief-squad only to scaffold and opens its own ledger row.
    // The agentic row it used to leave here had no owner: still `running` after the dispatch
    // delivered, escalated as stalled once its lease expired (smoke-judge-squad, 2026-08-26).
    const scriptedLedger = path.join(TMP, "brief-squad-scripted.sqlite");
    const r = spawnSync(process.execPath, [
      path.join(SKILLS, "squads", "scripts", "brief-squad.ts"),
      "fixture-squad", "Uma landing page para uma clínica veterinária", "--project", "projeto-scriptado",
    ], {
      encoding: "utf8",
      cwd: projectRoot,
      env: {
        ...process.env,
        SQUADS_DIR: path.join(home, "squads"),
        NIRVANA_HOME: home,
        NIRVANA_PROJECT_ROOT: projectRoot,
        NIRVANA_RUN_LEDGER_DB: scriptedLedger,
        NIRVANA_SKILLS_DIR: SKILLS,
        NIRVANA_DISPATCH_TRACKS_RUN: "1",
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("tracked by the dispatch that spawned this step");
    expect(r.stdout).not.toContain("nrv run-track close");
    // No row at all, not a closed one: the dispatch's own row is the run's only record.
    const count = openLedger(scriptedLedger).db.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
    expect(count.n).toBe(0);
  }, spawnBudgetMs(1));
});

// ── 2. the supervisor's agentic door ──────────────────────────────────────

describe("supervisor — agentic runs", () => {
  test("expired lease but files still moving → graced, never escalated", () => {
    const h = freshLedger();
    const outputs = outputsAt("live-outputs", LATER - 10_000);   // written 10s before the sweep
    const row = openRun(h, {
      projectId: "p-live", targetSlug: "brandcraft", targetKind: "squad",
      childPid: null, initialLeaseSec: -60,
      meta: { path: "agentic", outputs_root: outputs },
    });
    markState(h, row.run_id, "running");

    const s = sweep({
      handle: h,
      now: LATER,
      resumeImpl: neverCalled("resume"),
      redispatchImpl: neverCalled("redispatch"),
      notifyImpl: noNotify,
      salvageImpl: noSalvage,
    });

    expect(s.graced).toBe(1);
    expect(s.escalated).toBe(0);
    const after = getRun(h, row.run_id)!;
    expect(after.state).toBe("running");
    // renewLease runs off the wall clock, not the injected one (the injected
    // clock exists only to age the row) — so the check is simply that the lease
    // is no longer expired.
    expect(Date.parse(after.lease_expires_at!)).toBeGreaterThan(Date.now());
  });

  test("expired lease and nothing moving → escalates on the FIRST sweep, human notified", () => {
    const h = freshLedger();
    const outputs = outputsAt("dead-outputs", Date.now());   // untouched for the whole 40 min
    const row = openRun(h, {
      projectId: "p-dead", targetSlug: "brandcraft", targetKind: "squad",
      childPid: null, initialLeaseSec: -60, maxRetries: 2,
      meta: { path: "agentic", outputs_root: outputs },
    });
    markState(h, row.run_id, "running");

    const notified: string[] = [];
    const s = sweep({
      handle: h,
      now: LATER,
      // A scripted recovery applied to an agentic run is a bug: there is no
      // session to resume and no prompt to relaunch.
      resumeImpl: neverCalled("resume"),
      redispatchImpl: neverCalled("redispatch"),
      notifyImpl: (_r, message) => { notified.push(message); },
      salvageImpl: noSalvage,
    });

    expect(s.escalated).toBe(1);
    expect(notified.length).toBe(1);
    expect(notified[0]).toContain("agentic run stopped reporting");
    const after = getRun(h, row.run_id)!;
    expect(after.state).toBe("stalled");
    // Escalation is immediate: retries are for recoveries that could work.
    expect(after.retries).toBe(0);
  });

  test("a scripted run is untouched by the agentic door", () => {
    const h = freshLedger();
    const resumed: RunRow[] = [];
    const row = openRun(h, {
      projectId: "p-scripted", targetSlug: "biz", targetKind: "business",
      childPid: 999_999, sessionId: "s-1", initialLeaseSec: -60,
      meta: { outputs_root: outputsAt("scripted-outputs", Date.now()) },
    });
    markState(h, row.run_id, "running");

    sweep({
      handle: h,
      resumeImpl: (r) => { resumed.push(r); return { ok: true, finalState: "delivered", detail: "stub" }; },
      notifyImpl: noNotify,
      salvageImpl: noSalvage,
    });

    expect(resumed.length).toBe(1);
    expect(getRun(h, row.run_id)!.state).toBe("delivered");
  });
});

// ── 3. periodic status ────────────────────────────────────────────────────

describe("supervisor — progress ping", () => {
  test("a long run reports in once per interval, not once per sweep", () => {
    const h = freshLedger();
    const row = openRun(h, {
      projectId: "p-long", targetSlug: "brandcraft", targetKind: "squad",
      childPid: null, initialLeaseSec: 7200,
      meta: { path: "agentic", outputs_root: outputsAt("long-outputs", Date.now()) },
    });
    markState(h, row.run_id, "running");

    const pings: number[] = [];
    const pingImpl = (_r: RunRow, mins: number) => { pings.push(mins); };
    const later = Date.now() + 31 * 60_000;   // past the 1800s default, inside the lease

    sweep({ handle: h, now: later, pingImpl, notifyImpl: noNotify, salvageImpl: noSalvage });
    expect(pings.length).toBe(1);
    expect(pings[0]).toBeGreaterThanOrEqual(30);

    // Same instant, second sweep: the stamp in meta has to suppress it.
    sweep({ handle: h, now: later, pingImpl, notifyImpl: noNotify, salvageImpl: noSalvage });
    expect(pings.length).toBe(1);

    // The run is not disturbed by being reported on.
    expect(getRun(h, row.run_id)!.state).toBe("running");
  });

  test("a run younger than the interval stays quiet", () => {
    const h = freshLedger();
    openRun(h, {
      projectId: "p-young", targetSlug: "brandcraft", targetKind: "squad",
      childPid: null, initialLeaseSec: 7200, meta: { path: "agentic" },
    });
    const pings: number[] = [];
    sweep({ handle: h, pingImpl: (_r, m) => pings.push(m), notifyImpl: noNotify, salvageImpl: noSalvage });
    expect(pings.length).toBe(0);
  });
});

// ── 4. the close door ─────────────────────────────────────────────────────

describe("nrv run-track", () => {
  const ledger = path.join(TMP, "run-track.sqlite");
  const env = { ...process.env, NIRVANA_RUN_LEDGER_DB: ledger, NIRVANA_SKILLS_DIR: SKILLS };
  const runTrack = (args: string[]) =>
    spawnSync(process.execPath, [path.join(SKILLS, "harness", "scripts", "run-track.ts"), ...args], { encoding: "utf8", env });

  test("open → close walks running to delivered without an illegal jump", () => {
    const outputs = path.join(TMP, "rt-outputs");
    fs.mkdirSync(outputs, { recursive: true });
    const opened = runTrack(["open", "--target", "brandcraft", "--kind", "squad", "--project", "p-rt", "--outputs", outputs]);
    expect(opened.status).toBe(0);
    const runId = opened.stdout.trim();
    expect(runId).toMatch(/^run-/);

    const h = openLedger(ledger);
    expect(getRun(h, runId)!.state).toBe("running");

    const closed = runTrack(["close", runId, "--state", "delivered"]);
    expect(closed.status).toBe(0);
    expect(getRun(h, runId)!.state).toBe("delivered");
  }, spawnBudgetMs(2));

  test("a run the supervisor already escalated can still be closed truthfully", () => {
    // The realistic late finish: the sweep gave up at the lease, the human was
    // notified, and then the agent actually delivered. A ledger that refused the
    // close would keep asserting `stalled` about finished work — the same lie in
    // the other direction.
    const outputs = path.join(TMP, "rt-outputs-3");
    fs.mkdirSync(outputs, { recursive: true });
    const runId = runTrack(["open", "--target", "brandcraft", "--kind", "squad", "--project", "p-rt3", "--outputs", outputs]).stdout.trim();
    const h = openLedger(ledger);
    markState(h, runId, "stalled", { error: "supervisor: agentic run stopped reporting" });

    expect(runTrack(["close", runId, "--state", "delivered"]).status).toBe(0);
    expect(getRun(h, runId)!.state).toBe("delivered");
  }, spawnBudgetMs(1));

  test("closing an unknown run warns instead of failing the caller's work", () => {
    const r = runTrack(["close", "run-does-not-exist", "--state", "delivered"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("not found");
  }, spawnBudgetMs(1));

  test("a failed close records why", () => {
    const outputs = path.join(TMP, "rt-outputs-2");
    fs.mkdirSync(outputs, { recursive: true });
    const runId = runTrack(["open", "--target", "x", "--kind", "agent-x", "--project", "p-rt2", "--outputs", outputs]).stdout.trim();
    runTrack(["close", runId, "--state", "failed", "--error", "runtime sem cota"]);
    const row = getRun(openLedger(ledger), runId)!;
    expect(row.state).toBe("failed");
    expect(row.last_error).toContain("cota");
  }, spawnBudgetMs(2));
});

// ── 5. the lib door ───────────────────────────────────────────────────────

describe("openAgenticRun", () => {
  test("never throws — a broken ledger must not take down the dispatch", () => {
    const prev = process.env.NIRVANA_RUN_LEDGER_DB;
    // A path that cannot be opened as a database (a directory).
    process.env.NIRVANA_RUN_LEDGER_DB = TMP;
    try {
      const got = openAgenticRun({ projectId: "p", targetSlug: "s", targetKind: "squad", outputsRoot: TMP });
      expect(got).toBeNull();
    } finally {
      process.env.NIRVANA_RUN_LEDGER_DB = prev;
    }
  });
});
