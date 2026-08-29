# Durable Work Continuity (DWC)

Data da revisão: 28 de agosto de 2026, branch `feat/durable-work-continuity-core-pr-v9`, base/live upstream main `3700914f75fc8f7d1cfb60de3cd6062c5ba5c5ca`.

**Status:** provisional, aguardando revisão independente. O catálogo de eventos e a
migração Track B descritos aqui não estão prontos para produção enquanto uma revisão
independente solicitar alterações.

## Escopo e autoridade

Durable Work Continuity (DWC) é a capacidade do engine que tipa unidades de trabalho
duráveis como irmãs do Run Kernel canônico. O módulo
`skills/harness/lib/run-kernel/durable-work.ts` estende o kernel com unidades
particionáveis que podem ser declaradas, iniciadas, progredidas, completadas, reclamadas,
lidas, coletadas, retomadas e migradas da Track B, sem duplicar o substrato do kernel.

DWC possui apenas o estado durável da unidade de trabalho. O Run Kernel canônico, o run
ledger, o audit, o quality gate e o `HANDOFF.json` mantêm autoridade em nível de run. DWC
não cria um segundo supervisor, não valida o dono do connector lifecycle e não substitui o
run ledger. O ciclo de vida do run, a sequência monotônica de eventos, a idempotência, a
causalidade e o outbox pertencem ao kernel; DWC apenas acrescenta o contexto da unidade a
esses eventos canônicos.

Uso normal é offline. O módulo não consulta, não verifica nem atualiza o upstream enquanto
executa trabalho. Connector Platform é dono de fonte, versão, verificação de update,
consentimento, install, health, drift e rollback.

## Transição atômica de unidade e journal canônico

Cada mutação de DWC ocorre em uma única transação `BEGIN IMMEDIATE` do SQLite do kernel.
A transação envolve a linha da unidade, a gravação do operation, o snapshot da operação e a
emissão do evento `x_durable_work_*` no journal `run_events` pelo `appendEvent` do kernel.
Uma falha em qualquer passo reverte o efeito inteiro: nenhuma linha de unidade, nenhum
operation, nenhum evento. O journal e o outbox permanecem append-only; o rollback preserva
eventos de importação prévios.

O kernel oferece entrega pelo menos uma vez pelo outbox, com identidade estável de evento
para deduplicação pelo consumer. A identidade do evento (`idempotencyKey`) é estável por
replay: a mesma operação com o mesmo payload devolve o snapshot gravado, sem duplicar
eventos. A ordenação é monotônica por Project (sequência do `run_events`), e a causalidade
fica confinada ao mesmo Project. DWC não inventa valores de correlação canônica: `runId`,
`traceId`, `actor`, `correlationId` e `idempotencyKey` são fornecidos pelo chamador e
verificados contra o run canônico antes de qualquer mutação, por `assertCanonicalContext`.

## Correlação canônica

O envelope de cada evento `x_durable_work_*` carrega a correlação fornecida pelo Run
Kernel. Os campos efetivamente presentes na implementação:

| Campo | Origem | Onde |
|---|---|---|
| `runId` | Run Kernel canônico (`nirvana_run_id`) | envelope do evento |
| `traceId` | Run Kernel canônico (`trace_id`) | envelope do evento |
| `projectId` | Run Kernel canônico | envelope do evento |
| `actor` | `{ kind: "durable-work", id: runId }` ou `{ kind: "track-b-migration", id: operationId }` | envelope do evento |
| `correlationId` | derivado deterministamente com `encodeDwcTuple` (`cor_dw_def_${encodeDwcTuple(runId)}`, `cor_dw_mig_unit_imp_${encodeDwcTuple(runId, operationId, unitId)}`, etc.) | envelope do evento |
| `idempotencyKey` | derivado com `encodeDwcTuple` injetivo (`dw-mig-imp-${encodeDwcTuple(runId, operationId)}@${runId}`, etc.) | envelope do evento |
| `unit_id` | DWC | payload |
| `attempt_id` | DWC | payload |
| `operation_id` | DWC (chamador) | payload |
| `migration_operation_id` | DWC (Track B) | payload (eventos de migração) |
| `target.capabilityId` | Run Kernel (`target_capability_id` na tabela `durable_definitions`) | tabela, não payload público |
| `durable_work_id` | não existe nesta versão | n/a |

