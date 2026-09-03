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
 *
 * `.runs` was missing from this list until a rebuild was inspected file by file:
 * `brandcraft/.runs/` holds 64 files and 36 MB of leftover Remotion renders from
 * two runs on the author's machine, and it was shipping inside four packs. The
 * name appeared in three private exclusion lists — the pack assembler's `find`,
 * a manual rsync, the reconciler — and in the one list that four consumers read,
 * it did not.
 *
 * `SQUAD-DOCTOR-REPORT.md` is here for the same reason, though it is a file and
 * looks authored: the doctor used to write it into the squad directory, so it
 * travelled into the packs. Eighteen of them are sitting in built artifacts
 * right now — a diagnostic about the seller's machine, in the buyer's product.
 * It is also stamped with a fresh timestamp on every run, which made any two
 * copies of a squad disagree forever. The doctor now writes under
 * `.nirvana/state/squads/<slug>/`; this entry stops the old ones travelling.
 */
export const RUN_STATE_EXCLUDES: Record<string, string[]> = {
  // `.nirvana` is project state, never squad content: running any `nrv` command
  // with the cwd inside a squad materializes one there, carrying the machine's
  // registries and routing digest — which hold absolute paths into the author's
  // home. Measured 2026-09-03: 3 squads in the live library had picked one up
  // during an audit campaign, and the list did not exclude it, so the next build
  // would have shipped the author's paths to every buyer.
  squads: ["projects", "outputs", ".runs", ".nirvana", ".squad-state", ".squads-outputs", ".wiki-brain-state", ".vercel", ".omc", "_internal", "SQUAD-DOCTOR-REPORT.md"],
  businesses: ["memory/projects", "memory/learned.md", ".nirvana", ".squad-state", ".squads-outputs", ".vercel"],
  "mind-clones": [],
};

/** Every run-state name, flattened — for callers that filter by path segment. */
export const RUN_STATE_NAMES: string[] = [
  ...new Set(Object.values(RUN_STATE_EXCLUDES).flat().map((p) => p.split("/")[0])),
];

/**
 * True when a path sits inside run state. Takes a path RELATIVE to the
 * component root, with either separator.
 *
 * Pass `kind` whenever you know it. Without it the check falls back to
 * RUN_STATE_NAMES, which is the FIRST SEGMENT of each entry — and for a business
 * that first segment is `memory`, from `memory/projects`. Matching on the bare
 * name therefore excluded the whole `memory/` directory, so every pack shipped
 * its businesses without `memory/permanent.md`: the file the business protocol
 * documents as the long-term knowledge every employee reads as authoritative
 * context. Forty-six businesses, silently, in every pack on the shelf.
 *
 * With `kind`, an entry is matched as a contiguous run of path segments, so
 * `memory/projects` excludes exactly that and leaves `memory/permanent.md`
 * alone.
 */
export function isRunStatePath(rel: string, kind?: keyof typeof RUN_STATE_EXCLUDES): boolean {
  const segs = rel.split(/[\\/]/).filter(Boolean);
  if (!kind) return segs.some((s) => RUN_STATE_NAMES.includes(s));
  return (RUN_STATE_EXCLUDES[kind] ?? []).some((entry) => {
    const parts = entry.split("/").filter(Boolean);
    for (let i = 0; i + parts.length <= segs.length; i++) {
      if (parts.every((p, j) => segs[i + j] === p)) return true;
    }
    return false;
  });
}
