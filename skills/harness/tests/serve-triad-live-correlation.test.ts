// serve-triad-live-correlation.test.ts — proves the three `nrv serve` event
// transports on ONE real run, at the same time, correlated by the same
// trace_id.
//
// Each transport already has isolated proof: serve-webhook-delivery.test.ts
// signs/verifies as pure functions (no server), serve-api.test.ts drives the
// webhook and the polling floor (`/v1/jobs/*`) end to end but never listens
// to SSE, and serve-queue-sse.test.ts streams SSE for a run that has no
// webhook registered. None of the three ever ran together on the same run —
// so a regression that broke correlation between transports (the webhook
// firing for a DIFFERENT run than the SSE stream, or the run_id drifting
// between the live feed and the terminal envelope) had no test that would
// catch it.
//
// This test drives all three against one dispatch: a webhook receiver is a
// REAL local HTTP server (never a mock of the delivery function), the SSE
// subscription opens WHILE the run is still in flight and must observe an
// intermediate audit event before the terminal one (proving "live", not
// "state polled after the fact"), and the run is also polled by trace_id —
// then every transport's view of the run is checked against the same
// trace_id, and the webhook's HMAC signature is verified with the shared
// `verifyWebhook` from webhooks.ts (never reimplemented here).
//
// Out of scope, by design: the real Glance cockpit (the HTML view). Glance's
// live feed consumes the exact same `/v1/.../events` SSE endpoint this test
// exercises — proving the endpoint here is proving what Glance depends on;
// replicating Glance's browser client would test a different consumer of the
// same contract, not a gap in it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const root = mkdtempSync(join(tmpdir(), "serve-triad-"));
const dispatchFixture = join(root, "slow-dispatch.ts");

// Stands in for `nrv dispatch --auto --exec`: writes an intermediate audit
// event, waits (so the SSE subscriber has time to observe it before the run
// ends), writes the terminal audit event, then the deliverable, then exits 0
// — the same two-event shape serve-queue-sse.test.ts's fixture uses, so the
// SSE half of this test rests on an already-proven pattern.
writeFileSync(dispatchFixture, `
import * as fs from "node:fs";
import * as path from "node:path";
const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const out = val("--outputs-root");
const trace = val("--project");
fs.mkdirSync(out, { recursive: true });

const projectRoot = process.env.NIRVANA_PROJECT_ROOT;
const day = new Date().toISOString().slice(0, 10);
const logDir = path.join(projectRoot, ".nirvana", "logs", "harness", day);
fs.mkdirSync(logDir, { recursive: true });
fs.appendFileSync(path.join(logDir, "audit.jsonl"),
  JSON.stringify({ ts: new Date().toISOString(), event: "dispatch_squad", trace_id: trace, squad_name: "fixture-squad" }) + "\\n");

await new Promise((r) => setTimeout(r, 300));

fs.appendFileSync(path.join(logDir, "audit.jsonl"),
  JSON.stringify({ ts: new Date().toISOString(), event: "gate_passed", trace_id: trace, files: 1 }) + "\\n");
fs.writeFileSync(path.join(out, "deliverable.md"), "# entrega\\n\\nconteúdo real do artefato.\\n");
fs.writeFileSync(path.join(out, "_SUMMARY.md"), "resumo de uma página");
process.exit(0);
`);

let server: { stop: () => void; port: number };
let base: string;
let token: string;

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
  // Fast sweep — the webhook outbox is a poll loop, not a timer per
  // delivery; a 30 ms sweep keeps this test from paying the 5 s default.
  process.env.NIRVANA_SERVE_WEBHOOK_SWEEP_MS = "30";
  mkdirSync(join(root, "serve"), { recursive: true });

  const { keygen } = await import("../lib/serve/auth.ts");
  const { startServer } = await import("../lib/serve/server.ts");
  token = keygen({ label: "triad-test" }).token;
  server = startServer({ port: 0, host: "127.0.0.1", maxConcurrent: 2 }) as any;
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

