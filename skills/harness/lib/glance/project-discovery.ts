/**
 * project-discovery.ts — finds OTHER Nirvana project directories on this
 * machine, for the Glance project switcher (`/api/known-projects`,
 * `POST /api/actions/switch-project`).
 *
 * Source: Claude Code's own transcript-storage convention. A session run
 * from `/home/dev/nirvana-os` gets its transcripts stored under
 * `~/.claude/projects/-home-dev-nirvana-os/` — every path separator
 * turned into "-", with a leading "-" for the leading "/". That encoding is
 * LOSSY: a real directory name can itself contain "-" (`nirvana-os`,
 * `mini-apps`), so it is not reversible by a blind
 * `replace(/-/g, "/")` — that would misread `nirvana-os` as `nirvana/os`.
 *
 * `decodeClaudeProjectDirName()` recovers the real path by walking the
 * filesystem instead of guessing blind: at each step it prefers the LONGEST
 * run of remaining dash-separated tokens that names a real directory under
 * the path resolved so far, then descends into it. A name whose real
 * boundaries can't be recovered this way is simply dropped — not an error,
 * one fewer suggestion, degrading gracefully (a project can still be added
 * via the free-text path field the UI offers alongside this list).
 *
 * A decoded candidate only makes the list when it exists on disk AND has a
 * `.nirvana/` marker — this scan is about NIRVANA projects the owner can
 * switch Glance into, not every folder Claude Code ever ran a session in.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { paths, expandPath } from "../../../_shared/lib/bun-helpers.ts";

const NIRVANA_MARKER = ".nirvana";
// Bounds the worst case of the O(tokens^2) filesystem-guided decode below —
// no real project path encodes to more dash-separated tokens than this.
const MAX_DECODE_TOKENS = 60;

export function hasNirvanaMarker(dir: string): boolean {
  try { return fs.statSync(path.join(dir, NIRVANA_MARKER)).isDirectory(); }
  catch { return false; }
}

/** `baseRoot` is the filesystem root the first token resolves against — always
 *  `path.sep` in production (a real absolute path); overridable so tests can
 *  point the walk at a temp fixture tree instead of the real "/". */
export function decodeClaudeProjectDirName(encoded: string, baseRoot: string = path.sep): string | null {
  const tokens = encoded.split("-");
  if (tokens[0] === "") tokens.shift(); // leading "-" encodes the leading "/"
  if (tokens.length === 0 || tokens.length > MAX_DECODE_TOKENS) return null;

  let resolved = baseRoot;
  let i = 0;
  while (i < tokens.length) {
    let advanced = false;
    // Longest-run-first: prefer the biggest chunk of tokens that is a real
    // directory here, so a hyphenated leaf name (`nirvana-os`) wins over the
    // shorter, wrong split (`nirvana` then a separate `os`).
    for (let j = tokens.length; j > i; j--) {
      const candidateName = tokens.slice(i, j).join("-");
      const candidatePath = path.join(resolved, candidateName);
      try {
        if (fs.statSync(candidatePath).isDirectory()) {
          resolved = candidatePath;
          i = j;
          advanced = true;
          break;
        }
      } catch { /* not a real segment at this length — try shorter */ }
    }
    if (!advanced) return null;
  }
  return resolved;
}

export interface DiscoveredProject {
  path: string;
  name: string;
}

/** Scans `~/.claude/projects/` (or `claudeProjectsDir`, for tests) and
 *  returns every decodable entry that is a real, `.nirvana/`-marked
 *  directory. Sorted by name; no duplicates. `decodeBaseRoot` overrides the
 *  filesystem root the decode walk starts from (tests only; always `path.sep`
 *  in production, since transcript dir names encode a real absolute path). */
export function discoverKnownProjects(claudeProjectsDir?: string, decodeBaseRoot: string = path.sep): DiscoveredProject[] {
  const dir = claudeProjectsDir || path.join(paths.CLAUDE_CONFIG_DIR, "projects");
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return []; }

  const seen = new Set<string>();
  const out: DiscoveredProject[] = [];
  for (const entry of entries) {
    try { if (!fs.statSync(path.join(dir, entry)).isDirectory()) continue; } catch { continue; }
    const decoded = decodeClaudeProjectDirName(entry, decodeBaseRoot);
    if (!decoded || seen.has(decoded) || !hasNirvanaMarker(decoded)) continue;
    seen.add(decoded);
    out.push({ path: decoded, name: path.basename(decoded) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export type ValidatedProjectPath = { ok: true; path: string } | { ok: false; error: string };

/** Validates a free-text (or discovered) path for the project switcher: it
 *  must exist, be a directory, and carry a `.nirvana/` marker. Same bar as
 *  discovery, applied to a path the owner typed by hand. */
export function validateProjectPath(input: unknown): ValidatedProjectPath {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return { ok: false, error: "project_root is required" };
  const resolved = path.resolve(expandPath(raw));
  let stat: fs.Stats;
  try { stat = fs.statSync(resolved); }
  catch { return { ok: false, error: `path does not exist: ${resolved}` }; }
  if (!stat.isDirectory()) return { ok: false, error: `not a directory: ${resolved}` };
  if (!hasNirvanaMarker(resolved)) return { ok: false, error: `no .nirvana/ marker found in ${resolved} — run \`nrv init\` there first` };
  return { ok: true, path: resolved };
}
