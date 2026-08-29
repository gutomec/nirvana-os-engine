// serve-queue-sse.test.ts — the two behaviours that make the API usable
// under load and observable while it works.
//
// Queue: one run at a time per session (the protocol's own model — a
// project advances one brief at a time) and a global cap, because the
// server must not reproduce on a buyer's VPS the uncontrolled parallelism
// that kills machines.
//
// SSE: progress costs nothing to build because the engine already appends
// every dispatch, gate and revision to the project's audit.jsonl. The
// stream must also END when the run ends, or a client waits forever.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const root = mkdtempSync(join(tmpdir(), "serve-queue-"));
const dispatchFixture = join(root, "slow-dispatch.ts");

// Slow fixture: records start/end timestamps so overlap is provable, and
// appends an audit line so the SSE has something real to stream.
writeFileSync(dispatchFixture, `
import * as fs from "node:fs";
import * as path from "node:path";
const argv = process.argv.slice(2);
const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const out = val("--outputs-root")!;
const trace = val("--project")!;
fs.mkdirSync(out, { recursive: true });
const marks = process.env.FIXTURE_MARKS!;
fs.appendFileSync(marks, JSON.stringify({ trace, at: Date.now(), phase: "start" }) + "\\n");

const projectRoot = process.env.NIRVANA_PROJECT_ROOT!;
const day = new Date().toISOString().slice(0, 10);
const logDir = path.join(projectRoot, ".nirvana", "logs", "harness", day);
fs.mkdirSync(logDir, { recursive: true });
fs.appendFileSync(path.join(logDir, "audit.jsonl"),
  JSON.stringify({ ts: new Date().toISOString(), event: "dispatch_squad", trace_id: trace, squad_name: "fixture-squad" }) + "\\n");

await new Promise((r) => setTimeout(r, parseInt(process.env.FIXTURE_MS || "400", 10)));

fs.appendFileSync(path.join(logDir, "audit.jsonl"),
  JSON.stringify({ ts: new Date().toISOString(), event: "gate_passed", trace_id: trace, files: 1 }) + "\\n");
fs.writeFileSync(path.join(out, "nota.md"), "# entrega lenta");
fs.appendFileSync(marks, JSON.stringify({ trace, at: Date.now(), phase: "end" }) + "\\n");
process.exit(0);
`);

let server: any;
let base: string;
let token: string;
const marksFile = join(root, "marks.jsonl");

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${base}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) },
  });

