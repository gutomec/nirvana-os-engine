// maestro-turn.ts — one Message of a Glance conversation is one turn of the project's runtime session.
//
// The Message prepares no Run. The server starts the host runtime headless in the root of the
// adopted project, with the Message as the prompt, the conversation's session resumed and a short
// maestro directive appended to the system prompt. That child reads the project's CLAUDE.md and
// has the harness skill, so it behaves as the maestro of a terminal session: it answers questions
// directly and, when the user asks for work, follows the harness protocol and opens Runs through
// the ordinary scripts (brief-*, `nrv dispatch --exec`), which reach the Runs tab as they do today.
//
// The runtime's output is normalized the way the chat concierge did ({t:"tok"|"tool"|"done"}), plus
// {t:"run"} when the project's audit shows a Run opening during the turn; the events reach the chat
// by SSE (server.ts streams `subscribe`). The final reply is written to the conversation once, as
// the assistant; the conversation keeps `session_id` and `session_runtime`, so the next turn
// resumes the session and a page reload loses nothing. One turn per conversation at a time: a
// second Message waits in the conversation's lane. Cancelling signals the turn's process group.
//
// claude-code streams (`--output-format stream-json --include-partial-messages`) and is spawned
// directly. Every other runtime goes through the driver's runHeadless (its per-runtime flags,
// `codex exec resume <sid>` included) inside a child of this module (`--child`), because
// runHeadless is synchronous and must not block the server's event loop; those runtimes deliver
// at the end. The autonomy flags follow execution.headless_skip_permissions, as the driver's do.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { paths as nrvPaths } from "../../../_shared/lib/bun-helpers.ts";
import { DEFAULT_ALLOWED_TOOLS, resolveExecutable, runHeadless, runtimeAvailable, type Runtime } from "../../../_shared/lib/host-agent-driver.ts";
import { harnessLogsDir } from "../../../_shared/lib/log-paths.ts";
import { resolveSetting, settingsEnvForChild } from "../../../_shared/lib/settings.ts";
import { resolveSystemModel } from "../../../_shared/lib/system-model.ts";
import { canonicalRuntimeName } from "../runtime-rules.ts";
import type { ConversationService } from "./conversation-service.ts";
import { detectExecutionRuntime, signalProcessGroup } from "./execution-runner.ts";
import { parseAuditLine } from "../../../_shared/lib/cloudevents.js";

/** Wall-clock ceiling of one turn. A turn that dispatches work waits for the dispatch, so the
 * ceiling is the dispatch's order of magnitude, not the concierge's five minutes. */
export const MAESTRO_TURN_TIMEOUT_MS = 45 * 60_000;
/** How often a running turn re-reads the project's audit for Runs it opened. */
const AUDIT_POLL_MS = 1500;
const MAESTRO_TURN_SCRIPT = fileURLToPath(import.meta.url);
const MAX_CATALOG_HINT_CHARS = 8000;

// i18n-user-facing: the directive is what the maestro reads; PT-BR by the project's language rule.
export const MAESTRO_DIRECTIVE = [
  "Você é o maestro do Nirvana-OS DESTE projeto, falando pelo chat do Glance. Vale aqui o mesmo protocolo do `CLAUDE.md` do projeto e do skill `harness`: você orquestra, e o trabalho é dos despachos. A sessão é longa: continue o contexto das mensagens anteriores.",
  "",
  "Perguntas e conversa: responda em português, direto, sem despachar nada. Para listar, contar ou indicar empresas e squads, use a linha de catálogo no fim desta diretiva, sem rodar comandos; consulte os comandos de leitura (`nrv find \"<termo>\"`, `nrv config list`, os registros de empresas, squads e mind-clones, `nrv run-track list`) só quando o catálogo não bastar. Saudação recebe conversa, não pipeline.",
  "",
  "Pedido de trabalho: siga o protocolo do harness (brief enriquecido em `.nirvana/briefs/`, cascata Empresa → Squad → agent-x, `run-track` e audit, gate, entrega). Antes de começar, diga qual empresa, squad, mind-clone e runtime usaria, o modo (standard, Gauntlet e intensidade, multi-target) e por quê, e pergunte o que falta no brief. `use business <slug>:` ou `use squad <slug>:` no início da mensagem é ordem do usuário. Respeite as settings (`gauntlet.default_mode`, `routing.mode`). Nunca pule o gate.",
  "",
  "Runtime: sem escolha do usuário, o padrão é o runtime desta sessão; as regras `USE_*`/`NOT_USE_*` do `.env` redirecionam por tipo de tarefa. Se perguntarem com qual sistema você vai trabalhar, explique isso e diga sua escolha.",
  "",
  "Estilo: markdown, conciso. Você está numa janela de chat estreita; uma saudação merece uma ou duas frases.",
].join("\n");

