// run-workspace.ts — a dispatched worker starts in its own run folder.
//
// Every run lives in `<outputs base>/<run id>/` (project-root.js
// outputsBaseDir): the run's HANDOFF, its deliverables and whatever its squads
// wrote. Workers used to start in the project root, or in HOME outside a
// project, with every earlier run one `ls ../` away. A worker that finds a
// finished run of the same brief beside it can copy that run's deliverables and
// present them as its own work; it happened in a benchmark run, and nothing in
// the engine could tell.
//
// So a worker given a `workspace` (RunHeadlessOpts.workspace) gets:
//
//   · its cwd in the run folder, never HOME or the bare project root;
//   · the project it serves as an additional directory, so a brief about the
//     user's own files still reads them;
//   · on every runtime, one line appended to the worker's directive naming the
//     run folder and saying the earlier runs beside it are not its input
//     unless its instruction points to them. It is a direction, never a lock:
//     no folder is denied. Sibling runs used to be denied by Read/Edit rules on
//     claude-code, and a brief that told the worker to build on an earlier run
//     (named in the brief file, which the rule never saw) had that folder
//     refused; the worker redid 62 screenshots it was told to reuse. A worker
//     must be able to reach any folder on the machine: a review of another
//     project, or a new project created elsewhere, is ordinary work;
//   · the run folder in its environment (RUN_WORKSPACE_ENV), so a dispatch
//     started from inside this run (only an orchestrator may start one) nests
//     inside it (nestedOutputsBase) instead of becoming a sibling.
//
// Moving the cwd has one cost that is paid back here: Claude Code loads a
// project's `.claude/settings.json` from the cwd only, with no parent fallback,
// so the project's Read/Edit deny rules (the `.env` rules `nrv init` writes)
// stopped applying. They are re-anchored at the project root and travel in the
// same settings file.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonical, findProjectRoot, isInvalidProjectRoot, outputsBaseDir, resolveProjectRoot, sameDir } from "./project-root.js";

/** Prefix of the per-run settings file, so the driver's orphan reaper knows it. */
export const FENCE_FILE_PREFIX = "nrv-fence-";

/** The run folder a confined worker runs in, exported to its environment. A
 *  dispatch started from inside that run reads it and nests its scaffold
 *  inside the run. */
export const RUN_WORKSPACE_ENV = "NIRVANA_RUN_WORKSPACE";

/**
 * The run folder that holds `dir`: `<base>/<run id>` for the first outputs base
 * `dir` sits under (the project's, then the engine store's). Null when `dir` is
 * not inside a run, which leaves the caller's cwd as it was.
 */
export function runFolderOf(dir: string | null | undefined, projectRoot?: string | null): string | null {
  if (!dir) return null;
  const bases: string[] = [];
  if (projectRoot && !isInvalidProjectRoot(projectRoot)) bases.push(outputsBaseDir(projectRoot));
  bases.push(outputsBaseDir(null));
  const targets = [path.resolve(dir), canonical(dir)];
  for (const base of bases) {
    for (const b of new Set([path.resolve(base), canonical(base)])) {
      for (const t of targets) {
        const rel = path.relative(b, t);
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
        return path.join(b, rel.split(path.sep)[0]);
      }
    }
  }
  return null;
}

/**
 * Where a dispatch started from inside a run puts its scaffold:
 * `<run folder>/dispatches`. As a run of its own under the outputs base, that
 * work would sit BESIDE the run that asked for it, fenced off from it. Nested,
 * `runFolderOf` maps it to the run that asked for it. Null for a dispatch from the operator, and for
 * a variable that does not name a run folder of this project or of the store.
 */
export function nestedOutputsBase(projectRoot: string | null, env: Record<string, string | undefined> = process.env): string | null {
  const named = env[RUN_WORKSPACE_ENV];
  if (!named) return null;
  const workspace = path.resolve(named);
  if (!fs.existsSync(workspace)) return null;
  const run = runFolderOf(workspace, projectRoot);
  if (!run || !sameDir(canonical(run), canonical(workspace))) return null;
  return path.join(workspace, "dispatches");
}

/**
 * An absolute path as a Claude Code permission pattern: `//` anchors at the
 * filesystem root, and on Windows the path is matched in POSIX form
 * (`C:\Users\a` is `/c/Users/a`). Gitignore metacharacters in the path are
 * escaped so a folder name cannot turn into a wildcard. Null for a path the
 * rules cannot express (a UNC share).
 */
