# harness skill · Configuration Reference

> Tudo que pode ser configurado nesta skill, onde, e o efeito de cada variável.
> Última atualização: 2026-05-03 (refactor: budget elevado + Stage -1 + v4 inferred).

---

## 1. Onde a configuração mora

4 fontes, em ordem de precedência (a primeira ganha):

1. **`ctx` argument** passado em `route(brief, ctx)` (programmatic API)
2. **CLI flags** dos scripts (`--threshold`, `--budget`)
3. **`config.yaml`** local (`~/.claude/skills/harness/config.yaml`)
4. **Variáveis de ambiente** (`~/.env`)
5. **Defaults hardcoded** em `lib/router.js`

A `config.yaml` é o lugar canônico para mudar comportamento global. `~/.env` overrides apenas alguns valores específicos (caps de budget e thresholds — ver §3).

---

## 2. `config.yaml` — campos completos

Path: `~/.claude/skills/harness/config.yaml`. Estado atual após MAX POWER MODE:

```yaml
budget:
  default_max_cost_usd: 50.0
  default_max_tokens: 1000000
  default_max_handoffs: 100
  default_max_duration_seconds: 7200
  on_budget_exceeded: warn
  auto_invoke_budget_usd: 25.0

baselines:
  squad_capability_usd: 0.30
  business_usd: 0.80
  per_handoff_usd: 0.05

routing:
  match_high_threshold: 0.80
  match_high_lead: 0.15
  match_ambiguous_threshold: 0.60
  match_ambiguous_window: 0.15

audit:
  retention_days: 90
```

### Bloco `budget`

| Campo | Default atual | Função |
|---|---|---|
| `default_max_cost_usd` | `50.0` | Cap de custo por invocation. Stage 4 abortar/warn se estimativa exceder. **Era 2.0 antes do MAX POWER.** |
| `default_max_tokens` | `1000000` (1M) | Cap de tokens. **Era 200K.** |
| `default_max_handoffs` | `100` | Cap de handoffs entre agents. |
| `default_max_duration_seconds` | `7200` (2h) | Timeout total da invocation. |
| `on_budget_exceeded` | `warn` | `abort` (para tudo), `warn` (avisa mas continua), `escalate` (pede confirmação humana). **Era `abort` antes — agora `warn` para não quebrar pipelines longos.** |
| `auto_invoke_budget_usd` | `25.0` | Cap para invocations automáticas (sem confirmação humana). Acima disso, escalate. |

### Bloco `baselines`

Estimativas usadas em Stage 4 para previsão de custo antes de dispatchar:

| Campo | Default | Função |
|---|---|---|
| `squad_capability_usd` | `0.30` | Custo médio de invocação de 1 squad capability |
| `business_usd` | `0.80` | Custo médio de dispatch de 1 brief para 1 business |
| `per_handoff_usd` | `0.05` | Custo agregado por handoff (acumula em pipelines longos) |

### Bloco `routing`

Thresholds do Stage 3 (decisão HIGH / AMBIGUOUS / NO_MATCH):

| Campo | Default | Função |
|---|---|---|
| `match_high_threshold` | `0.80` | Score normalizado mínimo para HIGH (top must be ≥ esse valor) |
| `match_high_lead` | `0.15` | Lead mínimo do top sobre o segundo (top - second ≥ esse valor para HIGH) |
| `match_ambiguous_threshold` | `0.60` | Score mínimo para entrar no cluster AMBIGUOUS |
| `match_ambiguous_window` | `0.15` | Largura da janela do cluster (top - second ≤ esse valor → AMBIGUOUS) |

### Bloco `audit`

| Campo | Default | Função |
|---|---|---|
| `retention_days` | `90` | Quantos dias de logs jsonl manter em `${HARNESS_LOGS_DIR}/` |

---

## 3. Variáveis de ambiente — overrides

Setadas em `~/.env` e lidas por `lib/router.js` (sobrescrevem `config.yaml` quando presentes):

### Budget caps

