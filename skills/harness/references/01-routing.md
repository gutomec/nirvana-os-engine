# Reference 01 — Routing (5-stage pipeline)

> Detalha como o brief vira decisão. Source of truth: `HARNESS_PROTOCOL_V1.md` §6.

## Visão geral

Todo brief passa por 5 stages, em ordem, sem atalhos. Cada stage tem entrada e saída bem definidas, e qualquer um pode falhar de forma explícita (HP2: failure-loud).

```
brief
  ↓ Stage 1  intent classification     (~500 tokens, opcional)
  ↓ Stage 2  capability matching        (BM25, zero LLM)
  ↓ Stage 3  routing decision           (HIGH | AMBIGUOUS | NO_MATCH)
  ↓ Stage 4  budget pre-flight          (cost cap, handoffs cap)
  ↓ Stage 5  invocation plan            (lazy load, fork over spawn)
  → emite plano + audit
```

A invocação propriamente dita NÃO é responsabilidade do harness, ela é
delegada ao runtime adapter (Claude Code, Codex, Gemini-CLI). O harness emite
um `invocation_plan` que o adapter consome via seu próprio mecanismo de
sub-agente.

## Stage 1 — Intent classification

**Função:** `router.stage1IntentClassify(brief, ctx)`

Por padrão, usa heurística baseada em verbos (gratuita). Quando o brief é
ambíguo, o adapter pode plugar um `classifier` async que chama o modelo mais
barato (Haiku) com o template em `templates/intent-classifier-default.md`.

```javascript
const router = require('./lib/router');
const intent = router.stage1IntentClassify(
  'manage marketing for client X this quarter',
  { knownDomains: ['marketing','social_media','copywriting'] }
);
// → { intent: 'RUN_ORG', domains: ['marketing'], verbs: ['manage'], confidence: 0.8 }
```

**Saída esperada:**

```typescript
{
  intent: 'WORK' | 'RUN_ORG' | 'BOTH',
  domains: string[],   // snake_case, intersecção com knownDomains
  verbs: string[],
  confidence: number,  // [0, 1]
}
```

## Stage 2 — Capability matching (BM25)

**Função:** `router.stage2Match(intent, registries, opts)`

BM25 clássico (k1=1.5, b=0.75). Documentos:

- 1 doc por (capability_id, provider squad) — texto = `capId + description + examples + domains`.
- 1 doc por business — texto = `slug + description + domains + capabilities`.

Filtro por intent:
- `WORK`  → exclui businesses.
- `RUN_ORG` → exclui squad capabilities.
- `BOTH`  → considera ambos.

Ajustes pós-BM25:
- `score *= meta.score_boost` (default 1.0; capabilities experimentais usam 0.7).
- Penalty `score *= 0.4` quando o brief contém um termo do `not_for` da capability.
- Reranqueia e re-normaliza para top = 1.0.

## Stage 3 — Routing decision (3 sinais)

**Função:** `router.stage3Decide(matches, opts)`

```
top   = matches[0].normalized
lead  = top - matches[1].normalized

if top >= 0.80 AND lead >= 0.15:        signal = HIGH
elif >= 2 candidates within 0.15 of top AND each >= 0.60:   signal = AMBIGUOUS
elif top >= 0.60:                        signal = AMBIGUOUS  (single low-confidence)
else:                                    signal = NO_MATCH
```

Thresholds são parametrizáveis por `ctx.thresholds` (default em
`router.DEFAULT_THRESHOLDS`).

## Stage 4 — Budget pre-flight

**Função:** `router.stage4BudgetCheck(target, ctx)`

Estima custo:
1. Se o registry entry tem `estimated_cost_usd`, usa-o direto.
2. Senão, baseline por tipo (`squad_capability=$0.30`, `business=$0.80`) +
   overhead por handoff esperado (`$0.05` cada).

Compara contra cap (default $2.00, override via `ctx.budget.max_cost_usd` ou
`config.yaml`). Quando `estimated > cap`, retorna `ok: false` e o caller
decide: abort (default), warn, ou escalate.

