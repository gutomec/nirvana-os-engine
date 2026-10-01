// run-session.ts — the session file a finished run leaves beside its plumbing,
// so `nrv revise` can continue the worker's own conversation.
//
// One file per worker that ran, in the scaffold dir it worked from:
//   <run>/businesses/<slug>/session.json   the business's solo worker
//   <run>/squads/<slug>/session.json       each squad of a squad-only route
//   <run>/agent-x/session.json             the generalist
//
// The business file is written by dispatch.ts itself (its shape is pinned by the
// business parity test). This module writes the squad and agent-x ones, with the
// same fields plus the target they belong to, and finds all three kinds.
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir } from "../../_shared/lib/ensure-dir.ts";

export type RunSessionKind = "business" | "squad" | "agent-x";

export interface RunSessionFile { file: string; kind: RunSessionKind; slug: string }

/** Every session file of one run folder: businesses, then squads (by name), then agent-x. */
export function findRunSessions(runRoot: string): RunSessionFile[] {
  const found: RunSessionFile[] = [];
  for (const [sub, kind] of [["businesses", "business"], ["squads", "squad"]] as const) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(runRoot, sub), { withFileTypes: true }); } catch { continue; }
    for (const e of entries.filter(d => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(runRoot, sub, e.name, "session.json");
      if (fs.existsSync(file)) found.push({ file, kind, slug: e.name });
    }
  }
  const agentX = path.join(runRoot, "agent-x", "session.json");
  if (fs.existsSync(agentX)) found.push({ file: agentX, kind: "agent-x", slug: "agent-x" });
  return found;
}

export interface WorkerSession {
  projectId: string;
  kind: "squad" | "agent-x";
  slug: string;
  /** The runtime that finished the work, after any handoff: the session is its. */
  runtime: string;
  /** Null when the runtime returned none; `nrv revise` then refuses. */
  sessionId: string | null;
  /** The worker's scaffold dir; the file is written here. */
  projectDir: string;
  projectRoot: string;
  outputsRoot: string;
  /** The folder the session was started in (claude and gemini resume only from there). */
  workspace: string | null;
  manifest?: string | null;
}

/** Writes `<projectDir>/session.json` for a squad or agent-x worker and returns
 *  its path and contents, so a caller can rewrite it when a correction round
 *  mints a new session id. */
export function writeWorkerSession(s: WorkerSession): { file: string; data: Record<string, unknown> } {
  const data: Record<string, unknown> = {
    project_id: s.projectId, target_kind: s.kind, target_slug: s.slug, runtime: s.runtime,
    session_id: s.sessionId, project_dir: s.projectDir, project_root: s.projectRoot,
    outputs_root: s.outputsRoot, workspace: s.workspace, manifest: s.manifest ?? null,
    created_at: new Date().toISOString(),
  };
  ensureDir(s.projectDir);
  const file = path.join(s.projectDir, "session.json");
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return { file, data };
}
