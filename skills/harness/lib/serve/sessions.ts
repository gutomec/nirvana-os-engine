// sessions.ts — a session IS a project directory (HP7: isolation by
// construction). Creating one runs the same init-project.ts the CLI uses,
// so every session carries the agent contract and the .nirvana scaffold.

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { serveDir } from "./auth.ts";

export interface SessionRecord {
  id: string;
  key_id: string;
  dir: string;
  created_at: string;
  expired?: boolean;
}

interface SessionsFile { sessions: SessionRecord[] }

export function sessionsRoot(): string {
  return process.env.NIRVANA_SERVE_SESSIONS_ROOT || path.join(serveDir(), "sessions");
}
const regPath = () => path.join(serveDir(), "sessions.json");

function load(): SessionsFile {
  try { return JSON.parse(fs.readFileSync(regPath(), "utf8")); }
  catch { return { sessions: [] }; }
}
function save(f: SessionsFile): void {
  fs.mkdirSync(serveDir(), { recursive: true });
  fs.writeFileSync(regPath(), JSON.stringify(f, null, 2), { mode: 0o600 });
}

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(process.env.HOME || "", ".nirvana", "skills"))
    ? path.join(process.env.HOME || "", ".nirvana", "skills")
    : path.resolve(import.meta.dir, "..", "..", ".."));

export function createSession(keyId: string): SessionRecord {
  const id = "ses_" + randomBytes(8).toString("hex");
  const dir = path.join(sessionsRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  // Same init the CLI runs — contract files + .nirvana scaffold. Failure is
  // non-fatal: a session without the contract still dispatches (the API
  // invokes the scripted cascade directly), but we record the warning.
  const init = path.join(SKILLS_ROOT, "_shared", "scripts", "init-project.ts");
  if (fs.existsSync(init)) {
    spawnSync(process.env.NIRVANA_SERVE_BUN || "bun", [init, dir, "--scope=project"], {
      stdio: "ignore", timeout: 60_000, env: { ...process.env },
    });
  }
  const rec: SessionRecord = { id, key_id: keyId, dir, created_at: new Date().toISOString() };
  const f = load();
  f.sessions.push(rec);
  save(f);
  return rec;
}

export function getSession(id: string, keyId?: string): SessionRecord | null {
  const s = load().sessions.find((x) => x.id === id && !x.expired) || null;
  if (!s) return null;
  if (keyId && s.key_id !== keyId) return null; // a key only sees its own sessions
  return s;
}

export function listSessions(keyId: string): SessionRecord[] {
  return load().sessions.filter((x) => x.key_id === keyId && !x.expired);
}

export function expireSession(id: string, keyId: string): boolean {
  const f = load();
  const s = f.sessions.find((x) => x.id === id && x.key_id === keyId && !x.expired);
  if (!s) return false;
  s.expired = true;
  save(f);
  return true;
}