/** One light catalog line from the project's registries (else the user's): each business with up
 * to three domains, the squads by slug. Enough for "which business for X" without a tool call;
 * `nrv find` (a full router pass, tens of seconds) stays for what the line cannot answer. */
export function catalogHint(projectRoot: string): string {
  const entries = (file: string, key: string): Array<[string, any]> => {
    try { return Object.entries(JSON.parse(fs.readFileSync(file, "utf8"))[key] ?? {}).sort(([a], [b]) => a.localeCompare(b)); } catch { return []; }
  };
  const first = (name: string, fallback: string, key: string): Array<[string, any]> => {
    const local = entries(path.join(projectRoot, ".nirvana", name), key);
    return local.length ? local : entries(fallback, key);
  };
  const businesses = first(".businesses-registry.json", nrvPaths.BUSINESSES_REGISTRY_PATH, "businesses");
  const squads = first(".squads-registry.json", nrvPaths.SQUADS_REGISTRY_PATH, "squads");
  if (!businesses.length && !squads.length) return "";
  const line = ([slug, entry]: [string, any]) => {
    const domains = Array.isArray(entry?.domains) ? entry.domains.slice(0, 3).map(String).join(", ") : "";
    return domains ? `${slug} (${domains})` : slug;
  };
  const head = `Instalado neste escopo: ${businesses.length} empresas e ${squads.length} squads. Empresas: ${businesses.map(line).join("; ") || "nenhuma"}. Squads: `;
  // Every business line stays; the squads list is cut to the budget, saying how many were left out.
  const listed: string[] = [];
  let used = head.length;
  for (const [slug] of squads) { if (used + slug.length + 2 > MAX_CATALOG_HINT_CHARS) break; listed.push(slug); used += slug.length + 2; }
  const omitted = squads.length - listed.length;
  const squadsPart = listed.length ? `${listed.join(", ")}${omitted > 0 ? ` e mais ${omitted}` : ""}` : (squads.length ? `${squads.length} (liste com \`nrv find\`)` : "nenhum");
  return `${head}${squadsPart}. Detalhes de cada uma: \`nrv find "<termo>"\`.`;
}

/** The system-prompt suffix of a turn: the directive plus the light catalog line. */
export function maestroDirective(projectRoot: string): string {
  const hint = catalogHint(projectRoot);
  return hint ? `${MAESTRO_DIRECTIVE}\n\n${hint}` : MAESTRO_DIRECTIVE;
}

/** The environment of a turn's child: the server's, the effective settings pinned as the variables
 * the child reads (so the project's config holds in it), the project root and the project's harness
 * log, the same anchors the execution runner gives a dispatch child. */
export function turnEnvironment(projectRoot: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  env.NIRVANA_PROJECT_ROOT = projectRoot;
  Object.assign(env, settingsEnvForChild({ env, projectRoot }));
  if (!env.HARNESS_LOGS_DIR) env.HARNESS_LOGS_DIR = harnessLogsDir({ projectRoot });
  return env;
}

/** How a CLI is started on this platform (`resolveExecutable`'s shape). Injected in tests so the
 * shell branch below is exercised deterministically, without depending on the runner's PATH probe. */
export type ExecutableResolver = (cli: string) => { command: string; args: (a: string[]) => string[]; shell: boolean };

export interface TurnCommand {
  command: string; args: string[]; shell: boolean; sessionId: string;
  /** Files written for delivery (the directive under a shell); removed when the child closes. */
  tmpFiles?: string[];
}

/** The `claude -p` command line of a turn. A conversation without a session gets a fresh
 * `--session-id`, so the id is known before the child answers; one with a session resumes it.
 * The autonomy flag follows the driver's rule: the bypass, or the restricted path (`acceptEdits`
 * plus the driver's tool allowlist) when execution.headless_skip_permissions is off.
 *
 * The directive spans several lines. On Windows a `.cmd` whose shape `resolveExecutable` cannot
 * read is still started through the command interpreter, and cmd.exe ends the command line at the
 * first newline of an argument: everything after `--append-system-prompt` (the autonomy flag, the
 * budget) was lost. Under a shell the directive therefore travels as
 * `--append-system-prompt-file <temp file>`; without one it stays inline, as before. */
