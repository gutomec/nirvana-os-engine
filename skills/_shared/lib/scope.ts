/**
 * scope.ts — Project/global/merge scope resolver for Nirvana.
 *
 * Reads NIRVANA_SCOPE from <cwd>/.env (walking up to find it, stopping at
 * the first .env or .nirvana/ or .git found). Returns ordered path lists for
 * squads, businesses and mind-clones. The first hit per slug wins, so when
 * mode = "merge" the project copy automatically overrides the global one.
 *
 * Modes:
 *   "global"  → only ~/.nirvana/skills/* and ~/squads/* (default — backward compat)
 *   "project" → only <project>/.nirvana/{squads,businesses,mind-clones}/*
 *   "merge"   → project first, global second; project overrides by slug
 *
 * Reads (all optional, .env-style KEY=VALUE):
 *   NIRVANA_SCOPE                       global | project | merge
 *   NIRVANA_PROJECT_ROOT                explicit override (else auto-detect)
 *   NIRVANA_PROJECT_SQUADS_DIR          default: <project>/.nirvana/squads
 *   NIRVANA_PROJECT_BUSINESSES_DIR      default: <project>/.nirvana/businesses
 *   NIRVANA_PROJECT_MIND_CLONES_DIR     default: <project>/.nirvana/mind-clones
 *   NIRVANA_GLOBAL_INCLUDE_ONLY         CSV — when set, only these slugs from global
 *   NIRVANA_GLOBAL_EXCLUDE              CSV — exclude these slugs from global
 *
 * CLI override: --scope=project|global|merge wins over .env.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { paths } from "./bun-helpers.ts";

export type ScopeMode = "global" | "project" | "merge";

export interface ResolvedScope {
  mode: ScopeMode;
  projectRoot: string | null;
  squadDirs: string[];
  businessDirs: string[];
  mindCloneDirs: string[];
  globalInclude: Set<string> | null;
  globalExclude: Set<string>;
}

interface SlugLocation {
  slug: string;
  dir: string;
  source: "project" | "global";
  overridden?: boolean;
}

const SCOPE_MARKERS = [".env", ".nirvana", ".git", "package.json", "pyproject.toml"];

// HOME and the OS root are never valid projectRoots — even if .env or .nirvana
// happen to exist there. Otherwise the resolver treats the user's HOME as a
// project, which collapses every scope-aware lookup.
function isInvalidProjectRoot(dir: string): boolean {
  if (!dir || dir === "/" || dir === "") return true;
  try {
    if (path.resolve(dir) === path.resolve(process.env.HOME || os.homedir())) return true;
  } catch {}
  return false;
}

function findProjectRoot(start: string): string | null {
  let cur = path.resolve(start);
  for (let i = 0; i < 30; i++) {
    if (!isInvalidProjectRoot(cur)) {
      for (const m of SCOPE_MARKERS) {
        if (fs.existsSync(path.join(cur, m))) return cur;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

// Expand $VAR / ${VAR} using process.env + previously seen keys in the file.
function expandEnvRefs(value: string, scope: Record<string, string>): string {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Za-z_][\w]*)\}|\$([A-Za-z_][\w]*)/g, (full, braced, bare) => {
    const key = braced || bare;
    if (process.env[key] != null && process.env[key] !== "") return process.env[key]!;
    if (scope && scope[key] != null && scope[key] !== "") return scope[key];
    return full;
  });
}

function loadDotenv(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  const txt = fs.readFileSync(envPath, "utf8");
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = expandEnvRefs(v, out);
  }
  return out;
}

function csv(s: string | undefined): Set<string> {
  if (!s) return new Set();
  return new Set(s.split(",").map(x => x.trim()).filter(Boolean));
}

function cliScope(): ScopeMode | null {
  for (const a of process.argv.slice(2)) {
    if (a === "--scope=project" || a === "--scope=global" || a === "--scope=merge") {
      return a.split("=")[1] as ScopeMode;
    }
    if (a === "--scope" || a === "-s") {
      const idx = process.argv.indexOf(a);
      const next = process.argv[idx + 1];
      if (next === "project" || next === "global" || next === "merge") return next;
    }
  }
  return null;
}

export function resolveScope(opts: { cwd?: string; explicitMode?: ScopeMode } = {}): ResolvedScope {
  const cwd = opts.cwd ?? process.cwd();
  const projectRoot = process.env.NIRVANA_PROJECT_ROOT
    ? path.resolve(process.env.NIRVANA_PROJECT_ROOT)
    : findProjectRoot(cwd);

  // Layered config: defaults < .env (project) < process.env < CLI flag
  const dotenv = projectRoot ? loadDotenv(path.join(projectRoot, ".env")) : {};
  const cfg = (k: string) => process.env[k] ?? dotenv[k];

  const cliMode = cliScope();
  const envMode = (cfg("NIRVANA_SCOPE") || "").toLowerCase();
  const mode: ScopeMode =
    opts.explicitMode ??
    cliMode ??
    (envMode === "project" || envMode === "merge" || envMode === "global" ? envMode as ScopeMode : "global");

  // Defensive — the "ran from inside the skill dir" footgun. Scope detection
  // walks UP from cwd; if a loader is invoked after `cd`-ing into the skill
  // tree, cwd is no longer inside the project, no project root is found, and we
  // silently fall back to GLOBAL (listing the home registry instead of the
  // project's). Warn loudly so the wrong scope is never presented as correct.
  // Suppress with NIRVANA_SCOPE_QUIET=1 or by pinning NIRVANA_PROJECT_ROOT.
  if (mode === "global" && !projectRoot && !process.env.NIRVANA_PROJECT_ROOT && !process.env.NIRVANA_SCOPE_QUIET) {
    const resolvedCwd = path.resolve(cwd);
    const skillsRoot = paths.SKILLS_ROOT ? path.resolve(paths.SKILLS_ROOT) : null;
    const inSkillsDir =
      /[/\\]\.(claude|nirvana)[/\\]skills[/\\]/.test(resolvedCwd) ||
      (!!skillsRoot && resolvedCwd.startsWith(skillsRoot));
    if (inSkillsDir) {
      process.stderr.write(
        "\x1b[33m⚠ scope: resolved to GLOBAL from inside the skill directory " +
        `(cwd=${resolvedCwd}).\n` +
        "  A loader was run with the shell INSIDE the skill tree, so the project\n" +
        "  scope was lost. Run loaders from your PROJECT directory with an absolute\n" +
        "  path (bun ~/.claude/skills/.../scripts/<loader>.ts), or export\n" +
        "  NIRVANA_PROJECT_ROOT=<project>. Never `cd` into the skill dir to run one.\x1b[0m\n"
      );
    }
  }

  // Project assets can live in EITHER `<root>/.nirvana/<kind>/` (Nirvana
  // canonical) OR `<root>/<kind>/` (AIOX layout and others). We auto-detect
  // both layouts. Explicit env override (NIRVANA_PROJECT_*_DIR) wins if set.
  // The trailing filter on the returned struct drops paths that don't exist.
  const projectDirsFor = (envVar: string, kind: string): string[] => {
    const explicit = cfg(envVar);
    if (explicit) return [explicit];
    if (!projectRoot) return [];
    return [
      path.join(projectRoot, ".nirvana", kind),
      path.join(projectRoot, kind),
    ];
  };
  const projectSquadsList = projectDirsFor("NIRVANA_PROJECT_SQUADS_DIR", "squads");
  const projectBusinessesList = projectDirsFor("NIRVANA_PROJECT_BUSINESSES_DIR", "businesses");
  const projectMindClonesList = projectDirsFor("NIRVANA_PROJECT_MIND_CLONES_DIR", "mind-clones");

  const globalSquads = paths.SQUADS_DIR;
  const globalBusinesses = paths.BUSINESSES_DIR;
  const globalMindClones = paths.DNA_LIBRARY;

  let squadDirs: string[] = [];
  let businessDirs: string[] = [];
  let mindCloneDirs: string[] = [];

  if (mode === "project") {
    if (!projectRoot) throw new Error("[scope] NIRVANA_SCOPE=project but no project root found (no .env / .nirvana / .git in ancestors)");
    squadDirs = projectSquadsList;
    businessDirs = projectBusinessesList;
    mindCloneDirs = projectMindClonesList;
  } else if (mode === "merge") {
    if (!projectRoot) {
      // merge falls back to global if no project found
      squadDirs = [globalSquads];
      businessDirs = [globalBusinesses];
      mindCloneDirs = [globalMindClones];
    } else {
      // Project dirs first so they override on slug clashes; both layouts
      // (.nirvana/<kind> and bare <kind>) are probed.
      squadDirs = [...projectSquadsList, globalSquads];
      businessDirs = [...projectBusinessesList, globalBusinesses];
      mindCloneDirs = [...projectMindClonesList, globalMindClones];
    }
  } else {
    squadDirs = [globalSquads];
    businessDirs = [globalBusinesses];
    mindCloneDirs = [globalMindClones];
  }

  return {
    mode,
    projectRoot,
    squadDirs: squadDirs.filter(d => d && fs.existsSync(d)),
    businessDirs: businessDirs.filter(d => d && fs.existsSync(d)),
    mindCloneDirs: mindCloneDirs.filter(d => d && fs.existsSync(d)),
    globalInclude: csv(cfg("NIRVANA_GLOBAL_INCLUDE_ONLY")).size > 0 ? csv(cfg("NIRVANA_GLOBAL_INCLUDE_ONLY")) : null,
    globalExclude: csv(cfg("NIRVANA_GLOBAL_EXCLUDE")),
  };
}

/**
 * Walks each dir in `dirs` (in order) and returns one entry per unique slug.
 * Slug = directory basename. First-hit wins; later hits are marked overridden.
 * Honors NIRVANA_GLOBAL_INCLUDE_ONLY / NIRVANA_GLOBAL_EXCLUDE for entries
 * tagged "global".
 */
