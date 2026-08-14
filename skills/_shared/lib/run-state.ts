/**
 * What is run state, and therefore never content.
 *
 * When a squad or a business executes, it writes beside itself: `projects/`,
 * `outputs/`, `.squad-state/`, a business's `memory/projects/`. That is the
 * user's work, and three places in the engine already knew to leave it alone —
 * install-content.ts when overlaying a pack, uninstall-pack.ts when removing
 * one, install.ts when seeding the starter. Each carried its own copy of the
 * list.
 *
 * The pack builder had no copy at all, so it shipped run state INTO the product:
 * base/web-design.zip on the shelf right now carries 14 `.squad-state` entries
 * from a run on the author's machine, absolute home paths included. The gate
 * that should have caught it printed a number and let the build continue.
 *
 * One list, four consumers. A directory that is run state on install is run
 * state at build time too — there was never a reason for those to be different
 * lists, only an accident that they were.
 */
export const RUN_STATE_EXCLUDES: Record<string, string[]> = {
  squads: ["projects", "outputs", ".squad-state", ".squads-outputs", ".wiki-brain-state", ".vercel", ".omc", "_internal"],
  businesses: ["memory/projects", "memory/learned.md", ".squad-state", ".squads-outputs", ".vercel"],
  "mind-clones": [],
};

/** Every run-state name, flattened — for callers that filter by path segment. */
export const RUN_STATE_NAMES: string[] = [
  ...new Set(Object.values(RUN_STATE_EXCLUDES).flat().map((p) => p.split("/")[0])),
];

/**
 * True when a path sits inside run state. Takes a path RELATIVE to the
 * component root, with either separator.
 */
export function isRunStatePath(rel: string): boolean {
  const segs = rel.split(/[\\/]/);
  return segs.some((s) => RUN_STATE_NAMES.includes(s));
}
