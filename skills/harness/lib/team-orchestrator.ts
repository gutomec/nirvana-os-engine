#!/usr/bin/env bun
// team-orchestrator.ts — harness-driven multi-employee chain for a business.
//
// Solves the "single LLM single-shot" failure: instead of trusting the intake
// employee to delegate via Bash (which it almost never does), the harness
// itself decides the chain and runs each specialist as a separate claude -p
// with DNA-injected persona. Each step audits dispatch_business +
// mind_clone_injected + agent_executed — provable orchestration.
//
// Flow:
//   1. Director call (cheap, tool-less LLM): given the brief + the list of
//      employees of this business, returns the ordered chain {employee,task}.
//   2. Sequential executor: for each step, builds the employee prompt via
//      employee-prompt.ts (full DNA injection), runs runHeadless, captures
//      outputs into _team/<employee>/. The LAST step is the intake/synthesizer
//      and writes the FINAL deliverables to outputs_root.
//   3. Returns the last session_id (used by `nrv revise`).

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { runHeadless, AUTONOMOUS_DIRECTIVE, type Runtime } from "./host-agent-driver.ts";
import { runWithCascade } from "./cascade-runner.ts";
import { sessionKey, getSession, putSession, dropSession, type EntityKind } from "./session-store.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { runSquadHeadless } from "./squad-exec.ts";

const SKILLS = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));
const BUSINESSES = path.join(os.homedir(), "businesses");

export interface TeamRunArgs {
  slug: string;
  brief: string;
  projectId: string;
  projectDir: string;
  projectRoot: string;
  outputsRoot: string;
  runtime: Runtime;
  intakeEmployee: string;
  /** Squads the user explicitly asked for (from the agentic router). Each runs
   * as `nrv dispatch <slug> "<task>" --exec` right before the synthesizer; its
   * outputs land under <outputsRoot>/_squads/<slug>/ for the synthesizer to
   * read. Each emits dispatch_squad in the audit. */
  mandatorySquads?: string[];
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** The user's USE_* rules block (formatRulesForDirective) — appended to each
   * step's AUTONOMOUS_DIRECTIVE so the maestro honors it when delegating. */
  rulesDirective?: string;
}

export interface ChainStep { employee: string; task: string; }
export interface StepResult { employee: string; ok: boolean; sessionId: string | null; costUsd: number | null; durationMs: number; outputsDir: string; }
export interface TeamResult { ok: boolean; steps: StepResult[]; chain: ChainStep[]; lastSessionId: string | null; totalCostUsd: number; totalDurationMs: number; error?: string; }

function appendAudit(payload: Record<string, any>, projectRoot?: string): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(harnessLogsDir({ cwd: projectRoot }), today);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n");
  } catch { /* non-fatal */ }
}

