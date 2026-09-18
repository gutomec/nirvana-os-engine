/**
 * Walking a component without walking out of it.
 *
 * A component's `node_modules` is a LINK to the shared store (`~/.nirvana`,
 * Rule 12), not content the component owns. Following it is wrong in three ways
 * that all showed up at once:
 *
 *   - `hashDir` folded the whole store into the component's hash, so a squad
 *     nobody had touched read as "changed on disk" on every update;
 *   - `mirror`'s deletion pass listed the store's files as candidates and would
 *     `rmSync` paths inside it;
 *   - the pre-overlay backup recreated the link instead of copying it, and on
 *     Windows creating one needs a privilege most buyers do not have — EPERM
 *     killed the overlay after the pack had already been downloaded.
 *
 * So links are skipped. `lstatSync` and never `statSync`: the link is the thing
 * being judged, and `statSync` resolves it. On Windows a directory junction
 * answers `isSymbolicLink() === true`, which is what makes this work for the
 * layout the engine itself creates.
 */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** True when `p` is a link (symlink or Windows directory junction), false when absent. */
export function isLinked(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Every FILE under `root`, as paths relative to it with `/` separators, in no
 * particular order. Directories are descended; links (of any kind) are not
 * entered and not reported. An absent root yields an empty list, not an error.
 */
export function listFilesRel(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, base: string) => {
    for (const e of readdirSync(d)) {
      const abs = join(d, e);
      const rel = base ? `${base}/${e}` : e;
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  };
  if (existsSync(root)) walk(root, "");
  return out;
}
