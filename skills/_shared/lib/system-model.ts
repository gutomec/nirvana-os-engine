// system-model.ts — resolve o MODEL DO SISTEMA (o que a sessão do usuário está
// rodando) para propagar aos subprocessos que o Nirvana-OS dispara.
//
// Problema que resolve: o `/model` do Claude Code é local da sessão interativa
// e NÃO é herdado por um `claude -p` filho — não há env var expondo o model, e
// os drivers do harness disparam `claude -p` sem `--model`. Resultado: o filho
// cai no default do CLI (comumente sonnet), mesmo quando o usuário está em
// fable/opus. Aqui resolvemos o model pretendido e o driver o passa via
// `--model`, então "sem model pedido no brief → usa o model do sistema".
//
// Não força model quando nada resolve (mantém o comportamento model-agnóstico).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Sanitiza um id de model: remove escapes ANSI reais E fragmentos de ANSI que
// vazam para o valor salvo (o `/model` do Claude Code pode gravar o rótulo em
// negrito e deixar "[1m]" grudado no id, ex.: "claude-fable-5[1m]" — id inválido
// que faz o CLI cair no default). Retorna o id limpo ou "" se nada sobrar.
export function sanitizeModelId(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw);
  s = s.replace(/\x1b\[[0-9;]*m/g, "");     // ANSI real (ESC [ ... m)
  s = s.replace(/\[[0-9;]*m\]?/g, "");      // fragmento vazado "[1m]" / "[22m"
  s = s.replace(/[^\x20-\x7e]/g, "").trim(); // descarta não-imprimíveis
  const m = s.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/); // primeiro token válido de id
  return m ? m[0] : "";
}

// Resolve o model do sistema. Prioridade:
//   1. NIRVANA_MODEL   — pin explícito para os spawns do Nirvana
//   2. ANTHROPIC_MODEL — env padrão que alguns setups usam
//   3. ~/.claude/settings.json "model" — o model que o usuário setou via /model
// settings.json é do Claude Code; só vale para filhos claude-code. Retorna null
// quando nada resolve (aí o CLI decide — comportamento inalterado).
export function resolveSystemModel(runtime?: string): string | null {
  const fromEnv = sanitizeModelId(process.env.NIRVANA_MODEL) || sanitizeModelId(process.env.ANTHROPIC_MODEL);
  if (fromEnv) return fromEnv;
  if (runtime && runtime !== "claude-code") return null;
  try {
    const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const j = JSON.parse(fs.readFileSync(path.join(cfg, "settings.json"), "utf8"));
    const m = sanitizeModelId(j.model);
    if (m) return m;
  } catch { /* sem settings / ilegível — sem model do sistema */ }
  return null;
}
