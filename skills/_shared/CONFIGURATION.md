# _shared · Configuration Reference

> Tudo que pode ser configurado nas peças centrais (schemas, validators, catalog, adapters).
> Última atualização: 2026-05-03.

---

## 1. O que mora aqui

`~/.claude/skills/_shared/` é onde os 3 skills (businesses, squads, harness) **importam** schemas, validators e catalog. **Não é executável sozinho** — sempre é consumido por outras skills.

```
catalogs/CAPABILITY_CATALOG_V1.yaml      ← vocabulário canônico (57 domains)
schemas/business.schema.json             ← business manifest
schemas/capability.schema.json           ← squad capability
schemas/core-schemas.json                ← bundle: employee, org_chart, routing, ticket, mention, etc.
schemas/dna.schema.json                  ← mind-clone DNA file
validators/validators.ts                 ← Zod (TypeScript)
validators/validators.py                 ← Pydantic v2 (Python)
adapters/{claude-code,codex,gemini-cli}.md ← runtime-neutral specs
```

A configuração relevante aqui é estática (governance + versioning), não env vars.

---

## 2. Capability Catalog — `catalogs/CAPABILITY_CATALOG_V1.yaml`

Source of truth do vocabulário controlado.

### Estrutura

```yaml
version: "1.0.0"
protocol_compatibility:
  squad: "5.0"
  business: "1.0"
  harness: "1.0"
generated_at: "2026-05-02"
status: stable

domains:
  - id: marketing
    description: "..."
  - id: branding
    description: "..."
  # ... 57 entries em 6 categorias

namespaces:
  - prefix: marketing
    parent_domain: marketing
    sample_capabilities: [marketing.campaign.full_funnel, ...]
  # ...

reserved_prefixes: []
deprecated: []
validation_rules:
  ...
governance:
  additions: "PR review by protocol authors"
  removals: "deprecation cycle of one minor version"
```

### Domains atuais (57)

**Marketing & Sales (10):** marketing, sales, branding, copy, growth, performance, ads, retention, lifecycle, crm

**Content & Media (8):** content, media, video, audio, image, social_media, podcasting, journalism

**Engineering & Tech (11):** software_engineering, frontend, backend, mobile, data_engineering, devops, security, infrastructure, ai_engineering, qa, observability

**Business & Strategy (10):** strategy, business_operations, finance, accounting, legal, compliance, hr, recruiting, consulting, analytics

**Vertical (12):** healthcare, education, real_estate, fintech, crypto, gaming, ecommerce, hospitality, energy, agriculture, government, foodtech

**Cross-cutting (6):** research, knowledge_management, document_processing, automation, integration, **multi_agent_orchestration** (adicionado 2026-05-02)

### Como adicionar domain novo

1. Edite `catalogs/CAPABILITY_CATALOG_V1.yaml`
2. Inclua na categoria certa (Marketing/Content/Engineering/Business/Vertical/Cross-cutting)
3. Atualize o count no comment header da categoria
4. Se requer namespace novo, adicione em `namespaces[]`
5. Squad/business agora aceita o domain sem `experimental_domains: true`

### Como deprecate domain

1. Marque em `deprecated[]` com `from_version` e `replacement`
2. Schemas continuam aceitando 1 minor version
3. `validate-squad.ts` emite warning quando squad usa domain deprecated

---

## 3. Schemas (JSON Schema 2020-12)

Schemas controlam o que é aceito em manifests, frontmatters, e payloads de runtime.

### `business.schema.json`

