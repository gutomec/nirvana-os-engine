// cascade.ts — reads LLM_CASCADE from .env and resolves which runtime to try next.
//
// .env format (simple):
//   LLM_CASCADE=claude-code,codex,antigravity-cli,gemini-cli,ollama
//
// .env format (advanced, with model hints):
//   LLM_CASCADE=claude-code:claude-opus-4-7,codex:gpt-5.3-codex,antigravity-cli:gemini-3-pro,antigravity-cli:gemini-3-flash
//
// Note: gemini-cli sunsets for consumer tier on 2026-06-18. New configs should
// prefer antigravity-cli (binary `agy`). Both runtimes are accepted during the
// transition window. See (base de conhecimento interna)
//
// .env format (full, with provider hint for CLIs that support multi-provider —
// codex / qwen-code via the @provider suffix):
//   LLM_CASCADE=claude-code:claude-opus-4-7,codex:gpt-5.5,codex:qwen-3-coder@openrouter,antigravity-cli:gemini-3-flash
//
// .env format (with USD soft-budget per entry — switches to NEXT entry when
// accumulated spend on THIS project hits the threshold):
//   LLM_CASCADE=codex:gpt-5.5$10,codex:qwen3-coder@openrouter$5,gemini-cli:gemini-3-flash
//   (gpt-5.5 used until $10 spent on this project, then qwen3 until $5, then
//   gemini-flash uncapped)
//
// Each ENTRY has its own cooldown bucket — different entries of the same
// runtime (e.g. two codex entries with different models/providers) are
// independent for budget purposes. A subscription-cap event still grounds
// the whole RUNTIME (codex via subscription hitting weekly cap puts all
// codex entries in cooldown until reset), because subscription limits are
// per-account, not per-model. Budget exhaustion is the per-entry mechanism.
//
// Order = priority. The first entry the project cooldown registry says is
// FREE wins. If everything is in cooldown, returns null (caller decides what
// to do — by default the harness falls through to its currently-configured
// runtime and lets it fail naturally).

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Runtime } from "./host-agent-driver.ts";
import { isInCooldown, getCooldown } from "./cooldown-registry.ts";
import { getSpend } from "./spend-tracker.ts";

export interface CascadeEntry {
  runtime: Runtime;
  model: string | null;
  /** Provider id for CLIs that support multi-provider config (codex, qwen-code).
   * Parsed from the @provider suffix in the cascade string. */
  providerHint: string | null;
  /** Soft USD budget for this entry on this project. When accumulated spend
   * (tracked in cascade-spend.json) reaches this, the entry is marked
   * "budget_exhausted" and the cascade falls through to the next entry.
   * Null = no budget cap. Parsed from the $N suffix. */
  budgetUsd: number | null;
}

const VALID_RUNTIMES: ReadonlyArray<Runtime> = ["claude-code", "codex", "gemini-cli", "antigravity-cli"];

function parseCascadeString(s: string): CascadeEntry[] {
  return s.split(",").map(tok => tok.trim()).filter(Boolean).map(tok => {
    // Format: runtime[:model[@provider]][$N]
    // The $N (USD budget) attaches to the LAST segment — peel it off first.
    let budgetUsd: number | null = null;
    const bm = tok.match(/\$(\d+(?:\.\d+)?)$/);
    if (bm) { budgetUsd = parseFloat(bm[1]); tok = tok.slice(0, -bm[0].length); }
    const [runtimeAndModel, providerHint = null] = tok.split("@").map(s => s.trim());
    const [runtime, model = null] = runtimeAndModel.split(":").map(s => s.trim());
    return {
      runtime: runtime as Runtime,
      model: model || null,
      providerHint: providerHint || null,
      budgetUsd,
    };
  }).filter(e => (VALID_RUNTIMES as ReadonlyArray<string>).includes(e.runtime));
}

/** Stable string key identifying a unique entry — used by the spend tracker. */
export function entryKey(e: CascadeEntry): string {
  return `${e.runtime}${e.model ? ":" + e.model : ""}${e.providerHint ? "@" + e.providerHint : ""}`;
}

