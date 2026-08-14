// revise-delivery.test.ts — `nrv revise` delivers through the delivery
// pipeline, fail-closed.
//
// The defect this pins: revise.ts used to hand-roll its own verify (a private
// 200-byte rule) and its own gate over .md/.txt/.json ONLY, with
// `let allPass = true` before a loop that could run zero times. A revision
// producing an .html, a PDF or an image was therefore judged by NOTHING and
// still emitted `delivered` with gate:"pass" and exit 0 — and a genuine gate
// FAIL emitted `delivered` with gate:"fail" too, before exiting 1. That is the
// `gate_failed` + `delivered` fail-open Phase 4 closed at dispatch time, alive
// in the exact route the WITHHELD message tells users to take.
//
// End-to-end by construction: revise.ts is a CLI, so these cases spawn it with
// a FAKE `claude` on PATH (exits 0, prints the runtime's JSON envelope, writes
// nothing) over a pre-seeded outputs dir. What the artifacts are decides the
// outcome — nothing is stubbed inside the pipeline.
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { writeFakeCli } from "./helpers/fake-cli.ts";

const SKILLS = path.resolve(import.meta.dir, "..", "..");
const REVISE = path.join(SKILLS, "harness", "scripts", "revise.ts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-revise-test-"));

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

const PASSING_MD = [
  "# Relatório revisado",
  "",
  "A revisão pedida foi aplicada nos três blocos que o cliente marcou, e o texto ficou mais curto.",
  "",
  "O número que importa: a conversão medida em julho, 4,1%, veio de uma base de 12 mil sessões.",
  "",
  "## O que muda daqui",
  "",
  "1. Publicar a versão nova do painel.",
  "2. Avisar o time de vendas.",
  "3. Refazer a leitura em trinta dias.",
  "",
  "Uma ressalva honesta: a base de julho é menor que a de junho, então trate a comparação com cuidado.",
].join("\n");

const FAILING_MD = "# Nota\n\n" + "palavra - outra ".repeat(30) +
  "\n\nParágrafo final simples para dar corpo ao documento e passar de duzentos bytes com folga.\n";

const PASSING_HTML = [
  "<!doctype html>", "<html>", "<head><title>Entrega</title></head>", "<body>", "<main>",
  "<h1>Entrega revisada</h1>",
  "<p>Conteúdo da página com estrutura balanceada e tamanho suficiente para o gate julgar.</p>",
  "<p>Segundo parágrafo para dar corpo ao documento HTML de teste.</p>",
  "</main>", "</body>", "</html>",
].join("\n");

/** Valid PNG signature, under 1KB — brief-fidelity rejects it as a placeholder. */
const STUB_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(300, 7),
]);

const NON_GATEABLE_PDF = "%PDF-1.7\n" + "conteúdo binário simulado ".repeat(20) + "\n%%EOF\n";

let caseSeq = 0;

interface ReviseCase {
  status: number | null;
  stdout: string;
  audit: any[];
  runtimeCalls: number;
  oroot: string;
}

/** A project laid out the way dispatch.ts leaves one (outputs/<pid>/businesses/
 *  <slug>/session.json), with `files` already in the outputs root, plus a fake
 *  runtime that succeeds without touching disk. Then: `nrv revise`. */
function runRevise(files: Record<string, string | Buffer>, opts: { env?: Record<string, string>; runtimeFails?: boolean } = {}): ReviseCase {
  const n = caseSeq++;
  const home = path.join(TMP, `case-${n}`);
  const pid = `proj-revise-${n}`;
  const slug = "biz";
  const projectRoot = path.join(home, "outputs", pid);
  const projDir = path.join(projectRoot, "businesses", slug);
  const oroot = path.join(projDir, "deliverables");
  fs.mkdirSync(oroot, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(oroot, name), body as any);
  fs.writeFileSync(path.join(projDir, "session.json"), JSON.stringify({
    project_id: pid, business_slug: slug, employee: "ceo", runtime: "claude-code",
    session_id: "sess-original", project_dir: projDir, project_root: projectRoot,
    outputs_root: oroot, zip_path: null,
  }, null, 2));

  // Fake `claude`: swallows the prompt, prints the runtime's JSON envelope,
  // records the call. It writes NO artifact, so a revision run can never turn a
  // failing gate green — the budget just gets spent, exactly as in production.
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const callsFile = path.join(home, "runtime-calls.log");
  // Bun/TS body with a per-OS launcher: a `#!/bin/sh` fake is invisible to
  // Windows, which is why this whole file used to fail there.
  const envelope = opts.runtimeFails
    // A runtime that errors AFTER the edits are on disk — the usual shape of a
    // usage/turn limit at the end of a long revision.
    ? { type: "result", is_error: true, result: "usage limit reached", session_id: "sess-fake", total_cost_usd: 0 }
    : { type: "result", is_error: false, result: "ok", session_id: "sess-fake", total_cost_usd: 0 };
  writeFakeCli(binDir, "claude", `
    import * as fs from "node:fs";
    try { await Bun.stdin.text(); } catch {}
    try { fs.appendFileSync(${JSON.stringify(callsFile)}, "call\\n"); } catch {}
    console.log(JSON.stringify(${JSON.stringify(envelope)}));
    process.exit(0);
  `);

  const logs = path.join(home, "harness-logs");
  const r = spawnSync(process.execPath, [REVISE, pid, "encurte o texto", "--no-color"], {
    cwd: home,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      HOME: home,
      USERPROFILE: home,   // os.homedir() follows USERPROFILE on Windows
      NIRVANA_SKILLS_DIR: SKILLS,
      HARNESS_LOGS_DIR: logs,
      NRV_IN_SWEEP: "",
      ...(opts.env ?? {}),
    },
  });

  const day = new Date().toISOString().slice(0, 10);
  const auditFile = path.join(logs, day, "audit.jsonl");
  const audit = fs.existsSync(auditFile)
    ? fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } })
    : [];
  const runtimeCalls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean).length : 0;
  return { status: r.status, stdout: (r.stdout || "") + (r.stderr || ""), audit, runtimeCalls, oroot };
}

