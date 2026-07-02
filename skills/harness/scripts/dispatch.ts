#!/usr/bin/env bun
// dispatch.ts — one-command end-to-end dispatch of a Nirvana business.
//
// Wraps brief-business.ts + employee-prompt.ts + verify-deliverable.ts +
// quality-gate.ts so the user doesn't have to wire them manually.
//
// Usage:
//   nrv dispatch <business_slug> "<brief>"
//   nrv dispatch <business_slug> "<brief>" --manifest=paths.json --project=name --runtime=claude-code
//   nrv dispatch <business_slug> --brief-file=brief.md --manifest=paths.json
//
// What it does (atomic):
//   1. brief-business.ts <slug> "<brief>" [--manifest] [--project]
//   2. build full employee prompt with DNA injection
//   3. emit dispatch_business audit event
//   4. print actionable next step (copy-paste this into your Claude Code / Codex / Gemini)
//   5. (--exec mode, future) auto-invoke the runtime
//
// Exit codes:
//   0 = brief registered, prompt ready
//   1 = brief-business failed
//   2 = invalid args

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { runHeadless, runtimeAvailable, AUTONOMOUS_DIRECTIVE, type Runtime } from "../lib/host-agent-driver.ts";
import { amplify } from "../lib/amplifier.ts";
import { proxyEnrichBrief } from "../lib/brief-proxy.ts";
import { resolveRoutingMode } from "../../_shared/lib/routing-mode.ts";
import { runTeam } from "../lib/team-orchestrator.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { agenticRoute } from "../lib/agentic-router.ts";
import { runWithCascade } from "../lib/cascade-runner.ts";

const requireCjs = createRequire(import.meta.url);

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  lime: "\x1b[38;5;154m",
};

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.findIndex(a => a === name || a.startsWith(`${name}=`));
  if (i === -1) return fallback;
  const a = process.argv[i];
  if (a.includes("=")) return a.split("=").slice(1).join("=");
  return process.argv[i + 1] || fallback;
}

// Extract positionals WITHOUT swallowing space-form flag values. A naive
// filter(!startsWith("--")) treats the "X" in "--project X" as a positional,
// which made "--project caso-bruno" leak its value as the inline brief and
// override --brief-file. Skip the token after each known value-flag.
const VALUE_FLAGS = new Set(["--project", "--runtime", "--manifest", "--brief-file", "--outputs-root", "--max-budget", "--timeout", "--max-revisions"]);
function extractPositional(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (!a.includes("=") && VALUE_FLAGS.has(a)) i++; // skip its space-form value
      continue;
    }
    out.push(a);
  }
  return out;
}
const positional = extractPositional(process.argv.slice(2));
// --auto: no business is named; the router picks the best one for the brief.
// In that mode the first positional is the brief itself.
const autoMode = process.argv.includes("--auto");
// Routing mode (agentic default | fast). Precedence: --mode > env > config.
const routingMode = resolveRoutingMode(arg("--mode"));
let slug = autoMode ? "" : positional[0];
const inlineBrief = autoMode ? positional[0] : positional[1];
const briefFile = arg("--brief-file");
const manifest = arg("--manifest");
const projectId = arg("--project");
const runtime = arg("--runtime", "claude-code");  // future use
const outputsRoot = arg("--outputs-root");
const noColor = process.argv.includes("--no-color") || !process.stdout.isTTY;

function c(color: string, text: string): string {
  return noColor ? text : `${(ANSI as any)[color]}${text}${ANSI.reset}`;
}

// ── exec-mode flags ──────────────────────────────────────────────────────
function normRuntime(s: string): Runtime {
  const v = (s || "").toLowerCase();
  if (v === "claude" || v === "claude-code") return "claude-code";
  if (v === "codex") return "codex";
  if (v === "gemini" || v === "gemini-cli") return "gemini-cli";
  if (v === "agy" || v === "antigravity" || v === "antigravity-cli") return "antigravity-cli";
  return (s || "claude-code") as Runtime;
}
function resolveExecRuntime(): Runtime | null {
  const eq = process.argv.find(a => a.startsWith("--exec="));
  if (eq) return normRuntime(eq.split("=")[1]);
  if (process.argv.includes("--claude-code")) return "claude-code";
  if (process.argv.includes("--exec") || process.argv.includes("--run")) return normRuntime(runtime || "claude-code");
  return null;
}
const execRuntime = resolveExecRuntime();
const wantExec = execRuntime !== null;
const wantZip = process.argv.includes("--zip");
const wantPdf = process.argv.includes("--pdf");
// HTML report é DEFAULT (pulado só em modo fast ou com --no-html). --html fica
// como alias no-op para compat. --offline-snapshot inlina os assets CDN.
const skipHtml = routingMode === "fast" || process.argv.includes("--no-html");
// --team: harness-driven multi-employee orchestration (director + chain) instead
// of single-shot. Each employee runs as its own audited claude -p with DNA.
const wantTeam = process.argv.includes("--team");
const autoBriefEq = process.argv.find(a => a.startsWith("--auto-brief="));
const autoBriefMode = autoBriefEq ? autoBriefEq.split("=")[1] : (process.argv.includes("--auto-brief") ? "inferred" : null);
const wantAutoBrief = autoBriefMode !== null;
// Default = full trust (Bash habilitado, permissões puladas em todos os runtimes)
// para permitir que o agente delegue para colegas e entregue com qualidade.
// --safe opta pelo modo restrito antigo (allowlist + acceptEdits / workspace-write).
const safeMode = process.argv.includes("--safe");
const yolo = !safeMode;
const maxBudget = arg("--max-budget");
const timeoutMin = arg("--timeout");
const maxRevisions = parseInt(arg("--max-revisions") || "2", 10);

