# ADR-005: RuntimeProvider e Model Broker

**Status:** proposto
**Requisitos:** RT-001 a RT-006

## Contexto

Runtimes conhecidos aparecem em unions, aliases e schemas divergentes. Runtime e modelo estão acoplados, embora tenham capabilities, providers e ciclos de atualização diferentes.

## Decisão

O contrato primário é `RuntimeProvider`, que prepara e retoma `AgentHandle`. Runtime e model descriptors são separados. `active` usa o host atual sem allowlist obrigatória. `negotiate` é opt-in e filtra capabilities, enforcement, trust, policy e constraints. Catálogos e aliases pertencem a plugins ou snapshots, não ao core.

## Consequências

Runtime novo pode entrar sem alteração do core após conformance. Troca de provider é decisão sensível. Descriptors não concedem autorização. O driver atual será wrapped durante a migração.

## Alternativas rejeitadas

Allowlist central; nome do produto como prova; MCP como runtime universal; leaderboard global de modelos.