| Campo | Required | Constraint |
|---|---|---|
| `name` | ✅ | regex `^[a-z][a-z0-9-]{1,63}$` |
| `version` | ✅ | semver |
| `protocol` | ✅ | enum: `"1.0"` |
| `description` | ✅ | 20-500 chars |
| `domains` | ✅ | 1-50 entries, cada matching `^[a-z][a-z0-9_]*$` |
| `employee_count` | optional | 1-100 |
| `authority_level` | optional | enum: `tier-1, tier-2, tier-3` (default `tier-2`) |
| `operation_mode` | ✅ | enum: `zero_human, hybrid, human_in_loop` (default `zero_human`) |
| `runtime_requirements.minimum[]` | ✅ | min 1 entry |
| `legacy.*` | optional | `additionalProperties: true` (free-form) |
| `experimental_domains` | optional | boolean (default `false`) |

### `capability.schema.json`

| Campo | Required | Constraint |
|---|---|---|
| `id` | ✅ | regex `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$` (≥3 segments) |
| `description` | ✅ | 20-500 chars |
| `domains[]` | ✅ | 1-5 entries |
| `inputs[]` | optional | `{name, type, formats, schema, required, description}` |
| `outputs[]` | optional | type enum: `file, string, json, array, markdown, html, binary` |
| `tools_required[]` | optional | array of strings |
| `invoke.type` | ✅ | enum: `workflow, task, agent` |
| `invoke.ref` | ✅ | string |
| `examples[]` | ✅ | min 1, each ≥5 chars |
| `produces[]` | optional | kebab-case deliverable slugs (≥1, ≤20); sinal primário de descoberta agêntica |
| `example_briefs[]` | optional | briefs reais PT/EN (≤10, cada 20-500 chars) |
| `keywords[]` | optional | sinônimos PT/EN (≤30, cada 2-60 chars) |
| `not_for[]` | optional | array of strings |
| `fidelity` | optional | `{status: validated\|experimental\|drifted\|retired, ground_truth_dir?, eval_results?, threshold?}` |
| `score_boost` | optional | number (default 1.0) |
| `model_hint` | optional | enum: `haiku, sonnet, opus, inherit` |
| `estimated_cost_usd` | optional | number ≥0 |
| `parallel_safe` | optional | boolean (default `false`); Phase 5 — concorrência segura no DAG |
| `writes_paths[]` | optional | paths que a capability escreve (consumido pelo race-detector) |

### `core-schemas.json#/definitions/employee`

| Campo | Required | Constraint |
|---|---|---|
| `name` | ✅ | regex `^[a-z][a-z0-9-]{1,63}$` |
| `role` | ✅ | min 3 chars |
| `type` | ✅ | enum: `functional_specialist, mind_clone` |
| `description` | ✅ | min 20 chars |
| `maxTurns` | ✅ | 1-200 (CAP HARDCODED) |
| `reports_to` | ✅ | slug or `null` |
| `manages[]` | optional | array of slugs |
| `tools[]` | optional | array (free-form) |
| `model` | optional | enum |
| `budget_monthly_usd` | optional | non-negative number |
| `heartbeat.cadence` | optional | enum: `hourly, daily, weekly, manual` |
| `is_antagonist` | optional | boolean |
| `is_brief_intake` | optional | boolean |
| `dna_reference` | optional | path |
| `disclosure_required` | optional | boolean (forced `true` when `type: mind_clone`) |
| `commercial_use_allowed` | optional | enum: `never, review, allowed` |
| `self_score_contract` | ✅ | object com `criteria[]` |
| `self_score_contract.max_revise_iterations` | optional | 0-5 (default 2) |

### `core-schemas.json#/definitions/handoff_artifact`

| Campo | Required | Constraint |
|---|---|---|
| `schemaVersion` | ✅ | string (default `1.0.0`) |
| `from_agent` | ✅ | string |
| `to_agent` | ✅ | string |
| `summary` | ✅ | 10-1000 chars |
| `next_action` | ✅ | string |
| `key_decisions[]` | optional | max 5 |
| `files_modified[]` | optional | max 10 |
| `blockers[]` | optional | max 3 |
| `business_extensions.type` | optional | enum: `mention, ticket, escalation, delegation, auto_route` |

Este é o schema **mais crítico** quando `MAESTRO_HARD_FAIL_MODE=true` — toda handoff entre agents é validada contra ele.

