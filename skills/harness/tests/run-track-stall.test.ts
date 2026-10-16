// run-track-stall.test.ts — `nrv run-track` and a run its stall guard ended.
//
// A dispatch is awaited through its completion notice, or through `nrv
// run-track wait`. Both must always end: a stalled run answers 76 with the next
// steps, a live dispatcher whose lease nobody renewed past the stall threshold
// plus the grace answers 76 too, and a worker the engine opened in an Orca
// terminal (outside any process tree here) has its terminal closed when its
// run is closed. Hermetic: a fake `orca` on PATH, a temp ledger.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getRun, markState, openLedger, openRun, patchMeta, processStartedAt } from "../lib/run-ledger.ts";
import { IS_WINDOWS, writeFakeCli } from "./helpers/fake-cli.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-run-track-stall-"));
const PROJECT = path.join(TMP, "project");
fs.mkdirSync(path.join(PROJECT, ".nirvana"), { recursive: true });
const DB = path.join(TMP, "ledger.sqlite");
const RUN_TRACK = path.resolve(import.meta.dir, "..", "scripts", "run-track.ts");
const started: number[] = [];
const ENV = { ...process.env, NIRVANA_RUN_LEDGER_DB: DB, NIRVANA_PROJECT_ROOT: PROJECT, NIRVANA_NO_DESKTOP_NOTIFY: "1", NIRVANA_RUN_TRACK_BACKSTOP_MS: "200" };

