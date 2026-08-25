# Operação do Gauntlet Engine

## Ativação

O modo padrão continua sendo `standard`. Manifests legados sem `execution` não mudam de comportamento. A escolha explícita usa:

```bash
nrv run <business> "<brief>" --execution-mode=gauntlet --gauntlet-intensity=balanced
```

Os perfis disponíveis são `light`, `balanced` e `exhaustive`. O modo `auto` só escolhe Gauntlet quando a policy permite seleção automática e o brief foi classificado como verificável e de risco médio ou alto. A decisão e o motivo entram no audit.

### Canário Business light

O canário de Business exige allowlist explícita:

```bash
export NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST="business-slug"
nrv run business-slug "<brief>" --execution-mode=gauntlet --gauntlet-intensity=light
```

Vários slugs usam separação por vírgula. Não há valor padrão e não existe Business hardcoded. Para rollback operacional imediato:

```bash
export NIRVANA_BUSINESS_GAUNTLET_KILL_SWITCH=1
```

O kill switch e qualquer bypass são avaliados antes do producer. Falha pré-produção pode retornar ao executor legado. Depois que a produção começa, o canário termina de forma auditável e nunca dispara a produção legada na mesma tentativa.

## Contrato de aplicação

O módulo `skills/harness/lib/gauntlet/` expõe compiler, evaluator registry, store durável e controller. O caller cria o Run no kernel, compila o plano e inicia `GauntletController`. Antes de cada fan-out, chama `beginRound` com a reserva de custo. Candidates, revisions e scorecards são registrados com IDs estáveis.

Uma revision exige parent, evaluations causais e hipótese de melhoria. O evaluator deve declarar a capability exigida e ter target diferente do producer. Depois da revision, o caller registra os testes anteriores e os novos no mesmo scorecard. Uma regressão blocking encerra o Gauntlet com `critical_regression`.

O resultado do controller é `delivered`, `withheld` ou `reservations`. Essa decisão não substitui o quality gate final. O evento terminal contém `finalQualityGateRequired: true`.

## Recovery e replay

Plan, candidates, evaluations e projection usam o mesmo SQLite do Run Kernel. Cada escrita de domínio inclui um event na outbox dentro da mesma transação. Repetir a mesma chave retorna o estado persistido. Repetir um ID com conteúdo diferente falha.

Após crash, o caller reabre o kernel e instancia o controller com `projectId` e `runId`. `resume` retorna round, custo, melhor score e stop state. Side effects externos continuam sob responsabilidade do runtime adapter e precisam usar as chaves registradas no journal.

`RunKernelCompatibilityFacade.publishPending` projeta os events canônicos como `x_run_kernel_projection` no audit legado. A entrega é pelo menos uma vez. Consumers deduplicam por `event_id`.

## Limitações do primeiro cutover

- O CLI reconhece e audita a seleção. O fan-out concreto continua sendo fornecido pelo adapter de dispatch por callbacks do controller.
- Holdout é metadata `evaluator_only`. O isolamento do conteúdo depende do runtime adapter.
- Cost é reservado antes da round. Reconciliação com cobrança real deve emitir o custo observado pelo adapter.
- Arbitragem automática de judges não foi adicionada. Divergência material encerra com `judge_disagreement`.
- Candidates preservam referências imutáveis. A validação física dos artifacts continua no `ArtifactRef` do Run Kernel.
