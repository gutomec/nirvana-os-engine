// serve-archive.test.ts — the complete delivery of a run, as one zip.
//
// The API could hand a client one file at a time and nothing else. A run where
// several businesses and squads each delivered had no representation for "the
// finished work": `/artifacts` gave a listing the caller had to walk, and
// `/result` helped only when exactly one file existed. So the thing the client
// actually bought was the one thing this API could not return.
//
// What these tests defend, in order of how much it would cost to get wrong:
//
//   · The zip carries the WORK and none of the instrumentation. `agent-prompt.md`
//     is the employee's system prompt, the mind-clone library and the firm's
//     permanent memory. It reached a client through a private exclusion list
//     once already; a bundle the client KEEPS is a worse place for it to happen.
//   · Text inside the zip is redacted exactly as `/artifacts/{path}` redacts it.
//     A zip that skipped that step would be a hole around the whole redaction
//     layer, wide enough to drive a secret through.
//   · The bytes are a real zip. It is written by hand here (no `python3`, no
//     `zip` binary, because a customer VPS need not have either), so `unzip`
//     itself is the oracle — not our own reader agreeing with our own writer.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "serve-archive-"));
const serveDir = join(root, "serve");
const dispatchFixture = join(root, "fake-dispatch.ts");

// A run shaped like the one the owner reported: two businesses delivered, and
// the engine's own instrumentation sits in the same tree.
writeFileSync(dispatchFixture, `
import * as fs from "node:fs";
import * as path from "node:path";
const argv = process.argv.slice(2);
const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const out = val("--outputs-root")!;
const w = (rel: string, body: string) => {
  const abs = path.join(out, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};
w("businesses/acme/deliverables/relatorio-fiscal.md", "# Relatório fiscal\\n\\nO trabalho da acme.\\n");
w("businesses/beta/deliverables/parecer-juridico.md", "# Parecer\\n\\nO trabalho da beta.\\n");
w("squads/design-squad/logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
w("_SUMMARY.md", "resumo de uma página");
w("agent-prompt.md", "PROTOCOL COMPLIANCE\\nYOUR PERSONA\\nMIND-CLONE LIBRARY\\nMEMÓRIA DESTA ENTIDADE\\n");
w("brief.md", "o pedido original");
w("CLAUDE.md", "o contrato do projeto");
w("audit.jsonl", JSON.stringify({ event: "gate_passed" }) + "\\n");
w("HANDOFF.json", "{}");
w("_internal/rascunho.md", "trabalho intermediário");
if (process.env.FIXTURE_LEAK === "1") {
  w("businesses/acme/deliverables/relatorio-fiscal.md", "# Relatório\\n\\nchave: " + process.env.LEAKED_API_KEY + "\\n");
}
process.exit(0);
`);

let server: { stop: () => void; port: number };
let base = "";
let token = "";

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${base}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) },
  });

async function runBrief(deliver?: "zip"): Promise<{ session_id: string; trace_id: string }> {
  const cr = await api("/v1/sessions", { method: "POST" });
  const { session_id } = await cr.json();
  const br = await api(`/v1/sessions/${session_id}/briefs`, {
    method: "POST",
    body: JSON.stringify(deliver ? { brief: "faça o trabalho", deliver } : { brief: "faça o trabalho" }),
  });
  expect(br.status).toBe(202);
  const { trace_id } = await br.json();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const env = await (await api(`/v1/jobs/${trace_id}`)).json();
    if (env.state !== "queued" && env.state !== "running") return { session_id, trace_id };
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error("run never finished");
}