export function readEnvFile(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Resolve the true project root for the cascade subsystem. Two-pass walk-up
 * to avoid confusing a nested .nirvana/ (the harness creates them inside
 * .nirvana/outputs/<id>/ for per-run logs/state) with the actual root.
 *  Pass 1: prefer .env or .git (distinctive root markers).
 *  Pass 2: fall back to .nirvana/ if pass 1 found nothing.
 *  Returns the original start if nothing matches. */
export function resolveCascadeRoot(start: string): string {
  const home = os.homedir();
  const startAbs = path.resolve(start);
  const fsRoot = path.parse(startAbs).root;
  const walk = (markers: string[]): string | null => {
    let dir = startAbs;
    while (dir !== fsRoot && dir !== home) {
      for (const m of markers) if (fs.existsSync(path.join(dir, m))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  };
  return walk([".env", ".git"]) ?? walk([".nirvana"]) ?? startAbs;
}

/** Read LLM_CASCADE from disk. CRITICAL: we deliberately ignore
 *  process.env.LLM_CASCADE when reading the project .env, because Bun
 *  auto-loads .env and runs shell-style $VAR expansion on the value —
 *  so "claude-code:opus$2,codex:gpt-5.5$1" gets EATEN to
 *  "claude-code:opus,codex:gpt-5.5" (the $2/$1 are shell positional params
 *  that don't exist → expanded to empty). The literal file value is the
 *  source of truth.
 *
 *  Resolution order:
 *  1. <projectRoot>/.env (the user's literal file)
 *  2. Walk up from projectRoot using 2-pass logic (preferring .env/.git
 *     over .nirvana) to escape nested .nirvana traps in dispatch paths.
 *  3. ~/.claude/.env (user-global default)
 *  4. process.env.LLM_CASCADE as last resort — only when no .env file
 *     declared it (so an explicit shell `export LLM_CASCADE="..."` still
 *     works for users who know to escape their $).
 *  Returns ordered list. Empty if not configured. */
export function loadCascade(projectRoot: string | null): CascadeEntry[] {
  const envFiles: string[] = [];
  if (projectRoot) {
    envFiles.push(path.join(projectRoot, ".env"));
    const resolved = resolveCascadeRoot(projectRoot);
    const resolvedEnv = path.join(resolved, ".env");
    if (!envFiles.includes(resolvedEnv)) envFiles.push(resolvedEnv);
  }
  envFiles.push(path.join(os.homedir(), ".claude", ".env"));

  for (const f of envFiles) {
    const env = readEnvFile(f);
    if (env.LLM_CASCADE) return parseCascadeString(env.LLM_CASCADE);
  }
  if (process.env.LLM_CASCADE) return parseCascadeString(process.env.LLM_CASCADE);
  return [];
}

/** True iff this entry is currently usable: runtime not in subscription cooldown
 *  AND per-entry budget not exhausted. */
function entryIsAvailable(projectRoot: string, e: CascadeEntry): boolean {
  if (isInCooldown(projectRoot, e.runtime)) return false;
  if (e.budgetUsd != null && getSpend(projectRoot, entryKey(e)) >= e.budgetUsd) return false;
  return true;
}

/** Pick the first cascade entry that is usable (runtime OK + budget OK). */
export function nextAvailable(projectRoot: string, cascade: CascadeEntry[]): CascadeEntry | null {
  if (!cascade.length) return null;
  for (const e of cascade) if (entryIsAvailable(projectRoot, e)) return e;
  return null;
}

/** Given the current entry index (or runtime), pick the NEXT cascade entry
 * usable AND coming after. Falls back to nextAvailable if current isn't found. */
export function nextAfter(projectRoot: string, cascade: CascadeEntry[], current: Runtime, currentKey?: string): CascadeEntry | null {
  if (!cascade.length) return null;
  // Prefer exact-entry-key match (so budget-exhausted current can hand to a
  // same-runtime sibling like "codex:gpt-5.5" → "codex:qwen3@openrouter").
  let idx = -1;
  if (currentKey) idx = cascade.findIndex(e => entryKey(e) === currentKey);
  if (idx < 0) idx = cascade.findIndex(e => e.runtime === current);
  const tail = idx >= 0 ? cascade.slice(idx + 1) : cascade;
  for (const e of tail) if (entryIsAvailable(projectRoot, e)) return e;
  return null;
}

/** Human-readable explanation for logs. */
export function explain(projectRoot: string, cascade: CascadeEntry[]): string {
  if (!cascade.length) return "(no LLM_CASCADE configured)";
  return cascade.map(e => {
    const cd = getCooldown(projectRoot, e.runtime);
    const inCD = cd && new Date(cd.until_iso).getTime() > Date.now();
    const spent = getSpend(projectRoot, entryKey(e));
    const budgetExhausted = e.budgetUsd != null && spent >= e.budgetUsd;
    let status: string;
    if (inCD) status = `COOLDOWN until ${cd!.until_iso} (${cd!.reason})`;
    else if (budgetExhausted) status = `BUDGET EXHAUSTED (spent $${spent.toFixed(4)} of $${e.budgetUsd})`;
    else if (e.budgetUsd != null) status = `available (spent $${spent.toFixed(4)} of $${e.budgetUsd})`;
    else status = `available${spent > 0 ? ` (spent $${spent.toFixed(4)})` : ""}`;
    const label = `${e.runtime}${e.model ? ":" + e.model : ""}${e.providerHint ? "@" + e.providerHint : ""}${e.budgetUsd != null ? "$" + e.budgetUsd : ""}`;
    return `  - ${label} → ${status}`;
  }).join("\n");
}