// auditRootCache lets us point at the project's <root>/.nirvana/logs/harness/
// as soon as we know projDir (after brief-business runs). Before that point
// we fall back to cwd-detection. Either way: never hardcode $HOME/.harness-logs.
let auditRootCache: string | null = null;
function appendAudit(payload: Record<string, any>): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const root = auditRootCache ?? harnessLogsDir();
    const dir = path.join(root, today);
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

function nonStubText(dir: string): string[] {
  return listFiles(dir).filter(f =>
    /\.(md|txt|json)$/i.test(f) && (() => { try { return fs.statSync(f).size >= 200; } catch { return false; } })()
  );
}

// Run the offline gate over each text artifact; collect fix lists for failures.
function runGateOnce(files: string[], gateScript: string): { pass: boolean; fails: { file: string; fixes: string[] }[] } {
  const fails: { file: string; fixes: string[] }[] = [];
  for (const f of files) {
    const g = spawnSync("bun", [gateScript, f, "--auto", "--offline"], { encoding: "utf8" });
    if (g.status !== 0) {
      const fixes: string[] = [];
      try {
        const v = JSON.parse(g.stdout);
        for (const r of v.results || []) if (!r.passed && !r.skipped) fixes.push(...(r.fix_list || []));
      } catch { /* keep empty */ }
      fails.push({ file: f, fixes });
    }
  }
  return { pass: fails.length === 0, fails };
}

if (!slug && !autoMode) {
  console.error("Uso: nrv dispatch <business_slug> \"<brief>\" [opts]");
  console.error("");
  console.error("  Opts:");
  console.error("    --brief-file=<path>     Brief em arquivo (alternativa ao inline)");
  console.error("    --manifest=<path>       deliverables.json (paths esperados)");
  console.error("    --project=<id>          Project ID custom (default: auto)");
  console.error("    --outputs-root=<dir>    Onde artefatos finais devem ser escritos");
  console.error("    --runtime=<name>        claude-code|codex|antigravity-cli|gemini-cli (default: claude-code)");
  console.error("");
  console.error("  Exec (autopilot):");
  console.error("    --auto                  sem nomear a empresa: o roteador escolhe a melhor para o brief");
  console.error("    --exec[=runtime]        executa o agente headless (sem isso, só scaffolda)");
  console.error("    --claude-code           atalho para --exec=claude-code");
  console.error("    --auto-brief            enriquece brief magro e decide pelo humano");
  console.error("    --zip                   empacota os entregáveis em ./<project>.zip");
    console.error("    --pdf                   gera relatorio-final.pdf via report-publisher (se o business tiver)");
    console.error("    --html                  gera relatorio-final.html com todos os markdowns do projeto (marked)");
  console.error("    --team                  orquestração multi-employee real (diretor + cadeia, cada step audita)");
  console.error("    --max-budget=<usd>      teto de custo do run (claude --max-budget-usd)");
  console.error("    --timeout=<min>         timeout do run (default 20)");
  console.error("    --safe                  opt-in modo restrito (tools limitadas + sandbox); default = full trust");
  console.error("");
  console.error("Exemplo:");
  console.error("  nrv dispatch brand-creative-studio \"Manifesto para produto X\"");
  console.error("  nrv run minha-marca \"caso de acidente\" --auto-brief --zip");
  process.exit(2);
}

let brief = inlineBrief;
if (!brief && briefFile) {
  if (!fs.existsSync(briefFile)) {
    console.error(c("red", `ERRO: --brief-file não encontrado: ${briefFile}`));
    process.exit(2);
  }
  brief = fs.readFileSync(briefFile, "utf8");
}
if (!brief) {
  console.error(c("red", "ERRO: forneça brief inline ou --brief-file"));
  process.exit(2);
}

