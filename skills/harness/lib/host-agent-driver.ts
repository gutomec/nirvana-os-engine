#!/usr/bin/env bun
// host-agent-driver.ts — the exec bridge.
//
// Spawns the host agent runtime HEADLESS (non-interactive) so a dispatch can
// actually EXECUTE the employee prompt, not just scaffold it. This is the piece
// ask.ts deliberately avoided ("we don't actually shell out") and dispatch.ts
// marked as "(--exec mode, future)". The harness wraps verify + gate + export
// around this call.
//
// MVP: claude-code only. codex / gemini-cli / antigravity-cli are Phase 2
// (stubs below return a clear "not yet supported" so the caller fails loudly
// instead of silently).
//
// gemini-cli sunset for consumer (Pro/Ultra/free Code Assist): 2026-06-18.
// Replacement: antigravity-cli (binary `agy`). Both adapters live below
// during the transition window. See (base de conhecimento interna)
//
// The prompt is fed via STDIN (not argv) so large DNA-injected prompts don't
// hit ARG_MAX. The runtime writes deliverables itself (cwd-scoped); we capture
// the session_id so `nrv revise` can resume the same conversation.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveSystemModel } from "../../_shared/lib/system-model.ts";

export type Runtime = "claude-code" | "codex" | "gemini-cli" | "antigravity-cli" | "kimi-cli" | "grok-cli" | "pi";

export interface RunHeadlessOpts {
  runtime: Runtime;
  prompt: string;
  cwd: string;
  /** Extra directories the runtime may touch (e.g. the project root). */
  addDirs?: string[];
  /** Resume an existing conversation (revise flow). */
  sessionId?: string;
  /** Injected as a system-prompt suffix (autonomous-mode directive). */
  appendSystemPrompt?: string;
  /** Tool allowlist. Default: file + web tools, no Bash. */
  allowedTools?: string[];
  /** claude permission mode. Default: acceptEdits. */
  permissionMode?: string;
  /** Hard dollar cap for the run (claude --max-budget-usd). Omit = uncapped. */
  maxBudgetUsd?: number;
  /** Wall-clock timeout in ms. Default: NONE (uncapped) — long book/PDF runs
   * must not be SIGTERM'd mid-flight (the old 20-min default killed real runs
   * with exit 143). Callers that want a cap pass it explicitly (e.g. the fast
   * router sets 5 min; `nrv dispatch --timeout=<min>`). */
  timeoutMs?: number;
  /** Bypass all permission checks (claude --dangerously-skip-permissions). */
  yolo?: boolean;
  /** Optional model override. Passed as `--model <id>` (or equivalent) to the
   * underlying CLI. Honors model hints from LLM_CASCADE entries. If unset,
   * each CLI uses its own configured default. */
  model?: string;
  /** Optional provider id for CLIs that support multi-provider config
   * (codex `--provider <id>` referencing [model_providers.<id>] in
   * ~/.codex/config.toml; qwen-code modelProviders[].id; pi `--provider`
   * nativo — anthropic/openai/google/openrouter/ollama/…). Ignored by
   * CLIs that don't have this concept. */
  providerHint?: string;
}

export interface RunHeadlessResult {
  ok: boolean;
  runtime: Runtime;
  sessionId: string | null;
  result: string;
  costUsd: number | null;
  exitCode: number;
  stderr: string;
  durationMs: number;
  error?: string;
}

/** Conservative allowlist used only when the caller asks for safe mode
 * (--safe). Default trust mode passes NO allowlist (all tools available). */
export const DEFAULT_ALLOWED_TOOLS = ["Write", "Edit", "Read", "Glob", "Grep", "WebSearch", "WebFetch"];

/** Autonomous-mode directive — full-trust quality contract. Appended to the
 * system prompt so a headless run never blocks AND uses every tool it needs
 * (including Bash) to delegate to specialists for real multi-agent quality.
 * The first block is the "alma do nirvana-os": NADA NAS COXAS, sempre o
 * melhor disponível — para visuais, código, bibliotecas e especialistas. */
