// contract-breaks.ts — helper shared by BOTH install paths.
//
// It exists for a specific reason: `scripts/install.ts` (bootstrap) and
// `skills/_shared/scripts/install-content.ts` (pack install/update) each carry
// their own copy of `syncKind`, with the same logic written twice.
// That duplication already cost us: the first version of this feature landed
// only in the bootstrap, and the path the BUYER uses to update would have
// shipped with no contract-break warning at all.
//
// Keeping the comparison here guarantees both report exactly the same thing.

import { readSurface } from "./surface.ts";
import { diffSurfaces } from "./surface-diff.ts";

export interface BreakingChange {
  /** Already-qualified label, in the `squads/brandcraft` format. */
  slug: string;
  detail: string;
  migration?: string;
}

/**
 * Compares the installed contract with the incoming one and returns only the breaks.
 *
 * MUST be called BEFORE overwriting: it is the only instant when both
 * surfaces coexist on disk. After the mirror, the old one no longer exists.
 *
 * Fails silently on purpose. A pack predating the surface, a user-created
 * component and an old-schema artifact simply have nothing to compare, and
 * none of that justifies disrupting an otherwise correct installation.
 */
export function contractBreaks(installedDir: string, incomingDir: string, label: string): BreakingChange[] {
  try {
    const before = readSurface(installedDir);
    const after = readSurface(incomingDir);
    if (!before || !after) return [];
    return diffSurfaces(before, after).changes
      .filter((c) => c.severity === "breaking")
      .map((c) => ({ slug: label, detail: c.detail, migration: c.migration }));
  } catch {
    return [];
  }
}

/** Report block identical in both installers. */
export function reportBreaks(breaks: BreakingChange[], dry: boolean, log: (s: string) => void): void {
  if (!breaks.length) return;
  log("");
  log(`  ATENÇÃO: ${breaks.length} mudança(s) de contrato ${dry ? "seriam aplicadas" : "aplicadas"} nesta atualização.`);
  log("  Projetos que dependiam dos itens abaixo precisam de ajuste:");
  for (const b of breaks) {
    log(`    ! ${b.slug}: ${b.detail}`);
    if (b.migration) log(`      → ${b.migration}`);
  }
  log("  Detalhe completo em CHANGES.json dentro de cada componente.");
}
