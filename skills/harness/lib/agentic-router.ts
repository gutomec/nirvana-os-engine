#!/usr/bin/env bun
// agentic-router.ts — agentic routing (replaces BM25 + single-pass LLM).
//
// Spawns a headless claude with Read/Glob/Grep/Bash so it can actually
// INSPECT the registries (businesses + squads), the brief, and produce a
// reasoned route decision instead of guessing from keyword scores. Returns:
//
//   {
//     primary_business: "<slug>",
//     mandatory_squads: ["<slug>", ...],   // user explicitly asked for these
//     optional_squads:  ["<slug>", ...],   // router judges complementary
//     rationale: "<short reasoning>"
//   }
//
// Why agentic: BM25 fails on prose briefs (Dr. Paulo case picked
// holding-saude-ai because the brief had heavy medical vocabulary even though
// the JOB was landing-page work, and ignored the user's explicit request to
// dispatch awwwards-singularity-studio). The agent reads the user's actual
// intent and the actual catalog, not just word frequencies.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runHeadless, type Runtime } from "./host-agent-driver.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { paths as nrvPaths } from "../../_shared/lib/bun-helpers.ts";
import { formatRulesForRouterPrompt, type RuntimeRule } from "./runtime-rules.ts";

const EXEC_RUNTIMES: ReadonlyArray<string> = ["claude-code", "codex", "gemini-cli", "antigravity-cli", "kimi-cli", "grok-cli"];

export interface AgenticRouteDecision {
  primary_business: string | null;
  mandatory_squads: string[];
  optional_squads: string[];
  rationale: string;
  /** Runtime sugerido pelas regras USE_* do usuário (null = sem match). */
  runtime: Runtime | null;
  ok: boolean;
  cost_usd: number | null;
  duration_ms: number;
  error?: string;
}

function emitAudit(payload: Record<string, any>, cwd?: string): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(harnessLogsDir({ cwd }), today);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n");
  } catch { /* non-fatal */ }
}

export interface AgenticRouteArgs {
  brief: string;
  runtime: Runtime;
  cwd: string;
  projectId?: string | null;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** Regras USE_* do usuário — injetadas verbatim no prompt do roteador. */
  runtimeRules?: RuntimeRule[];
}

