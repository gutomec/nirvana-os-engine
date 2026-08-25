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

## Garantias e limitações

As provas herméticas cobrem concorrência de claim, isolamento entre Projects e Runs, crash entre evento e snapshot, crash com lease viva, expiração, owner incompatível e replay sem duplicação.

A lease protege o início e a retomada, mas não encerra um processo externo. Renovação precisa ser chamada pelo futuro adapter enquanto o side effect estiver ativo. Ainda não há política de recovery humano, publicação específica no Glance, adapter real nem cutover por allowlist.
