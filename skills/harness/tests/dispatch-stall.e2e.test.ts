// dispatch-stall.e2e.test.ts — the real dispatch ends itself on a stall.
//
// 2026-10-15: a worker parked on a dialog kept `nrv dispatch` open for 94
// minutes, and the background-task notice the orchestrating agent waited on
// never came. This spawns the REAL scripts/dispatch.ts with a fake `claude`
// that takes its prompt and then says nothing at all, at a stall threshold of
// a few seconds (the real settings, as variables), and proves the whole chain:
// the dispatch exits 76 on its own, `_STATUS.json` says `stalled` with the next
// steps, the gate never ran, the ledger row is `stalled` and stamped for the
// agent (meta.salvaged), the worker is gone, and a separate `nrv run-track
// wait` answers 76 too. No model, no network.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { IS_WINDOWS, writeFakeCli } from "./helpers/fake-cli.ts";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";
import { findByTraceId, openLedger, pidAlive } from "../lib/run-ledger.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const SKILLS = path.join(REPO, "skills");
const DISPATCH = path.join(SKILLS, "harness", "scripts", "dispatch.ts");
const RUN_TRACK = path.join(SKILLS, "harness", "scripts", "run-track.ts");

const roots: string[] = [];
afterEach(() => { while (roots.length) removeDir(roots.pop()!); });

describe.skipIf(IS_WINDOWS)("a dispatch whose worker hangs", () => {
  test("ends itself with exit 76, skips the gate, writes _STATUS.json, and run-track wait says 76", () => {
    const root = makeTempRoot("nrv-dispatch-stall-"); roots.push(root);
    const home = path.join(root, "home");
    const projectRoot = path.join(root, "project");
    const bin = path.join(root, "bin");
    const outputs = path.join(root, "outputs");
    const pidFile = path.join(root, "worker.pid");
    fs.mkdirSync(path.join(projectRoot, ".nirvana"), { recursive: true });
    writeFakeCli(bin, "claude", `
      import * as fs from "node:fs";
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      await Bun.stdin.text();
      await Bun.sleep(120_000);
    `);
    const briefFile = path.join(root, "brief.md");
    fs.writeFileSync(briefFile, "Produza o relatório final em report.html", "utf8");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || /^(NIRVANA_|HARNESS_|FAKE_|NRV_|LLM_CASCADE|SQUADS_DIR|BUSINESSES_DIR)/.test(key)) continue;
      env[key] = value;
    }
    const db = path.join(root, "ledger.sqlite");
    Object.assign(env, {
      HOME: home, NIRVANA_HOME: home, NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_PROJECT_ROOT: projectRoot,
      NIRVANA_HOST_RUNTIME: "claude-code", NIRVANA_RUN_LEDGER_DB: db,
      NIRVANA_STATE_DB: path.join(root, "state.db"), HARNESS_LOGS_DIR: path.join(root, "logs"),
      NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1", NRV_PREFLIGHT: "0", NIRVANA_NO_DESKTOP_NOTIFY: "1",
      NRV_SUPERVISOR: "0", NIRVANA_ORCA_HOST: "off",
      // 3 s to a first sign of life, 4.8 s of silence, a tick every 250 ms.
      NIRVANA_STALL_NO_START_MIN: "0.05", NIRVANA_STALL_TIMEOUT_MIN: "0.08", NIRVANA_HEARTBEAT_INTERVAL_MS: "250",
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    });
    const projectId = "stall-e2e";
    const started = Date.now();
    const r = spawnSync(process.execPath, [DISPATCH, "--agent-x", "--brief-file", briefFile, "--exec",
      "--project", projectId, "--outputs-root", outputs, "--max-revisions", "0"], { cwd: projectRoot, env, encoding: "utf8", timeout: 90_000 });
    const log = `${r.stdout}\n${r.stderr}`;
    expect(r.status, log).toBe(76);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(log).toContain("STALLED (exit 76)");
    expect(log).toContain(`nrv revise ${projectId}`);
    expect(log).not.toContain("Delivery pipeline");

    const status = JSON.parse(fs.readFileSync(path.join(outputs, "_STATUS.json"), "utf8"));
    expect(status.state).toBe("stalled");
    expect(status.exit_code).toBe(76);
    expect(status.gate).toBe("skipped");
    expect(status.stall.rule).toBe("never_started");
    expect(status.next.join("\n")).toContain(`nrv run-track status ${projectId}`);

    const ledger = openLedger(db);
    const row = findByTraceId(ledger, projectId)!;
    // Windows cannot delete a SQLite file that is still open (afterEach).
    ledger.close();
    expect(row.state).toBe("stalled");
    expect(row.meta.salvaged).toBe(true);
    expect(pidAlive(Number(fs.readFileSync(pidFile, "utf8")))).toBe(false);

    const waited = spawnSync(process.execPath, [RUN_TRACK, "wait", projectId, "--json", "--timeout", "30"], { cwd: projectRoot, env, encoding: "utf8" });
    expect(waited.status, waited.stdout + waited.stderr).toBe(76);
    const answer = JSON.parse(waited.stdout.trim());
    expect(answer.state).toBe("stalled");
    expect(answer.stall.rule).toBe("never_started");
    expect(answer.next.length).toBe(2);
  }, 120_000);
});