### `dna.schema.json`

Frontmatter de mind-clone:

| Campo | Required |
|---|---|
| `name` | ✅ |
| `description` | ✅ |
| `model` | ✅ |
| `maxTurns` | ✅ (1-200) |
| `tools[]` | ✅ |

Body deve ter 10 seções top-level numeradas (`## 1. ...` até `## 10. ...`). Validado por `validators.py#validate_dna_file()`.

---

## 4. Validators — `validators.{ts,py}`

### TypeScript / Zod (`validators.ts`)

Exporta:

| Schema | Função |
|---|---|
| `CapabilitySchema` | Para validar capability dentro de squad.yaml |
| `SquadManifestSchema` | Para validar squad.yaml |
| `SelfScoreContractSchema` | Subset usado em employee |
| `EscalationTriggerSchema` | Subset usado em employee |
| `EmployeeFrontmatterSchema` | Para validar `<biz>/employees/<name>.md` frontmatter |
| `BusinessManifestSchema` | Para validar business.yaml |
| `OrgChartSchema` | Para validar org-chart.yaml |
| `RoutingSchema` | Para validar routing.yaml |
| `TicketSchema, MentionSchema` | Runtime primitives |
| `HandoffArtifactSchema` | **Crítico para enforcement layer** |
| `ApprovalChainSchema` | Approval primitives |
| `RegistrySquadsSchema, RegistryBusinessesSchema` | Para validar registries gerados |
| `AuditEventSchema` | Para validar audit jsonl entries |
| `HarnessConfigSchema, HarnessNotificationSchema` | Harness-specific |
| `validateBusinessIntegrity({manifest, employees, org_chart})` | Cross-artifact: BP7 + intake unique + DAG no cycles + bidirectional |

Smoke: `bun ~/.claude/skills/_shared/validators/validators.ts test`

### Python / Pydantic v2 (`validators.py`)

Mirror do TS:

| Class | Função |
|---|---|
| `BusinessManifest` | Mirror de BusinessManifestSchema |
| `Employee` | Mirror de EmployeeFrontmatterSchema |
| `OrgChart` | Mirror de OrgChartSchema |
| `Routing` | Mirror de RoutingSchema |
| `HandoffArtifact` | **Mirror crítico — usado pelo enforcement.js** |
| `AuditEvent` | Mirror |
| `validate_dna_file(path)` | Frontmatter + 10 seções numeradas |

Test: `cd ~/.claude/skills/_shared/validators && python3 -m pytest validators.py` (36 passed atualmente).

### Como mudar validador

1. Edite ambos validators.ts E validators.py simultaneamente (TS = source de UX, PY = source de enforcement runtime)
2. Roda os 2 test suites para detectar drift
3. Atualize schemas JSON correspondente em `schemas/` se mudou shape
4. Documente em `~/.claude/skills/_shared/README.md#schemas`

---

## 5. Adapters — runtime-neutral specs

`adapters/{claude-code,codex,gemini-cli}.md` descrevem como cada runtime implementa as 15 seções canônicas:

1. Skill discovery
2. Subagent spawning
3. Memory isolation enforcement
4. Tool whitelisting
5. Handoff artifact validation
6. Audit event emission
7. Budget pre-flight
8. Workflow orchestration
9. Mention/ticket dispatch
10. Escalation trigger handling
11. Approval chain execution
12. Cron / heartbeat scheduling (optional)
13. Project memory layout
14. Multi-runtime negotiation

Use estes quando:
- Implementar adapter novo (cursor, aider, antigravity)
- Verificar se runtime suporta o protocolo completo
- Debugging cross-runtime brief portability

`adapters/README.md` tem matrix comparativa de features entre runtimes.

---

## 6. Variáveis de ambiente que afetam _shared

Não há env vars exclusivas de `_shared`. Mas estes paths são lidos por validators e schemas:

