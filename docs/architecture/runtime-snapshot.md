# Snapshot de runtime

## Estado

Todo Run dos três canários Gauntlet (`agent-x`, Squad único e Business allowlistado) e todo Run do comando multi-target congela a decisão de runtime, provider e modelo antes do primeiro producer. A decisão vem do broker universal (`RuntimeProviderCatalog`, `RuntimeBroker` e `ModelBroker`, em `skills/_shared/lib`) por meio de `freezeExecutionSnapshot`, em `skills/harness/lib/runtime-snapshot.ts`. O resultado entra no journal como evento `runtime.selection_snapshot`, e o digest canônico dessa estrutura é o `policySnapshotRef` do Run.

O journal é append-only. Atualizar o catálogo depois muda apenas os Runs seguintes: o Run antigo continua devolvendo o mesmo `policySnapshotRef` e o mesmo payload, pelo kernel e pelo Glance, inclusive depois de reiniciar o servidor. Isso fecha o critério "Snapshot de runtime e modelo permanece consultável mesmo depois de atualizar o catálogo".

## Fontes de catálogo

Os descriptors são arquivos `*.json`, `*.yaml` ou `*.yml` no formato `nirvana.runtime-provider/v1alpha1` (exemplo em `skills/squads/tests/fixtures/runtime-providers/`). A busca segue esta ordem, e um diretório inexistente é ignorado sem erro:

1. `NIRVANA_PROVIDER_CATALOG_DIR`, lista separada por `:` (`;` no Windows). Quando definida, substitui as fontes padrão.
2. `~/.nirvana/providers`, o catálogo do usuário.
3. `<projectRoot>/.nirvana/providers`, o catálogo do projeto. O root é `NIRVANA_PROJECT_ROOT` ou o diretório atual, o mesmo que o Glance e o multi-target usam.

Nenhuma leitura de rede acontece. Sem catálogo instalado, nada muda em relação ao comportamento anterior.

## Forma do snapshot

As chaves ficam em ordem canônica (`canonicalJson`), sem `undefined`, para que dois congelamentos sobre o mesmo catálogo produzam o mesmo digest.

Sem descriptor para o runtime, o snapshot é o literal anterior mais a razão:

```json
{
  "model": { "resolved": false, "selection": "runtime-default" },
  "provider": { "resolved": false, "selection": "runtime-provider" },
  "reason": "no provider descriptor for runtime",
  "runtime": { "id": "codex", "source": "flag" }
}
```

Com descriptor e broker compatível:

```json
{
  "catalog": { "dirs": ["/home/user/.nirvana/providers"], "observedAt": "2026-08-24T00:00:00Z", "stale": false },
  "evidence": { "providerId": "fixture-provider", "observedAt": "2026-08-24T00:00:00Z", "modelIds": ["fixture-provider/text-model/1"] },
  "model": { "id": "fixture-provider/text-model/1", "resolved": true },
  "policy": { "allowStale": false, "featuresRequired": [], "modelRequirements": {} },
  "provider": { "id": "fixture-provider", "resolved": true },
  "runtime": { "id": "codex", "resolved": true, "source": "flag", "version": "1.2.0" }
}
```

`runtime.source` registra de onde veio a escolha do runtime: `flag`, `brief`, `rule` ou `default` no dispatch; `flag`, `plan` ou `default` no multi-target. `evidence` é o `evidenceSnapshot` do broker. `policy` guarda os requisitos aplicados (RT-005). `warnings`, `degradations`, `rejected` e `errors` aparecem só quando existem.

## Catálogo stale

`catalog.observed_at` e `catalog.max_age_seconds` definem a validade do descriptor. Vencido, o snapshot fica sem resolução (`runtime.resolved: false`, `provider.id` conhecido, `model.selection: "runtime-default"`), com `catalog.stale: true` e um aviso em `warnings`. A execução prossegue com essa marca (TR-011); não há erro.

`NIRVANA_ALLOW_STALE_CATALOG=1` (ou `allowStale: true` na chamada) aceita o catálogo vencido: o broker resolve provider e modelo e mantém o aviso no snapshot.

## Incompatibilidade

Quando o broker recusa a combinação (feature obrigatória ausente no runtime ou nenhum modelo que atenda aos requisitos), o snapshot traz `errors` e `rejected`. O cutover grava o evento `runtime.selection_snapshot`, compila o plano e encerra o Run em `prepared → rolled_back` com `reason: runtime_incompatible` e os mesmos `errors` no payload da transição. Nenhum producer é chamado, nenhum candidate é criado e o executor legado não entra no lugar (RT-002): o dispatch imprime as razões, grava `x_runtime_incompatible` no audit legado e sai com código 1. No Business, essa saída não conta como rollback para o executor anterior.

O multi-target faz o mesmo no Run coordenador antes de qualquer onda: evento no journal, `x_runtime_incompatible` no audit, `rolled_back` e saída 1.

Hoje os canários não passam `featuresRequired` nem `modelRequirements`: os requisitos ainda não vêm dos manifests. Em produção, a incompatibilidade acontece quando o descriptor do runtime existe e o provider não oferece modelo algum.

## Consulta no Glance

- `GET /api/v1/runs/{run_id}?project_id={project_id}` devolve o Run com `policySnapshotRef`.
- `GET /api/v1/projects/{project_id}/events` lista o journal; o evento `runtime.selection_snapshot` do Run traz `payload.ref` (igual ao `policySnapshotRef`) e `payload.snapshot`.
- A timeline do chat rotula o evento como `Runtime: <id>`, com provider e modelo no subtítulo.

A prova hermética está em `skills/harness/tests/runtime-snapshot-after-catalog-update.e2e.test.ts`: dois Runs com catálogos diferentes, leitura pelo kernel e pelo Glance depois de um restart, catálogo stale com e sem permissão, feature obrigatória ausente, ausência de catálogo e o Run coordenador do multi-target.

## Limites

- Requisitos de features e modelo não são lidos dos manifests de squad ou business nos canários; a chamada aceita `requirements`, mas o dispatch ainda não os preenche.
- O snapshot congela a decisão, não a execução: quando o modelo não resolve, o runtime continua livre para escolher o seu padrão interno.
- Um Run retomado nunca recongela; o snapshot original permanece mesmo que o catálogo tenha mudado entre a queda e a retomada.
