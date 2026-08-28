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
import { parse as parseYaml } from "yaml";
import { type Runtime } from "./host-agent-driver.ts";
import { LEGACY_CAPABILITY_ID } from "./capability-resolver.ts";
import {
  normalizeWorkflow, readWorkflow, referencedComponents, resolveWorkflowRef, type CanonicalStep,
} from "../../squads/lib/workflow-reader.ts";
import { LIMITS } from "../../_shared/validators/limits.ts";
import { runWithCascade } from "./cascade-runner.ts";
import { sessionKey, getSession, putSession, dropSession } from "./session-store.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { briefExcerpt } from "../../_shared/lib/brief-excerpt.ts";
import { resolveClonePersona, loadCloneRegistry } from "../../_shared/lib/clone-resolver.ts";
import { layersForPhase } from "../../_shared/lib/dna-layer-policy.ts";
import { findCloneForTask } from "../../_shared/lib/clone-search.ts";
import { paths } from "../../_shared/lib/bun-helpers.ts";
import { scopeGuard } from "../../_shared/lib/scope-guard.ts";
import { resolveSetting } from "../../_shared/lib/settings.ts";

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
  /** Capability this dispatch runs (capability-resolver.ts). It builds the
   *  prompt and travels on `dispatch_squad`; absent keeps the historical prompt. */
  capabilityId?: string | null;
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
  // Same opt-in mode as employee-prompt (the execution.dna_injection setting):
  // fragments injects SOUL + phase layers (squads execute → execute layers)
  // with a byte budget; full = the whole persona.
  const dnaMode: "full" | "fragments" = resolveSetting("execution.dna_injection").value;
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

// ── the capability a dispatch runs, as prompt sections ──────────────────────

export interface SquadCapabilityAcceptance { id: string; description: string; blocking?: boolean; minimumScore?: number }

export interface SquadCapabilityPromptContext {
  capabilityId: string;
  description: string;
  produces: string[];
  acceptance: SquadCapabilityAcceptance[];
  /** The capability's `invoke.ref`, resolved and normalized; null when the ref
   *  names no readable workflow (the manifest still describes the capability).
   *  `file` is squad-relative with POSIX separators on every platform. */
  workflow: { ref: string; file: string; steps: CanonicalStep[]; body: string } | null;
  /** Agent and task documents the workflow runs, in step order, under the byte
   *  ceiling. Null when the workflow named none — the caller keeps the top-3 blocks. */
  components: { agents: string; tasks: string } | null;
}

const componentsBytesMax = (): number => Number(LIMITS.squad_prompt_components_bytes_max ?? 65536);

/**
 * A path as the prompt shows it: POSIX separators on every platform, so the
 * workflow reference the squad reads is the one its `invoke.ref` declares
 * (`workflows/guided-analysis.md`) and not a Windows `path.relative` result
 * (`workflows\guided-analysis.md`). Same idiom as `verify/kinds/squad.ts`,
 * plus the literal backslash, which makes the normalization provable off
 * Windows instead of only on it.
 */
export function promptPath(p: string): string {
  return p.split(path.sep).join("/").replace(/\\/g, "/");
}

/** Slice a string to at most `bytes` UTF-8 bytes, never splitting a code point. */
function sliceBytes(text: string, bytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= bytes) return text;
  return new TextDecoder("utf8", { fatal: false }).decode(buf.subarray(0, bytes)).replace(/�$/, "");
}

/** Headroom kept aside for the truncation note, so the note itself can never
 *  push the section past the ceiling it is reporting. */
const COMPONENTS_NOTE_RESERVE = 192;

/** Component documents in step order, under a budget shared by agents and tasks.
 *  A document that does not fit is dropped whole and counted; the first one that
 *  overflows an empty budget is sliced, so a single huge persona still arrives. */
