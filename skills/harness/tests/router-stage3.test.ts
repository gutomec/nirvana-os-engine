// Regressão do Stage 3 — falsa ambiguidade entre rotas do mesmo negócio.
//
// Uma `business_route` declara um regex de ativação. O BM25 indexa o TEXTO desse
// regex, e os padrões de um mesmo negócio compartilham quase todos os tokens
// (`ebook|livro|manual|guia`), então rotas que o brief não aciona pontuavam
// ~0.94 contra o 1.00 da rota certa. Três quase-empates fabricados enchiam a
// janela de ambiguidade e derrubavam HIGH para AMBIGUOUS — o roteador abstinha
// entre alternativas que o próprio contrato declarado já excluía.
//
// A regra é estreita de propósito: só filtra quando o LÍDER é uma rota que
// dispara. A versão larga foi medida e reprovada — em brief sem domínio
// ("quanto é dois mais dois") ela removia o falso concorrente, o líder ficava com
// folga e o sinal virava HIGH apontando um squad de vídeo. Trocava abstenção
// segura por erro confiante. Um piso de score absoluto compensaria, mas não
// existe: medido sobre example_briefs reais contra briefs fora de domínio, as
// distribuições se sobrepõem (real chega a 5.5, fora chega a 12.2).

import { test, expect } from "bun:test";
import * as path from "node:path";

const { stage3Decide } = require(path.join(import.meta.dir, "..", "lib", "router.js"));

const rota = (slug: string, pattern: string, normalized: number) => ({
  id: `business_route:ars-libri:${slug}`,
  normalized,
  meta: { type: "business_route", slug: "ars-libri", route_to: slug, pattern },
});

const ESCREVER = "(escreva|crie|produza)\\s+(o|um|a)?\\s*(ebook|livro|manual)";
const FORMATAR = "(formate|exporte)\\s+(o|um)?\\s*(epub|pdf|kindle)";
const REVISAR = "(audite|revise)\\s+(o|um|meu)?\\s*(rascunho|manuscrito)";

test("rota que não dispara não conta como concorrente quando o líder dispara", () => {
  const brief = "escreva o ebook sobre renda passiva";
  const matches = [
    rota("write-bestseller", ESCREVER, 1.0),
    rota("format-only", FORMATAR, 0.94),
    rota("audit-and-revise", REVISAR, 0.93),
  ];
  const d = stage3Decide(matches, { brief });
  expect(d.signal).toBe("HIGH");
  expect(d.target.meta.route_to).toBe("write-bestseller");
});

test("sem o brief, o comportamento antigo é preservado", () => {
  // Chamador que não passa `brief` não pode ser penalizado: sem texto para
  // testar o regex, não há como saber o que dispara.
  const matches = [
    rota("write-bestseller", ESCREVER, 1.0),
    rota("format-only", FORMATAR, 0.94),
  ];
  expect(stage3Decide(matches, {}).signal).toBe("AMBIGUOUS");
});

test("líder que NÃO dispara preserva a abstenção — o caso do brief sem domínio", () => {
  // Este é o teste que reprovou a versão larga do filtro. O brief não aciona
  // rota nenhuma; sem líder confiável, abster é a resposta certa.
  const brief = "quanto é dois mais dois";
  const matches = [
    rota("write-bestseller", ESCREVER, 1.0),
    { id: "squad_capability:veo-motion-studio:video.image_to_video", normalized: 0.86, meta: { type: "squad_capability", squad: "veo-motion-studio" } },
  ];
  expect(stage3Decide(matches, { brief }).signal).toBe("AMBIGUOUS");
});