Os valores legados do run ledger não são inventados. `workflow`, `node` e `attempt` no
sentido do Gauntlet multi-target não aparecem nos payloads de DWC; o equivalente em DWC é
`unit_id` + `attempt_id` + `operation_id`.

## Comportamento offline

O módulo DWC opera sem rede. Ele abre o SQLite do kernel do projeto, valida o contexto
canônico contra a projeção do run existente e grava dentro de transações immediate. Não há
chamada a upstream, a registry remota ou a serviço de update. A verificação de drift do
connector, o update check e o rollback de connector são responsabilidade do Connector
Platform, não do DWC.

DWC não valida o dono do connector lifecycle, não instala nem desinstala connectors, e não
emite eventos de lifecycle de connector. A presença do módulo `durable-work.ts` no
repositório não altera callers legados por simples presença: a adoção é explícita pelo
chamador que abre o kernel e chama as funções públicas.

## Catálogo de eventos provisional

**Versão do catálogo:** `nirvana.durable-work/v1alpha1`.
**Status:** provisional, não pronto para produção até revisão independente aprovar.

Consumidores devem ignorar campos aditivos desconhecidos. Breaking changes exigem nova
versão de schema ou evento. DWC é `source_authority` para eventos do ciclo de vida da
unidade; o adapter de migração Track B é `producer` dos eventos de migração, com
`source_authority: "holdfast-track-b"` e `source_version: "1.1.0-nirvana.1"` no payload.

### Eventos do ciclo de vida da unidade (actor: `durable-work`)

| Evento | Gatilho | Payload mínimo | Terminalidade | Ordenação / idempotência |
|---|---|---|---|---|
| `x_durable_work_units_defined` | `defineUnits` | `definition_digest`, `unit_ids[]` | não | idempotente por `dw-def-${runId}@${runId}`; replay semântico devolve a definição original |
| `x_durable_work_unit_started` | `startUnit` | `unit_id`, `attempt_id`, `operation_id`, `previous_revision`, `next_revision`, `previous_digest`, `next_digest` | não | idempotente por `dw-start-${unitId}-${attemptId}@${runId}`; mesmo `(operation_id, payload)` devolve snapshot |
| `x_durable_work_unit_progressed` | `progressUnit` | `unit_id`, `attempt_id`, `operation_id`, `previous_revision`, `next_revision`, `previous_digest`, `next_digest`, `coverage`, `evidence_count` | não | idempotente por `dw-prog-${unitId}-${operationId}@${runId}`; cobertura monotônica, sem regressão |
| `x_durable_work_unit_completed` | `completeUnit` | `unit_id`, `attempt_id`, `operation_id`, `previous_revision`, `next_revision`, `previous_digest`, `next_digest`, `verification_evidence_count` | sim (`completed`) | idempotente por `dw-done-${unitId}-${operationId}@${runId}`; exige cobertura completa + evidência de verificação |
| `x_durable_work_unit_failed` | `failUnit` | `unit_id`, `attempt_id`, `operation_id`, `previous_revision`, `next_revision`, `previous_digest`, `next_digest`, `reason_code` | não (`failed`) | idempotente por `dw-fail-${unitId}-${operationId}@${runId}`; `reason_code` validado (default: `unit_failed`), nunca expõe `reason` raw |
| `x_durable_work_unit_compensating` | `compensateUnit` | `unit_id`, `attempt_id`, `operation_id`, `previous_revision`, `next_revision`, `previous_digest`, `next_digest` | não (`compensating`) | idempotente por `dw-comp-${unitId}-${operationId}@${runId}`; exige status `failed` prévio |
| `x_durable_work_unit_compensated` | `completeCompensation` | `unit_id`, `attempt_id`, `operation_id`, `previous_revision`, `next_revision`, `previous_digest`, `next_digest` | sim (`compensated`) | idempotente por `dw-compd-${unitId}-${operationId}@${runId}`; exige evidência de compensação |
| `x_durable_work_unit_compensation_failed` | `failCompensation` | `unit_id`, `attempt_id`, `operation_id`, `previous_revision`, `next_revision`, `previous_digest`, `next_digest`, `reason_code` | não (`failed`) | idempotente por `dw-compf-${unitId}-${operationId}@${runId}`; exige status `compensating` prévio, `reason_code` validado (default: `compensation_failed`), nunca expõe `reason` raw |

