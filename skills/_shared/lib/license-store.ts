/**
 * license-store.ts — where a paid pack's license lives on this machine.
 *
 * The store used to hold ONE file, ~/.nirvana-license/PROVENANCE.json, and every
 * pack's setup.ts wrote it. The last pack installed won: a buyer with two packs
 * kept only the second pack's key, and `nrv update <first pack>` presented that
 * key and was refused (`pack_mismatch`) unless it was a Genesis Circle key.
 *
 * Each pack now also has its own copy, ~/.nirvana-license/packs/<slug>/
 * (PROVENANCE.json and LICENSE.txt). Readers look for the pack's own file first
 * and fall back to the single legacy file, which setup.ts keeps writing exactly
 * as before so an older engine still finds a license. An install made before
 * the per-pack copies existed has only the legacy file, and keeps working.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A pack slug that is safe as one path segment. */
export function isPackSlug(slug: unknown): slug is string {
  return typeof slug === "string" && /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(slug) && !slug.includes("..");
}

export function licenseDir(home = homedir()): string {
  return join(home, ".nirvana-license");
}

/** The single file every engine reads. */
export function legacyProvenancePath(home = homedir()): string {
  return join(licenseDir(home), "PROVENANCE.json");
}

/** The pack's own folder in the store, or null for a slug that is not one. */
export function packLicenseDir(slug: string, home = homedir()): string | null {
  return isPackSlug(slug) ? join(licenseDir(home), "packs", slug) : null;
}

export function packProvenancePath(slug: string, home = homedir()): string | null {
  const dir = packLicenseDir(slug, home);
  return dir ? join(dir, "PROVENANCE.json") : null;
}

/**
 * Where to look for the license of `slug`, in order: NIRVANA_PROVENANCE, the
 * pack's own file, the legacy file, then ./PROVENANCE.json. Without a slug the
 * order is the one every engine used before (env, legacy, cwd).
 */
export function provenanceCandidates(
  slug: string | null,
  opts: { home?: string; cwd?: string; env?: Record<string, string | undefined> } = {},
): string[] {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const own = slug ? packProvenancePath(slug, home) : null;
  return [env.NIRVANA_PROVENANCE, own, legacyProvenancePath(home), join(opts.cwd ?? process.cwd(), "PROVENANCE.json")]
    .filter((p): p is string => Boolean(p));
}

/** The first candidate on disk, or null. */
export function findProvenance(slug: string | null, opts: Parameters<typeof provenanceCandidates>[1] = {}): string | null {
  return provenanceCandidates(slug, opts).find((p) => existsSync(p)) ?? null;
}

/** The packs that have their own license file. */
export function installedPackLicenses(home = homedir()): Array<{ slug: string; path: string }> {
  const root = join(licenseDir(home), "packs");
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  return names.sort()
    .filter((slug) => isPackSlug(slug) && existsSync(join(root, slug, "PROVENANCE.json")))
    .map((slug) => ({ slug, path: join(root, slug, "PROVENANCE.json") }));
}
