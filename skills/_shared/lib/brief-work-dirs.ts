// brief-work-dirs.ts — the folders a brief places its work in, outside the
// run's outputs root.
//
// The first solo prompt has always said "when the brief's work lives in
// another folder (a project to review or fix, a new project to create), do that
// work there". Every later prompt dropped it: the supervisor's resume asked for
// "the final files under the outputs root", the revision for "the deliverables
// as files under <outputs root>", and the claims check accepted evidence only
// there. On 2026-10-14 a resumed worker copied a whole website project into
// `deliverables/website/` (node_modules included) because that was the only
// place its work could be proven, and the project it was asked to fix was left
// failing its own checks.
//
// What a brief can name is a path. This reads the absolute ones (POSIX, `~/`,
// or a Windows drive) and keeps the folders: one that exists, or a new one
// whose parent exists (a project to create). A file path is an input, not a
// work folder, and names none. Model-free and conservative: a brief that names
// no path gets no work folder, and the prompts then say the rule without one.
// A folder that CONTAINS the outputs root (the project the run belongs to) is
// kept: on 2026-10-14 that project was exactly the work folder.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PATH_TOKEN = /(?:^|[\s`'"(<\[=:])((?:~|[A-Za-z]:)?[\\/][^\s`'"()<>\[\],;|*?]+)/g;

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/** True for a folder too broad to be anyone's work folder. */
function tooBroad(dir: string, home: string): boolean {
  const resolved = path.resolve(dir);
  return resolved === path.parse(resolved).root || resolved === path.resolve(home) || path.dirname(resolved) === path.parse(resolved).root;
}

/**
 * The absolute folders `brief` places work in, outside `outputsRoot` and
 * outside the engine's own home (`~/.nirvana`). Deduplicated, in the order the
 * brief names them. `home` is a test seam.
 */
export function briefWorkDirs(brief: string | null | undefined, outputsRoot: string | null, home: string = os.homedir()): string[] {
  if (!brief) return [];
  const out: string[] = [];
  const engineHome = path.join(home, ".nirvana");
  const oroot = outputsRoot ? path.resolve(outputsRoot) : null;
  for (const m of brief.matchAll(PATH_TOKEN)) {
    let raw = m[1].replace(/[.:!]+$/, "");
    if (raw.startsWith("~")) raw = path.join(home, raw.slice(1));
    // A POSIX-looking token on Windows (or the reverse) is still a path; only
    // a lone separator or a URL fragment ("//host") is not.
    if (raw.length < 2 || /^[\\/]{2}/.test(raw)) continue;
    if (!/^[\\/]/.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) continue;
    const abs = path.resolve(raw);
    let dir: string | null = null;
    if (isDir(abs)) dir = abs;
    else if (isFile(abs)) continue;
    else if (!path.extname(abs) && isDir(path.dirname(abs))) dir = abs;   // a project to create
    if (!dir || tooBroad(dir, home)) continue;
    if (oroot && within(dir, oroot)) continue;
    if (within(dir, engineHome)) continue;
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

/** The rule every prompt after the first carries, with the folders when the brief names them. */
export function workElsewhereRule(outputsRoot: string, workDirs: readonly string[]): string {
  const where = workDirs.length ? ` The brief places work in: ${workDirs.join(", ")}.` : "";
  return `Work the brief places in another folder (a project to review or fix, a new project to create) is done there, in place: never copy it under ${outputsRoot}.${where} The deliverables written under ${outputsRoot} stay there.`;
}
