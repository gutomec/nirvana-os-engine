// runtime-rules.ts — regras de roteamento por runtime escritas pelo USUÁRIO em
// linguagem natural, no .env:
//
//   USE_CODEX="Quando precisar gerar imagens ou refinar visuais"
//   USE_ANTIGRAVITY="Quando for fazer deep research na internet"
//   USE_GEMINI="Quando o contexto for gigante (1M tokens)"
//   USE_HERMES="Quando precisar interagir com o usuário via mensageria"
//
// A regra escolhe apenas o runtime PREFERIDO (cabeça da fila) para o exec do
// dispatch; resiliência (cota/budget/cooldown) continua sendo do LLM_CASCADE
// (cascade-runner.ts) — rota é semântica, fallback é mecânico, nunca misturar.
//
// Dois modos de decisão, espelhando o routing-mode do harness:
//   - agentic: as regras vão VERBATIM no prompt do agentic-router (campo
//     "runtime" no JSON de saída) e como bloco anexado ao AUTONOMOUS_DIRECTIVE
//     (o maestro respeita as regras ao delegar sub-tarefas).
//   - fast: BM25 do brief contra o texto das regras (zero-token, determinístico).
//
// Precedência: flag explícita (--exec=<rt> | --runtime) > regra > default.
// Default = o runtime que o USUÁRIO JÁ ESTÁ USANDO (host da sessão, detectado
// por marcadores de env), não um valor fixo — se nada existir/configurar, o
// sistema segue no que está rodando.
//
// Hermes é alvo válido só no caminho agentic (delegação via `hermes -z`): não
// há classificador de cota nem session id para ele no runHeadless. Em fast,
// se vencer, degrada para o próximo do ranking com warn.
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { Runtime } from "./host-agent-driver.ts";
import { readEnvFile, resolveCascadeRoot } from "./cascade.ts";

const require = createRequire(import.meta.url);
const { buildIndex, query } = require("./bm25.js");

export type RoutableRuntime = Runtime | "hermes";

export interface RuntimeRule {
  runtime: RoutableRuntime;
  rule: string;              // o texto da regra, verbatim
  envKey: string;            // ex.: "USE_CODEX" | "NOT_USE_GEMINI"
  sourceFile: string | null; // .env de origem (null = process.env)
  /** true = regra NEGATIVA (NOT_USE_*): VETA o runtime para briefs que casem.
   *  Veto vence regra positiva; flag explícita vence tudo. */
  negate: boolean;
}

export interface RuntimeDecision {
  runtime: Runtime;
  source: "flag" | "rule" | "default";
  rule?: RuntimeRule;
  method?: "bm25" | "agentic";
  score?: number;
  /** Vetos (NOT_USE_*) que casaram com o brief e mudaram/limitaram a escolha. */
  vetoes?: Array<{ envKey: string; runtime: RoutableRuntime; score: number }>;
}

// USE_<sufixo> → runtime canônico. Sufixo desconhecido → warn, nunca quebra.
const RUNTIME_ALIASES: Record<string, RoutableRuntime> = {
  CLAUDE: "claude-code", CLAUDE_CODE: "claude-code", CLAUDECODE: "claude-code",
  CODEX: "codex", CODEX_CLI: "codex",
  GEMINI: "gemini-cli", GEMINI_CLI: "gemini-cli",
  ANTIGRAVITY: "antigravity-cli", ANTIGRAVITY_CLI: "antigravity-cli", AGY: "antigravity-cli",
  HERMES: "hermes",
};

const EXEC_RUNTIMES: ReadonlyArray<Runtime> = ["claude-code", "codex", "gemini-cli", "antigravity-cli"];

