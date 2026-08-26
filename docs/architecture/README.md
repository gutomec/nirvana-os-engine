# Programa de evolução do Nirvana-OS

**Status:** especificação executável proposta
**Idioma:** PT-BR
**Codificação:** UTF-8
**Branch de implementação:** `feat/universal-runtime-glance-gauntlet`

Este diretório é a fonte canônica para a evolução integrada do Run Kernel, runtime universal, Gauntlet Engine e Glance. A especificação preserva businesses, squads e mind-clones como camada semântica do Nirvana. Runtimes, modelos, providers e tools são infraestrutura substituível e nunca assumem responsabilidade organizacional.

## Convenções de estado

| Rótulo | Significado |
|---|---|
| **Existente** | Comportamento confirmado no engine atual. |
| **Proposto** | Contrato aprovado para implementação incremental. |
| **Adiado** | Ideia válida, excluída do primeiro programa. |
| **Rejeitado** | Alternativa incompatível com os invariantes. |

## Mapa da especificação

1. [Visão integrada](integrated-architecture.md)
2. [Requisitos executáveis](executable-requirements.md)
3. [Contratos e schemas](contracts-and-schemas.md)
4. [Máquinas de estado](state-machines.md)
5. [API do control plane](control-plane-api.md)
6. [Migração e compatibilidade](migration-and-compatibility.md)
7. [Plano incremental](implementation-plan.md)
8. [Matriz de testes](test-matrix.md)
9. [Matriz de rastreabilidade](traceability-matrix.md)
10. [Operação do Run Kernel](run-kernel-operations.md)
11. [Canário Gauntlet para agent-x, Squad e Business](agent-x-gauntlet-canary.md)
12. [Operação do Gauntlet Engine](gauntlet-engine-operations.md)
13. [Política Gauntlet multi-target](gauntlet-multi-target-policy.md)
14. [Coordenador Gauntlet multi-target](gauntlet-multi-target-coordinator.md)
15. [Portas Run Kernel para multi-target](gauntlet-multi-target-run-kernel.md)
16. [Adapters de dispatch para multi-target](gauntlet-multi-target-adapters.md)
17. [Comando multi-target](gauntlet-multi-target-cli.md)
18. [Timeline canônica no Glance](glance-canonical-timeline.md)
19. [Execução no Glance](glance-execution.md)
20. [Estado da implementação](implementation-status.md)

## ADRs

- [ADR-001: lifecycle canônico do run](adrs/ADR-001-canonical-run-lifecycle.md)
- [ADR-002: journal, transcript e projections](adrs/ADR-002-journal-transcript-projections.md)
- [ADR-003: publicação de artifacts](adrs/ADR-003-artifact-publication.md)
- [ADR-004: authority e scopes](adrs/ADR-004-monotonic-authority.md)
- [ADR-005: providers universais](adrs/ADR-005-runtime-provider-and-model-broker.md)
- [ADR-006: modo Gauntlet](adrs/ADR-006-gauntlet-execution-mode.md)
- [ADR-007: Glance e ProjectService](adrs/ADR-007-glance-project-control-plane.md)
- [ADR-008: migração por facade](adrs/ADR-008-compatibility-facade.md)

## Gate documental

A especificação passa quando:

- todo requisito crítico tem evidência, contrato e teste;
- estados atuais, propostas e itens adiados estão explícitos;
- business, squad e `agent-x` usam o mesmo lifecycle sem perder sua semântica;
- nenhuma migração reescreve businesses, squads ou mind-clones;
- Glance, CLI e `nrv serve` convergem no mesmo control plane;
- Gauntlet tem orçamento, progresso mensurável, regressão e parada finita;
- runtime e modelo são negociados por capabilities e policy, sem allowlist obrigatória.