Status terminais: `completed` e `compensated`. Os estados `failed` e `compensation_failed` (que transiciona de volta a `failed`) são não-terminais, permitindo retentativa, nova tentativa ou compensação. Uma unidade terminal não aceita nova mutação de ciclo de vida (`unit_already_terminal`).

### Eventos de migração Track B (actor: `track-b-migration`)

| Evento | Gatilho | Payload mínimo | Terminalidade | Ordenação / idempotência |
|---|---|---|---|---|
| `x_durable_work_unit_imported` | `importFromTrackB`, por unidade importada | `unit_id`, `operation_id`, `migration_operation_id`, `source_authority`, `source_version`, `origin { upstream_project, upstream_version, target_authority }`, `unit_digest`, `revision` | não (evento de importação) | idempotente por `dw-mig-unit-imp-${encodeDwcTuple(runId, operationId, unitId)}@${runId}` |
| `x_durable_work_units_defined` | `importFromTrackB`, definição criada pela migração | `definition_digest`, `unit_ids[]`, `migration_operation_id` | não | idempotente por `dw-mig-def-${encodeDwcTuple(runId, operationId)}@${runId}`; mesmo tipo reutilizado com actor distinto |
| `x_durable_work_track_b_imported` | `importFromTrackB`, conclusão da importação | `definition_digest`, `unit_count`, `operation_id`, `migration_operation_id`, `manifest_digest`, `payload_digest`, `source_authority`, `source_version`, `origin { ... }` | não (evento de importação) | idempotente por `dw-mig-imp-${encodeDwcTuple(runId, operationId)}@${runId}`; replay devolve cached report |
| `x_durable_work_track_b_rollback` | `rollbackTrackBImport` | `manifest_digest`, `operation_id`, `migration_operation_id`, `payload_digest`, `source_authority`, `source_version`, `origin { ... }` | não (evento de rollback) | idempotente por `dw-mig-rb-${encodeDwcTuple(runId, operationId)}@${runId}`; mesmo rollback + mesmo backup é no-op |

### Campos de correlação aditivos

Os campos a seguir permanecem contratos aditivos onde o Run Kernel os fornece. DWC não os
inventa nem os exige:

- `nirvana_run_id` (presente como `runId` no envelope canônico);
- `trace_id` (presente como `traceId` no envelope canônico);
- `workflow`, `node`, `attempt` no sentido do Gauntlet multi-target (não presentes em
  payloads de DWC; o equivalente é `unit_id` + `attempt_id` + `operation_id`);
- `durable_work_id` (não existe nesta versão);
- `target.capabilityId` (presente na tabela `durable_definitions` como
  `target_capability_id`, não no payload público do evento);
- refs de policy profile, tenancy, retenção e legal-hold (contratos futuros aditivos).

### Segurança de payload

Os payloads públicos de eventos contêm apenas:

- identificadores (`unit_id`, `attempt_id`, `operation_id`);
- digests (`definition_digest`, `unit_digest`, `manifest_digest`, `payload_digest`,
  `previous_digest`, `next_digest`);
- contagens (`unit_count`, `evidence_count`, `verification_evidence_count`);
- cobertura (`{ completed, total, label }`);
- código de motivo (`reason_code`, token validado; nunca expõe `reason` raw livre);
- proveniência (`source_authority`, `source_version`, `origin`).

Nenhum payload público contém `run_id` duplicado (pois o envelope canônico do evento já possui `runId`), caminho de backup, caminho local absoluto, evidência sensível
raw ou conteúdo de backup. A evidência é representada por refs tipados e digests SHA-256
(`EvidenceRef { type, ref, digest }`), com classificação, redação e estado de verificação
presentes apenas onde a implementação os fornece. O backup de migração é materializado em
diretório classificado interno; o payload público carrega apenas o digest do manifesto, não
o caminho.

## Migração e rollback da Track B

### Precondições de importação

`importFromTrackB` exige:

1. um `KernelHandle` aberto pelo chamador (a migração nunca abre um segundo kernel);
2. um run canônico existente para `(projectId, runId)` com `traceId` e `target`
    correspondentes, verificado por `assertCanonicalContext`;
3. um `STATE.json` Track B no `trackBRoot` com schema `2.0.0`, digest SHA-256 válido e
    campos `runId`, `traceId`, `nirvanaRunId` alinhados com o run canônico;
4. um arquivo de unidade `.json` por unidade declarada em `STATE.json`, com digest
    SHA-256 do corpo verificado contra o digest armazenado;
