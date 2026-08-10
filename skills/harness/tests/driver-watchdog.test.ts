// driver-watchdog.test.ts — regression for the callHostAgentAsync dangling-
// timer defects: the SIGKILL escalation was never cleared after a stall-kill
// settle (a stray 5s timer held the event loop and could signal a dead pid),
// and the stall path risked double resolution. The fix funnels every
// resolution through one settle() with a single timer-cleanup path.
//
// Method: each scenario runs in a SUBPROCESS so we can assert the whole
// process exits promptly once the call resolves — the observable proof that
// no stray timer is left holding the loop. Pre-fix, the stall-kill scenario
// took 5+ extra seconds (the orphaned escalation timer).
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-driver-watchdog-test-"));
const DRIVER = path.resolve(import.meta.dir, "..", "..", "_shared", "lib", "host-agent-driver.ts");

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/**
 * The fake agent is a Bun script, and the driver is pointed straight at `bun`
 * with that script as its argument — no launcher in between.
 *
 * That matters for THIS file specifically: the watchdog is about process
 * lifetime, so anything standing between the driver and the process it kills
 * changes the result. The old fake was a bash script using `exec` for exactly
 * that reason (replace the shell so SIGTERM reaches the real process); a
 * Windows `.cmd` cannot do that trick — the kill would hit cmd.exe and leave
 * the child holding the stdio pipes. Spawning the interpreter directly gives
 * every platform the single process the test intends.
 */
function fakeAgent(name: string, body: string): string {
  const f = path.join(TMP, `${name}-agent.ts`);
  fs.writeFileSync(f, body);
  return f;
}

function runScenario(name: string, cli: string, callOpts: string): { wallMs: number; payload: Record<string, unknown> } {
  const script = path.join(TMP, `${name}.ts`);
  fs.writeFileSync(script, [
    `import { callHostAgentAsync } from ${JSON.stringify(DRIVER)};`,
    `const res = await callHostAgentAsync("", "hi", {`,
    `  __testRuntime: { name: "fake", cli: ${JSON.stringify(process.execPath)}, buildArgs: () => [${JSON.stringify(cli)}], parseStdout: (s: string) => s.trim() },`,
    `  ${callOpts}`,
    `});`,
    `console.log("RESOLVED:" + JSON.stringify(res));`,
  ].join("\n"));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 30_000 });
  const wallMs = Date.now() - t0;
  const line = (r.stdout || "").split("\n").find((l) => l.startsWith("RESOLVED:"));
  expect(line).toBeTruthy();
  return { wallMs, payload: JSON.parse((line as string).slice("RESOLVED:".length)) };
}

describe("watchdog — stall-kill leaves no dangling timers", () => {
  test("silent child is stall-killed and the process exits promptly", () => {
    const cli = fakeAgent("slow-silent", "await Bun.sleep(30_000);");
    const { wallMs, payload } = runScenario("stall-kill", cli, `timeoutMs: 25_000, heartbeatMs: 700, heartbeatMode: "kill"`);
    expect(payload.error).toBe("stall");
    expect(Number(payload.stalled_after_ms)).toBeGreaterThanOrEqual(700);
    expect(payload.exit_code).toBe(-1);
    // Pre-fix: the uncleared 5s SIGKILL escalation held the loop → ~6s+.
    // Post-fix: stall (~1s) + SIGTERM death + timer cleanup → well under 4s.
    expect(wallMs).toBeLessThan(4_000);
  }, 30_000);

  test("warn mode resolves early, child runs on, timers reclaimed at child exit", () => {
    const cli = fakeAgent("slow-then-exit", `console.log("start");\nawait Bun.sleep(2_000);`);
    const { wallMs, payload } = runScenario("stall-warn", cli, `timeoutMs: 20_000, heartbeatMs: 600, heartbeatMode: "warn"`);
    expect(payload.error).toBe("stall_warning");
    // Process must end when the CHILD exits (~2s), not at timeoutMs (20s):
    // close reclaims the surviving global timeout.
    expect(wallMs).toBeLessThan(6_000);
  }, 30_000);

  test("healthy fast child resolves normally with heartbeat armed", () => {
    const cli = fakeAgent("fast", `console.log("hello");`);
    const { wallMs, payload } = runScenario("happy", cli, `timeoutMs: 20_000, heartbeatMs: 5_000, heartbeatMode: "kill"`);
    expect(payload.text).toBe("hello");
    expect(payload.exit_code).toBe(0);
    expect(wallMs).toBeLessThan(4_000);
  }, 30_000);

  test("nonzero exit resolves as error and exits promptly", () => {
    const cli = fakeAgent("fail-fast", `console.error("kaput");\nprocess.exit(3);`);
    const { wallMs, payload } = runScenario("fail", cli, `timeoutMs: 20_000, heartbeatMs: 5_000`);
    expect(payload.exit_code).toBe(3);
    expect(String(payload.error)).toContain("kaput");
    expect(wallMs).toBeLessThan(4_000);
  }, 30_000);
});
