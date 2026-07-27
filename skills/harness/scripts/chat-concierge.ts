#!/usr/bin/env bun
// chat-concierge.ts — turno conversacional do chat do Glance.
//
//   bun chat-concierge.ts "<mensagem>" [--resume <sessionId>] [--runtime <rt>]
//
// Spawna o host agent (claude por padrão) com uma persona de CONCIERGE do
// Nirvana-OS: responde perguntas sobre o sistema, e quando o usuário pede um
// TRABALHO concreto, roteia (`nrv route`) e executa (`nrv run`/`nrv auto`),
// sempre dizendo qual empresa/runtime usaria e por quê. Diferente do
// `dispatch --auto`, uma saudação como "oi" recebe uma RESPOSTA, não um
// pipeline de produção.
//
// Saída: uma linha JSON {result, session_id, cost_usd, runtime} para o Glance
// renderizar como a bolha do assistant e guardar o session_id p/ --resume.
import { readFileSync } from "node:fs";
import { runHeadless, type Runtime } from "../lib/host-agent-driver.ts";
import { resolveSystemModel } from "../../_shared/lib/system-model.ts";
import { resolveScope, enumerate } from "../../_shared/lib/scope.ts";
import { paths as nrvPaths } from "../../_shared/lib/bun-helpers.ts";

const args = process.argv.slice(2);
const message = args.find((a) => !a.startsWith("--")) || "";
const resumeIdx = args.indexOf("--resume");
const sessionId = resumeIdx >= 0 ? args[resumeIdx + 1] : null;
const rtIdx = args.indexOf("--runtime");
const runtimeArg = rtIdx >= 0 ? args[rtIdx + 1] : "";
// Modo de roteamento do chat: agêntico (padrão, mais acertivo) vs fast (opt-in,
// mais rápido/econômico). Controla a PROFUNDIDADE do raciocínio do concierge
// sobre o catálogo — não faz shell-out pro nrv route (lento e frágil).
const fastMode = args.includes("--fast");

if (!message.trim()) {
  console.log(JSON.stringify({ result: "(mensagem vazia)", session_id: sessionId, cost_usd: 0 }));
  process.exit(0);
}

const norm = (s: string): Runtime => {
  const v = (s || "").toLowerCase();
  if (v === "claude" || v === "claude-code") return "claude-code";
  if (v === "codex") return "codex";
  if (v === "gemini" || v === "gemini-cli") return "gemini-cli";
  if (v === "agy" || v === "antigravity" || v === "antigravity-cli") return "antigravity-cli";
  return "claude-code";
};
const runtime = runtimeArg ? norm(runtimeArg) : "claude-code";

// Catálogo instalado, com DESCRIÇÃO de cada empresa/squad (domains + keywords),
// lido do registry rico (o mesmo que o router agentic usa). Assim o concierge
// sugere pelo que cada um FAZ, não pelo nome. Se o registry não existe, cai no
// enumerate() (só nomes) e o concierge é instruído a rodar `nrv route`.
function loadRegistry(path: string, key: "businesses" | "squads"): Record<string, any> {
  try { return JSON.parse(readFileSync(path, "utf8"))[key] || {}; } catch { return {}; }
}
function line(slug: string, e: any): string {
  const domains = Array.isArray(e?.domains) ? e.domains.slice(0, 4).join(", ") : "";
  const kw = Array.isArray(e?.keywords) ? e.keywords.slice(0, 6).join(", ")
           : Array.isArray(e?.produces) ? e.produces.slice(0, 4).join(", ") : "";
  const tail = [domains && `domínios: ${domains}`, kw && `foco: ${kw}`].filter(Boolean).join(" · ");
  return tail ? `${slug} — ${tail}` : slug;
}

