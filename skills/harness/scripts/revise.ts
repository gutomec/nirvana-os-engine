#!/usr/bin/env bun
// revise.ts — request changes to an autopilot deliverable, keeping the session.
//
// Resumes the SAME runtime conversation (claude --resume <session_id>) so the
// agent has full context of what it produced, applies the change, then re-runs
// verify + gate + (re)export. State lives in <project>/session.json (written by
// dispatch.ts exec mode).
//
// Usage:
//   nrv revise <project_id> "<change request>"
//   nrv revise <project_id> "<change>" --zip --max-budget=10 --timeout=20 --yolo
//
// Exit codes (SAME TABLE as dispatch.ts — BREAKING, see CHANGELOG):
//   0 = revised + DELIVERED (gate pass)
//   1 = failed (runtime error, or no verifiable deliverable on disk)
//   2 = delivery WITHHELD — gate FAILED after the revision budget
//   3 = delivery INDETERMINATE — zero gateable artifacts; nothing was judged
//   4 = invalid args (EXIT.INVALID_ARGS per SCRIPT_CONTRACT; was 2)
//
// 0 means DELIVERED, and only that. This script used to exit 0 whenever the
// text-only gate had nothing to chew on, while emitting `delivered` with
// gate:"pass" — see the delivery block below.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { runHeadless, runtimeAvailable, AUTONOMOUS_DIRECTIVE, type Runtime } from "../lib/host-agent-driver.ts";
import { runDelivery, deliverAfterRuntimeError, type DeliveryResult } from "../lib/delivery-pipeline.ts";
import { loadHarnessConfig } from "../lib/harness-config.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";

const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", lime: "\x1b[38;5;154m" };
const noColor = process.argv.includes("--no-color") || !process.stdout.isTTY;
function c(k: keyof typeof ANSI, s: string): string { return noColor ? s : `${ANSI[k]}${s}${ANSI.reset}`; }

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return undefined;
}

const SKILLS = process.env.NIRVANA_SKILLS_DIR || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));
// Skip space-form value-flag values so they aren't mistaken for positionals.
const VALUE_FLAGS = new Set(["--max-budget", "--timeout", "--runtime"]);
const positional: string[] = [];
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { if (!a.includes("=") && VALUE_FLAGS.has(a)) i++; continue; }
    positional.push(a);
  }
}
const projectId = positional[0];
const change = positional[1];
const wantZip = process.argv.includes("--zip");
// Default = full trust (same criterion as dispatch.ts). --safe opts into restricted.
const yolo = !process.argv.includes("--safe");
const maxBudget = arg("--max-budget");
const timeoutMin = arg("--timeout");

if (!projectId || !change) {
  console.error('Uso: nrv revise <project_id> "<mudança>" [--zip] [--max-budget=<usd>] [--timeout=<min>] [--safe]');
  process.exit(4);   // EXIT.INVALID_ARGS — 2 now means WITHHELD (see the table above)
}

function appendAudit(payload: Record<string, any>, projectRoot?: string): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(harnessLogsDir({ cwd: projectRoot }), today);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n");
  } catch { /* non-fatal */ }
}

function readIfExists(p: string): string | null {
  try { return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null; } catch { return null; }
}

