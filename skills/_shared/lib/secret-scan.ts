// secret-scan.ts — does this text carry a secret out of the machine?
//
// Two families of findings. `known`: the exact value of a secret this process
// can see (an environment variable whose name says credential, a line of a
// `.env` file it was told to protect) appears in the text; that is a leak with
// no ambiguity and the delivery is withheld. `pattern`: the text carries
// something shaped like a credential (a private-key block, a vendor token
// prefix, a dump of KEY=value lines) without a value we recognise; that is
// redacted and delivered with a reservation, because documentation and
// `.env.example` files look like this on purpose.
//
// Values are compared as strings the caller already holds; nothing here writes
// a secret to a log, and the findings name the VARIABLE, never the value.
import * as fs from "node:fs";

export const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASS(WORD|WD)?|CREDENTIAL|PRIVATE|SIGNING|AUTH)/i;
const MIN_VALUE_LEN = 8;
const PLACEHOLDER_RE = /^(x+|\*+|\.{3,}|change[-_ ]?me|your[-_].*|<[^>]*>|\$\{[^}]*\}|TODO|null|none|true|false|\d{1,4})$/i;

export type Finding =
  | { kind: "known"; name: string; severity: "block" }
  | { kind: "private-key" | "token" | "env-dump"; label: string; severity: "redact" };

/** Names in `env` that look like credentials and carry a real value. */
export function secretLikeEntries(env: Record<string, string | undefined>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(env)) {
    if (!v || v.length < MIN_VALUE_LEN) continue;
    if (!SECRET_NAME_RE.test(k)) continue;
    if (PLACEHOLDER_RE.test(v.trim())) continue;
    out.push([k, v]);
  }
  return out;
}

/** KEY=value pairs of a dotenv file, quotes stripped; missing file → []. */
export function dotenvEntries(file: string): Array<[string, string]> {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out: Array<[string, string]> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*export\s+/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    if (v.length >= MIN_VALUE_LEN && !PLACEHOLDER_RE.test(v)) out.push([m[1], v]);
  }
  return out;
}

/** The secrets a scan must recognise: credential-like variables of `env` plus
 *  every value of the dotenv files named. Names only travel in findings. */
export function knownSecrets(opts: { env?: Record<string, string | undefined>; dotenvFiles?: string[] } = {}): Array<[string, string]> {
  const seen = new Map<string, string>();
  for (const [k, v] of secretLikeEntries(opts.env ?? process.env)) seen.set(v, k);
  for (const f of opts.dotenvFiles ?? []) for (const [k, v] of dotenvEntries(f)) if (!seen.has(v)) seen.set(v, k);
  return [...seen].map(([v, k]) => [k, v]);
}

const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const TOKEN_RES: Array<[string, RegExp]> = [
  ["anthropic", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ["openai", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ["github", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ["slack", /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g],
  ["aws", /\bAKIA[0-9A-Z]{16}\b/g],
  ["google", /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ["nirvana", /\bnrv_[A-Za-z0-9_-]{20,}\b/g],
];
const ENV_LINE_RE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})=(["']?)([^\s"']{8,})\2\s*$/;

/** Findings for `text`; `known` are [name, value] pairs. */
export function scanText(text: string, known: Array<[string, string]>): Finding[] {
  const findings: Finding[] = [];
  for (const [name, value] of known) {
    if (text.includes(value)) findings.push({ kind: "known", name, severity: "block" });
  }
  if (PRIVATE_KEY_RE.test(text)) findings.push({ kind: "private-key", label: "private key block", severity: "redact" });
  PRIVATE_KEY_RE.lastIndex = 0;
  for (const [label, re] of TOKEN_RES) {
    if (re.test(text)) findings.push({ kind: "token", label, severity: "redact" });
    re.lastIndex = 0;
  }
  const envLines = text.split(/\r?\n/).filter((l) => { const m = ENV_LINE_RE.exec(l); return m && SECRET_NAME_RE.test(m[1]) && !PLACEHOLDER_RE.test(m[3]); });
  if (envLines.length >= 2) findings.push({ kind: "env-dump", label: `${envLines.length} credential-shaped KEY=value lines`, severity: "redact" });
  return findings;
}

/** `text` with every finding masked; known values by name, patterns by kind. */
export function redactText(text: string, known: Array<[string, string]>): { text: string; redactions: number } {
  let out = text;
  let n = 0;
  for (const [name, value] of known) {
    if (!out.includes(value)) continue;
    out = out.split(value).join(`[redacted:${name}]`);
    n++;
  }
  out = out.replace(PRIVATE_KEY_RE, () => { n++; return "[redacted:private-key]"; });
  for (const [label, re] of TOKEN_RES) out = out.replace(re, () => { n++; return `[redacted:${label}-token]`; });
  out = out.split(/\r?\n/).map((l) => {
    const m = ENV_LINE_RE.exec(l);
    if (m && SECRET_NAME_RE.test(m[1]) && !PLACEHOLDER_RE.test(m[3])) { n++; return l.replace(m[3], "[redacted]"); }
    return l;
  }).join("\n");
  return { text: out, redactions: n };
}

/** The dotenv files the engine's own configuration chain reads, plus the
 *  project's: the ones an agent working here could echo. */
export function defaultDotenvFiles(opts: { cwd?: string; projectRoot?: string | null; home?: string } = {}): string[] {
  const home = opts.home ?? (process.env.HOME || "");
  const files = new Set<string>();
  for (const d of [opts.projectRoot, opts.cwd]) if (d) { files.add(`${d}/.env`); files.add(`${d}/.env.local`); }
  if (home) for (const f of [`${home}/.nirvana/.env`, `${home}/.claude/.env`, `${home}/.env`]) files.add(f);
  return [...files];
}