let catalogBlock = "";
let hasRichRegistry = false;
try {
  const bizReg = loadRegistry(nrvPaths.BUSINESSES_REGISTRY_PATH, "businesses");
  const squadReg = loadRegistry(nrvPaths.SQUADS_REGISTRY_PATH, "squads");
  const bizSlugs = Object.keys(bizReg).sort();
  const squadSlugs = Object.keys(squadReg).sort();
  hasRichRegistry = bizSlugs.length > 0 || squadSlugs.length > 0;

  if (hasRichRegistry) {
    catalogBlock = [
      "",
      "CATÁLOGO INSTALADO (fonte de verdade — cada linha traz o que a empresa/squad FAZ; use isto para sugerir e responder, SEM rodar comando):",
      `EMPRESAS (${bizSlugs.length}):`,
      ...bizSlugs.map((s) => `- ${line(s, bizReg[s])}`),
      "",
      `SQUADS (${squadSlugs.length}):`,
      ...squadSlugs.map((s) => `- ${line(s, squadReg[s])}`),
    ].join("\n");
  } else {
    // Fallback: registry ausente → só os nomes (enumeração de diretório).
    const scope = resolveScope({ cwd: process.cwd() });
    const biz = enumerate(scope, "businesses").map((b) => b.slug).sort();
    const squads = enumerate(scope, "squads").map((s) => s.slug).sort();
    catalogBlock = [
      "",
      "CATÁLOGO INSTALADO (só nomes — registry não construído; rode `nrv index` p/ descrições):",
      `EMPRESAS (${biz.length}): ${biz.join(", ")}`,
      `SQUADS (${squads.length}): ${squads.join(", ")}`,
    ].join("\n");
  }
} catch { /* sem catálogo: o concierge cai no nrv route */ }

// Instrução de roteamento — raciocínio INLINE sobre o catálogo (sem shell-out:
// o nrv route agentic leva ~25-40s aninhado e quebra o JSON de saída). A
// profundidade muda com o modo.
const agenticRule = hasRichRegistry
  ? "2. MODO AGÊNTICO (acertividade máxima). Para SUGERIR/ROTEAR (\"qual empresa/squad pra X\"): identifique primeiro o OBJETO que o usuário quer entregar (landing, análise, vídeo, campanha…), depois varra o CATÁLOGO abaixo casando esse OBJETO com os domínios/foco de cada empresa/squad. Escolha o melhor primary + 1-2 alternativas reais e JUSTIFIQUE por quê (cite o domínio/foco que casou). NUNCA case só pelo nome. Uma empresa de TEMA sem capacidade de entregar o OBJETO não é o primary. Listar/contar: direto do catálogo."
  : "2. Para SUGERIR/ROTEAR, use o catálogo abaixo (só nomes — peça ao usuário pra rodar `nrv index` p/ descrições melhores). Escolha pelo objeto pedido e justifique. Listar/contar: direto do catálogo.";
const fastRule = hasRichRegistry
  ? "2. MODO RÁPIDO (econômico). Para SUGERIR/ROTEAR: dê a MELHOR escolha direto do CATÁLOGO abaixo, 1 linha de justificativa, sem deliberar longamente. Seja decisivo e curto. Listar/contar: direto do catálogo."
  : "2. MODO RÁPIDO. Sugira do catálogo (só nomes) a opção mais provável, curto. Listar/contar: direto do catálogo.";
const routingRule = fastMode ? fastRule : agenticRule;

const CONCIERGE = [
  "Você é o CONCIERGE do Nirvana-OS deste usuário — uma interface de conversa DENTRO do cockpit Glance.",
  "",
  "O que você faz:",
  "1. RESPONDE perguntas sobre o sistema em português, de forma calorosa e direta: o que são as empresas, squads e mind-clones instalados, como o Nirvana funciona, o que ele pode entregar. Para saudações ('oi', 'olá') ou perguntas, apenas CONVERSE — não despache nada.",
  routingRule,
  "3. EXECUTA trabalho SÓ quando o usuário pede algo concreto E confirma. Antes de rodar, mostre o plano: qual empresa/squad e qual runtime você usaria e por quê. Execução: `nrv run <business> \"<brief>\" --html` ou `nrv auto \"<brief>\"` (auto-route). Nunca despache uma saudação ou pergunta.",
  "",
  "Sobre RUNTIME (a pergunta que o usuário sempre tem): se ele não escolheu um runtime, o padrão é o que a sessão dele está rodando. As regras `USE_*`/`NOT_USE_*` do `.env` dele podem redirecionar por tipo de tarefa (ex.: imagens → codex). Se ele perguntar 'com qual sistema você vai trabalhar?', explique isso e diga sua escolha.",
  "",
  "Estilo: markdown, conciso, sem encher linguiça. Você está numa janela de chat estreita. Uma saudação merece 1-2 frases, não um manual.",
  catalogBlock,
].join("\n");

