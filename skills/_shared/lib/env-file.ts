/**
 * env-file.ts — Parse, mutate and serialize dotenv files preserving comments,
 * blank lines and ordering. Designed for round-trip safety: if you parse and
 * immediately serialize, the result is byte-identical to the input.
 *
 * Supports:
 *   - KEY=value          → unquoted (whitespace-trimmed)
 *   - KEY="value"        → double-quoted (preserves literal whitespace)
 *   - KEY='value'        → single-quoted (preserves literal whitespace, no escapes)
 *   - # comment          → preserved
 *   - blank line         → preserved
 *   - export KEY=value   → preserved (export prefix retained)
 *
 * Does NOT support: multi-line values, variable expansion, escape sequences
 * inside double-quoted strings beyond \n / \t (handled by the env loader, not here).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type EnvEntry =
  | { kind: "var"; key: string; value: string; quote: "" | '"' | "'"; export: boolean; raw: string }
  | { kind: "comment"; raw: string }
  | { kind: "blank"; raw: string };

const VAR_RE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

export function parseEnv(text: string): EnvEntry[] {
  const lines = text.split(/\r?\n/);
  const trailing = text.endsWith("\n");
  const trimmedLines = trailing ? lines.slice(0, -1) : lines;

  const entries: EnvEntry[] = [];
  for (const raw of trimmedLines) {
    if (/^\s*$/.test(raw)) {
      entries.push({ kind: "blank", raw });
      continue;
    }
    if (/^\s*#/.test(raw)) {
      entries.push({ kind: "comment", raw });
      continue;
    }
    const m = raw.match(VAR_RE);
    if (!m) {
      entries.push({ kind: "comment", raw });
      continue;
    }
    const [, , exp, key, rawValue] = m;
    let value = rawValue;
    let quote: "" | '"' | "'" = "";
    if (value.length >= 2) {
      if (value.startsWith('"') && value.endsWith('"')) {
        quote = '"';
        value = value.slice(1, -1);
      } else if (value.startsWith("'") && value.endsWith("'")) {
        quote = "'";
        value = value.slice(1, -1);
      }
    }
    entries.push({
      kind: "var",
      key,
      value,
      quote,
      export: !!exp,
      raw,
    });
  }
  return entries;
}

export function serializeEnv(entries: EnvEntry[]): string {
  const out: string[] = [];
  for (const e of entries) {
    if (e.kind === "blank" || e.kind === "comment") {
      out.push(e.raw);
    } else {
      out.push(formatVarLine(e));
    }
  }
  return out.join("\n") + "\n";
}

function formatVarLine(e: Extract<EnvEntry, { kind: "var" }>): string {
  const prefix = e.export ? "export " : "";
  const needsQuotes = e.quote || /[\s#"']/.test(e.value);
  if (!needsQuotes) return `${prefix}${e.key}=${e.value}`;
  const q = e.quote || '"';
  const escaped = q === '"' ? e.value.replace(/"/g, '\\"') : e.value.replace(/'/g, "\\'");
  return `${prefix}${e.key}=${q}${escaped}${q}`;
}

export function getVar(entries: EnvEntry[], key: string): string | undefined {
  for (const e of entries) if (e.kind === "var" && e.key === key) return e.value;
  return undefined;
}

export function setVar(entries: EnvEntry[], key: string, value: string): EnvEntry[] {
  const idx = entries.findIndex(e => e.kind === "var" && e.key === key);
  if (idx >= 0) {
    const cur = entries[idx] as Extract<EnvEntry, { kind: "var" }>;
    entries[idx] = { ...cur, value, raw: formatVarLine({ ...cur, value }) };
    return entries;
  }
  entries.push({
    kind: "var",
    key,
    value,
    quote: /\s/.test(value) ? '"' : "",
    export: false,
    raw: "",
  });
  return entries;
}

export function deleteVar(entries: EnvEntry[], key: string): EnvEntry[] {
  return entries.filter(e => !(e.kind === "var" && e.key === key));
}

export function readEnvFile(filePath: string): EnvEntry[] {
  if (!fs.existsSync(filePath)) return [];
  return parseEnv(fs.readFileSync(filePath, "utf8"));
}

export interface WriteOptions {
  backup?: boolean;
}

export function writeEnvFile(filePath: string, entries: EnvEntry[], opts: WriteOptions = {}): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (opts.backup !== false && fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, filePath + ".bak");
  }
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, serializeEnv(entries), "utf8");
  fs.renameSync(tmp, filePath);
}

export function toMap(entries: EnvEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) if (e.kind === "var") out[e.key] = e.value;
  return out;
}
