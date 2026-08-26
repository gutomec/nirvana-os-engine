import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseGlanceArgs, runGlance } from "../scripts/glance.ts";

const PARSE_CASES = [
  { id: "SVC-NORMAL-DEFAULTS", argv: [], expected: { port: "auto", open: true, idleMin: 30, allowActions: true, theme: "apple" } },
  { id: "SVC-NORMAL-NO-OPEN", argv: ["--no-open"], expected: { open: false } },
  { id: "SVC-NORMAL-PORT", argv: ["--port", "4242"], expected: { port: 4242 } },
  { id: "SVC-NORMAL-READ-ONLY", argv: ["--read-only"], expected: { allowActions: false } },
  { id: "SVC-NORMAL-THEME-APPLE", argv: ["--theme", "apple-dark"], expected: { theme: "apple-dark" } },
  { id: "SVC-NORMAL-ZERO-IDLE", argv: ["--idle-min", "0"], expected: { idleMin: 0 } },
] as const;

test.each(PARSE_CASES)("$id", ({ argv, expected }) => {
  expect(parseGlanceArgs(argv)).toMatchObject({ kind: "normal", ...expected });
});

function allocateLoopbackPort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
  const port = probe.port;
  probe.stop(true);
  return port;
}

test("SVC-NORMAL-REAL-RUNGLANCE", async () => {
  const port = allocateLoopbackPort();
  let now = 0;
  let tick: (() => void) | undefined;
  let opened = "";
  const logged: string[] = [];
  let exited = false;
  const code = await runGlance(["--port", String(port), "--idle-min", "1", "--read-only", "--theme", "apple"], {
    serviceManager: { run: async () => { throw new Error("service path used"); } },
    normalRuntime: {
      now: () => now,
      openBrowser: url => { opened = url; },
      setInterval: callback => { tick = callback; return 1; },
      clearInterval: () => {},
      log: line => logged.push(line),
      exit: exitCode => { if (exitCode !== 0) throw new Error(`unexpected exit ${exitCode}`); exited = true; },
    },
  });
  expect(code).toBe(0);
  expect(opened).toBe(`http://localhost:${port}`);
  const health = await (await fetch(`${opened}/api/health`)).json() as Record<string, unknown>;
  expect(health).toMatchObject({ allow_actions: false, idle_timeout_ms: 60_000 });
  expect(logged.some(line => line.includes(`allow_actions=false, theme=apple`))).toBe(true);
  now = 30_000;
  tick?.();
  expect(exited).toBe(false);
  const refreshed = await (await fetch(`${opened}/api/health`)).json() as Record<string, unknown>;
  expect(refreshed.idle_ms).toBe(0);
  now = 60_001;
  tick?.();
  expect(exited).toBe(false);
  now = 90_001;
  tick?.();
  expect(exited).toBe(true);
  await expect(fetch(`${opened}/api/health`)).rejects.toThrow();
}, 60_000);

test("SVC-NORMAL-DIRECT-CLI-BOOTSTRAP", async () => {
  const script = join(import.meta.dir, "..", "scripts", "glance.ts");
  const port = allocateLoopbackPort();
  const isolatedHome = mkdtempSync(join(tmpdir(), "glance-bootstrap-home-"));
  const child = Bun.spawn([process.execPath, script, "--port", String(port), "--no-open", "--read-only"], { stdout: "ignore", stderr: "ignore", env: { ...process.env, NIRVANA_HOME: isolatedHome } });
  try {
    const deadline = Date.now() + 15_000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) { healthy = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(healthy).toBe(true);
    child.kill();
    await child.exited;
  } finally { rmSync(isolatedHome, { recursive: true, force: true }); }
}, 60_000);

export const NORMAL_CASES = ["SVC-NORMAL-DEFAULTS", "SVC-NORMAL-DIRECT-CLI-BOOTSTRAP", "SVC-NORMAL-NO-OPEN", "SVC-NORMAL-PORT", "SVC-NORMAL-READ-ONLY", "SVC-NORMAL-THEME-APPLE", "SVC-NORMAL-ZERO-IDLE"] as const;