export function enumerate(scope: ResolvedScope, kind: "squads" | "businesses" | "mind-clones"): SlugLocation[] {
  const dirs = kind === "squads" ? scope.squadDirs
             : kind === "businesses" ? scope.businessDirs
             : scope.mindCloneDirs;

  const seen = new Map<string, SlugLocation>();
  const overflow: SlugLocation[] = [];

  // A dir is the PROJECT source iff it physically lives under the resolved
  // projectRoot. Never tag by array index: resolveScope filters out
  // non-existent dirs, so when a project's .nirvana/<kind>/ doesn't exist yet
  // the global dir slides to index 0 and index-based tagging mislabels every
  // global asset as source="project" (provenance/override logic then breaks).
  const projRoot = scope.projectRoot ? path.resolve(scope.projectRoot) + path.sep : null;
  dirs.forEach((dir) => {
    if (!fs.existsSync(dir)) return;
    const isProjectDir = !!projRoot && (path.resolve(dir) + path.sep).startsWith(projRoot);
    const source: "project" | "global" = isProjectDir ? "project" : "global";

    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(".") || name.startsWith("_")) continue;
      const full = path.join(dir, name);
      try {
        if (!fs.statSync(full).isDirectory()) continue;
      } catch { continue; }

      // Apply global include/exclude filters
      if (source === "global") {
        if (scope.globalInclude && !scope.globalInclude.has(name)) continue;
        if (scope.globalExclude.has(name)) continue;
      }

      if (seen.has(name)) {
        overflow.push({ slug: name, dir: full, source, overridden: true });
      } else {
        seen.set(name, { slug: name, dir: full, source });
      }
    }
  });

  return [...seen.values(), ...overflow];
}

