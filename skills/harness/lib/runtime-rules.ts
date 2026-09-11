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
import * as path from "node:path";
import { createRequire } from "node:module";
import { listRuntimes, runtimeAvailable, type Runtime } from "../../_shared/lib/host-agent-driver.ts";
import { resolveSetting } from "../../_shared/lib/settings.ts";
import { globalEnvFiles, readEnvFile, resolveCascadeRoot } from "./cascade.ts";

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
  /** The caller named this runtime and it is not installed here. The choice is
   *  still theirs — this is not a silent substitution — but a caller must refuse
   *  to run rather than spend another vendor's quota behind their back. */
  unavailable?: boolean;
}

/** Everything the engine needs to RECOGNISE one runtime, in one entry:
 *  the extra names a human types, the env vars that identify a live session of
 *  it, and how a brief writes it. Typed `Record<Runtime, …>`, so the compiler
 *  refuses a roster the driver grew past — the same drift that left four tables
 *  in this file stuck at seven names while the driver carried nine.
 *
 *  `markers` are env vars a CLI exports to its own children. For the five that
 *  are installed here they were measured; for `kimi-cli`, `qwen-code` and
 *  `opencode` they follow each vendor's own convention and are UNVERIFIED (no
 *  binary on this machine to read). Our own dispatches never depend on the
 *  guess: the driver stamps `NIRVANA_HOST_RUNTIME` on every child it spawns,
 *  and that is checked before any marker. */
interface RuntimeIdentity {
  /** USE_<suffix> / typed names beyond the canonical one (upper snake). */
  aliases: string[];
  /** Env vars whose presence identifies a session of this runtime. */
  markers: string[];
  /** Alternation fragment for a brief mention — no anchors, no capture. */
  mention: string;
  /** Derivative of another runtime, so it inherits the parent's env vars and
   *  must be tested BEFORE the parent or it answers with the parent's name. */
  fork?: true;
}

const RUNTIME_IDENTITY: Record<Runtime, RuntimeIdentity> = {
  "claude-code": {
    aliases: ["CLAUDE", "CLAUDECODE"],
    markers: ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT"],
    mention: "claude(?:[- ]code)?",
  },
  codex: {
    aliases: ["CODEX_CLI"],
    markers: ["CODEX_SANDBOX", "CODEX_THREAD_ID", "CODEX_SESSION_ID"],
    mention: "codex(?:[- ]cli)?",
  },
  "antigravity-cli": {
    aliases: ["ANTIGRAVITY", "AGY"],
    markers: ["ANTIGRAVITY_SESSION_ID", "AGY_SESSION_ID", "ANTIGRAVITY_CLI"],
    mention: "agy|antigravity(?:[- ]cli)?",
    fork: true,   // Google, Gemini family
  },
  "gemini-cli": {
    aliases: ["GEMINI"],
    markers: ["GEMINI_SESSION_ID", "GEMINI_CLI"],
    mention: "gemini(?:[- ]cli)?",
  },
  pi: {
    aliases: ["PI_CLI", "PI_DEV", "PI_CODING_AGENT"],
    markers: ["PI_CODING_AGENT", "PI_SESSION_ID"],
    mention: "pi(?:[- ](?:cli|dev|coding[- ]agent))?",
  },
  "kimi-cli": {
    aliases: ["KIMI", "KIMI_CODE"],
    markers: ["KIMI_SESSION_ID", "KIMI_CLI", "KIMI_CODE"],
    mention: "kimi(?:[- ](?:code|cli))?",
  },
  "grok-cli": {
    aliases: ["GROK"],
    markers: ["GROK_SESSION_ID", "GROK_CLI"],
    mention: "grok(?:[- ]cli)?",
  },
  "qwen-code": {
    aliases: ["QWEN", "QWEN_CLI"],
    markers: ["QWEN_SESSION_ID", "QWEN_CODE", "QWEN_CLI"],
    mention: "qwen(?:[- ]code)?",
    fork: true,   // gemini-cli fork; ships the parent's vars
  },
  opencode: {
    aliases: ["OPEN_CODE", "OPENCODE_CLI"],
    markers: ["OPENCODE_SESSION_ID", "OPENCODE_CLI", "OPENCODE"],
    mention: "opencode",
  },
};

