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
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { SCOPE_GUARD_EN } from "../../_shared/lib/scope-guard.ts";
import { spawnBudgetMs, TEARDOWN_BUDGET_MS } from "./helpers/test-budgets.ts";
import * as runLedger from "../lib/run-ledger.ts";
import { SOLO_ROLE_LINE } from "../lib/business-solo.ts";

const SKILLS = path.resolve(import.meta.dir, "..", "..");
const REVISE = path.join(SKILLS, "harness", "scripts", "revise.ts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-revise-test-"));

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } }, TEARDOWN_BUDGET_MS);

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

// .pdf became gateable in the pdf-valid change (2026-08-22) — the
// nothing-to-judge fixture must be an extension the gate really cannot
// read, or this test would silently exercise the wrong path.
const NON_GATEABLE_BLOB = "PK\u0003\u0004" + "conteúdo binário simulado ".repeat(20);

let caseSeq = 0;

interface ReviseCase {
  status: number | null;
  stdout: string;
  audit: any[];
  runtimeCalls: number;
  /** Everything the fake runtime received: its argv and its stdin. */
  prompt: string;
  /** The dispatch role each runtime call carried (NIRVANA_DISPATCH_ROLE). */
  roles: string[];
  oroot: string;
}

/** A project laid out the way dispatch.ts leaves one (outputs/<pid>/businesses/
 *  <slug>/session.json; squads/<slug>/ or agent-x/ for those kinds), with
 *  `files` already in the outputs root, plus a fake runtime that succeeds
 *  without touching disk. Then: `nrv revise`. */
function runRevise(files: Record<string, string | Buffer>, opts: {
  env?: Record<string, string>; runtimeFails?: boolean; brief?: string; setup?: (pid: string, home: string) => void;
  kind?: "business" | "squad" | "agent-x"; sessionId?: string | null;
} = {}): ReviseCase {
  const n = caseSeq++;
  const home = path.join(TMP, `case-${n}`);
  const pid = `proj-revise-${n}`;
  const kind = opts.kind ?? "business";
  const slug = kind === "business" ? "biz" : kind === "squad" ? "copy" : "agent-x";
  const projectRoot = path.join(home, "outputs", pid);
  const projDir = kind === "business" ? path.join(projectRoot, "businesses", slug)
    : kind === "squad" ? path.join(projectRoot, "squads", slug) : path.join(projectRoot, "agent-x");
  // A business writes under its own scaffold; a squad and agent-x under the run's deliverables/.
  const oroot = kind === "business" ? path.join(projDir, "deliverables") : path.join(projectRoot, "deliverables");
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(oroot, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(oroot, name), body as any);
  // The run's brief lives at its scaffold root, two levels above businesses/<slug>
  // or squads/<slug>; agent-x's is brief-enriched.md, one level above agent-x/.
  if (opts.brief) fs.writeFileSync(path.join(projectRoot, kind === "agent-x" ? "brief-enriched.md" : "brief.md"), opts.brief);
  const sessionId = opts.sessionId === undefined ? "sess-original" : opts.sessionId;
  fs.writeFileSync(path.join(projDir, "session.json"), JSON.stringify(kind === "business" ? {
    project_id: pid, business_slug: slug, employee: "ceo", runtime: "claude-code",
    session_id: sessionId, project_dir: projDir, project_root: projectRoot,
    outputs_root: oroot, zip_path: null,
  } : {
    project_id: pid, target_kind: kind, target_slug: slug, runtime: "claude-code",
    session_id: sessionId, project_dir: projDir, project_root: projectRoot,
    outputs_root: oroot, workspace: null, manifest: null,
  }, null, 2));

  // Fake `claude`: swallows the prompt, prints the runtime's JSON envelope,
  // records the call. It writes NO artifact, so a revision run can never turn a
  // failing gate green — the budget just gets spent, exactly as in production.
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const callsFile = path.join(home, "runtime-calls.log");
  const promptFile = path.join(home, "runtime-prompt.log");
  const rolesFile = path.join(home, "runtime-roles.log");
  // Bun/TS body with a per-OS launcher: a `#!/bin/sh` fake is invisible to
  // Windows, which is why this whole file used to fail there.
  const envelope = opts.runtimeFails
    // A runtime that errors AFTER the edits are on disk — the usual shape of a
    // usage/turn limit at the end of a long revision.
    ? { type: "result", is_error: true, result: "usage limit reached", session_id: "sess-fake", total_cost_usd: 0 }
    : { type: "result", is_error: false, result: "ok", session_id: "sess-fake", total_cost_usd: 0 };
  writeFakeCli(binDir, "claude", `
    import * as fs from "node:fs";
    let stdin = "";
    try { stdin = await Bun.stdin.text(); } catch {}
    try { fs.appendFileSync(${JSON.stringify(callsFile)}, "call\\n"); } catch {}
    try { fs.appendFileSync(${JSON.stringify(rolesFile)}, (process.env.NIRVANA_DISPATCH_ROLE ?? "") + "\\n"); } catch {}
    try { fs.writeFileSync(${JSON.stringify(promptFile)}, process.argv.slice(2).join("\\n") + "\\n" + stdin); } catch {}
    console.log(JSON.stringify(${JSON.stringify(envelope)}));
    process.exit(0);
  `);

  const logs = path.join(home, "harness-logs");
  opts.setup?.(pid, home);
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
      NIRVANA_RUN_LEDGER_DB: path.join(home, "ledger.sqlite"),
      ...(opts.env ?? {}),
    },
  });

  const day = new Date().toISOString().slice(0, 10);
  const auditFile = path.join(logs, day, "audit.jsonl");
  const audit = fs.existsSync(auditFile)
    ? fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean).map(l => { try { return parseAuditLine(l); } catch { return {}; } })
    : [];
  const runtimeCalls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean).length : 0;
  const prompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, "utf8") : "";
  const roles = fs.existsSync(rolesFile) ? fs.readFileSync(rolesFile, "utf8").split("\n").slice(0, -1) : [];
  return { status: r.status, stdout: (r.stdout || "") + (r.stderr || ""), audit, runtimeCalls, prompt, roles, oroot };
}