/**
 * Canonical project outputs directory.
 *
 * Resolution order:
 *   1. NIRVANA_OUTPUTS_DIR env var (absolute or relative to projectRoot)
 *   2. <projectRoot>/outputs            (default — VISÍVEL: entregas são do usuário)
 *   3. <HOME>/.nirvana/outputs          (fallback escondido quando fora de um projeto)
 *
 * Why never inside <projectRoot>/.nirvana/{squads,businesses}/<slug>/: those
 * directories are copied between projects. Outputs from one project leaking
 * into another is the bug we're guarding against.
 */
export function outputsDir(scope: ResolvedScope): string {
  const env = process.env.NIRVANA_OUTPUTS_DIR;
  if (env) {
    return path.isAbsolute(env)
      ? env
      : path.join(scope.projectRoot ?? process.cwd(), env);
  }
  if (scope.projectRoot) return path.join(scope.projectRoot, "outputs");
  return path.join(os.homedir(), ".nirvana", "outputs");
}

/**
 * Canonical directory in which to CREATE a new asset of `kind`, scope-aware.
 * `scope.{squad,business}Dirs` are filtered to *existing* dirs and ordered for
 * *reading*; this returns the single dir where a *new* asset should be written:
 *   - project / merge → `<projectRoot>/.nirvana/<kind>/` (new assets land in the
 *     project; in merge they override the global on slug clash). An explicit
 *     `NIRVANA_PROJECT_<KIND>_DIR` override wins.
 *   - global → the home source-of-truth (paths.SQUADS_DIR / BUSINESSES_DIR /
 *     DNA_LIBRARY).
 * Callers should `ensureDir()` the result. Without this, write-side scripts fall
 * back to `paths.BUSINESSES_DIR` (always global) and scaffold in the WRONG scope.
 */
