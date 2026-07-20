#!/usr/bin/env bun
// brief-proxy.ts — the "informed client" briefing proxy.
//
// Phase 2 of the autopilot. Where `--auto-brief` (deterministic) appends
// templated assumptions, the proxy runs a real LLM pass that plays an informed
// client / intake analyst: it surfaces the clarifying questions a human would
// be asked, ANSWERS them on the absent human's behalf using conservative
// industry defaults, and returns an enriched brief. This is the "agent that
// decides the briefing for the human" the autopilot needs to stay one-command.
//
// It runs headless with NO tools (pure text in, enriched brief out), so it is
// cheap and cannot touch the filesystem. The main employee dispatch then runs
// against the enriched brief.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runHeadless, runtimeAvailable, type Runtime } from "./host-agent-driver.ts";

const BUSINESSES_ROOT = path.join(os.homedir(), "businesses");

function businessContext(slug: string): string {
  const yml = path.join(BUSINESSES_ROOT, slug, "business.yaml");
  if (!fs.existsSync(yml)) return `(business '${slug}' — sem manifesto local)`;
  const text = fs.readFileSync(yml, "utf8");
  // Keep it short: name, description, domains lines only.
  const keep = text.split("\n").filter(l => /^(name|description|domains|industry|sector|owner):/.test(l.trim()) || /^\s+-\s/.test(l)).slice(0, 20);
  return keep.join("\n") || `(business '${slug}')`;
}

export interface ProxyResult {
  ok: boolean;
  enriched: string;
  raw: string;
  error?: string;
}

export function proxyEnrichBrief(brief: string, slug: string, runtime: Runtime = "claude-code", opts: { maxBudgetUsd?: number; timeoutMs?: number } = {}): ProxyResult {
  if (!runtimeAvailable(runtime)) {
    return { ok: false, enriched: brief, raw: "", error: `runtime '${runtime}' indisponível` };
  }
  const ctx = businessContext(slug);
  const prompt = [
    `Você é um analista de intake experiente do negócio "${slug}". Contexto do negócio:`,
    "",
    ctx,
    "",
    "Recebeu o briefing abaixo de um cliente que NÃO está disponível para responder perguntas:",
    "",
    "<<<BRIEFING>>>",
    brief,
    "<<<FIM>>>",
    "",
    "Sua tarefa (decidir pelo cliente ausente):",
    "1. Liste mentalmente as perguntas de esclarecimento que um intake profissional faria para este briefing neste negócio.",
    "2. Responda CADA uma você mesmo, com premissas conservadoras e padrão de mercado (você decide no lugar do humano ausente).",
    "3. Produza UM briefing enriquecido em PT-BR que incorpore o pedido original mais suas respostas, terminando com uma seção '## Premissas decididas pelo proxy' listando o que você assumiu.",
    "",
    "Regra de hífen: use '-' só para palavras compostas; nunca para emendar orações nem como travessão.",
    "Saída: APENAS o texto do briefing enriquecido, sem comentários meta nem cercas de código.",
  ].join("\n");

  const res = runHeadless({
    runtime,
    prompt,
    cwd: os.tmpdir(),
    allowedTools: [], // pure text — no filesystem
    permissionMode: "default",
    maxBudgetUsd: opts.maxBudgetUsd,
    timeoutMs: opts.timeoutMs ?? 8 * 60 * 1000,
  });

  const enriched = (res.result || "").trim();
  if (!res.ok || enriched.length < brief.trim().length / 2) {
    return { ok: false, enriched: brief, raw: res.result || "", error: res.error || "proxy returned too little" };
  }
  return { ok: true, enriched, raw: res.result };
}

// CLI wrapper for standalone testing.
if (import.meta.main) {
  const [, , slug, ...rest] = process.argv;
  const brief = rest.filter(a => !a.startsWith("--")).join(" ");
  if (!slug || !brief) {
    console.error('Uso: bun brief-proxy.ts <business_slug> "<brief>" [--runtime=claude-code]');
    process.exit(2);
  }
  const rtArg = process.argv.find(a => a.startsWith("--runtime="))?.split("=")[1] as Runtime | undefined;
  const out = proxyEnrichBrief(brief, slug, rtArg || "claude-code");
  if (!out.ok) { console.error("proxy falhou:", out.error); process.exit(1); }
  console.log(out.enriched);
}
