// supervisor-sweep.test.ts — recovery semantics of the never-stall sweep:
// dead pid → resume seam; live-but-stalled → SIGTERM + redispatch seam;
// retries exhausted → stalled + notify; guards (self-pid, recursion, opt-out);
// nothing-pending maybeSweep <20ms; launchd plist content via --print.
// Hermetic: one temp SQLite per case, injectable seams, fake children.
import { describe, expect, test, afterAll } from "bun:test";
import { acquireLockSync } from "../../_shared/lib/file-lock.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-supervisor-test-"));
process.env.HARNESS_LOGS_DIR = path.join(TMP, "harness-logs");
process.env.NIRVANA_STATE_DB = path.join(TMP, "state.db");
process.env.NIRVANA_SKILLS_DIR = path.resolve(import.meta.dir, "..", "..");
process.env.NIRVANA_RUN_LEDGER_DB = path.join(TMP, "maybe-sweep.sqlite");

import {
  sweep, maybeSweep, renderLaunchdPlist, salvageStalledRun, redispatchRun, resumeOutcome, renderEscalationNotice,
  type RecoveryResult, type RedispatchOverrides, type SalvageVerdict,
} from "../scripts/supervisor.ts";
import { openLedger, openRun, getRun, markState, pidAlive, type LedgerHandle, type RunRow } from "../lib/run-ledger.ts";

let dbSeq = 0;
function freshLedger(): LedgerHandle {
  return openLedger(path.join(TMP, `case-${dbSeq++}.sqlite`));
}

function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
  return r.pid!;
}

