/**
 * settings-schema.ts — the one table of the engine's operational settings.
 *
 * Every switch a user may configure is declared here once: a dot-separated
 * key (`section.name`), a strict zod type, the default, the scopes a value may
 * live in, a short description, the legacy environment variable it answers to
 * and how that variable encodes the value. settings.ts resolves the table
 * (env > project > global > engine default > default); `nrv config`,
 * `nrv doctor` and the Glance settings panel read it, never a private copy.
 *
 * Secrets (API keys, license, provenance) are deliberately absent: they stay
 * in `.env`, so `secret` is always false here and a reader may rely on it.
 * Variables that identify a process or a run (NIRVANA_TRACE_ID,
 * NIRVANA_PROJECT_ROOT, HARNESS_LOGS_DIR, ...) are plumbing, not settings;
 * docs/architecture/configuration.md lists them and says why.
 *
 * `description` and `expects` are what the user reads (PT-BR by contract);
 * code, identifiers and comments stay English.
 */

import { z } from "zod";

export type SettingScope = "global" | "project";
export type SettingKind = "string" | "boolean" | "number" | "enum";
export type SettingValue = string | number | boolean;
export type SettingsEnv = Record<string, string | undefined>;

export interface SettingSpec<T extends SettingValue = SettingValue> {
  key: string;
  kind: SettingKind;
  type: z.ZodType<T>;
  default: T;
  scopes: SettingScope[];
  description: string;
  /** What a valid value looks like, for refusals and `nrv config explain`. */
  expects: string;
  /** Enum choices, when `kind` is "enum". */
  options?: readonly string[];
  /** Legacy environment variable; null when the key has no env form. */
  env: string | null;
  /** Other variables that also set the key (compatibility with older releases). */
  envAliases?: string[];
  secret: false;
  /**
   * How a variable encodes the value. Returns the candidate value (validated
   * afterwards), or null when the text means "no effect" for that variable.
   * Default: the variable's own text, read by kind (see `coerceText`).
   */
  fromEnv?: (raw: string, variable: string) => SettingValue | null;
  /** The value as the variable spells it, for pinning into children; null = leave the variable unset. */
  toEnv?: (value: T) => string | null;
}

const TRUE_WORDS = new Set(["1", "true", "on", "yes"]);
const FALSE_WORDS = new Set(["0", "false", "off", "no"]);

/** `1|true|on|yes` → true, `0|false|off|no` → false, anything else → null. */
export function parseBooleanWord(raw: string): boolean | null {
  const word = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return null;
}

/** Text (a variable, a CLI argument) read by the setting's kind. An unreadable
 * text comes back as-is so validation names it in the refusal. */
export function coerceText(spec: SettingSpec, raw: string): SettingValue {
  if (spec.kind === "boolean") return parseBooleanWord(raw) ?? raw;
  if (spec.kind === "number") {
    const trimmed = raw.trim();
    const n = Number(trimmed);
    return trimmed !== "" && Number.isFinite(n) ? n : raw;
  }
  return raw;
}

export type Validation = { ok: true; value: SettingValue } | { ok: false; message: string };

/** Strict validation against the zod type; the message is what the user reads. */
export function validateSettingValue(spec: SettingSpec, value: unknown): Validation {
  const parsed = spec.type.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data as SettingValue };
  const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
  return { ok: false, message: `${spec.key}: valor inválido ${shown}; esperado ${spec.expects}` };
}

const nonNegativeInt = z.number().int().min(0);
const nonNegative = z.number().min(0);

interface Common {
  scopes?: SettingScope[];
  env?: string | null;
  envAliases?: string[];
  fromEnv?: SettingSpec["fromEnv"];
}

function stringSetting(key: string, description: string, opts: Common & {
  default?: string; type?: z.ZodType<string>; expects: string; toEnv?: (value: string) => string | null;
}): SettingSpec<string> {
  return {
    key, kind: "string", type: opts.type ?? z.string(), default: opts.default ?? "",
    scopes: opts.scopes ?? ["global", "project"], description, expects: opts.expects,
    env: opts.env ?? null, ...(opts.envAliases ? { envAliases: opts.envAliases } : {}), secret: false,
    ...(opts.fromEnv ? { fromEnv: opts.fromEnv } : {}),
    // An empty string is "not set": pinning it would only shadow a child's own resolution.
    toEnv: opts.toEnv ?? ((value) => (value === "" ? null : value)),
  };
}

