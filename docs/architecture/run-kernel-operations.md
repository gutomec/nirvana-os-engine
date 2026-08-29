# Operação do Run Kernel

## Escopo desta implementação

O módulo `skills/harness/lib/run-kernel/` implementa a fundação canônica descrita nos ADRs 001, 002, 003 e 008. Ele mantém o dispatch atual intacto. A adoção ocorre por uma facade explícita, portanto nenhum caller legado muda de comportamento apenas ao atualizar o engine.

O kernel contém:

- journal append-only com sequência monotônica por Project;
- identidade e idempotência de events;
- causalidade confinada ao mesmo Project;
- lifecycle canônico de Run;
- projections reconstruíveis por replay;
- outbox durável no mesmo commit do event;
- transcript separado, limitado a mensagens visíveis;
- `ArtifactRef` imutável com digest, tamanho, media type, producer e URI publicada;
- facade opcional para o audit JSONL e o run ledger existentes.
- scopes aninhados com authority monotônica e descarte LIFO idempotente.

## Storage

Cada instância usa um arquivo SQLite definido pelo caller. O schema inicial tem versão `1` e cria as tabelas `project_sequences`, `run_events`, `run_projections`, `kernel_outbox`, `transcript_messages` e `artifact_refs`. `busy_timeout`, WAL, foreign keys e `synchronous=FULL` são configurados na abertura, nessa ordem: `journal_mode = WAL` pega lock exclusivo e devolve `SQLITE_BUSY` sem consultar o busy handler, então o timeout é o primeiro pragma e a conversão para WAL tem retry próprio até o modo do arquivo ler `wal`, tenha sido este processo ou outro a convertê-lo. Toda transação de escrita do kernel (journal, projections, store do Gauntlet e leases multi-target) começa com `BEGIN IMMEDIATE`: uma transação deferred que lê antes de escrever recebe `SQLITE_BUSY` imediato, sem passar pelo busy handler, quando outro processo gravou entre a leitura e a escrita, e é exatamente isso que acontece entre o servidor do Glance e o filho de dispatch no mesmo arquivo.

O journal e a outbox não devem ser apagados em rollback. Desativar o writer novo basta para retornar aos readers legados. A facade mantém o ledger atual no formato existente e adiciona somente eventos `x_run_kernel_projection` ao audit.

## Escopo de projeto do ledger

O arquivo do ledger é um só na máquina (`<NIRVANA_HOME>/.nirvana/run-ledger.sqlite`), e continua sendo. O que deixou de ser global é a **visibilidade**: cada linha guarda o `project_root` a que pertence, e toda leitura e toda escrita do `run-ledger.ts` filtram pela raiz que o processo chamador está servindo.

A raiz é resolvida como o resto do engine resolve: `NIRVANA_PROJECT_ROOT` quando existe, senão o primeiro ancestral do cwd que carrega um marcador de projeto (`.env`, `.nirvana`, `.git`, `package.json`, `pyproject.toml`). `HOME` e a raiz do sistema de arquivos nunca contam como projeto — um marcador solto em qualquer um dos dois colapsaria a máquina inteira num escopo só. O caminho é normalizado pelo resolvedor do sistema (`realpathSync.native`), porque o mesmo diretório tem mais de um nome: no macOS aparece como `/var/folders/…` e `/private/var/folders/…`, e no Windows como caminho curto 8.3 (`C:\Users\RUNNER~1\…`) e como forma longa (`C:\Users\runneradmin\…`) — o `mkdtemp` sob `%TEMP%` devolve a forma curta num runner do GitHub. O `realpathSync` do JS resolve o primeiro alias e não o segundo; só o `.native` resolve os dois. Comparar as strings cruas parte um projeto em dois.

Por que a regra existe: em 27/08/2026 uma sessão trabalhando em `~/nirvana-os` rodou `nrv run-track list`, viu linhas de `~/venda-mundial-pro` e de `consultorio-dr-paulo` — o ledger mostrava a máquina toda — e **fechou uma delas**. Um run de outro projeto, encerrado por um estranho, recuperável só por `x_audit_correction`. O raciocínio que justificava o banco global valia apenas para o supervisor, e vazava para todos os leitores.

