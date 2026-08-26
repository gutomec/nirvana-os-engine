# Política Gauntlet multi-target

## Estado

O contrato `nirvana.multi-target-gauntlet-policy/v1alpha1` compila uma política global em decisões explícitas por target e para a síntese. A implementação está em `skills/harness/lib/plan-compiler.ts` e permanece desconectada do executor.

O compilador projeta a política sobre o manifest produzido por `compileManifest`. Portanto, IDs, dependências, ondas paralelas, ordem topológica e caminhos de saída têm uma única fonte. A política não cria nem reescreve o DAG.

## Escopos

| Escopo | Targets | Síntese explícita |
| --- | --- | --- |
| `final-only` | `standard` | `gauntlet` |
| `each-target` | `gauntlet` | `standard`, quando declarada |
| `critical-targets` | apenas targets críticos | `standard`, quando declarada |
| `each-target-and-final` | `gauntlet` | `gauntlet` |
| `adaptive` | conforme sinais determinísticos | `gauntlet`, quando declarada |

`final-only` e `each-target-and-final` exigem `synthesisNodeId`. A referência precisa apontar para um nó `deliverable`. A síntese nunca é inferida a partir do último nó ou da última onda.

## Decisões compiladas

Cada target Business, Squad ou agent recebe:

- `mode`: `standard` ou `gauntlet`;
- `intensity`, somente quando o modo é `gauntlet`;
- limites efetivos de custo, duração e rounds;
- `reason`, com o sinal ou regra que determinou a decisão;
- `source`: padrão retrocompatível, escopo global ou override do target;
- tipo canônico `business`, `squad` ou `agent-x`.

Fases auxiliares, como o brief, também recebem uma decisão explícita `standard` com tipo `support`. Nós `deliverable` não aparecem nessa lista: quando declarados como síntese, têm sua própria decisão no campo `synthesis`.

Um nó `agent` (um papel sem squad especializado, executado pelo agent-x) compila para o tipo `agent-x` e entra em todo escopo, em `criticalTargetIds`, em `targets` e na reserva agregada exatamente como um squad: mesmos sinais do `adaptive`, mesma herança conservadora, mesmos pisos e rateio.

Sem política explícita, todos os targets ficam em `standard` e não há síntese implícita.

## Adaptive

O escopo `adaptive` usa apenas dados serializáveis já presentes no plano:

- criticidade declarada;
- risco `high` declarado;
- fan-in de pelo menos dois nós;
- fan-out transitivo para pelo menos dois dependentes;
- custo estimado igual ou superior a metade do limite global.

Não há chamada a LLM, benchmark, rede, runtime ou estado externo. O mesmo grafo e a mesma política produzem o mesmo snapshot e digest SHA-256.

## Herança conservadora

Um override pode reduzir intensidade e limites, mas não ampliá-los. A intensidade efetiva usa o menor nível entre pai e filho. Cada limite efetivo usa o menor valor declarado entre os dois níveis.

Referências inexistentes, ciclos, escopos, intensidades, modos, riscos e limites inválidos impedem a emissão do plano compilado.

## Reserva agregada de custo

`reserveAggregateGauntletBudget` projeta uma reserva sobre o `CompiledMultiTargetPlan`. O digest da reserva inclui `policyDigest`, ligando a alocação ao snapshot exato que a originou. A função não chama executor, runtime, rede nem medidor de consumo real.

O `maxCostUsd` global da política é o teto agregado. O limite efetivo de cada decisão é sua solicitação individual. Decisões `standard` registram solicitação e concessão zero. Cada alocação informa target, onda, valor solicitado, valor concedido, saldo e razão. Totais por onda tornam o paralelismo visível sem alterar o DAG.

Valores são convertidos para micros de dólar antes do cálculo. Isso evita divergência por ponto flutuante. A ordem é estável:

1. reservar o piso seguro de cada decisão Gauntlet, com USD 1 para `light`, USD 2 para `balanced` e USD 5 para `exhaustive`;
2. rejeitar a reserva inteira quando o teto ou um limite individual não comportar esses pisos;
3. completar a solicitação da síntese, quando houver;
4. ratear o saldo proporcionalmente entre targets, com resíduos de um micro distribuídos pela maior fração e depois pelo ID.

A soma concedida nunca supera o teto nem a solicitação individual. A síntese é protegida, mas não pode consumir os pisos já reservados para targets anteriores.

Ausência de política ou de `maxCostUsd` retorna reserva nula e preserva o plano. Zero explícito é um teto real: um Gauntlet ativo é rejeitado porque não comporta seu piso seguro. Duração não é somada porque ondas paralelas compartilham tempo de parede. Rounds continuam como limites locais, pois somá-los não descreve consumo agregado.

## Limitações e próximo cutover

O coordenador consome decisões e reservas pelas portas do Run Kernel e pelos adapters de dispatch, com entrada pública opt-in em `nrv multi-target run` ([Comando multi-target](gauntlet-multi-target-cli.md)). A reserva é preventiva e não representa dinheiro consumido; o custo observado vem dos eventos `agent_executed` de cada nó. Nenhuma rota existente do dispatch foi alterada.