function booleanSetting(key: string, description: string, opts: Common & {
  default: boolean; toEnv?: (value: boolean) => string | null;
}): SettingSpec<boolean> {
  return {
    key, kind: "boolean", type: z.boolean(), default: opts.default,
    scopes: opts.scopes ?? ["global", "project"], description, expects: "true | false",
    env: opts.env ?? null, ...(opts.envAliases ? { envAliases: opts.envAliases } : {}), secret: false,
    ...(opts.fromEnv ? { fromEnv: opts.fromEnv } : {}),
    toEnv: opts.toEnv ?? ((value) => (value ? "1" : "0")),
  };
}

function numberSetting(key: string, description: string, opts: Common & {
  default: number; type: z.ZodType<number>; expects: string;
}): SettingSpec<number> {
  return {
    key, kind: "number", type: opts.type, default: opts.default,
    scopes: opts.scopes ?? ["global", "project"], description, expects: opts.expects,
    env: opts.env ?? null, secret: false, toEnv: (value) => String(value),
  };
}

function enumSetting<const O extends readonly [string, ...string[]]>(key: string, description: string, options: O, opts: Common & {
  default: O[number]; toEnv?: (value: O[number]) => string | null;
}): SettingSpec<O[number]> {
  return {
    key, kind: "enum", type: z.enum(options), default: opts.default, options,
    scopes: opts.scopes ?? ["global", "project"], description, expects: options.join(" | "),
    env: opts.env ?? null, ...(opts.envAliases ? { envAliases: opts.envAliases } : {}), secret: false,
    ...(opts.fromEnv ? { fromEnv: opts.fromEnv } : {}),
    toEnv: opts.toEnv ?? ((value) => value),
  };
}

/** `0|false|off|no` switches it off; any other text keeps today's default (on). */
const offWordDisables: SettingSpec["fromEnv"] = (raw) => parseBooleanWord(raw) !== false;

export const MULTI_TARGET_KILL_SWITCH_ENV = "NIRVANA_MULTI_TARGET_KILL_SWITCH";
export const MULTI_TARGET_ENGINE_ENV = "NIRVANA_MULTI_TARGET_ENGINE";

