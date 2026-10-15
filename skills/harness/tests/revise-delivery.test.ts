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
import { SCOPE_GUARD_PT_BR } from "../../_shared/lib/scope-guard.ts";
import { spawnBudgetMs, TEARDOWN_BUDGET_MS } from "./helpers/test-budgets.ts";

/** Codex's usage-limit message as the 2026-10-14 incident logs carry it. */
const QUOTA_MESSAGE = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 1:21 AM.";

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
  /** Everything the fake runtime received: its argv and its stdin, per call. */
  prompt: string;
  oroot: string;
  /** NIRVANA_DISPATCH_ROLE of each runtime call. */
  roles: string[];
  home: string;
  pid: string;
}

/** A project laid out the way dispatch.ts leaves one (outputs/<pid>/businesses/
 *  <slug>/session.json), with `files` already in the outputs root, plus a fake
 *  runtime that succeeds without touching disk. Then: `nrv revise`. */
function runRevise(files: Record<string, string | Buffer>, opts: {
  env?: Record<string, string>; runtimeFails?: boolean | "quota"; brief?: string; setup?: (pid: string, home: string) => void;
  /** The worker the run had: a business (businesses/<slug>), a squad (squads/copy) or agent-x. */
  kind?: "business" | "squad" | "agent-x"; sessionId?: string | null;
  /** The CLI arguments after the script; `{pid}` is replaced by the case's project id. */
  args?: string[];
  /** The fake claude answers a `--resume` like a pruned session: "No conversation found". */
  missingSession?: boolean;
  /** Write no session.json at all (a run from before runs recorded one). */
  noSessionFile?: boolean;
  /** The gate's reservations already on disk from the run's last gate. */
  reservations?: string;
} = {}): ReviseCase {
  const n = caseSeq++;
  const home = path.join(TMP, `case-${n}`);
  const pid = `proj-revise-${n}`;
  const kind = opts.kind ?? "business";
  const slug = kind === "business" ? "biz" : kind === "squad" ? "copy" : "agent-x";
  const projectRoot = path.join(home, "outputs", pid);
  const projDir = kind === "business" ? path.join(projectRoot, "businesses", slug)
    : kind === "squad" ? path.join(projectRoot, "squads", slug) : path.join(projectRoot, "agent-x");
  const oroot = kind === "business" ? path.join(projDir, "deliverables") : path.join(projectRoot, "deliverables");
  fs.mkdirSync(oroot, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(oroot, name), body as any);
  // The run's brief lives at its scaffold root; agent-x's is brief-enriched.md.
  if (opts.brief) fs.writeFileSync(path.join(projectRoot, kind === "agent-x" ? "brief-enriched.md" : "brief.md"), opts.brief);
  if (opts.reservations) fs.writeFileSync(path.join(oroot, "_QA-RESERVATIONS.md"), opts.reservations);
  const sessionId = opts.sessionId === undefined ? "sess-original" : opts.sessionId;
  if (!opts.noSessionFile) fs.writeFileSync(path.join(projDir, "session.json"), JSON.stringify(kind === "business" ? {
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
  const envelope = opts.runtimeFails === "quota"
    // The real Codex message of the 2026-10-14 incident, curly apostrophe included.
    ? { type: "result", is_error: true, result: QUOTA_MESSAGE, session_id: "sess-fake", total_cost_usd: 0 }
    : opts.runtimeFails
    // A runtime that errors AFTER the edits are on disk — the usual shape of a
    // turn limit at the end of a long revision. (A usage limit is a quota: it
    // waits for the reset instead, see the quota test below.)
    ? { type: "result", is_error: true, result: "Reached max turns (40)", session_id: "sess-fake", total_cost_usd: 0 }
    : { type: "result", is_error: false, result: "ok", session_id: "sess-fake", total_cost_usd: 0 };
  writeFakeCli(binDir, "claude", `
    import * as fs from "node:fs";
    let stdin = "";
    try { stdin = await Bun.stdin.text(); } catch {}
    try { fs.appendFileSync(${JSON.stringify(callsFile)}, "call\\n"); } catch {}
    try { fs.appendFileSync(${JSON.stringify(rolesFile)}, (process.env.NIRVANA_DISPATCH_ROLE ?? "") + "\\n"); } catch {}
    try { fs.appendFileSync(${JSON.stringify(promptFile)}, process.argv.slice(2).join("\\n") + "\\n" + stdin + "\\n=== end of call ===\\n"); } catch {}
    const argv = process.argv.slice(2);
    if (${JSON.stringify(!!opts.missingSession)} && argv.includes("--resume")) {
      process.stderr.write("No conversation found with session ID: " + argv[argv.indexOf("--resume") + 1] + "\\n");
      process.exit(1);
    }
    const env = ${JSON.stringify(envelope)};
    const assigned = argv.includes("--session-id") ? argv[argv.indexOf("--session-id") + 1] : null;
    console.log(JSON.stringify(assigned ? { ...env, session_id: assigned } : env));
    process.exit(0);
  `);

  const logs = path.join(home, "harness-logs");
  opts.setup?.(pid, home);
  const cli = opts.args ? opts.args.map(a => a.replace("{pid}", pid)) : [pid, "encurte o texto"];
  const r = spawnSync(process.execPath, [REVISE, ...cli, "--no-color"], {
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
    ? fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean).map(l => { try { return parseAuditLine(l); } catch { return {}; } })
    : [];
  const runtimeCalls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean).length : 0;
  const prompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, "utf8") : "";
  const roles = fs.existsSync(rolesFile) ? fs.readFileSync(rolesFile, "utf8").split("\n").slice(0, -1) : [];
  return { status: r.status, stdout: (r.stdout || "") + (r.stderr || ""), audit, runtimeCalls, prompt, oroot, roles, home, pid };
}

/** DELIVERY-level events only. quality-gate.ts appends its own per-file
 *  gate_passed/gate_failed (those carry `artifact`) — one rubric's verdict on
 *  one file, never the delivery decision. */
const events = (c: ReviseCase) => c.audit.filter(l => !l.artifact).map(l => l.event);

describe("nrv revise — the outcome goes through the delivery pipeline", () => {
  test("the revision prompt the runtime receives carries the scope guard in PT-BR", () => {
    const c = runRevise({ "nota.md": PASSING_MD });
    expect(c.runtimeCalls).toBeGreaterThanOrEqual(1);
    expect(c.prompt).toContain(SCOPE_GUARD_PT_BR);
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

  test("a revision agy ran in another conversation says so, is audited, and the new id is kept for the next one", () => {
    // agy 1.3.3 `--continue` with nothing to continue: exit 0, no warning, a new conversation.
    const c = runRevise({ "nota.md": PASSING_MD }, {
      setup: (pid, home) => {
        const sessionFile = path.join(home, "outputs", pid, "businesses", "biz", "session.json");
        const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
        fs.writeFileSync(sessionFile, JSON.stringify({ ...session, runtime: "antigravity-cli", session_id: "conv-gone" }, null, 2));
        writeFakeCli(path.join(home, "bin"), "agy", `
          console.log(JSON.stringify({ conversation_id: "conv-new", status: "SUCCESS", response: "OK" }));
          process.exit(0);
        `);
      },
    });
    expect(c.status).toBe(0);
    expect(c.stdout).toContain("did NOT resume the run's conversation");
    expect(c.stdout).toContain("agy: resume failed");
    const lost = c.audit.find(l => l.event === "x_resume_lost");
    expect(lost?.requested_session_id).toBe("conv-gone");
    expect(lost?.session_id).toBe("conv-new");
    const session = JSON.parse(fs.readFileSync(path.join(c.oroot, "..", "session.json"), "utf8"));
    expect(session.session_id).toBe("conv-new");
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

  test("a FAILED revision still judges what is on disk instead of abandoning it", () => {
    // The runtime errors, but the artifacts exist. Old behavior: exit 1, nothing
    // verified, nothing gated — the unjudged-artifact defect, in the revise door.
    const c = runRevise({ "guia.md": PASSING_MD }, { runtimeFails: true });
    expect(c.status).toBe(0);                       // gate passed → delivered
    expect(events(c)).toContain("revision_failed");  // the error is never swallowed
    expect(events(c)).toContain("x_runtime_errored_with_artifacts");
    expect(events(c)).toContain("delivered");
  }, spawnBudgetMs(2));

  test("a FAILED revision whose artifacts fail the gate is WITHHELD, never delivered", () => {
    const c = runRevise({ "guia.md": FAILING_MD }, { runtimeFails: true });
    expect(c.status).toBe(2);
    expect(events(c)).toContain("x_runtime_errored_with_artifacts");
    expect(events(c)).toContain("x_delivery_withheld");
    expect(events(c)).not.toContain("delivered");
  }, spawnBudgetMs(2));

  test("a revision stopped on a spent quota waits for the reset: no gate, no judge, exit 75", () => {
    const c = runRevise({ "guia.md": PASSING_MD }, { runtimeFails: "quota" });
    expect(c.status).toBe(75);
    expect(events(c)).toContain("revision_failed");
    expect(events(c)).toContain("x_delivery_quota_wait");
    for (const e of ["judge_invoked", "gate_passed", "gate_failed", "revision_auto", "x_runtime_errored_with_artifacts", "delivered"]) expect(events(c)).not.toContain(e);
    expect(c.stdout).toContain("Waiting on quota");
  }, spawnBudgetMs(2));

  test("a revision keeps the folder the brief places the work in, and never asks to move it under the outputs root", () => {
    const site = path.join(TMP, `site-${Date.now()}`);
    fs.mkdirSync(site, { recursive: true });
    const c = runRevise({ "guia.md": PASSING_MD }, { brief: `# Brief\n\nCorrija o site em ${site}, no lugar.\n` });
    expect(c.status).toBe(0);
    expect(c.prompt).toContain(`O brief coloca trabalho em: ${site}.`);
    expect(c.prompt).toContain("nunca copiado para dentro de");
    expect(c.prompt).not.toContain("Reescreva/atualize os entregáveis como arquivos sob");
  }, spawnBudgetMs(2));

  test("a FAILED revision with nothing on disk keeps the historical exit 1", () => {
    const c = runRevise({}, { runtimeFails: true });
    expect(c.status).toBe(1);
    expect(events(c)).toContain("revision_failed");
    expect(events(c)).not.toContain("delivered");
  }, spawnBudgetMs(2));
});

describe("nrv revise continues a squad or agent-x worker like a business one", () => {
  test("a squad run resumes the squad's own session, as a squad, and delivers", () => {
    const c = runRevise({ "nota.md": PASSING_MD }, { kind: "squad" });
    expect(c.status, c.stdout).toBe(0);
    expect(c.prompt).toContain("--resume\nsess-original");
    expect(c.roles.every(r => r === "squad")).toBe(true);
    expect(c.audit.find(l => l.event === "revision_requested")).toMatchObject({ target_kind: "squad", target_slug: "copy", session_id: "sess-original" });
  }, 30_000);

  test("an agent-x run resumes the generalist's session, as agent-x", () => {
    const c = runRevise({ "nota.md": PASSING_MD }, { kind: "agent-x", brief: "# Brief\n\nNota." });
    expect(c.status, c.stdout).toBe(0);
    expect(c.prompt).toContain("--resume\nsess-original");
    expect(c.roles.every(r => r === "agent-x")).toBe(true);
  }, 30_000);

  test("the revision runs under a ledger row of the trace, closed by the verdict", () => {
    const c = runRevise({ "nota.md": PASSING_MD }, { kind: "squad" });
    expect(c.status, c.stdout).toBe(0);
    expect(c.audit.some(l => l.event === "x_ledger_state_changed" && l.to === "running")).toBe(true);
    expect(c.audit.some(l => l.event === "x_ledger_state_changed" && l.to === "delivered")).toBe(true);
  }, 30_000);

  test("a run whose runtime returned no session id runs a FRESH session seeded with the brief, the deliverables, the reservations and the change", () => {
    const c = runRevise({ "nota.md": PASSING_MD }, {
      kind: "squad", sessionId: null, brief: "# Brief\n\nCarta para a Eduarda, centralizada.",
      reservations: "# QA reservations\n\n- html-layout: o título não está centralizado.",
    });
    expect(c.status, c.stdout).toBe(0);
    expect(c.runtimeCalls).toBe(1);
    expect(c.stdout).toContain("FRESH session");
    expect(c.stdout).toContain("returned no session id");
    expect(c.prompt).not.toContain("--resume");
    expect(c.prompt).toContain("--session-id");
    expect(c.prompt).toContain("Carta para a Eduarda, centralizada.");
    expect(c.prompt).toContain(`The delivered work is in ${c.oroot}`);
    expect(c.prompt).toContain("o título não está centralizado");
    expect(c.prompt).toContain("encurte o texto");
    expect(c.audit.find(l => l.event === "x_revise_fresh_session")).toMatchObject({ reason: "no_session_id", target_kind: "squad", previous_session_id: null });
    expect(c.audit.find(l => l.event === "revision_requested")).toMatchObject({ fresh_session: "no_session_id", session_id: null });
    // The fresh session is the one the next revision continues.
    const file = path.join(c.home, "outputs", c.pid, "squads", "copy", "session.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).session_id).toMatch(/^[0-9a-f-]{36}$/);
  }, 30_000);

  test("a session the runtime no longer knows: the resume is tried, then a FRESH seeded session runs, audited as resume_failed", () => {
    const c = runRevise({ "nota.md": PASSING_MD }, { kind: "squad", missingSession: true, brief: "# Brief\n\nNota curta." });
    expect(c.status, c.stdout).toBe(0);
    expect(c.runtimeCalls).toBe(2);
    const [first, second] = c.prompt.split("=== end of call ===");
    expect(first).toContain("--resume\nsess-original");
    expect(second).not.toContain("--resume");
    expect(second).toContain("NEW session");
    expect(second).toContain("Nota curta.");
    expect(c.audit.find(l => l.event === "x_revise_fresh_session")).toMatchObject({ reason: "resume_failed", previous_session_id: "sess-original" });
  }, 30_000);

  test("a squad run from before squad runs recorded their session runs a FRESH seeded session, never a refusal", () => {
    const c = runRevise({ "nota.md": PASSING_MD }, { kind: "squad", noSessionFile: true, brief: "# Brief\n\nUma nota curta para o cliente." });
    expect(c.status, c.stdout).toBe(0);
    expect(c.stdout).toContain("FRESH session");
    expect(c.prompt).not.toContain("--resume");
    expect(c.prompt).toContain("NEW session");
    expect(c.prompt).toContain("Uma nota curta para o cliente.");
    expect(c.audit.find(l => l.event === "x_revise_fresh_session")).toMatchObject({ reason: "legacy_run", target_kind: "squad", target_slug: "copy" });
    const written = JSON.parse(fs.readFileSync(path.join(c.home, "outputs", c.pid, "squads", "copy", "session.json"), "utf8"));
    expect(written.session_id).toMatch(/^[0-9a-f-]{36}$/);
  }, 30_000);

  test("--runtime naming another runtime runs fresh there, never resumes a foreign id", () => {
    const c = runRevise({ "nota.md": PASSING_MD }, {
      kind: "agent-x", args: ["{pid}", "encurte o texto", "--runtime", "claude-code"],
      setup: (pid, home) => {
        // The session belongs to codex; the owner asks for claude-code.
        const file = path.join(home, "outputs", pid, "agent-x", "session.json");
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        fs.writeFileSync(file, JSON.stringify({ ...data, runtime: "codex", session_id: "codex-thread-1" }));
      },
    });
    expect(c.status, c.stdout).toBe(0);
    expect(c.prompt).not.toContain("codex-thread-1");
    expect(c.audit.find(l => l.event === "x_revise_fresh_session")).toMatchObject({ reason: "runtime_changed", previous_runtime: "codex", runtime: "claude-code" });
  }, 30_000);

  test("--last picks the newest run of the named worker, and resumes it", () => {
    const c = runRevise({ "nota.md": PASSING_MD }, {
      kind: "squad", args: ["--last", "copy", "encurte o texto"],
      setup: (pid, home) => {
        // An older run of the same squad, and a newer one of another squad.
        for (const [run, squad, sid, age] of [["old-run", "copy", "sess-old", 3600], ["other-run", "design", "sess-other", -3600]] as const) {
          const dir = path.join(home, "outputs", run, "squads", squad);
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, "session.json");
          fs.writeFileSync(file, JSON.stringify({ project_id: run, target_kind: "squad", target_slug: squad, runtime: "claude-code", session_id: sid }));
          const t = new Date(Date.now() - age * 1000);
          fs.utimesSync(file, t, t);
        }
        const mine = path.join(home, "outputs", pid, "squads", "copy", "session.json");
        const t = new Date(Date.now() - 60_000);
        fs.utimesSync(mine, t, t);
      },
    });
    expect(c.status, c.stdout).toBe(0);
    expect(c.stdout).toContain("--last → proj-revise-");
    expect(c.prompt).toContain("--resume\nsess-original");
  }, 30_000);

  test("--last with nothing to continue is a clear refusal (exit 4)", () => {
    const c = runRevise({ "nota.md": PASSING_MD }, { kind: "squad", args: ["--last", "nobody", "encurte"] });
    expect(c.status).toBe(4);
    expect(c.stdout).toContain("nrv run-track list");
    expect(c.runtimeCalls).toBe(0);
  }, 30_000);

  test("a route of several squads has no single worker to continue: exit 4, nothing runs", () => {
    const c = runRevise({ "nota.md": PASSING_MD }, {
      kind: "squad",
      setup: (pid, home) => {
        const other = path.join(home, "outputs", pid, "squads", "design");
        fs.mkdirSync(other, { recursive: true });
        fs.writeFileSync(path.join(other, "session.json"), JSON.stringify({ project_id: pid, target_kind: "squad", target_slug: "design", runtime: "claude-code", session_id: "s2" }));
      },
    });
    expect(c.status).toBe(4);
    expect(c.runtimeCalls).toBe(0);
  }, 30_000);
});