function listEmployees(slug: string): { name: string; role: string; description: string }[] {
  const dir = path.join(BUSINESSES, slug, "employees");
  if (!fs.existsSync(dir)) return [];
  const out: { name: string; role: string; description: string }[] = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const content = fs.readFileSync(path.join(dir, f), "utf8");
    const fm = content.match(/^---[\s\S]*?^---/m)?.[0] || content.slice(0, 2000);
    const name = fm.match(/^name:\s*(\S+)/m)?.[1] || path.basename(f, ".md");
    const role = (fm.match(/^role:\s*(.+)$/m)?.[1] || "").trim();
    const dm = fm.match(/^description:\s*["']?([\s\S]+?)["']?\s*$/m) || fm.match(/^description:\s*>?-?\s*\n((?:\s+.+\n?)+)/m);
    const description = (dm?.[1] || "").replace(/\s+/g, " ").trim().slice(0, 400);
    out.push({ name, role, description });
  }
  return out;
}

function pickChain(args: TeamRunArgs): ChainStep[] {
  const employees = listEmployees(args.slug);
  if (employees.length <= 1) return [{ employee: args.intakeEmployee, task: "Execute o brief de ponta a ponta. Você é o único employee deste business." }];

  const list = employees.map(e => `- ${e.name} (${e.role}): ${e.description}`).join("\n");
  const prompt = [
    `Você é o diretor de orquestração do business "${args.slug}". Sua única função é decidir a cadeia ideal de employees para executar o brief abaixo com QUALIDADE NIRVANA — o melhor que existe.`,
    "",
    "PREMISSA FUNDAMENTAL: nada nas coxas. A cadeia deve ativar os especialistas certos e cada sub-tarefa deve mandar o employee USAR o que há de melhor disponível (geradores de imagem reais como `nano-banana-pro` ou `image2-virtuoso`, bibliotecas modernas de primeiríssima via CDN confiável, dispatchar outros squads do registry quando fizer sentido). Nunca peça SVG genérico para visual, nunca improvise no que um especialista faz melhor.",
    "",
    "BRIEF DO CLIENTE:",
    args.brief,
    "",
    "EMPLOYEES DISPONÍVEIS:",
    list,
    "",
    `REGRAS:`,
    `- "${args.intakeEmployee}" é o intake/synthesizer e DEVE ser o ÚLTIMO da cadeia (consolida os outputs dos colegas em entregáveis finais).`,
    `- Inclua de 3 a 6 employees na cadeia (incluindo o synthesizer). Pule employees irrelevantes ao brief.`,
    `- Ordene pela dependência lógica: quem dá o input vem antes de quem precisa dele.`,
    `- Cada sub-tarefa deve mandar o employee usar os melhores recursos disponíveis para o seu tipo de output (imagens reais, bibliotecas atuais, especialistas externos quando aplicável).`,
    "",
    'Responda APENAS um JSON válido: {"chain":[{"employee":"<nome-exato>","task":"<sub-tarefa em 1-2 frases, citando que ferramentas/recursos top usar quando aplicável>"}, ...]}',
    "Sem markdown, sem cercas, sem comentário antes ou depois.",
  ].join("\n");

  appendAudit({ event: "team_director_called", project_id: args.projectId, business_slug: args.slug, employees_available: employees.length }, args.projectRoot);
  const res = runHeadless({
    runtime: args.runtime, prompt, cwd: os.tmpdir(),
    allowedTools: [], permissionMode: "default",
    timeoutMs: 5 * 60 * 1000,
  });
  const txt = (res.result || "").trim();
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`director returned no JSON: ${txt.slice(0, 200)}`);
  let parsed: any;
  try { parsed = JSON.parse(m[0]); } catch (e: any) { throw new Error(`invalid director JSON: ${e.message}`); }
  if (!Array.isArray(parsed.chain) || !parsed.chain.length) throw new Error("director retornou cadeia vazia");

  const known = new Set(employees.map(e => e.name));
  let chain: ChainStep[] = parsed.chain
    .filter((s: any) => s && typeof s.employee === "string" && known.has(s.employee))
    .map((s: any) => ({ employee: s.employee, task: String(s.task || "Execute sua especialidade aplicada ao brief.").trim() }));
  if (!chain.length) throw new Error("director picked no valid employee");
  if (chain[chain.length - 1].employee !== args.intakeEmployee) {
    chain.push({ employee: args.intakeEmployee, task: `Síntese final: leia os outputs dos colegas em _team/* e consolide os ENTREGÁVEIS FINAIS sob ${args.outputsRoot}. Cite premissas em "## Premissas assumidas".` });
  }
  return chain;
}

/**
 * Runs through the cascade RESUMING this entity's previous session in this project.
 *
 * Why it exists: without this, the same business (or squad) called twice in the
 * same project restarts cold and rebuilds what it already knew. The gain is not
 * speed — it is the agent staying the same agent.
 *
 * The fallback is the part that cannot be missing: the driver passes `--resume <id>`
 * and does NOT handle an invalid id. A session expired, deleted by the CLI or from
 * another machine would fail a dispatch that works today. So: if the run failed AND
 * we had passed an id, drop the id and retry ONCE cold. This way reuse can only
 * improve the result, never degrade it — the worst case is today's behavior.
 */