/** DELIVERY-level events only. quality-gate.ts appends its own per-file
 *  gate_passed/gate_failed (those carry `artifact`) — one rubric's verdict on
 *  one file, never the delivery decision. */
const events = (c: ReviseCase) => c.audit.filter(l => !l.artifact).map(l => l.event);

describe("nrv revise — the outcome goes through the delivery pipeline", () => {
  test("the revision prompt the runtime receives carries the scope guard", () => {
    const c = runRevise({ "nota.md": PASSING_MD });
    expect(c.runtimeCalls).toBeGreaterThanOrEqual(1);
    expect(c.prompt).toContain(SCOPE_GUARD_EN);
  }, 30_000);

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
    const c = runRevise({ "relatorio.zip": NON_GATEABLE_BLOB });
    expect(c.status).toBe(3);
    expect(events(c)).toContain("x_gate_skipped_no_files");
    expect(events(c)).not.toContain("gate_passed");
    expect(events(c)).not.toContain("delivered");
    expect(c.stdout).toContain("INDETERMINATE");
  }, 30_000);

  test("a style failure the corrections did not clear ships WITH RESERVATIONS (rule A), after the corrections ran", () => {
    const c = runRevise({ "nota.md": FAILING_MD });
    expect(c.status).toBe(0);
    expect(events(c)).toContain("gate_failed");
    expect(events(c)).toContain("x_delivered_with_reservations");
    expect(c.audit.find(l => l.event === "delivered" && !l.artifact)?.gate).toBe("fail-accepted");
    // Interactive budget: the config's max_revisions (2) revision runs on top
    // of the revision itself. The human asked for this loop.
    expect(c.runtimeCalls).toBe(3);
    expect(fs.existsSync(path.join(c.oroot, "_QA-RESERVATIONS.md"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(c.oroot, "_STATUS.json"), "utf8")).state).toBe("delivered_with_reservations");
  }, 60_000);

  test("a SERIOUS failure no correction improves is WITHHELD after the normal rounds — it never emits delivered", () => {
    // The fake runtime changes nothing, so the extra rounds a serious finding
    // may get never start: they are granted for progress (delivery-pipeline.ts).
    const c = runRevise({ "dados.json": '{"itens": [' + '"valor", '.repeat(40) });
    expect(c.status).toBe(2);
    expect(events(c)).toContain("x_delivery_withheld");
    expect(events(c)).not.toContain("delivered");
    expect(c.audit.find(l => l.event === "x_delivery_withheld")?.no_progress).toBe(true);
    expect(c.runtimeCalls).toBe(1 + 2);
  }, 90_000);

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
    // Budget rule: an unattended sweep must not spend LLM money in a
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
  }, spawnBudgetMs(1));

  test("a FAILED revision still judges what is on disk, and ships it WITH RESERVATIONS, never as a full pass", () => {
    // The runtime errors, but the artifacts exist. Old behavior: exit 1, nothing
    // verified, nothing gated — the unjudged-artifact defect, in the revise door.
    const c = runRevise({ "guia.md": PASSING_MD }, { runtimeFails: true });
    expect(c.status).toBe(0);
    expect(events(c)).toContain("revision_failed");  // the error is never swallowed
    expect(events(c)).toContain("x_runtime_errored_with_artifacts");
    expect(events(c)).toContain("x_delivered_with_reservations");
    expect(events(c)).toContain("delivered");
  }, spawnBudgetMs(2));

  test("a FAILED revision whose artifacts carry a serious finding is WITHHELD, never delivered", () => {
    const c = runRevise({ "guia.json": '{"itens": [' + '"valor", '.repeat(40) }, { runtimeFails: true, env: { NRV_IN_SWEEP: "1" } });
    expect(c.status).toBe(2);
    expect(events(c)).toContain("x_runtime_errored_with_artifacts");
    expect(events(c)).toContain("x_delivery_withheld");
    expect(events(c)).not.toContain("delivered");
  }, spawnBudgetMs(2));

  test("a FAILED revision with nothing on disk keeps the historical exit 1", () => {
    const c = runRevise({}, { runtimeFails: true });
    expect(c.status).toBe(1);
    expect(events(c)).toContain("revision_failed");
    expect(events(c)).not.toContain("delivered");
  }, spawnBudgetMs(2));
});