export function writeDir(scope: ResolvedScope, kind: "squads" | "businesses" | "mind-clones"): string {
  const envVar = {
    squads: "NIRVANA_PROJECT_SQUADS_DIR",
    businesses: "NIRVANA_PROJECT_BUSINESSES_DIR",
    "mind-clones": "NIRVANA_PROJECT_MIND_CLONES_DIR",
  }[kind];
  if (scope.mode === "project" || scope.mode === "merge") {
    const override = process.env[envVar];
    if (override) return path.resolve(override);
    if (scope.projectRoot) return path.join(scope.projectRoot, ".nirvana", kind);
    // project mode without a root already threw in resolveScope; merge falls through.
  }
  const globalMap: Record<string, string> = {
    squads: paths.SQUADS_DIR,
    businesses: paths.BUSINESSES_DIR,
    "mind-clones": paths.DNA_LIBRARY,
  };
  return globalMap[kind];
}

export function describeScope(scope: ResolvedScope): string {
  const lines = [
    `mode: ${scope.mode}`,
    `projectRoot: ${scope.projectRoot ?? "(none)"}`,
    `squadDirs: ${scope.squadDirs.join(" → ") || "(empty)"}`,
    `businessDirs: ${scope.businessDirs.join(" → ") || "(empty)"}`,
    `mindCloneDirs: ${scope.mindCloneDirs.join(" → ") || "(empty)"}`,
  ];
  if (scope.globalInclude) lines.push(`globalIncludeOnly: ${[...scope.globalInclude].join(",")}`);
  if (scope.globalExclude.size > 0) lines.push(`globalExclude: ${[...scope.globalExclude].join(",")}`);
  return lines.join("\n");
}

// CLI: `bun scope.ts` prints the resolved scope as JSON
if (import.meta.main) {
  const scope = resolveScope();
  const flag = process.argv.includes("--explain");
  if (flag) {
    console.log(describeScope(scope));
    console.log("---");
    console.log("squads:");
    for (const e of enumerate(scope, "squads")) {
      console.log(`  ${e.slug.padEnd(40)} ${e.source}${e.overridden ? " (overridden)" : ""}  ${e.dir}`);
    }
    console.log("businesses:");
    for (const e of enumerate(scope, "businesses")) {
      console.log(`  ${e.slug.padEnd(40)} ${e.source}${e.overridden ? " (overridden)" : ""}  ${e.dir}`);
    }
  } else {
    console.log(JSON.stringify({
      mode: scope.mode,
      projectRoot: scope.projectRoot,
      squadDirs: scope.squadDirs,
      businessDirs: scope.businessDirs,
      mindCloneDirs: scope.mindCloneDirs,
      globalInclude: scope.globalInclude ? [...scope.globalInclude] : null,
      globalExclude: [...scope.globalExclude],
    }, null, 2));
  }
}
