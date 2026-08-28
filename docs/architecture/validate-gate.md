# Portão de admissão — `nrv validate`

Data da revisão: 26 de agosto de 2026, branch `feat/validate-gate-core`.

Todo squad, empresa ou mind-clone que entra na biblioteca — criado por um wizard, instalado de um pack, escrito à mão — passa por uma verificação que o aprova ou o reprova. O comando é `nrv validate`, o módulo é `skills/_shared/lib/verify/`, e este documento é o contrato: o verbo, os códigos de saída, o JSON, o débito baselinado, o laço `--fix` e o que ainda não existe.

## O verbo mudou de dono

`nrv validate` era um alias de 20 linhas para o doctor da máquina. Agora é o portão das entidades. O doctor continua em `nrv doctor`, inalterado.

```bash
nrv validate <squad|business|mind-clone> <slug|path> [--fix] [--strict] [--json]
nrv validate <path>                       # o tipo sai do manifesto em disco
nrv validate <kind> --all [--fix] [--strict] [--json] [--record [--allow-regression]] [--root <dir>]
nrv validate --pack <content-dir> [<kind>] [--json] [--record]
nrv validate                              # DEPRECADO: roda o doctor, com aviso
```

Apelidos de tipo: `biz` → business, `clone` e `mc` → mind-clone. `nrv verify` é alias de `nrv validate` nos dois despachantes (`bin/nrv` e `skills/harness/scripts/nrv.ts`). `nrv validate-mind-clones` (e `nrv mc-validate`) continua existindo e delega ao módulo, mantendo as chaves que sempre imprimiu — `target`, `total`, `ok`, `failed`, `results[].{file, ok, errors, warnings}` — com `findings` a mais.

O `nrv validate` sem argumento nenhum roda o doctor e imprime na stderr um aviso de deprecação. Isso vale por uma release; depois dela, o bare vira erro de uso.

## Códigos de saída

| Código | Significado |
|---|---|
| 0 | Admitido: nenhum erro fora do baseline, e nenhum aviso sob `--strict` |
| 1 | Reprovado: pelo menos um erro que o baseline não cobre |
| 2 | Só avisos, com `--strict` |
| 64 | Erro de uso, tipo desconhecido ou entidade que não resolve |

O 64 é `EX_USAGE`. O engine já usa `EXIT.INVALID_ARGS = 4` em outros lugares e o `2` estava tomado pela convenção "precisa de confirmação"; aqui o `2` é o veredito estrito, então o erro de uso sobe para a convenção BSD. O `--help` imprime a tabela.

## O relatório

Sem `--json`, uma tabela no idioma dos `scripts/check-*.ts`: uma linha por finding com `FAIL`, `WARN`, `DEBT` ou `INFO`, o id, a mensagem e o nome do fixer quando existe um; depois a contagem de critérios que passaram e a linha `Verdict: ADMITTED` ou `REJECTED`.

Com `--json`, o schema é `nirvana.verify-report/v1`:

```json
{
  "schema": "nirvana.verify-report/v1",
  "kind": "mind-clone", "slug": "jane-doe", "dir": "…",
  "verdict": "REJECTED",
  "summary": { "errors": 1, "warnings": 3, "debt": 2, "passed": 26 },
  "findings": [{ "id": "…", "severity": "error|warning|info", "autofix": "mechanical|agentic|none",
                 "message": "…", "evidence": "…", "where": "…", "baselined": false, "fixer": "…" }],
  "fixes": [{ "fixer": "…", "finding": "…", "applied": true, "changed_files": ["MANIFEST.yaml"] }],
  "fix_outcome": { "mode": "mechanical", "backup": "…", "rolled_back": false,
                   "before": { "errors": 2, "warnings": 4 }, "after": { "errors": 0, "warnings": 3 } },
  "baseline": { "present": true, "debt": 2 },
  "exit_code": 1, "strict": false, "checked_at": "2026-08-26T…"
}
```

`--all` e `--pack` envolvem os relatórios de entidade em `nirvana.verify-batch/v1`, com `mode`, `kinds[]`, `entities`, `summary {admitted, rejected, errors, warnings, debt}`, `reports[]` e o mesmo `exit_code`.

O relatório de cada entidade também é gravado em `SQUADS_STATE_DIR/<slug>/verify.json`. É estado, não produto — a mesma decisão de `activated.json`: nada é escrito dentro da entidade. Cada verificação grava um evento de audit `x_verify_squad`, `x_verify_business` ou `x_verify_mind_clone` com o veredito e as contagens.

