#!/usr/bin/env node
// Gera apps/web/lib/nirvana/pack-contents.ts — lista (slug + descrição curta) de
// empresas e squads de cada pack, lida dos content-dirs em packs-content/<slug>/.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/Users/guto/nirvana-os/packs-content";
const OUT = "/Users/guto/squads-sh-v2/apps/web/lib/nirvana/pack-contents.ts";
const CATALOG = "/Users/guto/analista-de-squads/analyses/pacotes-nichados-2026-06-23/squad-catalog.txt";

// one-liners ricas do audit: slug -> one_liner (formato "GRADE | slug | one_liner")
const ONELINERS = {};
if (existsSync(CATALOG)) {
  for (const line of readFileSync(CATALOG, "utf8").split("\n")) {
    const parts = line.split(" | ");
    if (parts.length >= 3) ONELINERS[parts[1].trim()] = parts.slice(2).join(" | ").trim();
  }
}

// Limpa uma descrição: remove boilerplate genérico de abertura, normaliza espaços,
// pega frases COMPLETAS (sem corte no meio da palavra) até ~230 chars.
function clean(raw) {
  let v = raw.replace(/\s+/g, " ").trim().replace(/^["'>|-]+\s*/, "").replace(/["']$/, "").trim();
  // remove abertura genérica ("Squad NIRVANA definitivo para", "Pipeline ... que", etc.)
  v = v.replace(
    /^(squad|pipeline|time|suite|sistema|plataforma|fábrica|estúdio|estudio|super-?agente|meta-?squad|a self-contained|self-contained)\b(\s+(nirvana|agêntico|agentico|self-contained|standalone|completo|completa|definitivo|definitiva|meta|universal|multi-?agente|multi-?agentic|industrial|cl[íi]nico|cl[íi]nica|fullstack|full-stack|solo|de produção|de \d+ agentes))*\s*(que |para o |para a |para os |para |de |em )?/i,
    ""
  );
  v = (v.charAt(0).toUpperCase() + v.slice(1)).trim();
  const MAX = 240;
  if (v.length <= MAX) return /[.!?…]$/.test(v) ? v : v.replace(/[\s,;:—-]+$/, "") + ".";
  // longo: corta no fim de frase mais próximo antes de MAX (se passar de 120), senão palavra
  const head = v.slice(0, MAX);
  const lastSentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (lastSentence > 120) return head.slice(0, lastSentence + 1);
  return head.replace(/\s+\S*$/, "").replace(/[\s,;:—-]+$/, "") + "…";
}

// extrai a descrição do yaml (inline OU block scalar concatenado) e limpa.
function shortDesc(yamlPath) {
  if (!existsSync(yamlPath)) return "";
  const lines = readFileSync(yamlPath, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)description:\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (["|", ">", "|-", ">-", "|+", ">+", ""].includes(v)) {
      // block scalar: concatena linhas indentadas até dedent/próxima chave
      const buf = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === "") { if (buf.length) break; else continue; }
        if (/^\s*[a-z_]+:/i.test(lines[j]) && !lines[j].startsWith(m[1] + " ")) break;
        buf.push(lines[j].trim());
        if (buf.join(" ").length > 260) break;
      }
      v = buf.join(" ");
    }
    return clean(v);
  }
  return "";
}

function items(dir, kind) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((e) => !e.startsWith(".") && e !== "README.md")
    .sort()
    .map((slug) => ({
      slug,
      // sempre do yaml do dono (rico + acentuado). NÃO usar one-liners do audit (sem acento).
      desc: shortDesc(join(dir, slug, kind === "biz" ? "business.yaml" : "squad.yaml")),
    }));
}

const map = {};
for (const slug of readdirSync(ROOT).filter((e) => !e.startsWith("."))) {
  const base = join(ROOT, slug);
  map[slug] = {
    businesses: items(join(base, "businesses"), "biz"),
    squads: items(join(base, "squads"), "sq"),
  };
}

const ts = `// AUTO-GERADO por scripts/gen-pack-contents.mjs — não editar à mão.
// Lista de empresas e squads (com descrição curta) de cada pack, para a página /packs/<slug>.

export interface PackItem {
  slug: string;
  desc: string;
}
export interface PackContents {
  businesses: PackItem[];
  squads: PackItem[];
}

export const PACK_CONTENTS: Record<string, PackContents> = ${JSON.stringify(map, null, 2)};

export function getPackContents(slug: string): PackContents | null {
  return PACK_CONTENTS[slug] ?? null;
}
`;

writeFileSync(OUT, ts);
const tot = Object.entries(map).map(([k, v]) => `${k}:${v.businesses.length}b/${v.squads.length}s`).join("  ");
console.log("OK →", OUT);
console.log(tot);