| Variável | Default no .env | Função |
|---|---|---|
| `HARNESS_DEFAULT_MAX_COST_USD` | `50` | Override de `budget.default_max_cost_usd` |
| `HARNESS_DEFAULT_MAX_TOKENS` | `1000000` | Override de `budget.default_max_tokens` |
| `HARNESS_DEFAULT_MAX_HANDOFFS` | `100` | Override de `budget.default_max_handoffs` |
| `HARNESS_DEFAULT_MAX_DURATION_SECONDS` | `7200` | Override de `budget.default_max_duration_seconds` |
| `HARNESS_ON_BUDGET_EXCEEDED` | `warn` | Override de `budget.on_budget_exceeded` |
| `HARNESS_AUTO_INVOKE_BUDGET_USD` | `25` | Override de `budget.auto_invoke_budget_usd` |

### Routing thresholds

> Honestidade doc↔código: o `lib/router.js` atual **não lê nenhuma env var** (`grep process.env lib/router.js` = vazio). Os thresholds vêm de `DEFAULT_THRESHOLDS` (frozen) e de `STAGE0_KEYWORD_THRESHOLD = 1.0`; o único override real é programático, via `opts.thresholds` / `ctx.stage0Threshold`. As env vars abaixo foram documentadas como intenção, mas **não estão wired** — não as use esperando efeito.

| Controle | Valor real (no código) | Override real |
|---|---|---|
| `match_high_threshold` | `0.80` (`DEFAULT_THRESHOLDS`) | `opts.thresholds.match_high_threshold` (programmatic) |
| `match_ambiguous_threshold` | `0.60` (`DEFAULT_THRESHOLDS`) | `opts.thresholds.match_ambiguous_threshold` (programmatic) |
| Stage 0 keyword threshold | `1.0` (`STAGE0_KEYWORD_THRESHOLD`, match exato) | `ctx.stage0Threshold` / `opts.threshold` (programmatic) |
| Stage -1 enabled | `true` | `ctx.disableStageMinus1` (programmatic) |

### Telemetry / paths

| Variável | Default | Função |
|---|---|---|
| `HARNESS_TELEMETRY` | `jsonl` | Formato: `jsonl` (file local), `otel` (export real OTel — ainda stub) |
| `HARNESS_LOGS_DIR` | `~/.harness-logs` | Diretório onde audit jsonl é gravado |

---

## 4. Pipeline 6-stage — controles por stage

### Stage -1 — Meta-intent detection

Detecta briefs amplos (multi-business, lance, audita) → curto-circuita para `business.project.orchestrate`.

| Controle | Onde | Função |
|---|---|---|
| `HARNESS_STAGE_MINUS_1_ENABLED` (env) | env | Liga/desliga (default ON) |
| `ctx.disableStageMinus1` | programmatic | Desliga por chamada |
| `ctx.metaActionVerbsThreshold` | programmatic | Min verbos distintos (default 3) |
| `ctx.metaSeparatorsThreshold` | programmatic | Min separadores `,/+/e/and` (default 2) |
| `META_INTENT_KEYWORDS[]` | hardcoded `lib/router.js` | Edit no código para adicionar palavras-chave de orquestração (atual: 35+ entries PT-BR + EN) |
| `META_ACTION_VERBS[]` | hardcoded | Edit para adicionar verbos canônicos |

### Stage 0 — Business auto_route short-circuit

Pattern matching contra `business.routing.auto_routes[]`.

| Controle | Onde | Função |
|---|---|---|
| `HARNESS_STAGE0_KEYWORD_THRESHOLD` | env (NÃO lido) | Documentado mas não wired — o router não lê env. Valor real `1.0` (match exato), no código. |
| `ctx.stage0Threshold` / `opts.threshold` | programmatic | Override real por chamada (default `1.0`) |
| `PREMIUM_BRIEF_KEYWORDS[]` | hardcoded `lib/router.js` | Lista de palavras (awwwards, cinematic, webgl, gsap, ...) que fazem Stage 0 ser **bypassado** — força o brief ir para Stage 2 BM25 onde squads premium ganham |

### Stage 1 — Intent classify

Heurística verbo-set: WORK / RUN_ORG / BOTH.

