// squad-exec.ts — the squad headless runner (routing-360 Phase 4.1).
//
// Extracted from team-orchestrator.ts so a squad can be dispatched in TWO
// contexts through ONE code path:
//   1. team mode ("team-mandatory") — a mandatory squad running as a sub-task
//      of a business chain; its output feeds the synthesizer. This is the
//      original team-orchestrator behavior, byte-compatible prompt included.
//   2. squad-only mode ("squad-only") — the agentic router decided a squad
//      delivers the object alone (primary_business: null). Before Phase 4
//      dispatch.ts printed instructions and exited 0 WITHOUT dispatching;
//      now it dispatches through here and flows into the delivery pipeline.
//
// Emits the same audit chain as the team path always did: dispatch_squad,
// agent_executed, squad_run_failed, mind_clone_missing_degraded, plus the
// session_resumed / session_resume_failed pair from the session-store reuse.

import * as fs from "node:fs";
import * as path from "node:path";
import { type Runtime } from "./host-agent-driver.ts";
import { runWithCascade } from "./cascade-runner.ts";
import { sessionKey, getSession, putSession, dropSession } from "./session-store.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { resolveClonePersona, loadCloneRegistry } from "../../_shared/lib/clone-resolver.ts";
import { layersForPhase } from "../../_shared/lib/dna-layer-policy.ts";
import { findCloneForTask } from "../../_shared/lib/clone-search.ts";
import { paths } from "../../_shared/lib/bun-helpers.ts";

export type SquadExecMode = "team-mandatory" | "squad-only";

export interface SquadExecArgs {
  squadSlug: string;
  brief: string;
  projectId: string;
  projectDir: string;
  projectRoot: string;
  /** Where THIS squad writes its files. */
  outputsDir: string;
  runtime: Runtime;
  /** Business the squad serves (team mode); null for squad-only dispatch. */
  businessSlug?: string | null;
  mode: SquadExecMode;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** User USE_* rules block, appended to the AUTONOMOUS_DIRECTIVE. */
  rulesDirective?: string;
  /** AUTONOMOUS_DIRECTIVE (kept as a param so the caller owns the directive
   * text; team-orchestrator passes host-agent-driver's constant). */
  autonomousDirective: string;
  /** Ledger heartbeat for supervised squad-only runs. */
  ledger?: { runId: string; watchDir?: string };
  /** Squads root override (tests). */
  squadsRoot?: string;
  /** Test seam: canned cascade runner (zero-token tests). */
  runWithCascadeImpl?: typeof runWithCascade;
}

export interface SquadExecResult {
  ok: boolean;
  squadSlug: string;
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number;
  outputsDir: string;
  error?: string;
}

function appendAudit(payload: Record<string, any>, projectRoot?: string): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(harnessLogsDir({ cwd: projectRoot }), today);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n");
  } catch { /* non-fatal */ }
}

/** Resolve mind-clones for a squad sub-task by the canonical order:
 *  SOLICITADO (brief names a clone) → BUSCA (task→clone search) → PADRÃO (none).
 *  Squads have no assigned_mind_clones, so the order is request-or-search. Every
 *  clone is resolved from the single library (full embodiment) — closing the gap
 *  where squad agents got zero DNA. (Moved verbatim from team-orchestrator.ts.) */