export function claudeAbsolutePattern(absPath: string, platform: NodeJS.Platform = process.platform): string | null {
  let p = absPath;
  if (platform === "win32") {
    const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(p);
    if (!m) return null;
    p = `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
  }
  if (!p.startsWith("/")) return null;
  const escaped = p.replace(/\/+$/, "").replace(/([[\]*?\\])/g, "\\$1");
  return `/${escaped}`;
}

/**
 * The project's own Read/Edit deny rules, re-anchored at the project root.
 * In `.claude/settings.json` a relative pattern anchors at the cwd, and a deny
 * pattern with no anchor matches at any depth under it; both keep that meaning
 * once the cwd is the run folder. Anchored (`//`, `~/`) rules and non-path
 * rules are Claude Code's to load from the user's settings, not ours to copy.
 */
export function projectDenyRules(projectRoot: string, platform: NodeJS.Platform = process.platform): string[] {
  let settings: any;
  try { settings = JSON.parse(fs.readFileSync(path.join(projectRoot, ".claude", "settings.json"), "utf8")); }
  catch { return []; }
  const deny: unknown = settings?.permissions?.deny;
  if (!Array.isArray(deny)) return [];
  const root = claudeAbsolutePattern(projectRoot, platform);
  if (!root) return [];
  const out: string[] = [];
  for (const rule of deny) {
    const m = typeof rule === "string" ? /^(Read|Edit)\((.+)\)$/.exec(rule.trim()) : null;
    if (!m) continue;
    const [, tool, pattern] = m;
    if (pattern.startsWith("//") || pattern.startsWith("~/") || pattern.startsWith("!")) continue;
    let rest: string;
    if (pattern.startsWith("./")) rest = pattern.slice(2);
    else if (pattern.startsWith("/")) rest = pattern.slice(1);
    else if (pattern.startsWith("**/")) rest = pattern;
    else rest = `**/${pattern}`;
    out.push(`${tool}(${root}/${rest})`);
  }
  return out;
}

/** The settings a claude-code worker runs with, or null when there are none:
 *  only the project's own deny rules (the `.env` rules `nrv init` writes),
 *  re-anchored at the project root. No folder is denied. */
export function fenceSettings(workspace: string, projectRoot: string | null, platform: NodeJS.Platform = process.platform): { permissions: { deny: string[] } } | null {
  const deny = projectRoot ? projectDenyRules(projectRoot, platform) : [];
  return deny.length ? { permissions: { deny } } : null;
}

/** The line every confined worker reads, on every runtime. */
export function workspaceDirective(workspace: string): string {
  return `YOUR RUN FOLDER is ${workspace}. Everything you write for this run belongs under the output folder your prompt names. The earlier runs beside it, in ${path.dirname(workspace)}, are not your input unless your instruction points to them; any other folder your work needs is yours to read and write.`;
}

/**
 * Codex reads AGENTS.md from the repository root down to its cwd, and only the
 * cwd when there is no repository (learn.chatgpt.com/docs/agent-configuration/
 * agents-md). Started in a run folder of a project that is not a repository, it
 * would lose the project's contract, so it is pointed at it. Claude Code and
 * Gemini CLI find theirs walking up from the run folder and are not told twice.
 */
export function contractPointer(runtime: string, workspace: string, projectRoot: string | null): string {
  if (runtime !== "codex" || !projectRoot) return "";
  const contract = path.join(projectRoot, "AGENTS.md");
  // A git root is not a project, so the walk is asked for `.git` explicitly.
  if (!fs.existsSync(contract) || findProjectRoot(workspace, { markers: [".git"] })) return "";
  return ` The project's instructions are in ${contract}: read them before you start.`;
}

type Confinable = {
  runtime: string;
  cwd: string;
  prompt?: string;
  workspace?: string;
  addDirs?: string[];
  appendSystemPrompt?: string;
  claudeSettings?: string;
  hostCwd?: string;
};

/**
 * Moves a worker into its run folder. Returns the options to spawn with and a
 * cleanup for the settings file; with no `workspace` the options come back
 * untouched.
 */
export function confineToWorkspace<T extends Confinable>(opts: T): { opts: T; cleanup: () => void } {
  if (!opts.workspace) return { opts, cleanup: () => {} };
  const workspace = path.resolve(opts.workspace);
  fs.mkdirSync(workspace, { recursive: true });
  // The project the caller serves, spelled as the caller spelled it when it is
  // the caller's own cwd (the resolver hands back the canonical form).
  const resolved: string | null = resolveProjectRoot({ cwd: opts.cwd });
  const projectRoot = resolved && sameDir(canonical(resolved), canonical(opts.cwd)) ? opts.cwd : resolved;
  const addDirs = [...(opts.addDirs ?? [])];
  if (projectRoot && !addDirs.some((d) => sameDir(canonical(d), canonical(projectRoot)))) addDirs.push(projectRoot);
  // The line rides with the worker's directive. A decision step (a judge, a router)
  // runs lean with no directive at all and keeps it that way; it still
  // gets the cwd and, on claude-code, the deny rules.
  const confined: T = {
    ...opts,
    cwd: workspace,
    hostCwd: opts.hostCwd ?? opts.cwd,
    addDirs,
    ...(opts.appendSystemPrompt
      ? { appendSystemPrompt: `${opts.appendSystemPrompt}\n\n${workspaceDirective(workspace)}${contractPointer(opts.runtime, workspace, projectRoot)}` }
      : {}),
  };
  let file: string | null = null;
  if (opts.runtime === "claude-code" && !opts.claudeSettings) {
    const settings = fenceSettings(workspace, projectRoot, process.platform);
    if (settings) {
      const written: string = path.join(os.tmpdir(), `${FENCE_FILE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      fs.writeFileSync(written, JSON.stringify(settings, null, 2), "utf8");
      confined.claudeSettings = written;
      file = written;
    }
  }
  return {
    opts: confined,
    cleanup: () => { if (file) { try { fs.rmSync(file, { force: true }); } catch { /* best effort */ } } },
  };
}
