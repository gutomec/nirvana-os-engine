// driver-activity-timeout.test.ts — the driver's kill decision is ACTIVITY-based.
//
// The defect: `callHostAgentAsync` armed one `setTimeout(kill, timeoutMs)` at
// spawn. It fired on elapsed time alone, so a child writing steadily for longer
// than the budget was SIGTERMed with all its work in flight, and the caller got
// `"<cli> exited null"` — a message that names neither the rule that fired nor
// what the child had been doing.
//
// The contract asserted here: `timeoutMs` is a budget of SILENCE. A child that
// keeps producing bytes survives any elapsed time; a child that stops producing
// them for the budget dies, and says so in a payload a human can read.
//
// Hermetic: no runtime, no network. The "agent" is a Bun script and the driver
// is pointed straight at `bun` (the driver-watchdog.test.ts convention — nothing
// stands between the driver and the process it signals).
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempRoot } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";
import {
  DEFAULT_INACTIVITY_BUDGET_MS,
  LEDGER_DEFAULT_TIMEOUT_MS,
  resolveLedgerTimeoutMs,
} from "../../_shared/lib/host-agent-driver.ts";

const TMP = makeTempRoot("nrv-driver-activity-");
const DRIVER = path.resolve(import.meta.dir, "..", "..", "_shared", "lib", "host-agent-driver.ts");
const SKILLS = path.resolve(import.meta.dir, "..", "..");

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function fakeAgent(name: string, body: string): string {
  const f = path.join(TMP, `${name}-agent.ts`);
  fs.writeFileSync(f, body);
  return f;
}

interface Scenario { wallMs: number; payload: Record<string, unknown>; logsDir: string }

function runScenario(name: string, cli: string, callOpts: string): Scenario {
  const script = path.join(TMP, `${name}.ts`);
  const logsDir = path.join(TMP, `${name}-logs`);
  fs.writeFileSync(script, [
    `import { callHostAgentAsync } from ${JSON.stringify(DRIVER)};`,
    `const res = await callHostAgentAsync("", "hi", {`,
    `  __testRuntime: { name: "fake", cli: ${JSON.stringify(process.execPath)}, buildArgs: () => [${JSON.stringify(cli)}], parseStdout: (s: string) => s.trim() },`,
    `  ${callOpts}`,
    `});`,
    `console.log("RESOLVED:" + JSON.stringify(res));`,
  ].join("\n"));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    timeout: spawnBudgetMs(4),
    env: { ...process.env, HARNESS_LOGS_DIR: logsDir, NIRVANA_SKILLS_DIR: SKILLS },
  });
  const wallMs = Date.now() - t0;
  const line = (r.stdout || "").split("\n").find((l) => l.startsWith("RESOLVED:"));
  expect(line).toBeTruthy();
  return { wallMs, payload: JSON.parse((line as string).slice("RESOLVED:".length)), logsDir };
}

function auditEvents(logsDir: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (!fs.existsSync(logsDir)) return out;
  for (const day of fs.readdirSync(logsDir)) {
    const f = path.join(logsDir, day, "audit.jsonl");
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return out;
}

describe("driver — a working child is not killed by the clock", () => {
  test("a child producing output steadily outlives its budget many times over", () => {
    // Writes every 250ms for 3s against a 1s budget: twelve renewals, three
    // times the old wall-clock ceiling. Pre-fix this resolved as a SIGTERM at 1s.
    const cli = fakeAgent("steady", `
      for (let i = 0; i < 12; i++) { console.log("chunk " + i); await Bun.sleep(250); }
      console.log("done");
    `);
    const { payload } = runScenario("survives", cli, `timeoutMs: 1_000, heartbeatMs: 0`);
    expect(payload.error).toBeUndefined();
    expect(payload.exit_code).toBe(0);
    expect(String(payload.text)).toContain("done");
  }, spawnBudgetMs(4));

  test("a child that goes silent dies at the budget and names the rule that killed it", () => {
    const cli = fakeAgent("goes-silent", `console.log("start");\nawait Bun.sleep(30_000);`);
    const { wallMs, payload, logsDir } = runScenario("dies", cli, `timeoutMs: 1_000, heartbeatMs: 0`);
    expect(payload.error).toBe("inactivity_timeout");
    expect(payload.exit_code).toBe(-1);
    // What the child had been doing, in the payload — not just "exited null".
    expect(Number(payload.stalled_after_ms)).toBeGreaterThanOrEqual(1_000);
    expect(Number(payload.bytes_received_before_stall)).toBeGreaterThan(0);
    // The SIGKILL escalation must not outlive the settle: the process exits at
    // the kill, not five seconds later.
    expect(wallMs).toBeLessThan(spawnBudgetMs(2));

    // A run that dies leaves a reason a human can read.
    const killed = auditEvents(logsDir).filter(e => e.event === "x_driver_child_killed");
    expect(killed.length).toBe(1);
    expect(killed[0].rule).toBe("inactivity");
    expect(killed[0].budget_ms).toBe(1_000);
    expect(Number(killed[0].silent_ms)).toBeGreaterThanOrEqual(1_000);
    expect(Number(killed[0].bytes_received)).toBeGreaterThan(0);
  }, spawnBudgetMs(4));

  test("silence is measured from the LAST byte, not from spawn", () => {
    // Two seconds of work, then silence, against a 1s budget. A wall clock kills
    // at 1s; a silence budget kills at ~3s. The wall time separates the two.
    const cli = fakeAgent("late-silence", `
      for (let i = 0; i < 8; i++) { console.log("tick " + i); await Bun.sleep(250); }
      await Bun.sleep(30_000);
    `);
    const { wallMs, payload } = runScenario("late", cli, `timeoutMs: 1_000, heartbeatMs: 0`);
    expect(payload.error).toBe("inactivity_timeout");
    expect(wallMs).toBeGreaterThan(2_500);
  }, spawnBudgetMs(4));
});

describe("driver — the budgets themselves", () => {
  test("no caller inherits a two-minute ceiling on an LLM call", () => {
    // Measured on this machine's 557 Claude Code transcripts (123,318 intra-turn
    // gaps, session-scoped, compaction-aware): 1.8% of the pauses between two
    // consecutive tool calls exceed two minutes. A 120s default killed roughly
    // one thinking pause in fifty-five.
    expect(DEFAULT_INACTIVITY_BUDGET_MS).toBeGreaterThan(120_000);
    // 45 min sits above the last credible single pause in that sample (0.089%
    // of gaps exceed it, and most of those are resumed sessions).
    expect(DEFAULT_INACTIVITY_BUDGET_MS).toBe(45 * 60_000);
  });

  test("the ledgered wall clock is a backstop no real run can reach", () => {
    expect(resolveLedgerTimeoutMs({ timeoutMs: 1234, ledger: { runId: "x" } })).toBe(1234);
    expect(resolveLedgerTimeoutMs({ ledger: { runId: "x" } })).toBe(LEDGER_DEFAULT_TIMEOUT_MS);
    expect(resolveLedgerTimeoutMs({})).toBeUndefined();
    // The longest run in this machine's ledger (371 rows) is 25.5h, and the
    // longest DELIVERED one 4.9h. 24h cut below both; the backstop must sit far
    // above the work, because the hang detector is the activity signal.
    expect(LEDGER_DEFAULT_TIMEOUT_MS).toBeGreaterThan(25.5 * 60 * 60_000);
  });
});
