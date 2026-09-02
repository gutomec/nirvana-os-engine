// system-model.ts — resolves the SYSTEM MODEL (what the user's session is
// running) to propagate to the subprocesses Nirvana-OS spawns.
//
// Problem it solves: Claude Code's `/model` is local to the interactive
// session and is NOT inherited by a child `claude -p` — no env var exposes the
// model, and the harness drivers spawn `claude -p` without `--model`. Result:
// the child falls back to the CLI default (commonly sonnet), even when the
// user is on fable/opus. Here we resolve the intended model and the driver
// passes it via `--model`, so "no model requested in the brief → use the
// system model".
//
// Does not force a model when nothing resolves (keeps the model-agnostic behavior).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSetting } from "./settings.ts";

// Sanitizes a model id: strips real ANSI escapes AND ANSI fragments that leak
// into the saved value (Claude Code's `/model` can record the label in bold
// and leave "[1m]" glued to the id, e.g. "claude-fable-5[1m]" — an invalid id
// that makes the CLI fall back to the default). Returns the clean id or "" if
// nothing remains.
export function sanitizeModelId(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw);
  s = s.replace(/\x1b\[[0-9;]*m/g, "");     // real ANSI (ESC [ ... m)
  s = s.replace(/\[[0-9;]*m\]?/g, "");      // leaked fragment "[1m]" / "[22m"
  s = s.replace(/[^\x20-\x7e]/g, "").trim(); // drop non-printables
  const m = s.match(/^[A-Za-z0-9][A-Za-z0-9._:/-]*/); // provider/id and runtime suffixes are valid tokens
  return m ? m[0] : "";
}

// Normalizes a model id to the ALIAS (opus/sonnet/haiku/fable) when it is a
// known Claude family — version-proof unlike the full id. Non-Claude models
// (gpt-*, gemini-*, custom) pass through untouched. We prefer the alias because
// it survives version bumps and is what `--model` and settings.json accept.
const CLAUDE_ALIASES = ["opus", "sonnet", "haiku", "fable"] as const;
export function toAlias(model: string): string {
  if (!model) return model;
  const m = model.toLowerCase();
  if ((CLAUDE_ALIASES as ReadonlyArray<string>).includes(m)) return m;
  const fam = m.match(/^claude-(opus|sonnet|haiku|fable)\b/);
  return fam ? fam[1] : model;
}

type ModelFamilyRule = {
  family: string;
  pattern: RegExp;
  runtimes: ReadonlySet<string>;
};

// Recognize native model families, not a catalog of available model versions.
// Unknown ids and configured custom providers remain owned by the child CLI.
const MODEL_FAMILY_RULES: readonly ModelFamilyRule[] = [
  { family: "anthropic", pattern: /^(?:claude-|opus(?:-|$)|sonnet(?:-|$)|haiku(?:-|$)|fable(?:-|$))/i, runtimes: new Set(["claude-code"]) },
  { family: "openai", pattern: /^(?:gpt-|codex(?:-|$)|o[1-9](?:-|$))/i, runtimes: new Set(["codex"]) },
  { family: "google", pattern: /^gemini(?:-|$)/i, runtimes: new Set(["gemini-cli", "antigravity-cli"]) },
  { family: "xai", pattern: /^grok(?:-|$)/i, runtimes: new Set(["grok-cli"]) },
  { family: "moonshot", pattern: /^(?:kimi(?:-|$)|moonshot(?:-|$)|k[23](?:[.-]|$))/i, runtimes: new Set(["kimi-cli"]) },
  { family: "zhipu", pattern: /^(?:glm(?:-|$)|codegeex(?:-|$))/i, runtimes: new Set<string>() },
  { family: "alibaba", pattern: /^qwen(?:-|$)/i, runtimes: new Set(["qwen-code"]) },
];

const MULTI_PROVIDER_RUNTIMES = new Set(["pi", "opencode", "kimi-cli", "qwen-code"]);

// Codex can select an OpenAI-compatible provider in its own config without a
// cascade @provider hint. Read only selection metadata; never copy credentials.
function codexProvider(): string | undefined {
  try {
    const configPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
    // Bun's native TOML loader predates Bun.TOML; do not cache user settings.
    delete require.cache[require.resolve(configPath)];
    const config = require(configPath) as {
      model_provider?: string; profile?: string; profiles?: Record<string, { model_provider?: string }>;
    };
    return (config.profile && config.profiles?.[config.profile]?.model_provider) || config.model_provider;
  } catch { return undefined; }
}

function claudeHasCustomEndpoint(): boolean {
  try {
    let endpoint = process.env.ANTHROPIC_BASE_URL;
    if (!endpoint) {
      const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
      endpoint = JSON.parse(fs.readFileSync(path.join(configDir, "settings.json"), "utf8")).env?.ANTHROPIC_BASE_URL;
    }
    return !!endpoint && new URL(endpoint).hostname !== "api.anthropic.com";
  } catch { return false; }
}