function renderComponents(squadDir: string, sub: "agents" | "tasks", stems: string[], budget: { left: number }): string {
  const parts: string[] = [];
  let dropped = 0;
  let missing = 0;
  const marker = `\n[…truncado no teto de ${componentsBytesMax()} bytes de componentes]`;
  const spend = (text: string) => { budget.left -= Buffer.byteLength(text, "utf8") + (parts.length ? 2 : 0); parts.push(text); };
  for (const stem of stems) {
    const file = path.join(squadDir, sub, `${stem}.md`);
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { missing++; continue; }
    const doc = `--- ${stem}.md ---\n${text}`;
    const join = parts.length ? 2 : 0;
    if (Buffer.byteLength(doc, "utf8") + join <= budget.left - COMPONENTS_NOTE_RESERVE) { spend(doc); continue; }
    const room = budget.left - COMPONENTS_NOTE_RESERVE - join - Buffer.byteLength(marker, "utf8");
    if (parts.length === 0 && room > 512) { spend(sliceBytes(doc, room) + marker); continue; }
    dropped++;
  }
  const notes: string[] = [];
  if (dropped) notes.push(`${dropped} documento(s) omitido(s) pelo teto de ${componentsBytesMax()} bytes de componentes`);
  if (missing) notes.push(`${missing} referência(s) sem arquivo em ${sub}/`);
  if (notes.length) spend(`[${notes.join("; ")}]`);
  return parts.join("\n\n");
}

/**
 * The capability's own context, read from the squad on disk: its manifest entry,
 * the workflow its `invoke.ref` names (through the v6 reader, so every legacy
 * dialect normalizes to the same graph) and the components that graph runs.
 *
 * Returns null when there is nothing better than the historical prompt: the
 * legacy `squad.execute`, an unreadable manifest, or an id the squad does not
 * declare. That null is what keeps the no-capability path byte-identical.
 */
