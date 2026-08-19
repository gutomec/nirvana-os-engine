/**
 * The seat-sufficiency measure: sections + decision content, never line count.
 *
 * Calibrated 2026-08-19 against all 574 employees in the authoring library:
 * 488 rich files → 0 thin, 86 short files → 28 thin, every short-side verdict
 * verified by reading. The fixtures below are SYNTHETIC reproductions of the
 * four calibration anchors' SHAPES (the real files are paid library content
 * and never enter this repo):
 *
 *   dense-short   — few lines, real method (numbered reject-criteria)
 *   role-label    — two lines naming a role, zero method
 *   noun-checklist— many numbered lines, all bare deliverable nouns
 *   prose-method  — deep sections, method in paragraphs, few markers
 *
 * The naive bar this replaces flagged all four shapes the same way when short.
 */
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { seatSufficiency, sufficiencyOfFile, stripFrontmatter } = require_("../lib/seat-sufficiency.js");

const DENSE_SHORT = `
## Identidade
Antagonista de qualidade. Derrubo entregas fracas antes do cliente.

## O que eu procuro
1. Capacidade exposta sem evidência que a sustente no relatório final.
2. Número redondo demais para ser medido — 90% sem denominador declarado.
3. Conclusão que o próprio corpo do documento contradiz duas seções antes.
4. Recomendação sem dono, sem prazo e sem critério de pronto verificável.
5. Gráfico cujo eixo não começa em zero sem aviso explícito ao leitor.

## Como eu opero
Nunca aprovo na primeira leitura. Sempre exijo a fonte primária.
`;

const ROLE_LABEL = `
# Traffic Specialist
Crie o plano detalhado de tráfego com segmentação e orçamento.
`;

const NOUN_CHECKLIST = `
# Strategy Director
Responsável pelo plano estratégico.
1. Posicionamento
2. Persona
3. Funil
4. Canais
5. Orçamento
6. Cronograma
7. Métricas
8. Riscos
9. Concorrência
10. Roadmap
11. Stakeholders
12. Relatórios
`;

const PROSE_METHOD = `
## Identidade
${"Analiso alarmes falsos separando o padrão do ruído com método próprio. ".repeat(6)}

## Como decido
${"A primeira pergunta é se o sinal se repete sob as mesmas condições de contorno. ".repeat(6)}

## O que entrego
${"Um laudo que qualquer engenheiro reproduz sem falar comigo, com a trilha completa. ".repeat(6)}

## Limites
${"Não estendo o laudo a domínios onde o sensor não foi calibrado por nós mesmos. ".repeat(6)}

## Postura
${"Escrevo para o operador de plantão, na língua do turno, sem jargão de comitê. ".repeat(6)}
`;

describe("the four calibration shapes", () => {
  test("dense-short passes — method in few lines is sufficiency, not thinness", () => {
    const r = seatSufficiency(DENSE_SHORT);
    expect(r.verdict).toBe("sufficient");
    expect(r.signals.headings).toBeGreaterThanOrEqual(2);
    expect(r.signals.decisionLines).toBeGreaterThanOrEqual(5);
  });

  test("a two-line role label is thin", () => {
    expect(seatSufficiency(ROLE_LABEL).verdict).toBe("thin");
  });

  test("a noun checklist is thin — twelve numbered nouns carry no decisions", () => {
    // The 30-char substance floor is what separates "1. Posicionamento" from
    // "1. Capacidade exposta sem evidência…".
    const r = seatSufficiency(NOUN_CHECKLIST);
    expect(r.verdict).toBe("thin");
    expect(r.signals.decisionLines).toBe(0);
  });

  test("prose-method passes via the deep-sections branch", () => {
    const r = seatSufficiency(PROSE_METHOD);
    expect(r.verdict).toBe("sufficient");
    expect(r.signals.headings).toBeGreaterThanOrEqual(4);
    expect(r.signals.bodyChars).toBeGreaterThanOrEqual(1500);
  });
});

describe("the decision-line detectors", () => {
  test("PT decimal comma counts as a threshold — rich files write 'F1 0,63'", () => {
    const r = seatSufficiency("## Método\n## Critério\nAceito o modelo quando o F1 passa de 0,63 no conjunto de validação.\nRejeito abaixo disso.\nSempre com denominador.\nNunca sem baseline.\nMeço 2 vezes antes de reportar.");
    expect(r.verdict).toBe("sufficient");
  });

  test("table data rows count; separator rows do not", () => {
    const body = "## Matriz\n## Uso\n| sinal | ação |\n|---|---|\n| queda > 20% | pausar campanha |\n| CPA acima do teto | trocar criativo |\n| ROAS < 1,2 | escalar para CEO |\n| fadiga 3 dias | rotacionar |\n| erro de pixel | abrir ticket |";
    const r = seatSufficiency(body);
    expect(r.verdict).toBe("sufficient");
  });

  test("a giant code dump cannot buy sufficiency alone — capped at 5 lines per block", () => {
    const dump = "```\n" + Array.from({ length: 40 }, (_, i) => `line${i} = ${i}`).join("\n") + "\n```";
    const r = seatSufficiency(dump);
    expect(r.signals.decisionLines).toBe(5);
    expect(r.verdict).toBe("thin");
  });

  test("bold-line pseudo-headings count as structure", () => {
    const body = "**Identidade**\nFaço o corte final.\n**Regras**\n1. Nunca aprovo sem ver a fonte primária do dado citado.\n2. Sempre confiro o denominador antes do percentual reportado.\n3. Rejeito média sem desvio quando a distribuição é assimétrica.\n4. Exijo critério de pronto por escrito antes de começar.\n5. Recuso escopo que muda depois do preço fechado.";
    expect(seatSufficiency(body).verdict).toBe("sufficient");
  });
});

describe("frontmatter handling", () => {
  test("sufficiencyOfFile strips frontmatter before judging", () => {
    const file = `---\nname: x\nrole: y\n---\n${ROLE_LABEL}`;
    expect(sufficiencyOfFile(file).verdict).toBe("thin");
    expect(stripFrontmatter(file)).not.toContain("name: x");
  });

  test("a file with no frontmatter is judged whole", () => {
    expect(sufficiencyOfFile(DENSE_SHORT).verdict).toBe("sufficient");
  });
});
