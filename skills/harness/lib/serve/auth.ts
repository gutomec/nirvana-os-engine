// auth.ts — API keys for nrv serve.
//
// Keys live in ~/.nirvana/serve/keys.json (chmod 600), one record per key:
// the KEY ITSELF is stored as a sha256 hash (a leaked keys file must not
// leak usable credentials), and budget/quota are ATTRIBUTES OF THE KEY —
// the client never sets its own ceiling (the affiliate lesson: the server
// computes, the client never defines money-shaped inputs).

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface ApiKeyRecord {
  id: string;
  /** sha256 hex of the bearer token. */
  hash: string;
  label: string;
  created_at: string;
  revoked?: boolean;
  /** Per-run budget cap in USD, forwarded as dispatch --max-budget. */
  budget_usd?: number;
  /** Runs allowed per UTC day (0/undefined = unlimited). */
  daily_runs?: number;
  /** Webhook registered for this key (terminal-state callback). */
  webhook?: { url: string; secret: string };
  /** Grants access to the Glance cockpit (`nrv glance --host`), separate from the job API this
   *  file otherwise governs — off by default, so a key minted for job submission does not
   *  silently also unlock the interactive cockpit (chat, settings, setup actions). */
  glance?: boolean;
}

interface KeysFile { keys: ApiKeyRecord[]; usage: Record<string, { day: string; runs: number }> }

export function serveDir(): string {
  return process.env.NIRVANA_SERVE_DIR || path.join(os.homedir(), ".nirvana", "serve");
}
const keysPath = () => path.join(serveDir(), "keys.json");

function load(): KeysFile {
  try { return JSON.parse(fs.readFileSync(keysPath(), "utf8")); }
  catch { return { keys: [], usage: {} }; }
}
function save(f: KeysFile): void {
  fs.mkdirSync(serveDir(), { recursive: true });
  fs.writeFileSync(keysPath(), JSON.stringify(f, null, 2), { mode: 0o600 });
  try { fs.chmodSync(keysPath(), 0o600); } catch { /* windows */ }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Generates a key, stores its hash, RETURNS THE TOKEN ONCE. */
export function keygen(opts: { label?: string; budgetUsd?: number; dailyRuns?: number; glance?: boolean } = {}): { token: string; record: ApiKeyRecord } {
  const token = "nrv_" + randomBytes(24).toString("base64url");
  const record: ApiKeyRecord = {
    id: "key_" + randomBytes(6).toString("hex"),
    hash: sha256(token),
    label: opts.label || "default",
    created_at: new Date().toISOString(),
    ...(opts.budgetUsd ? { budget_usd: opts.budgetUsd } : {}),
    ...(opts.dailyRuns ? { daily_runs: opts.dailyRuns } : {}),
    ...(opts.glance ? { glance: true } : {}),
  };
  const f = load();
  f.keys.push(record);
  save(f);
  return { token, record };
}

export function listKeys(): Omit<ApiKeyRecord, "hash">[] {
  return load().keys.map(({ hash: _h, ...rest }) => rest);
}

export function revokeKey(id: string): boolean {
  const f = load();
  const k = f.keys.find((x) => x.id === id);
  if (!k) return false;
  k.revoked = true;
  save(f);
  return true;
}

export function setWebhook(keyId: string, url: string, secret: string): boolean {
  const f = load();
  const k = f.keys.find((x) => x.id === keyId && !x.revoked);
  if (!k) return false;
  k.webhook = { url, secret };
  save(f);
  return true;
}

/** Bearer check: constant-time against every stored hash. */
export function authenticate(req: Request): ApiKeyRecord | null {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m) return null;
  const given = Buffer.from(sha256(m[1]), "hex");
  for (const k of load().keys) {
    if (k.revoked) continue;
    const stored = Buffer.from(k.hash, "hex");
    if (stored.length === given.length && timingSafeEqual(stored, given)) return k;
  }
  return null;
}

/** Daily-quota gate; increments on allow. */
export function consumeRun(keyId: string): { ok: boolean; used: number; limit: number | null } {
  const f = load();
  const k = f.keys.find((x) => x.id === keyId);
  const limit = k?.daily_runs ?? null;
  const day = new Date().toISOString().slice(0, 10);
  const u = f.usage[keyId]?.day === day ? f.usage[keyId] : { day, runs: 0 };
  if (limit && u.runs >= limit) return { ok: false, used: u.runs, limit };
  u.runs += 1;
  f.usage[keyId] = u;
  save(f);
  return { ok: true, used: u.runs, limit };
}