export function capabilityContext(squadDir: string, capabilityId: string): SquadCapabilityPromptContext | null {
  if (!capabilityId || capabilityId === LEGACY_CAPABILITY_ID) return null;
  let manifest: any;
  try { manifest = parseYaml(fs.readFileSync(path.join(squadDir, "squad.yaml"), "utf8")); } catch { return null; }
  const entry = Array.isArray(manifest?.capabilities)
    ? manifest.capabilities.find((c: any) => c && typeof c === "object" && c.id === capabilityId)
    : null;
  if (!entry) return null;

  const asStrings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const acceptance: SquadCapabilityAcceptance[] = Array.isArray(entry.acceptance)
    ? entry.acceptance.filter((a: any) => a && typeof a.id === "string" && typeof a.description === "string")
      .map((a: any) => ({ id: a.id, description: a.description, blocking: a.blocking, minimumScore: a.minimumScore }))
    : [];

  const ref = typeof entry.invoke?.ref === "string" ? entry.invoke.ref : "";
  const file = ref ? resolveWorkflowRef(squadDir, ref) : null;
  const raw = file ? readWorkflow(file) : null;
  const normalized = raw?.doc ? normalizeWorkflow(raw.doc, { stem: raw.stem }) : null;

  let workflow: SquadCapabilityPromptContext["workflow"] = null;
  let components: SquadCapabilityPromptContext["components"] = null;
  if (normalized && file && raw) {
    workflow = { ref, file: promptPath(path.relative(squadDir, file)), steps: normalized.canonical.steps, body: raw.body.trim() };
    const referenced = referencedComponents(normalized.canonical);
    const stem = (name: string) => name.replace(/^(?:agents|tasks)\//, "").replace(/\.(md|markdown)$/i, "");
    const agents = referenced.agents.map(stem).filter(Boolean);
    const tasks = referenced.tasks.map(stem).filter(Boolean);
    if (agents.length || tasks.length) {
      const budget = { left: componentsBytesMax() };
      const agentDocs = renderComponents(squadDir, "agents", agents, budget);
      const taskDocs = renderComponents(squadDir, "tasks", tasks, budget);
      // Only take over the blocks when at least the agents resolved: a workflow
      // whose every reference is dangling must not leave the squad with nothing.
      if (agentDocs) components = { agents: agentDocs, tasks: taskDocs || "(o workflow não referencia nenhuma task)" };
    }
  }

  return {
    capabilityId,
    description: typeof entry.description === "string" ? entry.description.trim() : "",
    produces: asStrings(entry.produces),
    acceptance,
    workflow,
    components,
  };
}

const EM_DASH_CELL = "—";

/**
 * The event vocabulary a dispatched squad needs at the moment it writes an
 * event: the CLI, the attribution flag, and the `x_` escape hatch. Inlined
 * instead of a pointer to `references/03-audit.md` — that path is inside the
 * engine skill tree, and a squad's `addDirs` never guarantees it is readable;
 * the whole premise of this cut (Cut 1, #157) is that a doc read once at
 * authoring time does not reach the agent naming an event mid-run.
 *
 * Mirrors the pattern `employee-prompt.ts` already ships for businesses
 * (`nrv audit emit x_clone_choice --business=<slug> --trace=<trace> --json=...`),
 * which Cut 1 measured at zero rogue events — the working precedent, not a
 * new invention.
 */
function renderEventContractBlock(squadSlug: string, traceId?: string): string {
  const trace = traceId || "<trace_id>";
  return `## COMO REPORTAR EVENTOS
Emita marcos do seu trabalho com \`nrv audit emit <nome> --squad=${squadSlug} --trace=${trace}\`. Sempre passe \`--squad=${squadSlug}\`: é o que atribui o evento a você no cockpit. O nome não precisa estar na lista fechada do motor — se não estiver, escreva-o já com o prefixo \`x_\` (ex.: \`x_pagina_altura_acima_orcamento\`), assim o nome que chega ao log é o mesmo que você digitou. Payload vai em \`--json='{...}'\`, curto: nunca o brief inteiro, um output completo ou um segredo, só o resumo que o evento precisa carregar.`;
}

/** The capability block, plus the workflow block when the graph resolved. */
function renderCapabilityBlock(ctx: SquadCapabilityPromptContext): string {
  const lines = ["## SUA CAPABILITY", `- **id**: \`${ctx.capabilityId}\``];
  if (ctx.description) lines.push(`- **descrição**: ${ctx.description}`);
  if (ctx.produces.length) lines.push(`- **produces**: ${ctx.produces.join(", ")}`);
  if (ctx.acceptance.length) {
    lines.push("- **critérios de aceitação**:");
    for (const a of ctx.acceptance) {
      const marks = [a.blocking ? "bloqueante" : "", a.minimumScore !== undefined ? `nota mínima ${a.minimumScore}` : ""].filter(Boolean);
      lines.push(`  - \`${a.id}\`${marks.length ? ` (${marks.join(", ")})` : ""} — ${a.description}`);
    }
  }
  if (!ctx.workflow) {
    lines.push("", "> Esta capability não aponta para um workflow legível; siga o manifesto e os documentos abaixo.");
    return lines.join("\n");
  }

  const table = [
    `## SEU WORKFLOW (\`${ctx.workflow.file}\`)`,
    "| # | passo | agente | task | requer | cria |",
    "| --- | --- | --- | --- | --- | --- |",
    ...ctx.workflow.steps.map((s, i) => `| ${i + 1} | \`${s.id}\` | \`${s.agent}\` | ${s.task ? `\`${s.task}\`` : EM_DASH_CELL} | ${s.requires.length ? s.requires.map(r => `\`${r}\``).join(", ") : EM_DASH_CELL} | ${s.creates.length ? s.creates.join(", ") : EM_DASH_CELL} |`),
    "",
    "Execute os passos nessa ordem, respeitando as dependências da coluna `requer`.",
  ];
  if (ctx.workflow.body) table.push("", ctx.workflow.body);
  return `${lines.join("\n")}\n\n${table.join("\n")}`;
}

/** Build the self-contained squad prompt — its manifest, the capability it was
 * dispatched for (when one was resolved) with that capability's workflow and
 * exactly the agents and tasks the workflow runs, mind-clone injection and the
 * brief. WITHOUT a resolved capability the string is byte-identical to the
 * pre-extraction team-orchestrator prompt: the capability section is empty and
 * the component blocks fall back to the historical top-3 collection, headings
 * included. `squad-exec.test.ts` pins the whole string on that path. */
export function buildSquadPrompt(args: {
  squadSlug: string;
  squadDir: string;
  brief: string;
  outDir: string;
  mode: SquadExecMode;
  cloneInjection: { block: string; decision: string };
  /** The capability this dispatch runs (capability-resolver.ts). Absent, or the
   *  legacy `squad.execute`, keeps the historical prompt. */
  capabilityId?: string | null;
  /** The run's trace_id, shown in the event-contract block's example command.
   *  Absent falls back to a `<trace_id>` placeholder — never omits the block. */
  traceId?: string;
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

  // The capability sections, or "" — the whole compatibility surface of this cut.
  // The event-contract block rides the same gate: a squad without a resolved
  // capability (legacy, undeclared) keeps the historical prompt byte for byte —
  // squad-exec.test.ts pins that path. Every squad with `capabilities[]`
  // declared (mandatory since Creation Rule 5) gets the contract for free.
  const capability = args.capabilityId ? capabilityContext(squadDir, args.capabilityId) : null;
  const capabilitySection = capability
    ? `${renderCapabilityBlock(capability)}\n\n${renderEventContractBlock(squadSlug, args.traceId)}\n\n`
    : "";
  const componentsHeading = capability?.components ? "" : " (top 3)";
  const agentsSection = capability?.components?.agents ?? agentsBlock;
  const tasksSection = capability?.components?.tasks ?? tasksBlock;

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

${capabilitySection}## SEUS AGENTES${componentsHeading}
${agentsSection}

## SUAS TASKS${componentsHeading}
${tasksSection}

## MIND-CLONES QUE VOCÊ INCORPORA (decisão: ${cloneInj.decision})
> Incorpore por inteiro; entregue COMO SE o clone tivesse produzido, sob a especialidade do squad.
${cloneInj.block || "(sem clone para esta tarefa — opere com a especialidade padrão do squad)"}

## BRIEF ORIGINAL DO CLIENTE
${brief}

## SUA SUB-TAREFA
Execute a SUA especialidade aplicada ao brief acima. Escreva arquivos sob \`${outDir}\` (HTML, CSS, JS, MD, PNG/JPG via skills de imagem, o que for da sua expertise). Não invoque a skill harness, não rode \`nrv run\`/\`nrv dispatch\` para este mesmo brief (anti-loop). Pode usar Bash, Read, Write, Edit, geração de imagem (nano-banana-pro), e qualquer ferramenta disponível para entregar o melhor possível.

Se o brief mencionar você por nome (ex.: "use o squad ${squadSlug}"), priorize fazer EXATAMENTE o que o usuário pediu nesse parágrafo. O usuário manda.

${scopeGuard("pt-BR")} Escopo é o brief acima e os critérios de aceitação da sua sub-tarefa.

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
    mode: args.mode, cloneInjection: cloneInj, capabilityId: args.capabilityId,
    traceId: args.projectId,
  });

  appendAudit({
    event: "dispatch_squad",
    trace_id: args.projectId,
    project_id: args.projectId,
    ...bizCtx,
    squad_slug: args.squadSlug,
    squad_name: args.squadSlug,
    ...(args.capabilityId ? { capability_id: args.capabilityId } : {}),
    mode: args.mode,
    outputs_dir: outDir,
    // The proof-of-dispatch event says which squad, and now also what it was
    // asked to do. Bounded — see brief-excerpt.ts for the measured cap.
    brief_excerpt: briefExcerpt(args.brief),
    brief_chars: args.brief.length,
  }, args.projectRoot);

  const cascadeImpl = args.runWithCascadeImpl ?? runWithCascade;
  const cascadeArgs: Parameters<typeof runWithCascade>[0] = {
    // The dispatched runtime runs INSIDE the project — it needs the project's .nirvana/,
    // its config, its logs and its code-base — with the scaffold and the outputs dir handed
    // to it as additional directories so both stay writable.
    runtime: args.runtime, prompt, cwd: args.projectRoot, addDirs: [args.projectDir, outDir],
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
