# Parecer da firma: migração do CLA do modelo de cessão para o modelo de licença

Juridical Singularity · prática corporate (js-managing-partner, com revisão do
js-corporate-lead) · trace `cla-licenca` · 11 de agosto de 2026.

Cliente: Nirvana-OS (Titular: Luiz Gustavo Vieira Rodrigues). Objeto: novo
`CLA.md` v2.0, §4 da SUL v1.0 e item 4 de "Pull requests" no `CONTRIBUTING.md`.
Janela de oportunidade confirmada no brief: zero assinaturas do CLA v1.0, então
a troca de modelo não cria classes distintas de contribuidores nem exige
repactuação. Depois do primeiro PR externo assinado, essa troca deixa de ser
barata.

## O que mudou e por quê

O CLA v1.0 transferia ao Titular os direitos patrimoniais de cada contribuição
(cessão, na terminologia da Lei 9.610/98, arts. 49 e seguintes). O v2.0 adota o
desenho do Apache ICLA: o contribuidor permanece dono da obra e concede ao
Titular uma licença perpétua, mundial, irrevogável, gratuita, não exclusiva e
sublicenciável, com o direito explícito de licenciar e relicenciar a
contribuição sob quaisquer termos, inclusive comerciais e proprietários. Na
prática, a liberdade comercial do projeto (packs pagos, dual licensing futuro)
permanece a mesma; o que muda é a posição do contribuidor, que deixa de se
desfazer do que criou. Percepção de justiça e fricção de entrada eram o motivo
da migração, e o modelo de licença é hoje o padrão de mercado em projetos
fair-code.

Mapa cláusula a cláusula do novo `CLA.md` (esqueleto de 7 cláusulas preservado):

| Cláusula | v1.0 (cessão) | v2.0 (licença) |
|---|---|---|
| 1 | Definições | Mantida; adiciona a definição de "Owner"/"Titular" |
| 2 | Transferência dos direitos patrimoniais | Titularidade retida + licença de direitos autorais com todos os adjetivos + direito explícito de relicenciamento |
| 3 | Direitos morais | Mantida (Lei 9.610/98, art. 27; autoria no histórico do git) |
| 4 | Licença de volta ao contribuidor | Substituída pela licença de patente estilo Apache ICLA §3, com defensive termination. A "licença de volta" perdeu o objeto: quem mantém a titularidade não precisa de licença sobre a própria obra; a retenção fica registrada na cláusula 2 |
| 5 | Declarações do contribuidor | Mantida (obra original, material de terceiros identificado, permissão do empregador) |
| 6 | Sem obrigação de aceitar | Ampliada: sem remuneração e sem participação no Projeto + sem obrigação de aceitar |
| 7 | Assinatura via bot + lei brasileira | Mantida |

A cláusula de patente é adição real de proteção: o v1.0 não tratava de
patentes. Sem ela, um contribuidor poderia licenciar o copyright e depois
processar usuários por infração de patente sobre a mesma contribuição.

## Fontes consultadas

