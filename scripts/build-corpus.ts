#!/usr/bin/env bun
// Monta o corpus PT (fonte) a ser traduzido p/ os outros 5 locales.
import { PRODUCTS } from "/Users/guto/squads-sh-v2/apps/web/lib/nirvana/product.ts";
import { PACK_CONTENTS } from "/Users/guto/squads-sh-v2/apps/web/lib/nirvana/pack-contents.ts";
import { writeFileSync } from "node:fs";

const ui: Record<string, string> = {
  navPacks: "Packs Nirvana-OS",
  eyebrow: "Pack",
  indexHeading: "Coleções prontas para instalar",
  indexSubtitle:
    "Bundles curados de empresas, squads e mind-clones que rodam sobre o motor Nirvana-OS.",
  homeHeading: "Packs Nirvana-OS",
  seeAll: "Ver todos",
  squads: "squads",
  businesses: "empresas",
  mindClones: "mind-clones",
  whatsInside: "O que vem dentro",
  businessesTitle: "Empresas",
  squadsTitle: "Squads",
  howToInstall: "Como instalar",
  installStep1Prefix: "Instale o motor:",
  installStep2: "Após a compra, baixe seu pack carimbado na área logada e rode",
  installStep3Prefix: "Atualize quando quiser:",
  honestNote: "Nota honesta",
  honestNoteBody:
    "Os squads e empresas geram estratégia, documentos, código, copy, planos e relatórios reais sobre o motor Nirvana-OS. A geração de imagem e vídeo usa as ferramentas do seu ambiente; a publicação e a execução em plataformas externas dependem das suas chaves e integrações. O conteúdo é seu para usar e adaptar.",
  buy: "Comprar",
  priceMetaSeats: "licença nominal · {seats} máquinas",
  pricePayment: "Pagamento único. Download carimbado por-comprador na área logada.",
  empty: "Nenhum pack disponível no momento.",
};

// copy dos packs (tagline + description), exceto genesis (tem landing própria)
const packs: Record<string, { tagline: string; description: string }> = {};
for (const [slug, p] of Object.entries(PRODUCTS)) {
  if (slug === "genesis-circle") continue;
  packs[slug] = { tagline: p.tagline ?? "", description: p.description ?? "" };
}

// descrições únicas dos itens (slug -> desc), dedup global
const items: Record<string, string> = {};
for (const c of Object.values(PACK_CONTENTS) as any[]) {
  for (const it of [...c.businesses, ...c.squads]) {
    if (it.desc && !items[it.slug]) items[it.slug] = it.desc;
  }
}

const corpus = { ui, packs, items };
writeFileSync("/Users/guto/nirvana-os/packs-content/_corpus.pt.json", JSON.stringify(corpus, null, 2));
console.log(
  `corpus PT: ui=${Object.keys(ui).length} packs=${Object.keys(packs).length} items=${Object.keys(items).length}`
);
