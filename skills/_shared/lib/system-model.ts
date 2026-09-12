// system-model.ts — the model a dispatch passes to a child, which is NOTHING
// unless the user pinned one.
//
// Owner doctrine (2026-09-12): "Nenhum modelo ou effort deve ser especificado
// por padrão. O padrão é sempre o que está por padrão no sistema do usuário."
// Dispatching codex means running `codex` with no `--model` and no effort, so
// codex uses what the user configured in their own codex. Dispatching claude
// means running `claude` bare, so it uses what the user configured in their own
// claude. Only when the user names a model or an effort does the dispatch carry
// one.
//
// This file used to do the opposite, for a reason that made sense at the time:
// Claude Code's `/model` is session-local, a child `claude -p` does not inherit
// it, and the judge was falling to the CLI default. The fix was to read the
// user's model from wherever it could be found and pass `--model`. Two things
// were wrong with it.
//
// It guessed from a VENDOR env var. `ANTHROPIC_MODEL` is set on many machines
// and has nothing to do with Nirvana, and the lookup below it ignored the
// runtime. Measured: with `ANTHROPIC_MODEL=claude-opus-5` exported, the
// resolver answered `opus` for all nine runtimes, so the driver ran
// `gemini --model opus`, `agy --model opus`, `pi --model opus`,
// `qwen --model opus` — model ids those vendors do not have. Only the codex
// adapter guarded itself (`isOpenAiModelId`), and the Orca worker path did not
// even do that.
//
// And it read `~/.claude/settings.json`. That file is Claude Code's OWN config:
// a `claude` child reads it without being told. Passing it back as `--model`
// added nothing and made the engine the author of a decision that was never
// its to make.
//
// What is left is the explicit pin and only that: `execution.model`
// (`NIRVANA_MODEL`, or the project/global config). Empty is the default, and
// empty means the child decides.
import { resolveSetting } from "./settings.ts";

// Sanitizes a model id: strips real ANSI escapes AND ANSI fragments that leak
// into a saved value (Claude Code's `/model` can record the label in bold and
// leave "[1m]" glued to the id, e.g. "claude-fable-5[1m]" — an invalid id that
// makes the CLI fall back to the default). Returns the clean id or "" if
// nothing remains.
export function sanitizeModelId(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw);
  s = s.replace(/\x1b\[[0-9;]*m/g, "");     // real ANSI (ESC [ ... m)
  s = s.replace(/\[[0-9;]*m\]?/g, "");      // leaked fragment "[1m]" / "[22m"
  s = s.replace(/[^\x20-\x7e]/g, "").trim(); // drop non-printables
  const m = s.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/); // first valid id token
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

/**
 * The model the USER PINNED for Nirvana's spawns, or null.
 *
 * null is the normal answer and means "pass no model": the child CLI uses
 * whatever its own configuration says, which is the user's default. A pin is
 * `execution.model` / `NIRVANA_MODEL` — something the user set ON PURPOSE for
 * this engine, which is why it applies to every runtime they dispatch to.
 *
 * The `runtime` parameter is kept for callers and for symmetry with
 * `resolvePinnedEffort`; the pin is runtime-independent by design, because a
 * user who writes `NIRVANA_MODEL=gpt-5.3-codex` and then dispatches gemini has
 * made a mistake the engine should surface, not silently rewrite.
 */
export function resolveSystemModel(_runtime?: string): string | null {
  const pinned = sanitizeModelId(resolveSetting("execution.model").value);
  return pinned ? toAlias(pinned) : null;
}

/** The effort level the USER PINNED, or null — same contract as the model.
 *  `low | medium | high | xhigh | max`, the levels `claude --effort` accepts
 *  and the range `model_reasoning_effort` takes in codex's own config. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as ReadonlyArray<string>).includes(value);
}

export function resolvePinnedEffort(): EffortLevel | null {
  const raw = String(resolveSetting("execution.effort").value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (!isEffortLevel(raw)) {
    console.error(`[effort] execution.effort='${raw}' is not one of ${EFFORT_LEVELS.join(" | ")} — passing no effort.`);
    return null;
  }
  return raw;
}
