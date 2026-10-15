// run-session.ts — the session file a finished run leaves beside its plumbing,
// so `nrv revise` can continue the worker's own conversation.
//
// One file per worker that ran, in the scaffold dir it worked from:
//   <run>/businesses/<slug>/session.json   the business (its last worker's session)
//   <run>/squads/<slug>/session.json       each squad of a squad-only route
//   <run>/agent-x/session.json             the generalist
//
// The business file is written by dispatch.ts itself (its shape predates this
// module). This module writes the squad and agent-x ones, with the same fields
// plus the target they belong to, and finds all three kinds.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDir } from "../../_shared/lib/ensure-dir.ts";
import { sessionHome } from "../../_shared/lib/host-agent-driver.ts";

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

/** The run folders a project id can live in, nearest first: the project's
 *  visible `outputs/`, the engine store, the project's `.nirvana/outputs/`, and
 *  the legacy home-level folder. */
export function runRoots(projectId: string, cwd: string = process.cwd(), home: string = os.homedir()): string[] {
  return [
    path.join(cwd, "outputs", projectId),
    path.join(home, ".nirvana", "outputs", projectId),
    path.join(cwd, ".nirvana", "outputs", projectId),
    path.join(home, projectId),
  ];
}

/** The session files of a project, from the nearest run folder that holds any. */
export function locateRunSessions(projectId: string, cwd: string = process.cwd(), home: string = os.homedir()): RunSessionFile[] {
  for (const root of runRoots(projectId, cwd, home)) {
    const found = findRunSessions(root);
    if (found.length) return found;
  }
  return [];
}

/** The one worker's session of a project, read, or why there is none. */
export function readRunSession(projectId: string, cwd: string = process.cwd(), home: string = os.homedir()):
  { ok: true; file: string; kind: RunSessionKind; slug: string; data: Record<string, any> } | { ok: false; reason: string } {
  const found = locateRunSessions(projectId, cwd, home);
  if (!found.length) return { ok: false, reason: `no session.json for project '${projectId}' under ${runRoots(projectId, cwd, home).join(", ")}` };
  if (found.length > 1) return { ok: false, reason: `project '${projectId}' ran ${found.length} workers; there is no single session to continue` };
  try {
    const data = JSON.parse(fs.readFileSync(found[0].file, "utf8"));
    return { ok: true, ...found[0], data };
  } catch (e) {
    return { ok: false, reason: `unreadable ${found[0].file}: ${(e as Error)?.message ?? e}` };
  }
}

/** The worker a session file belongs to: a business's slug, a squad's, or agent-x. */
export function sessionTarget(s: RunSessionFile, data: Record<string, any>): string {
  return (s.kind === "business" ? data.business_slug : data.target_slug) || s.slug;
}

/**
 * The project of the newest single-worker run with a session file, optionally
 * only those of one worker (a business or squad slug, or `agent-x`). Searched
 * in the same outputs folders as runRoots. `nrv revise --last [<target>]`.
 */
export function latestRunSession(opts: { target?: string | null; cwd?: string; home?: string } = {}): { projectId: string; file: string; kind: RunSessionKind; slug: string } | null {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? os.homedir();
  const bases = [path.join(cwd, "outputs"), path.join(home, ".nirvana", "outputs"), path.join(cwd, ".nirvana", "outputs")];
  let best: { projectId: string; file: string; kind: RunSessionKind; slug: string; at: number } | null = null;
  const seen = new Set<string>();
  for (const base of bases) {
    let runs: fs.Dirent[];
    try { runs = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const run of runs) {
      if (!run.isDirectory() || seen.has(run.name)) continue;
      const found = findRunSessions(path.join(base, run.name));
      if (found.length !== 1) continue;
      seen.add(run.name);
      const f = found[0];
      let data: Record<string, any> = {};
      try { data = JSON.parse(fs.readFileSync(f.file, "utf8")); } catch { continue; }
      if (opts.target && sessionTarget(f, data) !== opts.target) continue;
      let at = 0;
      try { at = fs.statSync(f.file).mtimeMs; } catch { continue; }
      if (!best || at > best.at) best = { projectId: run.name, file: f.file, kind: f.kind, slug: sessionTarget(f, data), at };
    }
  }
  return best ? { projectId: best.projectId, file: best.file, kind: best.kind, slug: best.slug } : null;
}

export interface WorkerSession {
  projectId: string;
  kind: "squad" | "agent-x";
  slug: string;
  /** The runtime that finished the work, after any handoff: the session is its. */
  runtime: string;
  /** Null when the runtime returned none; `nrv revise` then runs a fresh, seeded session. */
  sessionId: string | null;
  /** The worker's scaffold dir; the file is written here. */
  projectDir: string;
  projectRoot: string;
  outputsRoot: string;
  /** The folder the session was started in (claude resumes only from there). */
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
    // Where the session lives: a run that continued an earlier project's
    // session ran in that project's folder, and is resumed from there.
    outputs_root: s.outputsRoot, workspace: sessionHome(s.sessionId) ?? s.workspace, manifest: s.manifest ?? null,
    created_at: new Date().toISOString(),
  };
  ensureDir(s.projectDir);
  const file = path.join(s.projectDir, "session.json");
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return { file, data };
}