## Erro, aviso e débito

Três severidades. **Erro** é o que uma edição de texto conserta em um minuto: o manifesto não parseia, um artefato canônico falta, a superfície de contrato não existe. **Aviso** é o que degrada a entidade sem inviabilizá-la. **Info** nunca muda o veredito; existe para dizer que uma checagem não pôde rodar — `registry_absent` é o caso: sem registro indexado, o eixo de auto-recuperação é pulado em vez de reprovar.

Um subconjunto dos critérios é `baselineable`: os fatos que o pipeline de validação produz e que nenhum fixer pode inventar — `validation_verdict_missing`, `source_material_missing`, `fonte_density_low`, `dna_layers_missing`, `routing_block_missing`, `self_retrieval_miss` e, do lado de empresa, `seat_thin`. Um finding baselineável que o baseline já registra conta como **débito**: aparece no relatório como `DEBT` e não reprova. Desde 28/08/2026 a lista tem duas entradas que **são erro**: `audit_event_unprefixed` e `audit_event_unattributed`, nos dois catálogos. A razão está na ordem do plano em `.nirvana/plans/event-contract.md` — este corte torna a violação do contrato de eventos **visível** e o corte 4 renomeia os eventos preservando o payload, então reprovar as 3 squads que já violam a regra (duas delas dentro de packs publicados) antes de existir para onde migrar seria exatamente a falha que a baseline evita. Fora esse par, erro não vira débito.

O arquivo é `$NIRVANA_HOME/.nirvana/.verify-baseline.json`:

```json
{ "recorded_at": "…", "imported_from": ["…"], "entities": { "mind-clone:jane-doe": ["validation_verdict_missing"] } }
```

Regras, herdadas de `scripts/check-entity-admission.ts`:

- `--record` **funde** por entidade. Gravar a partir do pack A não apaga o que só o pack B enxerga; uma entidade varrida e limpa tem o registro dela removido; uma entidade que não estava na varredura fica intocada.
- Gravar **recusa** adicionar débito. Se uma entidade conhecida ganhou um item, ou se uma entidade nova traz débito para um baseline que já existe, o comando sai 1, nomeia o que cresceu e não escreve nada. `--allow-regression` grava assim mesmo, deliberadamente.
- Os dois baselines legados, `.admission-baseline.json` e `.seat-sufficiency-baseline.json`, são importados **uma vez**, na primeira leitura em que não existe baseline de verify, e ficam intactos em disco. `no_verdict` vira `validation_verdict_missing`, `no_source` vira `source_material_missing`, `thin_seat` vira `seat_thin:employees/<arquivo>` na empresa dona do assento.
- `--baseline <file>` aponta para outro arquivo (CI, teste, pack).

**Dia um.** Um chamador em `mode: "hook"` (wizard, instalação, ativação) que não encontra baseline nenhum grava o débito da entidade em vez de reprovar a biblioteca inteira de uma vez, e audita `x_verify_baseline_recorded` com `reason: "hook_grandfathering"`. A CLI explícita continua honesta: sem baseline, o aviso conta.

## O laço `--fix`

Porte de `skills/squads/scripts/improve-squad.ts:98-134` sem a etapa de consenso — nenhuma chamada de LLM em lugar nenhum do laço:

1. `check` → os findings com `autofix: "mechanical"` e fixer declarado são os alvos.
2. Backup com `fs.cpSync` para `$NIRVANA_HOME/.nirvana/verify-backups/<kind>/<slug>.<ts>/`; os cinco mais recentes por entidade ficam. Nunca `rsync`: a matriz de CI roda Windows, onde ele não existe.
3. Os fixers rodam na ordem fixa do módulo — estrutura, manifesto, routing, arquivos — e `surface_regen` por último, porque qualquer reescrita de manifesto muda a superfície. Empresa tem um passo depois dele: `protocol_bump_2`, que declara `2.0` só quando não resta erro (§18.4) e não altera a superfície, porque `protocol` não entra nem nas entradas nem na prosa extraída.
4. `check` de novo.
5. **Rollback** — `rm` + `cpSync`, byte a byte — quando um fixer lançou, quando o manifesto parou de parsear, ou quando surgiu um erro que não existia antes. O motivo entra em `fix_outcome.rollback_reason`.
6. O relatório mostra `before` e `after`.