// Locate <project>/businesses/<slug>/session.json across the standard roots.
function findSessionFile(pid: string): string | null {
  const roots = [
    path.join(process.cwd(), "outputs", pid),            // new visible default
    path.join(os.homedir(), ".nirvana/outputs", pid),
    path.join(process.cwd(), ".nirvana/outputs", pid),
    path.join(os.homedir(), pid),
  ];
  for (const root of roots) {
    const bizRoot = path.join(root, "businesses");
    if (!fs.existsSync(bizRoot)) continue;
    for (const e of fs.readdirSync(bizRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const sf = path.join(bizRoot, e.name, "session.json");
      if (fs.existsSync(sf)) return sf;
    }
  }
  return null;
}

const sessionFile = findSessionFile(projectId);
if (!sessionFile) {
  console.error(c("red", `✗ session.json não encontrado para '${projectId}'.`));
  console.error("  Este projeto foi criado com 'nrv run' / 'nrv dispatch --exec'?");
  process.exit(1);
}
const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
const rt = session.runtime as Runtime;
const sessionId = session.session_id as string | null;
const slug = session.business_slug as string;
const projDir = session.project_dir as string;
const projectRoot = session.project_root as string;
const oroot = session.outputs_root as string;

if (!sessionId) {
  console.error(c("red", "✗ session.json sem session_id — não dá para retomar a conversa do runtime."));
  process.exit(1);
}

console.log("");
console.log(c("lime", "▶") + c("bold", ` nrv revise — ${projectId} (${rt})`));
console.log(c("dim", `  resume session: ${sessionId}`));

if (!runtimeAvailable(rt)) {
  console.error(c("red", `✗ runtime '${rt}' não está no PATH.`));
  process.exit(1);
}

const revisePrompt = [
  "INSTRUÇÃO DE REVISÃO (mesma sessão — você tem o contexto completo do que produziu):",
  "",
  change,
  "",
  `Reescreva/atualize os entregáveis como arquivos sob: ${oroot}`,
  'Não imprima resumo: entregue os arquivos atualizados. Atualize a seção "## Premissas assumidas" se algo mudou.',
].join("\n");

appendAudit({ event: "revision_requested", trace_id: projectId, project_id: projectId, business_slug: slug, runtime: rt, session_id: sessionId }, projectRoot);

const res = runHeadless({
  runtime: rt,
  prompt: revisePrompt,
  cwd: projDir,
  addDirs: [projectRoot],
  sessionId,
  appendSystemPrompt: AUTONOMOUS_DIRECTIVE,
  maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
  timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
  yolo,
});

// claude --resume can mint a fresh session id; persist whatever we got back.
if (res.sessionId && res.sessionId !== sessionId) {
  session.session_id = res.sessionId;
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
}
console.log(c("dim", `  ${res.durationMs}ms${res.costUsd != null ? ` · $${res.costUsd.toFixed(4)}` : ""}`));

// ── delivery (verify → gate → deliver) ────────────────────────────────────
//
// The SAME pipeline as the dispatch path and the supervisor. What lived here
// before was a private copy of both steps, and it failed open twice over: a
// 200-byte verify, a .md/.txt/.json-only gate, and an `allPass` flag that
// started at TRUE — so a revision producing only an .html, a PDF or an image
// was judged by nothing and still emitted `delivered` with gate:"pass". A real
// gate FAIL also emitted `delivered` (gate:"fail") before exiting 1. Phase 4
// closed exactly that at dispatch time; the route the WITHHELD message sends
// users to (`nrv revise <pid> "<fix>"`) kept it open.
//
// Revision budget: `nrv revise` is the human's own iteration loop, so the
// config budget applies — EXCEPT when the SUPERVISOR spawned us (NRV_IN_SWEEP=1,
// set by supervisor.ts defaultResume). An unattended launchd sweep runs every
// 120s; a revision loop there spends LLM money with nobody watching and can
// re-trigger on the next sweep. There the gate verdict goes straight back to
// the supervisor, which withholds and escalates to a human. Do NOT raise this
// number to "make recovery work": deliberate iteration is the human's call.
const inSweep = process.env.NRV_IN_SWEEP === "1";
const config = loadHarnessConfig();
const zipWanted = Boolean(session.zip_path) || wantZip;

/** Re-export the zip. Hangs off afterGate, so a WITHHELD delivery never
 *  refreshes the artifact a user might ship. */
function rezip(): string | null {
  if (!zipWanted) return null;
  const exportScript = path.join(SKILLS, "harness/scripts/export.ts");
  const out = (session.zip_path as string | null) || path.resolve(`./${projectId}.zip`);
  const z = spawnSync("bun", [exportScript, projectId, "--format=zip", "--deliverables-only", `--output=${out}`], { encoding: "utf8", stdio: "inherit" });
  if (z.status !== 0) return null;
  session.zip_path = out;
  fs.writeFileSync(sessionFile!, JSON.stringify(session, null, 2));
  return out;
}

const deliveryArgs = {
  // Only widens the deliverable floor for files named explicitly (see
  // delivery-pipeline briefNamedFiles); the change request is the closest
  // thing to a brief this script has when the project has no brief.md.
  brief: readIfExists(path.join(projectRoot, "brief.md")) ?? change,
  outputsRoot: oroot,
  // The dispatch records its --manifest in session.json, so a revision keeps
  // the completeness proof instead of silently falling back to the disk scan.
  // Older sessions predate the field: null there, and verify degrades as before.
  manifest: (typeof session.manifest === "string" && session.manifest) ? session.manifest : null,
  pid: projectId,
  slug,
  targetKind: "business",
  runtime: rt,
  projectDir: projDir,
  projectRoot,
  workingDir: process.cwd(),
  sessionId: (session.session_id as string | null) ?? sessionId,
  maxRevisions: inSweep ? 0 : config.quality_gate.max_revisions,
  maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
  timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
  yolo,
  config,
  ledger: null,                         // revise works off session.json, not the run ledger
  audit: (event, payload) => appendAudit({ event, ...payload, revision: true }, projectRoot),
  afterGate: () => ({ zipPath: rezip() }),
  onSession: (sid) => {
    session.session_id = sid;
    fs.writeFileSync(sessionFile!, JSON.stringify(session, null, 2));
  },
  verifyScript: path.join(SKILLS, "businesses/scripts/verify-deliverable.ts"),
  gateScript: path.join(SKILLS, "harness/scripts/quality-gate.ts"),
  log: (l) => console.log(c("dim", l)),
  warn: (l) => console.error(c("yellow", l)),
};

/** One outcome report for both doors: a clean revision and a salvaged one. */
function printOutcome(result: DeliveryResult): void {
  console.log("");
  if (result.exitCode === 0) {
    console.log(c("green", "✓ Revisão aplicada e entregue."));
  } else if (result.exitCode === 2) {
    console.log(c("yellow", "⚠ Revisão aplicada, entrega RETIDA — o quality gate reprovou (exit 2)."));
    console.log(c("dim", "  Os arquivos ficam no disco; nada foi marcado como entregue."));
  } else if (result.exitCode === 3) {
    console.log(c("yellow", "⚠ Entrega INDETERMINADA — nenhum artefato que o gate saiba julgar (exit 3)."));
    console.log(c("dim", "  Nada foi julgado, então nada foi entregue."));
  } else {
    console.log(c("red", "✗ Revisão sem entregável verificável."));
  }
  console.log(c("dim", `  Deliverables: ${oroot}`));
  if (result.zipPath) console.log(c("dim", `  Zip:          ${result.zipPath}`));
  console.log("");
}

if (!res.ok) {
  const runtimeError = `revision run: ${res.error || res.stderr || `exit ${res.exitCode}`}`;
  console.error(c("red", `✗ revisão falhou (exit ${res.exitCode}): ${res.error || res.stderr || "unknown"}`));
  appendAudit({ event: "revision_failed", trace_id: projectId, project_id: projectId, business_slug: slug, exit_code: res.exitCode, error: res.error || res.stderr }, projectRoot);
  // A failed revision does NOT mean nothing changed on disk: the usual case is
  // a limit hit after the edits were written. Judge what exists instead of
  // abandoning it — same policy the dispatch path applies (deliverAfterRuntimeError).
  // No artifacts -> the historical exit 1 stands.
  const outcome = deliverAfterRuntimeError({ ...deliveryArgs, runtimeError, errorContext: { revision: true } });
  if (!outcome.judged) process.exit(1);
  printOutcome(outcome.result!);
  process.exit(outcome.exitCode);
}

const result = runDelivery(deliveryArgs);
printOutcome(result);
process.exit(result.exitCode);
