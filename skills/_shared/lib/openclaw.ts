// openclaw.ts — OpenClaw's agent roster, read for one question: which agents
// have a Nirvana project as their home.
//
// OpenClaw inverts the model every other runtime here follows. Claude, Codex,
// Gemini and Hermes work in the directory they were started in, so "run it
// inside the project" is the whole recipe. An OpenClaw agent works in its
// WORKSPACE: that is where AGENTS.md/SOUL.md/IDENTITY.md are read from at every
// session start, where relative paths resolve, and where skills under
// `<workspace>/skills` and `<workspace>/.agents/skills` are found
// (docs.openclaw.ai/concepts/agent-workspace, 2026.8). The way a project meets
// an OpenClaw agent is therefore to make the project the agent's workspace:
//
//   openclaw agents add <name> --workspace <project> --non-interactive
//
// Measured 2026-09-05 with a project written by `nrv init`: the agent read the
// project's AGENTS.md, `pwd` was the project, and `nrv audit emit` landed
// signed in `<project>/.nirvana/logs/harness/`, nothing in the global log.
//
// `agents.entries.<id>.cwd` exists too ("working directory for tool execution,
// separate from workspace") and would put the logs in the project while the
// agent's files stay elsewhere — but then the project's AGENTS.md is not the
// agent's instructions, and the docs say sandboxed runs reject an alternate
// cwd. It is documented, not recommended.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface OpenClawAgent {
  id: string;
  workspace: string | null;
  cwd: string | null;
}

/** OPENCLAW_CONFIG_PATH, else <state dir>/openclaw.json, the state dir being OPENCLAW_STATE_DIR or ~/.openclaw. */
export function openclawConfigPath(): string {
  if (process.env.OPENCLAW_CONFIG_PATH) return process.env.OPENCLAW_CONFIG_PATH;
  const state = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
  return path.join(state, "openclaw.json");
}

function expandHome(p: string): string {
  return p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * The roster as the config declares it. Both shapes OpenClaw has used are read:
 * `agents.entries` (an object keyed by id) and the older `agents.list` (an
 * array with `id`). A workspace an agent does not set falls back to
 * `<agents.defaults.workspace>/<id>` for non-main agents, per the docs; the
 * main agent uses the default itself. An unreadable config is an empty roster,
 * never an error — this feeds a doctor line and an init hint.
 */
export function readOpenClawAgents(configPath = openclawConfigPath()): OpenClawAgent[] {
  let raw: string;
  try { raw = fs.readFileSync(configPath, "utf8"); } catch { return []; }
  let cfg: any;
  try { cfg = JSON.parse(raw); } catch { return []; }
  const agents = cfg?.agents ?? {};
  const defaultWs = typeof agents?.defaults?.workspace === "string"
    ? expandHome(agents.defaults.workspace)
    : path.join(process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw"), "workspace");
  const out: OpenClawAgent[] = [];
  const push = (id: string, entry: any) => {
    const ws = typeof entry?.workspace === "string" ? expandHome(entry.workspace)
      : id === "main" ? defaultWs : path.join(defaultWs, id);
    out.push({ id, workspace: ws, cwd: typeof entry?.cwd === "string" ? expandHome(entry.cwd) : null });
  };
  if (agents.entries && typeof agents.entries === "object" && !Array.isArray(agents.entries)) {
    for (const [id, entry] of Object.entries(agents.entries)) push(id, entry);
  } else if (Array.isArray(agents.list)) {
    for (const entry of agents.list) if (entry && typeof entry.id === "string") push(entry.id, entry);
  }
  return out;
}

/** A directory is a Nirvana project when it carries the `.nirvana/` scaffold `nrv init` writes. */
export function isNirvanaProject(dir: string): boolean {
  try { return fs.statSync(path.join(dir, ".nirvana")).isDirectory(); } catch { return false; }
}

/** Agents whose workspace is a Nirvana project — the recommended binding. */
export function openclawAgentsOnProjects(configPath?: string): OpenClawAgent[] {
  return readOpenClawAgents(configPath).filter((a) => a.workspace !== null && isNirvanaProject(a.workspace));
}

function realOrSelf(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** The agent whose workspace IS this project, if one is bound. */
export function openclawAgentFor(projectDir: string, configPath?: string): OpenClawAgent | null {
  const want = realOrSelf(projectDir);
  return readOpenClawAgents(configPath).find((a) => a.workspace !== null && realOrSelf(a.workspace) === want) ?? null;
}

/** The one command that binds a project to a new dedicated agent. */
export function openclawBindCommand(projectDir: string, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "nirvana";
  return `openclaw agents add ${safe} --workspace ${projectDir} --non-interactive`;
}
