#!/usr/bin/env node
// Insere as 12 entradas dos packs nichados no product.ts (antes do fecho de PRODUCTS).
import { readFileSync, writeFileSync } from "node:fs";

const F = "/Users/guto/squads-sh-v2/apps/web/lib/nirvana/product.ts";

const PACKS = [
  ["creative-studio", "Nirvana — Creative Studio", "Vídeo, imagem, áudio e produção episódica — do roteiro ao asset final.", 99000, 13, 4, 56],
  ["web-design", "Nirvana — Web, Design & Landing", "Sites nível Awwwards, design systems e landing pages de alta conversão.", 69000, 10, 2, 16],
  ["engineering-devops", "Nirvana — Engineering & DevOps", "Um time de engenharia sênior autônomo: backend, API, DevOps, segurança e dados.", 99000, 24, 2, 20],
  ["fintech-crypto", "Nirvana — Fintech, Crypto & Trading", "Incubadora fintech regulada, tokens Solana, trading e assessoria de investimentos.", 89000, 8, 3, 37],
  ["research-intelligence", "Nirvana — Research & Intelligence", "Forecasting, investigação/OSINT, consultoria de mesa-redonda e pesquisa de mercado.", 89000, 7, 6, 37],
  ["publishing-knowledge", "Nirvana — Publishing & Knowledge", "Escreve, ilustra, formata e lança livros; converte e organiza conhecimento.", 59000, 8, 2, 105],
  ["health-management", "Nirvana — Gestão de Saúde", "Operação completa de clínicas e consultórios BR (prontuário, TISS, compliance).", 69000, 9, 1, 7],
  ["food-hospitality", "Nirvana — Food, Hotelaria & Serviços Locais", "Restaurantes, hotéis, eventos, turismo, petshop, salão e coworking.", 49000, 7, 1, 5],
  ["realestate-construction", "Nirvana — Imobiliário, Construção & Energia", "Imobiliárias, arquitetura, engenharia civil, condomínios e energia solar.", 59000, 5, 2, 13],
  ["education", "Nirvana — Educação & Cursos", "Escolas, pós-graduação, cursos online e tutoria adaptativa.", 49000, 4, 1, 12],
  ["commerce-backoffice", "Nirvana — Comércio, Logística & Back-office", "E-commerce, logística, comex, contábil, fiscal, RH e recrutamento.", 59000, 9, 0, 0],
  ["creators", "Nirvana — Creators & Personal Brands", "Músicos, coaches, personal trainers e estúdios de jogos indie.", 39000, 4, 1, 12],
];

const entry = ([slug, name, tagline, price, sq, bz, cl]) => `  "${slug}": {
    slug: "${slug}",
    tier: "${slug}",
    name: ${JSON.stringify(name)},
    tagline: ${JSON.stringify(tagline)},
    listed: true,
    version: "0.1.21",
    priceUsdCents: ${price},
    defaultSeats: 3,
    eulaVersion: "2026-05-30",
    bucket: "nirvana-artifacts",
    baseArtifactPath: "base/${slug}.zip",
    buildPathPrefix: "builds",
    composition: { squads: ${sq}, businesses: ${bz}, mindClones: ${cl} },
  },`;

let src = readFileSync(F, "utf8");
if (PACKS.some((p) => src.includes(`"${p[0]}": {`))) {
  console.error("ABORT: alguma entrada já existe — não duplicar.");
  process.exit(1);
}
const block = PACKS.map(entry).join("\n");
// inserir antes do fecho de PRODUCTS: a linha "};" seguida de "\nexport const DEFAULT_PRODUCT_SLUG"
const anchor = "\n};\n\nexport const DEFAULT_PRODUCT_SLUG";
if (!src.includes(anchor)) { console.error("ABORT: âncora não encontrada."); process.exit(1); }
src = src.replace(anchor, `\n${block}\n};\n\nexport const DEFAULT_PRODUCT_SLUG`);
writeFileSync(F, src);
console.log(`OK: ${PACKS.length} entradas inseridas.`);