test("candidato que não é rota nunca é filtrado", () => {
  // Só `business_route` declara contrato de ativação. Capability de squad não
  // tem regex, então nada nela pode ser descartado por este caminho.
  const brief = "escreva o ebook sobre renda passiva";
  const matches = [
    rota("write-bestseller", ESCREVER, 1.0),
    { id: "squad_capability:ebook-maestro-nirvana:content.book.write_bestseller", normalized: 0.9, meta: { type: "squad_capability", squad: "ebook-maestro-nirvana" } },
  ];
  const d = stage3Decide(matches, { brief });
  expect(d.signal).toBe("AMBIGUOUS");
  expect(d.alternatives.some((a: any) => a.meta.type === "squad_capability")).toBe(true);
});

test("flag inline (?i) não derruba o teste do regex", () => {
  // `(?i)` é sintaxe de Python/Go; `new RegExp` lança nela. 9 das 498 rotas da
  // biblioteca usam. Compilamos com 'i', então remover o prefixo preserva o
  // sentido — sem isso, essas rotas nunca seriam avaliadas.
  const brief = "escreva o ebook sobre renda passiva";
  const matches = [
    rota("write-bestseller", `(?i)${ESCREVER}`, 1.0),
    rota("format-only", `(?i)${FORMATAR}`, 0.94),
  ];
  expect(stage3Decide(matches, { brief }).signal).toBe("HIGH");
});

test("regex inválido mantém o candidato em vez de descartá-lo", () => {
  const brief = "escreva o ebook sobre renda passiva";
  const matches = [
    rota("write-bestseller", ESCREVER, 1.0),
    rota("quebrado", "([sem fechar", 0.94),
  ];
  // O candidato de padrão inválido não pode sumir por defeito de dado; na dúvida
  // ele fica, e a decisão sai como antes.
  expect(stage3Decide(matches, { brief }).signal).toBe("AMBIGUOUS");
});

test("cluster que resolve para o mesmo squad não é ambiguidade", () => {
  // `escreva o ebook` traz a capability do squad em 1º e a rota da empresa para
  // aquele MESMO squad em 2º, com lead de 0.076 — abaixo do necessário para HIGH.
  // Mas o trabalho cai no mesmo lugar, e escolher entre "direto" e "pela empresa"
  // não é pergunta que o dono responda melhor que o roteador. Era o caso H4a/H4b
  // do relatório de validação externa.
  const matches = [
    { id: "squad_capability:ebook-maestro-nirvana:content.book.write_bestseller", normalized: 1.0, meta: { type: "squad_capability", squad: "ebook-maestro-nirvana" } },
    { id: "business_route:ars-libri:x", normalized: 0.924, meta: { type: "business_route", route_to: "ebook-maestro-nirvana::write-bestseller", pattern: "(escreva)\\s+(o)?\\s*(ebook)" } },
  ];
  const d = stage3Decide(matches, { brief: "escreva o ebook sobre renda passiva" });
  expect(d.signal).toBe("HIGH");
  expect(d.target.meta.squad).toBe("ebook-maestro-nirvana");
});

test("destinos diferentes continuam ambíguos", () => {
  // A proteção não pode virar atalho: dois squads distintos empatados é
  // exatamente o caso em que abster é a resposta certa.
  const matches = [
    { id: "squad_capability:a:cap", normalized: 1.0, meta: { type: "squad_capability", squad: "squad-a" } },
    { id: "squad_capability:b:cap", normalized: 0.95, meta: { type: "squad_capability", squad: "squad-b" } },
  ];
  expect(stage3Decide(matches, { brief: "qualquer coisa" }).signal).toBe("AMBIGUOUS");
});

test("destino desconhecido não é colapsado", () => {
  // Sem `meta` que identifique o squad, não dá para afirmar que o destino é o
  // mesmo — e afirmar por omissão seria pior que abster.
  const matches = [
    { id: "x:1", normalized: 1.0, meta: { type: "outro" } },
    { id: "x:2", normalized: 0.95, meta: { type: "outro" } },
  ];
  expect(stage3Decide(matches, { brief: "qualquer coisa" }).signal).toBe("AMBIGUOUS");
});
