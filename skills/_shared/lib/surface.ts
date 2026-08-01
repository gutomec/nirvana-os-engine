// surface.ts — extrai a SUPERFÍCIE DE CONTRATO de um artefato (squad, business,
// mind-clone).
//
// O problema que resolve: hoje a mudança de um artefato só pode ser narrada, nunca
// calculada. O campo `version` existe em todos eles e está morto (132 dos 178 squads
// parados em 5.0.0) justamente porque nada o deriva nem o cobra. Changelog escrito à
// mão apodrece pelo mesmo motivo, só que mais rápido.
//
// A superfície é o conjunto de IDENTIFICADORES ESTÁVEIS aos quais um agente
// consumidor se liga — capability id, ref de invocação, nome de task/workflow/agent,
// slug de employee — mais o hash do corpo de cada um. Duas superfícies são
// comparáveis mecanicamente, então a mudança passa a ser derivada.
//
// DETERMINISMO É REQUISITO, NÃO DETALHE. O arquivo gerado entra no conteúdo do
// artefato e portanto no hashDir() do install.ts. Se ele carregasse timestamp ou
// ordenação instável, todo rebuild marcaria todo artefato como "updated" e o sinal
// morreria no ruído. Por isso: sem data de geração, chaves ordenadas, e o próprio
// arquivo de superfície excluído do que ele mede.

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

export const SURFACE_FILE = ".nirvana-surface.json";
/** Saídas do próprio gerador. Medir isto como conteúdo cria realimentação: uma
 *  mudança escreve CHANGES.json/CHANGELOG.md, que na execução seguinte contam
 *  como conteúdo novo, que gera outra mudança, para sempre. Só a superfície de
 *  mind-clone varre o diretório inteiro, então o defeito era exclusivo dela. */
export const GENERATED_FILES = [SURFACE_FILE, "CHANGES.json", "CHANGELOG.md", ".nirvana-behavior.md"];
export const SURFACE_SCHEMA = 2;

export type ArtifactKind = "squad" | "business" | "mind-clone";

export type EntryType =
  | "capability"
  | "task"
  | "workflow"
  | "agent"
  | "employee"
  | "domain"
  | "produces"
  | "org-chart"
  | "routing"
  | "dna-artifact";

export interface SurfaceEntry {
  type: EntryType;
  /** Alvo da ligação: `workflow:workflows/x.yaml`, `task:tasks/y.md`. Mudar isto
   *  quebra quem invoca, mesmo com o id intacto. */
  binding?: string;
  /** Rótulos de roteamento (domains/produces da capability). */
  routing?: string[];
  /** Hash do corpo próprio da entrada (nó YAML ou arquivo). */
  hash: string;
}

export interface Surface {
  schema: number;
  kind: ArtifactKind;
  slug: string;
  /** Semver derivado do histórico de diffs. Semeado da versão declarada na
   *  primeira geração; a partir daí só o diff o move. */
  contract_version: string;
  /** Hash só dos identificadores + ligações. Muda = contrato mexeu. */
  surface_hash: string;
  /** Hash da prosa de descoberta (description/examples/keywords). Muda sozinho
   *  = PATCH: o roteamento pode melhorar, mas nada quebra. */
  prose_hash: string;
  entries: Record<string, SurfaceEntry>;
}

// ───────────────────────────── utilidades ─────────────────────────────

function sha(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** JSON canônico: chaves ordenadas em qualquer profundidade. Sem isto, a ordem
 *  de iteração vaza para o hash e o diff vira ruído. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

function readYaml(file: string): any {
  try { return parseYaml(fs.readFileSync(file, "utf8")) ?? {}; } catch { return {}; }
}

function listFiles(dir: string, exts: string[]): string[] {
  try {
    return fs.readdirSync(dir)
      .filter((f) => exts.some((e) => f.endsWith(e)))
      .sort();
  } catch { return []; }
}

function fileHash(file: string): string {
  try { return sha(fs.readFileSync(file)); } catch { return "missing"; }
}

/** Prosa de descoberta: muda o roteamento semântico, nunca a ligação. */
const PROSE_KEYS = ["description", "examples", "example_briefs", "keywords", "not_for"];

function splitProse(node: Record<string, unknown>): { contract: Record<string, unknown>; prose: Record<string, unknown> } {
  const contract: Record<string, unknown> = {};
  const prose: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (PROSE_KEYS.includes(k)) prose[k] = v;
    else contract[k] = v;
  }
  return { contract, prose };
}