export function claudeTurnCommand(input: { sessionId: string | null; directive: string; model?: string | null; skipPermissions: boolean; maxBudgetUsd: number },
  resolve: ExecutableResolver = resolveExecutable): TurnCommand {
  const sessionId = input.sessionId ?? randomUUID();
  const executable = resolve("claude");
  const tmpFiles: string[] = [];
  const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
    input.sessionId ? "--resume" : "--session-id", sessionId];
  if (executable.shell) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-maestro-")), "directive.md");
    fs.writeFileSync(file, input.directive, "utf8");
    tmpFiles.push(file);
    args.push("--append-system-prompt-file", file);
  } else {
    args.push("--append-system-prompt", input.directive);
  }
  if (input.model) args.push("--model", input.model);
  if (input.skipPermissions) args.push("--dangerously-skip-permissions");
  else args.push("--allowedTools", DEFAULT_ALLOWED_TOOLS.join(" "), "--permission-mode", "acceptEdits");
  if (input.maxBudgetUsd > 0) args.push("--max-budget-usd", String(input.maxBudgetUsd));
  return { command: executable.command, args: executable.args(args), shell: executable.shell, sessionId, ...(tmpFiles.length ? { tmpFiles } : {}) };
}

export type TurnStreamEvent = { t: "tok"; v: string } | { t: "tool"; name: string; cmd: string };
export interface TurnRunLink { run_id: string; trace_id: string | null; target_slug: string | null; target_kind: string | null; runtime: string | null }
export type TurnEvent = TurnStreamEvent | ({ t: "run" } & TurnRunLink)
  | { t: "done"; ok: boolean; state: TurnState; result: string; session_id: string | null; resume_command: string | null; cost_usd: number | null; runtime: Runtime; error: string | null; reason: string | null };

function toolLabel(block: any): string {
  const input = block?.input || {};
  if (block?.name === "Bash" && typeof input.command === "string") return input.command.slice(0, 120);
  if (typeof input.description === "string") return input.description.slice(0, 120);
  const firstString = Object.values(input).find(value => typeof value === "string") as string | undefined;
  return (firstString || "").slice(0, 120);
}

/** Normalizes the stream-json of `claude -p` into the chat's events and keeps the `result`. */
export class ClaudeStreamParser {
  result = "";
  sessionId: string | null = null;
  costUsd: number | null = null;
  subtype: string | undefined;
  isError = false;
  private buffer = "";
  constructor(private readonly onEvent: (event: TurnStreamEvent) => void) {}
  feed(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) { this.line(this.buffer.slice(0, newline)); this.buffer = this.buffer.slice(newline + 1); }
  }
  end(): void { this.line(this.buffer); this.buffer = ""; }
  line(line: string): void {
    if (!line.trim()) return;
    let data: any;
    try { data = JSON.parse(line); } catch { return; }
    if (data.type === "stream_event") {
      const event = data.event;
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) this.onEvent({ t: "tok", v: event.delta.text });
    } else if (data.type === "assistant") {
      for (const block of data.message?.content ?? []) if (block?.type === "tool_use") this.onEvent({ t: "tool", name: block.name, cmd: toolLabel(block) });
    } else if (data.type === "system" && data.subtype === "init") {
      if (typeof data.session_id === "string") this.sessionId = data.session_id;
    } else if (data.type === "result") {
      if (typeof data.result === "string") this.result = data.result;
      if (typeof data.session_id === "string") this.sessionId = data.session_id;
      if (typeof data.total_cost_usd === "number") this.costUsd = data.total_cost_usd;
      if (typeof data.subtype === "string") this.subtype = data.subtype;
      if (data.is_error === true) this.isError = true;
    }
  }
}

export interface StartTurnInput {
  runtime: Runtime;
  prompt: string;
  cwd: string;
  sessionId: string | null;
  directive: string;
  model?: string | null;
  skipPermissions: boolean;
  maxBudgetUsd: number;
  env: Record<string, string>;
  onEvent(event: TurnStreamEvent): void;
}
export interface TurnOutcome { ok: boolean; result: string; sessionId: string | null; costUsd: number | null; exitCode: number | null; signal: string | null; error?: string; subtype?: string; durationMs: number }

/** How the user continues the same native session from a terminal in the project root. */
export function resumeCommand(runtime: Runtime, sessionId: string): string {
  switch (runtime) {
    case "claude-code": return `claude --resume ${sessionId}`;
    case "codex": return `codex resume ${sessionId}`;
    case "gemini-cli": return `gemini -r ${sessionId}`;
    case "pi": return `pi --session ${sessionId}`;
    default: return `${runtime}: sessão ${sessionId}`;
  }
}
export interface StartedTurn {
  pid: number;
  argv: string[];
  /** Known up front for claude-code (`--session-id`); null when the runtime assigns it at the end. */
  sessionId: string | null;
  done: Promise<TurnOutcome>;
  kill(): void;
}