const noNotify = () => {};
const okResume = (calls: RunRow[]) => (r: RunRow): RecoveryResult => { calls.push(r); return { ok: true, finalState: "delivered", detail: "stub" }; };

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe("supervisor sweep — recovery paths", () => {
  test("expired lease + dead pid → resume seam called, retries++, outcome recorded", () => {
    const h = freshLedger();
    const row = openRun(h, {
      targetSlug: "biz", targetKind: "business", runtime: "claude-code",
      childPid: deadPid(), sessionId: "sess-1", projectId: "proj-1", initialLeaseSec: -60,
    });
    markState(h, row.run_id, "running");
    const calls: RunRow[] = [];
    const s = sweep({ handle: h, resumeImpl: okResume(calls), notifyImpl: noNotify });
    expect(calls.length).toBe(1);
    expect(calls[0].run_id).toBe(row.run_id);
    const after = getRun(h, row.run_id)!;
    expect(after.state).toBe("delivered");
    expect(after.retries).toBe(1);
    expect(s.resumed).toBe(1);
    expect(s.recovered).toBe(1);
  });

  test("failed resume keeps the run recoverable for the next sweep", () => {
    const h = freshLedger();
    const row = openRun(h, { childPid: deadPid(), initialLeaseSec: -60 });
    const s = sweep({ handle: h, resumeImpl: () => ({ ok: false, finalState: "failed", detail: "stub fail" }), notifyImpl: noNotify });
    const after = getRun(h, row.run_id)!;
    expect(after.state).toBe("failed");
    expect(after.retries).toBe(1);
    expect(s.resumed).toBe(1);
    expect(s.recovered).toBe(0);
  });

  test("expired lease + live-but-stalled pid → SIGTERM (default kill) + redispatch seam", async () => {
    const h = freshLedger();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    expect(pidAlive(child.pid!)).toBe(true);
    const row = openRun(h, {
      childPid: child.pid, initialLeaseSec: -60,
      meta: { outputs_root: path.join(TMP, "does-not-exist") },
    });
    markState(h, row.run_id, "running");
    // Fake "now" 10 min ahead: lease long expired, heartbeat stale.
    const future = Date.now() + 10 * 60_000;
    const redis: RunRow[] = [];
    const s = sweep({
      handle: h, now: future, notifyImpl: noNotify,
      redispatchImpl: (r) => { redis.push(r); return { ok: false, finalState: "failed", detail: "stub" }; },
    });
    expect(redis.length).toBe(1);
    expect(s.redispatched).toBe(1);
    const after = getRun(h, row.run_id)!;
    expect(after.retries).toBe(1);
    expect(after.state).toBe("failed");
    // The ledgered pid actually received SIGTERM.
    for (let i = 0; i < 20 && pidAlive(child.pid!); i++) await Bun.sleep(100);
    expect(pidAlive(child.pid!)).toBe(false);
  }, 10_000);

  test("live pid with recent output-dir activity gets a grace lease, never a signal", () => {
    const h = freshLedger();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const oroot = path.join(TMP, "active-outputs");
    fs.mkdirSync(oroot, { recursive: true });
    fs.writeFileSync(path.join(oroot, "draft.md"), "work in progress"); // fresh mtime
    const row = openRun(h, { childPid: child.pid, initialLeaseSec: -60, meta: { outputs_root: oroot } });
    markState(h, row.run_id, "running");
    const killed: number[] = [];
    // heartbeat_at is fresh (openRun) AND the output dir is fresh → graced.
    const s = sweep({ handle: h, killImpl: (p) => killed.push(p), notifyImpl: noNotify, redispatchImpl: () => ({ ok: true }) });
    expect(killed.length).toBe(0);
    expect(s.graced).toBe(1);
    const after = getRun(h, row.run_id)!;
    expect(after.state).toBe("running");
    expect(Date.parse(after.lease_expires_at!)).toBeGreaterThan(Date.now());
    child.kill("SIGKILL");
  });

  test("retries exhausted → stalled + notify seam; resume NOT attempted; later sweeps skip it", () => {
    const h = freshLedger();
    const row = openRun(h, { childPid: deadPid(), initialLeaseSec: -60, maxRetries: 0, projectId: "proj-x" });
    markState(h, row.run_id, "running");
    const resumes: RunRow[] = [];
    let notified = 0;
    const s = sweep({ handle: h, resumeImpl: okResume(resumes), notifyImpl: () => { notified++; } });
    expect(resumes.length).toBe(0);
    expect(notified).toBe(1);
    expect(s.escalated).toBe(1);
    const after = getRun(h, row.run_id)!;
    expect(after.state).toBe("stalled");
    // A second sweep must not re-notify (a human owns it now).
    const s2 = sweep({ handle: h, resumeImpl: okResume(resumes), notifyImpl: () => { notified++; } });
    expect(notified).toBe(1);
    expect(s2.skipped).toBe(1);
    expect(s2.escalated).toBe(0);
  });

  test("valid lease → untouched", () => {
    const h = freshLedger();
    const row = openRun(h, { initialLeaseSec: 900 });
    const s = sweep({ handle: h, resumeImpl: okResume([]), redispatchImpl: () => ({ ok: true }), notifyImpl: noNotify });
    expect(s.skipped).toBe(1);
    expect(getRun(h, row.run_id)!.state).toBe("dispatched");
  });

  test("self-guard: a run claiming the supervisor's own pid is never signaled nor recovered", () => {
    const h = freshLedger();
    const row = openRun(h, { childPid: process.pid, initialLeaseSec: -60 });
    markState(h, row.run_id, "running");
    const killed: number[] = [];
    const touched: RunRow[] = [];
    const s = sweep({
      handle: h, killImpl: (p) => killed.push(p), notifyImpl: noNotify,
      resumeImpl: okResume(touched), redispatchImpl: (r) => { touched.push(r); return { ok: true }; },
    });
    expect(killed.length).toBe(0);
    expect(touched.length).toBe(0);
    expect(s.skipped).toBe(1);
    expect(getRun(h, row.run_id)!.state).toBe("running");
  });

  test("kill seam only ever receives the LEDGERED pid", () => {
    const h = freshLedger();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const row = openRun(h, { childPid: child.pid, initialLeaseSec: -60, meta: { outputs_root: path.join(TMP, "nope") } });
    markState(h, row.run_id, "running");
    const killed: number[] = [];
    sweep({
      handle: h, now: Date.now() + 10 * 60_000, notifyImpl: noNotify,
      killImpl: (p) => killed.push(p),
      redispatchImpl: () => ({ ok: false, finalState: "failed" }),
    });
    expect(killed).toEqual([child.pid!]);
    child.kill("SIGKILL");
  });

  test("sweep never throws — a poisoned row is counted as an error, the rest still sweep", () => {
    const h = freshLedger();
    const bad = openRun(h, { childPid: deadPid(), initialLeaseSec: -60 });
    const good = openRun(h, { childPid: deadPid(), initialLeaseSec: -60 });
    const s = sweep({
      handle: h, notifyImpl: noNotify,
      resumeImpl: (r) => {
        if (r.run_id === bad.run_id) throw new Error("seam exploded");
        return { ok: true, finalState: "delivered" };
      },
    });
    expect(s.errors).toBe(1);
    expect(getRun(h, good.run_id)!.state).toBe("delivered");
  });
});

// ── artifact salvage at exhaustion ────────────────────────────────────────
// The gap this closes: the supervisor used to mark a run `stalled`, notify a
// human and walk away, leaving whatever it produced on disk UNJUDGED — the
// same defect the delivery pipeline exists to prevent, through a narrower door.

const PASSING_HTML = [
  "<!doctype html>",
  "<html>",
  "<head><title>Entrega</title></head>",
  "<body>",
  "<main>",
  "<h1>Entrega final</h1>",
  "<p>Conteúdo da página com estrutura balanceada e tamanho suficiente para o gate.</p>",
  "<p>Segundo parágrafo para reforçar o corpo do documento HTML de teste.</p>",
  "</main>",
  "</body>",
  "</html>",
].join("\n");

// wiki-lint hard-fails on spaced-hyphen clause stitching — deterministic, offline.
const FAILING_MD = "# Nota\n\n" + "palavra - outra ".repeat(30) +
  "\n\nParágrafo final simples para dar corpo ao documento e passar de duzentos bytes com folga.\n";

let orootSeq = 0;
function outputsWith(files: Record<string, string>): string {
  const oroot = path.join(TMP, `salvage-out-${orootSeq++}`);
  fs.mkdirSync(oroot, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(oroot, name), body);
  return oroot;
}

function stubVerify(exitCode: number): string {
  const p = path.join(TMP, `salvage-verify-${exitCode}.ts`);
  fs.writeFileSync(p, `process.exit(${exitCode});\n`);
  return p;
}

