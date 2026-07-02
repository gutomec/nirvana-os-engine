#!/usr/bin/env node
// Define a description rica (escrita à mão) de cada pack no product.ts.
import { readFileSync, writeFileSync } from "node:fs";
const F = "/Users/guto/squads-sh-v2/apps/web/lib/nirvana/product.ts";

const DESC = {
  "legal-compliance":
    "Três empresas e nove squads para advocacia, compliance e SST no Brasil. Vai do intake à peça revisada com QA de mais de 30 pontos, implanta o programa LGPD inteiro, revisa contratos com redlines e monta a documentação de segurança do trabalho. A jóia é a busca judicial real no CNJ e no DJEN — toda citação de jurisprudência sai marcada [VERIFICAR] para conferência humana.",
  "marketing-growth":
    "Nove empresas e quinze squads que cobrem marketing do diagnóstico de nicho à campanha publicada. Inteligência social em Instagram, TikTok e YouTube; funil completo com vinte clones de copy e lançamento; conteúdo do calendário ao multicanal; branding, mídia paga, landing pages e geração de imagem e vídeo. É o stack de uma agência inteira, sem a folha de pagamento.",
  "creative-studio":
    "Quatro estúdios e treze squads que cobrem a cadeia audiovisual inteira. Roteiro e treatment, geração de imagem, vídeo em Veo, Kling e Higgsfield, animação imagem-para-vídeo, locução com voz clonada e pós em seis provedores de TTS. Produção episódica e identidade de voz reutilizável, do brief ao asset final.",
  "web-design":
    "Duas agências de design e dez squads para web de ponta. Experiências nível Awwwards com WebGL e GSAP, design systems atômicos em tokens OKLCH e shadcn, três linhas de landing page de alta conversão, dashboards de BI e geração de imagem própria. Sai código TSX e CSS pronto para deploy, não mockup.",
  "engineering-devops":
    "Um time de engenharia sênior inteiro em vinte e quatro squads. Backend production-ready, modelagem Postgres com RLS, APIs tipadas, CI/CD com gate de CVE, testes, observabilidade, auditoria de segurança fullstack e pipelines de dados e ML. Pega um frontend de vibe coding e entrega sistema deployado.",
  "fintech-crypto":
    "Três incubadoras e oito squads para finanças reguladas e cripto. Do MVP de fintech ao token Solana — SPL, metadados Metaplex e pool no Raydium — com brain de trading multi-ativo, assessoria de investimentos no padrão ANBIMA e as camadas de compliance LGPD, jurídico e segurança que esse mercado cobra.",
  "research-intelligence":
    "Seis casas de inteligência e sete squads para decisão de alto risco. Forecasting probabilístico, investigação e OSINT no estilo Sherlock Holmes, mesa-redonda adversarial de conselheiros, pesquisa de mercado e radar competitivo. Feito para due diligence, estratégia e toda pergunta cara de responder errado.",
  "publishing-knowledge":
    "Duas editoras e oito squads que escrevem, ilustram, formatam e lançam livros — EPUB3, PDF de impressão KDP e roteiro de audiobook. Convertem qualquer arquivo em conhecimento estruturado e operam um segundo cérebro no estilo Obsidian. Os 105 mind-clones aterram a voz e o método dos autores.",
  "health-management":
    "Nove squads e uma holding para operar clínicas e consultórios brasileiros de ponta a ponta. Prontuário SOAP e CID-10, guia TISS, prevenção de no-show, marketing dentro do CFM, CRO e CRMV, e dashboards. Cobre medicina, fisioterapia, odontologia, psicologia, nutrição, veterinária, laboratório e farmácia.",
  "food-hospitality":
    "Sete squads e um coletivo foodtech para quem opera negócio de presença. Engenharia de cardápio e CMV no restaurante, revenue management no hotel, produção de eventos, roteiros de turismo, agenda de petshop e salão, e gestão de coworking. Plano, calendário, campanha e DRE como entregáveis.",
  "realestate-construction":
    "Duas empresas e cinco squads que vão do lote à obra entregue. Captação e contrato imobiliário com compliance CRECI, projeto do briefing ao alvará, orçamento de obra SINAPI com cronograma PERT/CPM, administração de condomínio e dimensionamento de energia solar com payback e documentação ANEEL.",
  "education":
    "Quatro squads e um grupo edtech para o ciclo educacional inteiro. Gestão de escola particular com BNCC e Censo INEP, coordenação de pós-graduação com relatórios CAPES, lançamento de curso online da ideia ao carrinho e tutoria adaptativa K-12 do diagnóstico de lacunas ao relatório para os pais.",
  "commerce-backoffice":
    "Nove squads para varejo e retaguarda. E-commerce e marketplaces, logística e supply chain, comércio exterior, concessionária, franqueadora, contabilidade, departamento pessoal, recrutamento e consultoria de gestão. É a operação que sustenta qualquer empresa, sem você montar time interno.",
  "creators":
    "Quatro squads e um estúdio indie para quem é a própria marca. Músico que vive da obra com distribuição, ECAD, EPK e booking; coach e mentor com jornada de cliente e funil; personal trainer com periodização e retenção; e go-to-market de jogo indie. Para o solopreneur virar negócio.",
};

let src = readFileSync(F, "utf8");
// 1) remove descriptions existentes (multi-linha) dos packs (legal/marketing) p/ reescrever
src = src.replace(/\n    description:\s*\n\s*"[^"]*",/g, "");
src = src.replace(/\n    description: "[^"]*",/g, "");
// 2) insere a nova description logo após o tagline de cada pack
let n = 0;
for (const [slug, desc] of Object.entries(DESC)) {
  const re = new RegExp(`("${slug}": \\{[\\s\\S]*?\\n    tagline: "[^"]*",)`, "");
  if (!re.test(src)) { console.error("NÃO achei tagline de", slug); continue; }
  src = src.replace(re, `$1\n    description: ${JSON.stringify(desc)},`);
  n++;
}
writeFileSync(F, src);
console.log(`OK: ${n}/${Object.keys(DESC).length} descrições aplicadas.`);