/** Starts one turn as a child that leads its own process group (`kill` reaches the runtime and
 * whatever it spawned). Resolves when the child's stdio closed, never rejects. */
export function startMaestroTurn(input: StartTurnInput): StartedTurn {
  const started = Date.now();
  const streaming = input.runtime === "claude-code";
  const command = streaming ? claudeTurnCommand(input) : childCommand(input);
  const child = spawn(command.command, command.args, {
    cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true, shell: command.shell,
  });
  const parser = new ClaudeStreamParser(input.onEvent);
  let childDone: TurnOutcome | null = null;
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    if (streaming) { parser.feed(chunk); return; }
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.t === "done") childDone = { ok: data.ok === true, result: String(data.result ?? ""), sessionId: data.session_id ?? null, costUsd: typeof data.cost_usd === "number" ? data.cost_usd : null, exitCode: 0, signal: null, error: data.error ?? undefined, durationMs: 0 };
        else if (data.t === "tok" || data.t === "tool") input.onEvent(data);
      } catch { /* not an event line */ }
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => { if (stderr.length < 8000) stderr += chunk; });
  child.stdin!.on("error", () => { /* the child exited before reading the prompt */ });
  child.stdin!.end(streaming ? input.prompt : JSON.stringify({ prompt: input.prompt, directive: input.directive }));
  const done = new Promise<TurnOutcome>(resolve => {
    let settled = false;
    const finish = (exitCode: number | null, signal: string | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      parser.end();
      for (const file of command.tmpFiles ?? []) { try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* already gone */ } }
      const base = streaming
        ? { ok: exitCode === 0 && !parser.isError, result: parser.result, sessionId: parser.sessionId ?? command.sessionId, costUsd: parser.costUsd, subtype: parser.subtype }
        : { ok: childDone?.ok === true && exitCode === 0, result: childDone?.result ?? "", sessionId: childDone?.sessionId ?? null, costUsd: childDone?.costUsd ?? null };
      const error = base.ok ? undefined : (spawnError ?? childDone?.error ?? stderr.trim().split("\n").filter(Boolean).at(-1) ?? `runtime exited with ${exitCode ?? signal ?? "a signal"}`);
      resolve({ ...base, exitCode, signal, durationMs: Date.now() - started, ...(error ? { error } : {}) });
    };
    child.once("close", (code, signal) => finish(code, signal));
    child.once("error", error => finish(null, null, error.message));
  });
  return {
    pid: child.pid ?? 0, argv: [command.command, ...command.args], sessionId: command.sessionId || null, done,
    kill() { if (child.pid) signalProcessGroup(child.pid); },
  };
}

/** The non-streaming runtimes: a child of this module runs the driver synchronously. */
function childCommand(input: StartTurnInput): TurnCommand {
  const args = [MAESTRO_TURN_SCRIPT, "--child", "--runtime", input.runtime, "--cwd", input.cwd];
  if (input.sessionId) args.push("--resume", input.sessionId);
  if (input.model) args.push("--model", input.model);
  if (input.maxBudgetUsd > 0) args.push("--max-budget-usd", String(input.maxBudgetUsd));
  return { command: "bun", args, shell: false, sessionId: input.sessionId ?? "" };
}

/** The legacy chat action (`chat-agent` → chat-concierge.ts): one turn from `cwd`, the events on
 * stdout as NDJSON for the job stream, and the `done` line at the end. */
export async function runMaestroTurnToStdout(input: { prompt: string; cwd: string; sessionId: string | null; runtime?: string; fast?: boolean }): Promise<void> {
  const emit = (event: Record<string, unknown>) => process.stdout.write(JSON.stringify(event) + "\n");
  if (!input.prompt.trim()) { emit({ t: "done", ok: true, state: "completed", result: "(mensagem vazia)", session_id: input.sessionId, cost_usd: 0 }); return; }
  const projectRoot = path.resolve(input.cwd);
  const env = turnEnvironment(projectRoot);
  const runtime = input.runtime ? canonicalRuntimeName(input.runtime) : detectExecutionRuntime(env).runtime;
  const directive = maestroDirective(projectRoot) + (input.fast ? "\n\nModo rápido: responda curto, sem deliberar." : "");
  const child = startMaestroTurn({
    runtime, prompt: input.prompt, cwd: projectRoot, sessionId: input.sessionId, directive, env, onEvent: emit,
    model: resolveSystemModel(runtime), skipPermissions: resolveSetting("execution.headless_skip_permissions", { projectRoot }).value,
    maxBudgetUsd: resolveSetting("glance.maestro_max_budget_usd", { projectRoot }).value,
  });
  const outcome = await child.done;
  emit({ t: "done", ok: outcome.ok, state: outcome.ok ? "completed" : "failed", result: outcome.result || outcome.error || "(sem resposta)",
    session_id: outcome.sessionId, cost_usd: outcome.costUsd, runtime, error: outcome.error ?? null, reason: null });
}

