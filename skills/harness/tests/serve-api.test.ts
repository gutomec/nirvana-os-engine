// serve-api.test.ts — the HTTP control plane, end to end, without spending
// a cent: NIRVANA_SERVE_DISPATCH_BIN points at a fixture that writes
// artifacts and exits with the code the case is about, so the exit-contract
// mapping (0 delivered · 2 withheld · 3 indeterminate · other failed) is
// exercised for real while the LLM never runs.
//
// What these tests defend: money and limits belong to the KEY (a client that
// asks for a bigger budget must be ignored), a session belongs to ONE key,
// an artifact path that escapes the outputs root is refused rather than
// served, and the queue never runs two briefs of the same session at once.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "serve-api-"));
const serveDir = join(root, "serve");
const dispatchFixture = join(root, "fake-dispatch.ts");

// The fixture stands in for `nrv dispatch --exec`: it honours --outputs-root,
// writes the files the case needs, and exits with EXIT_CODE.
writeFileSync(dispatchFixture, `
import * as fs from "node:fs";
import * as path from "node:path";
const argv = process.argv.slice(2);
const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const out = val("--outputs-root")!;
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "deliverable.md"), "# entrega\\n\\nconteúdo real do artefato.\\n");
fs.writeFileSync(path.join(out, "_SUMMARY.md"), "resumo de uma página");
if (process.env.FIXTURE_RESERVATIONS === "1") {
  fs.writeFileSync(path.join(out, "_QA-RESERVATIONS.md"), "gate ainda aponta: hifenização");
}
if (process.env.FIXTURE_BUDGET_ECHO === "1") {
  fs.writeFileSync(path.join(out, "budget.txt"), String(val("--max-budget")));
}
process.exit(parseInt(process.env.FIXTURE_EXIT || "0", 10));
`);

let server: { stop: () => void; port: number };
let base: string;
let token: string;
let keyId: string;

async function api(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
}

/** Polls the envelope until the run leaves the queued/running states. */
async function waitTerminal(sessionId: string, traceId: string, ms = 15000): Promise<any> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await api(`/v1/sessions/${sessionId}/runs/${traceId}`);
    const env = await r.json();
    if (env.state !== "queued" && env.state !== "running") return env;
    await new Promise((res) => setTimeout(res, 120));
  }
  throw new Error("run did not reach a terminal state in time");
}

beforeAll(async () => {
  process.env.NIRVANA_SERVE_DIR = serveDir;
  process.env.NIRVANA_SERVE_SESSIONS_ROOT = join(root, "sessions");
  process.env.NIRVANA_SERVE_DISPATCH_BIN = dispatchFixture;
  process.env.NIRVANA_RUN_LEDGER_DB = join(root, "ledger.sqlite");
  mkdirSync(serveDir, { recursive: true });

  const { keygen } = await import("../lib/serve/auth.ts");
  const { startServer } = await import("../lib/serve/server.ts");
  const gen = keygen({ label: "test", budgetUsd: 3 });
  token = gen.token;
  keyId = gen.record.id;
  server = startServer({ port: 0, host: "127.0.0.1", maxConcurrent: 2 }) as any;
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop(); } catch { /* already down */ }
  rmSync(root, { recursive: true, force: true });
});

describe("auth", () => {
  test("health needs no key; everything else does", async () => {
    const h = await api("/v1/health", {}, false);
    expect(h.status).toBe(200);
    const body = await h.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.runtimes)).toBe(true);

    const s = await api("/v1/sessions", { method: "POST" }, false);
    expect(s.status).toBe(401);
  });

  test("a wrong token is rejected", async () => {
    const r = await fetch(`${base}/v1/sessions`, { method: "POST", headers: { Authorization: "Bearer nrv_wrong" } });
    expect(r.status).toBe(401);
  });
});

