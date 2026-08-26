# Contrato do avaliador do Gauntlet

## Papel

O Gauntlet produz candidates, pede revisões e seleciona uma revisão por evidência. Quem fornece a evidência é o avaliador. Até este corte, os três canários do `dispatch.ts` julgavam com uma heurística: a fração dos arquivos avaliáveis que passa no quality gate offline, assinada por um alvo nominal (`harness-quality-gate`) que não existe instalado. A heurística continua disponível como último degrau, mas o avaliador de produção passa a ser um executor real, um squad instalado ou o agent-x, que recebe um brief de avaliação, lê o candidate e devolve um scorecard.

Três propriedades são inegociáveis. O avaliador é independente do produtor: `targetsAreIndependent` (`evaluator-registry.ts`) recusa o mesmo alvo antes de qualquer execução, e o controller recusa de novo ao registrar o scorecard. O avaliador não produz nem edita: o diretório do candidate é somente leitura e a única saída permitida é o `scorecard.json`. E nunca há aprovação implícita: scorecard ausente, inválido ou fora do contrato vira `indeterminate`, com toda dimensão reprovada e a razão anexada como evidência.

## O que o avaliador recebe

Cada avaliação de uma revisão de candidate acontece em um diretório isolado, `.nirvana/gauntlet/<runId>/evaluations/<revisionId>/`, criado pelo adapter (`skills/harness/lib/gauntlet/evaluator-adapter.ts`). Antes de despachar, o adapter grava ali dois arquivos e cria, vazio, o subdiretório `outputs/`, o único caminho entregue ao executor como outputs root: os dois arquivos do adapter ficam fora dele e nunca contam como artefatos do executor.

| Arquivo | Conteúdo |
|---|---|
| `evaluation-brief.md` | O brief de avaliação, em PT-BR como todo brief que o engine entrega a um executor: identificação do Run, do candidate e da revisão; a regra de não produzir nem editar; o caminho somente leitura do candidate; a nota de que ler arquivos basta, sem shell; o brief original; o contrato de sucesso em tabela (id, capability, bloqueante, nota mínima, descrição); o caminho do scorecard; o formato JSON com as regras; a guarda de escopo; e, quando o plano marca holdout `evaluator_only`, a instrução de não compartilhar critérios com o produtor. |
| `evaluation-request.json` | O mesmo pedido em forma legível por máquina (`nirvana.gauntlet-evaluation-request/v1alpha1`): `projectId`, `runId`, `candidateId`, `revisionId`, `revision`, `round`, `holdout`, `candidateRoot`, `scorecardPath`, `briefDigest`, `requirements[]` (os `SuccessRequirement` do plano) e `gauntletIds[]`. |

O executor é despachado por um subprocesso do `dispatch.ts` com alvo explícito, nunca pelo roteador:

```
bun dispatch.ts --squad <slug> | --agent-x --brief-file <dir>/evaluation-brief.md --exec \
  --project <projectId>-evl-<revisionId> --outputs-root <dir>/outputs --execution-mode=standard --max-revisions 0 \
  [--runtime <rt>] [--max-budget <usd>]
```

O modo é sempre `standard`: uma avaliação não abre outro Gauntlet, mesmo com `NIRVANA_EXECUTION_MODE=gauntlet` no ambiente. O project id é único por revisão (`<projectId>-evl-<revisionId>`), então o avaliador nunca retoma a sessão nem o scaffold do produtor, e o custo observado no audit é só o daquela avaliação.

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
| `evaluator` | O alvo real que executou (`squad:<slug>:<capabilityId>` ou `agent-x`), nunca o nominal da heurística. |
| `costUsd` | Soma de `agent_executed.cost_usd` no audit do harness para o project id da avaliação e o discriminador do alvo (`squad_slug` para squad, `employee: "agent-x"` para agent-x), a mesma fonte dos adapters multi-target. Sem registro, zero. |
| `createdAt` | O instante da avaliação. |

Cada avaliação também emite `x_gauntlet_evaluation_completed` no audit, com `trace_id` do Run, `candidate_id`, `revision_id`, `evaluator`, `evaluation_project_id`, `evaluation_dir`, `verdict`, `cost_usd`, `exit_code` e, quando indeterminada, `reason`.

## Seleção do alvo

A função compartilhada pelos três canários (`gauntletEvaluatorFor` em `dispatch.ts`, sobre `evaluator-selection.ts`) decide o avaliador antes de qualquer produtor, nesta ordem:

1. `NIRVANA_GAUNTLET_EVALUATOR`, quando definida, é honrada ou recusada, nunca reinterpretada. Formas aceitas: `squad:<slug>[:<capabilityId>]`, `agent-x` e `heuristic`. Um squad tem que estar no registro instalado (`.squads-registry.json`, mantido por `nrv index`); sem capability explícita, usa `quality.specification_conformance` quando o squad a declara, senão a primeira capability declarada. Valor ilegível, squad não instalado, capability não declarada ou alvo não independente do produtor encerram o dispatch com exit 4 e a explicação, antes do produtor.
2. Sem a variável, o registro instalado é percorrido em ordem alfabética de slug em busca de um squad que declare exatamente a capability `quality.specification_conformance` e seja independente do produtor. A regra é o id exato, não um domínio: os squads de domínio `qa` da biblioteca (`data-quality-guardian`, `code-review`, `automated-code-review-squad`) julgam datasets, código TypeScript ou PRs, não um entregável qualquer contra o seu brief, e nenhum squad instalado hoje declara essa capability.
3. Senão, `agent-x`, quando o produtor não é agent-x.
4. Senão, a heurística do quality gate offline.

Cada degrau pulado emite `x_gauntlet_evaluator_fallback { from, reason }` (`unset`, `registry_no_match`, `producer_is_agent_x`); a escolha final emite `x_gauntlet_evaluator_selected { evaluator, source, target, producer, evaluation_share }`, com `source` em `env`, `registry` ou `default`.

## Orçamento

`gauntletRoundBudget(plan, maxBudgetUsd, evaluationShare)` divide o teto do plano por rounds e candidates como antes. Com avaliador real, a parcela de cada candidate é repartida: 75% para o produtor e 25% (`GAUNTLET_EVALUATION_SHARE`) para a avaliação, que vira o `--max-budget` do subprocesso avaliador. A reserva da rodada que `beginRound` registra é a mesma de antes (parcela vezes número de candidates, limitada ao teto do plano), então o custo estimado da avaliação já está dentro dela e o teto do plano continua valendo. Com a heurística, a parcela é zero e nada muda.

## Timeout e abort

O cutover é síncrono, então o subprocesso roda com `spawnSync`. O timeout padrão de uma avaliação é `budget.maxDurationSeconds` do plano; `--timeout` do dispatch o substitui. O timeout mata o filho e a avaliação fica `indeterminate` com a razão. Um `AbortSignal` é observado nas fronteiras que um chamador síncrono consegue ver: já abortado antes do spawn, nada roda; abortado durante, o resultado é descartado como `indeterminate`.

## Smoke com avaliador real

```bash
export NIRVANA_GAUNTLET_EVALUATOR=agent-x          # ou squad:<slug>[:<capabilityId>] com o squad instalado e indexado
nrv dispatch --squad <squad-produtor> --brief-file brief.md --exec --project smoke-evaluator \
  --execution-mode=gauntlet --gauntlet-intensity=light --runtime claude-code --max-budget 4
```

Com produtor `agent-x`, o avaliador tem que ser um squad (`NIRVANA_GAUNTLET_EVALUATOR=squad:<slug>`), porque agent-x não avalia agent-x. Para um Business, some `NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST=<slug>` e use `nrv dispatch <slug> ...`. A prova fica em três lugares: `outputs/<project>/.nirvana/gauntlet/run_<project>/evaluations/<revisionId>/` (brief e request; o scorecard em `outputs/`), o kernel do Run (`gauntlet.evaluation_recorded` com `evaluator` real e `costUsd` observado) e o audit (`x_gauntlet_evaluator_selected`, `x_gauntlet_evaluation_completed`). Nos testes, `NIRVANA_DISPATCH_SCRIPT` aponta o adapter para um dispatch falso que escreve o scorecard (`tests/helpers/fake-dispatch.ts`, knobs `FAKE_DISPATCH_SCORECARD` e `FAKE_DISPATCH_SCORECARD_FOR`).

## Limites

- Um scorecard por avaliação cobre todos os requisitos do contrato; não há um scorecard por gauntlet nem arbitragem entre vários avaliadores.
- O custo observado depende do `agent_executed` que cada caminho do dispatch grava; um avaliador cujo caminho não grava o evento aparece com custo zero.
- O isolamento do candidate é por instrução e por diretório separado, não por sistema de arquivos somente leitura.
- `GAUNTLET_EVALUATION_SHARE` é uma constante; o `estimated_cost_usd` declarado por um squad ainda não entra na estimativa.