afterAll(() => {
  for (const pid of started) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  // Windows cannot delete a SQLite file that is still open.
  openLedger(DB).close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** A sleeping process this test is not the parent of. */
function sleeper(): number {
  const r = spawnSync(process.execPath, ["-e",
    `const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" }); c.unref(); console.log(c.pid);`,
  ], { encoding: "utf8" });
  const pid = Number(r.stdout.trim());
  started.push(pid);
  return pid;
}

describe("run-track and a stalled run", () => {
  test("wait and status answer 76 for a stalled run, with the next steps", () => {
    const h = openLedger(DB);
    const row = openRun(h, { projectId: "stalled-p", traceId: "stalled-p", projectRoot: PROJECT, targetKind: "squad", runtime: "antigravity-cli" });
    markState(h, row.run_id, "running");
    markState(h, row.run_id, "stalled", { error: "stalled: the worker never started", metaPatch: { stall: { rule: "never_started", confirmed_at: new Date().toISOString() }, salvaged: true } });
    const waited = spawnSync(process.execPath, [RUN_TRACK, "wait", "stalled-p", "--json", "--timeout", "20"], { cwd: PROJECT, encoding: "utf8", env: ENV });
    expect(waited.status, waited.stdout + waited.stderr).toBe(76);
    const answer = JSON.parse(waited.stdout.trim());
    expect(answer.state).toBe("stalled");
    expect(answer.stall.rule).toBe("never_started");
    expect(answer.next).toEqual(["nrv run-track status stalled-p", `nrv revise stalled-p "<what to do>"   # resumes the worker's session`]);
    const status = spawnSync(process.execPath, [RUN_TRACK, "status", row.run_id], { cwd: PROJECT, encoding: "utf8", env: ENV });
    expect(status.status).toBe(76);
    expect(status.stdout).toContain("next: nrv revise stalled-p");
  }, 30_000);

  test("wait returns 76 when the dispatcher is alive but its lease expired past the stall threshold and the grace", () => {
    const h = openLedger(DB);
    const dispatcher = sleeper();
    const row = openRun(h, { projectId: "wedged-p", traceId: "wedged-p", projectRoot: PROJECT, targetKind: "squad", runtime: "codex",
      initialLeaseSec: -(3 * 60 * 60), meta: { dispatcher_pid: dispatcher, dispatcher_started_at: processStartedAt(dispatcher), stall_guard: { silence_ms: 90 * 60_000, no_start_ms: 45 * 60_000 } } });
    markState(h, row.run_id, "running");
    const waited = spawnSync(process.execPath, [RUN_TRACK, "wait", row.run_id, "--json", "--timeout", "20"], { cwd: PROJECT, encoding: "utf8", env: ENV });
    expect(waited.status, waited.stdout + waited.stderr).toBe(76);
    expect(JSON.parse(waited.stdout.trim()).stall.rule).toBe("lease_expired");
  }, 30_000);

  test("a live dispatcher between two workers is still running, not killed", () => {
    const h = openLedger(DB);
    const dispatcher = sleeper();
    // The recorded worker pid is long gone (the previous seat finished).
    const deadWorker = spawnSync(process.execPath, ["-e", "0"]).pid!;
    const row = openRun(h, { projectId: "between-p", traceId: "between-p", projectRoot: PROJECT, targetKind: "business", runtime: "claude-code",
      childPid: deadWorker, meta: { dispatcher_pid: dispatcher, dispatcher_started_at: processStartedAt(dispatcher) } });
    markState(h, row.run_id, "running");
    const status = spawnSync(process.execPath, [RUN_TRACK, "status", row.run_id, "--json"], { cwd: PROJECT, encoding: "utf8", env: ENV });
    expect(status.status).toBe(75);
    expect(JSON.parse(status.stdout.trim()).state).toBe("running");
  }, 30_000);

  test("a signal file left by an earlier attempt does not end the wait for a live one", () => {
    const h = openLedger(DB);
    const row = openRun(h, { projectId: "again-p", traceId: "again-p", projectRoot: PROJECT, targetKind: "squad", runtime: "codex" });
    markState(h, row.run_id, "running");
    markState(h, row.run_id, "failed", { error: "first attempt" });
    // The supervisor resumes it: the old signal file stays on disk.
    markState(h, row.run_id, "running");
    const waited = spawnSync(process.execPath, [RUN_TRACK, "wait", row.run_id, "--json", "--timeout", "2"], { cwd: PROJECT, encoding: "utf8", env: ENV });
    expect(waited.status, waited.stdout + waited.stderr).toBe(6);
    expect(getRun(h, row.run_id)!.state).toBe("running");
  }, 30_000);
});

describe("run-track close and a worker in an Orca terminal", () => {
  // The worker in an Orca terminal is not in the dispatcher's tree: on
  // 2026-10-15 agy sat on its trust dialog for hours after its run was over.
  // Closing the recorded terminal is what ends that CLI.
  const bin = path.join(TMP, "orca-bin");
  const calls = path.join(TMP, "orca-calls.jsonl");
  writeFakeCli(bin, "orca", `
    import * as fs from "node:fs";
    const argv = Bun.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(argv) + "\\n");
    process.stdout.write(JSON.stringify({ ok: true, result: {} }) + "\\n");
  `);
  const orcaCli = path.join(bin, IS_WINDOWS ? "orca.cmd" : "orca");

  test("close closes the recorded Orca terminal and fails its task", () => {
    const h = openLedger(DB);
    const row = openRun(h, { projectId: "orca-p", traceId: "orca-p", projectRoot: PROJECT, targetKind: "squad", runtime: "antigravity-cli" });
    markState(h, row.run_id, "running");
    patchMeta(h, row.run_id, { orca_worker: { terminal: "term_21606efb", run_id: "run_e176", task_id: "task_6a5e", dispatch_id: "ctx_d3cb" } });
    fs.rmSync(calls, { force: true });
    const r = spawnSync(process.execPath, [RUN_TRACK, "close", row.run_id, "--state", "failed", "--error", "superseded"], {
      cwd: PROJECT, encoding: "utf8", env: { ...ENV, ORCA_CLI_COMMAND: orcaCli },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const made: string[][] = fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(made).toContainEqual(["terminal", "close", "--terminal", "term_21606efb", "--json"]);
    expect(made.some((a) => a[1] === "task-update" && a.includes("task_6a5e") && a.includes("failed"))).toBe(true);
    expect(getRun(h, row.run_id)!.state).toBe("abandoned");
  }, 30_000);

  test("a terminal the engine already closed is left alone", () => {
    const h = openLedger(DB);
    const row = openRun(h, { projectId: "closed-p", traceId: "closed-p", projectRoot: PROJECT, targetKind: "squad", runtime: "claude-code" });
    markState(h, row.run_id, "running");
    patchMeta(h, row.run_id, { orca_worker: { terminal: "term_x", closed_at: new Date().toISOString() } });
    fs.rmSync(calls, { force: true });
    const r = spawnSync(process.execPath, [RUN_TRACK, "close", row.run_id, "--state", "failed"], {
      cwd: PROJECT, encoding: "utf8", env: { ...ENV, ORCA_CLI_COMMAND: orcaCli },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(calls)).toBe(false);
  }, 30_000);
});