/** Every file under dir as path → content, for the read-only proof. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[full] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

function auditLines(): any[] {
  const day = new Date().toISOString().slice(0, 10);
  const p = path.join(process.env.HARNESS_LOGS_DIR!, day, "audit.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });
}
// audit.js flattens the payload onto the record (Object.assign(base, payload)).
function auditFor(runId: string, event: string): any[] {
  return auditLines().filter(l => l.event === event && l.run_id === runId);
}

describe("supervisor salvage — artifacts of an escalated run are judged, never abandoned", () => {
  test("exhaustion + artifacts that PASS + manifest verify PASS → delivered", () => {
    const h = freshLedger();
    const oroot = outputsWith({ "page.html": PASSING_HTML });
    const row = openRun(h, {
      childPid: deadPid(), initialLeaseSec: -60, maxRetries: 0,
      projectId: "proj-salv-1", targetKind: "business", targetSlug: "biz",
      meta: { outputs_root: oroot, manifest: "paths.json" },
    });
    markState(h, row.run_id, "running");
    const notices: SalvageVerdict[] = [];
    const s = sweep({
      handle: h, pidExitWaitMs: 0,
      salvageImpl: (r) => salvageStalledRun(h, r, { verifyScript: stubVerify(0), log: () => {}, warn: () => {} }),
      notifyImpl: (_r, _m, v) => { if (v) notices.push(v); },
    });
    expect(s.escalated).toBe(1);
    expect(s.salvaged).toBe(1);
    const after = getRun(h, row.run_id)!;
    expect(after.state).toBe("delivered");
    expect(notices[0].delivered).toBe(true);
    expect(notices[0].gate).toBe("pass");
    expect(notices[0].ceiling).toBeNull();
    // Escalation still fired — salvage enriches it, never silences it.
    expect(auditFor(row.run_id, "human_notification_required").length).toBe(1);
    expect(auditFor(row.run_id, "x_ledger_notify_human").length).toBe(1);
  });

  test("THE CEILING: exhaustion + artifacts that PASS + NO manifest → WITHHELD, reason in the audit", () => {
    const h = freshLedger();
    const oroot = outputsWith({ "page.html": PASSING_HTML });
    const row = openRun(h, {
      childPid: deadPid(), initialLeaseSec: -60, maxRetries: 0,
      projectId: "proj-salv-2", targetKind: "squad", targetSlug: "content-creation",
      meta: { outputs_root: oroot },
    });
    markState(h, row.run_id, "running");
    const notices: SalvageVerdict[] = [];
    const s = sweep({
      handle: h, pidExitWaitMs: 0,
      salvageImpl: (r) => salvageStalledRun(h, r, { log: () => {}, warn: () => {} }),
      notifyImpl: (_r, _m, v) => { if (v) notices.push(v); },
    });
    expect(s.salvaged).toBe(1);
    const after = getRun(h, row.run_id)!;
    expect(after.state).toBe("withheld");   // NOT delivered — completeness unproven
    expect(after.meta.ceiling).toBe("completeness");
    const v = notices[0];
    expect(v.judged).toBe(true);
    expect(v.gate).toBe("pass");            // the gate really did pass…
    expect(v.delivered).toBe(false);        // …and the run was still withheld
    expect(v.ceiling).toContain("interrupted");
    // The reason is visible in the audit payloads, not only in the return value.
    const withheld = auditLines().filter(l => l.event === "x_delivery_withheld" && l.project_id === "proj-salv-2");
    expect(withheld.at(-1)?.ceiling).toBe("completeness");
    expect(withheld.at(-1)?.ceiling_reason).toContain("interrupted");
    expect(auditFor(row.run_id, "x_ledger_salvage_result").at(-1)?.ceiling).toContain("interrupted");
    expect(auditFor(row.run_id, "human_notification_required").at(-1)?.delivered).toBe(false);
    expect(auditFor(row.run_id, "x_ledger_notify_human").at(-1)?.artifacts).toBe(1);
  });

  test("exhaustion + artifacts that FAIL the gate → WITHHELD for quality, ceiling not the reason", () => {
    const h = freshLedger();
    const oroot = outputsWith({ "nota.md": FAILING_MD });
    const row = openRun(h, {
      childPid: deadPid(), initialLeaseSec: -60, maxRetries: 0,
      projectId: "proj-salv-3", meta: { outputs_root: oroot },
    });
    markState(h, row.run_id, "running");
    const notices: SalvageVerdict[] = [];
    sweep({
      handle: h, pidExitWaitMs: 0,
      salvageImpl: (r) => salvageStalledRun(h, r, { log: () => {}, warn: () => {} }),
      notifyImpl: (_r, _m, v) => { if (v) notices.push(v); },
    });
    expect(getRun(h, row.run_id)!.state).toBe("withheld");
    expect(notices[0].gate).toBe("fail");
    expect(notices[0].ceiling).toBeNull();
    expect(notices[0].delivered).toBe(false);
  });

  test("exhaustion + NO artifacts → current behavior unchanged: stalled, notified once, nothing judged", () => {
    const h = freshLedger();
    const oroot = outputsWith({});                       // empty dir
    const row = openRun(h, {
      childPid: deadPid(), initialLeaseSec: -60, maxRetries: 0,
      projectId: "proj-salv-4", meta: { outputs_root: oroot },
    });
    markState(h, row.run_id, "running");
    const notices: SalvageVerdict[] = [];
    const s = sweep({
      handle: h, pidExitWaitMs: 0,
      salvageImpl: (r) => salvageStalledRun(h, r, { log: () => {}, warn: () => {} }),
      notifyImpl: (_r, _m, v) => { if (v) notices.push(v); },
    });
    expect(s.escalated).toBe(1);
    expect(s.salvaged).toBe(0);
    expect(getRun(h, row.run_id)!.state).toBe("stalled");
    expect(notices[0].judged).toBe(false);
    expect(notices[0].skipReason).toBe("no_artifacts");
  });

  test("the salvage is READ-ONLY: no runtime spawn, outputs dir byte-identical afterwards", () => {
    const h = freshLedger();
    const oroot = outputsWith({ "nota.md": FAILING_MD, "page.html": PASSING_HTML });
    const before = snapshot(oroot);
    const row = openRun(h, {
      childPid: deadPid(), initialLeaseSec: -60, maxRetries: 0,
      projectId: "proj-salv-5", meta: { outputs_root: oroot },
    });
    markState(h, row.run_id, "running");
    sweep({
      handle: h, pidExitWaitMs: 0, notifyImpl: noNotify,
      salvageImpl: (r) => salvageStalledRun(h, r, { log: () => {}, warn: () => {} }),
    });
    // A gate FAIL would normally trigger auto-revision runs (which rewrite the
    // artifacts). The salvage runs with maxRevisions 0 and a throwing
    // runHeadless seam, so nothing on disk moved.
    expect(snapshot(oroot)).toEqual(before);
    expect(getRun(h, row.run_id)!.state).toBe("withheld");
  });

  test("MID-RECOVERY: a run with retries left never reaches the salvage (resume path)", () => {
    const h = freshLedger();
    const oroot = outputsWith({ "page.html": PASSING_HTML });
    const row = openRun(h, {
      childPid: deadPid(), initialLeaseSec: -60, maxRetries: 2,   // retries LEFT
      projectId: "proj-salv-6", meta: { outputs_root: oroot },
    });
    markState(h, row.run_id, "running");
    const salvages: RunRow[] = [];
    const resumes: RunRow[] = [];
    const s = sweep({
      handle: h, pidExitWaitMs: 0, notifyImpl: noNotify,
      resumeImpl: (r) => { resumes.push(r); return { ok: true, finalState: "delivered", detail: "stub" }; },
      salvageImpl: (r) => { salvages.push(r); return { judged: false, skipReason: null, artifacts: 0, gateable: 0, gate: null, delivered: false, ceiling: null, outputsRoot: null, finalState: null, detail: null }; },
    });
    expect(resumes.length).toBe(1);
    expect(salvages.length).toBe(0);   // structurally unreachable: escalate() never ran
    expect(s.escalated).toBe(0);
    expect(s.salvaged).toBe(0);
  });

  test("MID-RECOVERY: a live-but-stalled run with retries left never reaches the salvage (redispatch path)", () => {
    const h = freshLedger();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const oroot = outputsWith({ "page.html": PASSING_HTML });
    const row = openRun(h, {
      childPid: child.pid, initialLeaseSec: -60, maxRetries: 2,
      projectId: "proj-salv-7", meta: { outputs_root: oroot },
    });
    markState(h, row.run_id, "running");
    const salvages: RunRow[] = [];
    const s = sweep({
      handle: h, now: Date.now() + 10 * 60_000, pidExitWaitMs: 0, notifyImpl: noNotify,
      killImpl: () => {},   // the child stays alive on purpose
      redispatchImpl: () => ({ ok: false, finalState: "failed", detail: "stub" }),
      salvageImpl: (r) => { salvages.push(r); return { judged: false, skipReason: null, artifacts: 0, gateable: 0, gate: null, delivered: false, ceiling: null, outputsRoot: null, finalState: null, detail: null }; },
    });
    expect(s.redispatched).toBe(1);
    expect(salvages.length).toBe(0);
    child.kill("SIGKILL");
  });

  test("a live ledgered child aborts the salvage even if the call site is reached", () => {
    const h = freshLedger();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const oroot = outputsWith({ "page.html": PASSING_HTML });
    const row = openRun(h, {
      childPid: child.pid, initialLeaseSec: -60, maxRetries: 0,
      projectId: "proj-salv-8", meta: { outputs_root: oroot },
    });
    markState(h, row.run_id, "running");
    const notices: SalvageVerdict[] = [];
    sweep({
      handle: h, now: Date.now() + 10 * 60_000, pidExitWaitMs: 0,
      killImpl: () => {},   // pid survives the "SIGTERM"
      salvageImpl: (r) => salvageStalledRun(h, r, { log: () => {}, warn: () => {} }),
      notifyImpl: (_r, _m, v) => { if (v) notices.push(v); },
    });
    expect(notices[0].judged).toBe(false);
    expect(notices[0].skipReason).toBe("live_writer");
    expect(getRun(h, row.run_id)!.state).toBe("stalled");
    child.kill("SIGKILL");
  });

  test("already-salvaged row is not re-judged; a NEW stalled run still notifies", () => {
    const h = freshLedger();
    // Empty outputs → the salvage finds nothing, so the row STAYS `stalled`
    // (a terminal state would make the next sweep skip it for free; this is
    // the case where meta.salvaged is the only thing preventing a re-judge).
    const a = openRun(h, {
      childPid: deadPid(), initialLeaseSec: -60, maxRetries: 0,
      projectId: "proj-salv-9a", meta: { outputs_root: outputsWith({}) },
    });
    markState(h, a.run_id, "running");
    let judged = 0;
    let notified = 0;
    const deps = () => ({
      handle: h, pidExitWaitMs: 0,
      salvageImpl: (r: RunRow) => { judged++; return salvageStalledRun(h, r, { log: () => {}, warn: () => {} }); },
      notifyImpl: () => { notified++; },
    });
    sweep(deps());
    expect(judged).toBe(1);
    expect(notified).toBe(1);
    expect(getRun(h, a.run_id)!.state).toBe("stalled");
    expect(getRun(h, a.run_id)!.meta.salvaged).toBe(true);

    // Second sweep: still swept (non-terminal), but skipped on meta.salvaged.
    const s2 = sweep(deps());
    expect(judged).toBe(1);
    expect(notified).toBe(1);
    expect(s2.scanned).toBe(1);
    expect(s2.skipped).toBe(1);

    // A row already `stalled` WITHOUT meta.salvaged (escalated before salvage
    // existed — the real ledger has such rows) is still picked up exactly once.
    const orootB = outputsWith({ "page.html": PASSING_HTML });
    const b = openRun(h, {
      childPid: deadPid(), initialLeaseSec: -60, maxRetries: 0,
      projectId: "proj-salv-9b", meta: { outputs_root: orootB },
    });
    markState(h, b.run_id, "stalled");
    const s3 = sweep(deps());
    expect(judged).toBe(2);
    expect(notified).toBe(2);
    expect(s3.escalated).toBe(1);
    expect(getRun(h, b.run_id)!.state).toBe("withheld");
    expect(s3.skipped).toBe(1);   // row A still skipped while row B escalates

    // And a genuinely NEW stalled run still gets its own notification.
    const c = openRun(h, {
      childPid: deadPid(), initialLeaseSec: -60, maxRetries: 0,
      projectId: "proj-salv-9c", meta: { outputs_root: outputsWith({}) },
    });
    markState(h, c.run_id, "running");
    sweep(deps());
    expect(notified).toBe(3);
    expect(getRun(h, c.run_id)!.state).toBe("stalled");
  });

  test("the escalation notice carries the verdict, not just the reason", () => {
    const h = freshLedger();
    const row = openRun(h, { projectId: "proj-notice", targetKind: "squad", targetSlug: "content-creation", maxRetries: 2 });
    const verdict: SalvageVerdict = {
      judged: true, skipReason: null, artifacts: 16, gateable: 13, gate: "fail",
      delivered: false, ceiling: null, outputsRoot: "/tmp/deliverables",
      finalState: "withheld", detail: "exit 2",
    };
    const notice = renderEscalationNotice({ ...row, retries: 2 }, "orphaned run; retries exhausted", verdict);
    expect(notice).toContain("16 artifact(s) on disk · 13 gateable · gate FAIL");
    expect(notice).toContain("decision: WITHHELD — quality gate rejected the artifacts");
    expect(notice).toContain("outputs:  /tmp/deliverables");
    // …and the ceiling case names completeness as the blocker.
    const capped = renderEscalationNotice({ ...row, retries: 2 }, "orphaned run; retries exhausted",
      { ...verdict, gate: "pass", ceiling: "supervisor salvage: the run was interrupted" });
    expect(capped).toContain("decision: WITHHELD — gate passed, completeness unproven (no manifest)");
  });
});

// ── post-redispatch delivery ──────────────────────────────────────────────
// The gap this closes: after a successful redispatch the supervisor used to
// run a homegrown verify (200-byte rule) + a .md/.txt/.json-only gate, and
// then FAIL OPEN — a run producing only .html/.pdf/images/code was declared
// `delivered` with "gate indeterminate", i.e. delivered without one rubric
// ever running. The outcome now goes through the delivery pipeline, the same
// one the dispatch path and the salvage use.

const PASSING_MD = [
  "# Relatório de entrega",
  "",
  "O time concluiu o levantamento pedido no brief. Os dados vieram de três fontes internas, todas com registro de data.",
  "",
  "A leitura principal: o volume caiu no segundo trimestre, e a queda se concentra em duas praças. Nada indica sazonalidade.",
  "",
  "## Próximos passos",
  "",
  "1. Revisar a base de contatos.",
  "2. Refazer a segmentação por praça.",
  "3. Publicar o painel interno até sexta.",
  "",
  "Fica um alerta honesto: a amostra de junho é menor do que gostaríamos, então o intervalo de confiança é largo.",
].join("\n");

// html-valid hard-fails on unbalanced non-void tags — deterministic, offline.
const BROKEN_HTML = [
  "<!doctype html>",
  "<html>",
  "<head><title>Quebrada</title></head>",
  "<body>",
  "<main>",
  "<h1>Página incompleta</h1>",
  "<p>Parágrafo com corpo suficiente para passar do piso de duzentos bytes do verify.</p>",
  "<div>",
  "<span>Bloco aberto de propósito: duas tags nunca fecham, e o gate precisa enxergar isso.",
  "</main>",
  "</body>",
  "</html>",
].join("\n");

/** A .png with a valid signature but under 1KB — brief-fidelity rejects it as
 *  corrupted/placeholder. Proves an IMAGE is really judged, not waved through. */