// `cwd` anchors the clone registry to the DISPATCH's project scope — without it
// the registry resolves from process.cwd(), and the two halves of one dispatch
// can read different scopes (the exact leak fixed in employee-prompt on
// 2026-08-18: a test run from the engine repo picked up the repo's derived
// registry and injected clones its fixture never wrote).
export function squadCloneInjection(brief: string, cwd?: string): { block: string; decision: string; missingClones: string[] } {
  const MAX = 2;
  const picked: Array<{ slug: string; reason: string }> = [];
  // 1. SOLICITADO — brief names a clone (slug or display name)
  const reg = loadCloneRegistry();
  const low = (brief || "").toLowerCase();
  for (const [slug, c] of Object.entries(reg)) {
    if (picked.length >= MAX) break;
    const name = String((c as any).display_name || "").toLowerCase();
    if (low.includes(slug) || low.includes(slug.replace(/-/g, " ")) || (name.length > 3 && low.includes(name))) {
      picked.push({ slug, reason: "solicitado" });
    }
  }
  let decision = picked.length ? "SOLICITADO pelo usuário" : "";
  // 2. BUSCA — only if nothing requested
  if (!picked.length) {
    let hits: any[] = [];
    try { hits = findCloneForTask(brief, { limit: MAX, cwd }); } catch { hits = []; }
    for (const h of hits) {
      if (picked.length >= MAX) break;
      // Coverage gate (routing-360 Phase 3.3), not normalized>=0.5: normalized
      // is max-normalized, so the top hit is 1.0 by construction even for an
      // out-of-domain brief ("consertar a bomba hidráulica do trator") — a
      // vacuous gate. `below_gate` mirrors the router's Stage 3 coverage bands.
      if (h.below_gate === false) picked.push({ slug: h.slug, reason: `busca cobertura ${h.coverage?.matched}/${h.coverage?.total}` });
    }
    decision = picked.length ? "encontrado por BUSCA" : "PADRÃO — nenhum clone útil";
  }
  if (!picked.length) return { block: "", decision, missingClones: [] };
  // Same opt-in mode as employee-prompt: fragments injects SOUL + phase layers
  // (squads execute → execute layers) with a byte budget; full = the whole persona.
  const dnaMode: "full" | "fragments" =
    (process.env.NIRVANA_DNA_INJECTION || "full").toLowerCase() === "fragments" ? "fragments" : "full";
  const fragLayers = layersForPhase("execute");
  const parts: string[] = [];
  const missingClones: string[] = [];
  for (const p of picked) {
    const persona = dnaMode === "fragments"
      ? resolveClonePersona(p.slug, { depth: "fragments", layers: fragLayers, byteBudget: 16000, cwd })
      : resolveClonePersona(p.slug, { depth: "full", cwd });
    if (persona) parts.push(`--- MIND-CLONE: ${p.slug} — ${persona.display_name} (${p.reason}) ---\n\n${persona.content}`);
    else missingClones.push(p.slug);
  }

  // A requested but nonexistent clone does not take down the squad — but
  // degrading in SILENCE would be worse than failing: the squad would produce
  // without the DNA and nobody would know. Same policy as dispatch.ts: the
  // degradation is NOISY — explicit block in the prompt itself, field in the
  // return value (the caller emits the audit event) and an order to the agent
  // to report the absence in the deliverable.
  if (missingClones.length) {
    parts.push(
      `--- MIND-CLONE AUSENTE: ${missingClones.join(", ")} ---\n\n` +
      `# Especialista sem clone na biblioteca\n\n` +
      `Os seguintes especialistas foram pedidos e NÃO existem como mind-clone instalado: ` +
      `**${missingClones.join(", ")}**.\n\n` +
      `Você NÃO está carregando o DNA dessas pessoas. Trabalhe com o seu próprio ` +
      `conhecimento sobre o método delas, e trate isso como o que é: uma aproximação, ` +
      `não a persona.\n\n` +
      `Duas obrigações:\n` +
      `1. **Não afirme** que aplicou o método daquela pessoa com fidelidade de clone. ` +
      `Diga que atuou por conhecimento geral.\n` +
      `2. **Registre no entregável** quais especialistas faltaram, para que o dono ` +
      `possa decidir se quer criar o mind-clone (o squad \`fabrica-de-genios\` faz isso ` +
      `pela capability \`knowledge_management.mind_clone_generation_pipeline.execute\`).\n`
    );
  }
  return { block: parts.join("\n\n"), decision, missingClones };
}

/** Build the self-contained squad prompt — its manifest, primary agent(s),
 * primary task(s), mind-clone injection and the brief. The team-mandatory
 * framing is byte-identical to the pre-extraction team-orchestrator prompt. */