Uma segunda rodada de `--fix` é no-op por construção: todo fixer compara antes de escrever e não escreve quando não há diferença. Os fixers editam YAML pela API de documento da biblioteca `yaml`, então comentários, ordem das chaves e formatação dos nós intocados sobrevivem.

Dois limites que não são negociáveis: **nenhum fixer apaga conteúdo autoral** (arquivo deprecado é relatado, não removido) e **nenhum fixer fabrica fonte ou citação**. `source_material_missing` e `fonte_density_low` não têm fixer mecânico, e nunca terão.

## O catálogo de mind-clone

Os critérios saem dos números da biblioteca medidos em 26/08/2026 (555 clones vivos: 54 sem bloco `routing:`, 58 sem verdict, 22 com verdict fora do enum, 59 sem `dna_layers`, 357 sem um único `^[FONTE:`, 6 com menos de três camadas).

| Critério | Severidade | Fixer |
|---|---|---|
| `manifest_parse` | erro | — |
| `manifest_schema` | erro | — |
| `manifest_name_mismatch` | erro | `manifest_name_sync` |
| `artifact_missing:<path>` | erro | — |
| `agent_md_invalid` | erro | — |
| `category_numbered` | erro | `category_bare` |
| `domains_item_malformed` | erro | — |
| `validation_verdict_unknown` | erro | — |
| `dna_schema_layers_incomplete` | erro | — |
| `surface_missing` | erro | `surface_regen` |
| `artifacts_status_wrong` | aviso | `artifacts_status_sync` |
| `routing_block_missing`, `one_liner_missing` | aviso (débito) | agêntico |
| `one_liner_too_long` | aviso | — |
| `domains_count`, `domains_negation`, `domains_slash`, `domains_refuses_conflict` | aviso | — |
| `serves_missing`, `serves_too_long`, `not_for_missing` | aviso | — |
| `delegates_to_present` | aviso | `delegates_to_strip` |
| `validation_verdict_missing`, `source_material_missing` | aviso (débito) | — |
| `dna_layers_missing`, `dna_layers_below_min`, `dna_layers_count_drift` | aviso | `dna_layers_sync` |
| `fonte_density_low` | aviso (débito) | — |
| `source_coverage_unsupported` | aviso | — |
| `surface_stale` | aviso | `surface_regen` |
| `self_retrieval_miss` | aviso (débito) | agêntico |
| `registry_absent` | info | — |

Quatro detalhes valem a leitura de quem for estender o catálogo:

- **Artefatos canônicos**: `agent/AGENT.md`, `agent/SOUL.md`, `agent/DNA-CONFIG.yaml`, `dna/dna-schema.md`. Arquivo vazio conta como ausente. Os dois primeiros aceitam o fallback plano (`AGENT.md` na raiz do clone), a mesma tolerância do `index-clones.ts`.
- **Categoria**: a forma canônica é a nua (`marketing`), não a numerada (`01-marketing`). O validador de persona tinha a regra invertida; aqui ela está no sentido da biblioteca viva, e `category_bare` remove o prefixo.
- **Contagem de itens por camada**, em ordem de precedência: os títulos `### ` da camada, senão os itens de lista de primeiro nível, senão as linhas de uma tabela Markdown menos o cabeçalho, senão os parágrafos que abrem com negrito. Medida contra a biblioteca, essa cascata bate com os `dna_layers` autorais muito melhor que qualquer regra única — contar toda linha de lista batia em 5 de 490 clones.
- **Densidade de `^[FONTE:`**: tags por item de camada, mínimo 0,5. Zero fonte é um sinal de que o clone talvez devesse declarar `ARCHETYPE_PERSONA` em vez de ganhar citações inventadas, e a mensagem diz isso.

O schema em Zod, `MindCloneManifestSchema` (`skills/_shared/validators/validators.ts`), é espelho reconciliado de `skills/_shared/schemas/mind-clone.schema.json`: `category` em kebab-case nu, enum de `validation_verdict` com os três valores vivos que a biblioteca já usa (`ARCHETYPE_PERSONA`, `EXTRACTED_FROM_PUBLIC_CORPUS`, `PACKAGED_FROM_EXISTING_DOSSIER`), bloco `routing` conforme `MIND_CLONE_ROUTING_CONTRACT.md`, `delegates_to` tolerado. `mind-clone-schema-parity.test.ts` compara chave a chave e enum a enum os dois arquivos.