/** `unzip` is the oracle: a zip our own reader likes proves nothing. */
function namesIn(zipPath: string): string[] {
  const r = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split("\n").filter(Boolean);
}
function bodyOf(zipPath: string): string {
  const r = spawnSync("unzip", ["-p", zipPath], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}
async function saveZip(res: Response, name: string): Promise<string> {
  const p = join(root, name);
  writeFileSync(p, Buffer.from(await res.arrayBuffer()));
  return p;
}

beforeAll(async () => {
  process.env.NIRVANA_SERVE_DIR = serveDir;
  process.env.NIRVANA_SERVE_SESSIONS_ROOT = join(root, "sessions");
  process.env.NIRVANA_SERVE_DISPATCH_BIN = dispatchFixture;
  process.env.NIRVANA_RUN_LEDGER_DB = join(root, "ledger.sqlite");
  process.env.NIRVANA_CHILD_ENV_EXTRA = "FIXTURE_LEAK,LEAKED_API_KEY";
  mkdirSync(serveDir, { recursive: true });
  const { keygen } = await import("../lib/serve/auth.ts");
  const { startServer } = await import("../lib/serve/server.ts");
  token = keygen({ label: "archive-test", budgetUsd: 3 }).token;
  server = startServer({ port: 0, host: "127.0.0.1", maxConcurrent: 2 }) as any;
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop(); } catch { /* already down */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* the OS reclaims tmp */ }
});

