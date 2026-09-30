/**
 * profiles.ts — the three performance profiles an install can pick.
 *
 * A profile is a bundle of defaults, resolved as its own layer between the
 * user's files and the engine defaults (settings.ts):
 *
 *   env > project > global > PROFILE > engine default > schema default
 *
 * So choosing `economy` moves many switches at once, and any key the user
 * sets explicitly (project, global or env) still wins over the profile.
 *
 * What a profile never sets: the model. `execution.model` reaches every
 * runtime's `--model` unchanged (only codex filters non-OpenAI ids), so one id
 * cannot be right for claude, codex and gemini at once. Each runtime keeps the
 * model its own configuration names; a profile tunes what is runtime-neutral:
 * effort, the context ceiling of a worker, the review policy, routing and the
 * judge.
 */

import type { SettingValue } from "./settings-schema.ts";

export const PROFILE_NAMES = ["max", "balanced", "economy"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export function isProfileName(value: unknown): value is ProfileName {
  return typeof value === "string" && (PROFILE_NAMES as ReadonlyArray<string>).includes(value);
}

/** The defaults each profile brings. Every key must exist in the schema and
 *  every value must validate against it (settings-profiles.test.ts). */
export const PROFILE_PRESETS: Record<ProfileName, Readonly<Record<string, SettingValue>>> = {
  // Highest quality, highest token use: the deepest effort, no context ceiling,
  // every delivery reviewed by another runtime, two correction rounds.
  max: {
    "execution.business_mode": "solo",
    "execution.effort": "xhigh",
    "execution.context_window": 0,
    "review.policy": "always",
    "review.runtime": "other",
    "review.max_rounds": 2,
    "routing.mode": "agentic",
    "quality_gate.judge_enabled": "reports",
  },
  // The recommended default: one agent per business, a 400k ceiling, review
  // when a rule asks for it, the deterministic gate instead of a per-report judge.
  balanced: {
    "execution.business_mode": "solo",
    "execution.effort": "high",
    "execution.context_window": 400000,
    "review.policy": "rule",
    "review.runtime": "other",
    "review.max_rounds": 1,
    "routing.mode": "cards",
    "quality_gate.judge_enabled": "false",
  },
  // Lowest token use: a 200k ceiling, medium effort, review only when the user
  // asks or the gate fails, reviewed on the same runtime.
  economy: {
    "execution.business_mode": "solo",
    "execution.effort": "medium",
    "execution.context_window": 200000,
    "review.policy": "on-request",
    "review.runtime": "same",
    "review.max_rounds": 1,
    "routing.mode": "cards",
    "quality_gate.judge_enabled": "false",
    "gauntlet.default_intensity": "light",
  },
};

/** The value a profile sets for `key`, or undefined when it leaves the key alone. */
export function profileValue(profile: string, key: string): SettingValue | undefined {
  if (!isProfileName(profile)) return undefined;
  const preset = PROFILE_PRESETS[profile];
  return Object.prototype.hasOwnProperty.call(preset, key) ? preset[key] : undefined;
}