export function buildSquadPrompt(args: {
  squadSlug: string;
  squadDir: string;
  brief: string;
  outDir: string;
  mode: SquadExecMode;
  cloneInjection: { block: string; decision: string };
}): string {
  const { squadSlug, squadDir, brief, outDir, mode, cloneInjection: cloneInj } = args;
  const readIfExists = (p: string) => fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const manifest = readIfExists(path.join(squadDir, "squad.yaml")) || "(squad.yaml missing)";
  // Collect up to ~3 agents and ~3 tasks so the prompt stays bounded.
  const agentsDir = path.join(squadDir, "agents");
  const tasksDir = path.join(squadDir, "tasks");
  const collect = (dir: string, n: number) => fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => f.endsWith(".md")).slice(0, n).map(f => `--- ${f} ---\n${fs.readFileSync(path.join(dir, f), "utf8")}`).join("\n\n")
    : "";
  const agentsBlock = collect(agentsDir, 3) || "(no agents/ dir)";
  const tasksBlock = collect(tasksDir, 3) || "(no tasks/ dir)";

  const roleLine = mode === "team-mandatory"
    ? `Você É o squad "${squadSlug}" executando uma sub-tarefa de um business maior. Sua saída é input do synthesizer do business.`
    : `Você É o squad "${squadSlug}" executando o brief do cliente de ponta a ponta. Sua saída é o ENTREGÁVEL FINAL para o usuário.`;
  const doneLine = mode === "team-mandatory"
    ? "Termine quando o trabalho estiver pronto para o synthesizer integrar."
    : "Termine quando o trabalho estiver pronto para entrega ao usuário.";

  return `${roleLine}

## SUA IDENTIDADE (squad.yaml)
\`\`\`yaml
${manifest}
\`\`\`

## SEUS AGENTES (top 3)
${agentsBlock}

## SUAS TASKS (top 3)
${tasksBlock}

## MIND-CLONES QUE VOCÊ INCORPORA (decisão: ${cloneInj.decision})
> Incorpore por inteiro; entregue COMO SE o clone tivesse produzido, sob a especialidade do squad.
${cloneInj.block || "(sem clone para esta tarefa — opere com a especialidade padrão do squad)"}

## BRIEF ORIGINAL DO CLIENTE
${brief}

## SUA SUB-TAREFA
Execute a SUA especialidade aplicada ao brief acima. Escreva arquivos sob \`${outDir}\` (HTML, CSS, JS, MD, PNG/JPG via skills de imagem, o que for da sua expertise). Não invoque a skill harness, não rode \`nrv run\`/\`nrv dispatch\` para este mesmo brief (anti-loop). Pode usar Bash, Read, Write, Edit, geração de imagem (nano-banana-pro), e qualquer ferramenta disponível para entregar o melhor possível.

Se o brief mencionar você por nome (ex.: "use o squad ${squadSlug}"), priorize fazer EXATAMENTE o que o usuário pediu nesse parágrafo. O usuário manda.

## SAÍDA
Arquivos no diretório acima. Não printe sumário — entregue arquivos. ${doneLine}`;
}

/**
 * Run one squad headless, with session reuse and the full audit chain.
 *
 * Session policy (lifted from team-orchestrator's runWithSession): resume the
 * prior session of THIS squad in THIS project when one exists; on failure with
 * a resumed session, drop the id and retry ONCE cold — reuse may only ever
 * improve the result, never degrade it.
 */