## Catálogo de squad

O manifesto da biblioteca é são; o workflow não é. Medido em 26/08/2026 sobre 204 squads: 0 de 5.774 componentes declarados faltam e 705 de 705 `invoke.ref` resolvem, mas **160 de 1.740 `task:` e 180 de 2.786 `agent:` apontam para nada**, 56 passos carregam o prompt inline em vez de referenciar uma task, 15 workflows são órfãos, e o grafo aparece em oito dialetos dos quais só `steps[]` está na spec. O catálogo existe para nomear isso.

**A severidade segue o protocolo do manifesto.** Sob `protocol: "6.0"` as regras de workflow são erro; sob `"5.0"` as mesmas regras são aviso. É a promessa de compatibilidade inteira deste corte: os 204 squads instalados mantêm o veredito que já têm, e um squad que optou pela v6 entra limpo. Três regras fogem disso de propósito: o teto de corpo e o workflow órfão são conselho sob qualquer protocolo (são fatos sobre autoria, não sobre contrato), e `distribution_artifacts` é sempre aviso porque uma cópia instalada de pack legitimamente carrega `PROVENANCE.json`, `LICENSE.txt` e watermark — reprovar por isso impediria o comprador de validar a própria biblioteca. A tabela declara a severidade da v6 (o estado-alvo); cada finding carrega a que de fato se aplica.

| Critério | Severidade | Fixer |
|---|---|---|
| `manifest_parse` | erro | — |
| `manifest_schema` | erro | — |
| `capabilities_missing` | erro | — |
| `capability_outputs_shape` | erro | `outputs_shape_repair` |
| `capability_examples_missing` | erro | `caps_examples_not_for` |
| `not_for_too_long` | erro em 6.0 · aviso em 5.0 | agêntico |
| `invoke_ref_unresolved` | erro | — |
| `invoke_ref_extension` | erro (só 6.0) | `invoke_ref_extension` |
| `components_missing` | erro | `components_files_stub` |
| `workflow_parse` | erro | — |
| `workflow_twin` | por protocolo | `twin_merge` |
| `workflow_inline_prose` | por protocolo | `workflow_inline_prose_to_body` |
| `workflow_ref_unresolved` | por protocolo | `workflow_refs_repair` |
| `workflow_step_id_duplicate` | por protocolo | — |
| `workflow_dangling_requires` | por protocolo | — |
| `workflow_requires_by_output` | por protocolo | `requires_by_output_name` |
| `workflow_cycle` | por protocolo | — |
| `workflow_shape_legacy` | por protocolo | `workflow_normalize_shape` |
| `workflow_stem_case` | por protocolo | — |
| `surface_missing` | erro | `surface_regen` |
| `outputs_pollution` | erro | — |
| `audit_event_unprefixed` | erro (débito) | — |
| `audit_event_unattributed` | erro (débito) | — |
| `evaluator_missing` | erro em 6.0 · aviso em 5.0 | agêntico |
| `surface_stale` | aviso | `surface_regen` |
| `workflow_event_router` | informativo | — |
| `workflow_orphan` | aviso | — |
| `workflow_body_too_long` | aviso | — |
| `produces_untyped` | aviso | — |
| `fidelity_validated_unproven` | aviso | — |
| `portability` | aviso | — |
| `routing_metadata_incomplete` | aviso (débito) | agêntico |
| `requires_no_provider` | aviso | — |
| `agent_frontmatter_incomplete` | aviso | `agents_frontmatter_repair` |
| `task_acceptance_missing` | aviso | `tasks_acceptance_criteria` |
| `dependencies_missing` | aviso | `dependencies_synth` |
| `readme_missing` | aviso | `readme_scaffold` |
| `not_for_dead` | aviso (débito) | — |
| `distribution_artifacts` | aviso | — |
| `protocol_below_6` | aviso | — |

Quem for estender o catálogo precisa de quatro detalhes:

- **Um leitor só.** `skills/squads/lib/workflow-reader.ts` é a única derivação do grafo: `readWorkflow` aceita as duas codificações (YAML v5, Markdown v6 = frontmatter + corpo), `normalizeWorkflow` mapeia cada dialeto sobre a forma canônica da §28.1, `lintWorkflow` decide a severidade pelo protocolo. Validador, auditor, fixer e migração partem daqui para que nenhum deles discorde sobre o que é o grafo de um squad.
- **Nada se perde.** Uma chave de topo desconhecida vai para `extensions`, uma chave de passo desconhecida vai para `step.meta`. Um dialeto atravessa `normalizeWorkflow` → `renderCanonicalMarkdown` → `normalizeWorkflow` e volta ao mesmo objeto, com todo campo ainda lá. Essa é também a razão de a segunda rodada de `--fix` não mexer num byte: a forma canônica é ponto fixo da normalização.
- **Nada se inventa.** Os fixers renomeiam, movem e reformam o que já existe: uma extensão retirada de um ref, a prosa de `task: |` transportada verbatim para `## <step.id>` no corpo, um `depends_on` que nomeava um output reescrito para o passo que o cria, um `output` singular promovido a `outputs[]`. `workflow_refs_repair` **renomeia** quando exatamente um componente casa por caixa ou por `_`↔`-` (o caso `enterprise-dashboard`) e **nunca cria stub**: escrever a task que falta seria fabricar o método do squad. Um `.yaml` também nunca vira `.md` num fixer — trocar a codificação é migração, com backup e relatório (`nrv migrate --to 6`), e o fixer diz isso em vez de agir.
- **`event_routes` não é um DAG.** É um roteador: nenhuma ordem de passos sai dele. O lint emite `workflow_event_router` como **informativo** — conta as rotas, explica o `steps[]` vazio, e não entra em veredito nem em `passed`. Era aviso até 27/08/2026, o que dava constatação permanente e REJECTED sob `--strict` a duas squads corretas. Adivinhar a ordem continua pior que não ter nenhuma, e a migração continua recusando o arquivo sem `--force`.

O `humanize` saiu junto. Era a contradição documentada no inventário: os docs mandavam declarar, o schema estrito rejeitava, e o fixer **escrevia** o campo — de modo que `fix-squad --apply` podia transformar um manifesto válido em inválido. Os seis pontos do critério 9 da auditoria passam a medir o contrato que o juiz de fato lê (`c9_acceptance`: parcela de capabilities com `acceptance[]` ou com task invocada declarando `## Acceptance Criteria`), o total continua 100, e a metade útil do fixer virou `outputs_shape_repair`.

## Catálogo de empresa

A tabela da §16.2 do `skills/businesses/BUSINESS_PROTOCOL_V2.md` **é** este catálogo: 18 erros e 23 avisos, mesmos ids, mesma severidade, mesma classe de autofix, mesma marca de baselinável. O `skills/businesses/tests/protocol-v2-spec-parity.test.ts` compara os dois conjuntos linha a linha, nas duas direções — a spec é o documento, o módulo é a execução, e um critério só de um lado é teste vermelho. Por isso o módulo de empresa não declara nenhum critério `info`: a §16.2 só tem erro e aviso, então o eixo de auto-recuperação é pulado em silêncio quando a empresa não está no registro, em vez de emitir `registry_absent` como o módulo de clone faz.

Os números que moldaram os critérios (61 empresas, 581 cargos, 26/08/2026): nenhum manifesto e nenhum cargo falha no Zod, então nada aqui é sobre YAML malformado. 566 cargos declaram um `self_score_contract` que código nenhum lê, 475 um `heartbeat` que agendador nenhum rodou, 30 manifestos e 201 cargos uma `squads_authorized` vazia que a spec lia como "todos" e o prompt lia como "nenhum", 61 um `employee_count` que o registro recomputa, 7 manifestos guardam `auto_routes` no arquivo errado e 38 empresas não trazem README.

**Erros**: `manifest_parse`, `manifest_schema` (`manifest_schema_repair`), `protocol_unsupported`, `employees_present`, `employee_frontmatter_invalid` (`employee_frontmatter_repair`, só quando o bloco falta inteiro — reescrever um cabeçalho que um humano escreveu é autoria), `intake_exactly_one` (`intake_from_chart_root`, só com zero intakes), `org_chart_missing` e `org_chart_inconsistent` (`org_chart_repair`), `antagonist_bp7`, `auto_route_unknown_employee`, `auto_route_in_manifest` (`auto_routes_relocate`), `pinned_clone_unresolved`, `acceptance_invalid` (`acceptance_normalize`), `surface_missing` (`surface_regen`), `dna_symlink_dangling`, `outputs_pollution`, `audit_event_unprefixed` (débito), `audit_event_unattributed` (débito).

