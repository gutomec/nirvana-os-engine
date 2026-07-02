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

export type Runtime = "claude-code" | "codex" | "gemini-cli" | "antigravity-cli";

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
   * ~/.codex/config.toml; qwen-code modelProviders[].id). Ignored by
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
  if (opts.model) args.push("--model", opts.model);

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
  if (opts.model) args.push("--model", opts.model);
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
  if (opts.model) args.push("--model", opts.model);
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
  // agy flags CONFIRMED via `agy --help`: -p/--print runs a single prompt
  // non-interactively and prints the response. There is NO --output-format
  // (plain text out, not JSON). Resume = --continue (most recent conversation)
  // or --conversation <id>; we can't set our own id upfront, so we use
  // --continue. Autonomy = --dangerously-skip-permissions (auto-approve every
  // tool permission — without it agy halts waiting for approval).
  const args = ["-p", withPreamble(opts)];
  if (opts.sessionId) args.push("--continue");
  if (opts.model) args.push("--model", opts.model);
  if (opts.yolo !== false) args.push("--dangerously-skip-permissions");
  for (const d of opts.addDirs ?? []) args.push("--add-dir", d);

  const r = spawnSync("agy", args, {
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
    sessionId = j.session_id || j.sessionId || j.conversation_id || sid;
  } catch { /* keep sid */ }
  // agy --print emits the plain response (no JSON / no usage block), so we keep
  // the full stdout as the result; the cost-estimator falls back to $0 for this
  // runtime. (The JSON.parse above is best-effort: if a future agy build prints
  // JSON it picks up the conversation id, otherwise we keep the random sid.)
  const result = rawStdout;

  return {
    ok: exitCode === 0, runtime: "antigravity-cli", sessionId, result,
    costUsd: null, exitCode, stderr, durationMs,
    error: exitCode === 0 ? undefined : (stderr || "agy failed"),
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
    default:
      return {
        ok: false, runtime: opts.runtime, sessionId: null, result: "", costUsd: null,
        exitCode: 2, stderr: "", durationMs: 0,
        error: `unknown runtime '${opts.runtime}'. Use claude-code | codex | gemini-cli | antigravity-cli.`,
      };
  }
}

/** True if the runtime's CLI binary is on PATH. Cross-platform: uses `where`
 * on Windows, `which` elsewhere. */
export function runtimeAvailable(runtime: Runtime): boolean {
  const bin = runtime === "claude-code" ? "claude"
    : runtime === "codex" ? "codex"
    : runtime === "antigravity-cli" ? "agy"
    : "gemini";
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [bin], { encoding: "utf8" });
  return r.status === 0;
}
