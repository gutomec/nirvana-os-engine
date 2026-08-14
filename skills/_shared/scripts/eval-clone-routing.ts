#!/usr/bin/env bun
/**
 * Evaluation set for mind-clone routing (3 axes).
 *
 *   1. self-retrieval — each clone's one_liner with a block must retrieve it
 *   2. need — the 47 queries written before the blocks existed
 *   3. scaffold — identical pairs with and without the intent verb; the top-3
 *      must be the SAME in both, otherwise the scaffold is deciding
 *
 * Run before and after any tokenizer/index change and compare.
 * Usage: bun eval-clone-routing.ts — or import runEval(); it is what
 * tests/clone-routing-eval.test.ts does to lock the watermark baselines in CI.
 */
import { loadCloneRegistry } from "../lib/clone-resolver.ts";
import { buildCloneDocForTest } from "../lib/clone-search.ts";
const bm25 = require("../../harness/lib/bm25.js");

// ── axis 2: need ────────────────────────────────────────────────────────────
const NEED: Array<[string, string]> = [
  ["aleyda-solis", "meu site tem versão em três países e o Google mostra a página errada em cada um"],
  ["aleyda-solis", "metade das páginas do site não aparece no Google e não sei por quê"],
  ["aleyda-solis", "hreflang and international site architecture subfolder or ccTLD"],
  ["rand-fishkin", "as pessoas veem a resposta direto no Google e não clicam mais no meu site"],
  ["rand-fishkin", "vale a pena continuar investindo em busca orgânica ou é melhor outro canal"],
  ["rand-fishkin", "where does my audience actually spend attention online"],
  ["mike-king", "como o ChatGPT decide qual trecho da minha página vai recuperar e citar"],
  ["mike-king", "vamos migrar o site inteiro sem perder o que o buscador já entende sobre a empresa"],
  ["mike-king", "query fan-out and relevance engineering for retrieval"],
  ["dan-petrovic", "quero um experimento controlado que prove se a mudança de SEO funcionou"],
  ["dan-petrovic", "medir a distância semântica entre a minha página e a pergunta do usuário"],
  ["dan-petrovic", "embeddings and model interpretability experiment in search"],
  ["lily-ray", "meu site de conteúdo precisa provar autoridade e experiência real do autor"],
  ["lily-ray", "como um portal de notícias sobrevive e aparece no Google Discover"],
  ["lily-ray", "E-E-A-T signals for a publisher website"],
  ["marie-haynes", "perdi sessenta por cento do tráfego depois de uma atualização do Google e quero recuperar"],
  ["marie-haynes", "o site foi atingido pelo helpful content update, qual o plano de recuperação"],
  ["marie-haynes", "core update recovery plan and quality rater guidelines"],
  ["brian-dean", "preciso conseguir mais links apontando para o meu site"],
  ["brian-dean", "pesquisa de palavra-chave e agrupamento de conteúdo por tópico"],
  ["brian-dean", "link building outreach and keyword research"],
  ["barry-schwartz", "teve atualização de algoritmo rodando essa semana ou é impressão minha"],
  ["tobias-van-schneider-products-practice", "quero construir um negócio próprio de design sem depender de cliente"],
  ["tobias-van-schneider-products-practice", "como um designer independente cria produto próprio e vive dele"],
  ["caio-braga-products-practice", "como decidir se o trabalho de design está bom o suficiente para aprovar antes de subir"],
  ["aarron-walter-products-practice", "quero que o produto crie vínculo emocional com quem usa"],
  ["jared-spool-products-practice", "a equipe toma decisão de design no achismo e ninguém observa usuário"],
  ["jared-spool-products-practice", "como aumentar a maturidade de design da organização"],
  ["john-maeda-products-practice", "preciso simplificar um produto que ficou complicado demais"],
  ["john-maeda-products-practice", "como design tecnologia e negócio se encontram na liderança"],
  ["julie-zhuo-products-practice", "virei gestor de design pela primeira vez e não sei conduzir o time"],
  ["julie-zhuo-products-practice", "dar feedback e crescer designers dentro do time"],
  ["don-norman-products-practice", "o cliente pediu uma coisa que o time inteiro acha errada e ninguém sabe como recusar o briefing"],
  // neighbors that must NOT be displaced
  ["olaf-kopp", "auditoria de chunk e passagem para a página ser citada pela IA"],
  ["kevin-indig", "o tráfego orgânico caiu e o faturamento ficou igual, preciso explicar isso para o CMO"],
  ["tom-roach-cso", "a marca travou no platô de performance e a mídia paga não escala mais"],
  ["kim-scott-cpo", "empatia ruinosa e franqueza radical no time"],
  ["fabricio-teixeira-products-practice", "diagnóstico de maturidade da prática de design em cinco dias numa página"],
  ["felipe-memoria-products-practice", "P&L da prática com receita por squad-mês e utilização do time"],
  ["dan-mall", "governança e adoção do design system com métricas"],
  ["alla-kholmatova", "linguagem de padrões e ethos do design system"],
  ["marty-cagan", "product operating model e times empoderados de produto"],
  ["jony-ive", "design industrial e de hardware para um produto físico"],
  ["chris-lattner", "otimização de compilador e low-level DevOps puro"],
  ["bruno-rodrigues-ux", "microcopy e mensagem de erro na interface"],
  ["jakob-nielsen-ux", "avaliação heurística com severity rating"],
  ["pedro-sobral-paid", "estruturar minha conta de meta ads do zero para um lançamento"],
];

