// claude-resumed-cost.test.ts — a resumed claude session records the run's own spend.
//
// Since claude 2.1.277 `total_cost_usd` on a resumed session is cumulative
// (code.claude.com/docs/en/agent-sdk/cost-tracking). Every engine path that
// resumes (nrv revise, delivery-pipeline revision rounds, solo review
// corrections: all through runHeadless; maestro chat turns: startMaestroTurn)
// records the difference from the session's last total instead.
// Hermetic: fake `claude` CLIs that report cumulative totals; the ledger is this
// file's own (see below). No LLM, no network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeRunCost, ledgerSessionCostStore, type SessionCostStore } from "../../_shared/lib/claude-session-cost.ts";
import { runHeadless } from "../../_shared/lib/host-agent-driver.ts";
import { openLedger, recordSessionCostTotal, sessionCostTotal } from "../lib/run-ledger.ts";
import { startMaestroTurn } from "../lib/control-plane/maestro-turn.ts";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

// This file's own ledger, not the one skills/test-preload.ts points at. bun runs
// every test file in one process, and several files (business-liveness,
// driver-ledger-heartbeat, serve-*, supervisor-sweep) set NIRVANA_RUN_LEDGER_DB
// at load time, open it, delete their temp dir in afterAll and never restore the
// variable. openLedger() caches its handle by path, so a file running after one
// of them got the cached handle of a deleted SQLite file: "disk I/O error" on
// the first write. A fresh path here has no cached handle, whatever ran before.
const LEDGER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-resumed-cost-ledger-"));
const LEDGER_ENV_BEFORE = process.env.NIRVANA_RUN_LEDGER_DB;
beforeAll(() => { process.env.NIRVANA_RUN_LEDGER_DB = path.join(LEDGER_DIR, "run-ledger.sqlite"); });
afterAll(() => {
  try { openLedger().close(); } catch { /* never opened */ }
  if (LEDGER_ENV_BEFORE === undefined) delete process.env.NIRVANA_RUN_LEDGER_DB;
  else process.env.NIRVANA_RUN_LEDGER_DB = LEDGER_ENV_BEFORE;
  try { fs.rmSync(LEDGER_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function memoryStore(seed: Record<string, number> = {}): SessionCostStore & { data: Map<string, number> } {
  const data = new Map(Object.entries(seed));
  return { data, get: id => data.get(id) ?? null, set: (id, total) => { data.set(id, total); } };
}

describe("claudeRunCost", () => {
  test("a fresh run records its total and reports it as is", () => {
    const store = memoryStore();
    expect(claudeRunCost({ resumedFrom: null, sessionId: "s1", reportedUsd: 0.1 }, store)).toBe(0.1);
    expect(store.data.get("s1")).toBe(0.1);
  });

  test("a resumed run reports the difference from the session's last total", () => {
    const store = memoryStore({ s1: 0.1 });
    expect(claudeRunCost({ resumedFrom: "s1", sessionId: "s1", reportedUsd: 0.25 }, store)).toBe(0.15);
    expect(store.data.get("s1")).toBe(0.25);
    expect(claudeRunCost({ resumedFrom: "s1", sessionId: "s1", reportedUsd: 0.4 }, store)).toBe(0.15);
  });

  test("an unknown previous total keeps today's behaviour", () => {
    const store = memoryStore();
    expect(claudeRunCost({ resumedFrom: "old", sessionId: "old", reportedUsd: 0.7 }, store)).toBe(0.7);
    expect(store.data.get("old")).toBe(0.7);
  });

  test("a value below the stored total is a per-run figure (pre-2.1.277 CLI), kept as is", () => {
    const store = memoryStore({ s1: 0.5 });
    expect(claudeRunCost({ resumedFrom: "s1", sessionId: "s1", reportedUsd: 0.2 }, store)).toBe(0.2);
  });

  test("a resume that comes back under a new id still subtracts the restored total", () => {
    const store = memoryStore({ s1: 0.1 });
    expect(claudeRunCost({ resumedFrom: "s1", sessionId: "s2", reportedUsd: 0.3 }, store)).toBe(0.2);
    expect(store.data.get("s2")).toBe(0.3);
  });

  test("no cost stays no cost, and nothing is stored", () => {
    const store = memoryStore();
    expect(claudeRunCost({ resumedFrom: "s1", sessionId: "s1", reportedUsd: null }, store)).toBeNull();
    expect(store.data.size).toBe(0);
  });

  test("the default store reads the ledger, so a new process (nrv revise) finds the dispatch's total", () => {
    const id = `ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    recordSessionCostTotal(openLedger(), id, 1.25);
    expect(sessionCostTotal(openLedger(), id)).toBe(1.25);
    expect(ledgerSessionCostStore.get(id)).toBe(1.25);
    expect(claudeRunCost({ resumedFrom: id, sessionId: id, reportedUsd: 2 })).toBe(0.75);
    expect(sessionCostTotal(openLedger(), id)).toBe(2);
  });
});

// Each call adds 0.10 to a per-session total kept in the state dir, the way the
// real CLI reports a resumed session's spend.
const CUMULATIVE = (stream: boolean) => String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
const argv = Bun.argv.slice(2);
const value = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
await Bun.stdin.text();
const sid = value("--resume") ?? value("--session-id") ?? "cum-session";
const file = path.join(process.env.FAKE_CUM_DIR, sid + ".total");
const total = Math.round(((fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0) + 0.1) * 1e6) / 1e6;
fs.writeFileSync(file, String(total));
const result = { type: "result", subtype: "success", is_error: false, result: "ok", session_id: sid, total_cost_usd: total };
${stream ? `process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sid }) + "\\n" + JSON.stringify(result) + "\\n");` : `process.stdout.write(JSON.stringify(result));`}
`;

describe("the runners record the run's own spend on resume", () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-resumed-cost-"));
  const BIN = path.join(TMP, "bin");
  const STREAM_BIN = path.join(TMP, "stream-bin");
  const saved = { PATH: process.env.PATH, FAKE_CUM_DIR: process.env.FAKE_CUM_DIR };
  beforeAll(() => {
    writeFakeCli(BIN, "claude", CUMULATIVE(false));
    writeFakeCli(STREAM_BIN, "claude", CUMULATIVE(true));
    process.env.FAKE_CUM_DIR = TMP;
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  test("runHeadless (revise, revision rounds, solo corrections): 0.10, then 0.10 per resumed round", () => {
    process.env.PATH = `${BIN}${path.delimiter}${saved.PATH ?? ""}`;
    try {
      const first = runHeadless({ runtime: "claude-code", prompt: "do", cwd: TMP, timeoutMs: 20_000 });
      expect(first.ok, first.error ?? first.stderr).toBe(true);
      expect(first.sessionId).toBe("cum-session");
      expect(first.costUsd).toBeCloseTo(0.1, 9);
      for (let round = 0; round < 2; round++) {
        const again = runHeadless({ runtime: "claude-code", prompt: "fix", cwd: TMP, timeoutMs: 20_000, sessionId: "cum-session" });
        expect(again.ok, again.error ?? again.stderr).toBe(true);
        expect(again.costUsd).toBeCloseTo(0.1, 9);
      }
    } finally { process.env.PATH = saved.PATH; }
  }, spawnBudgetMs(3));

  test("startMaestroTurn (glance chat): the second turn's cost is its own", async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.PATH = `${STREAM_BIN}${path.delimiter}${saved.PATH ?? ""}`;
    // The executable is resolved against this process's PATH: the fake must win there too.
    process.env.PATH = env.PATH;
    const turn = (sessionId: string | null) => startMaestroTurn({
      runtime: "claude-code", prompt: "oi", cwd: TMP, sessionId, directive: "d", env, onEvent: () => {},
      model: null, skipPermissions: true, maxBudgetUsd: 0,
    });
    const first = await turn(null).done;
    expect(first.ok, first.error).toBe(true);
    expect(first.costUsd).toBeCloseTo(0.1, 9);
    const second = await turn(first.sessionId).done;
    expect(second.ok, second.error).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.costUsd).toBeCloseTo(0.1, 9);
    process.env.PATH = saved.PATH;
  }, spawnBudgetMs(2));
});
