# squads skill · Configuration Reference

> Tudo que pode ser configurado nesta skill, onde, e o efeito de cada variável.
> Última atualização: 2026-05-03 (refactor v4 capability inferrer + premium routing).

---

## 1. Onde a configuração mora

3 fontes, em ordem de precedência:

1. **CLI flags** dos scripts (`--roots`, `--report`, `--legacy-v4`)
2. **Variáveis de ambiente** (`~/.env`)
3. **Defaults hardcoded** em `lib/registry.js`

Não existe `config.yaml` próprio. A "configuração runtime" da skill está distribuída entre lib + scripts + .env.

---

## 2. Variáveis de ambiente

| Variável | Default | Função |
|---|---|---|
| `SQUADS_DIR` | `~/squads` | Diretório canônico de squads. Squads novos vão aqui. Indexado pelo `index-squads.ts`. |
| `SQUADS_LEGACY_DIR` | (none) | Diretório legacy adicional (~134 squads v4). Quando definido, lido em paralelo com `${SQUADS_DIR}`. Em colisão de slug, `${SQUADS_DIR}` ganha. |

Ambas são lidas pelo `lib/registry.js` (default roots) e pelos scripts CLI.

### Outras variáveis indiretamente relevantes

| Variável | Quando importa |
|---|---|
| `HARNESS_LOGS_DIR` | Para audit logs do `validate-squad.ts` se rodar com `--audit-trail` |
| `PROJECTS_OUTPUT_DIR` | Subdir relativo a cada squad onde invocations escrevem output |

---

## 3. Scripts CLI — flags

### `init-squad.ts <name> [opções]`

Cria scaffold de squad novo.

| Flag | Default | Função |
|---|---|---|
| `<name>` (positional) | obrigatório | Slug kebab-case |
| `--legacy-v4` | (off, default v5) | Cria scaffold v4 com `agents/`, `tasks/`, `workflows/` flat (sem `capabilities[]`). Use só para coexistir com v4 existente. |
| `--protocol <v>` | `5.0` | Versão do protocolo declarada no manifest |
| `--target-dir <path>` | `$SQUADS_DIR` | Override do diretório de criação |

### `validate-squad.ts <path-or-slug> [opções]`

Valida manifest. Branches por `protocol`:
- `5.0` → Pydantic SquadManifest + capability validator
- `4.0` → legacy B1-B18 blocking checks

| Flag | Default | Função |
|---|---|---|
| `<path-or-slug>` (positional) | obrigatório | Path absoluto ou slug (resolvido contra `$SQUADS_DIR`) |
| `--report` | (off) | Output em formato AI-friendly com remediation guidance por erro |
| `--runtime <id>` | (off) | Valida features_required contra capabilities específicas do runtime (claude-code, codex, gemini-cli) |

### `index-squads.ts [opções]`

Escaneia + gera `${SQUADS_REGISTRY_PATH}` (incluindo `_v4_inferred_capabilities` para v4).

| Flag | Default | Função |
|---|---|---|
| `--roots <dir>...` | `[$SQUADS_LEGACY_DIR, $SQUADS_DIR]` | Diretórios a escanear |
| `--output <path>` | `${SQUADS_REGISTRY_PATH}` | Path do registry |
| `--no-infer-v4` | (off) | Desliga inferência automática de capabilities para v4 squads (não recomendado) |

### `list-squads.ts [opções]`

| Flag | Default | Função |
|---|---|---|
| `--format <fmt>` | `table` | `table` ou `json` |
| `--protocol <v>` | (off) | Filtra `5.0` ou `4.0` |
| `--filter-domain <slug>` | (off) | Mostra só squads com domain |

---

## 4. Squad manifest — `squad.yaml` campos configuráveis

### Top-level (obrigatórios)

| Campo | Função |
|---|---|
| `name` | Slug kebab-case (`^[a-z][a-z0-9-]+$`) |
| `version` | Semver (`^\d+\.\d+\.\d+...$`) |
| `protocol` | `"5.0"` (preferido) ou `"4.0"` (legacy) |
| `description` | Texto descrevendo o squad |
| `author` | Quem criou |
| `license` | Default `MIT` |

### Top-level (opcionais)

| Campo | Default | Função |
|---|---|---|
| `slashPrefix` | `<name>` truncado | Prefix do slash command (ex: `aws` para `*aws ...`) |
| `tags[]` | `[]` | Tags para search/discovery |
| `experimental_domains` | `false` | Aceita domains fora do CAPABILITY_CATALOG_V1.yaml |
| `legacy.v4_path` | (sem) | Path para versão v4 ainda em coexistência |