### O que passa a filtrar

| Ponto | Comportamento |
|---|---|
| `findNonTerminal`, `countNonTerminal`, `findExpired` | linhas do projeto do chamador; `{ allProjects: true }` é a porta do supervisor |
| `findRelatedRuns` | linhas da raiz **da própria linha** consultada, não da do chamador — a pergunta é "o que mais este projeto está fazendo", e o supervisor a faz varrendo projetos alheios |
| `beatAgenticRuns` | só bate no projeto do chamador, inclusive quando um `runId` de fora é nomeado explicitamente |
| `nrv run-track list` | só os runs deste projeto |
| `nrv run-track beat` e `close` | recusam uma linha de outro projeto com exit 4, nomeando o projeto dono |
| varredura e salvage do supervisor | a lista de candidatos vem de `findNonTerminal`, então herda o escopo |
| `adoptOrphans` (control plane do `serve`) | conta os órfãos do projeto que o servidor atende |

O `project_id` sozinho não separava nada: ele é o *basename* de um diretório, e dois projetos colidem nele com facilidade (`cliente`, `site`, `landing`). É a raiz que distingue.

### Linhas legadas

A coluna `project_root` chegou depois da tabela. A migração é idempotente por `PRAGMA table_info`, e o backfill roda uma única vez, na abertura que adiciona a coluna: cada linha antiga é colocada a partir de `meta.project_root`, `meta.project_dir` ou `meta.cwd`, ancorando o valor relativo no `meta.cwd` e subindo dali até o projeto. Nesse caminho o `meta.project_root` guarda um diretório de *outputs*, não a raiz — por isso o valor é caminhado para cima, e um diretório de outputs já apagado ainda nomeia o projeto sob o qual viveu.

O que não dá para colocar fica em `NULL`, que se lê como "legado": invisível para um projeto, presente no modo `--all-projects` e no histórico. Um projeto errado seria pior do que um "não sei" honesto. Uma linha legada consultada por `findRelatedRuns` mantém o casamento antigo, só por id, para que a atualização nunca cegue a prova de vida quanto aos próprios filhos de um run; a tolerância é de mão única, e uma linha que conhece o seu projeto nunca aceita um irmão sem raiz.

### A exceção do supervisor

Recuperação não funciona com escopo: um run cuja sessão morreu não tem mais ninguém no projeto dele para varrer. O supervisor é a única exceção, e ele passa a pedi-la em voz alta.

- `--all-projects` varre a máquina inteira. É assim que um operador roda `watch` ou um `sweep` manual pedindo a visão da máquina toda em vez de um projeto só.
- Sem a flag, com projeto resolvível, ele varre só o projeto em que está — o caso da varredura preguiçosa pendurada num `nrv` do usuário.
- Sem a flag e sem projeto algum, ele fica global e diz por quê no stderr — o caso de `sweep`/`watch` iniciado de um diretório sem marcador de projeto (`HOME`, `/`, um diretório temporário qualquer).

Nenhuma dessas engatilha um serviço do sistema operacional: o próprio engine não registra nada em launchd, systemd ou Agendador de Tarefas em nenhuma plataforma. "A sessão é o supervisor" — três gatilhos, todos dentro de uma sessão já em execução: o `maybeSweep()` pendurado em todo `nrv find/route/dispatch`, o mesmo `maybeSweep()` disparado de novo quando um dispatch retorna (`dispatch.ts`, `process.on("exit")`), e `nrv supervisor watch`, o loop de primeiro plano para o caso desatendido.

`sweep`, `status` e `watch` aceitam a flag; `maybeSweep` conta no mesmo escopo que o filho vai varrer, porque contar um escopo e varrer outro é como um run pendente passa a ser pulado para sempre.

### O que isto não é

Não é controle de acesso a arquivos. Ler e escrever fora do projeto continua permitido quando o trabalho pedir, e nada aqui toca no `scope-guard` nem em permissão de diretório: a correção é sobre **enxergar runs de outros projetos**.

O Glance também não muda. Ele nunca leu o ledger — o `/api/runs` dele é derivado do audit em `~/.harness-logs` — e as suas visões de consumo (Runs, Cost, Memory, Agents, Activity) já abrem no escopo do projeto por padrão, com "all" como escolha explícita do usuário.