## Stage 5 — Invocation plan (lazy)

**Função:** `router.stage5Invoke(target, brief, ctx)`

Não invoca; produz um plano:

```json
{
  "target_type": "business" | "squad_capability",
  "target_id": "...",
  "manifest_path": "...",
  "loader": "businesses skill ..." | "squads skill ...",
  "inherit_context": true,
  "handoff_artifact_required": true,
  "max_handoff_tokens": 800
}
```

O adapter consome o plano e dispara via seu primitive nativo (Skill tool,
`forkSubagent`, etc.).

## Pipeline completo

**Função:** `await router.route(brief, ctx)`

Roda os 5 stages em ordem e retorna um JSON consolidado:

```json
{
  "brief": "...",
  "timestamp": "2026-05-02T...",
  "stage1": { ... },
  "stage2": { "candidates_count": 12, "top": [...] },
  "stage3": { "signal": "HIGH", "target": {...}, "alternatives": [...] },
  "stage4": { "ok": true, "estimated_usd": 0.30, ... },
  "stage5": { "target_type": "...", ... },
  "warnings": ["..."]
}
```

## Tabela de signals

| Signal | Condição | Ação esperada do adapter |
|---|---|---|
| `HIGH` | top ≥ 0.80 AND lead ≥ 0.15 | Auto-invoke se capability validada e budget OK; senão, confirmar |
| `AMBIGUOUS` | ≥ 2 candidates ≥ 0.60 dentro de 0.15 do top **OU** top isolado entre 0.60 e 0.80 | `AskUserQuestion` com top-N opções |
| `NO_MATCH` | top < 0.60 | Recusar; sugerir criar capability ou refinar brief |

## Exemplos

### Exemplo 1 — HIGH

```
brief: "transcribe this 30-minute video into text"
stage1.intent: WORK
stage2 top: squad_capability:audio-suite:audio_video.transcribe (norm=1.0)
stage2 second: squad_capability:nirvana:content.summarize (norm=0.42)
stage3.signal: HIGH (1.0 >= 0.80 & lead 0.58 >= 0.15)
stage4.ok: true (estimated $0.30 ≤ cap $2.00)
stage5: invoke audio-suite squad, capability audio_video.transcribe
```

### Exemplo 2 — AMBIGUOUS

```
brief: "create a logo for my coffee brand"
stage2 top: squad_capability:design-suite:graphics.brand_logo (norm=0.78)
stage2 second: squad_capability:design-suite:graphics.illustration (norm=0.72)
stage3.signal: AMBIGUOUS (cluster of 2 within 0.15 of top, both ≥ 0.60)
→ AskUserQuestion com 2 opções e descrições
```

### Exemplo 3 — NO_MATCH

```
brief: "summarize a YouTube playlist into bullet points"
(sem capability matching)
stage2 top: norm=0.31
stage3.signal: NO_MATCH (top < 0.60)
→ recusar; sugerir criar capability `content.youtube_playlist_digest`
```

## Boas práticas

- Roda `bun scripts/index.ts` antes de testar routing — registries
  desatualizados produzem NO_MATCH falso.
- Use `bun scripts/find.ts --json "..."` para inspecionar a decisão sem
  invocar.
- Tweake thresholds em `config.yaml` quando notar muitos falsos negativos.
- Monitore `~/.harness-logs/<date>/audit.jsonl` — toda decisão é registrada.

## Anti-patterns

- NÃO invocar silenciosamente em scores ambíguos. HP2: failure-loud.
- NÃO carregar manifesto completo na Stage 2; só registry. (HP5: lazy load.)
- NÃO ignorar `not_for`; é o primeiro guard contra mismatch.
- NÃO permitir que adapter pule o budget pre-flight para "ser útil". HP3: caps são duros.

## Reference: comandos

```bash
# pipeline completo (apenas plano)
bun scripts/route.ts --dry-run --json "manage marketing for client X"

# inspeção rápida
bun scripts/find.ts "transcribe video"

# rebuild registries
bun scripts/index.ts

# self-test
bun scripts/validate.ts
```
