/**
 * locale-resolver.ts — resolves the active user locale for runtime decisions
 * (e.g. picking which mind-clone variant to load).
 *
 * Resolution order (first match wins):
 *   1. NIRVANA_LOCALE env var          (e.g. "en", "pt-BR", "es")
 *   2. project .nirvana/config.yaml    (locale: "...")
 *   3. system LANG / LC_ALL env vars   (POSIX standard, e.g. "en_US.UTF-8")
 *   4. default fallback                "pt-BR"
 *
 * Locale format: BCP-47 — a 2-letter language code, optionally followed by
 *   a hyphen and a 2-letter region (e.g. "en", "pt-BR", "es-MX").
 *   Underscores from POSIX (en_US) are normalized to hyphens.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_LOCALE = "pt-BR";
const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

let _cache: { locale: string; ts: number } | null = null;
const CACHE_TTL_MS = 30_000;

function normalize(raw: string): string | null {
  if (!raw) return null;
  // Strip charset: "en_US.UTF-8" → "en_US"
  const head = raw.split(".")[0];
  // Underscore → hyphen, normalize region
  const parts = head.replace("_", "-").split("-");
  if (parts.length === 0) return null;
  const lang = parts[0]?.toLowerCase();
  if (!lang || !/^[a-z]{2}$/.test(lang)) return null;
  if (parts.length === 1) return lang;
  const region = parts[1]?.toUpperCase();
  if (region && /^[A-Z]{2}$/.test(region)) return `${lang}-${region}`;
  return lang;
}

function readProjectLocale(): string | null {
  let cwd = process.cwd();
  while (cwd !== "/" && cwd !== ".") {
    const config = path.join(cwd, ".nirvana", "config.yaml");
    if (fs.existsSync(config)) {
      try {
        const raw = fs.readFileSync(config, "utf8");
        const m = raw.match(/^\s*locale\s*:\s*["']?([a-zA-Z_-]+)["']?\s*$/m);
        if (m) return normalize(m[1]);
      } catch {}
      return null;
    }
    const parent = path.dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  return null;
}

export function resolveLocale(): string {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache.locale;

  const candidates = [
    process.env.NIRVANA_LOCALE,
    readProjectLocale(),
    process.env.LC_ALL,
    process.env.LANG,
  ].filter(Boolean) as string[];

  for (const raw of candidates) {
    const norm = normalize(raw);
    if (norm && LOCALE_RE.test(norm)) {
      _cache = { locale: norm, ts: Date.now() };
      return norm;
    }
  }
  _cache = { locale: DEFAULT_LOCALE, ts: Date.now() };
  return DEFAULT_LOCALE;
}

/** Language portion only ("en-US" → "en"). Useful for file-suffix matches. */
export function resolveLanguage(): string {
  return resolveLocale().split("-")[0];
}

/** True when the active locale is anything other than the default Portuguese. */
export function isNonDefault(): boolean {
  return resolveLanguage() !== "pt";
}

/** Reset cache (test-only). */
export function _resetCache() {
  _cache = null;
}