// ── the queue: one turn per conversation at a time ───────────────────────────────────────────

export type TurnState = "queued" | "running" | "completed" | "failed" | "cancelled" | "unavailable";
export interface TurnView {
  turn_id: string; conversation_id: string; project_id: string; message_id: string;
  state: TurnState; position: number; runtime: Runtime; session_id: string | null;
  created_at: string; started_at: string | null; ended_at: string | null;
  cost_usd: number | null; result_message_id: string | null; runs: TurnRunLink[];
  reason: string | null; detail: string | null;
}
export interface TurnReceipt { turn: TurnView; session: { session_id: string | null; session_runtime: string | null } }
export type TurnAudit = (event: string, payload: Record<string, unknown>, ctx: Record<string, unknown>) => void;
export interface MaestroTurnQueueOptions {
  projectRoot: string;
  /** Environment of the children; default turnEnvironment(projectRoot) at every start. */
  env?: () => Record<string, string>;
  /** Audit sink; default lib/audit.js anchored on the project's harness log. */
  audit?: TurnAudit;
  timeoutMs?: number;
}
type TurnListener = (sequence: number, event: TurnEvent) => void;
interface TurnItem extends TurnView {
  prompt: string; events: TurnEvent[]; listeners: Set<TurnListener>;
  child: StartedTurn | null; cancelRequested: boolean; timedOut: boolean; session_recreated_from: string | null;
}

const TERMINAL_TURN_STATES: ReadonlySet<TurnState> = new Set(["completed", "failed", "cancelled", "unavailable"]);
const RECAP_MESSAGES = 6;
const RECAP_CHARS_PER_MESSAGE = 600;

// i18n-user-facing: the recap is read by the maestro, in the conversation's language.
/** The last visible messages of the conversation (the current Message excluded), labelled as a recap, for a session the runtime lost. */
export function continuityRecap(messages: Array<{ message_id: string; role: string; content: string }>, currentMessageId: string): string {
  const visible = messages.filter(message => message.message_id !== currentMessageId && message.role !== "system").slice(-RECAP_MESSAGES);
  const lines = visible.map(message => {
    const text = message.content.replace(/\s+/g, " ").trim();
    return `- ${message.role === "user" ? "usuário" : "assistente"}: ${text.length > RECAP_CHARS_PER_MESSAGE ? text.slice(0, RECAP_CHARS_PER_MESSAGE) + "…" : text}`;
  });
  return ["Recapitulação da conversa (a sessão anterior do runtime não existe mais; esta é uma sessão nova, continue de onde parou):", ...(lines.length ? lines : ["- (sem mensagens anteriores)"])].join("\n");
}

function defaultAudit(): TurnAudit {
  const audit = createRequire(import.meta.url)("../audit.js") as { emit(event: string, payload: Record<string, unknown>, ctx: Record<string, unknown>): void };
  return (event, payload, ctx) => { try { audit.emit(event, payload, ctx); } catch (error) { console.error(`[glance] audit not written (${(error as Error).message})`); } };
}

export class MaestroTurnQueue {
  private readonly turns = new Map<string, TurnItem>();
  private readonly lanes = new Map<string, TurnItem[]>();
  private readonly active = new Map<string, TurnItem>();
  private readonly audit: TurnAudit;
  private stopped = false;
  constructor(private readonly conversations: ConversationService, private readonly options: MaestroTurnQueueOptions) {
    this.audit = options.audit ?? defaultAudit();
  }

  /** The runtime a turn runs on, by the dispatch's own rule over the project's effective settings. */
  runtime(): Runtime { return detectExecutionRuntime(this.environment()).runtime; }

  /** Why a turn cannot start now, or null: `glance.execution` off, or the runtime's CLI missing. */
  unavailable(): string | null {
    if (!resolveSetting("glance.execution", { env: process.env, projectRoot: this.options.projectRoot }).value) return "glance.execution=false";
    const runtime = this.runtime();
    return runtimeAvailable(runtime) ? null : `runtime ${runtime} is not on PATH`;
  }