const STUB_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(300, 7),
]);

const NON_GATEABLE_PDF = "%PDF-1.7\n" + "conteúdo binário simulado ".repeat(20) + "\n%%EOF\n";

let redispatchSeq = 0;

/** A ledgered run parked in `running` (where sweepOne leaves it before calling
 *  the redispatch seam), with the meta the redispatch needs and `files`
 *  already sitting in its outputs root — i.e. what the fresh run produced. */
function redispatchCase(h: LedgerHandle, files: Record<string, string | Buffer>, opts: {
  meta?: Record<string, unknown>;
  targetKind?: string;
  targetSlug?: string;
  maxRetries?: number;
} = {}): { row: RunRow; oroot: string } {
  const n = redispatchSeq++;
  const base = path.join(TMP, `redispatch-${n}`);
  const oroot = path.join(base, "outputs");
  fs.mkdirSync(oroot, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(oroot, name), body as any);
  const promptPath = path.join(base, "prompt.md");
  fs.writeFileSync(promptPath, "Entregue todos os artefatos pedidos no brief original.");
  const row = openRun(h, {
    childPid: deadPid(), initialLeaseSec: -60, maxRetries: opts.maxRetries ?? 2,
    projectId: `proj-redisp-${n}`, targetKind: opts.targetKind ?? "squad", targetSlug: opts.targetSlug ?? "content-creation",
    meta: { outputs_root: oroot, project_dir: base, project_root: base, prompt_path: promptPath, ...(opts.meta ?? {}) },
  });
  markState(h, row.run_id, "running");
  return { row: getRun(h, row.run_id)!, oroot };
}