// ───────────────────────────── detecção de tipo ─────────────────────────────

export function detectKind(dir: string): ArtifactKind | null {
  if (fs.existsSync(path.join(dir, "squad.yaml"))) return "squad";
  if (fs.existsSync(path.join(dir, "business.yaml"))) return "business";
  if (fs.existsSync(path.join(dir, "MANIFEST.yaml"))) return "mind-clone";
  return null;
}

// ───────────────────────────── extração ─────────────────────────────

function squadSurface(dir: string, slug: string): { entries: Record<string, SurfaceEntry>; prose: string[] } {
  const manifest = readYaml(path.join(dir, "squad.yaml"));
  const entries: Record<string, SurfaceEntry> = {};
  const prose: string[] = [];

  for (const cap of (manifest.capabilities ?? []) as any[]) {
    const id = String(cap?.id ?? "").trim();
    if (!id) continue;
    const { contract, prose: p } = splitProse(cap);
    // O `id` é a CHAVE da entrada, não parte do corpo. Mantê-lo dentro do hash
    // faria toda renomeação mudar o hash junto, e o detector de rename (que casa
    // por corpo idêntico) nunca reconheceria uma — reportaria remoção + adição,
    // escondendo justamente a migração trivial de trocar o id.
    delete (contract as Record<string, unknown>).id;
    const invoke = cap?.invoke ?? {};
    entries[`capability:${id}`] = {
      type: "capability",
      binding: invoke?.type && invoke?.ref ? `${invoke.type}:${invoke.ref}` : undefined,
      routing: [
        ...((cap?.domains ?? []) as string[]).map((d) => `domain:${d}`),
        ...((cap?.produces ?? []) as string[]).map((d) => `produces:${d}`),
      ].sort(),
      hash: sha(canonical(contract)),
    };
    // Só o CONTEÚDO da prosa entra no hash, nunca o id. Incluir o id faria toda
    // renomeação disparar um "prose_changed" junto com a quebra real, misturando
    // ruído de roteamento com o sinal que importa.
    prose.push(canonical(p));
  }

  // Componentes de arquivo: o nome é o identificador que workflows e capabilities
  // referenciam, então renomear é quebra mesmo com o conteúdo idêntico.
  for (const [sub, type, exts] of [
    ["tasks", "task", [".md"]],
    ["workflows", "workflow", [".yaml", ".yml"]],
    ["agents", "agent", [".md"]],
  ] as const) {
    const subdir = path.join(dir, sub);
    for (const f of listFiles(subdir, exts as unknown as string[])) {
      entries[`${type}:${sub}/${f}`] = { type, hash: fileHash(path.join(subdir, f)) };
    }
  }
  return { entries, prose };
}

function businessSurface(dir: string, slug: string): { entries: Record<string, SurfaceEntry>; prose: string[] } {
  const manifest = readYaml(path.join(dir, "business.yaml"));
  const entries: Record<string, SurfaceEntry> = {};
  const prose: string[] = [];

  // Domains e produces são a superfície de roteamento da empresa: o orquestrador
  // escolhe por eles. Perder um domain é quebra para quem roteava por ele.
  for (const d of (manifest.domains ?? []) as string[]) {
    entries[`domain:${d}`] = { type: "domain", hash: sha(String(d)) };
  }
  for (const p of (manifest.produces ?? []) as string[]) {
    entries[`produces:${p}`] = { type: "produces", hash: sha(String(p)) };
  }

  const empDir = path.join(dir, "employees");
  for (const f of listFiles(empDir, [".md"])) {
    entries[`employee:${f.replace(/\.md$/, "")}`] = { type: "employee", hash: fileHash(path.join(empDir, f)) };
  }

  for (const [file, type] of [["org-chart.yaml", "org-chart"], ["routing.yaml", "routing"]] as const) {
    const full = path.join(dir, file);
    if (fs.existsSync(full)) entries[`${type}:${file}`] = { type, hash: fileHash(full) };
  }

  const { prose: p } = splitProse(manifest);
  prose.push(canonical(p));
  return { entries, prose };
}

