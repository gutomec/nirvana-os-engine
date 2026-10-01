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
 * `description` and `expects` are what the user reads; like all code,
 * identifiers and comments, they are English.
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
  return { ok: false, message: `${spec.key}: invalid value ${shown}; expected ${spec.expects}` };
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
    "Whether `nrv multi-target run` executes plans (false = kill switch: refuses with exit 4).",
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
    "Execution mode when the dispatch gets no --execution-mode.",
    ["standard", "gauntlet", "auto"], { default: "standard", env: "NIRVANA_EXECUTION_MODE" }),
  "gauntlet.default_intensity": enumSetting("gauntlet.default_intensity",
    "Gauntlet intensity when the dispatch gets no --gauntlet-intensity.",
    ["light", "balanced", "exhaustive"], { default: "balanced", env: "NIRVANA_GAUNTLET_INTENSITY" }),
  "gauntlet.evaluator": stringSetting("gauntlet.evaluator",
    "Gauntlet evaluator; empty = automatic selection (an installed squad with quality.specification_conformance, otherwise judge-x).",
    {
      env: "NIRVANA_GAUNTLET_EVALUATOR",
      type: z.string().regex(/^(|heuristic|agent-x|judge-x|squad:[^:\s]+(?::[^\s]+)?)$/),
      expects: "squad:<slug>[:<capability>] | judge-x | agent-x | heuristic | empty",
    }),
  "gauntlet.business_allowlist": stringSetting("gauntlet.business_allowlist",
    "Businesses (comma-separated slugs) allowed to run in gauntlet mode.",
    {
      env: "NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST",
      type: z.string().regex(/^$|^[A-Za-z0-9._-]+(?:\s*,\s*[A-Za-z0-9._-]+)*$/),
      expects: "comma-separated slugs (or empty)",
    }),
  "gauntlet.business_kill_switch": booleanSetting("gauntlet.business_kill_switch",
    "Turns off the business Gauntlet canary even with an allowlist.",
    { default: false, env: "NIRVANA_BUSINESS_GAUNTLET_KILL_SWITCH" }),
  "gauntlet.auto_allowed": booleanSetting("gauntlet.auto_allowed",
    "Lets auto mode choose gauntlet (otherwise auto resolves to standard).",
    { default: false, env: "NIRVANA_ALLOW_AUTO_GAUNTLET" }),
  "gauntlet.requirements_source": enumSetting("gauntlet.requirements_source",
    "Where the judge's contract comes from: brief = brief-conformance only (today's default); capability = brief-conformance plus the declared acceptance[].",
    ["brief", "capability"], { default: "brief", env: "NIRVANA_GAUNTLET_REQUIREMENTS_SOURCE" }),

  "delivery.produces_to_rubric": booleanSetting("delivery.produces_to_rubric",
    "Passes the target's produces[] to the quality gate's rubric selector, so a research report is judged by the research rubric; a produces entry with no rubric falls back to inference by file extension. false = the judge uses only the rubric inferred from the extension.",
    { default: true, env: "NIRVANA_PRODUCES_TO_RUBRIC" }),

  "execution.default_runtime": stringSetting("execution.default_runtime",
    "Runtime used when the session is not identified; empty = first one available on PATH.",
    { env: "NIRVANA_DEFAULT_RUNTIME", type: z.string().regex(/^[A-Za-z0-9._-]*$/), expects: "runtime name (claude-code, codex, gemini-cli, ...) or empty" }),
  // Empty is the default, and empty means PASS NOTHING: the child CLI uses what
  // its own configuration says, which is the user's default. Dispatching codex
  // is running `codex` with no `--model` and no effort; dispatching claude is a
  // bare `claude`. A value here is the user asking for something else on purpose.
  "execution.model": stringSetting("execution.model",
    "Model pinned on Nirvana spawns (--model); empty (default) = specify nothing and the CLI uses the user's default.",
    { env: "NIRVANA_MODEL", expects: "model id or alias (opus, sonnet, haiku, fable, ...) or empty" }),
  "execution.effort": stringSetting("execution.effort",
    "Effort pinned on Nirvana spawns; empty (default) = specify nothing and the CLI uses the user's default.",
    { env: "NIRVANA_EFFORT", expects: "low | medium | high | xhigh | max or empty" }),
  "execution.child_env": enumSetting("execution.child_env",
    "Environment a dispatched agent receives: inherit = the parent process's whole environment (local default); declared = only the system base, the NIRVANA_* scope, the credentials of the runtime about to run and the env_vars that installed squads declare (the nrv serve default).",
    ["inherit", "declared"], { default: "inherit", env: "NIRVANA_CHILD_ENV" }),
  // Agents dispatching agents is bounded, and the bound is finite on purpose:
  // the failure mode is exponential. Reported from a live run — two dispatches
  // became fifteen agents, each opening its own subagents, one of them looping
  // against the project contract's orchestration rule.
  "execution.max_dispatch_depth": numberSetting("execution.max_dispatch_depth",
    "Maximum depth of a chain of agents dispatching agents; 0 = unlimited. The default 4 covers both topologies: in the terminal, business (1), seat (2) and the squad used by the seat (3); in Glance the maestro is itself a child, so everything moves down one level and the squad sits at 4.",
    { default: 4, type: nonNegativeInt, env: "NIRVANA_MAX_DISPATCH_DEPTH", expects: "integer >= 0" }),
  // The profile is a layer of defaults (profiles.ts), resolved between the
  // user's files and the engine defaults; `none` keeps the engine defaults.
  "execution.profile": enumSetting("execution.profile",
    "Performance profile: max = highest quality and highest token use; balanced = balance (recommended); economy = lowest use; none = no profile, engine defaults apply. An explicitly set key always beats the profile.",
    ["none", "max", "balanced", "economy"], { default: "none", env: "NIRVANA_PROFILE" }),
  // Measured on real runs: 76% of the plan went to re-reading context, and a
  // worker's conversation grew to 650k-870k tokens before the runtime
  // compacted it. The ceiling makes the worker compact early; its state lives
  // on disk (PROGRESS.md), so what leaves the context is tool output it has
  // already turned into files.
  "execution.context_window": numberSetting("execution.context_window",
    "Context ceiling, in tokens, for the agents Nirvana dispatches: above it the runtime compacts the conversation. 0 = the runtime default. Applies to claude-code (CLAUDE_CODE_AUTO_COMPACT_WINDOW) and codex (model_auto_compact_token_limit).",
    { default: 0, type: nonNegativeInt, env: "NIRVANA_CONTEXT_WINDOW", expects: "integer >= 0 (tokens)" }),
  // 2026 models read what they need when they need it (Anthropic: context on
  // demand; OpenAI: "prompting the model to read files before every edit is a
  // great way to burn context"). A whole persona pasted three times over made
  // the task 0.2% of a 169k-character prompt; the card names the file instead.
  "execution.dna_injection": enumSetting("execution.dna_injection",
    "Depth of mind-clone DNA injection: reference = a card (path, one_liner, routing) and the executor reads the file when needed; fragments = the phase's layers; full = the whole persona.",
    ["reference", "fragments", "full"], { default: "reference", env: "NIRVANA_DNA_INJECTION" }),
  "execution.headless_skip_permissions": booleanSetting("execution.headless_skip_permissions",
    "Headless children run autonomously: claude in auto mode (a classifier approves in place of a person), other runtimes skip their own CLI approvals; false = restricted path.",
    { default: true, env: "NIRVANA_HEADLESS_SKIP_PERMISSIONS", fromEnv: offWordDisables }),

  "briefing.altitude": enumSetting("briefing.altitude",
    "Altitude of the enriched brief and the dispatch instructions: outcome = result, guardrails and definition of done (default); guided = adds the structure the author suggests; prescriptive = per-item criteria, artifact list and method (the form up to 0.13.9).",
    ["outcome", "guided", "prescriptive"], { default: "outcome", env: "NIRVANA_BRIEF_ALTITUDE" }),
  "glance.execution": booleanSetting("glance.execution",
    "Glance runs Messages through a child process; false = cockpit without execution.",
    { default: true, env: "NIRVANA_GLANCE_EXECUTION", fromEnv: offWordDisables }),
  // 0, like every other cap here. A ceiling is the owner's to name: it is
  // HARD, so one chosen by the engine can end a turn halfway with everything
  // spent and nothing delivered. This defaulted to 5 and was the only place
  // the engine put a number on someone else's money by itself.
  "glance.maestro_max_budget_usd": numberSetting("glance.maestro_max_budget_usd",
    "Spend ceiling in USD for one maestro turn in the Glance chat (claude --max-budget-usd); 0 = no ceiling, and that is the default.",
    { default: 0, type: nonNegative, expects: "number >= 0 (USD); 0 = no ceiling" }),

  // Enforced today only by a served Glance instance (`glance --host` beyond loopback), against
  // the log already pinned to the project (the tenant). The default (365) is the same number
  // already declared, and never wired to anything, in
  // HarnessConfigSchema.audit.project_retention_days — not a new policy. A legal document has a
  // filing deadline and an LGPD obligation: the real value is the project owner's call, made
  // via `nrv config set audit.project_retention_days <n> --scope project`.
  "audit.project_retention_days": numberSetting("audit.project_retention_days",
    "Retention days for a served project's audit log before rotation deletes the day's directory; the right value for a legal obligation (e.g. LGPD) is the owner's decision, not an engine default.",
    { default: 365, type: z.number().int().positive(), expects: "integer > 0 (days)" }),

  "runtime.provider_catalog_dir": stringSetting("runtime.provider_catalog_dir",
    "Provider catalog directories (separated by : or ; on Windows); empty = ~/.nirvana/providers and <project>/.nirvana/providers.",
    { env: "NIRVANA_PROVIDER_CATALOG_DIR", expects: "list of paths separated by the system delimiter, or empty" }),
  "runtime.allow_stale_catalog": booleanSetting("runtime.allow_stale_catalog",
    "Accepts an expired provider catalog (with a warning) instead of leaving runtime and model unresolved.",
    { default: false, env: "NIRVANA_ALLOW_STALE_CATALOG" }),

  "routing.mode": enumSetting("routing.mode",
    "How the router picks the target: agentic = an agent reads the registries; cards = one tool-less call over the compiled cards; fast = deterministic BM25.",
    ["agentic", "cards", "fast"], { default: "agentic", env: "NIRVANA_ROUTING_MODE" }),
  "routing.dense": enumSetting("routing.dense",
    "Neural arm of the fast router: off; fallback = consulted only on NO_MATCH, suggests, never dispatches.",
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
    "When the agentic router fails in transport (after 1 retry): agent-x-only = goes straight to agent-x, BM25 never fires without an explicit --fast (default); cascade = tries BM25 before agent-x; fail = ends without dispatching anything.",
    ["cascade", "agent-x-only", "fail"], { default: "agent-x-only" }),
  "routing.timeout_ms": numberSetting("routing.timeout_ms",
    "Ceiling for one agentic router call, in milliseconds. A timeout is not retried: the dispatch goes straight to routing.on_router_failure.",
    { default: 300_000, type: z.number().int().min(1), expects: "integer > 0 (ms)", env: "NIRVANA_ROUTING_TIMEOUT_MS" }),
  "routing.digest_token_budget": numberSetting("routing.digest_token_budget",
    "Token budget for the routing digest (chars/4); above it the digest degrades in tiers. 0 = no ceiling (default).",
    { default: 0, type: nonNegativeInt, expects: "integer >= 0 (tokens); 0 = no ceiling" }),

  "host.orca": enumSetting("host.orca",
    "Orca host: auto = only inside an Orca terminal; on = whenever the app responds; off = never call Orca.",
    ["auto", "on", "off"], { default: "auto", env: "NIRVANA_ORCA_HOST" }),
  "host.orca_workers": booleanSetting("host.orca_workers",
    "With the Orca host active, each headless dispatch runs in an Orca worker terminal; false keeps the child process invisible.",
    { default: true, env: "NIRVANA_ORCA_WORKERS" }),

  "supervisor.progress_ping_sec": numberSetting("supervisor.progress_ping_sec",
    "Interval in seconds of the progress notice for a long run; 0 silences it.",
    { default: 1800, env: "NIRVANA_PROGRESS_PING_SEC", type: nonNegativeInt, expects: "integer >= 0 (seconds)" }),
  "supervisor.stall_threshold_ms": numberSetting("supervisor.stall_threshold_ms",
    "Milliseconds without activity until a run is treated as stalled (supervisor and driver heartbeat).",
    { default: 300_000, env: "NIRVANA_STALL_THRESHOLD_MS", type: z.number().int().positive(), expects: "integer > 0 (milliseconds)" }),
  "supervisor.touch_events_max": numberSetting("supervisor.touch_events_max",
    "Ceiling on artifact_touched events the heartbeat emits per headless execution; 0 turns off file reporting.",
    { default: 500, env: "NIRVANA_TOUCH_EVENTS_MAX", type: nonNegativeInt, expects: "integer >= 0 (events)" }),

  "updates.check": booleanSetting("updates.check",
    "Checks whether a new engine release exists (daily cache); false turns it off.",
    {
      default: true, scopes: ["global"], env: "NIRVANA_NO_UPDATE_CHECK",
      // The legacy variable is an opt-out: NIRVANA_NO_UPDATE_CHECK=1 means "do not check".
      fromEnv: (raw) => { const word = parseBooleanWord(raw); return word === null ? raw : !word; },
      toEnv: (check) => (check ? null : "1"),
    }),

  "budget.default_max_cost_usd": numberSetting("budget.default_max_cost_usd",
    "Cost ceiling per run in USD; 0 = unlimited.", { default: 0, type: nonNegative, expects: "number >= 0 (USD)" }),
  "budget.default_max_tokens": numberSetting("budget.default_max_tokens",
    "Token ceiling per run; 0 = unlimited.", { default: 0, type: nonNegativeInt, expects: "integer >= 0" }),
  "budget.default_max_handoffs": numberSetting("budget.default_max_handoffs",
    "Handoff ceiling per run; 0 = unlimited.", { default: 0, type: nonNegativeInt, expects: "integer >= 0" }),
  "budget.default_max_duration_seconds": numberSetting("budget.default_max_duration_seconds",
    "Maximum duration of a run in seconds; 0 = unlimited.", { default: 0, type: nonNegativeInt, expects: "integer >= 0 (seconds)" }),
  "budget.on_budget_exceeded": enumSetting("budget.on_budget_exceeded",
    "What to do when a ceiling > 0 is exceeded.", ["abort", "warn", "escalate"], { default: "warn" }),
  "budget.auto_invoke_budget_usd": numberSetting("budget.auto_invoke_budget_usd",
    "USD ceiling for the automatic invocation of a validated capability; 0 = no ceiling.", { default: 0, type: nonNegative, expects: "number >= 0 (USD)" }),
  "baselines.squad_capability_usd": numberSetting("baselines.squad_capability_usd",
    "Estimated cost of a squad capability with no estimate of its own.", { default: 0.3, type: nonNegative, expects: "number >= 0 (USD)" }),
  "baselines.business_usd": numberSetting("baselines.business_usd",
    "Estimated cost of a business with no estimate of its own.", { default: 0.8, type: nonNegative, expects: "number >= 0 (USD)" }),
  "baselines.per_handoff_usd": numberSetting("baselines.per_handoff_usd",
    "Estimated cost per handoff.", { default: 0.05, type: nonNegative, expects: "number >= 0 (USD)" }),

  // Three values, and the old two keep their meaning: `true` judges every gateable
  // file, `false` keeps the offline heuristics only. `reports` (the default)
  // judges the text deliverables (.md, .txt, .html), the reports and research
  // whose content the heuristics cannot check against the brief, and leaves
  // code, images and data files to their heuristic rubrics.
  "quality_gate.judge_enabled": {
    key: "quality_gate.judge_enabled", kind: "enum",
    // A YAML `true`/`false` written before this key had three values is still
    // valid and reads as the matching word, so every value has one spelling.
    // `off` is accepted as a spelling of `false`, the way the judge is turned off.
    type: z.union([z.boolean(), z.enum(["reports", "true", "false", "off"])])
      .transform((v) => (v === true ? "true" : v === false || v === "off" ? "false" : v)) as unknown as z.ZodType<"reports" | "true" | "false">,
    default: "reports", options: ["reports", "true", "false"], scopes: ["global", "project"],
    description: "Quality gate LLM judge, on the session's runtime: reports (default) = judges text deliverables (.md, .txt, .html) against the brief and leaves the rest to the heuristics; true = judges everything the gate covers; false = offline heuristics only. Secret-leak and file-validity checks run either way.",
    expects: "reports | true | false", env: "NIRVANA_JUDGE_ENABLED", secret: false,
    fromEnv: (raw) => {
      if (raw.trim().toLowerCase() === "reports") return "reports";
      const word = parseBooleanWord(raw);
      return word === null ? raw : word ? "true" : "false";
    },
    toEnv: (value) => value,
  } as SettingSpec<"reports" | "true" | "false">,
  "quality_gate.max_revisions": numberSetting("quality_gate.max_revisions",
    "Automatic corrections after a failed gate. A style finding left after them ships with _QA-RESERVATIONS.md; a serious one (secret leak, invalid file, material defect, unproven blocking criterion) gets up to 3 more rounds and is then withheld.", { default: 2, type: nonNegativeInt, expects: "integer >= 0" }),
  "quality_gate.escalate_after": numberSetting("quality_gate.escalate_after",
    "Revisions before escalating (reserved; today it follows max_revisions).", { default: 2, type: nonNegativeInt, expects: "integer >= 0" }),
  "quality_gate.rubric_fallback": stringSetting("quality_gate.rubric_fallback",
    "Rubric used when produces[] matches none.", { default: "prose_shortform", type: z.string().min(1), expects: "rubric name" }),
  "quality_gate.default_judge_model": stringSetting("quality_gate.default_judge_model",
    "Judge model; inherit = the model configured in the user's runtime.", { default: "inherit", type: z.string().min(1), expects: "model id or inherit" }),

  // The review of a solo delivery (solo-review.ts): one reviewer for the whole
  // delivery, never one per seat, decided by a rule rather than by an LLM.
  "review.policy": enumSetting("review.policy",
    "When a solo-mode delivery goes through review: always = always; rule = when the user asks, when the business manifest marks the delivery as sensitive or when the deterministic gate fails; on-request = only when the user asks or the gate fails; never = never.",
    ["always", "rule", "on-request", "never"], { default: "rule", env: "NIRVANA_REVIEW_POLICY" }),
  "review.runtime": enumSetting("review.runtime",
    "Reviewer runtime: same (default) = the runtime of the session; other = another installed runtime that no NOT_USE_* rule vetoes for this brief, falling back to the same one when there is none.",
    ["other", "same"], { default: "same", env: "NIRVANA_REVIEW_RUNTIME" }),
  "review.max_rounds": numberSetting("review.max_rounds",
    "Fix rounds after a failed review; once exhausted, the delivery ships with _QA-RESERVATIONS.md.",
    { default: 1, type: nonNegativeInt, env: "NIRVANA_REVIEW_MAX_ROUNDS", expects: "integer >= 0" }),

  // The admission gate's rollout switches. `verify.mode` is what the HOOKS
  // read (creation, install, activation, pack build); the explicit CLI
  // (`nrv validate`) is never governed by it — a user who asks for a verdict
  // gets the honest one. Defaults ship the gate in report-only so an existing
  // machine keeps installing what it already has.
  "verify.mode": enumSetting("verify.mode",
    "How the admission gate hooks treat a finding: report = only reports; warn = warns prominently; block = refuses a non-baselined error.",
    ["report", "warn", "block"], { default: "report", env: "NIRVANA_VERIFY_MODE" }),
  "verify.enforce_on_install": booleanSetting("verify.enforce_on_install",
    "Install refuses an entity with a non-baselined error (escape: --skip-validate).",
    { default: false, env: "NIRVANA_VERIFY_ENFORCE_ON_INSTALL" }),
  "verify.enforce_on_activate": booleanSetting("verify.enforce_on_activate",
    "`nrv activate` refuses a squad with a non-baselined error before installing dependencies (escape: --skip-verify).",
    { default: false, env: "NIRVANA_VERIFY_ENFORCE_ON_ACTIVATE" }),
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