## Recovery

Um event e sua linha de outbox são gravados na mesma transação. Se a publicação falhar, a linha permanece pendente e uma chamada posterior a `publishOutbox` tenta novamente com o mesmo `eventId`. O consumer precisa deduplicar pelo `eventId`, pois uma falha após o side effect remoto e antes da confirmação local pode produzir nova entrega.

As projections podem ser descartadas e reconstruídas com `rebuildProjections`. O snapshot canônico antes e depois do replay deve ser idêntico.

## Compatibilidade e cutover

`RunKernelCompatibilityFacade` centraliza o dual-write. `createHarnessLegacyAdapter` projeta apenas transições representáveis pelo ledger atual. Estados canônicos sem equivalente exato continuam preservados no kernel e aparecem no audit; a facade não força uma transição ilegal no ledger. O mapa canônico → legado é fixo: `prepared` → `dispatched`; `running`, `waiting`, `revising` e `cancelling` → `running`; `verifying` → `verifying`; `completed` e `delivered_with_reservations` → `delivered` (a reserva fica em `meta.canonical_state`); `withheld` → `withheld`; `failed`, `rolled_back` e `cancelled` → `failed`, com o `error` da transição, senão a `reason` e os `errors` dela, em `last_error`, inclusive no rollback antes do producer de um canário Gauntlet, que abre ou adota a linha pelo mesmo adapter; `abandoned` não é projetado, porque o ledger só chega lá por `abandon()`.

O cutover recomendado é vertical:

1. abrir o kernel em shadow mode;
2. habilitar a facade para um fluxo;
3. comparar projection canônica, ledger e audit;
4. promover um reader por vez;
5. manter o fallback legado durante a janela de paridade.

## Publicação do modo standard

O modo `standard` do `dispatch.ts` publica cada execução com `--exec` como Run canônico pelo módulo `standard-publication.ts`, em vez da facade: o run-ledger legado já é aberto pelo próprio dispatch, e a facade com adapter legado criaria uma segunda linha sem heartbeat. As branches chamam quatro operações e nada mais.

1. `openStandardPublication` abre o kernel do projeto, cria o Run tipado (`{kind: "business", slug}`, `{kind: "squad", slug, capabilityId}` ou `{kind: "agent-x", slug: "agent-x"}`) ou adota o Run que o Glance preparou com `--run-id`, grava `runtime.selection_snapshot` com o snapshot congelado pelo broker e deriva `policySnapshotRef` do digest desse snapshot. Um Run adotado mantém o trace e o `policySnapshotRef` com que foi preparado, e não recebe um segundo `run.prepared`. A adoção segue a regra da seção seguinte: um Run já terminal sob o id recebido é recusado, e a publicação devolve `collided` para o dispatch sair com 1 antes de qualquer producer (a branch business marca a linha do run-ledger como `failed`).
2. `start` transiciona `prepared → running` antes do executor.
3. `verify` transiciona `running → verifying` antes da delivery pipeline.
4. `finish` aplica o estado terminal pelo resultado da entrega: `completed` (exit 0, gate `pass`), `delivered_with_reservations` (exit 0 com `fail-forced` ou `fail-accepted`), `withheld` (exit 2 ou 3) ou `failed` (exit 1 ou erro de runtime, com `payload.error`). O payload terminal registra `exitCode`, `gateOutcome` e `outputsRoot`.

As chaves idempotentes usam o prefixo `standard:<runId>:` (`create`, `execution-snapshot`, `running`, `verifying`, `terminal`), então repetir um dispatch sobre o mesmo Run não duplica eventos. Snapshot com erros do broker encerra o Run em `rolled_back` com `reason: runtime_incompatible` antes do producer, e o dispatch sai com 1.

A publicação é fail-open. Kernel que não abre ou não aceita a transição (disco, permissão, Run adotado num estado que recusa a transição, como um Run ainda `running`) gera `x_run_kernel_unavailable` no audit legado, com `stage` e `error`, e a publicação fica inerte: exit codes, artifacts, audit e session file seguem idênticos ao fluxo anterior. Sem `--exec`, ou com argumentos inválidos, nenhum Run é criado. Uma rota com vários Squads publica sob o primeiro; depois de um rollback do canário Business, o fallback legado não publica um segundo Run, porque o kernel já guarda o estado terminal daquele `runId`.

