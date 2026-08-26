# Operação do Gauntlet Engine

## Ativação

O modo padrão continua sendo `standard`. Manifests legados sem `execution` não mudam de comportamento. A escolha explícita usa:

```bash
nrv run <business> "<brief>" --execution-mode=gauntlet --gauntlet-intensity=balanced
```

Os perfis disponíveis são `light`, `balanced` e `exhaustive`. O modo `auto` só escolhe Gauntlet quando a policy permite seleção automática e o brief foi classificado como verificável e de risco médio ou alto. A decisão e o motivo entram no audit.

### Canário Business

O canário de Business exige allowlist explícita e aceita `light`, `balanced` e `exhaustive`:

```bash
export NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST="business-slug"
nrv run business-slug "<brief>" --execution-mode=gauntlet --gauntlet-intensity=light
```

Vários slugs usam separação por vírgula. Não há valor padrão e não existe Business hardcoded. Para rollback operacional imediato:

```bash
export NIRVANA_BUSINESS_GAUNTLET_KILL_SWITCH=1
```

O kill switch e qualquer bypass são avaliados antes do producer. Falha pré-produção pode retornar ao executor legado. Depois que a produção começa, o canário termina de forma auditável e nunca dispara a produção legada na mesma tentativa.

### Engine multi-target por arquivo de plano

`nrv multi-target` leva um plano declarado em `.nirvana/plans/<trace_id>.json` até o coordenador multi-target, com portas do Run Kernel e adapters de dispatch reais:

```bash
nrv multi-target plan .nirvana/plans/proj-x.json            # compila e imprime ondas, decisões e reserva
export NIRVANA_MULTI_TARGET_ENGINE=1
nrv multi-target run .nirvana/plans/proj-x.json             # executa; repetir retoma
nrv multi-target status .nirvana/plans/proj-x.json --json   # projeção do Run, sem side effects
```

`run` é opt-in e `NIRVANA_MULTI_TARGET_KILL_SWITCH=1` o desliga. Exit 0 entregue, 1 falhou, 2 retido, 4 plano inválido ou opt-in ausente. Cada nó roda `nrv dispatch` como subprocesso com alvo explícito (`--business`, `--squad`, `--agent-x`), então exit codes, audit e canários do caminho legado não mudam. Schema, audit, retomada e limitações em [Comando multi-target](gauntlet-multi-target-cli.md).

## Contrato de aplicação

O módulo `skills/harness/lib/gauntlet/` expõe compiler, evaluator registry, store durável e controller. O caller cria o Run no kernel, compila o plano e inicia `GauntletController`. Antes de cada fan-out, chama `beginRound` com a reserva de custo. Candidates, revisions e scorecards são registrados com IDs estáveis.

Uma revision exige parent, evaluations causais e hipótese de melhoria. O evaluator deve declarar a capability exigida e ter target diferente do producer. Depois da revision, o caller registra os testes anteriores e os novos no mesmo scorecard. Uma regressão blocking encerra o Gauntlet com `critical_regression`.

O resultado do controller é `delivered`, `withheld` ou `reservations`. Essa decisão não substitui o quality gate final. O evento terminal contém `finalQualityGateRequired: true`.

## Avaliador independente

Cada rodada é julgada por um avaliador escolhido antes do primeiro produtor, pela mesma função nos três canários:

```bash
export NIRVANA_GAUNTLET_EVALUATOR=squad:<slug>[:<capabilityId>]   # ou agent-x, ou heuristic
```

Sem a variável, o dispatch procura no registro instalado um squad que declare a capability `quality.specification_conformance` e seja independente do produtor; senão usa `agent-x`, quando o produtor não é agent-x; senão a heurística do quality gate offline. Uma variável que não pode ser honrada (valor ilegível, squad não instalado, capability não declarada, alvo igual ao produtor) encerra o dispatch com exit 4 antes de produzir. Cada degrau pulado grava `x_gauntlet_evaluator_fallback { from, reason }` e a escolha grava `x_gauntlet_evaluator_selected { evaluator, source, target }`.

O avaliador real roda como subprocesso do `dispatch.ts` com alvo explícito e modo `standard`, em `.nirvana/gauntlet/<runId>/evaluations/<revisionId>/`, lê o candidate sem editá-lo e escreve `scorecard.json`. O adapter valida o arquivo contra o contrato de sucesso do plano, preenche identidade, alvo real e custo observado no audit, e emite `x_gauntlet_evaluation_completed`. Scorecard ausente, inválido ou fora do contrato vira `indeterminate`: o Run termina `withheld` com `reason: evaluation_indeterminate`, sem revisão e sem gate final. Com avaliador real, 25% da parcela de cada candidate fica reservada para a avaliação dentro da mesma reserva de rodada. Contrato, schema e regras em [Contrato do avaliador do Gauntlet](gauntlet-evaluator-contract.md).

## Recovery e replay

Plan, candidates, evaluations e projection usam o mesmo SQLite do Run Kernel. Cada escrita de domínio inclui um event na outbox dentro da mesma transação. Repetir a mesma chave retorna o estado persistido. Repetir um ID com conteúdo diferente falha.

Após crash, o caller reabre o kernel e instancia o controller com `projectId` e `runId`. `resume` retorna round, custo, melhor score e stop state. Side effects externos continuam sob responsabilidade do runtime adapter e precisam usar as chaves registradas no journal.

`RunKernelCompatibilityFacade.publishPending` projeta os events canônicos como `x_run_kernel_projection` no audit legado. A entrega é pelo menos uma vez. Consumers deduplicam por `event_id`.

## Limitações do primeiro cutover

- O fan-out concreto vive em `runAgentXGauntlet`: candidates por rodada, revisão causal por `reviseCandidate` e publicação da revisão selecionada. Rotas com múltiplos Squads e o coordenador multi-target ainda não usam esse loop.
- A seleção usa o ranking do controller por revisão: sem falha bloqueante, maior nota ponderada, id estável. Não há arbitragem entre judges; divergência sobre a mesma revisão encerra com `judge_disagreement`.
- Holdout é metadata `evaluator_only` repassado ao evaluator. O isolamento do conteúdo depende do runtime adapter.
- Cost é reservado antes da round como estimativa por candidate vezes `candidateStrategy.count`, com a parcela da avaliação incluída quando o avaliador é real. O custo observado entra no scorecard pelo audit; a reconciliação da produção com a cobrança real continua a cargo do adapter de produção.
- Um candidate com nota zero em `light` para em `no_progress` na primeira rodada, porque a paciência do perfil é uma rodada.
- Candidates preservam referências imutáveis. A validação física dos artifacts continua no `ArtifactRef` do Run Kernel.
