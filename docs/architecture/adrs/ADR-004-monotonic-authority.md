# ADR-004: scopes e authority monotônica

**Status:** proposto
**Requisitos:** RK-002, RK-006, GL-005

## Contexto

Runs, agents, turns e tool calls adquirem processes, files, network access e secrets. Sem ownership explícito, crashes deixam órfãos e children podem ampliar autoridade.

## Decisão

Adotar scopes aninhados: Global, Project, Run, Target, Agent, Turn e ToolCall. Cada scope possui disposer stack. Policy do child é a interseção com o parent; `deny` nunca vira `allow`. Filesystem, process, network, secrets e host são domínios independentes.

## Consequências

Prepare e rollback podem liberar resources deterministically. Tool pipeline recebe policy efetiva. Emulação de sandbox deve declarar enforcement real por domínio.

## Alternativas rejeitadas

Permissão por prompt; flag global de ações como policy final; assumir que isolamento de process cobre network e filesystem.