export const AUTONOMOUS_DIRECTIVE = [
  "============================================================",
  "PREMISSA FUNDAMENTAL (alma do nirvana-os): NADA NAS COXAS.",
  "O MELHOR QUE EXISTE É O DEFAULT, não o teto. O sistema procura o melhor a ser feito e usa o que há de mais robusto e atual para a tarefa.",
  "",
  "1) VISUAIS (logos, hero, retratos, ilustrações, ícones custom, capas, imagens de produto): SEMPRE gere imagens REAIS via os geradores disponíveis no ambiente. NUNCA SVG genérico à mão, NUNCA stock photo óbvio, NUNCA placeholder no entregável final. Ferramentas:",
  "   · skill `nano-banana-pro` (Gemini 3 Pro Image) — texto→imagem de alta qualidade. Resoluções 1K / 2K / 4K conforme uso.",
  "   · skill `flux` ou MCP `flux__generate_image` — texto→imagem alternativa.",
  "   · squad `image2-virtuoso` (gpt-image-2 + Codex), via `nrv dispatch image2-virtuoso \"<prompt>\"` — refino premium, fallback chain.",
  "   · MCP `fal-video` (veo3, kling, luma) ou nano-banana-pro vídeo — para vídeo/animação.",
  "   Gere conjunto responsivo (PNG/JPG/WebP em múltiplas resoluções) quando o entregável for web.",
  "",
  "2) CÓDIGO E BIBLIOTECAS: SEMPRE escolha a opção mais atual, robusta e bem mantida HOJE. CDN confiável e versão pinada (jsDelivr, unpkg, cdnjs). SRI quando viável. Exemplos do estado-da-arte:",
  "   · Mapas → Leaflet + OpenStreetMap (open) ou Mapbox GL (premium).",
  "   · Charts → ApexCharts, Recharts, Chart.js, D3 conforme caso.",
  "   · Ícones → Lucide.",
  "   · Animações → Intersection Observer puro, AOS, ou GSAP em casos avançados.",
  "   · Forms → Formspree / Netlify Forms / Web3Forms (no-backend).",
  "   · Vídeo → Plyr ou Vidstack.",
  "   · UI React → shadcn/ui + Tailwind + Radix. UI vanilla → CSS moderno (container queries, :has, grid).",
  "   · React → Next.js 15 / TanStack Start. Mobile → Expo + React Native. Native iOS → SwiftUI.",
  "   · Backend → Hono / Bun, ou FastAPI / Python conforme caso.",
  "   Em dúvida sobre o que é o melhor HOJE para a tarefa, USE `WebSearch`/`WebFetch` para verificar antes de decidir.",
  "",
  "3) ESPECIALISTAS (squads + employees): SEMPRE despache o especialista quando existir. O prompt deste run injeta o CATÁLOGO completo de squads disponíveis (veja a seção SQUADS DISPONÍVEIS). Para EXECUTAR um squad: `nrv dispatch <slug> \"<sub-tarefa>\" --exec`. Para inspecionar antes: `nrv list-squads` / `nrv inspect-squad <slug>`. A skill `squads` é só para lifecycle (criar/validar squads), NÃO para executá-los — quem executa é `nrv dispatch` ou a skill `harness`. Em caso nenhum faça in-house o que um squad do registry faz melhor.",
  "",
  "Defaults conservadores são para PREMISSAS FACTUAIS (datas, nomes, números). Para QUALIDADE da execução, o default é o teto, não o piso. Se você for entregar algo mediano por preguiça/atalho, REFAÇA com a ferramenta certa.",
  "============================================================",
  "",
  "AUTONOMOUS MODE (headless run, FULL TRUST — Bash + all tools enabled, permissions skipped):",
  "- Você É o intake do business já dispatchado. Não invoque a skill `harness` nem rode `nrv run` para reanunciar este mesmo brief (anti-loop). Mas DELEGUE para outros employees/squads quando o trabalho exigir, via Bash.",
  "- Para usar colegas do seu próprio business como sub-agentes:",
  "    PROMPT=$(bun ~/.nirvana/skills/businesses/lib/employee-prompt.ts <slug> <employee> <project_dir> <brief_file> <outputs_root>)",
  "    echo \"$PROMPT\" | claude -p --output-format json --dangerously-skip-permissions",
  "- Para sub-tarefas em outros businesses ou squads especialistas, despache via: `nrv dispatch <slug> \"<sub-tarefa>\" --exec`. (não use --auto recursivo para este mesmo brief).",
  "- Escreva CADA entregável final como arquivo sob o outputs_root indicado no prompt. Não imprima resumo do que faria.",
  "- O harness wrap (verify, quality gate, export, PDF) roda DEPOIS de você terminar — não duplique.",
  "- NUNCA pergunte ao usuário, NUNCA espere input. Decida com defaults profissionais e registre em '## Premissas assumidas' no entregável principal.",
  "- FLUXO CONTÍNUO (fases / HANDOFF): se o trabalho tem fases (HANDOFF.json ou um plano em etapas), avance-as em SEQUÊNCIA até `complete` SEM PAUSAR entre elas. Ao finalizar uma fase, INICIE A PRÓXIMA IMEDIATAMENTE na mesma execução — não pare para confirmar, não reporte status intermediário, não devolva o controle. Só interrompa em erro irrecuperável ou num gatilho explícito `notify: human`. Você é o autopiloto: rode de ponta a ponta.",
  "- INTERRUPÇÃO POR MENSAGEM (não idle): se chegar uma pergunta ou mensagem de status no MEIO da execução, responda em UMA linha com o estado atual e RETOME a execução na mesma ação. NUNCA entre em estado ocioso esperando nova ordem — a ordem de continuar já é esta.",
  "- HÍFEN (regra dura, antes de escrever): use '-' SOMENTE para palavras compostas (guarda-chuva) e intervalos. NUNCA use '-' nem '—' para emendar orações ou pausas — troque por vírgula, dois-pontos ou ponto. Siga o writing contract no AGENTS.md / CLAUDE.md / GEMINI.md.",
  "- Termine escrevendo arquivos, nunca imprimindo um resumo do que escreveria.",
].join("\n");

