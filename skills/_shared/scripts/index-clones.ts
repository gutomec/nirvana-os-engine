#!/usr/bin/env bun
/**
 * index-clones.ts — build the mind-clone registry (.mind-clones-registry.json).
 *
 * Parallel to index-squads / index-businesses, which `nrv index` lacked for
 * clones. Walks the scope-resolved mind-clone library (scope.mindCloneDirs),
 * parses each canonical clone's MANIFEST.yaml, detects its persona files, and
 * writes a registry the unified resolver + task→clone search consume. Flat
 * layout: one dir per slug; the drive category lives in .pack-categories.json
 * (metadata, not path). The `match` block (one_liner / domains / when_to_use)
 * is left enrichable — populated from MANIFEST `routing:` if present, empty
 * otherwise, so the personal enrichment pass fills it incrementally.
 *
 * Scope: global → ~/.nirvana/.mind-clones-registry.json; project/merge →
 * <projectRoot>/.nirvana/.mind-clones-registry.json (project clones override).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { paths, parseArgs, EXIT } from "../lib/bun-helpers.ts";
import { resolveScope } from "../lib/scope.ts";

const YAML = require("yaml");

const { flags } = parseArgs();
const quiet = !!flags.quiet || !!flags.q;

const scope = resolveScope();
const roots = scope.mindCloneDirs.length ? scope.mindCloneDirs : [paths.DNA_LIBRARY];

const registryDir = scope.projectRoot
  ? path.join(scope.projectRoot, ".nirvana")
  : path.join(os.homedir(), ".nirvana");
const registryPath = path.join(registryDir, ".mind-clones-registry.json");

/**
 * slug → drive category, gravado ao lado da biblioteca (pelo installer, no
 * install de pack/clone). Resolvido POR ROOT: em scope de projeto os clones
 * ficam em <projeto>/.nirvana/mind-clones, com o mapa deles próprio — ler só
 * o global perderia a categoria de todo clone de projeto.
 */
function loadCatMap(root: string): Record<string, string> {
  const p = path.join(root, ".pack-categories.json");
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* ignore */ }
  }
  return {};
}

function readManifest(dir: string): any | null {
  for (const n of ["MANIFEST.yaml", "manifest.yaml"]) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) {
      try { return YAML.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
    }
  }
  return null;
}