| Variável | Default | Função |
|---|---|---|
| `HOME` | (auto) | Usado para resolver paths absolutos em validators |

Tudo mais é hardcoded por design — schemas centrais não devem variar entre máquinas.

---

## 7. Como contribuir mudanças

### Adicionar schema novo

1. Edite `core-schemas.json` adicionando definition `<name>`
2. Mirror em Zod (`validators.ts`) com strict mode (`.strict()`)
3. Mirror em Pydantic (`validators.py`) com `model_config = ConfigDict(extra='forbid')`
4. Add positive + strict-mode-rejection tests
5. Run smoke + pytest:
   ```bash
   cd ~/.claude/skills/_shared/validators
   bun validators.ts test
   python3 -m pytest validators.py
   ```

### Adicionar runtime adapter novo

1. Copie `adapters/claude-code.md` como template (15 seções canônicas)
2. Para cada seção, documente primitiva nativa
3. Adicione linha no `adapters/README.md` (feature matrix)
4. Add `<runtime>` ao enum `Runtime` em ambos validators

### Adicionar domain ao catalog

Ver §2 acima.

---

## 8. Versioning policy

| Asset | Versioning |
|---|---|
| `CAPABILITY_CATALOG_V1.yaml` | Semver — additions = minor, removals = major |
| Schemas | Implícito no `protocol` field (squad: `"5.0"`, business: `"1.0"`, harness: `"1.0"`) |
| Validators | Devem suportar TODAS as protocol versions live (atualmente squad 4.0 + 5.0, business 1.0) |
| Adapters | Independente — versionado por arquivo |

---

## 9. Test coverage

| Suite | Comando | Status |
|---|---|---|
| TS smoke | `bun validators.ts test` | 8/8 OK |
| Python pytest | `python3 -m pytest validators.py` | 36/36 passed |
| Drift detection | Ambos rodando | Manual — sem CI ainda |

---

## 10. Troubleshooting

| Sintoma | Causa | Fix |
|---|---|---|
| Validator TS aceita, Python rejeita (ou vice-versa) | Drift entre os dois | Review diff, alinhar |
| `Domain X not in catalog` warning | Domain ausente | Add ao `CAPABILITY_CATALOG_V1.yaml` ou usar `experimental_domains: true` |
| `Capability id pattern violation` | <3 dotted segments | Ajustar id |
| `Extra inputs not permitted` | Schema strict, campo extra | Remover OR mover para `legacy.*` (que aceita extras) |
| Pydantic erro em `HandoffArtifact` mas TS aceita | Schemas core podem ter divergido | Conferir `core-schemas.json` é source de verdade |

---

## Limites configuráveis (`limits.py` / `limits.ts`)

> Adicionado 2026-05-15. Permite sobrescrever limites de tamanho/contagem
> dos validators sem editar código.

### Por quê

Vários campos tinham limites hard-coded (`description` 500 chars,
`produces` 30 itens, `keywords` 40 itens, etc.). Com modelos de janela
de 1M tokens e businesses multi-dimensionais, alguns limites ficaram
apertados. Agora são configuráveis — mas **com cabeça**: nem tudo deve
crescer.

### Arquivos

| Arquivo | Função |
|---|---|
| `validators/limits.py` | Loader cascata (Python) — exporta `LIMITS` |
| `validators/limits.ts` | Loader cascata (TypeScript) — exporta `LIMITS` |
| `~/.claude/nirvana-limits.yaml` | Override nível usuário (opcional) |
| `<projeto>/.nirvana-limits.yaml` | Override nível projeto (opcional) |

`validators.py` e `validators.ts` importam `LIMITS` e usam nos
`StringConstraints` / `z.string().max()`.

### Cascata de precedência (maior vence)

```
1. NIRVANA_LIMIT_<KEY>  env var
2. <projeto>/.nirvana-limits.yaml      (acha subindo do cwd até a raiz)
3. ~/.claude/nirvana-limits.yaml       (nível usuário)
4. DEFAULTS                            (valores históricos hard-coded)
```