function runClaudeCode(opts: RunHeadlessOpts): RunHeadlessResult {
  const started = Date.now();
  const args: string[] = ["-p", "--output-format", "json"];

  if (opts.sessionId) args.push("--resume", opts.sessionId);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  // Model: explícito do caller > model do sistema (o que a sessão do usuário
  // roda) > default do CLI. Sem isso, o filho `claude -p` cai no default (sonnet)
  // em vez de herdar o fable/opus da sessão interativa.
  const ccModel = opts.model ?? resolveSystemModel("claude-code");
  if (ccModel) args.push("--model", ccModel);

  // Trust by default. EXPLICIT caller settings (allowedTools / permissionMode)
  // always take precedence — so focused text-only calls like the brief-proxy or
  // the team-orchestrator director can lock down permissions without the trust
  // default overriding them.
  const safe = opts.yolo === false;
  const explicitTools = opts.allowedTools !== undefined;
  const explicitPerm = opts.permissionMode !== undefined;

  if (explicitTools) {
    if (opts.allowedTools!.length > 0) args.push("--allowedTools", opts.allowedTools!.join(" "));
    // length === 0 → caller asked for "no tools": skip the flag and let
    // permissionMode govern (default mode denies tool calls in headless).
  } else if (safe) {
    args.push("--allowedTools", DEFAULT_ALLOWED_TOOLS.join(" "));
  }

  if (explicitPerm) {
    args.push("--permission-mode", opts.permissionMode!);
  } else if (safe) {
    args.push("--permission-mode", "acceptEdits");
  } else {
    args.push("--dangerously-skip-permissions");
  }

  if (typeof opts.maxBudgetUsd === "number") args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  for (const d of opts.addDirs ?? []) args.push("--add-dir", d);

  const r = spawnSync("claude", args, {
    cwd: opts.cwd,
    input: opts.prompt,
    encoding: "utf8",
    ...(typeof opts.timeoutMs === "number" ? { timeout: opts.timeoutMs } : {}),
    maxBuffer: 64 * 1024 * 1024,
  });

  const durationMs = Date.now() - started;
  const exitCode = r.status ?? (r.signal ? 124 : 1);
  const stdout = r.stdout || "";
  const stderr = (r.stderr || "").trim();

  // claude --output-format json prints a single JSON object:
  // { type:"result", subtype, is_error, result, session_id, total_cost_usd, ... }
  let sessionId: string | null = null;
  let result = "";
  let costUsd: number | null = null;
  let isError = exitCode !== 0;
  try {
    const parsed = JSON.parse(stdout.trim());
    sessionId = parsed.session_id ?? null;
    result = typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result ?? "");
    costUsd = typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null;
    if (typeof parsed.is_error === "boolean") isError = isError || parsed.is_error;
  } catch {
    // Non-JSON stdout (e.g. early crash). Keep raw for diagnostics.
    result = stdout.trim();
  }

  return {
    ok: !isError && exitCode === 0,
    runtime: "claude-code",
    sessionId,
    result,
    costUsd,
    exitCode,
    stderr,
    durationMs,
    error: isError ? (stderr || "runtime returned an error verdict") : undefined,
  };
}