5. toda evidência referenciada presente em disco, com digest SHA-256 verificado contra o
    digest declarado, e caminho confinado ao `trackBRoot` (sem absoluto, sem `..`, sem
    symlink escape).

### Idempotência da operação

A importação deriva `operationId` deterministicamente do digest do estado Track B quando o
chamador não fornece um. O payload digest da migração exclui o wall-clock `now` e o
caminho do backup, então um replay da mesma fonte produz o mesmo digest. Um replay com
mesmo `operationId` e mesmo payload digest devolve o cached report e re-verifica a
materialização. Um replay com mesmo `operationId` e payload diferente é
`operation_replay_conflict`.

### Materialização atômica

A importação materializa em uma transação immediate: linha de definição + linhas de
unidade + eventos canônicos (`x_durable_work_unit_imported` por unidade,
`x_durable_work_units_defined`, `x_durable_work_track_b_imported`) + linha de
`durable_migration_operations` com o result cached. Uma falha em qualquer passo reverte o
efeito inteiro. O backup é gravado antes da transação do kernel; se a transação falha, o
stage de backup criado é removido.

### Backup classificado

O backup é gravado em `backupRoot/<stage-name>/` (derivado deterministicamente via `deriveStageName(operationId, payloadDigest)` a partir do hash do tuple injetivo `encodeDwcTuple(operationId, payloadDigest)`) com `STATE.json`, `units/<id>.json`, `evidence/<unitId>/<ref>` e `MANIFEST.json`. O manifesto carrega proveniência (`projectId`, `runId`, `traceId`, `target`, `operationId`), lista de arquivos com digest e `holdfastAttribution`. O caminho do backup fica interno ao `durable_migration_operations` (`backup_path`); o payload público do evento carrega apenas `manifest_digest`.

### Refs públicas seguras

Os eventos públicos de migração não expõem o caminho do backup, caminho absoluto ou
conteúdo de evidência. A evidência é representada por `EvidenceRef` com `type`, `ref`
(relativo, confinado) e `digest` SHA-256. O backup é verificado por
`verifyBackupFiles`: cada arquivo do manifesto deve existir, ser regular, ter o tamanho e
o digest declarados.

### Comportamento de rollback

`rollbackTrackBImport` reverte uma importação específica a partir de um diretório de
backup. O rollback:

1. lê e valida o `MANIFEST.json` (schema, provenância `projectId`/`runId`, digest do
    manifesto);
2. verifica cada arquivo do backup (existência, tipo regular, tamanho, digest);
3. verifica as precondições de estado (`verifyRollbackStatePreconditions`): o run
    canônico, a definição e as unidades devem corresponder exatamente ao snapshot
    importado, e nenhuma tabela de trabalho durável (`durable_units`, `durable_definitions`,
    `durable_claims`, `durable_operations`, `durable_operation_snapshots`) pode ter
    linhas pós-importação ou resíduos em caso de replay;
4. em uma transação immediate, remove as linhas de DWC (`durable_units`,
    `durable_definitions`, `durable_claims`, `durable_operations`,
    `durable_operation_snapshots`) e emite
    `x_durable_work_track_b_rollback`. Replays em cache verificam que todas as cinco
    tabelas estão limpas (`operation_replay_state_drift` em caso de resíduos).

Um rollback com mesmo `operationId` e mesmo payload é no-op. Um rollback com
`operationId` igual e payload diferente é `operation_replay_conflict`.

### Replay determinístico

A importação e o rollback são determinísticos: o mesmo snapshot Track B e o mesmo backup
produzem o mesmo `operationId`, o mesmo payload digest e o mesmo resultado. A retomada de
processo fresco abre o mesmo kernel DB e encontra o estado prévio. A coleção é
determinística e segura de rerodar.

### Verificação de backup e rollback suportada por testes

`skills/harness/tests/durable-work.test.ts` cobre:

- importação materializa unidades e eventos, e o backup contém STATE, unidades e
  evidência;
- idempotência: segundo import com mesma fonte devolve cached report sem duplicar eventos;
- rollback remove DWC state e emite `x_durable_work_track_b_rollback`;
- rollback idempotente: segundo rollback com mesmo backup é no-op;
- re-import após rollback recria o estado e os eventos;
- rollback recusa backup com provenância errada (`rollback_backup_provenance_mismatch`);
- rollback recusa state drift (`rollback_state_drift` ou `operation_replay_state_drift`) quando tabelas têm linhas pós-importação ou resíduos nas cinco tabelas de trabalho durável (`durable_units`, `durable_definitions`, `durable_claims`, `durable_operations`, `durable_operation_snapshots`);
- atomicidade: trigger que aborta o evento de importação reverte a transação inteira e limpa apenas o stage de backup criado por ela, permitindo retentativa limpa.