**Backward-compatible**: sem `.yaml` e sem env var, `LIMITS == DEFAULTS`
== comportamento idêntico ao anterior.

### Safety bounds

Toda chave tem `(piso, teto)` em `SAFETY_BOUNDS`. Valores absurdos são
**clampados** com aviso no stderr — não é possível, por exemplo, setar
`business_description_max=10` (quebraria entidades existentes) nem
`employee_max_turns_max=99999` (runaway financeiro).

### 3 buckets de limite

| Bucket | Política | Exemplos |
|---|---|---|
| **A — PAYLOAD SIZE** | Configurável, baixo risco | description, example_briefs, keywords, produces, handoff_summary |
| **B — EXECUTION CONTROL** | Configurável, exige cap orçamentário no projeto | max_turns, max_tokens, max_duration, max_handoffs |
| **C — FEATURE LIMITS** | **NÃO** exposto — limite é feature de design | handoff.blockers (3), orgchart.reports (1), domains, selfscore.criteria min |

### Chaves disponíveis (22)

```
# Bucket A — payload size
business_description_max            (default 500)
business_produces_max               (default 30)
business_example_briefs_max         (default 15)
business_example_briefs_item_max    (default 500)
business_keywords_max               (default 40)
business_capabilities_max           (default 100)
capability_description_max          (default 500)
capability_produces_max             (default 20)
capability_example_briefs_max       (default 10)
capability_example_briefs_item_max  (default 500)
capability_keywords_max             (default 30)
squad_capabilities_max              (default 50)
handoff_summary_max                 (default 1000)
handoff_files_modified_max          (default 10)
employee_description_max            (default null = sem teto)

# Bucket B — execution control (CAUTELA)
employee_max_turns_max              (default 200)
dna_max_turns_max                   (default 200)
harness_default_max_tokens          (default 200000)
harness_default_max_cost_usd        (default 2.00)
harness_default_max_handoffs        (default 20)
harness_default_max_duration_seconds(default 600)
business_memory_max_facts_ceiling   (default 5000)
```

### Inspecionar limites efetivos

```bash
python3 ~/.claude/skills/_shared/validators/limits.py    # tabela Python
bun     ~/.claude/skills/_shared/validators/limits.ts    # tabela TS
NIRVANA_LIMITS_DEBUG=1 python3 -c "import limits"         # com fonte de cada valor
```

### Fix incluído (2026-05): `SelfScoreCriterion.id`

A regex era `^[a-z_]+$` — bloqueava dígitos não-iniciais
(`iso_42001_compliant`, `gpt4_check`). Corrigida para
`^[a-z][a-z0-9_]*$`. Não é configurável — é fix de bug.

### Onde o JSON Schema fica defasado

Os arquivos `schemas/*.json` continuam com os **defaults antigos**
(ferramentas externas que validam por JSON Schema não conhecem env vars).
`validators.py`/`.ts` têm precedência no runtime real do Nirvana. Se
você usa um validador JSON Schema externo, ele será mais restritivo —
isso é seguro (rejeita a mais, nunca a menos).

---

## Referências

- **README.md** — overview de _shared + sample usage
- **CAPABILITY_CATALOG_V1.yaml** — vocabulário canônico
- **schemas/{business,capability,core-schemas,dna}.schema.json**
- **validators/{validators.ts, validators.py, limits.ts, limits.py}**
- **~/.claude/nirvana-limits.yaml** — override de limites nível usuário
- **adapters/{claude-code,codex,gemini-cli}.md** + `adapters/README.md`
- **~/.claude/skills/businesses/CONFIGURATION.md** — consumer downstream
- **~/.claude/skills/squads/CONFIGURATION.md** — consumer downstream
- **~/.claude/skills/harness/CONFIGURATION.md** — consumer downstream
