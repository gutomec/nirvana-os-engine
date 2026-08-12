# Sumário da entrega — trace cla-licenca

- `CLA.md` — CLA v2.0 completo, bilíngue (EN canônico + PT-BR informativo), esqueleto de 7 cláusulas preservado; titularidade retida, licença perpétua/mundial/irrevogável/gratuita/não exclusiva/sublicenciável com direito explícito de relicenciamento (dual licensing), patente estilo Apache ICLA §3 com defensive termination na cláusula 4 (antiga "licença de volta"), direitos morais, declarações, sem remuneração, bot de CLA, lei brasileira.
- `LICENSE-section4.md` — dois blocos substitutos do §4 da SUL (EN ~linha 57, PT ~linha 158), texto plano na largura do arquivo, com delimitação exata de onde cada um entra.
- `CONTRIBUTING-cla-item.md` — item 4 substituto da lista "Pull requests", mesmo registro informal do arquivo original.
- `REVIEW-NOTES.md` — parecer PT-BR da firma: mapa cláusula a cláusula, fontes consultadas (Apache ICLA v2.2 e CLA do n8n, ambos em 11/08/2026), seis riscos remanescentes e sete pontos de validação obrigatória por advogado humano antes do primeiro PR externo.

Verificação executada: 4 arquivos existem e não estão vazios; grep com word boundary por `assign|cede|cessão|cedida|transferência de direitos` nos três textos substitutos retornou zero ocorrências; terminologia "Owner"/"Titular" e "Contribution"/"Contribuição" consistente nos três textos.

Premissas assumidas:

1. Output path: o brief traz `/Users/guto/.nirvana/outputs/...`, a instrução do engajamento traz `/Users/guto/nirvana-os/outputs/...`. Segui a instrução do engajamento (mais recente e explícita).
2. Versão: o CLA novo foi numerado v2.0 (mudança de modelo jurídico justifica major bump sobre o v1.0).
3. Dentro do esqueleto de 7 cláusulas, a licença de patente ocupa a cláusula 4 (vaga da antiga "licença de volta", que perdeu o objeto); a retenção de titularidade ficou registrada na cláusula 2, como o brief permite.
4. O grant de patente corre para o Titular com direito de sublicenciar, não diretamente para cada recipient como no Apache ICLA; a diferença está apontada no risco 4 do parecer.
5. No item do CONTRIBUTING, "contribution" segue minúsculo como no arquivo original (registro informal); os termos definidos capitalizados valem para CLA e LICENSE.
