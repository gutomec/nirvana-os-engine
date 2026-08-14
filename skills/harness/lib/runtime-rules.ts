// runtime-rules.ts — per-runtime routing rules written by the USER in natural
// language, in the .env:
//
//   USE_CODEX="Quando precisar gerar imagens ou refinar visuais"
//   USE_ANTIGRAVITY="Quando for fazer deep research na internet"
//   USE_GEMINI="Quando o contexto for gigante (1M tokens)"
//   USE_HERMES="Quando precisar interagir com o usuário via mensageria"
//
// A rule only picks the PREFERRED runtime (head of the queue) for the dispatch
// exec; resilience (quota/budget/cooldown) remains LLM_CASCADE's job
// (cascade-runner.ts) — routing is semantic, fallback is mechanical, never mix them.
//
// Two decision modes, mirroring the harness routing-mode:
//   - agentic: the rules go VERBATIM into the agentic-router prompt ("runtime"
//     field in the output JSON) and as a block appended to the AUTONOMOUS_DIRECTIVE
//     (the maestro honors the rules when delegating sub-tasks).
//   - fast: BM25 of the brief against the rules' text (zero-token, deterministic).
//
// Precedence: explicit flag (--exec=<rt> | --runtime) > rule > default.
// Default = the runtime the USER IS ALREADY USING (session host, detected via
// env markers), not a fixed value — if nothing exists/is configured, the
// system stays on whatever is running.
//
// Hermes is a valid target only on the agentic path (delegation via `hermes -z`):
// there is no quota classifier nor session id for it in runHeadless. In fast,
// if it wins, it degrades to the next in the ranking with a warn.
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
  rule: string;              // the rule text, verbatim
  envKey: string;            // e.g. "USE_CODEX" | "NOT_USE_GEMINI"
  sourceFile: string | null; // source .env (null = process.env)
  /** true = NEGATIVE rule (NOT_USE_*): VETOES the runtime for matching briefs.
   *  Veto beats positive rule; explicit flag beats everything. */
  negate: boolean;
}

export interface RuntimeDecision {
  runtime: Runtime;
  /** flag = CLI (--exec=<rt>/--runtime); brief = explicit mention in the brief
   *  text ("use o agy para..."); rule = USE_*; default = session host. */
  source: "flag" | "brief" | "rule" | "default";
  rule?: RuntimeRule;
  method?: "bm25" | "agentic";
  score?: number;
  /** Brief excerpt that named the runtime (source === "brief"). */
  mention?: string;
  /** Vetoes (NOT_USE_*) that matched the brief and changed/limited the choice. */
  vetoes?: Array<{ envKey: string; runtime: RoutableRuntime; score: number }>;
}

// USE_<suffix> → canonical runtime. Unknown suffix → warn, never breaks.
const RUNTIME_ALIASES: Record<string, RoutableRuntime> = {
  CLAUDE: "claude-code", CLAUDE_CODE: "claude-code", CLAUDECODE: "claude-code",
  CODEX: "codex", CODEX_CLI: "codex",
  GEMINI: "gemini-cli", GEMINI_CLI: "gemini-cli",
  ANTIGRAVITY: "antigravity-cli", ANTIGRAVITY_CLI: "antigravity-cli", AGY: "antigravity-cli",
  KIMI: "kimi-cli", KIMI_CLI: "kimi-cli", KIMI_CODE: "kimi-cli",
  GROK: "grok-cli", GROK_CLI: "grok-cli",
  PI: "pi", PI_CLI: "pi", PI_DEV: "pi", PI_CODING_AGENT: "pi",
  HERMES: "hermes",
};

const EXEC_RUNTIMES: ReadonlyArray<Runtime> = ["claude-code", "codex", "gemini-cli", "antigravity-cli", "kimi-cli", "grok-cli", "pi"];

// PT-BR + EN stopwords removed before BM25: with short rules, function words
// ("um", "o", "quando", "when") produce false matches — "escreva um
// poema" must not match "um milhão de tokens" on "um" alone.
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

/** Runtime HOSTING this session (the one the user is using), detected via the
 *  env markers each CLI sets on its subprocesses.
 *  NIRVANA_HOST_RUNTIME is the explicit override. null = not identified
 *  (bare terminal, cron, or a host without an exec-target like Hermes). */