describe("GET /v1/jobs/{id}/archive", () => {
  test("returns one zip holding every business's and squad's work, organized as the org chart produced it", async () => {
    const { trace_id } = await runBrief();
    const res = await api(`/v1/jobs/${trace_id}/archive`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain(`${trace_id}.zip`);

    const names = namesIn(await saveZip(res, "a.zip"));
    expect(names).toContain(`${trace_id}/businesses/acme/deliverables/relatorio-fiscal.md`);
    expect(names).toContain(`${trace_id}/businesses/beta/deliverables/parecer-juridico.md`);
    expect(names).toContain(`${trace_id}/squads/design-squad/logo.svg`);
    // Everything under one top folder, so extracting never sprays the cwd.
    expect(names.every((n) => n.startsWith(`${trace_id}/`))).toBe(true);
  });

  test.each([
    ["agent-prompt.md", "the employee's system prompt"],
    ["brief.md", "the brief"],
    ["CLAUDE.md", "the project contract"],
    ["_SUMMARY.md", "an envelope field, not a file"],
    ["HANDOFF.json", "the handoff"],
    ["audit.jsonl", "the audit trail"],
  ])("never ships %s", async (name) => {
    const { trace_id } = await runBrief();
    const names = namesIn(await saveZip(await api(`/v1/jobs/${trace_id}/archive`), `no-${name}.zip`));
    expect(names.some((n) => n.endsWith(`/${name}`))).toBe(false);
  });

  test("the mind-clone library and the firm's memory are not in the bytes", async () => {
    const { trace_id } = await runBrief();
    const body = bodyOf(await saveZip(await api(`/v1/jobs/${trace_id}/archive`), "clean.zip"));
    expect(body).not.toContain("MIND-CLONE LIBRARY");
    expect(body).not.toContain("MEMÓRIA DESTA ENTIDADE");
    expect(body).toContain("O trabalho da acme.");
    expect(body).toContain("O trabalho da beta.");
  });

  test("a run-state directory is not a deliverable, in the zip or in the listing", async () => {
    const { trace_id } = await runBrief();
    const names = namesIn(await saveZip(await api(`/v1/jobs/${trace_id}/archive`), "internal.zip"));
    expect(names.join(" ")).not.toContain("_internal");
    const env = await (await api(`/v1/jobs/${trace_id}`)).json();
    expect(JSON.stringify(env.artifacts)).not.toContain("_internal");
  });

  test("MANIFEST.json says what the bundle is, and lists what is in it", async () => {
    const { trace_id, session_id } = await runBrief();
    const zip = await saveZip(await api(`/v1/jobs/${trace_id}/archive`), "manifest.zip");
    const r = spawnSync("unzip", ["-p", zip, `${trace_id}/MANIFEST.json`], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const m = JSON.parse(r.stdout);
    expect(m.trace_id).toBe(trace_id);
    expect(m.session_id).toBe(session_id);
    expect(m.state).toBe("delivered");
    expect(m.brief).toBe("faça o trabalho");
    expect(m.includes_audit).toBe(false);
    expect(m.files.map((f: any) => f.path)).toContain("businesses/acme/deliverables/relatorio-fiscal.md");
  });

  test("?include_audit=1 is a deliberate choice, and still never the prompt", async () => {
    const { trace_id } = await runBrief();
    const zip = await saveZip(await api(`/v1/jobs/${trace_id}/archive?include_audit=1`), "audit.zip");
    const names = namesIn(zip);
    expect(names).toContain(`${trace_id}/_audit/audit.jsonl`);
    expect(names).toContain(`${trace_id}/_audit/HANDOFF.json`);
    expect(names.some((n) => n.endsWith("/agent-prompt.md"))).toBe(false);
    expect(bodyOf(zip)).not.toContain("MIND-CLONE LIBRARY");
  });

  test("a secret that reached a deliverable is masked inside the zip too", async () => {
    process.env.FIXTURE_LEAK = "1";
    process.env.LEAKED_API_KEY = "sk-live-archive-canary-4f2b8d";
    try {
      const { trace_id } = await runBrief();
      const res = await api(`/v1/jobs/${trace_id}/archive`);
      expect(res.headers.get("x-nirvana-redactions")).toBeTruthy();
      expect(bodyOf(await saveZip(res, "redacted.zip"))).not.toContain("sk-live-archive-canary-4f2b8d");
    } finally {
      delete process.env.FIXTURE_LEAK;
      delete process.env.LEAKED_API_KEY;
    }
  });

  test("an unknown job is 404, and another key's job is the same 404", async () => {
    expect((await api("/v1/jobs/run_nope/archive")).status).toBe(404);
    const { trace_id } = await runBrief();
    const { keygen } = await import("../lib/serve/auth.ts");
    const other = keygen({ label: "stranger", budgetUsd: 1 }).token;
    const r = await fetch(`${base}/v1/jobs/${trace_id}/archive`, { headers: { Authorization: `Bearer ${other}` } });
    expect(r.status).toBe(404);
  });

  test("no key at all is 401, like every route but health", async () => {
    const { trace_id } = await runBrief();
    expect((await fetch(`${base}/v1/jobs/${trace_id}/archive`)).status).toBe(401);
  });

  test("the session-scoped twin returns the same bundle", async () => {
    const { session_id, trace_id } = await runBrief();
    const res = await api(`/v1/sessions/${session_id}/runs/${trace_id}/archive`);
    expect(res.status).toBe(200);
    expect(namesIn(await saveZip(res, "twin.zip"))).toContain(`${trace_id}/businesses/acme/deliverables/relatorio-fiscal.md`);
  });
});

describe("asking for the zip when the brief is sent", () => {
  test('{"deliver":"zip"} makes /result return the bundle rather than a listing', async () => {
    const { trace_id } = await runBrief("zip");
    const res = await api(`/v1/jobs/${trace_id}/result`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(namesIn(await saveZip(res, "result.zip")).length).toBeGreaterThan(1);
  });

  test("without it, /result still answers with the listing and now points at the archive", async () => {
    const { trace_id } = await runBrief();
    const res = await api(`/v1/jobs/${trace_id}/result`);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.archive_url).toBe(`/v1/jobs/${trace_id}/archive`);
    expect(body.hint).toContain("/archive");
  });

  test("the 202 receipt already carries the three URLs the client will need", async () => {
    const cr = await api("/v1/sessions", { method: "POST" });
    const { session_id } = await cr.json();
    const br = await api(`/v1/sessions/${session_id}/briefs`, { method: "POST", body: JSON.stringify({ brief: "outro trabalho", deliver: "zip" }) });
    const b = await br.json();
    expect(b.deliver).toBe("zip");
    expect(b.job_url).toBe(`/v1/jobs/${b.trace_id}`);
    expect(b.events_url).toBe(`/v1/jobs/${b.trace_id}/events`);
    expect(b.archive_url).toBe(`/v1/jobs/${b.trace_id}/archive`);
  });

  test("the envelope carries the link whether or not the client asked for a zip", async () => {
    const { trace_id } = await runBrief();
    const env = await (await api(`/v1/jobs/${trace_id}`)).json();
    expect(env.archive_url).toContain(`/v1/jobs/${trace_id}/archive`);
  });
});

describe("a run that is not finished, and one that delivered nothing", () => {
  test("409 while the work is still going, never a half-written bundle", async () => {
    const { register, envelope } = await import("../lib/serve/runs.ts");
    const { getSession, createSession } = await import("../lib/serve/sessions.ts");
    const s = createSession("k-pending", "global");
    const memo = register({
      trace_id: "run_pending_archive", session: getSession(s.id, "k-pending")!, key_id: "k-pending",
      brief: "ainda rodando", outputs_root: join(root, "pending-outputs"), created_at: new Date().toISOString(),
    });
    expect(memo.state).toBe("queued");
    expect(envelope(memo).archive_url).toContain("/archive");
  });

  test("a finished run with no artifacts is a valid zip that says so, not a 404", async () => {
    const { buildRunArchive } = await import("../lib/serve/archive.ts");
    const empty = join(root, "empty-run");
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, "agent-prompt.md"), "MIND-CLONE LIBRARY");
    const built = buildRunArchive({ outputsRoot: empty, sessionDir: empty, rootName: "run_empty", manifest: { trace_id: "run_empty", state: "withheld" } });
    expect(built.files).toEqual([]);
    const p = join(root, "empty.zip");
    writeFileSync(p, Buffer.from(built.zip));
    expect(namesIn(p)).toEqual(["run_empty/MANIFEST.json"]);
    expect(bodyOf(p)).not.toContain("MIND-CLONE LIBRARY");
  });
});