describe("nrv revise continues the ORIGINAL worker", () => {
  const BRIEF = [
    "## Request (verbatim)", "Encurte o relatório.", "",
    "## Decisions", "None.", "",
    "## Your part", "O relatório.", "",
    "## Inputs", "None.", "",
    "## Done when", "- O relatório tem no máximo uma página (bloqueante)", "",
    "## Output", "nota.md", "",
  ].join("\n");

  test("a business revision runs as the solo worker, told to update its summary and claims", () => {
    const c = runRevise({ "nota.md": PASSING_MD, "_CLAIMS.json": JSON.stringify([{ id: "d1", evidence: "nota.md:1-14, o relatório inteiro" }]) }, { brief: BRIEF });
    expect(c.status).toBe(0);
    expect(c.roles[0]).toBe("solo");
    expect(c.prompt).toContain("_SUMMARY.md");
    expect(c.prompt).toContain("_CLAIMS.json");
  }, 30_000);

  test("the brief is read from the run's scaffold root: its blocking criterion is held to the claims", () => {
    // No _CLAIMS.json and a runtime that writes nothing: the blocking criterion
    // never gets its proof, which is serious, so the delivery is withheld.
    const c = runRevise({ "nota.md": PASSING_MD }, { brief: BRIEF });
    expect(c.status).toBe(2);
    expect(events(c)).toContain("x_delivery_withheld");
    const status = JSON.parse(fs.readFileSync(path.join(c.oroot, "_STATUS.json"), "utf8"));
    expect(status.serious[0]).toContain("blocking criterion d1");
    // Every correction ran as the solo worker too.
    expect(c.roles.every(r => r === "solo")).toBe(true);
  }, 90_000);

  test("the ledger row of the run is carried to its terminal state", () => {
    let db = "";
    let runId = "";
    const c = runRevise({ "nota.md": PASSING_MD }, {
      setup: (pid, home) => {
        db = path.join(home, "ledger.sqlite");
        const h = runLedger.openLedger(db);
        const row = runLedger.openRun(h, { traceId: pid, projectId: pid, projectRoot: null, targetSlug: "biz", targetKind: "business", runtime: "claude-code",
          meta: { mode: "solo", dispatch_role: "solo", runtime_source: "flag" } });
        runLedger.markState(h, row.run_id, "running");
        runId = row.run_id;
      },
    });
    expect(c.status).toBe(0);
    const h = runLedger.openLedger(db);
    const row = runLedger.getRun(h, runId)!;
    expect(row.state).toBe("delivered");
    expect(row.child_pid).toBeNull();
  }, 30_000);

  test("a squad run from before squad runs recorded their session: refused with a clear message, exit 4", () => {
    const home = path.join(TMP, "squad-case");
    fs.mkdirSync(path.join(home, "outputs", "proj-squad", "squads", "copy"), { recursive: true });
    const r = spawnSync(process.execPath, [REVISE, "proj-squad", "encurte", "--no-color"], {
      cwd: home, encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_RUN_LEDGER_DB: path.join(home, "ledger.sqlite") },
    });
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("is a squad run");
    expect(r.stderr).not.toContain("Was this project created");
  }, spawnBudgetMs(1));
});