// Stopwords PT-BR + EN removidas antes do BM25: com regras curtas, palavras
// funcionais ("um", "o", "quando", "when") geram matches falsos — "escreva um
// poema" não pode casar com "um milhão de tokens" só pelo "um".
const STOPWORDS = new Set([
  "a", "o", "as", "os", "um", "uma", "uns", "umas", "de", "do", "da", "dos", "das",
  "em", "no", "na", "nos", "nas", "por", "para", "pra", "com", "sem", "sobre",
  "que", "quando", "se", "e", "ou", "ao", "aos", "for", "ser", "estar", "fazer",
  "precisar", "preciso", "precisa", "quiser", "vai", "via",
  "the", "an", "of", "to", "in", "on", "at", "and", "or", "when", "is", "are",
  "be", "need", "needs", "use", "using", "with", "you", "your",
]);
const stripStop = (text: string): string =>
  text.split(/\s+/).filter(w => !STOPWORDS.has(w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""))).join(" ");

/** Runtime que está HOSPEDANDO esta sessão (o que o usuário está usando),
 *  detectado pelos marcadores de env que cada CLI seta nos seus subprocessos.
 *  NIRVANA_HOST_RUNTIME é o override explícito. null = não identificado
 *  (terminal puro, cron, ou host sem exec-target como o Hermes). */