// codex / gemini lack a --append-system-prompt flag, so we fold the directive
// into the user prompt as a preamble for those runtimes.
function withPreamble(opts: RunHeadlessOpts): string {
  return opts.appendSystemPrompt ? `${opts.appendSystemPrompt}\n\n---\n\n${opts.prompt}` : opts.prompt;
}

// Codex CLI (codex exec). Writes deliverables under cwd via the workspace-write
// sandbox. Resume is a subcommand (`codex exec resume <id>`). Session id is
// scraped best-effort from the --json event stream; if it can't be captured,
// the run still completes but `nrv revise` for that project won't resume.
function runCodex(opts: RunHeadlessOpts): RunHeadlessResult {
  const started = Date.now();
  const lastMsg = path.join(os.tmpdir(), `codex-last-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const base = opts.sessionId
    ? ["exec", "resume", opts.sessionId]
    : ["exec"];
  const args = [...base, "--json", "--skip-git-repo-check", "-C", opts.cwd, "-o", lastMsg];
  const cxModel = opts.model ?? resolveSystemModel("codex");
  if (cxModel) args.push("--model", cxModel);
  if (opts.providerHint) args.push("--provider", opts.providerHint);
  // Trust by default; --safe (opts.yolo===false) → workspace-write sandbox.
  if (opts.yolo === false) args.push("-s", "workspace-write");
  else args.push("--dangerously-bypass-approvals-and-sandbox");

  const r = spawnSync("codex", args, {
    cwd: opts.cwd,
    input: withPreamble(opts),
    encoding: "utf8",
    ...(typeof opts.timeoutMs === "number" ? { timeout: opts.timeoutMs } : {}),
    maxBuffer: 64 * 1024 * 1024,
  });

  const durationMs = Date.now() - started;
  const exitCode = r.status ?? (r.signal ? 124 : 1);
  const stderr = (r.stderr || "").trim();

  let sessionId: string | null = opts.sessionId ?? null;
  for (const line of (r.stdout || "").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t);
      sessionId = j.session_id || j.thread_id || j.conversation_id || j?.session?.id || j?.msg?.session_id || sessionId;
    } catch { /* not a json line */ }
  }
  let lastMsgContent = "";
  try { lastMsgContent = fs.readFileSync(lastMsg, "utf8"); } catch { /* ignore */ }
  try { fs.rmSync(lastMsg, { force: true }); } catch { /* ignore */ }

  // Result is the agent's final message FOLLOWED BY the JSONL event stream.
  // The stream carries `turn.completed.usage` events that the cost-estimator
  // needs (input_tokens, output_tokens). Concatenating preserves both.
  const result = (lastMsgContent || "").trim()
    + ((lastMsgContent && r.stdout) ? "\n\n--- codex event stream ---\n" : "")
    + ((r.stdout || "").trim());

  return { ok: exitCode === 0, runtime: "codex", sessionId, result, costUsd: null, exitCode, stderr, durationMs, error: exitCode === 0 ? undefined : (stderr || "codex exec failed") };
}

// Gemini CLI. We set a known --session-id on first run so revise can resume it
// deterministically with -r. auto_edit auto-approves file writes (yolo = all).
function runGemini(opts: RunHeadlessOpts): RunHeadlessResult {
  const started = Date.now();
  const sid = opts.sessionId || randomUUID();
  const args = ["-p", withPreamble(opts), "-o", "json", "--skip-trust"];
  if (opts.sessionId) args.push("-r", opts.sessionId);
  else args.push("--session-id", sid);
  const gmModel = opts.model ?? resolveSystemModel("gemini-cli");
  if (gmModel) args.push("--model", gmModel);
  // Trust by default (--yolo); --safe (opts.yolo===false) → auto_edit.
  args.push("--approval-mode", opts.yolo === false ? "auto_edit" : "yolo");

  const r = spawnSync("gemini", args, {
    cwd: opts.cwd,
    encoding: "utf8",
    ...(typeof opts.timeoutMs === "number" ? { timeout: opts.timeoutMs } : {}),
    maxBuffer: 64 * 1024 * 1024,
  });

  const durationMs = Date.now() - started;
  const exitCode = r.status ?? (r.signal ? 124 : 1);
  const stderr = (r.stderr || "").trim();

  const rawStdout = (r.stdout || "").trim();
  let sessionId: string | null = sid;
  try {
    const j = JSON.parse(rawStdout);
    sessionId = j.session_id || j.sessionId || sid;
  } catch { /* keep sid */ }
  // CRITICAL: keep the FULL JSON stdout in result, not just j.response — the
  // cost-estimator needs the `stats.models.*.tokens` block to compute spend.
  // Slicing to j.response throws that data away and forces $0 tracking.
  const result = rawStdout;

  return { ok: exitCode === 0, runtime: "gemini-cli", sessionId, result, costUsd: null, exitCode, stderr, durationMs, error: exitCode === 0 ? undefined : (stderr || "gemini failed") };
}

// Antigravity CLI (`agy`). Replaces gemini-cli for consumer tier after 2026-06-18.
// Same Google backend (Gemini models), different binary + flag conventions.
// Spec: (base de conhecimento interna)
function runAntigravity(opts: RunHeadlessOpts): RunHeadlessResult {
  const started = Date.now();
  const sid = opts.sessionId || randomUUID();
  // agy headless: -p / --print / --prompt all accept the prompt as argv value.
  // Output formats: "json" (single object) or "stream-json" (NDJSON events).
  // We use single-object json for parity with runGemini/runClaudeCode.
  // Resume = --continue (most recent conversation); we can't set our own id
  // upfront. Autonomy = --dangerously-skip-permissions (sem ela o agy trava
  // esperando aprovação).
  //
  // --output-format json: sob non-TTY o `agy -p` em modo TEXTO pode dropar a
  // resposta final do stdout (bug documentado do render de terminal); o JSON
  // não sofre disso. Builds antigos NÃO têm a flag (confirmado via --help em
  // versões instaladas) — se o spawn falhar com erro de flag, retry sem ela.
  const args = ["-p", withPreamble(opts), "--output-format", "json"];
  if (opts.sessionId) args.push("--continue");
  const agyModel = opts.model ?? resolveSystemModel("antigravity-cli");
  if (agyModel) args.push("--model", agyModel);
  if (opts.yolo !== false) args.push("--dangerously-skip-permissions");
  for (const d of opts.addDirs ?? []) args.push("--add-dir", d);

  const spawnOpts = {
    cwd: opts.cwd,
    encoding: "utf8" as const,
    ...(typeof opts.timeoutMs === "number" ? { timeout: opts.timeoutMs } : {}),
    maxBuffer: 64 * 1024 * 1024,
  };
  let r = spawnSync("agy", args, spawnOpts);
  if ((r.status ?? 1) !== 0 && /output[- ]format|unknown|unrecognized|invalid (option|flag|argument)/i.test(r.stderr || "")) {
    const i = args.indexOf("--output-format");
    r = spawnSync("agy", [...args.slice(0, i), ...args.slice(i + 2)], spawnOpts);
  }

  const durationMs = Date.now() - started;
  const exitCode = r.status ?? (r.signal ? 124 : 1);
  const stderr = (r.stderr || "").trim();

  const rawStdout = (r.stdout || "").trim();
  let sessionId: string | null = sid;
  let result = rawStdout;
  try {
    const j = JSON.parse(rawStdout);
    sessionId = j.session_id || j.sessionId || j.conversation_id || sid;
    // Formato JSON (builds novos): a resposta vem num campo; texto (builds
    // antigos): o stdout inteiro É a resposta. Cost-estimator segue $0 p/ agy.
    if (typeof j.response === "string") result = j.response;
    else if (typeof j.result === "string") result = j.result;
  } catch { /* texto puro — mantém stdout inteiro */ }

  return {
    ok: exitCode === 0, runtime: "antigravity-cli", sessionId, result,
    costUsd: null, exitCode, stderr, durationMs,
    error: exitCode === 0 ? undefined : (stderr || "agy failed"),
  };
}

// Kimi Code CLI (`kimi`, MoonshotAI/kimi-code). Open-weight Moonshot models
// (K2.x / K3), 1M context, agentic-coding-first. Free + agentic when authed
// with a Kimi.com account via `kimi` → `/login` (OAuth, no API key); paid via
// a `[providers.*]` type="openai" block in ~/.kimi-code/config.toml pointing at
// api.moonshot.ai or OpenRouter. Cost stays $0-tracked here (the free OAuth tier
// reports no per-call spend, same as gemini/agy).
//
// Headless: `kimi -p <prompt>` is one-shot (no TUI); the model is picked with
// `-m <id>` (e.g. `k3`). We ask for `--output-format stream-json` (NDJSON) —
// like agy's stream-json it survives non-TTY spawns where plain-text render can
// drop the final line. Old builds may lack the flag → retry without it (stdout
// then carries the plain assistant text). The model comes ONLY from the cascade
// entry (`kimi-cli:k3`), never hardcoded — engine stays model-agnostic.
function runKimi(opts: RunHeadlessOpts): RunHeadlessResult {
  const started = Date.now();
  const sid = opts.sessionId || randomUUID();
  const args = ["-p", withPreamble(opts), "--output-format", "stream-json"];
  const kmModel = opts.model ?? resolveSystemModel("kimi-cli");
  if (kmModel) args.push("-m", kmModel);

  const spawnOpts = {
    cwd: opts.cwd,
    encoding: "utf8" as const,
    ...(typeof opts.timeoutMs === "number" ? { timeout: opts.timeoutMs } : {}),
    maxBuffer: 64 * 1024 * 1024,
  };
  let r = spawnSync("kimi", args, spawnOpts);
  if ((r.status ?? 1) !== 0 && /output[- ]format|unknown|unrecognized|invalid (option|flag|argument)/i.test(r.stderr || "")) {
    const i = args.indexOf("--output-format");
    r = spawnSync("kimi", [...args.slice(0, i), ...args.slice(i + 2)], spawnOpts);
  }

  const durationMs = Date.now() - started;
  const exitCode = r.status ?? (r.signal ? 124 : 1);
  const stderr = (r.stderr || "").trim();
  const rawStdout = (r.stdout || "").trim();

  // stream-json = NDJSON events. Extract the assistant's final text defensively
  // (schema varies by build), accumulating any assistant-content field; if the
  // output isn't NDJSON (plain-text fallback path) keep the whole stdout.
  let sessionId: string | null = sid;
  let assistant = "";
  let sawJson = false;
  for (const line of rawStdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t);
      sawJson = true;
      sessionId = j.session_id || j.sessionId || j.conversation_id || j?.session?.id || sessionId;
      const piece = typeof j.text === "string" ? j.text
        : typeof j.content === "string" ? j.content
        : typeof j.response === "string" ? j.response
        : typeof j.message === "string" ? j.message
        : typeof j?.delta?.text === "string" ? j.delta.text
        : typeof j?.message?.content === "string" ? j.message.content
        : "";
      if (piece) assistant += piece;
    } catch { /* not a json line */ }
  }
  const result = (sawJson && assistant) ? assistant.trim() : rawStdout;

  return {
    ok: exitCode === 0, runtime: "kimi-cli", sessionId, result,
    costUsd: null, exitCode, stderr, durationMs,
    error: exitCode === 0 ? undefined : (stderr || "kimi failed"),
  };
}

// Grok Build CLI (`grok`, xAI). Agentic coding + native media gen (image/i2v).
// Two auth rails: (A) `grok` subscription login ($0 marginal, same rail the
// grok-studio-nirvana squad uses) or (B) xAI API via XAI_API_KEY (pay-per-token).
// Model comes ONLY from the cascade entry (`grok-cli:<model>`) — engine stays
// model-agnostic. O custo vem do próprio JSON (`total_cost_usd`), quando o build
// reporta; na trilha de assinatura pode vir ausente/zero.
//
// Headless: `grok -p <prompt> --output-format json --always-approve --cwd <dir>`.
// `--always-approve` auto-aprova execuções de tool (sem ela um run headless
// trava esperando aprovação) — é a flag DOCUMENTADA; `--yolo` é só um alias
// oculto, que some sem aviso entre builds. `--output-format json` devolve um
// objeto único (chaves reais: text/sessionId/total_cost_usd).
// Builds antigos podem não ter `--output-format` → retry sem ela (stdout puro).
function runGrok(opts: RunHeadlessOpts): RunHeadlessResult {
  const started = Date.now();
  const sid = opts.sessionId || randomUUID();
  const args = ["-p", withPreamble(opts), "--output-format", "json", "--cwd", opts.cwd];
  if (opts.yolo !== false) args.push("--always-approve");
  const gkModel = opts.model ?? resolveSystemModel("grok-cli");
  if (gkModel) args.push("-m", gkModel);

  const spawnOpts = {
    cwd: opts.cwd,
    encoding: "utf8" as const,
    ...(typeof opts.timeoutMs === "number" ? { timeout: opts.timeoutMs } : {}),
    maxBuffer: 64 * 1024 * 1024,
  };
  let r = spawnSync("grok", args, spawnOpts);
  if ((r.status ?? 1) !== 0 && /output[- ]format|unknown|unrecognized|invalid (option|flag|argument)/i.test(r.stderr || "")) {
    const i = args.indexOf("--output-format");
    r = spawnSync("grok", [...args.slice(0, i), ...args.slice(i + 2)], spawnOpts);
  }

  const durationMs = Date.now() - started;
  const exitCode = r.status ?? (r.signal ? 124 : 1);
  const stderr = (r.stderr || "").trim();
  const rawStdout = (r.stdout || "").trim();

  // --output-format json = single object; parse defensively (schema varies by
  // build), else keep the whole stdout (plain-text fallback path).
  let sessionId: string | null = sid;
  let result = rawStdout;
  let costUsd: number | null = null;
  try {
    const j = JSON.parse(rawStdout);
    sessionId = j.session_id || j.sessionId || j.conversation_id || j?.session?.id || sid;
    if (typeof j.response === "string") result = j.response;
    else if (typeof j.result === "string") result = j.result;
    else if (typeof j.output === "string") result = j.output;
    else if (typeof j.text === "string") result = j.text;
    const cost = j.total_cost_usd ?? j.totalCostUsd ?? j.cost_usd;
    if (typeof cost === "number" && Number.isFinite(cost)) costUsd = cost;
  } catch { /* plain text — keep stdout */ }

  return {
    ok: exitCode === 0, runtime: "grok-cli", sessionId, result,
    costUsd, exitCode, stderr, durationMs,
    error: exitCode === 0 ? undefined : (stderr || "grok failed"),
  };
}

// Pi Coding Agent (`pi`, Earendil — pi.dev). Harness minimalista multi-provider:
// UM runtime dá acesso a 15+ providers (Anthropic, OpenAI, Google, Bedrock,
// Groq, xAI, OpenRouter…) E a MODELOS LOCAIS (Ollama, llama.cpp, LM Studio,
// vLLM — providers custom em ~/.pi/agent/models.json). Model e provider vêm
// SÓ da entrada `pi:<model>@<provider>` do LLM_CASCADE — nunca hardcoded; o
// @provider vira `--provider` nativo (o pi é, com o codex, o único runtime que
// honra o providerHint de verdade).
//
// Headless (VERIFICADO contra `pi 0.82.1` em 2026-07-28): `pi -p --mode json
// "<prompt>"` — event stream JSONL no stdout: header {"type":"session","id":
// "<uuid>", ...} e o texto do assistant em eventos `message_end` com
// message.content = [{type:"text",text}]. Sessão determinística via
// `--session-id <uuid>` ("exact project session ID, creating it if missing")
// — mesmo padrão do runGemini: nós geramos o id no 1º run e o `nrv revise`
// retoma com o MESMO id. `--append-system-prompt` existe (diretiva vai como
// system prompt DE VERDADE, não dobrada no prompt do usuário).
//
// QUIRK confirmado: o pi sai com EXIT 0 mesmo quando o provider falha — o erro
// vem no stream (message.stopReason === "error" + message.errorMessage, ex.:
// 403 "used all available credits"). ok/error saem do STREAM, não só do exit.
// Custo real vem em message.usage.cost.total (somado por turn do assistant).
//
// Sem popups de permissão por design; `-a/--approve` confia nos ARQUIVOS
// LOCAIS do projeto (extensões/settings — sem TTY não há como responder o
// trust prompt) e `--safe` usa `-na/--no-approve`. Builds antigos sem
// `--mode` → retry em print mode `-p` puro (texto no stdout).
function runPi(opts: RunHeadlessOpts): RunHeadlessResult {
  const started = Date.now();
  const sid = opts.sessionId || randomUUID();
  const flags: string[] = ["--session-id", sid];
  if (opts.appendSystemPrompt) flags.push("--append-system-prompt", opts.appendSystemPrompt);
  const piModel = opts.model ?? resolveSystemModel("pi");
  if (piModel) flags.push("--model", piModel);
  if (opts.providerHint) flags.push("--provider", opts.providerHint);
  flags.push(opts.yolo === false ? "--no-approve" : "--approve");

  const spawnOpts = {
    cwd: opts.cwd,
    encoding: "utf8" as const,
    ...(typeof opts.timeoutMs === "number" ? { timeout: opts.timeoutMs } : {}),
    maxBuffer: 64 * 1024 * 1024,
  };
  let r = spawnSync("pi", ["-p", "--mode", "json", ...flags, opts.prompt], spawnOpts);
  if ((r.status ?? 1) !== 0 && /--mode|unknown|unrecognized|invalid (option|flag|argument)/i.test(r.stderr || "")) {
    r = spawnSync("pi", ["-p", ...flags, opts.prompt], spawnOpts);
  }

  const durationMs = Date.now() - started;
  const exitCode = r.status ?? (r.signal ? 124 : 1);
  const stderr = (r.stderr || "").trim();
  const rawStdout = (r.stdout || "").trim();

  // JSONL de eventos: session id do header, ÚLTIMO texto do assistant dos
  // message_end (a resposta final), erro do stream e custo somado. Se o stdout
  // não for JSONL (fallback print mode), mantém o stdout inteiro como result.
  let sessionId: string | null = sid;
  let assistant = "";
  let sawJson = false;
  let costUsd: number | null = null;
  let streamError: string | null = null;
  for (const line of rawStdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t);
      sawJson = true;
      if (j.type === "session") { sessionId = j.id || j.session_id || sessionId; continue; }
      const msg = j.message;
      if (j.type === "message_end" && msg && msg.role === "assistant") {
        let text = "";
        if (typeof msg.content === "string") text = msg.content;
        else if (Array.isArray(msg.content)) {
          text = msg.content
            .map((b: any) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : ""))
            .join("");
        }
        if (text.trim()) assistant = text; // último assistant vence
        // Exit 0 não significa sucesso: o erro do provider vem no próprio turn.
        // Um turn posterior bem-sucedido (retry interno do pi) limpa o erro.
        if (msg.stopReason === "error" || typeof msg.errorMessage === "string") {
          streamError = msg.errorMessage || "pi assistant turn ended with stopReason=error";
        } else {
          streamError = null;
        }
        const cost = msg?.usage?.cost?.total;
        if (typeof cost === "number" && Number.isFinite(cost)) costUsd = (costUsd ?? 0) + cost;
      }
    } catch { /* not a json line */ }
  }
  const result = (sawJson && assistant) ? assistant.trim() : rawStdout;
  const ok = exitCode === 0 && streamError === null;

  return {
    ok, runtime: "pi", sessionId, result,
    costUsd, exitCode, stderr, durationMs,
    error: ok ? undefined : (streamError || stderr || "pi failed"),
  };
}