describe("nrv revise continues a squad or agent-x worker like a business one", () => {
  test("a squad revision resumes the squad's session as `squad`, told to update its summary (no claims), and judges the result", () => {
    let db = "";
    let runId = "";
    const c = runRevise({ "nota.md": PASSING_MD }, {
      kind: "squad",
      setup: (pid, home) => {
        // The squad run finished (delivered): the revision opens a new attempt of the trace.
        db = path.join(home, "ledger.sqlite");
        const h = runLedger.openLedger(db);
        const row = runLedger.openRun(h, { traceId: pid, projectId: pid, projectRoot: null, targetSlug: "copy", targetKind: "squad", runtime: "claude-code",
          meta: { mode: "squad-only", dispatch_role: "squad", runtime_source: "default" } });
        runLedger.markState(h, row.run_id, "running");
        runLedger.markState(h, row.run_id, "delivered");
        runId = row.run_id;
      },
    });
    expect(c.status, c.stdout).toBe(0);
    expect(c.runtimeCalls).toBe(1);
    expect(c.roles[0]).toBe("squad");
    expect(c.prompt).toContain("--resume");
    expect(c.prompt).toContain("sess-original");
    expect(c.prompt).toContain(path.join(c.oroot, "_SUMMARY.md"));
    expect(c.prompt).not.toContain("_CLAIMS.json");
    expect(c.prompt).not.toContain(SOLO_ROLE_LINE);
    expect(c.audit.find(l => l.event === "revision_requested")).toMatchObject({ target_kind: "squad", target_slug: "copy", dispatch_role: "squad", business_slug: null });
    expect(events(c)).toContain("delivered");
    const h = runLedger.openLedger(db);
    const fresh = runLedger.findByTraceId(h, path.basename(path.dirname(c.oroot)))!;
    expect(fresh.run_id).not.toBe(runId);
    expect(fresh).toMatchObject({ target_kind: "squad", target_slug: "copy", state: "delivered" });
    expect(fresh.meta).toMatchObject({ revision_of: runId, dispatch_role: "squad" });
    // The revision's own dispatcher, not the earlier run's: `stop` ends this one.
    expect(typeof fresh.meta?.dispatcher_pid).toBe("number");
    expect(fresh.meta?.dispatcher_pid).not.toBe(runLedger.getRun(h, runId)!.meta?.dispatcher_pid);
  }, 30_000);

  test("an agent-x revision resumes the generalist's session as `agent-x`", () => {
    const c = runRevise({ "nota.md": PASSING_MD }, { kind: "agent-x" });
    expect(c.status, c.stdout).toBe(0);
    expect(c.roles[0]).toBe("agent-x");
    expect(c.prompt).toContain("sess-original");
    expect(c.prompt).toContain(path.join(c.oroot, "_SUMMARY.md"));
    expect(c.prompt).not.toContain("_CLAIMS.json");
    expect(c.audit.find(l => l.event === "revision_requested")).toMatchObject({ target_kind: "agent-x", dispatch_role: "agent-x" });
  }, 30_000);

  test("the corrections after a failed gate run as the same worker", () => {
    const c = runRevise({ "nota.md": FAILING_MD }, { kind: "squad" });
    expect(c.status).toBe(0);
    expect(c.runtimeCalls).toBe(3);
    expect(c.roles.every(r => r === "squad")).toBe(true);
  }, 60_000);

  test("a run whose runtime returned no session id is refused (exit 4) and nothing runs", () => {
    const c = runRevise({ "nota.md": PASSING_MD }, { kind: "agent-x", sessionId: null });
    expect(c.status).toBe(4);
    expect(c.stdout).toContain("returned no session id");
    expect(c.stdout).toContain("new dispatch");
    expect(c.runtimeCalls).toBe(0);
  }, 30_000);

  test("a route of several squads has no single session to continue: refused (exit 4)", () => {
    const c = runRevise({ "nota.md": PASSING_MD }, {
      kind: "squad",
      setup: (pid, home) => {
        const other = path.join(home, "outputs", pid, "squads", "design");
        fs.mkdirSync(other, { recursive: true });
        fs.writeFileSync(path.join(other, "session.json"), JSON.stringify({ project_id: pid, target_kind: "squad", target_slug: "design", runtime: "claude-code", session_id: "sess-2" }));
      },
    });
    expect(c.status).toBe(4);
    expect(c.stdout).toContain("ran 2 workers (squad copy, squad design)");
    expect(c.runtimeCalls).toBe(0);
  }, 30_000);
});
