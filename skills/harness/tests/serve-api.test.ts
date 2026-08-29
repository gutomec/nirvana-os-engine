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
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

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
  process.env.NIRVANA_SERVE_WEBHOOK_SWEEP_MS = "30";
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
  // Windows holds the ledger's sqlite handle a beat longer than the test
  // ends, and rm on a busy file throws EBUSY — failing a suite that already
  // passed. The temp dir is the OS's to reclaim; cleanup is a courtesy, not
  // an assertion.
  try { rmSync(root, { recursive: true, force: true }); } catch { /* OS will reclaim tmp */ }
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

describe("library scope", () => {
  test("a session defaults to the operator's global library", async () => {
    const r = await api("/v1/sessions", { method: "POST" });
    const body = await r.json();
    expect(body.library).toBe("global");
  });

  test("an isolated session is honoured and its runs scope to the project only", async () => {
    const r = await api("/v1/sessions", { method: "POST", body: JSON.stringify({ library: "isolated" }) });
    const { session_id, library } = await r.json();
    expect(library).toBe("isolated");
    const listed = await (await api("/v1/sessions")).json();
    expect(listed.sessions.find((s: any) => s.session_id === session_id).library).toBe("isolated");
  });

  test("a global session writes NIRVANA_SCOPE=merge — the library is never project by default", async () => {
    const r = await api("/v1/sessions", { method: "POST" });
    const { session_id } = await r.json();
    const env = readFileSync(join(root, "sessions", session_id, ".env"), "utf8");
    // The source of intelligence resolves globally; a session that starts
    // blind would route every brief to the generalist.
    expect(env).toContain("NIRVANA_SCOPE=merge");
    expect(env).not.toContain("NIRVANA_SCOPE=project");
  });

  test("an isolated session is the only one scoped to the project itself", async () => {
    const r = await api("/v1/sessions", { method: "POST", body: JSON.stringify({ library: "isolated" }) });
    const { session_id } = await r.json();
    const env = readFileSync(join(root, "sessions", session_id, ".env"), "utf8");
    expect(env).toContain("NIRVANA_SCOPE=project");
  });

  test("files are written inside the session regardless of where the library comes from", async () => {
    process.env.FIXTURE_EXIT = "0";
    const { session_id } = await (await api("/v1/sessions", { method: "POST" })).json();
    const { trace_id } = await (await api(`/v1/sessions/${session_id}/briefs`, {
      method: "POST", body: JSON.stringify({ brief: "onde os arquivos nascem" }),
    })).json();
    await waitTerminal(session_id, trace_id);
    // outputs under the session, never in a shared root
    const artifact = join(root, "sessions", session_id, ".nirvana", "outputs", trace_id, "deliverable.md");
    expect(readFileSync(artifact, "utf8")).toContain("conteúdo real");
  });

  test("an unknown library value falls back to global rather than failing the call", async () => {
    const r = await api("/v1/sessions", { method: "POST", body: JSON.stringify({ library: "whatever" }) });
    expect((await r.json()).library).toBe("global");
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

describe("jobs — session-agnostic, the polling floor", () => {
  test("proves the polling floor: submit, never listen, retrieve the terminal state afterwards", async () => {
    process.env.FIXTURE_EXIT = "0";
    const { session_id } = await (await api("/v1/sessions", { method: "POST" })).json();
    const { trace_id } = await (await api(`/v1/sessions/${session_id}/briefs`, {
      method: "POST", body: JSON.stringify({ brief: "nunca escutei o SSE" }),
    })).json();
    // No /events call anywhere in this test — only polling, the mechanism
    // that does not depend on connectivity between updates.
    const deadline = Date.now() + 15000;
    let env: any;
    while (Date.now() < deadline) {
      env = await (await api(`/v1/jobs/${trace_id}`)).json();
      if (env.state !== "queued" && env.state !== "running") break;
      await new Promise((r) => setTimeout(r, 120));
    }
    expect(env.state).toBe("delivered");
    expect(env.trace_id).toBe(trace_id);
    expect(env.artifacts.some((a: any) => a.path === "deliverable.md")).toBe(true);

    // The fixture writes two files (deliverable.md + _SUMMARY.md), so /result
    // answers with the listing and a pointer to the by-path route rather than
    // guessing which one is "the" artifact.
    const result = await api(`/v1/jobs/${trace_id}/result`);
    expect(result.status).toBe(200);
    const resultBody = await result.json();
    expect(resultBody.artifacts.some((a: any) => a.path === "deliverable.md")).toBe(true);

    const download = await api(`/v1/jobs/${trace_id}/artifacts/deliverable.md`);
    expect(await download.text()).toContain("conteúdo real");
  });

  test("a job belongs to the key that created it — another key gets job_not_found, never someone else's case", async () => {
    process.env.FIXTURE_EXIT = "0";
    const { session_id } = await (await api("/v1/sessions", { method: "POST" })).json();
    const { trace_id } = await (await api(`/v1/sessions/${session_id}/briefs`, {
      method: "POST", body: JSON.stringify({ brief: "caso privado" }),
    })).json();

    const { keygen } = await import("../lib/serve/auth.ts");
    const other = keygen({ label: "intruder-jobs" });
    const r = await fetch(`${base}/v1/jobs/${trace_id}`, { headers: { Authorization: `Bearer ${other.token}` } });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("job_not_found");
  });

  test("an unknown job id is not found", async () => {
    const r = await api("/v1/jobs/run_does_not_exist");
    expect(r.status).toBe(404);
  });

  test("result on a still-running job is a conflict, not a partial answer", async () => {
    process.env.FIXTURE_EXIT = "0";
    const { session_id } = await (await api("/v1/sessions", { method: "POST" })).json();
    const { trace_id } = await (await api(`/v1/sessions/${session_id}/briefs`, {
      method: "POST", body: JSON.stringify({ brief: "ainda rodando" }),
    })).json();
    // The fixture is fast, so this is a best-effort race — assert the
    // CONTRACT (409 while non-terminal) rather than depend on timing when it
    // happens to still be queued/running.
    const r = await api(`/v1/jobs/${trace_id}/result`);
    if (r.status === 409) {
      expect((await r.json()).error).toBe("job_not_finished");
    } else {
      expect(r.status).toBe(200);
    }
  });

  test("events by job id streams the same feed as events by session+run", async () => {
    process.env.FIXTURE_EXIT = "0";
    const { session_id } = await (await api("/v1/sessions", { method: "POST" })).json();
    const { trace_id } = await (await api(`/v1/sessions/${session_id}/briefs`, {
      method: "POST", body: JSON.stringify({ brief: "stream por job id" }),
    })).json();
    const res = await api(`/v1/jobs/${trace_id}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });
});

describe("webhook delivery — signed, timed, idempotent, referenced not embedded", () => {
  test("the delivered request verifies, carries a stable delivery id, and never embeds the summary by value", async () => {
    const received: { body: string; headers: Record<string, string> }[] = [];
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
      const reg = await api("/v1/webhooks", {
        method: "POST",
        body: JSON.stringify({ url: `http://127.0.0.1:${receiver.port}/hook` }),
      });
      const { secret } = await reg.json();

      process.env.FIXTURE_EXIT = "0";
      const { session_id } = await (await api("/v1/sessions", { method: "POST" })).json();
      const { trace_id } = await (await api(`/v1/sessions/${session_id}/briefs`, {
        method: "POST", body: JSON.stringify({ brief: "caso com webhook" }),
      })).json();

      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && received.length === 0) await new Promise((r) => setTimeout(r, 50));
      expect(received.length).toBeGreaterThan(0);

      const delivery = received[0];
      const { verifyWebhook } = await import("../lib/serve/webhooks.ts");
      const verdict = verifyWebhook({
        body: delivery.body,
        signature: delivery.headers["x-nirvana-signature"],
        timestamp: delivery.headers["x-nirvana-timestamp"],
        secret,
      });
      expect(verdict.valid).toBe(true);
      expect(delivery.headers["x-nirvana-delivery-id"]).toBeTruthy();

      const payload = JSON.parse(delivery.body);
      expect(payload.trace_id).toBe(trace_id);
      expect(payload.state).toBe("delivered");
      expect(payload.job_url).toContain(`/v1/jobs/${trace_id}`);
      // Payload by reference, never by value: the summary text must not
      // travel inside the webhook body — a legal case is sensitive.
      expect(delivery.body).not.toContain("resumo de uma p");
      expect(payload.summary).toBeUndefined();
      expect(payload.artifacts).toBeUndefined();
    } finally {
      receiver.stop(true);
    }
  }, spawnBudgetMs(1));
});
