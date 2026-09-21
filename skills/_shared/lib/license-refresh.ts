/**
 * Whether an update may replace the license already on disk.
 *
 * `nrv update <pack>` refreshes the license store from the PROVENANCE.json the
 * downloaded zip carries, which repairs a store that is missing, stale or from
 * an older purchase. The store holds ONE file, so that refresh is only ever a
 * repair when both speak about the same edition.
 *
 * It used to write unconditionally, and that was destructive: updating a single
 * pack replaced whatever license was there with the edition of that pack. A
 * buyer whose license was a bundle ran `nrv update <one vertical>` and came out
 * holding a license for that vertical alone — every other pack then answered
 * `pack_mismatch` to every later update, and the packs they had paid for stopped
 * being updatable. The failure surfaced on the next command, far from the one
 * that caused it.
 *
 * The rule, therefore:
 *
 *   no usable local license  → refresh (the repair this exists for)
 *   same edition, newer      → refresh
 *   same edition, same/older → keep (nothing to repair)
 *   different edition        → keep, and say so; switching stays deliberate
 */
import { existsSync, readFileSync } from "node:fs";

/** Numeric compare of dotted versions; unparsable parts fall back to a string compare. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface LicenseRefreshDecision {
  refresh: boolean;
  reason: string;
}

export function decideLicenseRefresh(
  licPath: string,
  incoming: Record<string, unknown>,
): LicenseRefreshDecision {
  const incomingEdition = String(incoming.edition ?? "");
  const incomingVersion = String(incoming.version ?? "");

  if (!existsSync(licPath)) {
    return { refresh: true, reason: `no license on this machine yet (${incomingEdition})` };
  }

  let current: Record<string, unknown>;
  try {
    current = JSON.parse(readFileSync(licPath, "utf8"));
  } catch {
    return { refresh: true, reason: "the license on this machine is unreadable" };
  }
  if (!current?.license_key) {
    return { refresh: true, reason: "the license on this machine carries no license_key" };
  }

  const currentEdition = String(current.edition ?? "");
  const currentVersion = String(current.version ?? "");

  if (currentEdition !== incomingEdition) {
    return {
      refresh: false,
      reason:
        `the license here is '${currentEdition}', the pack is '${incomingEdition}'` +
        ` — run 'nrv license install <folder>' to switch`,
    };
  }
  if (compareVersions(incomingVersion, currentVersion) < 0) {
    return { refresh: false, reason: `the license here is already newer (${currentVersion} > ${incomingVersion})` };
  }
  if (incomingVersion === currentVersion) {
    return { refresh: false, reason: `already current (${currentEdition} ${currentVersion})` };
  }
  return { refresh: true, reason: `${currentEdition} ${currentVersion} → ${incomingVersion}` };
}