/** The fresh run the supervisor starts, stubbed: it "succeeded" and the files
 *  the case seeded are what it wrote. */
const okCascade = () => ({ ok: true, sessionId: "sess-redispatch", finalRuntime: "claude-code" });

/** Delivery overrides every case shares: silent, with a counting stand-in for
 *  the revision runtime. The supervisor sets maxRevisions 0, so the counter is
 *  there to PROVE nothing is spent — see the budget test below. */
function quietDelivery(revisionCalls: unknown[] = []): RedispatchOverrides {
  return {
    runCascadeImpl: okCascade,
    runHeadlessImpl: ((a: unknown) => { revisionCalls.push(a); return { ok: false }; }) as any,
    log: () => {}, warn: () => {},
  };
}

describe("supervisor redispatch — the outcome goes through the delivery pipeline", () => {
  test("THE FAIL-OPEN, CLOSED: only non-gateable artifacts → INDETERMINATE, never delivered", () => {
    const h = freshLedger();
    const { row } = redispatchCase(h, { "relatorio.pdf": NON_GATEABLE_PDF });
    const res = redispatchRun(h, row, quietDelivery());
    // Old behavior: {ok:true, finalState:"delivered", detail:"…gate indeterminate"}.
    expect(res.ok).toBe(false);
    expect(res.finalState).toBe("withheld");
    expect(res.detail).toContain("INDETERMINATE");
    expect(res.detail).toContain("nothing delivered");
    const after = getRun(h, row.run_id)!;
    expect(after.state).toBe("withheld");
    expect(after.meta.gate).toBe("indeterminate");
  });

  test("THE FAIL-OPEN, CLOSED: .html + .png are judged, not waved through", () => {
    const h = freshLedger();
    // Not one .md/.txt/.json in sight — the old gate surface saw zero files and
    // delivered on the spot. Both of these are gateable now, and the image is a
    // sub-1KB stub, so the gate has something to say about it.
    const { row } = redispatchCase(h, { "page.html": PASSING_HTML, "hero.png": STUB_PNG });
    const res = redispatchRun(h, row, quietDelivery());
    expect(res.ok).toBe(false);
    expect(res.finalState).toBe("withheld");
    expect(res.detail).toContain("gate fail");
    expect(res.detail).toContain("2 judged");   // the html AND the png
    expect(getRun(h, row.run_id)!.state).toBe("withheld");
  });

  test("the gate surface really covers .html: same shape, opposite verdicts", () => {
    const hBroken = freshLedger();
    const broken = redispatchCase(hBroken, { "page.html": BROKEN_HTML });
    const bad = redispatchRun(hBroken, broken.row, quietDelivery());
    expect(bad.finalState).toBe("withheld");
    expect(bad.detail).toContain("gate fail");

    const hGood = freshLedger();
    const good = redispatchCase(hGood, { "page.html": PASSING_HTML });
    const ok = redispatchRun(hGood, good.row, quietDelivery());
    expect(ok.ok).toBe(true);
    expect(ok.finalState).toBe("delivered");
    expect(ok.detail).toContain("1 judged");
    expect(getRun(hGood, good.row.run_id)!.state).toBe("delivered");
    // Two ledgers and two full redispatches through the delivery pipeline. That
    // is 630ms here and 5,736ms on a cold Windows runner, which overran the
    // 5,000ms default and failed a release PR whose only change was three
    // version strings. The work is genuine, so the budget moves rather than the
    // test — same as the one at the top of this file.
  }, 20_000);

  test("passing text artifacts → delivered", () => {
    const h = freshLedger();
    const { row } = redispatchCase(h, { "nota.md": PASSING_MD });
    const res = redispatchRun(h, row, quietDelivery());
    expect(res.ok).toBe(true);
    expect(res.finalState).toBe("delivered");
    expect(res.detail).toContain("gate pass");
    const after = getRun(h, row.run_id)!;
    expect(after.state).toBe("delivered");
    expect(after.meta.gate).toBe("pass");
  });

  test("NO completeness ceiling: a completed redispatch delivers without a manifest", () => {
    // The salvage caps an INTERRUPTED run at `withheld` without a manifest.
    // A redispatch ran to completion under the supervisor, so the cap does not
    // apply — same evidence the dispatch path delivers on.
    const h = freshLedger();
    const { row } = redispatchCase(h, { "nota.md": PASSING_MD });
    const res = redispatchRun(h, row, quietDelivery());
    expect(res.finalState).toBe("delivered");
    expect(res.detail).not.toContain("ceiling");
    expect(getRun(h, row.run_id)!.meta.ceiling).toBeUndefined();
  });

  test("failing text artifacts → WITHHELD, and the unattended sweep spends NOTHING on revisions", () => {
    // maxRevisions 0 here is a BUDGET rule, not the salvage's read-only rule:
    // the sweep runs under launchd every 120s with nobody watching. A failing
    // gate is withheld and escalated; the human runs `nrv revise` deliberately.
    const h = freshLedger();
    const { row } = redispatchCase(h, { "nota.md": FAILING_MD });
    const revisions: unknown[] = [];
    const res = redispatchRun(h, row, quietDelivery(revisions));
    expect(res.ok).toBe(false);
    expect(res.finalState).toBe("withheld");
    expect(res.detail).toContain("0 revision(s)");
    expect(revisions.length).toBe(0);
    expect(getRun(h, row.run_id)!.state).toBe("withheld");
  });

  test("produced nothing → failed", () => {
    const h = freshLedger();
    const { row } = redispatchCase(h, {});
    const res = redispatchRun(h, row, quietDelivery());
    expect(res.ok).toBe(false);
    expect(res.finalState).toBe("failed");
    expect(res.detail).toContain("no deliverable");
    expect(getRun(h, row.run_id)!.state).toBe("failed");
  });

  test("a manifest is consulted now: verify-deliverable FAIL sinks the redispatch", () => {
    const h = freshLedger();
    const { row } = redispatchCase(h, { "nota.md": PASSING_MD }, {
      targetKind: "business", targetSlug: "biz", meta: { manifest: "paths.json" },
    });
    const res = redispatchRun(h, row, { ...quietDelivery(), verifyScript: stubVerify(1) });
    // The artifacts would pass the gate; the manifest says the SET is incomplete.
    expect(res.ok).toBe(false);
    expect(res.finalState).toBe("failed");
    expect(getRun(h, row.run_id)!.state).toBe("failed");
  });

  test("the failure paths that already worked still work", () => {
    const h = freshLedger();
    const { row } = redispatchCase(h, { "nota.md": PASSING_MD });
    const dead = redispatchRun(h, row, {
      ...quietDelivery(),
      runCascadeImpl: () => ({ ok: false, error: "quota_exhausted" }),
    });
    expect(dead.finalState).toBe("failed");
    expect(dead.detail).toContain("quota_exhausted");
    expect(getRun(h, row.run_id)!.state).toBe("running");   // untouched: nothing was judged

    // No prompt, no paths → nothing to re-dispatch.
    const bare = openRun(h, { childPid: deadPid(), initialLeaseSec: -60 });
    const noMeta = redispatchRun(h, bare, quietDelivery());
    expect(noMeta.finalState).toBe("failed");
    expect(noMeta.detail).toContain("cannot re-dispatch");
  });

  test("through the sweep: the summary counts what the pipeline actually decided", () => {
    const h = freshLedger();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const { row } = redispatchCase(h, { "nota.md": PASSING_MD });
    // Live, stalled, retries left → the redispatch branch of sweepOne.
    markState(h, row.run_id, "failed");
    markState(h, row.run_id, "running", { childPid: child.pid });
    const s = sweep({
      handle: h, now: Date.now() + 10 * 60_000, pidExitWaitMs: 0, notifyImpl: noNotify,
      killImpl: () => {},
      redispatchImpl: (r) => redispatchRun(h, r, quietDelivery()),
    });
    expect(s.redispatched).toBe(1);
    expect(s.recovered).toBe(1);      // the pipeline drove the row terminal; the count still lands
    expect(s.escalated).toBe(0);
    const after = getRun(h, row.run_id)!;
    expect(after.state).toBe("delivered");
    expect(after.retries).toBe(1);
    expect(auditFor(row.run_id, "x_ledger_recovery_result").at(-1)?.final_state).toBe("delivered");
    child.kill("SIGKILL");
  });

  test("the resume branch reads revise.ts's EXIT CODE, never its prose", () => {
    // defaultResume used to map exit 0 → delivered and grep stdout for
    // "gate FAIL" — so it inherited revise.ts's fail-open (exit 0 with a gate
    // that never ran) and decided control flow by reading prose. revise.ts now
    // speaks the pipeline's table, and this is the whole mapping.
    expect(resumeOutcome(0)).toEqual({ ok: true, finalState: "delivered", detail: "resumed via revise session (delivered)" });
    expect(resumeOutcome(2).finalState).toBe("withheld");
    expect(resumeOutcome(2).ok).toBe(false);
    expect(resumeOutcome(3).finalState).toBe("withheld");     // nothing judged → never delivered
    expect(resumeOutcome(3).detail).toContain("INDETERMINATE");
    expect(resumeOutcome(1).finalState).toBe("failed");
    expect(resumeOutcome(4).finalState).toBe("failed");       // invalid args
    expect(resumeOutcome(null).finalState).toBe("failed");    // killed / timed out
  });

  test("through the sweep: a withheld redispatch is NOT counted as recovered", () => {
    const h = freshLedger();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const { row } = redispatchCase(h, { "relatorio.pdf": NON_GATEABLE_PDF });
    markState(h, row.run_id, "failed");
    markState(h, row.run_id, "running", { childPid: child.pid });
    const s = sweep({
      handle: h, now: Date.now() + 10 * 60_000, pidExitWaitMs: 0, notifyImpl: noNotify,
      killImpl: () => {},
      redispatchImpl: (r) => redispatchRun(h, r, quietDelivery()),
    });
    expect(s.redispatched).toBe(1);
    expect(s.recovered).toBe(0);
    expect(getRun(h, row.run_id)!.state).toBe("withheld");
    expect(auditFor(row.run_id, "x_ledger_recovery_result").at(-1)?.final_state).toBe("withheld");
    child.kill("SIGKILL");
  });
});