export interface RuntimeModelSelection {
  runtime: string | null;
  requestedModel: string | null;
  effectiveModel: string | null;
  source: "explicit" | "setting" | "anthropic-env" | "claude-settings" | "runtime-default";
  effectiveSource: RuntimeModelSelection["source"];
  /** Whether the requested model itself fits the runtime, before fallback. */
  compatible: boolean;
  fallback: boolean;
  reason: "compatible" | "runtime_default" | "incompatible_model_family" | "incompatible_model_format";
  family: string | null;
  warning: string | null;
}

export function selectRuntimeModel(
  runtime: string | undefined,
  requestedModel: string | null | undefined,
  source: RuntimeModelSelection["source"] = "explicit",
  providerHint?: string,
): RuntimeModelSelection {
  const requested = sanitizeModelId(requestedModel);
  const normalized = source !== "explicit" && (!runtime || runtime === "claude-code") ? toAlias(requested) : requested;
  const modelName = normalized.split("/").at(-1)!;
  const rule = MODEL_FAMILY_RULES.find(candidate => candidate.pattern.test(modelName));
  const customCodexProvider = runtime === "codex" && !!providerHint && !["openai", "azure"].includes(providerHint.toLowerCase());
  const compatible = !runtime || !rule || MULTI_PROVIDER_RUNTIMES.has(runtime)
    || customCodexProvider || (runtime === "claude-code" && claudeHasCustomEndpoint()) || rule.runtimes.has(runtime);
  if (!normalized) {
    return { runtime: runtime ?? null, requestedModel: null, effectiveModel: null, source: "runtime-default", effectiveSource: "runtime-default",
      compatible: true, fallback: false, reason: "runtime_default", family: null, warning: null };
  }
  if (runtime === "opencode" && !/^[^/]+\/.+/.test(normalized)) {
    return { runtime, requestedModel: requested, effectiveModel: null, source, effectiveSource: "runtime-default",
      compatible: false, fallback: true, reason: "incompatible_model_format", family: rule?.family ?? null,
      // i18n-user-facing: OpenCode requires a provider-qualified id, never guess a provider.
      warning: `Modelo '${requested}' sem formato provider/model exigido pelo OpenCode; usando o modelo padrão do runtime.` };
  }
  if (compatible) {
    return { runtime: runtime ?? null, requestedModel: requested, effectiveModel: normalized, source, effectiveSource: source,
      compatible: true, fallback: false, reason: "compatible", family: rule?.family ?? null, warning: null };
  }
  // i18n-user-facing: model compatibility warnings use the default PT-BR locale.
  const warning = `Modelo '${requested}' da família ${rule!.family} incompatível com o runtime '${runtime}'; usando o modelo padrão do runtime.`;
  return { runtime: runtime ?? null, requestedModel: requested, effectiveModel: null, source, effectiveSource: "runtime-default",
    compatible: false, fallback: true, reason: "incompatible_model_family", family: rule!.family, warning };
}

// Resolves the system model. Inherited Claude settings retain their historical
// alias normalization; explicit ids and other runtimes keep their full ids.
// Priority:
//   1. the `execution.model` setting — env NIRVANA_MODEL, else the project or
//      global config (_shared/lib/settings.ts): the explicit pin for Nirvana spawns
//   2. ANTHROPIC_MODEL — only for Claude Code
//   3. ~/.claude/settings.json "model" — the model the user set via /model
// settings.json belongs to Claude Code; only valid for claude-code children.
// Incompatible pins fall back to the active runtime's configured/default model.
// A null effective model means the CLI decides, never a prescribed engine model.
export function resolveSystemModelSelection(runtime?: string, explicitModel?: string | null, providerHint?: string): RuntimeModelSelection {
  if (runtime === "codex" && !providerHint) providerHint = codexProvider();
  if (explicitModel !== undefined) {
    const selection = selectRuntimeModel(runtime, explicitModel, "explicit", providerHint);
    if (!selection.fallback) return selection;
    const configured = resolveSystemModelSelection(runtime, undefined, providerHint);
    if (configured.effectiveModel) {
      return { ...selection, effectiveModel: configured.effectiveModel, effectiveSource: configured.effectiveSource,
        // i18n-user-facing: explain the configured fallback without hiding the requested model.
        warning: `Modelo '${selection.requestedModel}' incompatível com o runtime '${runtime}'; usando o modelo configurado '${configured.effectiveModel}'.` };
    }
    return selection;
  }
  const configured = sanitizeModelId(resolveSetting("execution.model").value);
  if (configured) return selectRuntimeModel(runtime, configured, "setting", providerHint);
  if (runtime && runtime !== "claude-code") return selectRuntimeModel(runtime, null, "runtime-default");
  const anthropicModel = sanitizeModelId(process.env.ANTHROPIC_MODEL);
  if (anthropicModel) return selectRuntimeModel(runtime, anthropicModel, "anthropic-env");
  try {
    const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const j = JSON.parse(fs.readFileSync(path.join(cfg, "settings.json"), "utf8"));
    const m = sanitizeModelId(j.model);
    if (m) return selectRuntimeModel(runtime, m, "claude-settings");
  } catch { /* no settings / unreadable — no system model */ }
  return selectRuntimeModel(runtime, null, "runtime-default");
}

export function resolveSystemModel(runtime?: string): string | null {
  return resolveSystemModelSelection(runtime).effectiveModel;
}
