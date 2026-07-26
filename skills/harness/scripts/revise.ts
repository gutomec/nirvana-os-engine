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
// Exit codes: 0 = revised + gate pass · 1 = failed or gate fail · 2 = bad args

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { runHeadless, runtimeAvailable, AUTONOMOUS_DIRECTIVE, type Runtime } from "../lib/host-agent-driver.ts";
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
// Default = full trust (mesmo critério do dispatch.ts). --safe opta pelo restrito.
const yolo = !process.argv.includes("--safe");
const maxBudget = arg("--max-budget");
const timeoutMin = arg("--timeout");

if (!projectId || !change) {
  console.error('Uso: nrv revise <project_id> "<mudança>" [--zip] [--max-budget=<usd>] [--timeout=<min>] [--safe]');
  process.exit(2);
}

function appendAudit(payload: Record<string, any>, projectRoot?: string): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(harnessLogsDir({ cwd: projectRoot }), today);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n");
  } catch { /* non-fatal */ }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

// Locate <project>/businesses/<slug>/session.json across the standard roots.
function findSessionFile(pid: string): string | null {
  const roots = [
    path.join(process.cwd(), "outputs", pid),            // novo default visível
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

if (!res.ok) {
  console.error(c("red", `✗ revisão falhou (exit ${res.exitCode}): ${res.error || res.stderr || "unknown"}`));
  appendAudit({ event: "revision_failed", trace_id: projectId, project_id: projectId, business_slug: slug, exit_code: res.exitCode, error: res.error || res.stderr }, projectRoot);
  process.exit(1);
}
// claude --resume can mint a fresh session id; persist whatever we got back.
if (res.sessionId && res.sessionId !== sessionId) {
  session.session_id = res.sessionId;
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
}
console.log(c("dim", `  ${res.durationMs}ms${res.costUsd != null ? ` · $${res.costUsd.toFixed(4)}` : ""}`));

// verify
const produced = listFiles(oroot).filter(f => { try { return fs.statSync(f).size >= 200; } catch { return false; } });
if (produced.length === 0) {
  console.error(c("red", `✗ nenhum entregável não-stub em ${oroot} após a revisão`));
  appendAudit({ event: "verify_failed", trace_id: projectId, project_id: projectId, business_slug: slug }, projectRoot);
  process.exit(1);
}
appendAudit({ event: "verify_passed", trace_id: projectId, project_id: projectId, business_slug: slug, files: produced.length }, projectRoot);

// gate
const gateScript = path.join(SKILLS, "harness/scripts/quality-gate.ts");
const textFiles = produced.filter(f => /\.(md|txt|json)$/i.test(f));
let allPass = true;
for (const f of textFiles) {
  const g = spawnSync("bun", [gateScript, f, "--auto", "--offline"], { encoding: "utf8" });
  if (g.status !== 0) allPass = false;
}
console.log(allPass ? c("green", `  ✓ gate PASS (${textFiles.length} arquivo(s))`) : c("yellow", `  ⚠ gate FAIL em ao menos 1 arquivo`));
appendAudit({ event: allPass ? "gate_passed" : "gate_failed", trace_id: projectId, project_id: projectId, business_slug: slug, files: textFiles.length }, projectRoot);

// re-zip if it was zipped before or --zip given
let zipPath: string | null = session.zip_path || null;
if (zipPath || wantZip) {
  const exportScript = path.join(SKILLS, "harness/scripts/export.ts");
  const out = zipPath || path.resolve(`./${projectId}.zip`);
  const z = spawnSync("bun", [exportScript, projectId, "--format=zip", "--deliverables-only", `--output=${out}`], { encoding: "utf8", stdio: "inherit" });
  if (z.status === 0) { zipPath = out; session.zip_path = out; fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2)); }
}

appendAudit({ event: "delivered", trace_id: projectId, project_id: projectId, business_slug: slug, files: produced.length, gate: allPass ? "pass" : "fail", zip: zipPath, revision: true }, projectRoot);

console.log("");
console.log(c("green", "✓ Revisão aplicada."));
console.log(c("dim", `  Deliverables: ${oroot}`));
if (zipPath) console.log(c("dim", `  Zip:          ${zipPath}`));
console.log("");
process.exit(allPass ? 0 : 1);