// --auto: agentic routing. An LLM with Read+Bash+Grep inspects the brief AND
// the registries and returns {primary_business, mandatory_squads, optional_squads,
// rationale}. The user's explicit asks (a squad named in the brief, an empresa
// nameada) are ALWAYS honored. Mandatory squads flow into the team orchestrator.
let autoMandatorySquads: string[] = [];
if (autoMode && routingMode === "fast") {
  // fast mode: BM25 business pick, zero-token. Honest fallback when BM25 can't
  // confidently choose a business (most businesses lack auto_routes yet).
  console.log(c("lime", "▶") + c("bold", " Auto-route — fast (BM25, zero-token)"));
  let picked: string | null = null;
  let signal = "";
  try {
    const router = createRequire(import.meta.url)("../lib/router.js");
    const r = await router.route(brief, { prefer: "business" });
    const s3 = (r && r.stage3) || {};
    signal = String(s3.signal || "");
    const m = (s3.target && s3.target.meta) || {};
    if (m.type === "business_route") picked = m.slug || null;
    else if (m.type === "business") picked = m.slug || m.business || null;
    else if (typeof m.business === "string") picked = m.business;
  } catch (e: any) {
    console.error(c("yellow", `  fast route error: ${e?.message || e}`));
  }
  if (!picked) {
    console.error(c("red", `✗ --auto (fast): BM25 não escolheu uma empresa com confiança (sinal ${signal || "n/a"}; a maioria dos businesses ainda não tem auto_routes). Nomeie a empresa, ou use --mode=agentic.`));
    process.exit(1);
  }
  slug = picked;
  console.log(c("lime", "  →") + c("bold", ` ${slug}`) + c("dim", ` (BM25 · signal ${signal})`));
  appendAudit({ event: "auto_route_selected", project_id: projectId || null, business_slug: slug, method: "fast" });
} else if (autoMode) {
  // agentic (default): an LLM with Read+Bash+Grep inspects the brief AND the
  // registries and returns {primary_business, mandatory_squads, optional_squads,
  // rationale}. The user's explicit asks are ALWAYS honored.
  console.log(c("lime", "▶") + c("bold", " Auto-route — agentic"));
  const rt = execRuntime || normRuntime(runtime || "claude-code");
  const decision = await agenticRoute({
    brief, runtime: rt, cwd: process.cwd(), projectId: projectId || null,
    maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
    timeoutMs: 5 * 60 * 1000,
  });
  if (!decision.ok) {
    console.error(c("red", `✗ --auto: router agêntico não decidiu (${decision.error || "no decision"}). Nomeie a empresa ou o squad.`));
    process.exit(1);
  }
  if (!decision.primary_business) {
    // Squad-only route: the user named a squad (or the router judged a single
    // squad delivers the object on its own) — there is NO business to scaffold.
    // dispatch.ts is a BUSINESS dispatcher, so surface the decision and hand off
    // to the squad run path instead of forcing an empresa.
    if (decision.mandatory_squads.length) {
      console.log(c("lime", "  →") + c("bold", ` rota squad-only: ${decision.mandatory_squads.join(", ")}`));
      if (decision.rationale) console.log(c("dim", `  rationale: ${decision.rationale}`));
      appendAudit({ event: "auto_route_selected", project_id: projectId || null, business_slug: null, method: "agentic", squad_only: true, mandatory_squads: decision.mandatory_squads, optional_squads: decision.optional_squads });
      console.log(c("cyan", "\n  Rode o(s) squad(s) direto (sem empresa):"));
      for (const sq of decision.mandatory_squads) {
        console.log("    " + c("yellow", `nrv inspect-squad ${sq}`) + c("dim", "   # capabilities/workflows; execute o squad com seu brief"));
      }
      process.exit(0);
    }
    console.error(c("red", `✗ --auto: router não escolheu empresa nem squad (${decision.error || "no primary"}). Nomeie o alvo.`));
    process.exit(1);
  }
  slug = decision.primary_business;
  autoMandatorySquads = decision.mandatory_squads;
  const cost = decision.cost_usd != null ? ` · $${decision.cost_usd.toFixed(4)}` : "";
  console.log(c("lime", "  →") + c("bold", ` ${slug}`) + c("dim", ` (${decision.duration_ms}ms${cost})`));
  if (autoMandatorySquads.length) console.log(c("dim", `  mandatory squads: ${autoMandatorySquads.join(", ")}`));
  if (decision.optional_squads.length) console.log(c("dim", `  optional squads: ${decision.optional_squads.join(", ")}`));
  if (decision.rationale) console.log(c("dim", `  rationale: ${decision.rationale}`));
  appendAudit({ event: "auto_route_selected", project_id: projectId || null, business_slug: slug, method: "agentic", mandatory_squads: autoMandatorySquads, optional_squads: decision.optional_squads });
}