export const SETTINGS = {
  "multi_target.enabled": booleanSetting("multi_target.enabled",
    "Se `nrv multi-target run` executa planos (false = kill switch: recusa com exit 4).",
    {
      default: true, env: MULTI_TARGET_KILL_SWITCH_ENV, envAliases: [MULTI_TARGET_ENGINE_ENV],
      // The kill switch at 1|true|on switches the engine off; the legacy opt-in
      // flag at 0|false|off does the same, and at 1 (or anything else) it
      // changes nothing, so an environment of the opt-in era keeps working.
      fromEnv: (raw, variable) => {
        const word = parseBooleanWord(raw);
        if (variable === MULTI_TARGET_KILL_SWITCH_ENV) return word === null ? raw : !word;
        return word === false ? false : null;
      },
      toEnv: (enabled) => (enabled ? "0" : "1"),
    }),

  "gauntlet.default_mode": enumSetting("gauntlet.default_mode",
    "Modo de execução quando o dispatch não recebe --execution-mode.",
    ["standard", "gauntlet", "auto"], { default: "standard", env: "NIRVANA_EXECUTION_MODE" }),
  "gauntlet.default_intensity": enumSetting("gauntlet.default_intensity",
    "Intensidade do Gauntlet quando o dispatch não recebe --gauntlet-intensity.",
    ["light", "balanced", "exhaustive"], { default: "balanced", env: "NIRVANA_GAUNTLET_INTENSITY" }),
  "gauntlet.evaluator": stringSetting("gauntlet.evaluator",
    "Avaliador do Gauntlet; vazio = seleção automática (squad instalado com quality.specification_conformance, senão judge-x).",
    {
      env: "NIRVANA_GAUNTLET_EVALUATOR",
      type: z.string().regex(/^(|heuristic|agent-x|judge-x|squad:[^:\s]+(?::[^\s]+)?)$/),
      expects: "squad:<slug>[:<capability>] | judge-x | agent-x | heuristic | vazio",
    }),
  "gauntlet.business_allowlist": stringSetting("gauntlet.business_allowlist",
    "Businesses (slugs separados por vírgula) autorizados a rodar em modo gauntlet.",
    {
      env: "NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST",
      type: z.string().regex(/^$|^[A-Za-z0-9._-]+(?:\s*,\s*[A-Za-z0-9._-]+)*$/),
      expects: "slugs separados por vírgula (ou vazio)",
    }),
  "gauntlet.business_kill_switch": booleanSetting("gauntlet.business_kill_switch",
    "Desliga o canário Gauntlet de businesses mesmo com allowlist.",
    { default: false, env: "NIRVANA_BUSINESS_GAUNTLET_KILL_SWITCH" }),
  "gauntlet.auto_allowed": booleanSetting("gauntlet.auto_allowed",
    "Permite que o modo auto escolha gauntlet (senão auto resolve para standard).",
    { default: false, env: "NIRVANA_ALLOW_AUTO_GAUNTLET" }),

  "execution.default_runtime": stringSetting("execution.default_runtime",
    "Runtime usado quando a sessão não é identificada; vazio = primeiro disponível no PATH.",
    { env: "NIRVANA_DEFAULT_RUNTIME", type: z.string().regex(/^[A-Za-z0-9._-]*$/), expects: "nome de runtime (claude-code, codex, gemini-cli, ...) ou vazio" }),
  "execution.model": stringSetting("execution.model",
    "Modelo fixado nos spawns do Nirvana (--model); vazio = herda o modelo da sessão.",
    { env: "NIRVANA_MODEL", expects: "id ou alias de modelo (opus, sonnet, haiku, fable, ...) ou vazio" }),
  "execution.dna_injection": enumSetting("execution.dna_injection",
    "Profundidade da injeção de DNA dos mind-clones: full = persona inteira; fragments = camadas da fase.",
    ["full", "fragments"], { default: "full", env: "NIRVANA_DNA_INJECTION" }),
  "execution.headless_skip_permissions": booleanSetting("execution.headless_skip_permissions",
    "Filhos headless pulam as aprovações do próprio CLI (autonomia); false = caminho restrito.",
    { default: true, env: "NIRVANA_HEADLESS_SKIP_PERMISSIONS", fromEnv: offWordDisables }),

  "glance.execution": booleanSetting("glance.execution",
    "O Glance executa Messages por processo filho; false = cockpit sem execução.",
    { default: true, env: "NIRVANA_GLANCE_EXECUTION", fromEnv: offWordDisables }),

  "runtime.provider_catalog_dir": stringSetting("runtime.provider_catalog_dir",
    "Diretórios de catálogo de providers (separados por : ou ; no Windows); vazio = ~/.nirvana/providers e <projeto>/.nirvana/providers.",
    { env: "NIRVANA_PROVIDER_CATALOG_DIR", expects: "lista de caminhos separados pelo delimitador do sistema, ou vazio" }),
  "runtime.allow_stale_catalog": booleanSetting("runtime.allow_stale_catalog",
    "Aceita catálogo de providers vencido (com aviso) em vez de deixar runtime e modelo sem resolução.",
    { default: false, env: "NIRVANA_ALLOW_STALE_CATALOG" }),

  "routing.mode": enumSetting("routing.mode",
    "Como o roteador escolhe o alvo: agentic = um agente lê os registries; fast = BM25 determinístico.",
    ["agentic", "fast"], { default: "agentic", env: "NIRVANA_ROUTING_MODE" }),
  "routing.dense": enumSetting("routing.dense",
    "Braço neural do roteador fast: off; fallback = consultado só em NO_MATCH, sugere, nunca despacha.",
    ["off", "fallback"], {
      default: "off", env: "NIRVANA_ROUTER_DENSE",
      fromEnv: (raw) => {
        const word = raw.trim().toLowerCase();
        if (word === "1") return "fallback";
        if (word === "0") return "off";
        return raw;
      },
      toEnv: (value) => (value === "fallback" ? "1" : "0"),
    }),
  "routing.on_router_failure": enumSetting("routing.on_router_failure",
    "Quando o roteador agêntico falha no transporte: cascade = BM25 e depois agent-x; fail = encerra.",
    ["cascade", "fail"], { default: "cascade" }),

  "supervisor.progress_ping_sec": numberSetting("supervisor.progress_ping_sec",
    "Intervalo em segundos do aviso de progresso de um run longo; 0 silencia.",
    { default: 1800, env: "NIRVANA_PROGRESS_PING_SEC", type: nonNegativeInt, expects: "inteiro >= 0 (segundos)" }),
  "supervisor.stall_threshold_ms": numberSetting("supervisor.stall_threshold_ms",
    "Milissegundos sem atividade até um run ser tratado como travado (supervisor e heartbeat do driver).",
    { default: 300_000, env: "NIRVANA_STALL_THRESHOLD_MS", type: z.number().int().positive(), expects: "inteiro > 0 (milissegundos)" }),

  "updates.check": booleanSetting("updates.check",
    "Verifica se há release nova do engine (cache diário); false desliga.",
    {
      default: true, scopes: ["global"], env: "NIRVANA_NO_UPDATE_CHECK",
      // The legacy variable is an opt-out: NIRVANA_NO_UPDATE_CHECK=1 means "do not check".
      fromEnv: (raw) => { const word = parseBooleanWord(raw); return word === null ? raw : !word; },
      toEnv: (check) => (check ? null : "1"),
    }),

  "budget.default_max_cost_usd": numberSetting("budget.default_max_cost_usd",
    "Teto de custo por run em USD; 0 = ilimitado.", { default: 0, type: nonNegative, expects: "número >= 0 (USD)" }),
  "budget.default_max_tokens": numberSetting("budget.default_max_tokens",
    "Teto de tokens por run; 0 = ilimitado.", { default: 0, type: nonNegativeInt, expects: "inteiro >= 0" }),
  "budget.default_max_handoffs": numberSetting("budget.default_max_handoffs",
    "Teto de handoffs por run; 0 = ilimitado.", { default: 0, type: nonNegativeInt, expects: "inteiro >= 0" }),
  "budget.default_max_duration_seconds": numberSetting("budget.default_max_duration_seconds",
    "Duração máxima de um run em segundos; 0 = ilimitado.", { default: 0, type: nonNegativeInt, expects: "inteiro >= 0 (segundos)" }),
  "budget.on_budget_exceeded": enumSetting("budget.on_budget_exceeded",
    "O que fazer quando um teto > 0 é excedido.", ["abort", "warn", "escalate"], { default: "warn" }),
  "budget.auto_invoke_budget_usd": numberSetting("budget.auto_invoke_budget_usd",
    "Teto em USD para invocação automática de uma capability validada; 0 = sem teto.", { default: 0, type: nonNegative, expects: "número >= 0 (USD)" }),
  "baselines.squad_capability_usd": numberSetting("baselines.squad_capability_usd",
    "Custo estimado de uma capability de squad sem estimativa própria.", { default: 0.3, type: nonNegative, expects: "número >= 0 (USD)" }),
  "baselines.business_usd": numberSetting("baselines.business_usd",
    "Custo estimado de um business sem estimativa própria.", { default: 0.8, type: nonNegative, expects: "número >= 0 (USD)" }),
  "baselines.per_handoff_usd": numberSetting("baselines.per_handoff_usd",
    "Custo estimado por handoff.", { default: 0.05, type: nonNegative, expects: "número >= 0 (USD)" }),

  "quality_gate.judge_enabled": booleanSetting("quality_gate.judge_enabled",
    "Liga o juiz LLM do quality gate (senão só as heurísticas offline).", { default: false }),
  "quality_gate.max_revisions": numberSetting("quality_gate.max_revisions",
    "Revisões automáticas antes de reter a entrega.", { default: 2, type: nonNegativeInt, expects: "inteiro >= 0" }),
  "quality_gate.escalate_after": numberSetting("quality_gate.escalate_after",
    "Revisões antes de escalar (reservado; hoje segue max_revisions).", { default: 2, type: nonNegativeInt, expects: "inteiro >= 0" }),
  "quality_gate.rubric_fallback": stringSetting("quality_gate.rubric_fallback",
    "Rubrica usada quando produces[] não casa com nenhuma.", { default: "prose_shortform", type: z.string().min(1), expects: "nome de rubrica" }),
  "quality_gate.default_judge_model": stringSetting("quality_gate.default_judge_model",
    "Modelo do juiz; inherit = o modelo configurado no runtime do usuário.", { default: "inherit", type: z.string().min(1), expects: "id de modelo ou inherit" }),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValueOf<K extends SettingKey> = (typeof SETTINGS)[K] extends SettingSpec<infer T> ? T : never;

/** The table in declaration order: the order `nrv config list` and `nrv doctor` print. */
export const SETTINGS_SCHEMA: SettingSpec[] = Object.values(SETTINGS) as SettingSpec[];
export const SETTING_KEYS: SettingKey[] = Object.keys(SETTINGS) as SettingKey[];

export function getSettingSpec(key: string): SettingSpec | undefined {
  return (SETTINGS as Record<string, SettingSpec>)[key];
}

/** The spec without its zod type: what a JSON consumer (the CLI, the Glance panel) gets. */
export interface SettingInfo {
  key: string;
  kind: SettingKind;
  default: SettingValue;
  scopes: SettingScope[];
  description: string;
  expects: string;
  options: string[] | null;
  env: string | null;
  envAliases: string[];
  secret: false;
}

export function settingInfo(spec: SettingSpec): SettingInfo {
  return {
    key: spec.key, kind: spec.kind, default: spec.default, scopes: [...spec.scopes], description: spec.description,
    expects: spec.expects, options: spec.options ? [...spec.options] : null, env: spec.env, envAliases: [...(spec.envAliases ?? [])], secret: false,
  };
}