beforeAll(async () => {
  process.env.NIRVANA_SERVE_DIR = join(root, "serve");
  process.env.NIRVANA_SERVE_SESSIONS_ROOT = join(root, "sessions");
  process.env.NIRVANA_SERVE_DISPATCH_BIN = dispatchFixture;
  process.env.NIRVANA_RUN_LEDGER_DB = join(root, "ledger.sqlite");
  process.env.FIXTURE_MARKS = marksFile;
  mkdirSync(join(root, "serve"), { recursive: true });
  writeFileSync(marksFile, "");

  const { keygen } = await import("../lib/serve/auth.ts");
  const { startServer } = await import("../lib/serve/server.ts");
  token = keygen({ label: "queue-test" }).token;
  server = startServer({ port: 0, host: "127.0.0.1", maxConcurrent: 2 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop(); } catch { /* already down */ }
  // Windows holds the ledger's sqlite handle a beat longer than the test
  // ends, and rm on a busy file throws EBUSY — failing a suite that already
  // passed. The temp dir is the OS's to reclaim; cleanup is a courtesy, not
  // an assertion.
  try { rmSync(root, { recursive: true, force: true }); } catch { /* OS will reclaim tmp */ }
});

async function waitTerminal(sessionId: string, traceId: string, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const env = await (await api(`/v1/sessions/${sessionId}/runs/${traceId}`)).json();
    if (env.state !== "queued" && env.state !== "running") return env;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timeout waiting for terminal state");
}

describe("queue", () => {
  test("two briefs on the SAME session never overlap", async () => {
    const { session_id } = await (await api("/v1/sessions", { method: "POST" })).json();
    const a = await (await api(`/v1/sessions/${session_id}/briefs`, { method: "POST", body: JSON.stringify({ brief: "primeiro" }) })).json();
    const b = await (await api(`/v1/sessions/${session_id}/briefs`, { method: "POST", body: JSON.stringify({ brief: "segundo" }) })).json();

    await waitTerminal(session_id, a.trace_id);
    await waitTerminal(session_id, b.trace_id);

    const marks = (await Bun.file(marksFile).text()).trim().split("\n").map((l) => JSON.parse(l));
    const span = (t: string) => {
      const s = marks.find((m) => m.trace === t && m.phase === "start")!.at;
      const e = marks.find((m) => m.trace === t && m.phase === "end")!.at;
      return [s, e];
    };
    const [aStart, aEnd] = span(a.trace_id);
    const [bStart] = span(b.trace_id);
    // second starts only after the first finished — serialization proved
    expect(bStart).toBeGreaterThanOrEqual(aEnd - 5);
    expect(aStart).toBeLessThan(bStart);
  }, spawnBudgetMs(2));

  test("different sessions DO run in parallel under the cap", async () => {
    writeFileSync(marksFile, "");
    const s1 = await (await api("/v1/sessions", { method: "POST" })).json();
    const s2 = await (await api("/v1/sessions", { method: "POST" })).json();
    const r1 = await (await api(`/v1/sessions/${s1.session_id}/briefs`, { method: "POST", body: JSON.stringify({ brief: "sessão 1" }) })).json();
    const r2 = await (await api(`/v1/sessions/${s2.session_id}/briefs`, { method: "POST", body: JSON.stringify({ brief: "sessão 2" }) })).json();

    await waitTerminal(s1.session_id, r1.trace_id);
    await waitTerminal(s2.session_id, r2.trace_id);

    const marks = (await Bun.file(marksFile).text()).trim().split("\n").map((l) => JSON.parse(l));
    const starts = marks.filter((m) => m.phase === "start").map((m) => m.at).sort();
    const ends = marks.filter((m) => m.phase === "end").map((m) => m.at).sort();
    // the second run started before the first one ended — real overlap
    expect(starts[1]).toBeLessThan(ends[1]);
  }, spawnBudgetMs(2));
});

describe("SSE", () => {
  test("streams the run's audit events and closes when the run finishes", async () => {
    const { session_id } = await (await api("/v1/sessions", { method: "POST" })).json();
    const r = await (await api(`/v1/sessions/${session_id}/briefs`, { method: "POST", body: JSON.stringify({ brief: "com stream" }) })).json();

    const res = await api(`/v1/sessions/${session_id}/runs/${r.trace_id}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = "";
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;                    // stream closed by the server
      seen += dec.decode(value, { stream: true });
      if (seen.includes("run.finished")) break;
    }
    expect(seen).toContain("dispatch_squad");
    expect(seen).toContain("gate_passed");
    expect(seen).toContain("run.finished");
    // the audit file may be shared with other runs/tests — the stream must
    // carry only THIS run's events (CI caught another test's judge events
    // leaking into the feed).
    expect(seen).not.toContain("judge_invoked");
    for (const line of seen.split("\n").filter((l) => l.startsWith("data: "))) {
      const ev = JSON.parse(line.slice(6));
      if (ev.event === "run.finished") continue;
      expect(ev.trace_id ?? ev.project_id).toBe(r.trace_id);
    }
  }, spawnBudgetMs(1));

  test("a client that disconnects mid-run does not take the server down with it", async () => {
    process.env.FIXTURE_MS = "600";
    const { session_id } = await (await api("/v1/sessions", { method: "POST" })).json();
    const r = await (await api(`/v1/sessions/${session_id}/briefs`, { method: "POST", body: JSON.stringify({ brief: "desconecta cedo" }) })).json();

    const res = await api(`/v1/sessions/${session_id}/runs/${r.trace_id}/events`);
    // Cancel while the run is still in flight — this is exactly what left
    // the polling interval's next `enqueue()` throwing uncaught against a
    // dead controller before `cancel()` was wired up.
    await res.body!.cancel();

    // Several 150ms poll ticks fire against the cancelled stream before the
    // fixture even finishes (FIXTURE_MS=600 above).
    await new Promise((res2) => setTimeout(res2, 500));

    // If that throw had gone uncaught, the process would be gone and this
    // would time out or the connection would reset instead of answering.
    const health = await api("/v1/health");
    expect(health.status).toBe(200);
    delete process.env.FIXTURE_MS;
  }, spawnBudgetMs(1));
});