- Apache Software Foundation, Individual Contributor License Agreement v2.2
  (apache.org/licenses/icla.pdf, consultado em 11/08/2026). Extraímos: a
  reserva de titularidade do preâmbulo ("Except for the license granted herein
  [...] You reserve all right, title, and interest in and to Your
  Contributions"), os adjetivos do grant de copyright do §2 ("perpetual,
  worldwide, non-exclusive, no-charge, royalty-free, irrevocable") e o §3 de
  patente com defensive termination ("any patent licenses granted to that
  entity [...] shall terminate as of the date such litigation is filed").
- n8n, `CONTRIBUTOR_LICENSE_AGREEMENT.md` (github.com/n8n-io/n8n, consultado em
  11/08/2026). É a referência fair-code para o direito explícito de
  relicenciamento: "I give n8n permission to license my contributions on any
  terms they like". Nosso texto vai além do n8n em dois pontos: o CLA deles não
  tem cláusula de patente nem declarações robustas do contribuidor.
- Lei 9.610/98 (arts. 4º, 24, 27, 49), Lei 9.609/98 (art. 2º, §1º; art. 4º),
  Lei 9.279/96 (art. 42) e MP 2.200-2/2001 (art. 10, §2º), citadas adiante nos
  riscos.

## Riscos remanescentes

1. **Irrevogabilidade de licença gratuita sob direito brasileiro.** A Lei
   9.610/98 manda interpretar restritivamente negócios sobre direitos autorais
   (art. 4º) e disciplina cessão e licença com menos precisão do que o direito
   americano. Uma licença perpétua, irrevogável e sem contraprestação pode ser
   atacada como revogável por analogia à doação ou por onerosidade; é o risco
   estrutural do modelo de licença frente ao de cessão. Mitigantes: o caráter
   sinalagmático do ecossistema (o contribuidor recebe o engine sob a SUL e a
   integração do seu código no produto) e a prática internacional consolidada.
   Risco baixo, mas não zero, e é a diferença de robustez que o dono aceitou ao
   trocar de modelo.
2. **Software e direitos morais.** Para programa de computador, a Lei 9.609/98
   (art. 2º, §1º) reduz os direitos morais a paternidade e oposição a
   alterações que deformem a obra e atinjam a honra do autor. A cláusula 3 cita
   a regra geral do art. 27 da Lei 9.610/98; para código, o regime aplicável é
   o mais estreito, o que joga a favor do projeto.
3. **Contribuidor empregado.** Pela Lei 9.609/98, art. 4º, o software criado na
   vigência de contrato de trabalho com esse objeto pertence ao empregador. A
   declaração (c) da cláusula 5 cobre o cenário, mas depende da veracidade do
   que o contribuidor afirma.
4. **Grant de patente corre só para o Titular.** O Apache ICLA concede patente
   à Foundation e também aos recipients do software. Nós concedemos ao Titular
   com direito de sublicenciar, o que alcança os usuários via SUL ou licença
   comercial; é mais simples e serve ao dual licensing, mas a proteção
   downstream fica mediada pelo Titular.
5. **CLA de indivíduos, sem CCLA.** A definição de "Você" admite entidades,
   mas não há instrumento corporativo separado (o equivalente ao Corporate CLA
   da Apache) nem verificação de poderes de quem assina em nome da entidade.
6. **Foro.** A cláusula 7 elege as leis do Brasil sem eleição de foro; a SUL §9
   elege São Paulo e arbitragem CAM-CCBC para estrangeiros. A assimetria é
   tolerável, mas evitável.

## O que um advogado humano deve validar antes do primeiro PR externo mesclado

1. **Validade da assinatura via bot.** O aceite por comentário em pull request
   é assinatura eletrônica não-ICP; a MP 2.200-2/2001 (art. 10, §2º) a admite
   quando as partes reconhecem o meio. Validar o fluxo do bot e o arquivamento
   da evidência: identidade do signatário, data, hash ou versão exata do texto
   assinado.
2. **Sustentação da irrevogabilidade** da licença gratuita e perpétua sob a
   Lei 9.610/98 e o Código Civil (risco 1 acima), incluindo se convém inserir
   contraprestação simbólica ou reforço de causa no texto.
3. **Alcance do direito de relicenciamento** frente à interpretação restritiva
   do art. 4º da Lei 9.610/98: confirmar que a enumeração da cláusula 2 cobre
   todos os modos de exploração do modelo de packs (distribuição de cópias
   watermarkadas, venda de licenças comerciais, SaaS futuro).
4. **Eficácia da cláusula de patente no Brasil** (Lei 9.279/96) e a
   executabilidade da defensive termination perante tribunal brasileiro.
5. **Capacidade civil do signatário** (menores de idade contribuindo via
   GitHub) e tratamento de entidades sem CCLA (risco 5).
6. **Alinhamento de foro** entre CLA cláusula 7 e SUL §9 (risco 6).
7. **Regime bilíngue.** Confirmar que manter o inglês como texto canônico com
   tradução informativa é sustentável perante contribuidor brasileiro
   hipossuficiente, e que as duas versões do v2.0 não divergem em nenhum ponto
   material.

## Conclusão da firma

A migração é juridicamente sã e o momento é o correto: sem assinaturas legadas,
não há classe de contribuidores sob o regime antigo. O texto entregue preserva
integralmente a liberdade comercial do Titular pelo trio licença sublicenciável
+ direito explícito de relicenciamento + patente com defensive termination, e
melhora a posição do contribuidor sem custo prático para o projeto. Nenhum dos
três textos substitutos descreve mecanismo de transferência de titularidade;
verificação por grep consta no `_SUMMARY.md`. Este parecer é trabalho de agente
de IA e não substitui advogado habilitado na OAB; os sete pontos acima são a
pauta mínima dessa validação humana.