function firstExisting(dir: string, rels: string[]): string | null {
  for (const r of rels) {
    const p = path.join(dir, r);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const clones: Record<string, any> = {};
let scanned = 0;
let legacyNested = 0;

function addClone(slug: string, dir: string, m: any, packCategory: string | null): void {
  scanned++;
  if (clones[slug]) return; // first wins: flat antes de aninhado, projeto antes de global
  const man = m.manifest || m;
  const persona = {
    agent: firstExisting(dir, ["agent/AGENT.md", "AGENT.md"]),
    soul: firstExisting(dir, ["agent/SOUL.md", "SOUL.md"]),
    dna_schema: firstExisting(dir, ["dna/dna-schema.md"]),
    manifest: firstExisting(dir, ["MANIFEST.yaml", "manifest.yaml"]),
  };
  // The enrichment pass writes the routing block. It is deliberately split into
  // fields that get INDEXED (positive: what this clone is for) and fields that
  // never do (negative: what it refuses, who to call instead). BM25 has no notion
  // of negation, so "do not use for direct response" indexes as a vote FOR direct
  // response — the exact defect that made two independently written blocks rank
  // first on queries they meant to repel. Keeping the negative text out of the
  // corpus fixes that structurally instead of asking every author to dodge it.
  const routing = m.routing || {};
  clones[slug] = {
    slug,
    display_name: man.display_name || slug,
    pack_category: packCategory,
    manifest_category: man.category || null,
    tags: Array.isArray(man.tags) ? man.tags : [],
    validation_verdict: m.validation_verdict || man.validation_verdict || null,
    scores: m.scores || null,
    dir,
    has_full_dna: !!(persona.agent && persona.soul),
    persona_files: persona,
    match: {
      // ── indexed ────────────────────────────────────────────────────────────
      one_liner: routing.one_liner || null,
      domains: Array.isArray(routing.domains) ? routing.domains : [],
      serves: routing.serves || null,
      // Legacy: pre-split blocks put positive AND negative prose in when_to_use.
      // Still indexed while `serves` is absent, so the 171 blocks written before
      // the split keep working; ignored by the corpus once `serves` exists.
      when_to_use: routing.when_to_use || null,
      // ── never indexed — read by the orchestrator after retrieval ───────────
      not_for: routing.not_for || null,
      delegates_to: Array.isArray(routing.delegates_to) ? routing.delegates_to : [],
      refuses: Array.isArray(routing.refuses) ? routing.refuses : [],
    },
  };
}

for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  const catMap = loadCatMap(root);
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."));

  // Passe 1 — layout CANÔNICO (flat): dna/<slug>/MANIFEST.yaml.
  const notClones: typeof entries = [];
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    const m = readManifest(dir);
    if (m) addClone(entry.name, dir, m, catMap[entry.name] ?? null);
    else notClones.push(entry);
  }

  // Passe 2 — layout LEGADO (aninhado): dna/<categoria>/<slug>/MANIFEST.yaml.
  // Escrito por instalações de pack ≤ 0.1.61, quando o installer aninhava por
  // categoria enquanto este scanner só via um nível — o que zerava o roster
  // (github.com/gutomec/nirvana-os-engine/issues/2, corrigido na 0.1.62).
  //
  // Leitor liberal, escritor estrito: NADA é movido em disco (mexer nos dados
  // do usuário durante um comando de leitura seria pior que o bug). O writer já
  // é flat, então este caminho é só compatibilidade e decai sozinho conforme as
  // instalações antigas reinstalam. O flat vence no empate de slug (passe 1
  // primeiro), e aqui a categoria vem do próprio diretório-pai.
  for (const catEntry of notClones) {
    const catDir = path.join(root, catEntry.name);
    let subs: typeof entries;
    try { subs = fs.readdirSync(catDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")); }
    catch { continue; } // ilegível → não é biblioteca de clone
    for (const sub of subs) {
      const dir = path.join(catDir, sub.name);
      const m = readManifest(dir);
      if (!m) continue;
      legacyNested++;
      addClone(sub.name, dir, m, catMap[sub.name] ?? catEntry.name);
    }
  }
}

// EEXIST tolerado: no Windows o Bun pode lançar mesmo com recursive:true.
try { fs.mkdirSync(registryDir, { recursive: true }); }
catch (e) { if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e; }
const out = {
  schema_version: "1.0",
  generated_at: new Date().toISOString(),
  scope_mode: scope.mode,
  mind_clone_roots: roots,
  count: Object.keys(clones).length,
  mind_clones: clones,
};
// Um clone não pode ser convocado pelo que ele recusa. O caso canônico é
// `saul-steinberg`, que declarava "cartum" em domains enquanto o AGENT.md abre
// com "Não-cartunista" e trata cartum como o modo de falha: quem roteia por esse
// domínio recebe uma recusa, e o despacho morre depois de já ter custado.
//
// Detectar isso lendo a prosa é inviável — duas tentativas de regex sobre as
// seções de recusa deram 716 falsos positivos, porque "never cast purely by
// celebrity" é heurística de COMO fazer casting, não recusa de casting. O que
// torna a checagem possível é a representação: com `refuses` declarado como
// lista, a contradição vira interseção de conjuntos, sem inferência nenhuma.
//
// Aviso, não erro: bloqueia nada até o critério ser calibrado contra julgamento
// humano. Gate que reprova por falso positivo ensina todo mundo a ignorar aviso.
// Item de `domains` que não é string saiu do corpus sem avisar. A causa comum é
// dois-pontos dentro do item (`- margem de segurança: desconto sobre o valor`),
// que o YAML lê como mapa em vez de texto — o domínio some do índice e o autor
// só percebe porque "o score não mexe entre reindexações". Barulhento de
// propósito: é perda de cobertura invisível, não questão de estilo.
const malformados: string[] = [];
for (const [slug, c] of Object.entries(clones) as Array<[string, any]>) {
  for (const d of c.match?.domains || []) {
    if (typeof d !== "string") {
      malformados.push(`${slug}: item de domains não é texto (${JSON.stringify(d).slice(0, 60)}) — use vírgula, não dois-pontos`);
    }
  }
}
if (malformados.length && !quiet) {
  console.warn(`[index-clones] ${malformados.length} domínio(s) fora do corpus por má formação:`);
  for (const m of malformados.slice(0, 20)) console.warn(`  ! ${m}`);
}

const contradicoes: string[] = [];
for (const [slug, c] of Object.entries(clones) as Array<[string, any]>) {
  const refuses: string[] = c.match?.refuses || [];
  const domains: string[] = c.match?.domains || [];
  if (!refuses.length || !domains.length) continue;
  const norm = (s: string) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const recusados = new Set(refuses.map(norm));
  for (const d of domains) {
    if (recusados.has(norm(d))) contradicoes.push(`${slug}: domínio "${d}" também está em refuses`);
  }
}
if (contradicoes.length && !quiet) {
  console.warn(`[index-clones] ${contradicoes.length} domínio(s) contradizem a própria recusa:`);
  for (const c of contradicoes.slice(0, 20)) console.warn(`  ! ${c}`);
}

// Escrita atômica: grava em temporário no MESMO diretório e renomeia. rename(2)
// é atômico dentro do filesystem, então um leitor concorrente vê o registry
// antigo inteiro ou o novo inteiro, nunca um JSON truncado. Importa porque o
// enriquecimento roda vários agentes em paralelo e cada um reindexa para
// verificar o próprio bloco — sem isto, dois reindexes simultâneos podem
// entregar registry corrompido a um terceiro que só estava lendo.
const tmpPath = `${registryPath}.${process.pid}.tmp`;
fs.writeFileSync(tmpPath, JSON.stringify(out, null, 1));
fs.renameSync(tmpPath, registryPath);

// Espelho no escopo global: quando o scan cobriu exatamente a biblioteca global
// (nenhum clone local de projeto), o conteúdo dos dois registries é idêntico por
// construção — então o global é atualizado junto. Sem isto, reindexar só no
// projeto deixa a instalação cega ao trabalho novo (aconteceu: o registry global
// ficou 5 dias parado enquanto o de projeto andava). Com clone local de projeto
// no scan, o espelho NÃO roda: o conteúdo divergiria do que o global deve ter.
const globalRegistryPath = path.join(os.homedir(), ".nirvana", ".mind-clones-registry.json");
const scannedOnlyGlobalLibrary =
  roots.length === 1 && path.resolve(roots[0]) === path.resolve(paths.DNA_LIBRARY);
if (registryPath !== globalRegistryPath && scannedOnlyGlobalLibrary) {
  const gTmp = `${globalRegistryPath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(globalRegistryPath), { recursive: true });
  fs.writeFileSync(gTmp, JSON.stringify(out, null, 1));
  fs.renameSync(gTmp, globalRegistryPath);
  if (!quiet) console.error(`[index-clones] espelhado no escopo global → ${globalRegistryPath}`);
}

if (!quiet) {
  console.error(`[index-clones] scope=${scope.mode} → scanning: ${roots.join(", ")}`);
  console.error(`[index-clones] registry → ${registryPath}`);
  const enriched = Object.values(clones).filter((c: any) => c.match.one_liner).length;
  console.error(`[index-clones] ✓ ${out.count} mind-clones indexed (${scanned} scanned, ${enriched} enriched)`);
  if (legacyNested > 0) {
    console.error(`[index-clones] ⚠ ${legacyNested} clone(s) em layout legado aninhado (dna/<categoria>/<slug>/) — indexados normalmente.`);
    console.error(`[index-clones]   O layout canônico é flat (dna/<slug>/). Reinstalar o pack em 0.1.62+ normaliza; nada precisa ser movido à mão.`);
  }
}
process.exit(EXIT.OK);