/** Run the router. Writes one `agentic_route_decision` audit event. */
export async function agenticRoute(args: AgenticRouteArgs): Promise<AgenticRouteDecision> {
  // Resolução scope-aware (mesma do indexer) — o path fixo $HOME/*.json era o
  // local LEGADO de antes da migração para ~/.nirvana.
  const businessesReg = nrvPaths.BUSINESSES_REGISTRY_PATH;
  const squadsReg = nrvPaths.SQUADS_REGISTRY_PATH;

  // Write the brief to a temp file the agent can `Read` (avoids quoting hell
  // for big prose briefs) and reference by absolute path.
  const briefFile = path.join(os.tmpdir(), `agentic-router-brief-${Date.now()}.md`);
  fs.writeFileSync(briefFile, args.brief, "utf8");

  const prompt = `Você é o roteador agêntico do nirvana-os. Decide QUAL BUSINESS executa + QUAIS SQUADS são usados, lendo registries de verdade e respeitando ordens literais do usuário.

## REGRA-MÃE: SEPARE OBJETO DE TEMA

Todo brief tem 2 dimensões. NÃO MISTURE:
- **OBJETO** = o ARTEFATO concreto a entregar (landing page, livro, app, parecer jurídico, relatório, marca, mídia social, vídeo, etc.). É O QUE construir.
- **TEMA** = o ASSUNTO (saúde, agro, finanças, jurídico-trabalhista, beleza, etc.). É SOBRE O QUÊ.

**O OBJETO determina ~80% do roteamento.** TEMA é filtro secundário.

Exemplo:
- "Landing page premium para clínica de nutrologia" → OBJETO=landing page, TEMA=saúde. Primary business = quem ORQUESTRA entrega de landing/web (design/frontend), NÃO um business médico. TEMA entra como squad opcional (nirvana-clinica-medica pra CFM), não como primary.
- "Parecer jurídico sobre acidente de trabalho" → OBJETO=parecer jurídico, TEMA=segurança/medicina do trabalho. Primary = business jurídico-trabalhista.
- "PDF estratégico de branding para clínica" → OBJETO=brand strategy + PDF, TEMA=saúde. Primary = brand business.

Se um business da sua escolha não tem como entregar o OBJETO (ex.: holding-saude-ai não monta HTML/CSS/JS), está ERRADO mesmo que o TEMA case.

## REGRAS DURAS
1. **Alvo explícito manda — e estreito.** Se o usuário nomeia SÓ UM SQUAD e nenhuma empresa (ex.: "use o brandcraft", "crie um pdf com o brandcraft"): rode SÓ esse squad — coloque-o em mandatory_squads, deixe \`primary_business: null\`, e NÃO escale para uma empresa, A MENOS QUE o OBJETO exija de fato um pipeline multi-fase que o squad sozinho não entrega (se for o caso, justifique explicitamente no rationale). Se nomeia uma EMPRESA, use essa empresa. Se NÃO nomeia alvo algum, pesquise AMBOS os registries (businesses E squads) e escolha o melhor conjunto — não force uma empresa só porque o slot existe.
2. **Usuário manda.** Se o brief diz "use squad X" ou "use empresa Y", entram em mandatory_squads / primary_business SEM negociação. Se o usuário cita um squad de OBJETO (ex.: awwwards-singularity-studio para landing), ele tem que estar na cadeia.
3. **Para OBJETOS de software/web** (landing, app, site, dashboard, SaaS): se uma empresa for o primary, ela precisa ter capabilities/employees de design+frontend+backend. Squads de OBJETO especialistas (ex.: ultimate-landingpage, landing-page-nirvana, awwwards-singularity-studio) entram em mandatory_squads se aplicáveis.
4. **Para OBJETOS textuais profundos** (livro, parecer, relatório técnico): primary é o business cujo intake+synthesizer dão a autoridade — salvo quando um único squad nomeado já entrega o objeto (regra 1).
5. **Para OBJETOS visuais** (logo, identidade, ilustração): primary é brand/design business + skill de imagem (nano-banana-pro) é assumida.
6. **optional_squads**: 0-3 squads complementares (geralmente squads de TEMA). Não vira spray-and-pray.

## FERRAMENTAS
- \`Read ${briefFile}\` — o brief inteiro
- \`Read ${businessesReg}\` — registry de businesses (slug, domains, capabilities, employee_count)
- \`Read ${squadsReg}\` — registry de squads
- \`Bash\`, \`Grep\`, \`Glob\` — explore \`~/businesses/<slug>/business.yaml\`, \`~/squads/<slug>/squad.yaml\` se precisar

## METODOLOGIA
1. Ler brief. **Declarar mentalmente OBJETO e TEMA** (vão para o rationale).
2. Ler menções explícitas do usuário (frases tipo "use squad X").
3. Ler os 2 registries. Filtrar primeiro por OBJETO (capabilities que entregam o artefato). Depois validar contra TEMA (squads opcionais de tema).
4. primary_business: aquele com capabilities/employees alinhados ao OBJETO. Empresa de TEMA (sem capacidade de entregar o OBJETO) NÃO PODE ser primary.
5. mandatory_squads: literal do usuário + squads de OBJETO se houver especialista claro.
6. optional_squads: até 3, geralmente squads de TEMA pra validação.
7. Rationale (3-5 frases): comece com "OBJETO=<x>, TEMA=<y>." Depois justifique.

${args.runtimeRules?.length ? formatRulesForRouterPrompt(args.runtimeRules) + "\n\n" : ""}## SAÍDA
Apenas um bloco JSON, sem markdown, sem prosa antes/depois:

\`\`\`
{"primary_business":"<slug>","mandatory_squads":["<slug>",...],"optional_squads":["<slug>",...],"rationale":"OBJETO=<x>, TEMA=<y>. <restante da justificativa>"${args.runtimeRules?.length ? ',"runtime":"<runtime canônico se uma regra USE_* casar, senão omita>"' : ""}}
\`\`\`

\`primary_business\` pode ser \`null\` quando o usuário nomeou só um squad e ele entrega o objeto sozinho (regra 1). Exemplo squad-only:

\`\`\`
{"primary_business":null,"mandatory_squads":["brandcraft"],"optional_squads":[],"rationale":"OBJETO=pdf/branding, TEMA=—. Usuário nomeou o squad brandcraft explicitamente e ele entrega o PDF sozinho; sem necessidade de escalar para uma empresa."}
\`\`\`

Se não há squad nomeado E nenhum business adequado, retorne \`"primary_business": null\` com mandatory_squads vazio e explique. Não invente slugs — só use os que existem no registry.`;

  const started = Date.now();
  emitAudit({
    event: "agentic_route_called",
    project_id: args.projectId ?? null,
    brief_chars: args.brief.length,
  }, args.cwd);

  const res = runHeadless({
    runtime: args.runtime,
    prompt,
    cwd: args.cwd,
    allowedTools: ["Read", "Glob", "Grep", "Bash"],
    permissionMode: "acceptEdits",
    maxBudgetUsd: args.maxBudgetUsd,
    timeoutMs: args.timeoutMs ?? 5 * 60 * 1000,
  });
  const durationMs = Date.now() - started;

  try { fs.rmSync(briefFile, { force: true }); } catch { /* ignore */ }

  if (!res.ok) {
    emitAudit({
      event: "agentic_route_failed",
      project_id: args.projectId ?? null,
      error: res.error || res.stderr,
      duration_ms: durationMs,
      cost_usd: res.costUsd,
    }, args.cwd);
    return { primary_business: null, mandatory_squads: [], optional_squads: [], rationale: "", runtime: null, ok: false, cost_usd: res.costUsd, duration_ms: durationMs, error: res.error || res.stderr };
  }

  const txt = (res.result || "").trim();
  // The model might wrap the JSON in fences or trailing prose — grab the first
  // top-level {...} via brace matching.
  let jsonStr = "";
  const start = txt.indexOf("{");
  if (start >= 0) {
    let depth = 0, end = -1;
    for (let i = start; i < txt.length; i++) {
      if (txt[i] === "{") depth++;
      else if (txt[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > start) jsonStr = txt.slice(start, end + 1);
  }
  if (!jsonStr) {
    emitAudit({ event: "agentic_route_failed", project_id: args.projectId ?? null, error: `no JSON block in output: ${txt.slice(0, 200)}`, duration_ms: durationMs, cost_usd: res.costUsd }, args.cwd);
    return { primary_business: null, mandatory_squads: [], optional_squads: [], rationale: "", runtime: null, ok: false, cost_usd: res.costUsd, duration_ms: durationMs, error: "router did not return JSON" };
  }

  let parsed: any;
  try { parsed = JSON.parse(jsonStr); }
  catch (e: any) {
    emitAudit({ event: "agentic_route_failed", project_id: args.projectId ?? null, error: `JSON parse: ${e.message}`, duration_ms: durationMs, cost_usd: res.costUsd }, args.cwd);
    return { primary_business: null, mandatory_squads: [], optional_squads: [], rationale: "", runtime: null, ok: false, cost_usd: res.costUsd, duration_ms: durationMs, error: "router JSON invalid" };
  }

  // Validate against the actual registries — no hallucinated slugs.
  const bizReg = (() => { try { return JSON.parse(fs.readFileSync(businessesReg, "utf8")).businesses || {}; } catch { return {}; } })();
  const squadReg = (() => { try { return JSON.parse(fs.readFileSync(squadsReg, "utf8")).squads || {}; } catch { return {}; } })();
  const primary: string | null = parsed.primary_business && bizReg[parsed.primary_business] ? parsed.primary_business : null;
  const filterSquads = (arr: any): string[] => Array.isArray(arr) ? arr.filter((s: any) => typeof s === "string" && squadReg[s]) : [];
  const mandatory = filterSquads(parsed.mandatory_squads);
  const optional = filterSquads(parsed.optional_squads);
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";
  // Runtime sugerido pelas regras USE_*: só valores canônicos de exec; hermes
  // e desconhecidos viram null (hermes é delegação, nunca exec de cabeça).
  let ruleRuntime: Runtime | null = null;
  if (typeof parsed.runtime === "string" && parsed.runtime.trim()) {
    const v = parsed.runtime.trim().toLowerCase();
    if (EXEC_RUNTIMES.includes(v)) ruleRuntime = v as Runtime;
    else console.error(`[agentic-router] runtime '${parsed.runtime}' inválido no JSON do roteador — ignorado.`);
  }

  emitAudit({
    event: "agentic_route_decision",
    project_id: args.projectId ?? null,
    primary_business: primary,
    mandatory_squads: mandatory,
    optional_squads: optional,
    rationale,
    runtime: ruleRuntime,
    cost_usd: res.costUsd,
    duration_ms: durationMs,
  }, args.cwd);

  // A squad-only route (named squad, no business) is valid — the user asked
  // for a specific squad that delivers the object on its own.
  return { primary_business: primary, mandatory_squads: mandatory, optional_squads: optional, rationale, runtime: ruleRuntime, ok: !!primary || mandatory.length > 0, cost_usd: res.costUsd, duration_ms: durationMs };
}