// --auto-brief: deterministically enrich a thin brief so the headless agent can
// decide for the human. Inferred assumptions are appended to the brief and the
// agent surfaces them under "Premissas assumidas" in the output (correct later
// via `nrv revise`).
if (wantAutoBrief) {
  if (autoBriefMode === "proxy" || autoBriefMode === "llm") {
    // LLM "informed client" — interviews + answers on the human's behalf.
    const pr = proxyEnrichBrief(brief, slug, normRuntime(runtime || "claude-code"), {
      maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
    });
    if (pr.ok && pr.enriched) {
      brief = pr.enriched;
      console.log(c("dim", `  [auto-brief=proxy] briefing enriquecido por proxy (${pr.enriched.length} chars)`));
      appendAudit({ event: "brief_proxy_enriched", business_slug: slug, chars: pr.enriched.length });
    } else {
      console.error(c("yellow", `  [auto-brief=proxy] falhou (${pr.error}); caindo para inferência determinística`));
      try {
        const decision = amplify(brief, { mode: "inferred" });
        if (decision.action === "infer") brief = decision.inferred_brief;
      } catch { /* keep raw brief */ }
    }
  } else {
    try {
      const decision = amplify(brief, { mode: "inferred" });
      if (decision.action === "infer") {
        brief = decision.inferred_brief;
        console.log(c("dim", `  [auto-brief] ${decision.assumptions.length} premissa(s) inferida(s); brief enriquecido`));
        appendAudit({ event: "brief_amplified", business_slug: slug, mode: "inferred", assumptions: decision.assumptions.length, score: decision.score.total });
      } else if (decision.action === "skip") {
        console.log(c("dim", `  [auto-brief] brief já rico (score ${decision.score.total}); sem inferência`));
      }
    } catch (e: any) {
      console.error(c("yellow", `  [auto-brief] amplifier falhou (${e?.message || e}); usando brief original`));
    }
  }
}

const SKILLS = process.env.NIRVANA_SKILLS_DIR || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));
const briefBiz = path.join(SKILLS, "businesses/scripts/brief-business.ts");
const employeePrompt = path.join(SKILLS, "businesses/lib/employee-prompt.ts");

if (!fs.existsSync(briefBiz)) {
  console.error(c("red", `ERRO: brief-business.ts não encontrado em ${briefBiz}`));
  console.error("Rode `nrv install --bootstrap` para reinstalar o Nirvana.");
  process.exit(1);
}

// Step 1 — brief-business
console.log(c("lime", "▶") + c("bold", " Step 1/4 — brief-business.ts"));
const args = [briefBiz, slug, brief];
if (projectId) args.push("--project", projectId);
if (manifest) args.push("--manifest", manifest);
const r1 = spawnSync("bun", args, { encoding: "utf8" });
if (r1.status !== 0) {
  console.error(c("red", "✗ brief-business failed:"));
  console.error(r1.stdout || r1.stderr);
  process.exit(1);
}
console.log(r1.stdout);

// Parse the output to extract Project ID + Intake + Project Dir
const stdout = r1.stdout;
const pid = stdout.match(/Project ID:\s+(\S+)/)?.[1];
const intake = stdout.match(/Intake:\s+(\S+)/)?.[1];
const projDir = stdout.match(/Project dir:\s+(\S+)/)?.[1];
if (!pid || !intake || !projDir) {
  console.error(c("red", "✗ Não consegui parsear output do brief-business"));
  process.exit(1);
}

// Step 2 — build employee prompt
console.log(c("lime", "▶") + c("bold", ` Step 2/4 — buildEmployeePrompt (${intake}@${slug})`));
// brief-business writes brief.md at the project root (parent of businesses/<slug>/), not inside the business subdir
const projectRoot = path.resolve(projDir, "..", "..");
// In exec mode the agent writes deliverables here (a clean subfolder export
// includes but the scaffold dirs handoffs/tickets/employees are excluded).
const execOutputsRoot = outputsRoot || (wantExec ? path.join(projDir, "deliverables") : undefined);
if (execOutputsRoot && wantExec) fs.mkdirSync(execOutputsRoot, { recursive: true });
const tmpBriefFile = path.join(projectRoot, "brief.md");
if (!fs.existsSync(tmpBriefFile)) {
  console.error(c("red", `✗ brief.md not found at ${tmpBriefFile}`));
  process.exit(1);
}
const buildArgs = [employeePrompt, slug, intake, projDir, tmpBriefFile];
if (execOutputsRoot) buildArgs.push(execOutputsRoot);
const r2 = spawnSync("bun", buildArgs, { encoding: "utf8" });
if (r2.status !== 0) {
  console.error(c("red", "✗ employee-prompt failed:"));
  console.error(r2.stderr);
  process.exit(1);
}

const outputPath = path.join(projDir, "agent-prompt.md");
fs.writeFileSync(outputPath, r2.stdout);