**Avisos**: `protocol_v1` (`protocol_bump_2`), `employee_count_authored` (`employee_count_strip`), `deprecated_field:<campo>` (o fixer varia por campo: `heartbeat_strip`, `acceptance_from_self_score`, `draws_from_to_assigned`, `dna_reference_to_pin` ou `deprecated_field_strip`), `deprecated_file:<arquivo>` (relatado, nunca apagado), `squads_authorized_empty` (`squads_authorized_empty_strip`), `squads_ref_unknown`, `acceptance_missing` (agêntico), `routing_metadata_incomplete` (agêntico), `description_short` (agêntico), `auto_route_never_fires`, `auto_route_catch_all` (`catch_all_to_default_employee`), `seat_thin` (débito), `self_retrieval_miss` (débito), `readme_missing` (`readme_business_scaffold`), `readme_thin` (agêntico), `memory_missing` (`memory_seed`), `runtime_requirements_default` (`runtime_requirements_business_default`), `type_mind_clone_without_pin`, `type_flag_mismatch` (`type_flag_sync`), `dna_dir_present` (`dna_dir_to_bindings`), `surface_stale` (`surface_regen`), `operation_mode_unsupported`, `legacy_partial`.

Os fixers moram em `skills/businesses/lib/business-fixers.js` — CJS com tabela de despacho, como o `mechanical-fixers.js` dos squads — e o scorer de auditoria (`business-audit-criteria.js`) emite os mesmos nomes em `fixable_diff.kind`, mais `fixable_diff.class` dizendo quem pode aplicar (`mechanical`, `agentic`, `none`). Um `fixable_diff` que nomeia um reparo sem aplicador era o defeito anterior; agora as duas superfícies chamam a mesma tabela.

O frontmatter de cargo é editado por `skills/_shared/lib/frontmatter-edit.ts`, que reescreve **só** o bloco `---` e remonta o arquivo em volta da fatia original do corpo. `business.yaml`, `org-chart.yaml` e `routing.yaml` são reescritos inteiros pela API de documento da `yaml`: comentários e ordem de chaves sobrevivem, exceto o comentário grudado numa chave que o fixer remove, que sai com ela.

Medição de `nrv validate business --all` sobre uma cópia da biblioteca instalada (26/08/2026, 61 empresas, 0,8 s sem auto-recuperação e 4,3 s com ela): 53 admitidas, 8 reprovadas, 31 erros (7 `auto_route_in_manifest` e 24 `auto_route_unknown_employee`), 1.262 avisos, 15 empresas com `self_retrieval_miss`. Um `--fix` sobre a mesma cópia aplicou 578 reparos em 3,2 s, sem rollback, com as 61 ainda carregando pelo loader, e a segunda rodada mudou zero bytes.

## Tudo em processo

`verifyEntity`, `verifyAll` e `verifyPack` são chamadas de função. Nada de spawn: `business-audit-criteria.js` inicia o `loader.ts` por empresa com timeout de 30 s, e `--all` sobre 555 clones não pode herdar isso. O eixo de auto-recuperação usa o `runGate` compartilhado (`skills/_shared/scripts/self-retrieval-gate.ts`) com `reindex: false`, e um índice BM25 é cacheado por objeto de registro para que um lote não reconstrua o corpus uma vez por entidade. `--no-retrieval` desliga o eixo inteiro.

O Glance chama o mesmo módulo: `GET /api/mind-clones/validate?slug=…` responde um clone e `GET /api/mind-clones/validate-all` a biblioteca, mantendo `ok`, `errors` e `warnings` e ganhando `findings`. As duas rotas rodam sem auto-recuperação e sem gravar estado.

## Os quatro ganchos

Uma entidade entra no sistema em quatro momentos, e agora os quatro passam pela mesma porta: `verifyHook` (`skills/_shared/lib/verify/hooks.ts`).

| Momento | Onde | Com a flag desligada | Com a flag ligada |
|---|---|---|---|
| Criação | `init-squad.ts`, `init-business.ts` | reparo mecânico e o veredito impresso | erro que sobra apaga o scaffold |
| Instalação | `installer.ts` (na cópia de staging), `install-content.ts` (por entidade, antes do primeiro espelhamento) | avisa e instala | recusa; nada é escrito |
| Ativação | `nrv activate` (antes de instalar dependências) | avisa e ativa | recusa antes de tocar em qualquer dependência |
| Build de packs | `check-entity-admission.ts`, `check-seat-sufficiency.ts` | invólucros de `verifyPack`/`verifyAll` com flags, saída e exit codes congelados | — |

