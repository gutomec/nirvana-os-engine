// surface-diff.ts — compara duas superfícies de contrato e deriva a lista de
// mudanças tipada + o bump de versão.
//
// Regra de ouro: a severidade não é opinião de quem escreveu, é consequência
// estrutural. Um id que sumiu quebra quem o invoca, ponto. Isso é o que permite
// gerar `CHANGES.json` sem depender de ninguém lembrar de descrever a mudança.
//
// O único tipo que a máquina NÃO consegue derivar é comportamento: mesma
// interface, resultado diferente. Esse fica como anotação opcional (ver
// `mergeBehaviorNotes`), e é deliberadamente a exceção, não a regra.

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
  /** Identificador afetado, na forma `capability:x` / `employee:y`. */
  id: string;
  /** Preenchidos em `renamed` e `rebound`. */
  from?: string;
  to?: string;
  severity: Severity;
  detail: string;
  /** O que quem consome precisa fazer. Vazio quando nada é exigido. */
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
 * Renomear é um id que sai e outro que entra com o MESMO corpo e o MESMO tipo.
 * Detectar isso importa porque a migração é trivial (troque o id) e a mensagem
 * "removido + adicionado" esconderia exatamente essa informação.
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

  // Sem superfície anterior o artefato é novo para quem recebe: nada a migrar.
  //
  // O mesmo vale quando o SCHEMA mudou: uma melhoria no extrator altera hashes de
  // artefatos que ninguém tocou, e comparar entre schemas produziria uma enxurrada
  // de mudanças fantasma em todo comprador. Nesse caso a base é reestabelecida em
  // silêncio, que é o comportamento honesto: o engine não sabe o que mudou de
  // verdade, então não inventa.
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

    // Ligação trocada: o id continua, mas aponta para outro alvo. É a quebra mais
    // traiçoeira porque nada falha na resolução — só o resultado muda.
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
 * Mudança de comportamento é o único tipo que nenhum diff estrutural enxerga:
 * mesma interface, resultado diferente. Fica como anotação humana opcional, lida
 * de `.nirvana-behavior.md` no artefato, e some do arquivo depois de absorvida
 * pelo build (para não repetir no release seguinte).
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

/** Markdown legível GERADO a partir das mudanças. Nunca é fonte, sempre saída. */
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
