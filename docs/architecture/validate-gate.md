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

Um subconjunto dos critérios é `baselineable`: os fatos que o pipeline de validação produz e que nenhum fixer pode inventar — `validation_verdict_missing`, `source_material_missing`, `fonte_density_low`, `dna_layers_missing`, `routing_block_missing`, `self_retrieval_miss`. Um finding baselineável que o baseline já registra conta como **débito**: aparece no relatório como `DEBT` e não reprova. Erro duro nunca vira débito.

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
3. Os fixers rodam na ordem fixa do módulo — estrutura, manifesto, routing, arquivos — e `surface_regen` sempre por último, porque qualquer reescrita de manifesto muda a superfície.
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

## Squads e empresas

Neste corte os dois módulos existem com os critérios triviais — o manifesto parseia, `.nirvana-surface.json` existe e bate com os arquivos em disco — para a CLI funcionar de ponta a ponta nos três tipos. O catálogo de squad (v6) e o de empresa (BP v2) entram nos cortes próprios do programa.

## Tudo em processo

`verifyEntity`, `verifyAll` e `verifyPack` são chamadas de função. Nada de spawn: `business-audit-criteria.js` inicia o `loader.ts` por empresa com timeout de 30 s, e `--all` sobre 555 clones não pode herdar isso. O eixo de auto-recuperação usa o `runGate` compartilhado (`skills/_shared/scripts/self-retrieval-gate.ts`) com `reindex: false`, e um índice BM25 é cacheado por objeto de registro para que um lote não reconstrua o corpus uma vez por entidade. `--no-retrieval` desliga o eixo inteiro.

O Glance chama o mesmo módulo: `GET /api/mind-clones/validate?slug=…` responde um clone e `GET /api/mind-clones/validate-all` a biblioteca, mantendo `ok`, `errors` e `warnings` e ganhando `findings`. As duas rotas rodam sem auto-recuperação e sem gravar estado.

## O que ainda não existe

- **`--fix=agentic`**: recusado com uma mensagem clara. O laço agêntico (cópia de staging, `runHeadless`, orçamento, linha no ledger) é um corte próprio.
- **Ganchos**: os wizards, `nrv activate`, a instalação e o build de packs ainda não chamam o módulo. `check-entity-admission.ts` e `check-seat-sufficiency.ts` continuam como estão.
- **Rota versionada do Glance** (`GET /api/v1/verify/<kind>/<slug>`) e a ação `verify-fix`.
- **Flags de rollout** (`verify.mode`, `verify.enforce_on_install`, `verify.enforce_on_activate`).