/** The canonical USE_ suffix for a runtime: `gemini-cli` → `GEMINI_CLI`. */
const envSuffix = (r: Runtime): string => r.toUpperCase().replace(/-/g, "_");

// USE_<suffix> → canonical runtime. Unknown suffix → warn, never breaks.
// Derived: canonical name + declared aliases, for every runtime the driver has.
const RUNTIME_ALIASES: Record<string, RoutableRuntime> = (() => {
  const table: Record<string, RoutableRuntime> = { HERMES: "hermes" };
  for (const { name } of listRuntimes()) {
    table[envSuffix(name)] = name;
    for (const alias of RUNTIME_IDENTITY[name]?.aliases ?? []) table[alias] = name;
  }
  return table;
})();

// The roster, DERIVED. Three copies of this list lived in three files and all
// three had stopped at seven names while the driver grew to nine, so a user who
// wrote `qwen-code` or `opencode` had their entry dropped without a word. The
// driver owns the list; everyone else asks it.
const EXEC_RUNTIMES: ReadonlyArray<Runtime> = listRuntimes().map((r) => r.name);

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
  for (const name of detectionOrder()) {
    if (RUNTIME_IDENTITY[name]?.markers.some((m) => env[m])) return name;
  }
  return null;
}

/** Roster order, with the derivatives moved to the front: a `qwen-code` session
 *  exports the gemini-cli vars it forked, so testing gemini first would answer
 *  with the parent's name for a runtime that is not it. */
function detectionOrder(): Runtime[] {
  const names = listRuntimes().map((r) => r.name);
  return [...names.filter((n) => RUNTIME_IDENTITY[n]?.fork), ...names.filter((n) => !RUNTIME_IDENTITY[n]?.fork)];
}

/** Canonical runtime for a user-typed name (`claude`, `agy`, `pi-dev`, …) through the
 *  same alias table as USE_* and NIRVANA_HOST_RUNTIME. Unknown names pass through. */
export function canonicalRuntimeName(name: string): Runtime {
  const alias = RUNTIME_ALIASES[name.trim().toUpperCase().replace(/-/g, "_")];
  return alias && alias !== "hermes" ? (alias as Runtime) : (name.trim() as Runtime);
}

/** Default exec runtime once flag, brief mention and rules are silent, in the order
 *  dispatch.ts applies: the session host, then NIRVANA_DEFAULT_RUNTIME, then the first
 *  runtime installed on PATH, then claude-code. Pure, so the dispatch and the Glance
 *  execution runner cannot disagree about which runtime a child would pick. */
export function resolveDefaultRuntime(input: {
  detectedHost: Runtime | null;
  envDefault: string;
  normalize: (name: string) => Runtime;
  firstAvailable: () => Runtime | null;
}): { runtime: Runtime; from: "host" | "env" | "path-scan" | "fallback" } {
  if (input.detectedHost) return { runtime: input.detectedHost, from: "host" };
  if (input.envDefault) return { runtime: input.normalize(input.envDefault), from: "env" };
  const scanned = input.firstAvailable();
  if (scanned) return { runtime: scanned, from: "path-scan" };
  return { runtime: "claude-code", from: "fallback" };
}

export interface RunRuntimeChoice extends RuntimeDecision {
  /** What session detection found; null when the CLI exports no marker. */
  hostDetected: Runtime | null;
  /** Where the DEFAULT came from, when neither flag, brief nor rule decided. */
  defaultFrom: "host" | "env" | "path-scan" | "fallback";
  /** Runtimes actually installed here, in roster order. */
  installed: Runtime[];
}

/**
 * THE house rule for which runtime a run uses, in one place.
 *
 * The default is the session the user is sitting in: if they are working in
 * Codex, the work runs in Codex, on that CLI's own configured model. They may
 * name another one — flag, or a mention in the brief, or a USE_* rule — and
 * that wins, provided it is installed here.
 *
 * It lives here because the rule was duplicated and drifted. `dispatch.ts`
 * resolved it properly while `chain.ts` (the business director, and therefore
 * every seat of every org chart) carried a literal `?? "claude-code"`: a client
 * working in Codex had the director run on a Claude Code session they never
 * use, which failed on a stale credential and dropped the whole business to
 * `agent-x`. One resolver, so a third caller cannot drift again.
 */