// ── axis 3: scaffold ────────────────────────────────────────────────────────
const SCAFFOLD: Array<[string, string]> = [
  ["quero uma segunda opinião sobre uma escolha", "uma segunda opinião sobre uma escolha"],
  ["quero escrever um PRD de uma página com critério de aceite testável", "escrever um PRD de uma página com critério de aceite testável"],
  ["preciso de ajuda com uma decisão difícil", "ajuda com uma decisão difícil"],
  ["quero contratar um diretor de fotografia para o comercial", "contratar um diretor de fotografia para o comercial"],
  ["quero organizar as finanças da minha empresa", "organizar as finanças da minha empresa"],
  ["preciso de um plano de mídia paga para o lançamento", "plano de mídia paga para o lançamento"],
  ["quero melhorar a cultura do time", "melhorar a cultura do time"],
  ["i want to improve my landing page conversion", "improve my landing page conversion"],
  ["we need a design system for our product", "a design system for our product"],
  ["quero entender por que meu produto não retém usuário", "por que meu produto não retém usuário"],
];

export interface EvalResult {
  avgDocLen: number;
  selfOk: number;
  selfN: number;
  selfFail: string[];
  needOk: number;
  needTotal: number;
  needFail: string[];
  scaffoldOk: number;
  scaffoldTotal: number;
  scaffoldFail: string[];
}

export function runEval(): EvalResult {
  const reg: any = loadCloneRegistry();
  const docs = Object.values(reg).map(buildCloneDocForTest as any);
  const idx = bm25.buildIndex(docs);

  // axis 1: self-retrieval
  let selfOk = 0, selfN = 0;
  const selfFail: string[] = [];
  for (const d of docs as any[]) {
    if (!d.one_liner) continue;
    selfN++;
    const hits = bm25.query(idx, d.one_liner, { topK: 1 });
    if (hits[0]?.doc.slug === d.slug) selfOk++;
    else selfFail.push(`${d.slug} -> ${hits[0]?.doc.slug ?? "(nada)"}`);
  }

  // axis 2: need
  let needOk = 0;
  const needFail: string[] = [];
  for (const [alvo, q] of NEED) {
    const hits = bm25.query(idx, q, { topK: 1 });
    if (hits[0]?.doc.slug === alvo) needOk++;
    else needFail.push(`${alvo} <- perdeu para ${hits[0]?.doc.slug ?? "(nada)"} | ${q.slice(0, 55)}`);
  }

  // axis 3: scaffold
  let scaffoldOk = 0;
  const scaffoldFail: string[] = [];
  for (const [comV, semV] of SCAFFOLD) {
    const a = bm25.query(idx, comV, { topK: 3 }).map((h: any) => h.doc.slug).join(",");
    const b = bm25.query(idx, semV, { topK: 3 }).map((h: any) => h.doc.slug).join(",");
    if (a === b) scaffoldOk++;
    else scaffoldFail.push(`COM[${a}] != SEM[${b}] | ${semV.slice(0, 45)}`);
  }

  return {
    avgDocLen: idx.avgDocLen,
    selfOk, selfN, selfFail,
    needOk, needTotal: NEED.length, needFail,
    scaffoldOk, scaffoldTotal: SCAFFOLD.length, scaffoldFail,
  };
}

if (import.meta.main) {
  const r = runEval();
  console.log(`avgDocLen ............ ${r.avgDocLen.toFixed(1)}`);
  console.log(`self-retrieval ....... ${r.selfOk}/${r.selfN}`);
  console.log(`need ................. ${r.needOk}/${r.needTotal}`);
  console.log(`scaffold (top-3 same)  ${r.scaffoldOk}/${r.scaffoldTotal}`);
  if (r.selfFail.length) console.log("\nself-retrieval failures:\n  " + r.selfFail.slice(0, 12).join("\n  "));
  if (r.needFail.length) console.log("\nneed failures:\n  " + r.needFail.join("\n  "));
  if (r.scaffoldFail.length) console.log("\nscaffold deciding:\n  " + r.scaffoldFail.join("\n  "));
}