### `capabilities[]` (v5 only — array de objetos)

| Campo | Função |
|---|---|
| `id` | Pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$` — ≥3 segmentos dotted (ex: `marketing.funnel.create`) |
| `description` | ≥20 chars |
| `domains[]` | 1-5 do CAPABILITY_CATALOG_V1.yaml |
| `examples[]` | ≥1 frase em linguagem natural (BM25 indexa) |
| `outputs[].name` | Nome da saída |
| `outputs[].type` | `file | string | json | array | markdown | html | binary` (NÃO `yaml` ou `jsonl` — schema rejeita) |
| `invoke.type` | `workflow | task | agent` |
| `invoke.ref` | Path relativo ao squad dir |
| `invoke.agent` | (opcional) Agent específico para `task` invocation |
| `invoke.prompt_template` | (opcional) Template para `task` invocation |
| `inputs[]` | (opcional) Inputs declarados — `{name, type, formats[], schema, required, description}` |
| `tools_required[]` | (opcional) Tools que o agent precisa |
| `not_for[]` | (opcional) Frases que penalizam match (ex: "B2C, consumer-grade") |
| `score_boost` | `1.0` | Multiplicador de score no harness BM25. **Premium squads (awwwards, nirvana, etc.) recebem 1.2 quando inferred via v4-capability-inferrer.** |
| `model_hint` | (opcional) `haiku | sonnet | opus` |

### `components` (obrigatório)

| Campo | Função |
|---|---|
| `agents[]` | Lista de paths relativos a `agents/<name>.md` |
| `tasks[]` | Lista de paths relativos a `tasks/<name>.md` |
| `workflows[]` | Lista de paths relativos a `workflows/<name>.yaml` |
| `schemas[]` | (opcional) Schemas JSON do squad |

### `runtime_requirements` (obrigatório)

| Campo | Função |
|---|---|
| `minimum[]` | Lista de `{runtime: <id>, version?: <v>}`. Runtimes aceitos: `claude-code, codex, gemini-cli, cursor, antigravity, openclaw, opencode` |
| `compatible[]` | Runtimes que também funcionam (sem garantia) |
| `incompatible[]` | Runtimes que NÃO funcionam |

### `features_required[]` / `features_optional[]`

15 features canônicas:

| Feature | Função |
|---|---|
| `max_turns` | Cap de turns por invocation |
| `tool_whitelist` | Filtro de tools permitidos |
| `subagent_spawning` | Capacidade de spawnar Agent({subagent_type}) |
| `audit_trail` | Logging de eventos |
| `scheduled_invocation` | Cron / heartbeats |
| `event_bus` | Pub/sub entre agents |
| `hooks` | Pre/post hooks |
| `sandboxing` | Isolation por worktree ou similar |
| `session_memory` | Memória entre invocations |
| `project_memory` | Memória por projeto |
| `global_memory` | Memória cross-projeto |
| `handoff_artifacts` | Schema validation de handoffs |
| `fork_context` | Spawn com fork de contexto |
| `teammate_primitive` | Suporte a `Skill({skill: ..., teammate: ...})` |
| `telemetry_otel` | Export OTel |

---

## 5. v4 capability inferrer — controles

`lib/v4-capability-inferrer.js` infere capabilities virtuais para squads v4. Comportamento configurável:

| Constante (no código) | Default | Como mudar |
|---|---|---|
| `PREMIUM_MARKERS[]` | `[awwwards, nirvana, master, elite, premium, singularity, cinematic, studio, forge]` | Edite array no arquivo. Squads cujo nome contém qualquer marker recebem `score_boost: 1.2` |
| `KEYWORD_DOMAINS[]` | ~30 entries | Edite para mudar mapping `keyword → canonical domain` |
| Inferência habilitada | `true` | Desligue passando `--no-infer-v4` ao `index-squads.ts` |

### Como funciona

Para cada squad v4 (sem `capabilities[]` declarado):

1. Lê `components.workflows[]` do manifest
2. Para cada workflow file: lê `description`, `objective`, `workflow_name` via parsing leve
3. Infere `id`: `<namespace>.<workflow_slug>.execute` (3 segmentos)
4. Infere `domains[]`: heurística keyword → catalog
5. Gera `examples[]` a partir de description ou nome
6. Aplica `score_boost: 1.2` se nome do squad contém PREMIUM_MARKER

Output: `${SQUADS_REGISTRY_PATH}#_v4_inferred_capabilities` (extra-schema, prefixo `_`).