## Regra de adoção

Um Run só é adotado (continuado por outro processo sob o mesmo id, via `--run-id`) enquanto não terminou. A regra vale para a publicação do modo `standard` e para o cutover Gauntlet (`runAgentXGauntlet`), que leem o Run antes de qualquer escrita no kernel. Sob um id cujo Run é terminal (`completed`, `withheld`, `delivered_with_reservations`, `failed`, `rolled_back`, `cancelled`, `abandoned`), nada é recriado nem transicionado: a publicação `standard` avisa `run '<id>' is already terminal (<estado>); pass a fresh --run-id` e devolve `collided`; o cutover lança `RunAlreadyTerminalError` (`lib/run-kernel/lifecycle.ts`) e os três canários saem com 1, sendo que o canário Business nunca converte essa recusa em rollback para o produtor legado, que rodaria sob o mesmo id. Nos dois casos o audit legado recebe `x_run_id_collision` com `run_id`, `state`, `target_kind` do dispatch recusado, `run_target` do Run existente, `mode` (`standard` ou `gauntlet`) e, na publicação, `kernel_path`.

A regra nasceu de um plano multi-target cujos nós derivavam todos `run_<projectId>` de `--project`: a onda 1 concluiu o Run, a onda 2 reproduziu os eventos dele e a onda 3 adotou o Run `completed`, produziu um candidato e morreu em `illegal transition completed -> completed`. Cada nó passou a receber o próprio `--run-id` ([adapters multi-target](gauntlet-multi-target-adapters.md)); a recusa cobre qualquer outro caminho que repita um id.

Um Run adotado que ainda não terminou ganha, na adoção pelo cutover, a linha do run-ledger legado sob o mesmo `run_id`. Só `facade.create` a abria: um Run preparado pelo Glance chegava ao cutover sem linha, o dual-write lançava `legacy run '<id>' is missing` na primeira transição e `recordSession` registrava `run '<id>' not found` depois de cada produtor. O `openRun` do adapter legado é idempotente sobre uma linha existente, então a adoção o chama sem duplicar nada.

## Prova de vida de runs agênticos

O supervisor (`skills/harness/scripts/supervisor.ts`) só retém por stall uma linha agêntica do ledger legado (`meta.path = "agentic"`, sem pid, aberta por `brief-business`, `brief-squad` ou `nrv run-track open`) quando nada no trace dela mostra vida dentro da janela do lease agêntico (`AGENTIC_LEASE_SEC`, 1800 s). A leitura é de `resolveAgenticLiveness` (`skills/harness/lib/run-ledger.ts`), na ordem mais barata, e o primeiro sinal encontrado encerra a busca:

1. `heartbeat_at` da própria linha: um `nrv run-track beat`, ou o beat que `updateHandoffPhase` (`skills/_shared/lib/handoff.js`) e `brief-squad` fazem como efeito colateral, sem comando novo. O `x_ledger_lease_renewed` desses beats leva `source` (`handoff_phase_advanced`, `brief-squad`).
2. Um run filho no mesmo `project_id` ou `trace_id` (a linha que `nrv dispatch --exec --project <id>` ou `brief-squad --project <id>` abre): em estado `dispatched`, `running`, `verifying` ou `gated`, com `updated_at` ou `heartbeat_at` dentro da janela (`child_run`); ou `delivered` com `terminal_at` dentro da janela (`child_delivered`). O segundo caso é o período de graça para o funcionário integrar a entrega: dura uma janela a partir da entrega, e depois a regra normal volta a valer. Filhos em `failed` ou `stalled` não contam.
3. Um evento de hook do trace no audit diário (`tool_invoked`, `artifact_touched`, `bash_completed`), lido com `audit.readRecent` no root de `HOME` (onde `audit-emit-from-hook.ts` grava) e no root do projeto quando difere. O evento pertence ao run quando traz o mesmo `run_id`, `project_id` ou `trace_id`, ou quando `file_path` ou `cwd` cai sob o diretório do projeto (`dirname` de `meta.brief_path`), o que cobre a pasta do squad e os handoffs que a mtime do `outputs_root` nunca vê.
4. Atividade de arquivo sob `meta.outputs_root` (a regra anterior, agora a última).