function runWithSession(
  kind: EntityKind,
  slug: string,
  args: TeamRunArgs,
  cascadeArgs: Parameters<typeof runWithCascade>[0],
): ReturnType<typeof runWithCascade> {
  const key = sessionKey(args.runtime, kind, slug);
  const prior = getSession(args.projectDir, key);

  let res = runWithCascade(prior ? { ...cascadeArgs, sessionId: prior } : cascadeArgs);

  if (!res.ok && prior) {
    // The session may have died outside our control. There is no reliable way
    // to tell "invalid resume" from "the task failed" by the error text across
    // 6 runtimes, so the policy is simple and safe: one cold attempt before
    // giving up.
    appendAudit({
      event: "session_resume_failed", trace_id: args.projectId, project_id: args.projectId,
      business_slug: args.slug, entity: `${kind}:${slug}`, runtime: args.runtime, session_id: prior,
    }, args.projectRoot);
    dropSession(args.projectDir, key);
    res = runWithCascade(cascadeArgs);
  } else if (prior && res.ok) {
    appendAudit({
      event: "session_resumed", trace_id: args.projectId, project_id: args.projectId,
      business_slug: args.slug, entity: `${kind}:${slug}`, runtime: args.runtime, session_id: prior,
    }, args.projectRoot);
  }

  putSession(args.projectDir, key, res.finalRuntime ?? args.runtime, res.sessionId);
  return res;
}

