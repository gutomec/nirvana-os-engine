#!/usr/bin/env node
// Mescla os 6 corpus traduzidos em: pack-contents.ts (desc locale-keyed),
// pack-i18n.ts (copy dos packs locale-keyed) e messages/<locale>.json (namespace packs).
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const LOCALES = ["en", "zh", "hi", "es", "ar", "pt"];
const CDIR = "/Users/guto/nirvana-os/packs-content";
const WEB = "/Users/guto/squads-sh-v2/apps/web";

const corp = {};
for (const l of LOCALES) corp[l] = JSON.parse(readFileSync(join(CDIR, `_corpus.${l}.json`), "utf8"));
const pick = (sec, key, sub) =>
  Object.fromEntries(
    LOCALES.map((l) => {
      const node = corp[l][sec][key];
      return [l, (sub ? node?.[sub] : node) ?? (sub ? corp.pt[sec][key]?.[sub] : corp.pt[sec][key]) ?? ""];
    })
  );

// 1) pack-contents.ts (slug lists dos content-dirs + desc locale-keyed)
const packsDir = readdirSync(CDIR).filter((e) => !e.startsWith("_") && !e.startsWith("."));
const contents = {};
for (const slug of packsDir) {
  const base = join(CDIR, slug);
  const list = (kind) => {
    const d = join(base, kind);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((e) => !e.startsWith(".") && e !== "README.md")
      .sort()
      .map((s) => ({ slug: s, desc: pick("items", s) }));
  };
  contents[slug] = { businesses: list("businesses"), squads: list("squads") };
}
const pcTs = `// AUTO-GERADO por scripts/merge-i18n.mjs — não editar à mão.
// Empresas e squads de cada pack, com descrição em 6 idiomas, para /packs/<slug>.
export type Loc = "en" | "zh" | "hi" | "es" | "ar" | "pt";
export interface PackItem { slug: string; desc: Record<Loc, string>; }
export interface PackContents { businesses: PackItem[]; squads: PackItem[]; }
export const PACK_CONTENTS: Record<string, PackContents> = ${JSON.stringify(contents, null, 2)};
export function getPackContents(slug: string): PackContents | null { return PACK_CONTENTS[slug] ?? null; }
export function pickDesc(d: Record<Loc, string>, locale: string): string { return d[(locale as Loc)] ?? d.pt ?? d.en ?? ""; }
`;
writeFileSync(join(WEB, "lib/nirvana/pack-contents.ts"), pcTs);

// 2) pack-i18n.ts (copy dos packs)
const i18n = {};
for (const slug of Object.keys(corp.pt.packs)) {
  i18n[slug] = { tagline: pick("packs", slug, "tagline"), description: pick("packs", slug, "description") };
}
const piTs = `// AUTO-GERADO por scripts/merge-i18n.mjs — não editar à mão.
// Tagline + descrição de cada pack em 6 idiomas.
import type { Loc } from "./pack-contents";
export interface PackCopy { tagline: Record<Loc, string>; description: Record<Loc, string>; }
export const PACK_I18N: Record<string, PackCopy> = ${JSON.stringify(i18n, null, 2)};
export function packTagline(slug: string, locale: string, fallback = ""): string {
  return PACK_I18N[slug]?.tagline?.[(locale as Loc)] ?? PACK_I18N[slug]?.tagline?.pt ?? fallback;
}
export function packDescription(slug: string, locale: string, fallback = ""): string {
  return PACK_I18N[slug]?.description?.[(locale as Loc)] ?? PACK_I18N[slug]?.description?.pt ?? fallback;
}
`;
writeFileSync(join(WEB, "lib/nirvana/pack-i18n.ts"), piTs);

// 3) messages/<locale>.json — namespace packs (ui) + header.packs
for (const l of LOCALES) {
  const f = join(WEB, "messages", `${l}.json`);
  const m = JSON.parse(readFileSync(f, "utf8"));
  m.packs = corp[l].ui;
  m.header = { ...(m.header || {}), packs: corp[l].ui.navPacks };
  writeFileSync(f, JSON.stringify(m, null, 2) + "\n");
}

console.log(`OK: pack-contents.ts (${packsDir.length} packs), pack-i18n.ts (${Object.keys(i18n).length}), messages × ${LOCALES.length}.`);