describe("webhook + SSE + polling agree on one live run", () => {
  test("a real webhook receiver, a live SSE subscription and a polled envelope all correlate on the same trace_id", async () => {
    const received: { body: string; headers: Record<string, string> }[] = [];
    // A real local HTTP server — never a mock of the delivery function —
    // exactly as the brief requires for the webhook half of the proof.
    const receiver = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = await req.text();
        received.push({ body, headers: Object.fromEntries(req.headers) });
        return new Response("ok", { status: 200 });
      },
    });

    try {
      // 1) register a webhook for this key against the real receiver
      const reg = await api("/v1/webhooks", {
        method: "POST",
        body: JSON.stringify({ url: `http://127.0.0.1:${receiver.port}/hook` }),
      });
      expect(reg.status).toBe(201);
      const { secret } = await reg.json();

      // 2) start the one real run every transport below will observe
      const { session_id } = await (await api("/v1/sessions", { method: "POST" })).json();
      const { trace_id } = await (await api(`/v1/sessions/${session_id}/briefs`, {
        method: "POST",
        body: JSON.stringify({ brief: "prova tripla dos transportes" }),
      })).json();

      // 3) subscribe to SSE WHILE the run is still in flight (the fixture is
      // still sleeping its 300ms at this point) and read until the terminal
      // event, tracking whether an intermediate event arrived first — that
      // is what proves "live", as opposed to a final state fetched afterward.
      const sseRes = await api(`/v1/sessions/${session_id}/runs/${trace_id}/events`);
      expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

      const reader = sseRes.body!.getReader();
      const dec = new TextDecoder();
      let seen = "";
      let sawIntermediateBeforeTerminal = false;
      let streamClosedByServer = false;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) { streamClosedByServer = true; break; }
        seen += dec.decode(value, { stream: true });
        if (seen.includes("dispatch_squad") && !seen.includes("run.finished")) sawIntermediateBeforeTerminal = true;
        if (seen.includes("run.finished")) {
          // The server enqueues the terminal event and closes the controller
          // right after (server.ts's sseAuditStream) — the NEXT read must
          // observe that close, proving the stream ends with the run rather
          // than staying open for a client to time out on.
          const trailing = await reader.read();
          streamClosedByServer = trailing.done;
          break;
        }
      }
      expect(sawIntermediateBeforeTerminal).toBe(true);
      expect(seen).toContain("gate_passed");
      expect(seen).toContain("run.finished");
      expect(streamClosedByServer).toBe(true);

      // Every audit line on the wire belongs to THIS run — the correlation
      // key the whole test is about, checked on the SSE side first.
      for (const line of seen.split("\n").filter((l) => l.startsWith("data: "))) {
        const ev = JSON.parse(line.slice(6));
        if (ev.event === "run.finished") continue;
        expect(ev.trace_id ?? ev.project_id).toBe(trace_id);
      }

      // 4) the webhook must have delivered the terminal envelope for the
      // SAME run, signed with the secret this test's key registered.
      const wDeadline = Date.now() + 15000;
      while (Date.now() < wDeadline && received.length === 0) await new Promise((r) => setTimeout(r, 50));
      expect(received.length).toBeGreaterThan(0);
      const delivery = received[0];

      const { verifyWebhook, deliveryId } = await import("../lib/serve/webhooks.ts");
      const verdict = verifyWebhook({
        body: delivery.body,
        signature: delivery.headers["x-nirvana-signature"],
        timestamp: delivery.headers["x-nirvana-timestamp"],
        secret,
      });
      expect(verdict.valid).toBe(true);

      const payload = JSON.parse(delivery.body);
      expect(payload.trace_id).toBe(trace_id);
      expect(payload.state).toBe("delivered");
      // The idempotency key is derived from the envelope's own content
      // (webhooks.ts's `deliveryId`), not reinvented here — recomputing it
      // from the same trace_id/state and comparing is what proves the
      // webhook and the SSE stream above are talking about the SAME run,
      // not two runs that merely share a brief.
      expect(delivery.headers["x-nirvana-delivery-id"]).toBe(deliveryId({ trace_id, state: "delivered" }));

      // 5) the polling transport, on the SAME trace_id, after the fact —
      // the third leg of the triad, agreeing with both live transports.
      // Checked via both polling routes the API exposes for a run (session-
      // scoped and the session-agnostic job id) since both read the same
      // memo and must agree with each other too.
      const polled = await (await api(`/v1/sessions/${session_id}/runs/${trace_id}`)).json();
      const polledJob = await (await api(`/v1/jobs/${trace_id}`)).json();
      expect(polled.trace_id).toBe(trace_id);
      expect(polled.state).toBe("delivered");
      expect(polled.gate).toBe("pass");
      expect(polledJob.trace_id).toBe(trace_id);
      expect(polledJob.state).toBe("delivered");
    } finally {
      receiver.stop(true);
    }
  }, spawnBudgetMs(1));
});
