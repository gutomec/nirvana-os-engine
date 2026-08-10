// session-store.ts — per-entity session reuse, within a project.
//
// PROBLEM: every dispatch opens a cold session. The same business called twice
// in the same project rebuilds from scratch what it already knew — and an agent
// restarting cold is not the same agent, it is a new one with the same prompt.
// Lost context is lost quality, and no budget brings back what the agent forgot.
//
// SCOPE: the key is (project, runtime, entity). All three matter:
//   - project  → the SAME business in another project starts cold, on purpose.
//                Same isolation as memory: what one project learned is usually
//                wrong for the next, and a shared session leaks bias without
//                leaving a trace.
//   - runtime  → a claude-code session id means nothing to codex. Reusing
//                across runtimes fails in the best case, and resumes the
//                wrong conversation in the worst.
//   - entity   → each employee/squad has its own line of reasoning.
//
// The file lives in the project directory (`sessions.json`), the only place
// BP5 allows writing to during a brief.
import * as fs from "node:fs";
import * as path from "node:path";

const FILE = "sessions.json";

export type EntityKind = "employee" | "squad" | "business";

interface Entry { session_id: string; runtime: string; updated_at: string; resumes: number }
type Store = Record<string, Entry>;

/** (runtime, kind, slug) → stable key. Runtime in the key is mandatory:
 *  session ids are not portable across CLIs. */
export function sessionKey(runtime: string, kind: EntityKind, slug: string): string {
  return `${runtime}:${kind}:${slug}`;
}

function storePath(projectDir: string): string {
  return path.join(projectDir, FILE);
}

function read(projectDir: string): Store {
  try {
    const raw = fs.readFileSync(storePath(projectDir), "utf8");
    const parsed = JSON.parse(raw);
    // A corrupted file must not take down a dispatch: treat it as empty and
    // the run proceeds cold, which is degradation, not failure.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Store;
  } catch { /* absent or unreadable → empty */ }
  return {};
}

/** This entity's previous session in this project, or null to start cold. */
export function getSession(projectDir: string, key: string): string | null {
  const e = read(projectDir)[key];
  return e && typeof e.session_id === "string" && e.session_id ? e.session_id : null;
}

/** Records the session returned by the run. No-op when the runtime returns no
 *  id (gemini-cli, for example) — in that case the entity simply keeps
 *  starting cold, without error. */
export function putSession(projectDir: string, key: string, runtime: string, sessionId: string | null): void {
  if (!sessionId) return;
  const store = read(projectDir);
  const prev = store[key];
  store[key] = {
    session_id: sessionId,
    runtime,
    updated_at: new Date().toISOString(),
    resumes: (prev?.resumes ?? 0) + (prev ? 1 : 0),
  };
  try {
    // EEXIST tolerated: on Windows Bun throws it even with recursive:true.
    try { fs.mkdirSync(projectDir, { recursive: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e; }
    fs.writeFileSync(storePath(projectDir), JSON.stringify(store, null, 2));
  } catch { /* failing to write does not invalidate the work already done */ }
}

/** Drops an entity's session — used when a resume fails, so the next attempt
 *  does not repeat the same invalid id. */
export function dropSession(projectDir: string, key: string): void {
  const store = read(projectDir);
  if (!(key in store)) return;
  delete store[key];
  try { fs.writeFileSync(storePath(projectDir), JSON.stringify(store, null, 2)); } catch { /* idem */ }
}