const promptSize = r2.stdout.length;
const dnaCount = (r2.stdout.match(/^--- MIND-CLONE:/gm) || []).length;
console.log(c("dim", `  Prompt: ${promptSize.toLocaleString()} chars · ${dnaCount} mind-clones injected`));
console.log(c("dim", `  Saved to: ${outputPath}`));

// Step 3 — dispatch_business audit event. From here on we know projDir, so
// pin auditRootCache to the project's logs dir; all subsequent appendAudit
// calls (and child processes that import paths.js) write there.
auditRootCache = harnessLogsDir({ cwd: projDir });
console.log(c("lime", "▶") + c("bold", " Step 3/4 — emit dispatch_business audit"));
const today = new Date().toISOString().slice(0, 10);
const globalDir = path.join(auditRootCache, today);
fs.mkdirSync(globalDir, { recursive: true });
const event = {
  ts: new Date().toISOString(),
  event: "dispatch_business",
  trace_id: pid,
  project_id: pid,
  business_slug: slug,
  employee: intake,
  // Honest mode: this standalone script either scaffolds only, or shells out to
  // a headless child runtime via --exec. The TRUE in-process subagent path is
  // the maestro calling the runtime's native subagent (Agent tool / codex
  // [agents] / antigravity dynamic subagents) — documented in the adapters,
  // NOT this script. So never claim "subagent-inline" here.
  mode: wantExec ? "headless-subprocess" : "scaffold-only",
  runtime,
  dna_files_injected: dnaCount,
  prompt_size_chars: promptSize,
};
fs.appendFileSync(path.join(globalDir, "audit.jsonl"), JSON.stringify(event) + "\n");
console.log(c("dim", `  ✓ dispatch_business written to ${globalDir}/audit.jsonl`));