describe("supervisor — lazy sweep guards and speed", () => {
  test("recursion guard and opt-out short-circuit", () => {
    process.env.NRV_IN_SWEEP = "1";
    expect(maybeSweep()).toBe(false);
    delete process.env.NRV_IN_SWEEP;
    process.env.NRV_SUPERVISOR = "0";
    expect(maybeSweep()).toBe(false);
    delete process.env.NRV_SUPERVISOR;
  });

  test("nothing pending: <20ms and no background sweep; recent-sweep guard skips the next call", () => {
    // Dedicated empty DB via the env override maybeSweep reads.
    process.env.NIRVANA_RUN_LEDGER_DB = path.join(TMP, "maybe-sweep.sqlite");
    openLedger(); // warm (file + DDL) so we measure the steady state
    const t0 = performance.now();
    const spawned = maybeSweep();
    const elapsed = performance.now() - t0;
    expect(spawned).toBe(false);
    expect(elapsed).toBeLessThan(20);
    // A pending run appears, but the last sweep was <5 min ago → still skipped
    // (the background cadence belongs to launchd/watch, not the hot path).
    const h = openLedger();
    openRun(h, { initialLeaseSec: -60 });
    expect(maybeSweep()).toBe(false);
  });
});

describe("supervisor — launchd plist", () => {
  test("install --print emits a sane plist without touching LaunchAgents", () => {
    const supervisorScript = path.resolve(import.meta.dir, "..", "scripts", "supervisor.ts");
    const r = spawnSync(process.execPath, [supervisorScript, "install", "--print"], {
      encoding: "utf8", env: { ...process.env },
    });
    expect(r.status).toBe(0);
    const plist = r.stdout;
    expect(plist).toContain("<key>Label</key><string>sh.nirvana.supervisor</string>");
    expect(plist).toContain("<key>StartInterval</key><integer>120</integer>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<string>sweep</string>");
    expect(plist).toContain("<string>--quiet</string>");
    expect(plist).toContain(supervisorScript);
    // In-process render matches the CLI output.
    expect(renderLaunchdPlist()).toBe(plist);
  });
});

describe("sweep — cross-process lock", () => {
  test("a second sweeper skips while the first holds the lock", () => {
    // Two triggers exist (launchd every 120s + the lazy maybeSweep a user
    // command spawns), so without this lock both would recover the SAME row:
    // two paid re-dispatches writing the same outputs dir at once.
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-sweeplock-")), "ledger.sqlite");
    const held = acquireLockSync(dbPath, { timeoutMs: 0 });
    try {
      // timeoutMs 0 = try-lock: the contender must fail immediately, not wait.
      expect(() => acquireLockSync(dbPath, { timeoutMs: 0 })).toThrow();
    } finally {
      held.release();
    }
    // Released: the next sweeper can take it.
    const after = acquireLockSync(dbPath, { timeoutMs: 0 });
    after.release();
  });
});
