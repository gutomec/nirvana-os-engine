// glance-idle-never.test.ts — `--idle-min 0` means the cockpit stays up: no
// watchdog is armed and /api/health says so. It used to mean "shut down on the
// first tick", the one-line reason a cockpit could not be left running.
// One server per file, like every glance test: the module keeps boot-time state.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, shutdown } from "../lib/glance/server.ts";

let instance: any;
beforeAll(async () => {
  instance = await startServer({ port: 0, open: false, idleMin: 0, allowActions: false, theme: "apple" } as any);
});
afterAll(() => { try { instance?.close(); } catch {} });

describe("glance --idle-min 0", () => {
  test("no idle timeout is advertised and the server keeps answering", async () => {
    const health = await (await fetch(`http://127.0.0.1:${instance.port}/api/health`)).json();
    expect(health.ok).toBe(true);
    expect(health.idle_timeout_ms).toBeNull();
    expect((await fetch(`http://127.0.0.1:${instance.port}/api/health`)).status).toBe(200);
  }, 30_000);

  test("shutdown tolerates a disarmed watchdog", () => {
    let stopped = false; let code = -1;
    shutdown({ stop() { stopped = true; } }, null, () => {}, (c) => { code = c; }, "/nonexistent/pid");
    expect(stopped).toBe(true);
    expect(code).toBe(0);
  });
});