function mindCloneSurface(dir: string, slug: string): { entries: Record<string, SurfaceEntry>; prose: string[] } {
  // Clone não tem contrato invocável: ninguém o "chama", ele é injetado. A
  // superfície útil é quais artefatos de persona existem. Mudança aqui é quase
  // sempre aditiva ou comportamental, então o tratamento é deliberadamente leve.
  const entries: Record<string, SurfaceEntry> = {};
  const walk = (rel: string) => {
    const full = path.join(dir, rel);
    let items: string[] = [];
    try { items = fs.readdirSync(full).sort(); } catch { return; }
    for (const it of items) {
      if (GENERATED_FILES.includes(it) || it.startsWith(".")) continue;
      const child = path.join(full, it);
      const childRel = rel ? `${rel}/${it}` : it;
      if (fs.statSync(child).isDirectory()) walk(childRel);
      else entries[`dna-artifact:${childRel}`] = { type: "dna-artifact", hash: fileHash(child) };
    }
  };
  walk("");
  return { entries, prose: [] };
}

// ───────────────────────────── API ─────────────────────────────

/** Versão declarada no manifesto, usada só para semear a primeira geração. */
function declaredVersion(dir: string, kind: ArtifactKind): string {
  const file = kind === "squad" ? "squad.yaml" : kind === "business" ? "business.yaml" : "MANIFEST.yaml";
  const v = String(readYaml(path.join(dir, file))?.version ?? "").trim();
  return /^\d+\.\d+\.\d+$/.test(v) ? v : "1.0.0";
}

export function readSurface(dir: string): Surface | null {
  const file = path.join(dir, SURFACE_FILE);
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as Surface;
    return s && typeof s === "object" && s.entries ? s : null;
  } catch { return null; }
}

/**
 * Extrai a superfície atual do artefato em disco. `contract_version` sai como a
 * versão semeada; quem aplica o bump é o diff, não a extração.
 */
export function extractSurface(dir: string, kindHint?: ArtifactKind): Surface {
  const kind = kindHint ?? detectKind(dir);
  if (!kind) throw new Error(`não é um artefato Nirvana reconhecível: ${dir}`);
  const slug = path.basename(dir);

  const { entries, prose } =
    kind === "squad" ? squadSurface(dir, slug)
    : kind === "business" ? businessSurface(dir, slug)
    : mindCloneSurface(dir, slug);

  const ordered: Record<string, SurfaceEntry> = {};
  for (const k of Object.keys(entries).sort()) ordered[k] = entries[k];

  // surface_hash cobre só identidade e ligação. O hash do CORPO de cada entrada
  // entra separado, porque corpo mudado sem id mexido é PATCH, não quebra.
  const bindingOnly = Object.fromEntries(
    Object.entries(ordered).map(([k, v]) => [k, { binding: v.binding ?? null, routing: v.routing ?? null }]),
  );

  const previous = readSurface(dir);
  return {
    schema: SURFACE_SCHEMA,
    kind,
    slug,
    contract_version: previous?.contract_version ?? declaredVersion(dir, kind),
    surface_hash: sha(canonical(bindingOnly)),
    prose_hash: sha(prose.sort().join("\n")),
    entries: ordered,
  };
}

/** Serialização determinística: mesma entrada, mesmos bytes, sempre. */
export function serializeSurface(s: Surface): string {
  return JSON.stringify(
    {
      schema: s.schema,
      kind: s.kind,
      slug: s.slug,
      contract_version: s.contract_version,
      surface_hash: s.surface_hash,
      prose_hash: s.prose_hash,
      entries: s.entries,
    },
    null,
    2,
  ) + "\n";
}

export function writeSurface(dir: string, s: Surface): void {
  fs.writeFileSync(path.join(dir, SURFACE_FILE), serializeSurface(s), "utf8");
}