// Protocolo de saída (NDJSON, uma linha por evento — o action-runner transmite
// linha-a-linha via SSE, e o chat renderiza ao vivo):
//   {"t":"tok","v":"<delta de texto>"}         token do assistant (streaming)
//   {"t":"tool","name":"Bash","cmd":"nrv …"}   o agente chamou uma ferramenta
//   {"t":"done","result","session_id","cost_usd","ok"}   fim + resposta canônica
const emit = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify(o) + "\n");
const model = resolveSystemModel(runtime) ?? undefined;

function toolLabel(c: any): string {
  const inp = c?.input || {};
  if (c?.name === "Bash" && typeof inp.command === "string") return inp.command.slice(0, 120);
  if (typeof inp.description === "string") return inp.description.slice(0, 120);
  const first = Object.values(inp).find((v) => typeof v === "string") as string | undefined;
  return (first || "").slice(0, 120);
}

// Streaming real (só claude-code): claude -p --output-format stream-json
// --include-partial-messages emite content_block_delta (tokens), assistant
// (tool_use) e result (final + session_id + custo). Spawn assíncrono (Bun.spawn)
// e repassa cada evento normalizado. Outros runtimes caem no bloco síncrono.
async function streamClaude(): Promise<void> {
  const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose"];
  if (sessionId) args.push("--resume", sessionId);
  args.push("--append-system-prompt", CONCIERGE);
  if (model) args.push("--model", model);
  args.push("--dangerously-skip-permissions"); // concierge precisa de Bash p/ nrv route/list

  const proc = Bun.spawn(["claude", ...args], { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => { try { proc.kill(); } catch {} }, 5 * 60 * 1000);
  proc.stdin.write(message); proc.stdin.end();

  let result = "", sessionOut: string | null = sessionId, cost = 0, sawText = false;
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const handle = (line: string) => {
    if (!line.trim()) return;
    let d: any; try { d = JSON.parse(line); } catch { return; }
    if (d.type === "stream_event") {
      const ev = d.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) { sawText = true; emit({ t: "tok", v: ev.delta.text }); }
    } else if (d.type === "assistant") {
      for (const c of (d.message?.content || [])) {
        if (c?.type === "tool_use") emit({ t: "tool", name: c.name, cmd: toolLabel(c) });
      }
    } else if (d.type === "result") {
      if (typeof d.result === "string") result = d.result;
      if (d.session_id) sessionOut = d.session_id;
      if (typeof d.total_cost_usd === "number") cost = d.total_cost_usd;
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  }
  handle(buf);
  await proc.exited;
  clearTimeout(killer);
  emit({ t: "done", result: result || (sawText ? "" : "(sem resposta)"), session_id: sessionOut, cost_usd: cost, runtime, ok: true });
}

if (runtime === "claude-code") {
  await streamClaude();
} else {
  // Fallback síncrono (codex/gemini/antigravity): sem stream-json normalizado
  // aqui — devolve o bloco final no mesmo formato {t:"done"}.
  const res = runHeadless({
    runtime, prompt: message, cwd: process.cwd(), appendSystemPrompt: CONCIERGE,
    model, yolo: true, timeoutMs: 5 * 60 * 1000, ...(sessionId ? { sessionId } : {}),
  });
  emit({ t: "done", result: res.result || res.error || "(sem resposta)", session_id: res.sessionId, cost_usd: res.costUsd, runtime, ok: res.ok });
}
process.exit(0);