describe("sessions and briefs", () => {
  test("a brief runs and the envelope carries gate, summary and artifacts", async () => {
    process.env.FIXTURE_EXIT = "0";
    const cr = await api("/v1/sessions", { method: "POST" });
    expect(cr.status).toBe(201);
    const { session_id } = await cr.json();

    const br = await api(`/v1/sessions/${session_id}/briefs`, {
      method: "POST",
      body: JSON.stringify({ brief: "escreva a nota de teste" }),
    });
    expect(br.status).toBe(202);
    const { trace_id, state } = await br.json();
    expect(state).toBe("queued");

    const env = await waitTerminal(session_id, trace_id);
    expect(env.state).toBe("delivered");
    expect(env.gate).toBe("pass");
    expect(env.summary).toContain("resumo");
    expect(env.artifacts.some((a: any) => a.path === "deliverable.md")).toBe(true);
    // the brief file the server wrote for the child is not an artifact
    expect(env.artifacts.some((a: any) => a.path === ".brief.md")).toBe(false);
  });

  test("an empty brief is a 400, not a run", async () => {
    const { session_id } = await (await api("/v1/sessions", { method: "POST" })).json();
    const r = await api(`/v1/sessions/${session_id}/briefs`, { method: "POST", body: JSON.stringify({ brief: "   " }) });
    expect(r.status).toBe(400);
  });

  test("a session belongs to one key — another key gets 404, never someone else's run", async () => {
    const { session_id } = await (await api("/v1/sessions", { method: "POST" })).json();
    const { keygen } = await import("../lib/serve/auth.ts");
    const other = keygen({ label: "intruder" });
    const r = await fetch(`${base}/v1/sessions/${session_id}/briefs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${other.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ brief: "roubar contexto" }),
    });
    expect(r.status).toBe(404);
  });
});

describe("the exit contract maps to the envelope", () => {
  test("exit 2 → withheld with gate fail; exit 3 → indeterminate", async () => {
    const { session_id } = await (await api("/v1/sessions", { method: "POST" })).json();

    process.env.FIXTURE_EXIT = "2";
    const w = await (await api(`/v1/sessions/${session_id}/briefs`, { method: "POST", body: JSON.stringify({ brief: "retido" }) })).json();
    const wEnv = await waitTerminal(session_id, w.trace_id);
    expect(wEnv.state).toBe("withheld");
    expect(wEnv.gate).toBe("fail");

    process.env.FIXTURE_EXIT = "3";
    const i = await (await api(`/v1/sessions/${session_id}/briefs`, { method: "POST", body: JSON.stringify({ brief: "indeterminado" }) })).json();
    const iEnv = await waitTerminal(session_id, i.trace_id);
    expect(iEnv.state).toBe("indeterminate");
    expect(iEnv.gate).toBe("indeterminate");
  });

  test("reservations promote the verdict to fail-accepted and travel in the envelope", async () => {
    const { session_id } = await (await api("/v1/sessions", { method: "POST" })).json();
    process.env.FIXTURE_EXIT = "0";
    process.env.FIXTURE_RESERVATIONS = "1";
    const r = await (await api(`/v1/sessions/${session_id}/briefs`, { method: "POST", body: JSON.stringify({ brief: "com ressalvas" }) })).json();
    const env = await waitTerminal(session_id, r.trace_id);
    delete process.env.FIXTURE_RESERVATIONS;
    expect(env.state).toBe("delivered");
    expect(env.gate).toBe("fail-accepted");
    expect(env.reservations).toContain("gate ainda aponta");
  });
});

describe("money and limits belong to the key", () => {
  test("the key's budget reaches the dispatch; a client-supplied budget is ignored", async () => {
    const { session_id } = await (await api("/v1/sessions", { method: "POST" })).json();
    process.env.FIXTURE_EXIT = "0";
    process.env.FIXTURE_BUDGET_ECHO = "1";
    const r = await (await api(`/v1/sessions/${session_id}/briefs`, {
      method: "POST",
      // a caller trying to raise its own ceiling — must have no effect
      body: JSON.stringify({ brief: "orçamento", max_budget: 999, budget_usd: 999 }),
    })).json();
    const env = await waitTerminal(session_id, r.trace_id);
    delete process.env.FIXTURE_BUDGET_ECHO;
    const dl = await api(`/v1/sessions/${session_id}/runs/${r.trace_id}/artifacts/budget.txt`);
    expect(await dl.text()).toBe("3"); // the KEY's budget, not the client's 999
    expect(env.state).toBe("delivered");
  });

  test("the daily quota returns 429 once spent", async () => {
    const { keygen } = await import("../lib/serve/auth.ts");
    const limited = keygen({ label: "one-shot", dailyRuns: 1 });
    const sess = await (await fetch(`${base}/v1/sessions`, { method: "POST", headers: { Authorization: `Bearer ${limited.token}` } })).json();
    const post = () => fetch(`${base}/v1/sessions/${sess.session_id}/briefs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${limited.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ brief: "consumindo a cota" }),
    });
    process.env.FIXTURE_EXIT = "0";
    expect((await post()).status).toBe(202);
    const second = await post();
    expect(second.status).toBe(429);
    expect((await second.json()).error).toBe("daily_quota_exceeded");
  });
});

describe("artifact paths are a boundary, not a suggestion", () => {
  test("traversal is refused, real files are served", async () => {
    const { session_id } = await (await api("/v1/sessions", { method: "POST" })).json();
    process.env.FIXTURE_EXIT = "0";
    const r = await (await api(`/v1/sessions/${session_id}/briefs`, { method: "POST", body: JSON.stringify({ brief: "artefatos" }) })).json();
    await waitTerminal(session_id, r.trace_id);

    const ok = await api(`/v1/sessions/${session_id}/runs/${r.trace_id}/artifacts/deliverable.md`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("conteúdo real");

    for (const evil of ["../../../../etc/passwd", "..%2f..%2f..%2fetc%2fpasswd", "%2e%2e%2f%2e%2e%2fkeys.json"]) {
      const bad = await api(`/v1/sessions/${session_id}/runs/${r.trace_id}/artifacts/${evil}`);
      expect(bad.status).toBe(404);
    }
  });
});

describe("webhooks", () => {
  test("registration returns a secret and the signature is verifiable", async () => {
    const r = await api("/v1/webhooks", { method: "POST", body: JSON.stringify({ url: "https://example.com/hook" }) });
    expect(r.status).toBe(201);
    const { secret, signature_header } = await r.json();
    expect(secret.length).toBeGreaterThan(20);
    expect(signature_header).toBe("X-Nirvana-Signature");

    const { sign } = await import("../lib/serve/webhooks.ts");
    const body = JSON.stringify({ event: "run.finished" });
    expect(sign(body, secret)).toBe(sign(body, secret));
    expect(sign(body, secret)).not.toBe(sign(body, "outro-segredo"));
  });

  test("a non-http url is refused", async () => {
    const r = await api("/v1/webhooks", { method: "POST", body: JSON.stringify({ url: "file:///etc/passwd" }) });
    expect(r.status).toBe(400);
  });
});
