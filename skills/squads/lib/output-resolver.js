/**
 * Squad Output Resolver — Skill-owned path resolution for squad artifacts.
 *
 * Convention: {project-root}/.squads-outputs/{squad-name}/{timestamp}-{slug}/
 *
 * The SKILL (not the squad) decides where outputs go. Squads that declare
 * `output:` in squad.yaml are silently ignored — this resolver is authoritative.
 *
 * Usage:
 *   const { OutputResolver } = require('./output-resolver');
 *   const resolver = new OutputResolver();
 *   const runDir = resolver.resolveRunDir('nirvana-video-creator', 'hormozi-reel');
 *   // → <cwd>/.squads-outputs/nirvana-video-creator/2026-04-05T185600-hormozi-reel/
 */

const fs = require('fs');
const path = require('path');
const projectRootLib = require('../../_shared/lib/project-root.js');

const OUTPUT_DIR_NAME = '.squads-outputs';

// Kept intentionally in sync with _shared/lib/scope.ts SCOPE_MARKERS so this
// resolver picks the SAME project root as the rest of the system.
const PROJECT_ROOT_MARKERS = [
  '.env',
  '.nirvana',
  '.git',
  'package.json',
  'pyproject.toml',
];

const README_TEMPLATE = `# Squad Outputs

This directory contains intermediate artifacts produced by AI agent squads.
Each subdirectory is a squad, and each run gets a timestamped folder.

Structure: \`{squad-name}/{YYYY-MM-DDTHHMMSS}-{slug}/\`

These are **working artifacts** — move final deliverables to your project's
appropriate directory when ready. You may delete old runs freely.

Managed by: Squad Protocol Engine v4.1 (skill: squads)
Convention: §16bis of SQUAD_PROTOCOL_V4.md
`;

class OutputResolver {
  /**
   * Resolve the project root directory.
   * Priority: $NIRVANA_PROJECT_ROOT > $SQUADS_PROJECT_ROOT > walk-up to marker > cwd()
   * Root detection is intentionally kept in sync with _shared/lib/scope.ts.
   */
  resolveProjectRoot(startDir) {
    // 1. Environment variable override (NIRVANA_PROJECT_ROOT wins, matching scope.ts)
    const nirvanaRoot = process.env.NIRVANA_PROJECT_ROOT;
    if (nirvanaRoot && fs.existsSync(nirvanaRoot)) {
      return path.resolve(nirvanaRoot);
    }
    const envRoot = process.env.SQUADS_PROJECT_ROOT;
    if (envRoot && fs.existsSync(envRoot)) {
      return path.resolve(envRoot);
    }

    // 2. Walk up from startDir until finding a project marker. Delegates to
    // project-root.js (the one implementation — shared with scope.ts,
    // paths.js, log-paths.ts, handoff.js, wiki-lint.js): HOME/root exclusion
    // through a canonical realpath compare, not the raw `current !== home`
    // string compare this resolver used to do — which never recognized HOME
    // on a Windows 8.3 short path, and read only `$HOME`, unset on a native
    // Windows shell (PowerShell/cmd.exe use `%USERPROFILE%`), silently
    // disabling the guard there.
    const start = path.resolve(startDir || process.cwd());
    const found = projectRootLib.findProjectRoot(start, { markers: PROJECT_ROOT_MARKERS });
    if (found) return found;

    // 3. Fallback to startDir, but never HOME or fs root — fall through to cwd.
    if (!projectRootLib.isInvalidProjectRoot(start)) return start;
    const cwd = path.resolve(process.cwd());
    return !projectRootLib.isInvalidProjectRoot(cwd) ? cwd : start;
  }

  /**
   * Resolve the output root directory: {project-root}/.squads-outputs/
   */
  resolveOutputRoot(projectRoot) {
    return path.join(projectRoot || this.resolveProjectRoot(), OUTPUT_DIR_NAME);
  }

  /**
   * Generate ISO timestamp string: YYYY-MM-DDTHHMMSS
   */
  generateTimestamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  /**
   * Slugify a string for directory names.
   */
  slugify(text) {
    if (!text) return `run-${Date.now()}`;
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50) || `run-${Date.now()}`;
  }

  /**
   * Resolve the full run directory path.
   *
   * Three modes based on squad.yaml `output.base_dir`:
   *   - absent  → default (.squads-outputs/{squad}/{timestamp}-{slug}/)
   *   - "default" → same as absent
   *   - custom path → {project-root}/{custom-path}/{squad}/{timestamp}-{slug}/
   *
   * @param {string} squadName - Squad name (from squad.yaml name field)
   * @param {string} [slug] - Human-readable slug for this run
   * @param {object} [options]
   * @param {string} [options.startDir] - Starting directory for project root detection
   * @param {string} [options.baseDir] - Value of squad.yaml output.base_dir (absent/null/"default"/custom)
   * @returns {string} Full absolute path to the run directory
   */
  resolveRunDir(squadName, slug, options = {}) {
    const { startDir, baseDir } = typeof options === 'string'
      ? { startDir: options, baseDir: undefined }  // backward compat: resolveRunDir(name, slug, startDir)
      : options;

    const projectRoot = this.resolveProjectRoot(startDir);
    const timestamp = this.generateTimestamp();
    const safeSlug = this.slugify(slug);
    const runDirName = `${timestamp}-${safeSlug}`;

    // Determine output root: default or custom
    let outputRoot;
    if (!baseDir || baseDir === 'default') {
      // Default convention: .squads-outputs/
      outputRoot = this.resolveOutputRoot(projectRoot);
    } else {
      // Custom: squad developer chose a specific path
      outputRoot = path.isAbsolute(baseDir)
        ? baseDir
        : path.join(projectRoot, baseDir);
    }

    return path.join(outputRoot, squadName, runDirName);
  }

  /**
   * Create the run directory and ensure README.md exists at output root.
   * @param {string} runDir - Path from resolveRunDir()
   * @returns {string} The created runDir path
   */
  ensureRunDir(runDir) {
    fs.mkdirSync(runDir, { recursive: true });
    this.ensureReadme(path.dirname(path.dirname(runDir)));
    return runDir;
  }

  /**
   * Auto-create README.md at .squads-outputs/ root for AI discoverability.
   */
  ensureReadme(outputRoot) {
    const readmePath = path.join(outputRoot, 'README.md');
    if (!fs.existsSync(readmePath)) {
      fs.writeFileSync(readmePath, README_TEMPLATE, 'utf-8');
    }
  }

  /**
   * List all runs for a squad.
   * @param {string} squadName
   * @param {string} [startDir]
   * @returns {string[]} Array of run directory paths, sorted newest first
   */
  listRuns(squadName, startDir) {
    const outputRoot = this.resolveOutputRoot(this.resolveProjectRoot(startDir));
    const squadDir = path.join(outputRoot, squadName);
    if (!fs.existsSync(squadDir)) return [];
    return fs.readdirSync(squadDir)
      .filter(d => fs.statSync(path.join(squadDir, d)).isDirectory())
      .sort()
      .reverse()
      .map(d => path.join(squadDir, d));
  }

  /**
   * Get the latest run directory for a squad.
   * @param {string} squadName
   * @param {string} [startDir]
   * @returns {string|null}
   */
  latestRun(squadName, startDir) {
    const runs = this.listRuns(squadName, startDir);
    return runs.length > 0 ? runs[0] : null;
  }
}

module.exports = { OutputResolver, OUTPUT_DIR_NAME, PROJECT_ROOT_MARKERS };
