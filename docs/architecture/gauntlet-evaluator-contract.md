# Contrato do avaliador do Gauntlet

## Papel

O Gauntlet produz candidates, pede revisões e seleciona uma revisão por evidência. Quem fornece a evidência é o avaliador. O julgamento é agêntico por política (`required`): um executor real, um squad instalado ou o `judge-x` do engine, recebe um brief de avaliação, lê o candidate e devolve um scorecard. A heurística offline, a fração dos arquivos avaliáveis que passa no quality gate, assinada por um alvo nominal (`harness-quality-gate`) que não existe instalado, sobrevive só como exceção explícita: `NIRVANA_GAUNTLET_EVALUATOR=heuristic`. Sem avaliador agêntico disponível, o Gauntlet não inicia. A [evidência](#evidência-heurística-contra-juiz-agêntico) que sustenta a política está mais abaixo.

Três propriedades são inegociáveis. O avaliador é independente do produtor: `targetsAreIndependent` (`evaluator-registry.ts`) recusa o mesmo alvo antes de qualquer execução, e o controller recusa de novo ao registrar o scorecard. O avaliador não produz nem edita: o diretório do candidate é somente leitura e a única saída permitida é o `scorecard.json`. E nunca há aprovação implícita: scorecard ausente, inválido ou fora do contrato vira `indeterminate`, com toda dimensão reprovada e a razão anexada como evidência.

## O que o avaliador recebe

Cada avaliação de uma revisão de candidate acontece em um diretório isolado, `.nirvana/gauntlet/<runId>/evaluations/<revisionId>/`, criado pelo adapter (`skills/harness/lib/gauntlet/evaluator-adapter.ts`). Antes de despachar, o adapter grava ali dois arquivos e cria, vazio, o subdiretório `outputs/`, o único caminho entregue ao executor como outputs root: os dois arquivos do adapter ficam fora dele e nunca contam como artefatos do executor.

| Arquivo | Conteúdo |
|---|---|
| `evaluation-brief.md` | O brief de avaliação, em PT-BR como todo brief que o engine entrega a um executor: identificação do Run, do candidate e da revisão; a regra de não produzir nem editar; o caminho somente leitura do candidate; a nota de que ler arquivos basta, sem shell; o brief original; o contrato de sucesso em tabela (id, capability, bloqueante, nota mínima, descrição); o caminho do scorecard; o formato JSON com as regras; a guarda de escopo; e, quando o plano marca holdout `evaluator_only`, a instrução de não compartilhar critérios com o produtor. |
| `evaluation-request.json` | O mesmo pedido em forma legível por máquina (`nirvana.gauntlet-evaluation-request/v1alpha1`): `projectId`, `runId`, `candidateId`, `revisionId`, `revision`, `round`, `holdout`, `candidateRoot`, `scorecardPath`, `briefDigest`, `requirements[]` (os `SuccessRequirement` do plano) e `gauntletIds[]`. |

O executor é despachado por um subprocesso do `dispatch.ts` com alvo explícito, nunca pelo roteador:

```
bun dispatch.ts --squad <slug> | --judge-x | --agent-x --brief-file <dir>/evaluation-brief.md --exec \
  --project <projectId>-evl-<revisionId> --outputs-root <dir>/outputs --execution-mode=standard --max-revisions 0 \
  [--runtime <rt>] --max-budget <cota de avaliação>
```

O modo é sempre `standard`: uma avaliação não abre outro Gauntlet, mesmo com `NIRVANA_EXECUTION_MODE=gauntlet` no ambiente. O project id é único por revisão (`<projectId>-evl-<revisionId>`), então o avaliador nunca retoma a sessão nem o scaffold do produtor, e o custo observado no audit é só o daquela avaliação. O `--max-budget` do filho é a cota de avaliação calculada em [Orçamento](#orçamento).

## O que o avaliador escreve

Exatamente um arquivo, `scorecard.json`, no seu `output_path`: `<dir>/outputs/scorecard.json`, o caminho absoluto indicado no brief e no pedido. Schema `nirvana.gauntlet-scorecard/v1alpha1`, validado com zod em modo estrito (`evaluation-contract.ts`): chaves desconhecidas são rejeitadas.

```json
{
  "schemaVersion": "nirvana.gauntlet-scorecard/v1alpha1",
  "verdict": "pass | revise | reject | indeterminate",
  "dimensions": [
    { "id": "<id do requisito>", "score": 0.0, "confidence": 0.0, "blocking": true, "passed": false, "evidenceRefs": ["<referência verificável>"] }
  ],
  "revisionRequests": [ { "requirementId": "<id do requisito>", "evidenceRefs": ["<o que falta ou está errado>"] } ],
  "regressions": ["<id do requisito>"]
}
```

| Campo | Regra |
|---|---|
| `schemaVersion` | Opcional; quando presente, tem que ser o valor acima. |
| `verdict` | `pass` somente com todas as dimensões aprovadas; um veredito diferente de `pass` exige ao menos uma dimensão reprovada. |
| `dimensions[]` | Uma por requisito do contrato, `id` idêntico ao declarado; nenhuma a mais, nenhuma a menos, nenhuma repetida. `score` e `confidence` em `[0, 1]`. `blocking` igual ao contrato. `passed` só pode ser `true` com `score` maior ou igual à nota mínima do requisito. |
| `revisionRequests[]` | Requisitos a revisar, sempre do contrato, com evidências. É o que o cutover entrega ao produtor na seção "Defeitos a corrigir" da revisão seguinte. |
| `regressions[]` | Requisitos que pioraram em relação à revisão anterior, quando o avaliador tem essa informação; senão `[]`. |
| `evidenceRefs[]` | Caminhos ou referências verificáveis dentro do candidate. |

## Validação e `indeterminate`

O adapter lê o arquivo depois que o subprocesso termina e aplica a validação. Qualquer uma destas condições produz um scorecard `indeterminate`: arquivo ausente, JSON inválido, schema violado, dimensão fora do contrato, requisito sem dimensão, `blocking` diferente do contrato, aprovação abaixo da nota mínima, veredito inconsistente com as dimensões, `revisionRequests` ou `regressions` que nomeiam requisitos inexistentes, timeout do subprocesso ou abort. O scorecard `indeterminate` tem uma dimensão por requisito, todas com `score: 0`, `confidence: 1`, `passed: false`, `blocking` como no contrato e `evidenceRefs: ["indeterminate: <razão>"]`. `revisionRequests` fica vazio, porque não há defeito causal a corrigir: o candidate não foi julgado.

O cutover (`agent-x-cutover.ts`) trata o veredito `indeterminate` como parada: nenhuma revisão é pedida ao produtor e o gate final não roda. O Run termina `withheld` com `reason: evaluation_indeterminate`, mesmo quando o controller parou por conta própria (`no_progress` em `light`, por exemplo). Em `balanced` e `exhaustive`, onde a paciência permitiria uma revisão, o Gauntlet para com `execution_failure` e a reserva `evaluation_indeterminate`. A decisão é tomada a partir dos scorecards persistidos, então uma retomada após crash chega à mesma parada.

## Identidade preenchida pelo adapter

O arquivo não carrega identidade; o adapter preenche o `EvaluationScorecard` que o controller registra:

| Campo | Valor |
|---|---|
| `evaluationId` | `evl_<revisionId>` |
| `candidateId`, `revisionId` | Os do candidate avaliado. |
| `gauntletId` | Os ids dos gauntlets do plano, unidos por vírgula (`brief-conformance` no plano compilado padrão). |
| `rubricVersion` | `gauntlet-evaluator/v1` |
| `evaluator` | O alvo real que executou (`squad:<slug>:<capabilityId>`, `agent-x:judge-x` ou `agent-x:agent-x`), nunca o nominal da heurística. |
| `costUsd` | Soma de `agent_executed.cost_usd` no audit do harness para o project id da avaliação e o discriminador do alvo (`squad_slug` para squad, `employee: "judge-x"` para o judge-x, `employee: "agent-x"` para agent-x), a mesma fonte dos adapters multi-target. Sem registro, zero. |
| `createdAt` | O instante da avaliação. |

Cada avaliação também emite `x_gauntlet_evaluation_completed` no audit, com `trace_id` do Run, `candidate_id`, `revision_id`, `evaluator`, `evaluation_project_id`, `evaluation_dir`, `verdict`, `cost_usd`, `exit_code` e, quando indeterminada, `reason` (e `reason_code: budget_exhausted` quando a cota do juiz acabou antes do scorecard).

## judge-x, o juiz do engine

`judge-x` é o avaliador que toda instalação tem sem variável, sem squad e sem passo de instalação (`skills/harness/lib/gauntlet/judge-x.ts`). Ele roda pelo mesmo driver headless e pelo mesmo mecanismo de persona do `agent-x`, mas é outra identidade.

**Identidade.** O `TargetRef` do judge é `{ kind: "agent-x", slug: "judge-x" }`. O tipo (`run-kernel/types.ts`) fixava `slug: "agent-x"`; a alternativa era um `kind` novo. A decisão foi estender o slug, porque a independência entre produtor e avaliador é comparada por `kind` e `slug` (`targetsAreIndependent`, `evaluator-registry.ts`): com o slug próprio o judge é independente do produtor agent-x, de todo squad e de todo business, e o kernel, o Glance e os validadores, que só leem `kind`, continuam aceitando o valor sem mudança. Um `kind` novo teria tocado todas as uniões de `kind` do engine (cascata, delivery pipeline, plan compiler, servidor do Glance, execution runner, fila do canário) para nada. O judge nunca é produtor: `--judge-x` não entra na cascata, não abre Gauntlet aninhado e não passa pelo gate de entrega de conteúdo.

**Persona.** Sete arquivos, um por runtime, `skills/_shared/agents/judge-x.<runtime>.md` (claude-code, codex, gemini, antigravity, grok, kimi, pi), na mesma estrutura das personas do agent-x e cobertos pelo gate `check-scope-guard`. A persona é curta e fechada: lê o brief de avaliação, o contrato e o candidate (somente leitura), não produz nem edita, escreve um único `scorecard.json` no `output_path`, evidência por arquivo ou trecho, nota conservadora, `indeterminate` quando não consegue julgar, e a guarda de escopo. Sem recrutamento de squads, sem `nrv`, sem rollover. A resolução é estrita: `judge-x.<flavor>.md` do runtime, nunca a persona de outro runtime; um runtime sem persona (`qwen-code`, `opencode`) não tem juiz.

**Prompt enxuto.** O prompt do judge é a persona mais o brief de avaliação, com o bloco de dispatch (trace, `output_path`, `scorecard_path`) e a guarda de escopo. Sem diretiva autônoma, sem catálogo de squads, sem regras de runtime, sem roteamento. Medida no brief da avaliação do smoke de 26/08/2026 (Café Solar, brief de avaliação com 3.012 caracteres), contagem aproximada de tokens por caracteres/4:

| Primeiro turno montado pelo engine | Caracteres | Tokens aproximados |
|---|---|---|
| `agent-x` como avaliador: persona (6.099) + bloco de dispatch + brief + `AUTONOMOUS_DIRECTIVE` (5.875) | ~15.500 | ~3.900 |
| `judge-x`: persona (~3.600) + bloco de dispatch + brief | ~7.000 | ~1.750 |

O que envolve o brief cai de ~12.500 para ~4.000 caracteres (um terço); o turno inteiro cai pela metade. Os ~55 mil tokens observados no filho do smoke incluem o que o próprio Claude Code carrega (prompt de sistema, ferramentas, `CLAUDE.md` do projeto e do usuário, índice de skills), igual para os dois e fora do que o engine monta. O teste `judge-x.test.ts` fixa as duas razões.

**Execução.** O adapter despacha `dispatch.ts --judge-x --brief-file <dir>/evaluation-brief.md --exec --project <projectId>-evl-<revisionId> --outputs-root <dir>/outputs --execution-mode=standard --max-revisions 0 --max-budget <cota>`. O filho lê o `evaluation-request.json` ao lado do outputs root (sem ele, exit 4: o judge não aceita brief livre), roda a persona pelo driver com `--max-budget-usd` igual à cota, e valida o próprio `scorecard.json` contra os requisitos do pedido. O Run canônico do filho (alvo `agent-x:judge-x`) termina `completed` só se o scorecard existir e validar; senão `withheld`, com `verify_failed` e a razão. Um estouro da cota (`claude` devolve o subtipo `error_max_budget_usd`) vira `budget_exhausted` no stderr do filho, no `agent_exec_failed` e no scorecard `indeterminate` que o adapter monta, nunca um "error verdict" anônimo. O audit do filho grava `x_dispatch_judge_x` (runtime, persona, tamanho do prompt, cota) e `agent_executed { employee: "judge-x" }`.

## Seleção do alvo

A função compartilhada pelos três canários (`gauntletEvaluatorFor` em `dispatch.ts`, sobre `evaluator-selection.ts`) decide o avaliador antes de qualquer produtor, nesta ordem:

1. `NIRVANA_GAUNTLET_EVALUATOR`, quando definida, é honrada ou recusada, nunca reinterpretada. Formas aceitas: `squad:<slug>[:<capabilityId>]`, `judge-x`, `agent-x` e `heuristic`. Um squad tem que estar no registro instalado (`.squads-registry.json`, mantido por `nrv index`); sem capability explícita, usa `quality.specification_conformance` quando o squad a declara, senão a primeira capability declarada. `agent-x` só é aceito quando o produtor não é agent-x. Valor ilegível, squad não instalado, capability não declarada, alvo não independente do produtor ou `judge-x` sem persona para o runtime encerram o dispatch com exit 4 e a explicação, antes do produtor.
2. Sem a variável, o registro instalado é percorrido em ordem alfabética de slug em busca de um squad que declare exatamente a capability `quality.specification_conformance` e seja independente do produtor. A regra é o id exato, não um domínio: os squads de domínio `qa` da biblioteca (`data-quality-guardian`, `code-review`, `automated-code-review-squad`) julgam datasets, código TypeScript ou PRs, não um entregável qualquer contra o seu brief. Quem quiser um juiz próprio cria um squad com essa capability na própria biblioteca e a seleção o prefere ao judge-x.
3. Senão, `judge-x`, para qualquer produtor: agent-x, squad ou business.
4. Senão, nada. Sem persona do judge para o runtime, ou com o CLI fora do PATH, a seleção é `unavailable`: o dispatch grava `x_gauntlet_evaluator_unavailable`, explica, encerra com exit 4 antes de qualquer produtor e transiciona o Run (criado ali, ou adotado por `--run-id`) para `rolled_back` com `reason: evaluator_unavailable`, o mesmo desenho de `runtime_incompatible`.

A heurística offline nunca é degrau: só `NIRVANA_GAUNTLET_EVALUATOR=heuristic` a seleciona, e a escolha grava `x_gauntlet_evaluator_heuristic_opt_in`. Cada degrau pulado emite `x_gauntlet_evaluator_fallback { from, reason }` (`unset`, `registry_no_match`, `judge_unavailable` com `detail`); a escolha final emite `x_gauntlet_evaluator_selected { evaluator, source, target, producer, evaluation_share, evaluation_floor_usd }`, com `source` em `env`, `registry` ou `default`. `nrv doctor` mostra, na linha `gauntlet: evaluator`, o que esta mesma seleção escolheria hoje e por quê, sem executar nada.

## Orçamento

`gauntletRoundBudget(plan, maxBudgetUsd, evaluationShare)` divide o teto do plano por rounds e candidates: a parcela de um candidate é `maxCostUsd / (candidates × rounds)`, e `--max-budget` só a reduz. Com avaliador real, a parcela é repartida entre produtor e avaliação: a avaliação recebe o maior entre 25% da parcela (`GAUNTLET_EVALUATION_SHARE`) e o piso absoluto `GAUNTLET_EVALUATION_FLOOR_USD = USD 1,50`, e o produtor recebe o restante. A cota da avaliação é o `--max-budget` do subprocesso avaliador; o restante é o do produtor. A reserva da rodada que `beginRound` registra continua sendo parcela vezes número de candidates, limitada ao teto do plano, então a avaliação já está dentro dela e o teto continua valendo.

O piso vem da medida: um julgamento pelo brief de avaliação custou USD 0,74 a 0,93 em três turnos, e o avaliador agent-x do primeiro smoke morreu em USD 0,82 no primeiro turno sob os USD 0,625 que 25% da parcela de `light` (USD 5 / 2 rounds = USD 2,50) permitiam. Por isso o perfil `light` passou de USD 5 para USD 8: parcela de USD 4 por candidate, USD 1,50 para o juiz e USD 2,50 para o produtor (o candidate do smoke custou USD 1,65). A conta por perfil, sem `--max-budget`:

| Perfil | Teto | Candidates × rounds | Parcela | Juiz | Produtor |
|---|---|---|---|---|---|
| `light` | USD 8 | 1 × 2 | USD 4,00 | USD 1,50 (piso) | USD 2,50 |
| `balanced` | USD 25 | 3 × 4 | USD 2,08 | USD 1,50 (piso) | USD 0,58 |
| `exhaustive` | USD 100 | 5 × 6 | USD 3,33 | USD 1,50 (piso) | USD 1,83 |

Quando a parcela não comporta produtor e piso do juiz (o restante do produtor é zero ou negativo, por exemplo `light` com `--max-budget 1.5`), o Gauntlet não inicia: `x_gauntlet_budget_insufficient` com a conta, o Run `rolled_back` com `reason: max_cost` antes de qualquer produtor e exit 1, em vez de estourar no meio da rodada. Com a heurística, a parcela da avaliação é zero e nada muda.

## Evidência: heurística contra juiz agêntico

Experimento de 26/08/2026, mesmo brief (Café Solar), quatro candidates, avaliação pelo brief do contrato via `claude -p` (3 turnos, USD 0,74 a 0,93, 39 a 64 s cada) contra a heurística offline (`quality-gate.ts --offline` por arquivo):

| Candidate | Verdade | Heurística | Juiz agêntico |
|---|---|---|---|
| A, real, no brief | bom | 2/2 | `pass` 0,92 |
| B, no brief, incompleto, em inglês | revisar | 0/2 | `revise` 0,25, três defeitos por linha |
| C, poema | rejeitar | 0/2 | `reject` 0,05 |
| D, copy estruturada de outro produto | rejeitar | 1/2 (`copy.md` aprovado) | `revise` 0,15, "produto inteiramente diferente" |

A heurística não separa B de C e aprova o arquivo principal de D; o juiz acertou os quatro com evidência verificável. É a justificativa da política `required`.

## Timeout e abort

O cutover é síncrono, então o subprocesso roda com `spawnSync`. O timeout padrão de uma avaliação é `budget.maxDurationSeconds` do plano; `--timeout` do dispatch o substitui. O timeout mata o filho e a avaliação fica `indeterminate` com a razão. Um `AbortSignal` é observado nas fronteiras que um chamador síncrono consegue ver: já abortado antes do spawn, nada roda; abortado durante, o resultado é descartado como `indeterminate`.

## Smoke com avaliador real

Sem variável, o judge-x julga; `--max-budget 4` deixa a parcela de `light` em USD 4 (USD 1,50 para o juiz, USD 2,50 para o produtor). Produtor squad:

```bash
unset NIRVANA_GAUNTLET_EVALUATOR
nrv dispatch --squad <squad-produtor> --brief-file brief.md --exec --project smoke-judge-squad \
  --execution-mode=gauntlet --gauntlet-intensity=light --runtime claude-code --max-budget 4
```

Produtor agent-x, julgado pelo judge-x (agent-x não avalia agent-x; o judge-x é outra identidade):

```bash
unset NIRVANA_GAUNTLET_EVALUATOR
nrv dispatch --agent-x --brief-file brief.md --exec --project smoke-judge-agent-x \
  --execution-mode=gauntlet --gauntlet-intensity=light --runtime claude-code --max-budget 4
```

Para um Business, some `NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST=<slug>` e use `nrv dispatch <slug> ...`; para um juiz próprio, `NIRVANA_GAUNTLET_EVALUATOR=squad:<slug>[:<capabilityId>]` com o squad instalado e indexado. A prova fica em três lugares: `outputs/<project>/.nirvana/gauntlet/run_<project>/evaluations/<revisionId>/` (brief e request; o scorecard em `outputs/`), o kernel do Run (`gauntlet.evaluation_recorded` com `evaluator` real e `costUsd` observado) e o audit (`x_gauntlet_evaluator_selected`, `x_dispatch_judge_x` no projeto `<project>-evl-<revisionId>`, `x_gauntlet_evaluation_completed`). Nos testes, `NIRVANA_DISPATCH_SCRIPT` aponta o adapter para um dispatch falso que escreve o scorecard (`tests/helpers/fake-dispatch.ts`, knobs `FAKE_DISPATCH_SCORECARD` e `FAKE_DISPATCH_SCORECARD_FOR`), e o `dispatch.ts --judge-x` real roda sobre um `claude` falso (`judge-x-dispatch.e2e.test.ts`, `gauntlet-evaluator-dispatch.e2e.test.ts`).

## Limites

- Um scorecard por avaliação cobre todos os requisitos do contrato; não há um scorecard por gauntlet nem arbitragem entre vários avaliadores.
- O custo observado depende do `agent_executed` que cada caminho do dispatch grava; um avaliador cujo caminho não grava o evento aparece com custo zero.
- O isolamento do candidate é por instrução e por diretório separado, não por sistema de arquivos somente leitura.
- `GAUNTLET_EVALUATION_SHARE` e `GAUNTLET_EVALUATION_FLOOR_USD` são constantes; o `estimated_cost_usd` declarado por um squad ainda não entra na estimativa.
- O subtipo `error_max_budget_usd` é do `claude`; nos outros runtimes não há teto de gasto no CLI (`runHeadless` avisa), então um estouro do juiz aparece como scorecard ausente, sem o nome `budget_exhausted`.
- O engine não materializa um squad avaliador em `~/squads`: os registros começam vazios por desenho e `~/squads` é camada do usuário. O judge-x cobre toda máquina; um juiz próprio é um squad da biblioteca do usuário com `quality.specification_conformance`.