| Controle | Onde | Função |
|---|---|---|
| `WORK_VERBS[]` / `RUN_ORG_VERBS[]` | hardcoded `lib/router.js` | Edit para mudar classificação |
| `ctx.classifier` | programmatic | Plugar LLM externo (recebe brief, retorna `{intent, domains, verbs, confidence}`) |
| `ctx.knownDomains[]` | programmatic | Override do conjunto de domains aceitos para extração |

### Stage 2 — BM25

Busca em registry de squads + businesses + v4 inferred capabilities.

| Controle | Onde | Função |
|---|---|---|
| `score_boost` por capability | manifest squad.yaml | Multiplica score (default 1.0; premium = 1.2 inferred) |
| `not_for[]` por capability | manifest | Frases que penalizam o match (multiplicador 0.4) |
| `DEFAULT_THRESHOLDS.not_for_penalty` | hardcoded | Multiplicador de penalty (default 0.4) |
| `topK` | programmatic via `ctx` | Quantos candidatos retornar (default 10) |

### Stage 3 — Decision

Sinaliza HIGH/AMBIGUOUS/NO_MATCH usando thresholds de `config.yaml#routing`.

### Stage 4 — Budget pre-flight

Estima custo antes de dispatchar. Aborta/warna conforme `on_budget_exceeded`.

### Stage 5 — Invocation plan

Lazy: produz JSON do plano. Adapter (Claude Code, Codex, Gemini-CLI) dispatches via primitiva native.

| Controle | Onde | Função |
|---|---|---|
| `ctx.runtime` | programmatic | `'claude-code' | 'codex' | 'gemini-cli'` — afeta `adapter_hint` no plan |
| `max_handoff_tokens` | hardcoded `stage5Invoke` | Default 800; tamanho máximo do handoff_artifact |

---

## 5. Scripts CLI — flags

### `find.ts "<brief>" [opções]`

Roteia 1 brief e mostra top matches.

| Flag | Default | Função |
|---|---|---|
| `<brief>` (positional) | obrigatório | Texto livre |
| `--json` | (off) | Output em JSON completo dos 6 stages |

### `route.ts "<brief>"`

Mesma coisa de `find.ts --json`.

### `validate.ts`

Valida config.yaml + smoke das 6 fases.

### `index.ts`

No-op atual — `lib/registry-loader.js` é lazy, lê registries dos paths fixos.

---

## 6. Programmatic API — ctx options

```javascript
const router = require('~/.claude/skills/harness/lib/router');

const decision = await router.route(brief, {
  // Registries (default: load from ~/.{businesses,squads}-registry.json)
  registries: { squads, businesses },

  // Thresholds (override config.yaml)
  thresholds: {
    match_high_threshold: 0.85,
    match_high_lead: 0.20,
    match_ambiguous_threshold: 0.65,
    match_ambiguous_window: 0.10,
    not_for_penalty: 0.5,
  },

  // Budget (override config.yaml)
  budget: {
    default_max_cost_usd: 100,
    default_max_tokens: 2000000,
  },

  // Stage controls
  disableStageMinus1: false,
  metaActionVerbsThreshold: 3,
  metaSeparatorsThreshold: 2,
  stage0Threshold: 1.0,            // default (match exato); baixe (ex: 0.5) p/ match parcial

  // Stage 1 LLM classifier override
  classifier: async (brief, ctx) => ({
    intent: 'WORK',
    domains: ['marketing'],
    verbs: ['create'],
    confidence: 0.92,
  }),

  // Stage 1 known domains
  knownDomains: ['marketing', 'sales', 'design'],

  // Runtime hint for Stage 5
  runtime: 'claude-code',
});
```

---

## 7. Premium routing — PREMIUM_BRIEF_KEYWORDS

Lista hardcoded em `lib/router.js`. Quando o brief contém qualquer dessas palavras, Stage 0 é **bypassado** (não curto-circuita) e o brief vai direto para Stage 2 BM25.