Consumido pelo harness `lib/router.js#buildMatchDocs` no Stage 2 BM25.

### Resultado atual (run-2 do refactor)

- 147 squads v4 inferred
- 458 capabilities virtuais total
- Awwwards-singularity-studio: 5 capabilities discoveráveis

---

## 6. Como mudar configuração

### Migrar squad v4 → v5 nativo

Adicione ao topo do `squad.yaml`:

```yaml
protocol: "5.0"
capabilities:
  - id: <namespace>.<verb>.<action>
    description: "≥20 chars"
    domains: [domain_canonical]
    invoke:
      type: workflow
      ref: workflows/main.yaml
    examples:
      - "Frase 1"
      - "Frase 2"
    outputs:
      - name: result
        type: markdown
```

Re-validate + re-index.

### Mudar root dir

```bash
echo 'SQUADS_DIR=/Volumes/external/squads' >> ~/.env
source ~/.env
bun ~/.claude/skills/squads/scripts/index-squads.ts
```

### Adicionar nova capability a squad existente

Edite `squad.yaml`, append em `capabilities[]`. Re-validate + re-index. BM25 indexa imediatamente.

### Boost de descoberta para um squad específico

```yaml
capabilities:
  - id: my.cap.execute
    score_boost: 1.5     # default 1.0; valores >1.0 priorizam em empate
```

OU adicione palavra ao `PREMIUM_MARKERS[]` de `v4-capability-inferrer.js` se for v4.

### Marcar capability como experimental

```yaml
capabilities:
  - id: experimental.thing.execute
    fidelity_status: experimental    # default 'validated' — afeta se aparece em recommendations
```

**Nota:** o schema Pydantic v5 NÃO aceita `fidelity_status` direto na capability. Para squads v5 puros, esse campo é ignorado. Para v4 inferred, é hardcoded como `inferred`.

---

## 7. Defaults e limites do schema

| Limite | Valor | Origem |
|---|---|---|
| `name` regex | `^[a-z][a-z0-9-]+$` | manifest |
| `version` regex | `^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$` | manifest |
| `protocol` enum | `5.0` ou `4.0` | manifest |
| `capability.id` regex | `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$` | capability.schema.json |
| `capability.description` length | ≥20 chars | capability.schema.json |
| `capability.domains[]` | 1-5 | capability.schema.json |
| `capability.examples[]` | ≥1 | capability.schema.json |
| `outputs[].type` enum | `file | string | json | array | markdown | html | binary` | capability.schema.json |

---

## 8. Troubleshooting de configuração

| Sintoma | Causa | Fix |
|---|---|---|
| `Capability id pattern violation` | <3 segmentos dotted | Use `marketing.funnel.create` (3 segmentos) |
| Domain warning | Não está no catalog | Adicione domain ao `CAPABILITY_CATALOG_V1.yaml` OU set `experimental_domains: true` |
| `outputs[].type: yaml rejected` | Schema só aceita 7 tipos | Use `string` e descreva inline |
| `Extra inputs not permitted: fidelity_status` | v5 schema strict | Remova o campo (ou use v4) |
| Awwwards squad não descoberto | Brief sem keywords premium | Use "cinematic", "awwwards", "webgl" no brief para bypass de Stage 0 |
| BM25 não match seu squad | Description curta ou examples vazios | Pad description ≥20 chars + adicione 2-3 examples próximos do vocabulário do usuário |
| v4 squad sem capabilities inferidas | Manifest sem `components.workflows[]` | Inferrer cai no fallback Strategy B (1 capability genérica via primeiro agent). Se sem agents também, squad fica sem caps. |

---

## Referências

- **SKILL.md** — entrada da skill
- **README.md** — overview
- **TUTORIAL.md** — tutorial passo-a-passo PT-BR
- **SQUAD_PROTOCOL_V5.md** — spec v5 completo
- **SQUAD_PROTOCOL_V4.md** — spec v4 (legacy)
- **lib/v4-capability-inferrer.js** — código + comments do inferrer
- **~/.claude/skills/_shared/catalogs/CAPABILITY_CATALOG_V1.yaml** — vocabulário canônico (57 domains)
- **~/.claude/skills/harness/CONFIGURATION.md** — config do roteador que consome este registry
