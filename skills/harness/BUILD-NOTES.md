# Harness Skill — Build Notes

## 2026-08-06 — routing-360 state (current)

The routing-360 overhaul (branch `feat/routing-360`, Phases 0-5) rebuilt the
routing and dispatch surface on top of the v1 build below. Summary of what is
true today:

- **Routing** — agentic mode is the default (registry digest + structured
  contract, `lib/agentic-router.ts`); the fast router (`lib/router.js`) grew
  stages -2/-1.5/0.5/-1/2.5/2.7/3.5, coverage NO_MATCH gates, a Unicode
  tokenizer, per-squad docs, keyword/example_briefs field weights, and a
  business-first tiebreak. Dense/BM25 RRF fusion is retired by measurement;
  the dense arm survives only as the opt-in NO_MATCH fallback slot. Truth:
  `references/01-routing.md`.
- **Eval harness** — `tests/routing-eval.test.ts` runs the golden set on
  every suite run (2026-08-06: n=2,963, top-1 98.1%, negatives NO_MATCH
  73.3%); watermark/regression cases locked in `tests/router*.test.ts`.
- **Cascade in code** — Business → Squad → agent-x resolves deterministically
  (`lib/dispatch-cascade.ts`); squad-only routes actually dispatch
  (`lib/squad-exec.ts`); delivery is fail-closed (`lib/delivery-pipeline.ts`,
  exit codes 0/1/2/3/4).
- **Never-stall** — dispatch run-ledger (`lib/run-ledger.ts`) + supervisor
  (`scripts/supervisor.ts`, `nrv supervisor sweep|status|watch`) recover
  stalled runs; every dispatch triggers a lazy sweep.
- **Audit** — closed enum (96 events) + open `x_` namespace; the event table
  in `references/03-audit.md` is GENERATED (`scripts/gen-audit-events-doc.ts`)
  and test-locked. Parity gates: `scripts/check-audit-parity.ts` and
  `scripts/check-skillmd-command-parity.ts`, both `--strict` in `check:all`.
- **Driver** — one canonical 9-runtime driver
  (`_shared/lib/host-agent-driver.ts`) with file-lock and ledger heartbeat;
  the harness copy re-exports it.
- **English source** — comments and agentic instructions are English, gated
  by `scripts/check-english-source.ts --strict`; PT-BR runtime UX strings and
  user-language data (briefs, trigger phrases, content scaffolds) stay
  localized by design.

