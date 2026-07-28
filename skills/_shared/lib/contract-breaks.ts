// contract-breaks.ts — helper compartilhado pelos DOIS caminhos de instalação.
//
// Existe por um motivo específico: `scripts/install.ts` (bootstrap) e
// `skills/_shared/scripts/install-content.ts` (instalação/atualização de pack)
// têm cada um a sua cópia de `syncKind`, com a mesma lógica escrita duas vezes.
// Essa duplicação já custou caro: a primeira versão desta feature entrou só no
// bootstrap, e o caminho que o COMPRADOR usa para atualizar teria ficado sem
// aviso nenhum de quebra de contrato.
//
// Manter a comparação aqui garante que os dois relatem exatamente a mesma coisa.

import { readSurface } from "./surface.ts";
import { diffSurfaces } from "./surface-diff.ts";

export interface BreakingChange {
  /** Rótulo já qualificado, no formato `squads/brandcraft`. */
  slug: string;
  detail: string;
  migration?: string;
}

/**
 * Compara o contrato instalado com o que está chegando e devolve só as quebras.
 *
 * DEVE ser chamado ANTES de sobrescrever: é o único instante em que as duas
 * superfícies coexistem em disco. Depois do mirror, a antiga deixou de existir.
 *
 * Falha em silêncio de propósito. Pack anterior à superfície, componente criado
 * pelo usuário e artefato de schema antigo simplesmente não têm o que comparar,
 * e nada disso justifica atrapalhar uma instalação que de resto está correta.
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

/** Bloco de relatório idêntico nos dois instaladores. */
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