/** DELIVERY-level events only. quality-gate.ts appends its own per-file
 *  gate_passed/gate_failed (those carry `artifact`) — one rubric's verdict on
 *  one file, never the delivery decision. */
const events = (c: ReviseCase) => c.audit.filter(l => !l.artifact).map(l => l.event);

describe("nrv revise — the outcome goes through the delivery pipeline", () => {
  test("THE FAIL-OPEN, CLOSED: zero text files never claims a gate pass", () => {
    // Not one .md/.txt/.json. The old gate looped zero times, kept allPass=true
    // and emitted gate_passed + delivered (gate "pass") with exit 0.
    const c = runRevise({ "page.html": PASSING_HTML, "hero.png": STUB_PNG });
    expect(c.status).toBe(2);                       // WITHHELD
    expect(events(c)).not.toContain("gate_passed");
    expect(events(c)).not.toContain("delivered");
    expect(events(c)).toContain("gate_failed");     // the .png WAS judged
    expect(events(c)).toContain("x_delivery_withheld");
    expect(c.stdout).toContain("WITHHELD");
  }, 30_000);

  test("nothing the gate can judge → exit 3, INDETERMINATE, no delivered", () => {
    const c = runRevise({ "relatorio.pdf": NON_GATEABLE_PDF });
    expect(c.status).toBe(3);
    expect(events(c)).toContain("x_gate_skipped_no_files");
    expect(events(c)).not.toContain("gate_passed");
    expect(events(c)).not.toContain("delivered");
    expect(c.stdout).toContain("INDETERMINATE");
  }, 30_000);

  test("a real gate FAIL withholds — it never emits delivered before exiting", () => {
    const c = runRevise({ "nota.md": FAILING_MD });
    expect(c.status).toBe(2);
    expect(events(c)).toContain("gate_failed");
    expect(events(c)).not.toContain("delivered");   // old code emitted it with gate:"fail"
    // Interactive budget: the config's max_revisions (2) revision runs on top
    // of the revision itself. The human asked for this loop.
    expect(c.runtimeCalls).toBe(3);
  }, 60_000);

  test("passing artifacts → exit 0, delivered, marked as a revision", () => {
    const c = runRevise({ "nota.md": PASSING_MD });
    expect(c.status).toBe(0);
    expect(events(c)).toContain("gate_passed");
    const delivered = c.audit.filter(l => l.event === "delivered");
    expect(delivered.length).toBe(1);
    expect(delivered[0].gate).toBe("pass");
    expect(delivered[0].revision).toBe(true);
    expect(c.runtimeCalls).toBe(1);                 // no revision needed
  }, 30_000);

  test("spawned BY THE SUPERVISOR (NRV_IN_SWEEP=1): zero revision runs, verdict handed back", () => {
    // Budget rule: an unattended launchd sweep must not spend LLM money in a
    // revision loop nobody is watching. Same artifacts as the case above.
    const c = runRevise({ "nota.md": FAILING_MD }, { env: { NRV_IN_SWEEP: "1" } });
    expect(c.status).toBe(2);
    expect(c.runtimeCalls).toBe(1);                 // the revision itself, and nothing more
    expect(events(c)).not.toContain("delivered");
  }, 30_000);

  test("no verifiable deliverable → exit 1", () => {
    const c = runRevise({});
    expect(c.status).toBe(1);
    expect(events(c)).toContain("verify_failed");
    expect(events(c)).not.toContain("delivered");
  }, 30_000);

  test("bad args → 4 (EXIT.INVALID_ARGS), so 2 can mean WITHHELD", () => {
    const r = spawnSync(process.execPath, [REVISE], { encoding: "utf8" });
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("Usage: nrv revise");
  });

  test("a FAILED revision still judges what is on disk instead of abandoning it", () => {
    // The runtime errors, but the artifacts exist. Old behavior: exit 1, nothing
    // verified, nothing gated — the unjudged-artifact defect, in the revise door.
    const c = runRevise({ "guia.md": PASSING_MD }, { runtimeFails: true });
    expect(c.status).toBe(0);                       // gate passed → delivered
    expect(events(c)).toContain("revision_failed");  // the error is never swallowed
    expect(events(c)).toContain("x_runtime_errored_with_artifacts");
    expect(events(c)).toContain("delivered");
  });

  test("a FAILED revision whose artifacts fail the gate is WITHHELD, never delivered", () => {
    const c = runRevise({ "guia.md": FAILING_MD }, { runtimeFails: true });
    expect(c.status).toBe(2);
    expect(events(c)).toContain("x_runtime_errored_with_artifacts");
    expect(events(c)).toContain("x_delivery_withheld");
    expect(events(c)).not.toContain("delivered");
  });

  test("a FAILED revision with nothing on disk keeps the historical exit 1", () => {
    const c = runRevise({}, { runtimeFails: true });
    expect(c.status).toBe(1);
    expect(events(c)).toContain("revision_failed");
    expect(events(c)).not.toContain("delivered");
  });
});