Atual:
```
EN: awwwards, singularity, cinematic, webgl, gsap, three.js, scroll-driven, parallax, award-winning, award winning, production-ready, premium quality, agency-grade, agency grade, high-fidelity, pixel-perfect
```

Por que existe: sem isso, Stage 0 (threshold `1.0`, match exato) match contra `business.routing.auto_routes[].pattern` ANTES do BM25 chegar nos squads premium (awwwards-singularity-studio etc.). Com a lista, o brief premium vai para Stage 2 onde awwwards vence com `score_boost: 1.2`.

Para adicionar palavras: edite o array em `lib/router.js`.

---

## 8. Como mudar configuração

### Subir budget para projeto grande

```bash
echo 'HARNESS_DEFAULT_MAX_COST_USD=100' >> ~/.env
echo 'HARNESS_DEFAULT_MAX_TOKENS=2000000' >> ~/.env
source ~/.env
```

OU edite `config.yaml`:

```yaml
budget:
  default_max_cost_usd: 100
  default_max_tokens: 2000000
```

### Forçar abort em vez de warn

```bash
echo 'HARNESS_ON_BUDGET_EXCEEDED=abort' >> ~/.env
```

### Tornar Stage 3 mais conservador (menos HIGH, mais AMBIGUOUS)

```bash
echo 'HARNESS_MATCH_HIGH_THRESHOLD=0.90' >> ~/.env
echo 'HARNESS_MATCH_AMBIGUOUS_THRESHOLD=0.70' >> ~/.env
```

### Desligar Stage -1 (debug)

```bash
echo 'HARNESS_STAGE_MINUS_1_ENABLED=false' >> ~/.env
```

OU via ctx:
```javascript
router.route(brief, { disableStageMinus1: true })
```

### Adicionar novo runtime (cursor, aider)

1. Edite `~/.claude/skills/_shared/validators/validators.{ts,py}` adicionando ao `Runtime` enum
2. Crie `~/.claude/skills/_shared/adapters/<runtime>.md`
3. Atualize `lib/router.js#stage5Invoke` para detectar `ctx.runtime === '<id>'`

---

## 9. Defaults e limites

| Limite | Valor |
|---|---|
| `topK` (Stage 2 candidates) | 10 |
| `max_handoff_tokens` (Stage 5) | 800 |
| `not_for_penalty` (multiplier) | 0.4 |
| Budget timeout safety | 2× `default_max_duration_seconds` (4h hard limit) |

---

## 10. Troubleshooting

| Sintoma | Causa | Fix |
|---|---|---|
| Stage 0 sempre vence (specialists hijacking) | Raro com threshold `1.0` (match exato) | Para afrouxar, passe `ctx.stage0Threshold` programaticamente — o router não lê env var |
| Stage -1 over-matching | Defaults muito permissivos | Suba `metaActionVerbsThreshold` para 4 |
| Awwwards não descoberto | Brief sem keywords premium | Use "cinematic", "awwwards", etc. (PREMIUM_BRIEF_KEYWORDS) |
| BM25 score baixo | Description curta ou examples fracos | Pad description ≥20 chars; adicione 2-3 examples próximos do user vocab |
| Budget abort muito cedo | Cap baixo | Suba `HARNESS_DEFAULT_MAX_COST_USD` |
| `NO_MATCH` em tudo | Registries vazios | `bash ~/.claude/skills/{businesses,squads}/scripts/index-*.sh` |
| Audit log vazio | Permissions ou path errado | `mkdir -p $HARNESS_LOGS_DIR && chmod 755 $HARNESS_LOGS_DIR` |

---

## Referências

- **SKILL.md** — entrada da skill
- **README.md** — overview + tutoriais
- **HARNESS_PROTOCOL_V1.md** — spec completo
- **lib/router.js** — implementação dos 6 stages
- **lib/bm25.js** — BM25 in-process
- **~/.claude/skills/businesses/CONFIGURATION.md** — registry consumido em Stage 0 + Stage 2
- **~/.claude/skills/squads/CONFIGURATION.md** — registry consumido em Stage 2
- **${MAESTRO_DIR}/CONFIGURATION.md** — config do orquestrador downstream
