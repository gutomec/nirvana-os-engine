// surface-diff.ts — compares two contract surfaces and derives the typed
// change list + the version bump.
//
// Golden rule: severity is not the author's opinion, it is a structural
// consequence. An id that vanished breaks its invokers, period. That is what
// allows generating `CHANGES.json` without relying on anyone remembering to
// describe the change.
//
// The only kind the machine CANNOT derive is behavior: same interface,
// different result. It stays as an optional annotation (see
// `mergeBehaviorNotes`), and is deliberately the exception, not the rule.

import type { Surface, SurfaceEntry } from "./surface.ts";

export type Severity = "breaking" | "additive" | "patch";

export type ChangeType =
  | "removed"
  | "added"
  | "renamed"
  | "rebound"
  | "routing_lost"
  | "routing_gained"
  | "content_changed"
  | "prose_changed"
  | "behavior_changed";

export interface Change {
  type: ChangeType;
  /** Affected identifier, in the `capability:x` / `employee:y` form. */
  id: string;
  /** Filled in for `renamed` and `rebound`. */
  from?: string;
  to?: string;
  severity: Severity;
  detail: string;
  /** What the consumer needs to do. Empty when nothing is required. */
  migration?: string;
}

export interface DiffResult {
  changes: Change[];
  bump: "major" | "minor" | "patch" | "none";
  from_version: string;
  next_version: string;
  breaking: number;
}

const RANK: Record<Severity, number> = { patch: 0, additive: 1, breaking: 2 };

function bumpVersion(version: string, bump: DiffResult["bump"]): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return version;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  return version;
}

/** `capability:x.y.z` → `capability`. */
function typeOf(id: string): string {
  return id.split(":", 1)[0];
}

function label(id: string): string {
  return id.slice(id.indexOf(":") + 1);
}

/**
 * A rename is one id leaving and another entering with the SAME body and the
 * SAME type. Detecting it matters because the migration is trivial (swap the
 * id) and a "removed + added" message would hide exactly that information.
 */
function detectRenames(
  removed: string[],
  added: string[],
  oldEntries: Record<string, SurfaceEntry>,
  newEntries: Record<string, SurfaceEntry>,
): Array<{ from: string; to: string }> {
  const pairs: Array<{ from: string; to: string }> = [];
  const takenAdded = new Set<string>();
  for (const r of removed) {
    const oe = oldEntries[r];
    const match = added.find(
      (a) => !takenAdded.has(a) && newEntries[a].type === oe.type && newEntries[a].hash === oe.hash,
    );
    if (match) {
      takenAdded.add(match);
      pairs.push({ from: r, to: match });
    }
  }
  return pairs;
}