function runStep(step: ChainStep, idx: number, total: number, args: TeamRunArgs, priorOutputs: { employee: string; dir: string }[]): StepResult {
  const isLast = idx === total - 1;
  const employeeOutDir = isLast ? args.outputsRoot : path.join(args.outputsRoot, "_team", step.employee);
  fs.mkdirSync(employeeOutDir, { recursive: true });

  const priorBlock = priorOutputs.length
    ? "## Outputs dos colegas (leia antes de produzir o seu)\n" + priorOutputs.map(p => `- **${p.employee}** → ${p.dir}`).join("\n") + "\n\n"
    : "";
  const outputInstr = isLast
    ? `## Saída\nEscreva os ENTREGÁVEIS FINAIS como arquivos sob: \`${args.outputsRoot}\`\nLeia tudo que os colegas produziram em \`_team/*\` e consolide. Cite as premissas em "## Premissas assumidas" no entregável principal. NÃO duplique trabalho dos colegas — sintetize, refine, complete.`
    : `## Saída\nEscreva o SEU trabalho como arquivos Markdown bem nomeados sob: \`${employeeOutDir}\`\nUm ou mais arquivos com sua análise + entregável da sua especialidade. Os colegas seguintes vão ler para continuar — escreva pensando neles.`;

  const stepBrief = [
    `# Tarefa para ${step.employee} — step ${idx + 1} de ${total}`,
    "",
    "## Sua sub-tarefa nesta cadeia",
    step.task,
    "",
    "## Brief original do cliente",
    args.brief,
    "",
    priorBlock + outputInstr,
  ].join("\n");

  const stepBriefFile = path.join(employeeOutDir, ".step-brief.md");
  fs.writeFileSync(stepBriefFile, stepBrief);

  const ep = spawnSync("bun", [
    path.join(SKILLS, "businesses/lib/employee-prompt.ts"),
    args.slug, step.employee, args.projectDir, stepBriefFile, employeeOutDir,
  ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (ep.status !== 0) {
    appendAudit({ event: "team_step_failed", project_id: args.projectId, business_slug: args.slug, employee: step.employee, reason: "employee-prompt build failed", error: ep.stderr?.slice(0, 500) }, args.projectRoot);
    return { employee: step.employee, ok: false, sessionId: null, costUsd: null, durationMs: 0, outputsDir: employeeOutDir };
  }

  appendAudit({ event: "dispatch_business", trace_id: args.projectId, project_id: args.projectId, business_slug: args.slug, employee: step.employee, mode: "team-step", step: idx + 1, total }, args.projectRoot);

  const res = runWithSession("employee", step.employee, args, {
    runtime: args.runtime, prompt: ep.stdout, cwd: args.projectDir, addDirs: [args.projectRoot],
    appendSystemPrompt: AUTONOMOUS_DIRECTIVE + (args.rulesDirective ?? ""),
    maxBudgetUsd: args.maxBudgetUsd, timeoutMs: args.timeoutMs,
    brief: args.brief, projectRoot: args.projectRoot, outputsRoot: employeeOutDir,
    taskHint: `team-step ${idx + 1}/${total} (${step.employee})`,
    projectId: args.projectId,
  });

  appendAudit({
    event: "agent_executed", trace_id: args.projectId, project_id: args.projectId, business_slug: args.slug,
    employee: step.employee, runtime: res.finalRuntime, session_id: res.sessionId,
    cost_usd: res.costUsd, duration_ms: res.durationMs, mode: "team-step", step: idx + 1, total,
    handoffs: res.handoffs.length ? res.handoffs : undefined,
  }, args.projectRoot);

  return { employee: step.employee, ok: res.ok, sessionId: res.sessionId, costUsd: res.costUsd, durationMs: res.durationMs, outputsDir: employeeOutDir };
}

/** Run a mandatory squad as a sub-task of this business chain. The squad
 * headless runner (prompt build, clone injection, session reuse, audit chain)
 * lives in squad-exec.ts (routing-360 Phase 4.1 extraction) — this is a thin
 * adapter that keeps the team-mode contract: writes to
 * <outputsRoot>/_squads/<slug>/, emits dispatch_squad (mode: team-mandatory)
 * + agent_executed (mode: squad-mandatory). */
function runMandatorySquad(squadSlug: string, args: TeamRunArgs): StepResult {
  const outDir = path.join(args.outputsRoot, "_squads", squadSlug);
  const r = runSquadHeadless({
    squadSlug,
    brief: args.brief,
    projectId: args.projectId,
    projectDir: args.projectDir,
    projectRoot: args.projectRoot,
    outputsDir: outDir,
    runtime: args.runtime,
    businessSlug: args.slug,
    mode: "team-mandatory",
    maxBudgetUsd: args.maxBudgetUsd,
    timeoutMs: args.timeoutMs,
    rulesDirective: args.rulesDirective,
    autonomousDirective: AUTONOMOUS_DIRECTIVE,
  });
  return { employee: `squad:${squadSlug}`, ok: r.ok, sessionId: r.sessionId, costUsd: r.costUsd, durationMs: r.durationMs, outputsDir: r.outputsDir };
}

export function runTeam(args: TeamRunArgs): TeamResult {
  let chain: ChainStep[];
  try { chain = pickChain(args); }
  catch (e: any) {
    appendAudit({ event: "team_director_failed", project_id: args.projectId, business_slug: args.slug, error: e?.message || String(e) }, args.projectRoot);
    return { ok: false, steps: [], chain: [], lastSessionId: null, totalCostUsd: 0, totalDurationMs: 0, error: `director: ${e?.message || e}` };
  }
  appendAudit({ event: "team_chain_selected", project_id: args.projectId, business_slug: args.slug, chain: chain.map(s => ({ employee: s.employee, task: s.task.slice(0, 120) })) }, args.projectRoot);

  const steps: StepResult[] = [];
  const priorOutputs: { employee: string; dir: string }[] = [];
  const mandatorySquads = args.mandatorySquads ?? [];
  for (let i = 0; i < chain.length; i++) {
    // Right before the synthesizer (last step), dispatch each mandatory squad
    // so its output is available in priorOutputs for the synthesizer to read.
    if (i === chain.length - 1 && mandatorySquads.length) {
      for (const squadSlug of mandatorySquads) {
        const sr = runMandatorySquad(squadSlug, args);
        steps.push(sr);
        if (sr.ok) priorOutputs.push({ employee: `squad:${squadSlug}`, dir: sr.outputsDir });
        // Squad failure is non-fatal: synthesizer continues with the colleagues
        // it already has. The squad_run_failed event is in the audit.
      }
    }
    const r = runStep(chain[i], i, chain.length, args, priorOutputs);
    steps.push(r);
    if (!r.ok) {
      const totalCost = steps.reduce((s, x) => s + (x.costUsd || 0), 0);
      const totalDur = steps.reduce((s, x) => s + x.durationMs, 0);
      return { ok: false, steps, chain, lastSessionId: r.sessionId, totalCostUsd: totalCost, totalDurationMs: totalDur, error: `step ${i + 1} (${chain[i].employee}) falhou` };
    }
    priorOutputs.push({ employee: chain[i].employee, dir: r.outputsDir });
  }

  const totalCost = steps.reduce((s, x) => s + (x.costUsd || 0), 0);
  const totalDur = steps.reduce((s, x) => s + x.durationMs, 0);
  appendAudit({ event: "team_completed", project_id: args.projectId, business_slug: args.slug, steps: chain.length, total_cost_usd: totalCost, total_duration_ms: totalDur }, args.projectRoot);
  return { ok: true, steps, chain, lastSessionId: steps[steps.length - 1].sessionId, totalCostUsd: totalCost, totalDurationMs: totalDur };
}