Com vida, a linha ganha mais um lease e o audit recebe `x_ledger_grace_extended` com `liveness_source` (`heartbeat`, `child_run`, `child_delivered`, `hook_activity`, `file_activity`), `liveness_at` e, nos casos de filho, `child_run_id`. Sem sinal algum, a linha é escalada como antes, com `last_error` `supervisor: agentic run stopped reporting (no heartbeat, no child run, no hook activity, no file activity)`, e o salvage a leva a `withheld` preservando esse motivo. `x_ledger_state_changed` passou a levar `last_error` além de `error`: uma linha `withheld` com `last_error` do supervisor foi retida por stall; sem ele, foi retida pelo gate (`meta.gate`).

A medição que motivou a regra (26/08/2026, `~/.nirvana/run-ledger.sqlite`): de 39 runs de empresa retidos desde 01/08, 35 tinham esse `last_error`, em 15 empresas e 10 dias, sem falha de gate. A empresa delegava a um squad e escrevia fora do próprio `outputs_root`. O limiar `supervisor.stall_threshold_ms` e o `AGENTIC_LEASE_SEC` não mudaram.

## O que o heartbeat relata

O sidecar de heartbeat (`heartbeatMain` em `skills/harness/lib/run-ledger.ts`, lançado desanexado por `runWithLedgerHeartbeat` em `skills/_shared/lib/host-agent-driver.ts`) já varria o diretório de `--watch` a cada tick para responder "há atividade?". A varredura agora devolve as duas respostas de uma vez, por `scanDir`: a mtime mais nova, que decide o lease, e **quais** arquivos se moveram desde o tick anterior. Cada arquivo novo vira um `artifact_touched` com `file_path`, `size_bytes`, `cwd`, `source: "ledger-heartbeat"` e o `trace_id` da linha do run, que é o que a Glance lê para dizer onde o run está.

A medição que motivou isso (27/08/2026, trace `70341260-ff80-4c9b-9dd4-6925a36c6b99`): um squad rodou 418 s no Codex escrevendo 113 arquivos e o audit do dia guardou dezesseis eventos, onze deles `x_ledger_lease_renewed`. O disco sabia a ordem exata dos passos; o log dizia "vivo", onze vezes.

Três limites nascem com a regra. O intervalo do tick (15 s por padrão) é a janela de coalescência, e dentro dela valem um teto de 25 eventos e o teto por execução de `supervisor.touch_events_max` (500; `0` desliga o relato sem tocar no lease). Um tick truncado carrega `omitted` no último evento em vez de sumir com a diferença. A ação é sempre `modify`: uma varredura por mtime vê que o arquivo se moveu, nunca que ele nasceu, e afirmar `create` a partir disso seria a alegação sem evidência que o sinal existe para substituir. E a lista de ruído (`.git`, `node_modules`, `.nirvana`, `dist`, `build`, tempfiles de editor) filtra só o **relato**: a varredura continua descendo nesses diretórios, porque podá-los mudaria a `latestMs` e com ela a prova de vida da seção anterior.

Nenhum processo novo entra em cena, e é o ponto: o ciclo de vida do sidecar já tem quatro saídas independentes (sentinela `--done`, pid do pai morto, linha do run ausente, run em estado terminal), então um despacho que termina normalmente e um que morre de `SIGKILL` fecham o observador do mesmo jeito. `nrv watch-fs` continua existindo para o que não passa por despacho: um projeto tocado por Cursor, Aider ou qualquer agente sem hooks.

## Limites conhecidos

Esta fundação não altera Gauntlet, runtime providers nem supervisor; o dispatch escreve no kernel apenas pela publicação do modo `standard` descrita acima. A outbox oferece entrega pelo menos uma vez, com identidade estável para deduplicação, porque exatamente uma vez entre SQLite e um side effect externo exige cooperação do consumer. A publicação atômica de artifacts além da verificação de `ArtifactRef` fica para o marco próprio previsto no plano incremental.