export function resolveRunRuntime(opts: {
  brief?: string;
  explicit?: Runtime | null;
  projectRoot?: string | null;
  mode?: "agentic" | "fast";
  env?: NodeJS.ProcessEnv;
  /** Test seam: which runtimes count as installed. */
  available?: (r: Runtime) => boolean;
}): RunRuntimeChoice {
  const env = opts.env ?? process.env;
  const available = opts.available ?? runtimeAvailable;
  const installed = listRuntimes().map((r) => r.name).filter(available);
  const hostDetected = detectCurrentHost(env);
  let envDefault = "";
  try { envDefault = String(resolveSetting("execution.default_runtime").value ?? "").trim(); } catch { envDefault = ""; }
  const { runtime: hostDefault, from: defaultFrom } = resolveDefaultRuntime({
    detectedHost: hostDetected,
    envDefault,
    normalize: canonicalRuntimeName,
    firstAvailable: () => installed[0] ?? null,
  });
  const decision = decideRuntime({
    brief: opts.brief ?? "",
    explicitRuntime: opts.explicit ?? null,
    defaultRuntime: hostDefault,
    rules: loadRuntimeRules(opts.projectRoot ?? null, env),
    mode: opts.mode ?? "agentic",
    available,
  });
  return { ...decision, hostDetected, defaultFrom, installed };
}

/** The sentence a caller prints when the runtime the user named is not here. */
export function unavailableRuntimeMessage(choice: { runtime: Runtime; installed: Runtime[] }): string {
  const green = choice.installed.length ? choice.installed.join(", ") : "none";
  return `runtime '${choice.runtime}' was requested but is not installed on this machine. `
    + `Installed right now: ${green}. `
    + `Install it, or name one of those instead — the work is not silently moved to another vendor.`;
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
  for (const f of globalEnvFiles()) if (!files.includes(f)) files.push(f);

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
// DERIVED from the same identity table as detection and USE_*, for one reason
// measured here: this pair used to be two hand-written lists, and the cue's
// name alternation had stopped four names earlier than the map beside it —
// `kimi-cli` and `grok-cli` sat in the map where nothing could ever reach them,
// and neither list had heard of `qwen-code` or `opencode`.
const MENTION_PAIRS: Array<[Runtime | "hermes", string]> = [
  ...listRuntimes().map((r) => [r.name, RUNTIME_IDENTITY[r.name].mention] as [Runtime, string]),
  ["hermes", "hermes"],
];
const MENTION_NAMES: Array<[RegExp, RoutableRuntime]> =
  MENTION_PAIRS.map(([rt, frag]) => [new RegExp(`^(?:${frag})$`, "i"), rt]);
/** Each fragment stays WHOLE inside its own group — several carry an internal
 *  `|` (pi's `cli|dev|coding-agent`), and splitting on it shreds the pattern.
 *  Longest group first, so no name is cut short by a shorter sibling. */
const MENTION_ALTERNATION = MENTION_PAIRS
  .map(([, frag]) => `(?:${frag})`)
  .sort((a, b) => b.length - a.length)
  .join("|");
const MENTION_CUE = new RegExp(
  "\\b(?:use|usa|usando|utilize|utilizando|rode|rodando|execute|executando|despache|via|pelo|pela|com|no|na"
  + "|using|with|through|run(?:ning)? (?:it )?on|on)"
  + `\\s+(?:o\\s+|a\\s+|the\\s+)?((?:${MENTION_ALTERNATION}))\\b`,
  "gi",
);

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
  const avail = opts.available ?? (() => true);

  // The explicit flag beats EVERYTHING, vetoes included: it is the user's
  // direct action right now, stronger than any config. It does NOT beat
  // reality: a runtime that is not on this machine cannot run the work, and
  // quietly serving it from another vendor is the defect this whole file
  // exists to prevent. The choice is returned as asked, marked unavailable,
  // and the caller refuses with the list of what is installed.
  if (opts.explicitRuntime) {
    return avail(opts.explicitRuntime)
      ? { runtime: opts.explicitRuntime, source: "flag" }
      : { runtime: opts.explicitRuntime, source: "flag", unavailable: true };
  }

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
