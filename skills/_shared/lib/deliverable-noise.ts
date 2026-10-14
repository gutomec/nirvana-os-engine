// deliverable-noise.ts — what sits beside a deliverable but was never written
// by the run: installed dependencies, build output, tool caches, lockfiles and
// the licence texts that come with third-party code.
//
// Measured on 2026-10-14 (Camila incident): a website deliverable sent
// `node_modules/@playwright/test/README.md`, `playwright-core/ThirdPartyNotices.txt`,
// `dist/assets/fonts/*-OFL.txt` and `dist/assets/vendor/GSAP-NOTICE.txt` to the
// LLM judge as prose. Twenty-six files, nine minutes of judging, none of them
// the run's work. One list, read by every place that picks the files to judge.
//
// Two kinds of directory, on purpose:
//
//   DEPENDENCY_DIRS  never the run's work, wherever they sit.
//   BUILD_DIRS       generated from the run's sources. Dropped while a source
//                    tree remains to judge; kept when they ARE the delivery (a
//                    static site delivered as `dist/` alone), so the filter can
//                    narrow noise and never empty the surface.

/** Installed dependencies, virtual environments, VCS and tool caches. */
export const DEPENDENCY_DIRS: ReadonlySet<string> = new Set([
  "node_modules", "bower_components", "jspm_packages", "vendor",
  ".git", ".hg", ".svn",
  ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".tox",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".cache", ".astro",
  "coverage", ".nyc_output",
]);

/** Build output: generated from the run's sources. */
export const BUILD_DIRS: ReadonlySet<string> = new Set(["dist", "build", "out", "target"]);

/** Lockfiles: written by a package manager, never by the run. */
export const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml",
  "Cargo.lock", "poetry.lock", "Pipfile.lock", "composer.lock", "Gemfile.lock", "uv.lock",
]);

/** Licence and notice texts. Inside a dependency or build tree they belong to
 *  third-party code; at the project's own level only the brief can make one a
 *  deliverable (see isThirdPartyLegal). */
const LEGAL_TEXT = /^(?:licen[cs]e|copying|notice|third[-_ ]?party[-_ ]?notices?|patents)(?:[-_][a-z0-9]+)?(?:\.(?:txt|md|markdown|rst|html|apache2?|mit|bsd))?$|[-_](?:ofl|licen[cs]e|notice)\.(?:txt|md)$/i;

function segmentsOf(relPath: string): string[] {
  return relPath.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
}

/** True when a directory segment of `relPath` is a dependency tree. */
export function inDependencyTree(relPath: string): boolean {
  return segmentsOf(relPath).slice(0, -1).some((s) => DEPENDENCY_DIRS.has(s));
}

/** True when a directory segment of `relPath` is build output. */
export function inBuildOutput(relPath: string): boolean {
  return segmentsOf(relPath).slice(0, -1).some((s) => BUILD_DIRS.has(s));
}

/** True for a lockfile, by basename. */
export function isLockfile(relPath: string): boolean {
  const segs = segmentsOf(relPath);
  return segs.length > 0 && LOCKFILES.has(segs[segs.length - 1]);
}

/** True for a licence or notice text, by basename (LICENSE, NOTICE.md,
 *  ThirdPartyNotices.txt, Inter-OFL.txt, GSAP-NOTICE.txt). */
export function isLegalText(relPath: string): boolean {
  const segs = segmentsOf(relPath);
  return segs.length > 0 && LEGAL_TEXT.test(segs[segs.length - 1]);
}

/**
 * True when `relPath` (relative to the folder being judged) is noise the run
 * did not write: anything inside a dependency tree, a lockfile, or a licence
 * or notice text the brief did not ask for. `named` holds the lowercase
 * basenames the brief names (delivery-pipeline briefNamedFiles): a LICENSE.md
 * the brief asked for is the run's own work and stays.
 *
 * Build output is NOT decided here: it is noise only while a source tree is
 * left to judge, which only the caller can know (see BUILD_DIRS).
 */
export function isDependencyNoise(relPath: string, named: ReadonlySet<string> = new Set()): boolean {
  if (inDependencyTree(relPath) || isLockfile(relPath)) return true;
  if (!isLegalText(relPath)) return false;
  const segs = segmentsOf(relPath);
  const base = segs[segs.length - 1].toLowerCase();
  if (inBuildOutput(relPath)) return true;
  return !named.has(base);
}

/** True when a directory with this name can be skipped whole by a walker that
 *  only looks for the run's work (never build output: see BUILD_DIRS). */
export function isDependencyDirName(name: string): boolean {
  return DEPENDENCY_DIRS.has(name);
}
