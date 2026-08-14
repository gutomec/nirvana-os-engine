/**
 * watermark-scan.ts — finds per-buyer attribution tags in a content library.
 *
 * Every paid copy carries an HMAC tag identifying its owner, written as a benign
 * comment ALONE on the last line of ~60 files: `//<22>` in .ts/.js, `[//]: # (<22>)`
 * in .md, `#<22>` in .yaml. It exists so a leaked copy can be attributed.
 *
 * The hazard is directional. On a buyer's machine those tags are correct and
 * expected. On a machine that AUTHORS packs, the same tags sitting in ~/squads or
 * ~/businesses are one build away from the base pack — and a tag that ships makes
 * every buyer's leak attribute to the author, destroying the attribution it exists
 * to provide. That happened here: `nrv update` pulled per-buyer content into both
 * libraries and it went unnoticed for a day, because nothing looked.
 *
 * Two call sites share this: `nrv doctor` (is my system healthy) and the end of
 * `nrv update` (the command that introduces it), so contamination is reported
 * seconds after it lands rather than a day later.
 *
 * Only the FILE TAIL is read. The tag is always alone on the last line, so the last
 * 200 bytes answer the question — scanning 13k files whole would cost seconds for
 * information already in hand.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** A line that is NOTHING BUT the tag. Prose mentioning such a string is not a tag. */
export const WATERMARK_RE = /^(\/\/[A-Za-z0-9_-]{22}|\[\/\/\]: # \([A-Za-z0-9_-]{22}\)|#[A-Za-z0-9_-]{22})$/;

// The six the watermarker writes. This set had five: `.markdown` was missing,
// so a `.markdown` file could be stamped by the store, pulled back in by
// `nrv update`, and stay invisible to the very check that exists to catch that.
// Latent today — the library has no `.markdown` file — and one is all it takes
// to reopen the hole that shipped in 0.1.12-0.1.14.
const EXTS = new Set([".md", ".markdown", ".ts", ".js", ".yaml", ".yml"]);

// `dist` used to be here. On a pack-authoring machine that is precisely where
// packs are BUILT, so the scan structurally could not see the artifacts it is
// meant to protect — `authorsPacks()` detects the authoring machine by the
// existence of ~/nirvana-packs, and then skipped that machine's output.
const SKIP_DIRS = new Set(["node_modules", ".git", "outputs"]);

export interface ScanResult {
  /** Files whose last line is a watermark tag. */
  hits: string[];
  /** Files actually inspected. */
  scanned: number;
  /** True when the walk stopped at the budget — the count is a floor, not a total. */
  truncated: boolean;
}

export function fileHasWatermark(file: string): boolean {
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return false;
    const len = Math.min(size, 200);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(len);
    try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
    return buf.toString("utf8").split("\n").some(l => WATERMARK_RE.test(l.trim()));
  } catch { return false; }
}

/** Walk a content library. `budget` bounds the cost on pathological trees. */
export function scanLibrary(root: string, budget = 20000): ScanResult {
  const hits: string[] = [];
  let scanned = 0;
  let truncated = false;

  const walk = (dir: string): void => {
    if (scanned >= budget) { truncated = true; return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (scanned >= budget) { truncated = true; return; }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".runs")) continue;
        walk(path.join(dir, e.name));
        continue;
      }
      if (!EXTS.has(path.extname(e.name))) continue;
      scanned++;
      const full = path.join(dir, e.name);
      if (fileHasWatermark(full)) hits.push(full);
    }
  };

  if (fs.existsSync(root)) walk(root);
  return { hits, scanned, truncated };
}

/**
 * True when this machine authors packs — the only place a tag in the library is a
 * defect rather than the normal state of purchased content.
 */
export function authorsPacks(home: string): boolean {
  return fs.existsSync(process.env.NIRVANA_PACKS_DIR || path.join(home, "nirvana-packs"));
}

/** The command that fixes it, quoted the same way everywhere it is reported. */
export const STRIP_HINT =
  "node ~/squads-sh-v2/scripts/strip-base-watermarks.mjs <dir> (then --check must report 0)";