// ── EXEC MODE — actually run the runtime headless, then verify+gate+zip ────
if (wantExec) {
  const rt = execRuntime as Runtime;
  const oroot = execOutputsRoot as string;

  console.log("");
  console.log(c("lime", "▶") + c("bold", ` Step 4/7 — exec ${wantTeam ? "team-chain" : "headless"} (${rt})`));
  if (!runtimeAvailable(rt)) {
    console.error(c("red", `✗ runtime '${rt}' não está no PATH. Instale-o ou use --runtime=claude-code.`));
    appendAudit({ event: "agent_exec_failed", trace_id: pid, project_id: pid, business_slug: slug, runtime: rt, reason: "runtime not on PATH" });
    process.exit(1);
  }

  // res = unified result shape consumed by Step 5+ below.
  let res: { ok: boolean; sessionId: string | null; durationMs: number; costUsd: number | null; exitCode?: number; error?: string; stderr?: string };

  if (wantTeam) {
    const tr = runTeam({
      slug, brief, projectId: pid, projectDir: projDir, projectRoot, outputsRoot: oroot,
      runtime: rt, intakeEmployee: intake,
      mandatorySquads: autoMandatorySquads,
      maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
      timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
    });
    if (!tr.ok) {
      console.error(c("red", `✗ team falhou: ${tr.error}`));
      appendAudit({ event: "agent_exec_failed", trace_id: pid, project_id: pid, business_slug: slug, runtime: rt, mode: "team", error: tr.error });
      process.exit(1);
    }
    console.log(c("green", `  ✓ time orquestrado: ${tr.chain.length} steps`));
    for (const s of tr.steps) {
      console.log(c("dim", `    · ${s.employee}: ${s.durationMs}ms${s.costUsd != null ? ` · $${s.costUsd.toFixed(4)}` : ""}`));
    }
    console.log(c("dim", `  total: ${tr.totalDurationMs}ms · $${tr.totalCostUsd.toFixed(4)}`));
    res = { ok: true, sessionId: tr.lastSessionId, durationMs: tr.totalDurationMs, costUsd: tr.totalCostUsd };
  } else {
    const agentPrompt = fs.readFileSync(outputPath, "utf8");
    // runWithCascade falls through to plain runHeadless when LLM_CASCADE is not set
    // in the project .env, so non-cascade users see no behavioral change.
    res = runWithCascade({
      runtime: rt,
      prompt: agentPrompt,
      cwd: projDir,
      addDirs: [projectRoot],
      appendSystemPrompt: AUTONOMOUS_DIRECTIVE,
      maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
      timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined,
      yolo,
      brief, projectRoot, outputsRoot: oroot,
      taskHint: `single-shot dispatch · ${slug}/${intake}`,
      projectId: pid,
    });
    if (!res.ok) {
      console.error(c("red", `✗ exec falhou (exit ${res.exitCode}): ${res.error || res.stderr || "unknown"}`));
      appendAudit({ event: "agent_exec_failed", trace_id: pid, project_id: pid, business_slug: slug, runtime: rt, exit_code: res.exitCode, error: res.error || res.stderr });
      process.exit(1);
    }
    console.log(c("dim", `  session: ${res.sessionId || "(none)"} · ${res.durationMs}ms${res.costUsd != null ? ` · $${res.costUsd.toFixed(4)}` : ""}`));
  }

  // session.json — lets `nrv revise` resume the same conversation and `nrv clean` find everything.
  const sessionFile = path.join(projDir, "session.json");
  const sessionData: Record<string, any> = {
    project_id: pid, business_slug: slug, employee: intake, runtime: rt,
    session_id: res.sessionId, project_dir: projDir, project_root: projectRoot,
    outputs_root: oroot, zip_path: null, created_at: new Date().toISOString(),
  };
  fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
  // In team mode each step emitted its own agent_executed; skip the parent-level
  // emit to avoid double counting. In single-shot mode, audit the parent run.
  if (!wantTeam) {
    appendAudit({ event: "agent_executed", trace_id: pid, project_id: pid, business_slug: slug, employee: intake, runtime: rt, session_id: res.sessionId, cost_usd: res.costUsd, duration_ms: res.durationMs });
  }

  // Advance HANDOFF to complete (one-shot autopilot).
  try {
    const { updateHandoffPhase } = requireCjs(path.join(SKILLS, "_shared", "lib", "handoff.js"));
    updateHandoffPhase(projDir, "complete", { lastTaskCompleted: "headless exec", decisions: [`autopilot run via ${rt}`] });
  } catch { /* non-fatal */ }

  // Step 5 — verify: at least one non-stub deliverable on disk.
  console.log(c("lime", "▶") + c("bold", " Step 5/7 — verify deliverables"));
  const produced = listFiles(oroot).filter(f => { try { return fs.statSync(f).size >= 200; } catch { return false; } });
  if (produced.length === 0) {
    console.error(c("red", `✗ nenhum entregável não-stub em ${oroot}`));
    appendAudit({ event: "verify_failed", trace_id: pid, project_id: pid, business_slug: slug, outputs_root: oroot });
    process.exit(1);
  }
  console.log(c("green", `  ✓ ${produced.length} arquivo(s) entregue(s)`));
  appendAudit({ event: "verify_passed", trace_id: pid, project_id: pid, business_slug: slug, files: produced.length });

  // Step 6 — quality gate with bounded auto-revision (loop until pass per the
  // protocol: revise → re-judge → repeat, capped at --max-revisions).
  console.log(c("lime", "▶") + c("bold", " Step 6/7 — quality gate"));
  const gateScript = path.join(SKILLS, "harness/scripts/quality-gate.ts");
  let textFiles = nonStubText(oroot);
  let gate = runGateOnce(textFiles, gateScript);
  let revUsed = 0;
  while (!gate.pass && revUsed < maxRevisions) {
    revUsed++;
    console.log(c("yellow", `  ⚠ gate FAIL — auto-revisão ${revUsed}/${maxRevisions}`));
    const fixLines = gate.fails.flatMap(fl => [`Arquivo ${path.basename(fl.file)}:`, ...fl.fixes.map(x => `  - ${x}`)]);
    const fixPrompt = [
      "O quality gate reprovou os entregáveis. Corrija EXATAMENTE estes pontos, reescrevendo os arquivos no mesmo caminho:",
      "",
      ...fixLines,
      "",
      "Regra de hífen (a mais comum): use '-' só para palavras compostas; nunca para emendar orações nem como travessão — troque por vírgula, dois-pontos ou ponto.",
      "Não imprima resumo: entregue os arquivos corrigidos.",
    ].join("\n");
    const rr = runHeadless({
      runtime: rt, prompt: fixPrompt, cwd: projDir, addDirs: [projectRoot],
      sessionId: res.sessionId || undefined, appendSystemPrompt: AUTONOMOUS_DIRECTIVE,
      maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
      timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined, yolo,
    });
    appendAudit({ event: "revision_auto", trace_id: pid, project_id: pid, business_slug: slug, attempt: revUsed, ok: rr.ok });
    if (rr.sessionId) { res.sessionId = rr.sessionId; sessionData.session_id = rr.sessionId; fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2)); }
    textFiles = nonStubText(oroot);
    gate = runGateOnce(textFiles, gateScript);
  }
  const allPass = gate.pass;
  console.log(allPass
    ? c("green", `  ✓ gate PASS (${textFiles.length} arquivo(s)${revUsed ? `, após ${revUsed} revisão(ões)` : ""})`)
    : c("yellow", `  ⚠ gate ainda FAIL após ${revUsed} revisão(ões) — rode 'nrv revise ${pid} "<ajuste>"'`));
  appendAudit({ event: allPass ? "gate_passed" : "gate_failed", trace_id: pid, project_id: pid, business_slug: slug, files: textFiles.length, revisions: revUsed });

  // Step 6.5 — optional PDF report. The report-publisher employee (LLM, no shell)
  // writes relatorio/resumo-executivo.md + relatorio/order.json; the harness then
  // runs the business's build-report-pdf.ts to produce relatorio-final.pdf inside
  // deliverables/ (so it lands in the --deliverables-only zip).
  if (wantPdf) {
    // Build script: the business's own (if it ships one) else the shared harness
    // script. Publisher: the business's report-publisher employee (if any) else a
    // generic inline publisher prompt. So --pdf works for ANY business.
    const bizHome = path.join(os.homedir(), "businesses", slug);
    const bizBuild = path.join(bizHome, "scripts", "build-report-pdf.ts");
    const buildScript = fs.existsSync(bizBuild) ? bizBuild : path.join(SKILLS, "harness/scripts/build-report-pdf.ts");
    const pubEmployee = path.join(bizHome, "employees", "report-publisher.md");
    const hasPublisher = fs.existsSync(pubEmployee);
    if (!fs.existsSync(buildScript)) {
      console.log(c("yellow", `  ⚠ --pdf: build-report-pdf.ts não encontrado; pulando PDF`));
    } else {
      console.log(c("lime", "▶") + c("bold", ` Step 6.5 — relatório PDF (${hasPublisher ? "report-publisher" : "publisher genérico"})`));
      const relatorioDir = path.join(projDir, "relatorio");
      fs.mkdirSync(relatorioDir, { recursive: true });
      const summaryPath = path.join(relatorioDir, "resumo-executivo.md");
      const orderPath = path.join(relatorioDir, "order.json");
      const pubBrief = [
        "Você é o publicador do relatório final. Compile a entrega.",
        `Leia TODOS os arquivos .md em: ${oroot}`,
        "",
        "Escreva EXATAMENTE dois arquivos (use a ferramenta Write, não rode shell):",
        `1. ${summaryPath} — resumo executivo fiel (markdown), que vai na capa do PDF.`,
        `2. ${orderPath} — JSON: {"title": "...", "subtitle": "...", "client": "...", "summary_file": "${summaryPath}", "order": ["arquivo1.md", "arquivo2.md", ...]}`,
        "   - order = nomes dos .md em " + oroot + " na sequência ideal (resposta direta primeiro, depois análise, base e anexos).",
        "Não invente conclusão nem fonte. Apenas sintetize e ordene.",
      ].join("\n");
      const pubBriefFile = path.join(relatorioDir, ".publisher-brief.md");
      fs.writeFileSync(pubBriefFile, pubBrief);

      // Prompt: DNA-injected employee persona if the business has one, else the
      // self-contained generic brief above.
      let pubPrompt = pubBrief;
      if (hasPublisher) {
        const ep = spawnSync("bun", [employeePrompt, slug, "report-publisher", projDir, pubBriefFile, relatorioDir], { encoding: "utf8" });
        if (ep.status === 0 && ep.stdout) pubPrompt = ep.stdout;
        else console.error(c("yellow", `  ⚠ prompt do report-publisher falhou; usando publisher genérico`));
      }
      {
        const pubRes = runHeadless({
          runtime: rt, prompt: pubPrompt, cwd: projDir, addDirs: [projectRoot],
          appendSystemPrompt: AUTONOMOUS_DIRECTIVE,
          maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
          timeoutMs: timeoutMin ? parseInt(timeoutMin, 10) * 60 * 1000 : undefined, yolo,
        });
        appendAudit({ event: "report_publisher_ran", trace_id: pid, project_id: pid, business_slug: slug, ok: pubRes.ok, publisher: hasPublisher ? "employee" : "generic" });

        // Assemble the PDF into deliverables/ so the zip includes it.
        const pdfOut = path.join(oroot, "relatorio-final.pdf");
        const buildArgs = [buildScript, "--deliverables", oroot, "--output", pdfOut];
        if (fs.existsSync(summaryPath)) buildArgs.push("--summary", summaryPath);
        let title = `Relatório — ${pid}`, subtitle = "", clientName = "", brand = slug;
        if (fs.existsSync(orderPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(orderPath, "utf8"));
            if (Array.isArray(meta.order) && meta.order.length) buildArgs.push("--order", meta.order.join(","));
            if (meta.title) title = meta.title;
            if (meta.subtitle) subtitle = meta.subtitle;
            if (meta.client) clientName = meta.client;
            if (meta.brand) brand = meta.brand;
          } catch { /* use defaults */ }
        }
        buildArgs.push("--title", title, "--brand", brand);
        if (subtitle) buildArgs.push("--subtitle", subtitle);
        if (clientName) buildArgs.push("--client", clientName);
        const pdf = spawnSync("bun", buildArgs, { encoding: "utf8" });
        if (pdf.status === 0 && fs.existsSync(pdfOut)) {
          console.log(c("green", `  ✓ PDF: ${pdfOut} (${(fs.statSync(pdfOut).size / 1024).toFixed(1)} KB)`));
          appendAudit({ event: "report_pdf_generated", trace_id: pid, project_id: pid, business_slug: slug, output: pdfOut });
        } else {
          console.error(c("yellow", `  ⚠ build-report-pdf falhou: ${(pdf.stdout || "") + (pdf.stderr || "")}`));
        }
      }
    }
  }

  // Step 6.6 — relatório HTML (DEFAULT; pulado só em modo fast ou com --no-html).
  // Renderiza todo markdown do projeto num HTML estilo Apple. Cai em deliverables/
  // para o bundle --zip carregar. --offline-snapshot gera uma cópia 100% offline.
  if (!skipHtml) {
    console.log(c("lime", "▶") + c("bold", " Step 6.6 — relatório HTML"));
    const htmlBuild = path.join(SKILLS, "harness/scripts/build-report-html.ts");
    const htmlOut = path.join(oroot, "relatorio-final.html");
    const htmlArgs = [htmlBuild, "--project", projDir, "--output", htmlOut, "--title", `Relatório — ${slug}`];
    if (process.argv.includes("--offline-snapshot")) htmlArgs.push("--offline-snapshot");
    const h = spawnSync("bun", htmlArgs, { encoding: "utf8", stdio: "inherit" });
    if (h.status === 0) appendAudit({ event: "report_html_generated", trace_id: pid, project_id: pid, business_slug: slug, output: htmlOut });
    else console.error(c("yellow", `  ⚠ build-report-html falhou (rc=${h.status})`));
  } else if (routingMode === "fast") {
    appendAudit({ event: "report_skipped_fast", trace_id: pid, project_id: pid, business_slug: slug });
  }

  // Step 7 — export .zip
  let zipPath: string | null = null;
  if (wantZip) {
    console.log(c("lime", "▶") + c("bold", " Step 7/7 — export .zip"));
    const exportScript = path.join(SKILLS, "harness/scripts/export.ts");
    const out = path.resolve(`./${pid}.zip`);
    const z = spawnSync("bun", [exportScript, pid, "--format=zip", "--deliverables-only", `--output=${out}`], { encoding: "utf8", stdio: "inherit" });
    if (z.status === 0) {
      zipPath = out;
      sessionData.zip_path = out;
      fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
    } else {
      console.error(c("yellow", "  ⚠ export falhou (entregáveis estão na pasta do projeto)"));
    }
  }

  appendAudit({ event: "delivered", trace_id: pid, project_id: pid, business_slug: slug, files: produced.length, gate: allPass ? "pass" : "fail", zip: zipPath });

  console.log("");
  console.log(c("green", "✓ Autopilot completo."));
  console.log(c("dim", `  Project ID:   ${pid}`));
  console.log(c("dim", `  Deliverables: ${oroot}`));
  if (zipPath) console.log(c("dim", `  Zip:          ${zipPath}`));
  console.log("");
  console.log(c("cyan", "  Pedir alterações (mantém a sessão):"));
  console.log("    " + c("yellow", `nrv revise ${pid} "<mudança>"`));
  console.log(c("cyan", "  Limpar todo o scaffold:"));
  console.log("    " + c("yellow", `nrv clean ${pid}`));
  console.log("");
  // Deliverables + zip are on disk; exit 0. Gate status is in the output above
  // and the audit log (gate_passed / gate_failed) for scripted callers.
  process.exit(0);
}

// Step 4 — actionable next step
console.log("");
console.log(c("lime", "▶") + c("bold", " Step 4/4 — next steps"));
console.log("");
console.log(c("cyan", "  Copie o prompt completo e cole no seu runtime:"));
console.log("");
console.log("    " + c("yellow", `cat ${outputPath} | pbcopy        # macOS`));
console.log("    " + c("yellow", `cat ${outputPath} | xclip         # Linux`));
console.log("    " + c("yellow", `type ${outputPath} | clip         # Windows`));
console.log("");
console.log(c("cyan", "  Ou abra o cockpit:"));
console.log("    " + c("yellow", `nrv glance --allow-actions`));
console.log("");
console.log(c("cyan", "  Para validar quando terminar:"));
console.log("    " + c("yellow", `bun ~/.nirvana/skills/businesses/scripts/verify-deliverable.ts ${pid} ${slug}`));
console.log("    " + c("yellow", `bun ~/.nirvana/skills/harness/scripts/validate-chain.ts ${pid} --strict`));
console.log("");
console.log(c("green", "✓ Ready. Project ID: " + pid));

process.exit(0);