Três regras impedem que um gancho quebre a máquina de um comprador:

1. **Desligado por padrão.** `verify.mode` sai em `report` e `verify.enforce_on_install` / `verify.enforce_on_activate` saem em `false`. Com os padrões, todo gancho imprime e segue. `verify.mode: block` liga os três de uma vez.
2. **Grandfathering.** Em `mode: "hook"`, uma máquina sem baseline **grava** a dívida que encontra (`x_verify_baseline_recorded`, `reason: hook_grandfathering`) em vez de reprovar o que já estava instalado. Só critérios `baselineable` viram dívida; um erro não marcado como baselineável nunca.
3. **Escape documentado.** `--skip-validate` na instalação, `--skip-verify` na ativação e na criação. Um gancho também nunca lança: falha interna vira `ran: false` com o motivo, e o chamador segue.

A criação é o único gancho que reprova por padrão, e por dois motivos: `init-business.ts` já apagava o scaffold quando o loader falhava, e o gancho roda `fix: "mechanical"` **antes** de julgar. Um scaffold é conteúdo autoral menos o que o **engine** possui — os componentes que o manifesto declara e o `.nirvana-surface.json`, que é um hash de arquivos que só existem depois que o wizard escreve. Reparar isso é o que transforma um squad recém-criado de REPROVADO em ADMITIDO; o que os fixers não consertam é um scaffold quebrado, e um scaffold quebrado é apagado.

## `--fix=agentic`

`skills/_shared/lib/verify/agentic.ts`. Os fixers mecânicos consertam **forma**; o que eles não sabem escrever é **sentido** — uma descrição que carrega sinal de roteamento, `example_briefs` que alguém digitaria, o bloco `routing:` de um clone. Esses achados são `autofix: "agentic"`.

O laço: passe mecânica primeiro (nunca peça ao modelo o que um fixer escreve de graça) → cópia de staging da entidade → `runHeadless` do `host-agent-driver` com o `scope-guard` no prompt → re-check **na cópia** → aceita só se os erros não cresceram **e** ao menos um achado alvo sumiu → backup da entidade real e cópia por cima. Quando o alvo era metadado de roteamento (`one_liner`, `domains`, `serves`, `description`), o `self-retrieval-gate` roda depois da cópia e uma reprovação restaura o backup.

Teto de gasto em `--budget-usd` (padrão 3) e relógio em `--timeout-min` (padrão 15). **Nada roda sem `--yes`**: sem ele o comando sai com **exit 2** citando o teto — a confirmação é propriedade do pedido, não da máquina, então a resposta é a mesma em todo lugar. Uma linha no ledger (`openAgenticRun({ targetKind: "verify-fix" })`) e o par `x_verify_fix_started` / `x_verify_fix_finished` tornam o gasto visível. Desligado em `--pack` e sem runtime no PATH.

## No Glance

`GET /api/v1/verify/<kind>/<slug>` responde um `nirvana.verify-report/v1`. Roda em **processo filho** com teto de relógio (`NIRVANA_GLANCE_VERIFY_TIMEOUT_MS`, padrão 20 s), nunca no laço de eventos: o cockpit é uma thread só, e uma entidade lenta congelaria todos os outros painéis. Estouro do teto = `504`; entidade desconhecida = `404`; método diferente de GET = `405`. Sem `--fix`, sem `--record`, sem auto-recuperação.

O reparo é uma ação à parte: `POST /api/actions/verify-fix` (`mutating: true`), com confirmação no painel antes de sair do navegador. Os painéis de squad, empresa e mind-clone ganharam um botão **Verificar** e, quando há achado com fixer mecânico, **Corrigir (--fix)**.

`nrv doctor` ganhou uma seção **Protocol** com as contagens da biblioteca (squads por protocolo, empresas em 1.0 e com campos aposentados). É **WARN, nunca FAIL** — o CI lê `doctor >= 2` como máquina quebrada, e uma biblioteca em migração é o estado normal de todo mundo durante o rollout. Bloquear é papel do `nrv validate`.

## O que ainda não existe

- **Ledger de reparo agêntico por lote**: `--fix=agentic` roda uma entidade por vez; `--all --fix=agentic` pede confirmação na primeira e pára.