export function detectCurrentHost(env: NodeJS.ProcessEnv = process.env): Runtime | null {
  const explicit = (env.NIRVANA_HOST_RUNTIME || "").toUpperCase().replace(/-/g, "_");
  if (explicit && RUNTIME_ALIASES[explicit] && RUNTIME_ALIASES[explicit] !== "hermes") {
    return RUNTIME_ALIASES[explicit] as Runtime;
  }
  if (env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (env.CODEX_SANDBOX || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return "codex";
  if (env.GEMINI_SESSION_ID || env.GEMINI_CLI) return "gemini-cli";
  if (env.ANTIGRAVITY_SESSION_ID || env.AGY_SESSION_ID || env.ANTIGRAVITY_CLI) return "antigravity-cli";
  if (env.KIMI_SESSION_ID || env.KIMI_CLI || env.KIMI_CODE) return "kimi-cli";
  if (env.GROK_SESSION_ID || env.GROK_CLI) return "grok-cli";
  if (env.PI_CODING_AGENT || env.PI_SESSION_ID) return "pi";
  return null;
}

/** Collects the USE_* vars along the SAME .env chain as LLM_CASCADE (literal
 *  file beats process.env — same reason as the cascade: Bun expands $ on auto-load).
 *  The first file defining a key wins (project overrides global). */
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
      // USE_<rt> = positive rule (attracts); NOT_USE_<rt> = veto (blocks).
      const m = key.match(/^(NOT_USE|USE)_([A-Z0-9_]+)$/);
      if (!m || !value || !String(value).trim()) continue;
      if (claimed.has(key)) continue;
      const negate = m[1] === "NOT_USE";
      const runtime = RUNTIME_ALIASES[m[2]];
      if (!runtime) {
        console.error(`[runtime-rules] unknown runtime in ${key}${sourceFile ? ` (${sourceFile})` : ""} — rule ignored. Known: ${Object.keys(RUNTIME_ALIASES).join(", ")}`);
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

// EXPLICIT runtime mention in the brief ("Use o agy para pesquisar...").
// Requires an instrumental cue before the name (use/via/pelo/com o/no/using/with...)
// so CONTENT is not confused with INSTRUCTION — a brief ABOUT the statue of
// Hermes must not route to Hermes. The runtime name alone is not enough.
const MENTION_NAMES: Array<[RegExp, RoutableRuntime]> = [
  [/\bagy\b|\bantigravity(?:[- ]cli)?\b/i, "antigravity-cli"],
  [/\bcodex(?:[- ]cli)?\b/i, "codex"],
  [/\bgemini(?:[- ]cli)?\b/i, "gemini-cli"],
  [/\bclaude(?:[- ]code)?\b/i, "claude-code"],
  [/\bkimi(?:[- ](?:code|cli))?\b/i, "kimi-cli"],
  [/\bgrok(?:[- ]cli)?\b/i, "grok-cli"],
  [/\bpi(?:[- ](?:cli|dev|coding[- ]agent))?\b/i, "pi"],
  [/\bhermes\b/i, "hermes"],
];
const MENTION_CUE =
  /\b(?:use|usa|usando|utilize|utilizando|rode|rodando|execute|executando|despache|via|pelo|pela|com|no|na|using|with|through|run(?:ning)? (?:it )?on|on)\s+(?:o\s+|a\s+|the\s+)?((?:agy|antigravity|codex|gemini|claude|hermes|pi)(?:[- ](?:cli|code|dev))?)\b/gi;

/** Detects an instrumental mention of a runtime in the brief. null when: none,
 *  or more than one distinct runtime named (ambiguous — no guessing). */
export function detectRuntimeMention(brief: string): { runtime: RoutableRuntime; mention: string } | null {
  if (!brief?.trim()) return null;
  const found = new Map<RoutableRuntime, string>();
  for (const m of brief.matchAll(MENTION_CUE)) {
    const name = m[1];
    for (const [re, rt] of MENTION_NAMES) {
      if (re.test(name)) { if (!found.has(rt)) found.set(rt, m[0].trim()); break; }
    }
  }
  if (found.size !== 1) {
    if (found.size > 1) console.error(`[runtime-rules] the brief names more than one runtime (${[...found.keys()].join(", ")}) — ambiguous mention, ignoring.`);
    return null;
  }
  const [runtime, mention] = [...found.entries()][0];
  return { runtime, mention };
}

/** Vetoes matching the brief: BM25 of the brief against the NOT_USE_* rules.
 *  Any veto with score ≥ minScore applies (no tie logic — a veto does not
 *  choose, it only blocks). */
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

/** Deterministic match (fast mode): BM25 of the brief against the POSITIVE
 *  rules' text. null when: no rules, raw top score < minScore, or a tie
 *  (2nd place within 5% of the 1st = ambiguous, no decision). */
export function resolveRuntimeByRules(
  brief: string,
  rules: RuntimeRule[],
  opts: { minScore?: number; allowHermes?: boolean } = {},
): { rule: RuntimeRule; score: number; ranked: Array<{ rule: RuntimeRule; score: number }> } | null {
  // Only positive rules choose; NOT_USE_* acts as a veto in decideRuntime.
  // hermes stays in the ranking even in fast (for the warn + degrade at the top);
  // excluding hermes as the WINNER happens further down.
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
  // hermes is not an exec-target: in fast it degrades to the next in the ranking.
  if (!opts.allowHermes && top.rule.runtime === "hermes") {
    console.error(`[runtime-rules] ${top.rule.envKey} won, but hermes only works in agentic mode (delegation) — using the next in the ranking.`);
    const next = ranked.find((r: { rule: RuntimeRule }) => r.rule.runtime !== "hermes");
    if (!next) return null;
    top = next;
  }
  if (top.score < minScore) return null;
  const second = ranked.find((r: { rule: RuntimeRule }) => r.rule !== top.rule);
  if (second && top.score > 0 && (top.score - second.score) / top.score < 0.05) return null; // tie = ambiguous

  return { rule: top.rule, score: top.score, ranked };
}

/** Precedence flag > rule > default; degrades an unavailable runtime to the
 *  next in the ranking and, finally, to the default (= the user's current host). */
export function decideRuntime(opts: {
  brief: string;
  explicitRuntime: Runtime | null;
  defaultRuntime: Runtime;
  rules: RuntimeRule[];
  mode: "agentic" | "fast";
  available?: (r: Runtime) => boolean;
}): RuntimeDecision {
  // The explicit flag beats EVERYTHING, vetoes included: it is the user's
  // direct action right now, stronger than any config.
  if (opts.explicitRuntime) return { runtime: opts.explicitRuntime, source: "flag" };

  const avail = opts.available ?? (() => true);

  // Explicit mention in the BRIEF ("Use o agy para pesquisar...") = the user
  // speaking directly. Beats vetoes and rules (config); loses only to the flag.
  // hermes named → delegation only (the maestro sees it via directive); flow continues.
  const mention = detectRuntimeMention(opts.brief);
  if (mention && mention.runtime !== "hermes") {
    if (avail(mention.runtime as Runtime)) {
      return { runtime: mention.runtime as Runtime, source: "brief", mention: mention.mention };
    }
    console.error(`[runtime-rules] the brief asks for ${mention.runtime} ("${mention.mention}"), but it is not on this machine — falling back to the rules/default.`);
  }
  // Vetoes (NOT_USE_*) matching this brief: they block the runtime both in the
  // positive-rule choice and in the default. Veto beats positive rule.
  const vetoHits = matchedVetoes(opts.brief, opts.rules);
  const vetoed = new Set(vetoHits.map(v => v.rule.runtime));
  const vetoInfo = vetoHits.length
    ? vetoHits.map(v => ({ envKey: v.rule.envKey, runtime: v.rule.runtime, score: v.score }))
    : undefined;
  const blocked = (r: RoutableRuntime): boolean => {
    if (!vetoed.has(r)) return false;
    const v = vetoHits.find(x => x.rule.runtime === r)!;
    console.error(`[runtime-rules] ${v.rule.envKey} vetoes ${r} for this brief ("${v.rule.rule}") — skipping.`);
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
      console.error(`[runtime-rules] ${c.rule.envKey} → ${c.rule.runtime} unavailable on this machine — trying the next one.`);
    }
  }

  // Default: if the default itself is vetoed for this brief, look for the
  // first available, non-vetoed exec-runtime. If EVERYTHING is vetoed,
  // ignore the vetoes with a warning — never leave the user without execution.
  if (vetoed.has(opts.defaultRuntime)) {
    const alt = EXEC_RUNTIMES.find(r => r !== opts.defaultRuntime && !vetoed.has(r) && avail(r));
    if (alt) {
      console.error(`[runtime-rules] default ${opts.defaultRuntime} vetoed for this brief — using ${alt}.`);
      return { runtime: alt, source: "default", vetoes: vetoInfo };
    }
    console.error(`[runtime-rules] every available runtime is vetoed for this brief — ignoring the vetoes and staying on the default (${opts.defaultRuntime}).`);
  }
  return { runtime: opts.defaultRuntime, source: "default", vetoes: vetoInfo };
}

/** Verbatim block for the agentic-router prompt (--auto path). */
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

/** Block appended to the AUTONOMOUS_DIRECTIVE: the maestro honors the rules
 *  when DELEGATING sub-tasks (nrv dispatch ... --exec=<rt>; messaging via hermes -z). */
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