  /** Queues one turn for the Message and starts it unless the conversation has one running. A
   * turn that cannot start (`unavailable`) is answered, never queued, with `capability_unavailable`. */
  submit(input: { projectId: string; conversationId: string; messageId: string; prompt: string }): TurnReceipt {
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation || conversation.project_id !== input.projectId) throw new Error("conversation does not belong to project");
    const session = { session_id: conversation.session_id ?? null, session_runtime: conversation.session_runtime ?? null };
    const now = new Date().toISOString();
    const runtime = this.runtime();
    const base: TurnView = {
      turn_id: `trn_${randomUUID()}`, conversation_id: input.conversationId, project_id: input.projectId, message_id: input.messageId,
      state: "queued", position: 0, runtime, session_id: session.session_runtime === runtime ? session.session_id : null,
      created_at: now, started_at: null, ended_at: null, cost_usd: null, result_message_id: null, runs: [], reason: null, detail: null,
    };
    const detail = this.stopped ? "server is shutting down" : this.unavailable();
    if (detail) return { turn: { ...base, state: "unavailable", reason: "capability_unavailable", detail }, session };
    const item: TurnItem = { ...base, prompt: input.prompt, events: [], listeners: new Set(), child: null, cancelRequested: false, timedOut: false, session_recreated_from: null };
    this.turns.set(item.turn_id, item);
    const lane = this.lanes.get(input.conversationId) ?? [];
    lane.push(item);
    this.lanes.set(input.conversationId, lane);
    item.position = this.active.has(input.conversationId) ? lane.length : lane.length - 1;
    this.drain(input.conversationId);
    return { turn: this.view(item), session };
  }

  get(turnId: string): TurnView | null {
    const item = this.turns.get(turnId);
    return item ? this.view(item) : null;
  }

  /** The turn running or queued for a conversation, so a reloaded page can subscribe again. */
  activeFor(conversationId: string): TurnView | null {
    const running = this.active.get(conversationId);
    if (running) return this.view(running);
    const queued = this.lanes.get(conversationId)?.[0];
    return queued ? this.view(queued) : null;
  }

  hasActive(): boolean { return this.active.size > 0; }

  /** Replays the events after `after` and then follows the turn live; the returned function stops
   * following. A terminal turn only replays (its `done` is the last event). */
  subscribe(turnId: string, after: number, listener: TurnListener): () => void {
    const item = this.turns.get(turnId);
    if (!item) return () => {};
    for (let index = Math.max(0, after); index < item.events.length; index++) listener(index + 1, item.events[index]);
    if (TERMINAL_TURN_STATES.has(item.state)) return () => {};
    item.listeners.add(listener);
    return () => { item.listeners.delete(listener); };
  }

  /** A queued turn ends `cancelled` at once; a running one gets SIGTERM on its process group and
   * ends `cancelled` when the child exits. */
  cancel(projectId: string, turnId: string): { accepted: boolean; state: TurnState | "cancelling" | "not_found" } {
    const item = this.turns.get(turnId);
    if (!item || item.project_id !== projectId) return { accepted: false, state: "not_found" };
    if (item.state === "queued") {
      this.removeFromLane(item);
      item.cancelRequested = true;
      this.finish(item, { ok: false, result: "", sessionId: item.session_id, costUsd: null, exitCode: null, signal: null, durationMs: 0 });
      return { accepted: true, state: "cancelled" };
    }
    if (item.state === "running") {
      item.cancelRequested = true;
      item.child?.kill();
      return { accepted: true, state: "cancelling" };
    }
    return { accepted: false, state: item.state };
  }

  /** Stops accepting turns and signals the running ones; the server is going away. */
  shutdown(): void {
    this.stopped = true;
    for (const item of this.active.values()) { item.cancelRequested = true; item.child?.kill(); }
    for (const lane of this.lanes.values()) for (const item of [...lane]) this.cancel(item.project_id, item.turn_id);
  }

  private environment(): Record<string, string> { return this.options.env?.() ?? turnEnvironment(this.options.projectRoot); }

  private view(item: TurnItem): TurnView {
    const { prompt: _prompt, events: _events, listeners: _listeners, child: _child, cancelRequested: _cancel, timedOut: _timedOut, session_recreated_from: _from, ...view } = item;
    return { ...view, runs: [...item.runs] };
  }

  private removeFromLane(item: TurnItem): void {
    const lane = this.lanes.get(item.conversation_id);
    if (!lane) return;
    const index = lane.indexOf(item);
    if (index >= 0) lane.splice(index, 1);
    lane.forEach((queued, position) => { queued.position = this.active.has(item.conversation_id) ? position + 1 : position; });
    if (!lane.length) this.lanes.delete(item.conversation_id);
  }

  private drain(conversationId: string): void {
    if (this.active.has(conversationId)) return;
    const next = this.lanes.get(conversationId)?.find(item => item.state === "queued");
    if (!next) return;
    this.removeFromLane(next);
    this.active.set(conversationId, next);
    void this.run(next);
  }

  private push(item: TurnItem, event: TurnEvent): void {
    item.events.push(event);
    const sequence = item.events.length;
    for (const listener of item.listeners) { try { listener(sequence, event); } catch { /* a listener never breaks the turn */ } }
  }

  private async run(item: TurnItem): Promise<void> {
    item.state = "running";
    item.started_at = new Date().toISOString();
    const projectRoot = this.options.projectRoot;
    const env = this.environment();
    const directive = maestroDirective(projectRoot);
    const skipPermissions = resolveSetting("execution.headless_skip_permissions", { env: process.env, projectRoot }).value;
    const maxBudgetUsd = resolveSetting("glance.maestro_max_budget_usd", { env: process.env, projectRoot }).value;
    const model = resolveSystemModel(item.runtime);
    // The session is read when the turn STARTS: a turn queued behind another resumes the session
    // that one leaves, not the one the conversation had when the Message arrived.
    const conversation = this.conversations.get(item.conversation_id);
    let sessionId = conversation?.session_runtime === item.runtime ? conversation.session_id : null;
    item.session_id = sessionId;
    let prompt = item.prompt;
    let outcome: TurnOutcome = { ok: false, result: "", sessionId, costUsd: null, exitCode: null, signal: null, durationMs: 0, error: "turn never started" };
    for (let attempt = 0; attempt < 2 && !item.cancelRequested; attempt++) {
      const child = startMaestroTurn({
        runtime: item.runtime, prompt, cwd: projectRoot, sessionId, directive, model, skipPermissions, maxBudgetUsd, env,
        onEvent: event => this.push(item, event),
      });
      item.child = child;
      if (child.sessionId) item.session_id = child.sessionId;
      const watcher = this.watchAudit(item, env);
      const timer = setTimeout(() => { item.timedOut = true; child.kill(); }, this.options.timeoutMs ?? MAESTRO_TURN_TIMEOUT_MS);
      outcome = await child.done;
      clearTimeout(timer);
      watcher.stop();
      item.child = null;
      // Runtimes prune their sessions (claude cleanupPeriodDays, gemini maxAge): a resume the
      // runtime no longer has ends with no result. The turn then starts a NEW session for the same
      // conversation, with a short recap of the visible transcript, instead of failing for good.
      const staleSession = !outcome.ok && sessionId && !outcome.result.trim() && !item.cancelRequested && !item.timedOut && !outcome.signal;
      if (!staleSession) break;
      prompt = `${continuityRecap(this.conversations.messages(item.conversation_id), item.message_id)}\n\n${item.prompt}`;
      item.session_recreated_from = sessionId;
      sessionId = null;
    }
    this.finish(item, outcome);
  }

  private finish(item: TurnItem, outcome: TurnOutcome): void {
    // SIGTERM (exit 143) leaves a `-p` turn unfinished but resumable: cancelled, never failed.
    const interrupted = item.cancelRequested || outcome.exitCode === 143 || outcome.signal === "SIGTERM";
    const state: TurnState = interrupted ? "cancelled" : item.timedOut ? "failed" : outcome.ok ? "completed" : "failed";
    const reason = item.cancelRequested ? "cancelled_by_user" : interrupted ? "interrupted" : item.timedOut ? "timeout" : outcome.ok ? null : "runtime_failed";
    const result = outcome.result.trim();
    if (result && state !== "cancelled") {
      const messageId = `msg_${createHash("sha256").update(`${item.turn_id}:assistant`).digest("hex").slice(0, 24)}`;
      try { item.result_message_id = this.conversations.append({ conversationId: item.conversation_id, projectId: item.project_id, role: "assistant", content: result, messageId }).message_id; }
      catch (error) { console.error(`[glance] assistant message not written (${(error as Error).message})`); }
    }
    if (outcome.sessionId && state !== "cancelled") {
      item.session_id = outcome.sessionId;
      const recreated = item.session_recreated_from;
      try { this.conversations.setSession(item.conversation_id, { sessionId: outcome.sessionId, runtime: item.runtime, reason: recreated ? "session_vanished" : "runtime_changed" }); }
      catch (error) { console.error(`[glance] session not written (${(error as Error).message})`); }
      if (recreated) {
        this.audit("x_session_recreated", {
          actor: "glance", conversation_id: item.conversation_id, turn_id: item.turn_id, runtime: item.runtime,
          previous_session_id: recreated, new_session_id: outcome.sessionId, reason: "resume_failed",
        }, { cwd: this.options.projectRoot, project_id: item.project_id, trace_id: outcome.sessionId, session_id: outcome.sessionId });
      }
    }
    item.cost_usd = outcome.costUsd;
    item.ended_at = new Date().toISOString();
    item.state = state;
    item.reason = reason;
    item.detail = outcome.error ?? null;
    // The trace is the runtime session, as the runtime's own hook events use it (tool_invoked,
    // bash_completed): one trace per session in the audit, the turn named in the payload.
    if (typeof outcome.costUsd === "number") {
      this.audit("cost_emission", {
        total_cost_usd: outcome.costUsd, source: "glance-maestro-turn", actor: "glance", runtime: item.runtime, session_id: item.session_id,
        conversation_id: item.conversation_id, turn_id: item.turn_id, message_id: item.message_id, duration_ms: outcome.durationMs, state,
      }, { cwd: this.options.projectRoot, project_id: item.project_id, trace_id: item.session_id ?? item.turn_id, session_id: item.session_id ?? undefined });
    }
    this.push(item, { t: "done", ok: state === "completed", state, result, session_id: item.session_id, resume_command: item.session_id ? resumeCommand(item.runtime, item.session_id) : null,
      cost_usd: item.cost_usd, runtime: item.runtime, error: outcome.error ?? null, reason });
    item.listeners.clear();
    if (this.active.get(item.conversation_id) === item) this.active.delete(item.conversation_id);
    this.drain(item.conversation_id);
  }

  /** Follows the project's audit while the turn runs: a Run the maestro opened (`x_ledger_run_opened`,
   * written by brief-*, `nrv dispatch --exec` and `nrv run-track open`) becomes a `run` event, so the
   * bubble can link to it as soon as it exists. */
  private watchAudit(item: TurnItem, env: Record<string, string>): { stop(): void } {
    const file = path.join(env.HARNESS_LOGS_DIR, new Date().toISOString().slice(0, 10), "audit.jsonl");
    const size = () => { try { return fs.statSync(file).size; } catch { return 0; } };
    let offset = size();
    let carry = "";
    const scan = () => {
      const current = size();
      if (current < offset) offset = 0;
      if (current === offset) return;
      const buffer = Buffer.alloc(current - offset);
      let descriptor: number | null = null;
      try { descriptor = fs.openSync(file, "r"); fs.readSync(descriptor, buffer, 0, buffer.length, offset); }
      catch { return; }
      finally { if (descriptor !== null) fs.closeSync(descriptor); }
      offset = current;
      const lines = (carry + buffer.toString("utf8")).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        let event: any;
        try { event = parseAuditLine(line); } catch { continue; }
        if (event?.event !== "x_ledger_run_opened" || typeof event.run_id !== "string" || item.runs.some(run => run.run_id === event.run_id)) continue;
        const run: TurnRunLink = { run_id: event.run_id, trace_id: event.trace_id ?? null, target_slug: event.target_slug ?? null, target_kind: event.target_kind ?? null, runtime: event.runtime ?? null };
        item.runs.push(run);
        this.push(item, { t: "run", ...run });
      }
    };
    const timer = setInterval(scan, AUDIT_POLL_MS);
    return { stop() { clearInterval(timer); scan(); } };
  }
}

// ── child mode: the driver, synchronously, for the runtimes that do not stream ─────────────
if (import.meta.main && process.argv.includes("--child")) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
  const payload = JSON.parse(await Bun.stdin.text()) as { prompt: string; directive: string };
  const budget = Number(flag("--max-budget-usd") ?? "0");
  const model = flag("--model");
  const result = runHeadless({
    runtime: flag("--runtime") as Runtime, prompt: payload.prompt, cwd: flag("--cwd") ?? process.cwd(), appendSystemPrompt: payload.directive,
    yolo: true, timeoutMs: MAESTRO_TURN_TIMEOUT_MS,
    ...(flag("--resume") ? { sessionId: flag("--resume") } : {}), ...(model ? { model } : {}), ...(budget > 0 ? { maxBudgetUsd: budget } : {}),
  });
  process.stdout.write(JSON.stringify({ t: "done", ok: result.ok, result: result.result || "", session_id: result.sessionId, cost_usd: result.costUsd, runtime: result.runtime, error: result.error ?? null }) + "\n");
  process.exit(result.ok ? 0 : 1);
}