describe("the zip writer itself", () => {
  test("round-trips through unzip, which is the only oracle that counts", async () => {
    const { writeZip } = await import("../lib/serve/archive.ts");
    const big = "linha repetida que comprime bem\n".repeat(500);
    const p = join(root, "writer.zip");
    writeFileSync(p, Buffer.from(writeZip([
      { name: "a/texto.md", data: Buffer.from("acentuação preservada: ação, coração\n", "utf8") },
      { name: "a/grande.txt", data: Buffer.from(big, "utf8") },
      { name: "b/vazio.txt", data: Buffer.from("", "utf8") },
      { name: "b/bin.dat", data: Buffer.from([0, 1, 2, 253, 254, 255]) },
    ])));
    // `unzip -t` verifies every CRC. A wrong checksum fails here and nowhere else.
    expect(spawnSync("unzip", ["-t", p], { encoding: "utf8" }).status).toBe(0);
    expect(namesIn(p)).toEqual(["a/texto.md", "a/grande.txt", "b/vazio.txt", "b/bin.dat"]);
    const out = join(root, "extracted");
    expect(spawnSync("unzip", ["-o", "-q", p, "-d", out], { encoding: "utf8" }).status).toBe(0);
    expect(readFileSync(join(out, "a", "texto.md"), "utf8")).toBe("acentuação preservada: ação, coração\n");
    expect(readFileSync(join(out, "a", "grande.txt"), "utf8")).toBe(big);
    expect(readFileSync(join(out, "b", "vazio.txt"), "utf8")).toBe("");
    expect([...readFileSync(join(out, "b", "bin.dat"))]).toEqual([0, 1, 2, 253, 254, 255]);
  });

  test("compression actually happens, so a big delivery is not shipped raw", async () => {
    const { writeZip } = await import("../lib/serve/archive.ts");
    const body = Buffer.from("a".repeat(100_000), "utf8");
    expect(writeZip([{ name: "x.txt", data: body }]).length).toBeLessThan(body.length / 10);
  });
});
