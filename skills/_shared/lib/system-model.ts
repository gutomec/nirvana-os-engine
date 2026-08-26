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

// Resolves the system model, ALWAYS as an alias when it is a Claude family.
// Priority:
//   1. the `execution.model` setting — env NIRVANA_MODEL, else the project or
//      global config (_shared/lib/settings.ts): the explicit pin for Nirvana spawns
//   2. ANTHROPIC_MODEL — standard env some setups use
//   3. ~/.claude/settings.json "model" — the model the user set via /model
// settings.json belongs to Claude Code; only valid for claude-code children.
// Returns null when nothing resolves (the CLI decides — behavior unchanged).
export function resolveSystemModel(runtime?: string): string | null {
  const fromEnv = sanitizeModelId(resolveSetting("execution.model").value) || sanitizeModelId(process.env.ANTHROPIC_MODEL);
  if (fromEnv) return toAlias(fromEnv);
  if (runtime && runtime !== "claude-code") return null;
  try {
    const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const j = JSON.parse(fs.readFileSync(path.join(cfg, "settings.json"), "utf8"));
    const m = sanitizeModelId(j.model);
    if (m) return toAlias(m);
  } catch { /* no settings / unreadable — no system model */ }
  return null;
}