export function diffSurfaces(before: Surface | null, after: Surface): DiffResult {
  const changes: Change[] = [];

  // With no previous surface the artifact is new to the receiver: nothing to
  // migrate.
  //
  // The same holds when the SCHEMA changed: an extractor improvement alters
  // hashes of artifacts nobody touched, and comparing across schemas would
  // produce a flood of phantom changes for every buyer. In that case the
  // baseline is silently re-established, which is the honest behavior: the
  // engine does not know what truly changed, so it does not make it up.
  if (!before || before.schema !== after.schema) {
    return {
      changes: [],
      bump: "none",
      from_version: after.contract_version,
      next_version: after.contract_version,
      breaking: 0,
    };
  }

  const oldKeys = Object.keys(before.entries);
  const newKeys = Object.keys(after.entries);
  const removed = oldKeys.filter((k) => !(k in after.entries));
  const added = newKeys.filter((k) => !(k in before.entries));

  const renames = detectRenames(removed, added, before.entries, after.entries);
  const renamedFrom = new Set(renames.map((r) => r.from));
  const renamedTo = new Set(renames.map((r) => r.to));

  for (const { from, to } of renames) {
    changes.push({
      type: "renamed",
      id: from,
      from: label(from),
      to: label(to),
      severity: "breaking",
      detail: `${typeOf(from)} renomeado: ${label(from)} → ${label(to)}`,
      migration: `substitua as referências a "${label(from)}" por "${label(to)}"`,
    });
  }

  for (const k of removed) {
    if (renamedFrom.has(k)) continue;
    changes.push({
      type: "removed",
      id: k,
      severity: "breaking",
      detail: `${typeOf(k)} removido: ${label(k)}`,
      migration: `quem invocava "${label(k)}" precisa de substituto; não há equivalente automático`,
    });
  }

  for (const k of added) {
    if (renamedTo.has(k)) continue;
    changes.push({
      type: "added",
      id: k,
      severity: "additive",
      detail: `${typeOf(k)} novo: ${label(k)}`,
    });
  }

  for (const k of newKeys) {
    const oe = before.entries[k];
    const ne = after.entries[k];
    if (!oe) continue;

    // Swapped binding: the id stays, but points at another target. It is the
    // most treacherous break because nothing fails at resolution — only the
    // result changes.
    if ((oe.binding ?? null) !== (ne.binding ?? null)) {
      changes.push({
        type: "rebound",
        id: k,
        from: oe.binding ?? "(nenhuma)",
        to: ne.binding ?? "(nenhuma)",
        severity: "breaking",
        detail: `${label(k)} passou a apontar para outro alvo: ${oe.binding ?? "(nenhuma)"} → ${ne.binding ?? "(nenhuma)"}`,
        migration: "revise o que espera desta invocação; o destino mudou",
      });
    }

    const oldRouting = new Set(oe.routing ?? []);
    const newRouting = new Set(ne.routing ?? []);
    const lost = [...oldRouting].filter((r) => !newRouting.has(r));
    const gained = [...newRouting].filter((r) => !oldRouting.has(r));

    if (lost.length) {
      changes.push({
        type: "routing_lost",
        id: k,
        severity: "breaking",
        detail: `${label(k)} perdeu roteamento: ${lost.join(", ")}`,
        migration: "quem selecionava por esses rótulos deixa de encontrar esta capability",
      });
    }
    if (gained.length) {
      changes.push({
        type: "routing_gained",
        id: k,
        severity: "additive",
        detail: `${label(k)} ganhou roteamento: ${gained.join(", ")}`,
      });
    }

    if (oe.hash !== ne.hash) {
      changes.push({
        type: "content_changed",
        id: k,
        severity: "patch",
        detail: `${label(k)} teve o corpo alterado (interface intacta)`,
      });
    }
  }

  if (before.prose_hash !== after.prose_hash) {
    changes.push({
      type: "prose_changed",
      id: `${after.kind}:${after.slug}`,
      severity: "patch",
      detail: "descrições, exemplos ou keywords de descoberta mudaram (afeta roteamento semântico, não invocação)",
    });
  }

  const worst = changes.reduce<Severity | null>(
    (acc, c) => (acc === null || RANK[c.severity] > RANK[acc] ? c.severity : acc),
    null,
  );
  const bump: DiffResult["bump"] =
    worst === "breaking" ? "major" : worst === "additive" ? "minor" : worst === "patch" ? "patch" : "none";

  changes.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.id.localeCompare(b.id));

  return {
    changes,
    bump,
    from_version: before.contract_version,
    next_version: bumpVersion(before.contract_version, bump),
    breaking: changes.filter((c) => c.severity === "breaking").length,
  };
}

/**
 * A behavior change is the only kind no structural diff can see: same
 * interface, different result. It stays as an optional human annotation, read
 * from `.nirvana-behavior.md` in the artifact, and disappears from the file
 * once absorbed by the build (so it does not repeat in the next release).
 */
export function mergeBehaviorNotes(result: DiffResult, notes: string[]): DiffResult {
  if (!notes.length) return result;
  const extra: Change[] = notes.map((n) => ({
    type: "behavior_changed" as const,
    id: "behavior",
    severity: "breaking" as const,
    detail: n,
    migration: "revise projetos que dependiam do comportamento anterior",
  }));
  const changes = [...extra, ...result.changes];
  return {
    ...result,
    changes,
    breaking: changes.filter((c) => c.severity === "breaking").length,
    bump: "major",
    next_version: bumpVersion(result.from_version, "major"),
  };
}

/** Readable markdown GENERATED from the changes. Never a source, always output. */
export function renderChangelogEntry(slug: string, result: DiffResult): string {
  if (!result.changes.length) return "";
  const icon: Record<Severity, string> = { breaking: "QUEBRA", additive: "novo", patch: "ajuste" };
  const lines = [`## ${result.next_version}`, ""];
  for (const sev of ["breaking", "additive", "patch"] as Severity[]) {
    const group = result.changes.filter((c) => c.severity === sev);
    if (!group.length) continue;
    lines.push(`### ${icon[sev]}`, "");
    for (const c of group) {
      lines.push(`- ${c.detail}${c.migration ? `\n  - migração: ${c.migration}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
