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

Cada target Business ou Squad recebe:

- `mode`: `standard` ou `gauntlet`;
- `intensity`, somente quando o modo é `gauntlet`;
- limites efetivos de custo, duração e rounds;
- `reason`, com o sinal ou regra que determinou a decisão;
- `source`: padrão retrocompatível, escopo global ou override do target;
- tipo canônico `business` ou `squad`.

Fases auxiliares, como o brief, também recebem uma decisão explícita `standard` com tipo `support`. Nós `deliverable` não aparecem nessa lista: quando declarados como síntese, têm sua própria decisão no campo `synthesis`.

O contrato reserva `agent-x` como tipo de decisão para compatibilidade futura, mas o grafo atual não fabrica esse target.

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

## Limitações e próximo cutover

Este incremento não conecta decisões ao dispatch multi-target, ao controller Gauntlet ou ao Run Kernel. Também não reserva orçamento entre targets e síntese. O próximo cutover deve consumir o snapshot imutável no executor existente, preservar idempotência e crash resume e provar que uma decisão `standard` segue o caminho legado sem divergência.