Everything below this line is the original 2026-05-02 build log, kept as
history — several file inventories and defaults in it no longer match the
tree (see `HARNESS_PROTOCOL_V1.md`'s banner for the spec-level list).

---

## Historical — v1.0 build (2026-05-02)

> Skill `harness` transitioned from spec-only to operational v1.0.
> Built 2026-05-02 on Node 18+ stdlib + Python 3.9+ stdlib only.

## O que foi entregue

### `lib/` (Node.js puro, zero deps)

- **`bm25.js`** — BM25 clássico (k1=1.5, b=0.75) com tokenização snake_case-aware e max-score normalization. ~178 LOC.
- **`registry-loader.js`** — Carrega `${SQUADS_REGISTRY_PATH}` e `${BUSINESSES_REGISTRY_PATH}` com fallback gracioso (empty stub + warnings) quando ausentes. ~136 LOC.
- **`audit.js`** — JSONL append-only em `${HARNESS_LOGS_DIR}/<date>/audit.jsonl`. Closed-enum de eventos (HP2: failure-loud em event names desconhecidos). Inclui `rotate(days)` e `readRecent(n)`. ~141 LOC.
- **`budget.js`** — Pre-flight estimator com config.yaml override. Lê YAML via `python3 yaml.safe_load` quando disponível, fallback para parser inline. ~201 LOC.
- **`router.js`** — Orquestra os 5 stages: `stage1IntentClassify` (heurística por verbos com hook async para LLM), `stage2Match` (BM25 com penalty `not_for` e filtro por intent), `stage3Decide` (3 sinais), `stage4BudgetCheck`, `stage5Invoke` (gera plano lazy, não invoca). ~436 LOC.
- **`bootstrap.js`** — Idempotent first-run helper (`mkdir -p ~/.harness-state`, `${HARNESS_LOGS_DIR}/<date>`). ~44 LOC.

### `scripts/`

- **`index.ts`** — Reindexa via squads/businesses skills; cria stubs quando inexistentes. ~122 LOC.
- **`find.ts`** — Dry-run do router; saída humanizada ou `--json`. ~90 LOC.
- **`route.ts`** — Pipeline completo + plano de invocação. Flags: `--dry-run`, `--verbose`, `--json`, `--budget=USD`. ~148 LOC.
- **`validate.ts`** — Self-test (bootstrap, módulos, registries, BM25, audit, validators presentes). ~126 LOC.

### `templates/`

- **`intent-classifier-default.md`** — Prompt template Stage 1 (Haiku tier), com placeholders `{{BRIEF}}`, `{{KNOWN_DOMAINS}}`, `{{KNOWN_CAPABILITIES}}` e exemplos.

### `references/` (PT-BR, alinhado com squads/businesses)

- **`01-routing.md`** — 5 stages detalhados, exemplos HIGH/AMBIGUOUS/NO_MATCH, comandos. ~213 LOC.
- **`02-budget.md`** — Caps, baselines, override per-business, on_exceeded actions. ~150 LOC.
- **`03-audit.md`** — Schema, eventos canônicos, queries comuns, retenção. ~169 LOC.

### `tests/`

- **`smoke.ts`** — End-to-end: validate.ts + 3 queries via find.ts + presence do audit log + sanity de normalização BM25. PASS 6/6 hoje em fresh run.

### `config.yaml`

Defaults conforme HARNESS_PROTOCOL_V1.md §5.1. Overrides comentados.

### `SKILL.md` (atualizado)

Frontmatter preservado. Adicionadas:
- Seção "First invocation (auto-bootstrap)".
- Tabela "Intent classification" mapeando verbo → reference → comando.
- Bloco "Exemplos concretos" com 5 invocações reais.

## Testes executados

```
$ bun tests/smoke.ts
==> validate.ts
    PASS: validate.ts exit 0
==> find.ts on three synthetic queries
    PASS: find.ts 'transcribe this video into text' returned valid decision JSON
    PASS: find.ts 'manage marketing for client X this quarter' returned valid decision JSON
    PASS: find.ts 'audit security of this codebase' returned valid decision JSON
==> audit log written today
    PASS: audit log ${HARNESS_LOGS_DIR}/2026-05-02/audit.jsonl present with 7 events
==> BM25 normalization sanity
    PASS: BM25 max-score normalization (top == 1.0, all in [0,1])

passed: 6
failed: 0
smoke PASS
```

Idempotência verificada: 2 runs consecutivos de `index.ts` + `smoke.ts` ambos PASS sem alterações de estado.

## Trade-offs assumidos

1. **Stage 1 LLM call: heurística por padrão.** Implementação pluga `ctx.classifier(brief, ctx)` async, mas o default é gratuito (verb-set match). Adapters que quiserem usar Haiku consomem o template em `templates/intent-classifier-default.md`. Decisão: zero LLM cost por padrão; runtime escolhe se quer pagar.

2. **Stage 5 NÃO invoca, apenas planeja.** O harness emite `invocation_plan` JSON; o adapter dispara via Skill tool / `forkSubagent` / Task tool. Decisão: harness puro, sem coupling de runtime — funciona idêntico em claude-code, codex, gemini-cli.

3. **YAML parsing: Python primeiro, parser inline de fallback.** `lib/budget.js` tenta `python3 yaml.safe_load`; se falhar, usa um parser micro que cobre flat key/value de até 1 nível de aninhamento (suficiente para `config.yaml`). Decisão: zero `npm install`, mas mantém DX caso Python esteja ausente.

4. **Registries vazios = NO_MATCH com warning, não erro.** A skill funciona em fresh install antes das skills `squads`/`businesses` indexarem. Decisão: habilita TDD top-down (router pode ser testado isoladamente).

5. **Per-project audit log delegado às skills filhas.** O harness só grava em `${HARNESS_LOGS_DIR}/<date>/audit.jsonl` (sessão). `${PROJECTS_OUTPUT_DIR}/<project>/audit.jsonl` fica como responsabilidade de quem invoca (squad/business). Decisão: o harness não conhece project_id obrigatoriamente.

6. **Adapters/ deixados intencionalmente vazios.** A skill `harness/adapters/` existe mas não duplica os arquivos em `_shared/adapters/`. SKILL.md aponta para `~/.claude/skills/_shared/adapters/{claude-code,codex,gemini-cli}.md` como fonte canônica. Decisão: REUSE (DRY) sobre cópia local.

## Próximos passos sugeridos (não bloqueantes)

- **Tier 2 embedding discovery.** Quando Tier 1 (BM25) cair frequentemente em NO_MATCH legítimos, plugar um embedding model opcional. Configuração via `routing.tier2_embedding: enabled` em `config.yaml` (já reservada no schema). Não implementado nesta v1.0.
- **Histórico de telemetria → estimativa dinâmica.** `budget.estimate()` hoje usa baselines estáticos. Substituir por média móvel das últimas N execuções por target_id, lendo de `${HARNESS_LOGS_DIR}/`. Aspiracional.
- **OTel real exporter.** Hoje o "telemetry" é apenas `audit.emit` (JSONL). Quando o adapter tiver SDK OTel configurado, traduzir os audit events em spans `harness.brief`/`harness.intent_classification`/etc. conforme §9. Aspiracional.
- **Isolation guard via FS hooks.** §11 prescreve um wrapper de Read/Write/Edit que rejeita paths fora do escopo do projeto. Hoje a skill confia que o adapter aplica esse guard. Plugar um hook explícito em `lib/isolation-guard.js` quando virar prioridade.
- **CLI binary.** Adicionar um `bin/harness` shim que despacha `harness brief|find|index|...` para os scripts. Hoje só é exposto via `bash scripts/*.sh`. Cosmetic; o conteúdo está pronto.
- **Cross-AI parity test.** Rodar smoke.ts nos 3 runtimes (claude-code, codex, gemini-cli) e validar que o `decision JSON` é idêntico — a skill é runtime-agnostic by construction; smoke verifica no claude-code only.

## Filesystem observado pós-build

```
~/.claude/skills/harness/
├── BUILD-NOTES.md                 (este arquivo)
├── HARNESS_PROTOCOL_V1.md         (intacto, source of truth)
├── SKILL.md                       (atualizado: First Invocation, Intent Table, exemplos)
├── config.yaml                    (defaults zero-deps YAML)
├── adapters/                      (vazio — ver _shared/adapters/)
├── lib/
│   ├── audit.js
│   ├── bm25.js
│   ├── bootstrap.js
│   ├── budget.js
│   ├── registry-loader.js
│   └── router.js
├── references/
│   ├── 01-routing.md
│   ├── 02-budget.md
│   └── 03-audit.md
├── schemas/                       (vazio — REUSE _shared/schemas/)
├── scripts/
│   ├── find.ts
│   ├── index.ts
│   ├── route.ts
│   └── validate.ts
├── templates/
│   └── intent-classifier-default.md
└── tests/
    └── smoke.ts

~/.harness-state/                  (criado por bootstrap)
${HARNESS_LOGS_DIR}/2026-05-02/audit.jsonl   (criado por audit.emit)
${SQUADS_REGISTRY_PATH}            (stub, populado quando squads indexar)
${BUSINESSES_REGISTRY_PATH}        (stub, populado quando businesses indexar)
```

## Resumo numérico

| Métrica | Valor |
|---|---|
| LOC novas (sem HARNESS_PROTOCOL_V1.md) | ~2650 |
| Arquivos criados | 14 (+ atualização do SKILL.md) |
| Dependências externas | 0 (Node stdlib + Python stdlib) |
| Smoke test | 6/6 PASS |
| Idempotência | verificada (2x runs sem efeito colateral) |