## Coexistência Track B com o core

A Track B coexiste com o core DWC até que os seis portões de aposentadoria hold:

1. equivalência semântica provada por testes;
2. migração de estado e referência;
3. backup;
4. rollback testado;
5. verificação de retrieval e comportamento;
6. autorização explícita do usuário.

Nenhum portão é automático. Não há deleção nem desabilitação automática da Track B. A
migração é opt-in pelo chamador; a ausência do módulo `durable-work.ts` não altera
callers legados.

## Atribuição

DWC adapta conceitos do Holdfast, mantido por André Almeida.

| Campo | Valor |
|---|---|
| Componente | Holdfast |
| Autor | André Almeida |
| URL upstream | `https://github.com/AndreAlmeidaDC/holdfast` |
| Versão upstream | `1.1.0` |
| Commit avaliado | `6e4f09dbad22bca93918aeb6efcbb0c0aaddd494` |
| Versão da adaptação | `1.1.0-nirvana.1` |
| Licença | MIT |

A adaptação não incorpora o skill Holdfast como produto rígido nem copia o skill
wholesale. DWC é uma capacidade do engine Nirvana-OS que estende o Run Kernel canônico; os
conceitos de unidade durável, checkpoint atômico e resume cold from disk são adaptados do
Holdfast sob MIT. O repositório upstream não é modificado.

## Lacunas explícitas e esclarecimentos contratuais

O catálogo e a migração descritos aqui têm lacunas e decisões contratuais honestas:

- **Claims consultivos e sem evento granular de claim.** `acquireClaim` e `releaseClaim` operam como claims consultivos (advisory leases) para coordenação cooperativa entre workers; não emitem eventos `x_durable_work_*`. O estado do claim reside em `durable_claims` sem journalização canônica no `run_events`.
- **Reconstrução de journal baseada exclusivamente em projeções.** DWC não reconstrói estado a partir de um log de eventos independente; toda leitura e reconciliação utiliza as tabelas relacionais do SQLite do Run Kernel como fonte de verdade projetada.
- **stateRoot de evidência e source root.** A validação de evidência requer `stateRoot` explícito para verificação de arquivos locais e prevenção contra directory traversal. Na migração da Trilha B, os arquivos de evidência são validados contra o `trackBRoot` de origem antes do empacotamento.
- **Staging de backup em dryRun.** Em modo `dryRun: true`, o backup de migração é inspecionado e montado em diretório de staging para validação de integridade prévia, sem alterar as tabelas do banco de dados DWC.
- **Digest de migração vinculado ao host/caminho (se aplicável).** O cálculo de digest da migração considera a estrutura canônica dos artefatos; migrações de armazenamento de trabalho durável permanecem provisórias e escopadas a este ciclo.
- **Sem criação de novo validador global (`validate`) ou novo supervisor.** DWC reutiliza as primitivas existentes do Run Kernel e não introduz nenhum comando global novo ou supervisor concorrente.
- **Cobertura de migração incompleta.** `importFromTrackB` e `rollbackTrackBImport` estão
  implementados e testados. Não há evento `x_durable_work_track_b_refused` nem
  `x_durable_work_track_b_failed` distintos; uma recusa ou falha de migração lança
  exceção sem evento canônico de refusal/failure.
- **Telemetria de backlog/lag/retry/dead-letter** é projeção futura de observabilidade, não
  um segundo supervisor. Não há evento nem tabela de backlog nesta versão.
- **Refs de policy profile, tenancy/retention/legal-hold** permanecem contratos aditivos
  futuros. A implementação não os fornece.
- **Cada campo de correlação canônica** (`nirvana_run_id`, `trace_id`, `workflow`,
  `node`, `attempt`, `durable_work_id`, `target.capabilityId`) permanece contrato aditivo
  onde o Run Kernel o fornece. DWC não inventa valores legados.

O catálogo não está pronto para produção enquanto uma revisão independente solicitar
alterações. Nunca descrever um evento de refusal/failure ausente como coberto. Nunca
rotular o catálogo como pronto para produção enquanto revisão independente pendente exista.