export function runHeadless(opts: RunHeadlessOpts): RunHeadlessResult {
  switch (opts.runtime) {
    case "claude-code":
      return runClaudeCode(opts);
    case "codex":
      return runCodex(opts);
    case "gemini-cli":
      return runGemini(opts);
    case "antigravity-cli":
      return runAntigravity(opts);
    case "kimi-cli":
      return runKimi(opts);
    case "grok-cli":
      return runGrok(opts);
    case "pi":
      return runPi(opts);
    default:
      return {
        ok: false, runtime: opts.runtime, sessionId: null, result: "", costUsd: null,
        exitCode: 2, stderr: "", durationMs: 0,
        error: `unknown runtime '${opts.runtime}'. Use claude-code | codex | gemini-cli | antigravity-cli | kimi-cli | grok-cli | pi.`,
      };
  }
}

/** True if the runtime's CLI binary is on PATH. Cross-platform: uses `where`
 * on Windows, `which` elsewhere. */
export function runtimeAvailable(runtime: Runtime): boolean {
  const bin = runtime === "claude-code" ? "claude"
    : runtime === "codex" ? "codex"
    : runtime === "antigravity-cli" ? "agy"
    : runtime === "kimi-cli" ? "kimi"
    : runtime === "grok-cli" ? "grok"
    : runtime === "pi" ? "pi"
    : "gemini";
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [bin], { encoding: "utf8" });
  return r.status === 0;
}