export function detectCurrentHost(env: NodeJS.ProcessEnv = process.env): Runtime | null {
  const explicit = (env.NIRVANA_HOST_RUNTIME || "").toUpperCase().replace(/-/g, "_");
  if (explicit && RUNTIME_ALIASES[explicit] && RUNTIME_ALIASES[explicit] !== "hermes") {
    return RUNTIME_ALIASES[explicit] as Runtime;
  }
  if (env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (env.CODEX_SANDBOX || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return "codex";
  if (env.GEMINI_SESSION_ID || env.GEMINI_CLI) return "gemini-cli";
  if (env.ANTIGRAVITY_SESSION_ID || env.AGY_SESSION_ID || env.ANTIGRAVITY_CLI) return "antigravity-cli";
  return null;
}

/** Coleta as USE_* na MESMA cadeia de .env do LLM_CASCADE (arquivo literal
 *  vence process.env — mesma razão do cascade: o Bun expande $ no auto-load).
 *  Primeiro arquivo que define uma chave vence (projeto sobrepõe global). */
export function loadRuntimeRules(projectRoot: string | null, env: NodeJS.ProcessEnv = process.env): RuntimeRule[] {
  const files: string[] = [];
  if (projectRoot) {
    files.push(path.join(projectRoot, ".env"));
    const resolved = path.join(resolveCascadeRoot(projectRoot), ".env");
    if (!files.includes(resolved)) files.push(resolved);
  }
  files.push(path.join(os.homedir(), ".claude", ".env"));

  const claimed = new Set<string>();
  const rules: RuntimeRule[] = [];
  const collect = (vars: Record<string, string | undefined>, sourceFile: string | null) => {
    for (const [key, value] of Object.entries(vars)) {
      // USE_<rt> = regra positiva (atrai); NOT_USE_<rt> = veto (bloqueia).
      const m = key.match(/^(NOT_USE|USE)_([A-Z0-9_]+)$/);
      if (!m || !value || !String(value).trim()) continue;
      if (claimed.has(key)) continue;
      const negate = m[1] === "NOT_USE";
      const runtime = RUNTIME_ALIASES[m[2]];
      if (!runtime) {
        console.error(`[runtime-rules] runtime desconhecido em ${key}${sourceFile ? ` (${sourceFile})` : ""} — regra ignorada. Conhecidos: ${Object.keys(RUNTIME_ALIASES).join(", ")}`);
        claimed.add(key);
        continue;
      }
      claimed.add(key);
      rules.push({ runtime, rule: String(value).trim(), envKey: key, sourceFile, negate });
    }
  };

  for (const f of files) collect(readEnvFile(f), f);
  collect(env as Record<string, string | undefined>, null);
  return rules;
}

/** Vetos que casam com o brief: BM25 do brief contra as regras NOT_USE_*.
 *  Qualquer veto com score ≥ minScore se aplica (sem lógica de empate — veto
 *  não escolhe, só bloqueia). */
export function matchedVetoes(
  brief: string,
  rules: RuntimeRule[],
  opts: { minScore?: number } = {},
): Array<{ rule: RuntimeRule; score: number }> {
  const negatives = rules.filter(r => r.negate);
  if (!negatives.length || !brief?.trim()) return [];
  const minScore = opts.minScore ?? Number(process.env.NIRVANA_RULE_MIN_SCORE || "0.15");
  const index = buildIndex(negatives.map((r, i) => ({ id: i, text: stripStop(r.rule) })));
  const hits = query(index, stripStop(brief), { topK: negatives.length, minScore: 0 });
  return hits
    .map((h: { doc: { id: number }; score: number }) => ({ rule: negatives[h.doc.id], score: h.score }))
    .filter((h: { score: number }) => h.score >= minScore);
}

/** Match determinístico (modo fast): BM25 do brief contra o texto das regras
 *  POSITIVAS. null quando: sem regras, score bruto do topo < minScore, ou
 *  empate (2º colocado a menos de 5% do 1º = ambíguo, não decide). */
export function resolveRuntimeByRules(
  brief: string,
  rules: RuntimeRule[],
  opts: { minScore?: number; allowHermes?: boolean } = {},
): { rule: RuntimeRule; score: number; ranked: Array<{ rule: RuntimeRule; score: number }> } | null {
  // Só positivas escolhem; NOT_USE_* atua como veto em decideRuntime.
  // hermes fica no ranking mesmo em fast (para o warn + degrade no topo);
  // a exclusão de hermes como VENCEDOR acontece adiante.
  const usable = rules.filter(r => !r.negate);
  if (!usable.length || !brief?.trim()) return null;
  const minScore = opts.minScore ?? Number(process.env.NIRVANA_RULE_MIN_SCORE || "0.15");

  const index = buildIndex(usable.map((r, i) => ({ id: i, text: stripStop(r.rule) })));
  const hits = query(index, stripStop(brief), { topK: usable.length, minScore: 0 });
  const ranked = hits
    .map((h: { doc: { id: number }; score: number }) => ({ rule: usable[h.doc.id], score: h.score }))
    .filter((h: { score: number }) => h.score > 0);
  if (!ranked.length) return null;

  let top = ranked[0];
  // hermes não é exec-target: em fast degrada para o próximo do ranking.
  if (!opts.allowHermes && top.rule.runtime === "hermes") {
    console.error(`[runtime-rules] ${top.rule.envKey} venceu, mas hermes só atua no modo agentic (delegação) — usando o próximo do ranking.`);
    const next = ranked.find((r: { rule: RuntimeRule }) => r.rule.runtime !== "hermes");
    if (!next) return null;
    top = next;
  }
  if (top.score < minScore) return null;
  const second = ranked.find((r: { rule: RuntimeRule }) => r.rule !== top.rule);
  if (second && top.score > 0 && (top.score - second.score) / top.score < 0.05) return null; // empate = ambíguo

  return { rule: top.rule, score: top.score, ranked };
}

/** Precedência flag > regra > default; degrada runtime indisponível para o
 *  próximo do ranking e, por fim, para o default (= host atual do usuário). */
export function decideRuntime(opts: {
  brief: string;
  explicitRuntime: Runtime | null;
  defaultRuntime: Runtime;
  rules: RuntimeRule[];
  mode: "agentic" | "fast";
  available?: (r: Runtime) => boolean;
}): RuntimeDecision {
  // Flag explícita vence TUDO, inclusive vetos: é ação direta do usuário
  // agora, mais forte que qualquer config.
  if (opts.explicitRuntime) return { runtime: opts.explicitRuntime, source: "flag" };

  const avail = opts.available ?? (() => true);
  // Vetos (NOT_USE_*) que casam com este brief: bloqueiam o runtime tanto na
  // escolha por regra positiva quanto no default. Veto vence regra positiva.
  const vetoHits = matchedVetoes(opts.brief, opts.rules);
  const vetoed = new Set(vetoHits.map(v => v.rule.runtime));
  const vetoInfo = vetoHits.length
    ? vetoHits.map(v => ({ envKey: v.rule.envKey, runtime: v.rule.runtime, score: v.score }))
    : undefined;
  const blocked = (r: RoutableRuntime): boolean => {
    if (!vetoed.has(r)) return false;
    const v = vetoHits.find(x => x.rule.runtime === r)!;
    console.error(`[runtime-rules] ${v.rule.envKey} veta ${r} para este brief ("${v.rule.rule}") — pulando.`);
    return true;
  };

  const hit = resolveRuntimeByRules(opts.brief, opts.rules, { allowHermes: false });
  if (hit) {
    const candidates = [hit, ...hit.ranked.filter(r => r.rule !== hit.rule)];
    for (const c of candidates) {
      if (c.rule.runtime === "hermes") continue;
      if (blocked(c.rule.runtime)) continue;
      if (avail(c.rule.runtime as Runtime)) {
        return { runtime: c.rule.runtime as Runtime, source: "rule", rule: c.rule, method: "bm25", score: c.score, vetoes: vetoInfo };
      }
      console.error(`[runtime-rules] ${c.rule.envKey} → ${c.rule.runtime} indisponível nesta máquina — tentando o próximo.`);
    }
  }

  // Default: se o próprio default está vetado para este brief, procura o
  // primeiro exec-runtime disponível e não-vetado. Se TUDO estiver vetado,
  // ignora os vetos com aviso — nunca deixa o usuário sem execução.
  if (vetoed.has(opts.defaultRuntime)) {
    const alt = EXEC_RUNTIMES.find(r => r !== opts.defaultRuntime && !vetoed.has(r) && avail(r));
    if (alt) {
      console.error(`[runtime-rules] default ${opts.defaultRuntime} vetado para este brief — usando ${alt}.`);
      return { runtime: alt, source: "default", vetoes: vetoInfo };
    }
    console.error(`[runtime-rules] todos os runtimes disponíveis estão vetados para este brief — ignorando vetos e seguindo no default (${opts.defaultRuntime}).`);
  }
  return { runtime: opts.defaultRuntime, source: "default", vetoes: vetoInfo };
}

/** Bloco verbatim para o prompt do agentic-router (caminho --auto). */
export function formatRulesForRouterPrompt(rules: RuntimeRule[]): string {
  if (!rules.length) return "";
  const positives = rules.filter(r => !r.negate).map(r => `- ${r.envKey} (${r.runtime}): "${r.rule}"`);
  const negatives = rules.filter(r => r.negate).map(r => `- ${r.envKey}: NUNCA use ${r.runtime} quando "${r.rule}"`);
  return [
    "## REGRAS DE RUNTIME DO USUÁRIO",
    ...(positives.length ? ["O usuário definiu em qual CLI agêntico cada tipo de tarefa deve rodar:", ...positives] : []),
    ...(negatives.length ? ["VETOS (têm prioridade sobre as regras positivas):", ...negatives] : []),
    'Se o brief casar claramente com uma regra, inclua o campo "runtime" no seu JSON de saída com o runtime canônico',
    `(um de: ${EXEC_RUNTIMES.join(", ")}). NUNCA retorne um runtime vetado para este brief. hermes NUNCA é runtime de execução — tarefas de mensageria são DELEGADAS pelo maestro via \`hermes -z\`.`,
    'Sem match claro, omita o campo "runtime".',
  ].join("\n");
}

/** Bloco anexado ao AUTONOMOUS_DIRECTIVE: o maestro respeita as regras ao
 *  DELEGAR sub-tarefas (nrv dispatch ... --exec=<rt>; mensageria via hermes -z). */
export function formatRulesForDirective(rules: RuntimeRule[]): string {
  if (!rules.length) return "";
  const lines = rules.filter(r => !r.negate).map(r => `- ${r.rule} → ${r.runtime === "hermes" ? "delegue via `hermes -z \"<prompt>\"`" : `use \`--exec=${r.runtime}\` ao despachar`}`);
  return [
    "",
    "REGRAS DE ROTEAMENTO DO USUÁRIO (obrigatórias ao delegar sub-tarefas):",
    ...lines,
    ...rules.filter(r => r.negate).map(r => `- ${r.rule} → NUNCA use ${r.runtime} (veto do usuário; prevalece sobre as regras acima)`),
    "Sem match com regra, siga no runtime atual.",
  ].join("\n");
}