export function runSquadHeadless(args: SquadExecArgs): SquadExecResult {
  // paths.SQUADS_DIR honours SQUADS_DIR and NIRVANA_HOME; os.homedir() ignored both and, on Windows,
  // reads USERPROFILE, so a squad installed under a redirected HOME was "not found".
  const squadsRoot = args.squadsRoot ?? paths.SQUADS_DIR;
  const squadDir = path.join(squadsRoot, args.squadSlug);
  const outDir = args.outputsDir;
  fs.mkdirSync(outDir, { recursive: true });
  const bizCtx = args.businessSlug ? { business_slug: args.businessSlug } : {};

  if (!fs.existsSync(squadDir)) {
    appendAudit({ event: "squad_run_failed", project_id: args.projectId, ...bizCtx, squad_slug: args.squadSlug, reason: "squad dir not found" }, args.projectRoot);
    return { ok: false, squadSlug: args.squadSlug, sessionId: null, costUsd: null, durationMs: 0, outputsDir: outDir, error: "squad dir not found" };
  }

  const cloneInj = squadCloneInjection(args.brief, args.projectDir);
  for (const slug of cloneInj.missingClones) {
    appendAudit({
      event: "mind_clone_missing_degraded", trace_id: args.projectId, project_id: args.projectId,
      ...bizCtx, squad_slug: args.squadSlug, reason: "mind_clone_not_found", slug_requested: slug,
    }, args.projectRoot);
  }

  const prompt = buildSquadPrompt({
    squadSlug: args.squadSlug, squadDir, brief: args.brief, outDir,
    mode: args.mode, cloneInjection: cloneInj,
  });

  appendAudit({
    event: "dispatch_squad",
    trace_id: args.projectId,
    project_id: args.projectId,
    ...bizCtx,
    squad_slug: args.squadSlug,
    squad_name: args.squadSlug,
    mode: args.mode,
    outputs_dir: outDir,
  }, args.projectRoot);

  const cascadeImpl = args.runWithCascadeImpl ?? runWithCascade;
  const cascadeArgs: Parameters<typeof runWithCascade>[0] = {
    runtime: args.runtime, prompt, cwd: args.projectDir, addDirs: [args.projectRoot],
    appendSystemPrompt: args.autonomousDirective + (args.rulesDirective ?? ""),
    maxBudgetUsd: args.maxBudgetUsd, timeoutMs: args.timeoutMs,
    brief: args.brief, projectRoot: args.projectRoot, outputsRoot: outDir,
    taskHint: args.mode === "team-mandatory" ? `mandatory squad: ${args.squadSlug}` : `squad-only dispatch: ${args.squadSlug}`,
    projectId: args.projectId,
    ...(args.ledger ? { ledger: { runId: args.ledger.runId, watchDir: args.ledger.watchDir ?? outDir } } : {}),
  };

  // Session reuse with the one-cold-retry fallback.
  const key = sessionKey(args.runtime, "squad", args.squadSlug);
  const prior = getSession(args.projectDir, key);
  let res = cascadeImpl(prior ? { ...cascadeArgs, sessionId: prior } : cascadeArgs);
  if (!res.ok && prior) {
    appendAudit({
      event: "session_resume_failed", trace_id: args.projectId, project_id: args.projectId,
      ...bizCtx, entity: `squad:${args.squadSlug}`, runtime: args.runtime, session_id: prior,
    }, args.projectRoot);
    dropSession(args.projectDir, key);
    res = cascadeImpl(cascadeArgs);
  } else if (prior && res.ok) {
    appendAudit({
      event: "session_resumed", trace_id: args.projectId, project_id: args.projectId,
      ...bizCtx, entity: `squad:${args.squadSlug}`, runtime: args.runtime, session_id: prior,
    }, args.projectRoot);
  }
  putSession(args.projectDir, key, res.finalRuntime ?? args.runtime, res.sessionId);

  appendAudit({
    event: "agent_executed",
    trace_id: args.projectId, project_id: args.projectId, ...bizCtx,
    squad_slug: args.squadSlug, employee: `squad:${args.squadSlug}`,
    runtime: res.finalRuntime, session_id: res.sessionId,
    cost_usd: res.costUsd, duration_ms: res.durationMs,
    mode: args.mode === "team-mandatory" ? "squad-mandatory" : "squad-only",
    handoffs: res.handoffs.length ? res.handoffs : undefined,
  }, args.projectRoot);

  return {
    ok: res.ok, squadSlug: args.squadSlug, sessionId: res.sessionId,
    costUsd: res.costUsd, durationMs: res.durationMs, outputsDir: outDir,
    error: res.ok ? undefined : (res.error || res.stderr || `exit ${res.exitCode}`),
  };
}
