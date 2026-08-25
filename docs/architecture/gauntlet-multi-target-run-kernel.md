# Portas Run Kernel para multi-target

## Estado

`createRunKernelMultiTargetPorts` conecta o coordenador interno ao Run Kernel existente. A factory recebe um `KernelHandle`, identidade de Project e Run, owner da execução, actor, correlation e os dois adapters injetáveis. Nenhum comando público usa essa factory neste corte.

Não existe banco ou ledger paralelo. Snapshots e eventos entram em `run_events`, recebem sequence do Project e seguem para o outbox canônico. A única tabela operacional adicional no mesmo SQLite é `kernel_multi_target_leases`, usada para exclusão e recuperação por nó.

## Snapshots e journal causal

Cada snapshot usa o evento idempotente `multi_target.snapshot_saved`, identificado por Run e versão. O payload mantém `planDigest`, `reservationDigest`, onda atual, projeção dos nós, custo reportado e estado terminal. `multi_target.snapshots_bound` registra a vinculação imutável antes da execução.

Eventos de nó carregam sua projeção completa. A porta mantém uma cadeia causal dentro do Run: cada novo evento aponta para o evento anterior por `causationId`. O Run Kernel fornece sequence monotônica por Project, isolamento, identidade idempotente e outbox durável.

No reload, a porta lê o último snapshot e reaplica eventos `multi_target.*` posteriores. Isso cobre uma interrupção depois de `node_delivered`, `node_withheld` ou `budget_exceeded` e antes do próximo `snapshot_saved`. Um nó terminal recuperado pelo journal não executa novamente.

Repetir a mesma operação com o mesmo payload retorna o evento existente. Reusar a identidade com payload divergente falha fechado.

## Lease por nó

A chave de lease é `(project_id, run_id, node_id)`. Cada registro contém:

- `owner_id`;
- `expires_at` em milissegundos Unix;
- versão monotônica usada no compare-and-swap.

`claim` roda em transação SQLite. Uma lease ativa do mesmo owner é sucesso idempotente. Uma lease ativa de outro owner recusa o claim. Após expiração, um novo claim explícito pode trocar owner e incrementar a versão.

`renew` exige owner atual, lease não expirada e versão ainda vigente. `release` remove somente a lease do owner e versão correspondentes. Claims, renovações e releases bem-sucedidos também entram no journal causal.

Ao recuperar um snapshot com nó `running`, o coordenador chama `canResume`. Somente owner igual e prazo válido autorizam `resume: true` com a mesma chave idempotente do adapter. Expiração ou owner incompatível produz `stalled`; não existe takeover automático.

## Heartbeat e abort

Enquanto `standard.run` ou `gauntlet.run` estiver pendente, a porta chama `renew` a cada `heartbeatMs`. O padrão é um terço de `leaseDurationMs`; um valor injetado precisa ser positivo e menor que a duração da lease. O agendador também é injetável (`schedule`), com `setInterval` e `clearInterval` como padrão, então os testes dirigem os batimentos sem tempo real.

Cada adapter recebe `signal`, um `AbortSignal` opcional em `MultiTargetAdapterInput`. Quando `renew` devolve `false`, por expiração, troca de owner ou release externo, a porta aborta o sinal com razão `lease_lost`, registra `multi_target.lease_lost` no journal causal e descarta o que o adapter devolver: o nó termina como `failed` com razão `lease_lost: ...`. O custo que o adapter tenha reportado é preservado na projeção, porque foi gasto de fato.

Ao fim do adapter, a porta confere de novo que a lease continua do mesmo owner e dentro do prazo. Sem lease válida nesse momento, o resultado também é descartado. Um nó nunca é marcado `delivered` sem lease válida no fim.

O timer é sempre limpo quando a promise resolve ou rejeita, e um batimento disparado depois disso é ignorado. Renovações continuam idempotentes por versão; o evento de perda usa a versão observada no momento da falha.

## Garantias e limitações

As provas herméticas cobrem concorrência de claim, isolamento entre Projects e Runs, crash entre evento e snapshot, crash com lease viva, expiração, owner incompatível, replay sem duplicação, heartbeat com agendador manual, perda de lease durante a execução e expiração no fim do adapter.

A lease protege início, execução e retomada. A renovação é responsabilidade da porta, nunca do adapter. O abort encerra o subprocesso dos adapters de dispatch (ver [adapters de dispatch](gauntlet-multi-target-adapters.md)); um adapter que ignore o sinal continua rodando por conta própria, e ainda assim seu resultado é descartado. Ainda não há política de recovery humano, publicação específica no Glance nem cutover por allowlist.
