# Tutorial passo a passo · squads skill

> Jornada do zero ao primeiro squad v5 com capability discoverável. Aproximadamente 30 min para completar.

Este tutorial assume Node 18+, Python 3.9+ e a skill já instalada em `~/.claude/skills/squads/`.

---

## Cenário do tutorial

Você quer um squad reusável que faz **análise rápida de competidores SaaS** — recebe nome de um competidor, faz pesquisa web em 2-3 min, e retorna um market-fit report estruturado de 1 página. Esse squad será invocável por qualquer business no portfólio que precisar de análise competitiva.

Você vai criar `competitor-analyzer-quick` com:
- 1 capability: `research.competitor.quick_scan`
- 2 agents: `web-researcher`, `report-synthesizer`
- 2 tasks: `scan-competitor`, `synthesize-report`
- 1 workflow: `quick-scan.yaml`

No fim do tutorial você terá um squad v5 validado e discoverável via harness.

---

## Passo 1 — Inspecionar squads existentes

```bash
bun ~/.claude/skills/squads/scripts/list-squads.ts | head -10
```

Saída esperada:
```
Total: 148 squads
  - business-nirvana-maestro (v1.0.0, protocol 5.0, 7 capabilities)
  - sales-funnel-masters (v5.0.0, protocol 5.0, 7 capabilities)
  - brandcraft-nirvana (v4.x, protocol 4.0, legacy)
  - ...
```

Copie um squad v5 maduro para inspirar:

```bash
cat ${SQUADS_DIR}/sales-funnel-masters/squad.yaml | head -50
```

Você vê: top-level com `name, version, protocol: "5.0", description, capabilities[], components, runtime_requirements`.

---

## Passo 2 — Scaffold do squad novo

```bash
bun ~/.claude/skills/squads/scripts/init-squad.ts competitor-analyzer-quick
```

Isso cria estrutura em `${SQUADS_DIR}/competitor-analyzer-quick/`:
```
squad.yaml         # template v5 com placeholders
agents/            # vazio
tasks/             # vazio
workflows/         # vazio
templates/         # templates de agente/task/workflow
```

---

## Passo 3 — Preencher o `squad.yaml`

Edite `${SQUADS_DIR}/competitor-analyzer-quick/squad.yaml`:

```yaml
name: competitor-analyzer-quick
version: 1.0.0
protocol: "5.0"
description: |
  Squad reusável para análise rápida de competidores SaaS. Recebe nome do
  competidor + ICP do solicitante; retorna market-fit report de 1 página em
  ≤3 min com 5-10 citações.
author: nirvana-system
license: MIT
slashPrefix: caq
tags:
  - research
  - competitor-intelligence

capabilities:
  - id: research.competitor.quick_scan
    description: |
      Análise rápida de 1 competidor SaaS específico. Pesquisa web em ≤3 min,
      extrai positioning + pricing + tração + diferenciação, sintetiza em
      report markdown de 1 página.
    domains:
      - research
      - knowledge_management
    invoke:
      type: workflow
      ref: workflows/quick-scan.yaml
    examples:
      - "Analise o competidor Notion no espaço de productivity SaaS"
      - "Quick scan de Linear vs nosso ICP"
      - "Compete intel rápido sobre Stripe Atlas"
    outputs:
      - name: competitor_report
        type: markdown
        description: Report 1 página com 5 seções (positioning, pricing, tração, diferenciação, ameaça)
    score_boost: 1.0
    model_hint: sonnet

components:
  agents:
    - agents/web-researcher.md
    - agents/report-synthesizer.md
  tasks:
    - tasks/scan-competitor.md
    - tasks/synthesize-report.md
  workflows:
    - workflows/quick-scan.yaml

runtime_requirements:
  minimum:
    - runtime: claude-code

features_required:
  - max_turns
  - tool_whitelist
  - handoff_artifacts

features_optional:
  - hooks
  - telemetry_otel

output:
  base_dir: default
```

**Pontos críticos:**
- `id` da capability tem 3 segmentos dotted (`research.competitor.quick_scan`) — schema rejeita menos
- `description` ≥20 chars
- `domains` em `[research, knowledge_management]` — ambos no canonical catalog (`~/.claude/skills/_shared/catalogs/CAPABILITY_CATALOG_V1.yaml`)
- `examples` com ≥1 frase em linguagem natural (BM25 vai indexar)
- `outputs[].type` apenas `file/string/json/array/markdown/html/binary` (não `yaml`)

---

## Passo 4 — Escrever o agente `web-researcher`

Crie `${SQUADS_DIR}/competitor-analyzer-quick/agents/web-researcher.md`:

```markdown
---
name: web-researcher
id: web-researcher
title: Web Researcher (fast)
icon: 🔎
whenToUse: Use para pesquisa rápida de 1 competidor via WebSearch + WebFetch. Limite ≤6 queries e ≤3 min.
model_hint: sonnet
maxTurns: 12
tools: [WebSearch, WebFetch, Read]
archetype: Builder
---

# Web Researcher

**Papel:** trazer dados verificáveis sobre o competidor em ≤3 min.

## Core principles
- Velocidade > exaustividade. ≤6 queries totais.
- Citação obrigatória — toda afirmação tem URL verificável.
- 2026-aware — preferir fontes ≥2024.

## Inputs
- `competitor_name: string`
- `requester_icp: string` (perfil do solicitante para framing relativo)

## Outputs
```yaml
research_payload:
  competitor: <name>
  positioning: <texto curto>
  pricing_tiers: [...]
  recent_traction_signals: [{ claim, url, year }]
  diferenciacao_vs_alternativas: [...]
  red_flags: [...]
  citations: [{ url, title, accessed_at }]
```

## Steps
1. Query 1: "<competitor> positioning 2026"
2. Query 2: "<competitor> pricing"
3. Query 3-4: "<competitor> reviews 2026" + traction signals
4. WebFetch top-3 URLs relevantes
5. Output research_payload estruturado

## Anti-patterns
- ❌ >6 queries
- ❌ Citação sem URL
- ❌ Inferir pricing sem fonte
```

---

## Passo 5 — Escrever o agente `report-synthesizer`

Crie `${SQUADS_DIR}/competitor-analyzer-quick/agents/report-synthesizer.md`:

```markdown
---
name: report-synthesizer
id: report-synthesizer
title: Report Synthesizer
icon: 📝
whenToUse: Use após web-researcher entregar research_payload. Sintetiza em report markdown de 1 página com 5 seções.
model_hint: sonnet
maxTurns: 10
tools: [Read, Write]
archetype: Balancer
---

# Report Synthesizer

**Papel:** transformar research_payload em report 1 página estruturado.

## Inputs
- `research_payload` (do web-researcher)
- `requester_icp: string`

## Outputs
- `competitor_report.md` com seções:
  1. Sumário em 3 linhas
  2. Positioning + value prop (≤100 palavras)
  3. Pricing & tiers (tabela)
  4. Tração & sinais 2024-2026 (5-7 bullets com URLs)
  5. Ameaça relativa ao ICP do solicitante (1-3 frases acionáveis)

## Anti-patterns
- ❌ Report >1 página
- ❌ Síntese vaga sem números
- ❌ Esquecer URLs de citação
```

---

## Passo 6 — Escrever as 2 tasks

Crie `${SQUADS_DIR}/competitor-analyzer-quick/tasks/scan-competitor.md`:

```markdown
---
name: scan-competitor
agent: web-researcher
type: web_research
duration_estimate: 2-3 min
---

# Task: Scan Competitor

## Entrada
- `competitor_name`
- `requester_icp`

## Saída
- `research_payload` conforme schema do agent

## Steps
1. ≤6 queries WebSearch
2. ≤3 WebFetch
3. Output estruturado YAML

## Success criteria
- ≤6 queries
- ≥3 citations com URL
- Pricing presente OU `pricing: unavailable` flag
```

Crie `${SQUADS_DIR}/competitor-analyzer-quick/tasks/synthesize-report.md`:

```markdown
---
name: synthesize-report
agent: report-synthesizer
type: synthesis
duration_estimate: 1-2 min
---

# Task: Synthesize Report

## Entrada
- `research_payload` (de scan-competitor)
- `requester_icp`

## Saída
- `competitor_report.md` 1 página

## Success criteria
- 5 seções presentes
- ≥5 citações URL preservadas
- Ameaça ao ICP articulada em frase acionável
```

---

## Passo 7 — Escrever o workflow

Crie `${SQUADS_DIR}/competitor-analyzer-quick/workflows/quick-scan.yaml`:

```yaml
name: quick-scan
description: |
  Workflow do squad competitor-analyzer-quick. Sequência: pesquisa web →
  síntese de report. ≤5 min total.
version: 1.0.0
capability: research.competitor.quick_scan
duration_estimate: 3-5 min

inputs:
  - name: competitor_name
    type: string
    required: true
  - name: requester_icp
    type: string
    required: true

outputs:
  - name: competitor_report
    type: markdown

agent_sequence:
  - phase: 1_research
    agent: web-researcher
    task: scan-competitor
    inputs: [competitor_name, requester_icp]
    outputs: [research_payload]
    transitions:
      success: 2_synthesize
      failure: ESCALATE_RESEARCH_FAILED

  - phase: 2_synthesize
    agent: report-synthesizer
    task: synthesize-report
    inputs: [research_payload, requester_icp]
    outputs: [competitor_report]
    transitions:
      success: COMPLETE

success_indicators:
  - ≤6 queries totais
  - ≥5 citations URL
  - Report 1 página markdown
```

---

## Passo 8 — Validar

```bash
bun ~/.claude/skills/squads/scripts/validate-squad.ts ${SQUADS_DIR}/competitor-analyzer-quick
```

Saída esperada:
```
Validating squad at: ${SQUADS_DIR}/competitor-analyzer-quick
Protocol: 5.0
================================
[PASS] v5 manifest valid

Components: 5 referenced, 0 missing
```

Se aparecer **`Capability id pattern violation`**: seu id precisa ter ≥3 segmentos dotted. `research.competitor.quick_scan` ✅, `research.competitor` ❌.

Se aparecer **warnings sobre domains**: o domain não está no catalog canonical. Ou troque para um existente OU adicione `experimental_domains: true` no top-level do `squad.yaml`.

---

## Passo 9 — Indexar

```bash
bun ~/.claude/skills/squads/scripts/index-squads.ts
```

Saída:
```
registry written: ${SQUADS_REGISTRY_PATH}
  squads: 149
  capabilities: 15
v5 squads with capabilities:
  - business-nirvana-maestro (7 capabilities)
  - sales-funnel-masters (7 capabilities)
  - competitor-analyzer-quick (1 capability)
  - ...
```

---

## Passo 10 — Confirmar discovery via harness

```bash
bun ~/.claude/skills/harness/scripts/find.ts "quick scan do Linear como competitor SaaS"
```

Stage 2 BM25 deve match seu squad:

```
signal: HIGH
top-match: squad_capability:competitor-analyzer-quick:research.competitor.quick_scan
```

Se não retornou (top match foi outro squad): seus `examples[]` no manifest provavelmente não cobrem o vocabulário da query. Adicione 2-3 examples mais próximos das frases reais que usuários usariam.

---

## Passo 11 — Invocação real (em session Claude Code)

Em uma session do Claude Code:

> Use o squad competitor-analyzer-quick para fazer quick scan do Linear, ICP é founder solo de SaaS B2B 50 funcionários.

Claude vai:
1. Ler `squad.yaml` da capability
2. Resolver workflow `quick-scan.yaml`
3. Spawnar `web-researcher` com inputs (Agent + tools WebSearch/WebFetch)
4. Receber `research_payload`
5. Spawnar `report-synthesizer` com payload + ICP
6. Receber `competitor_report.md` final
7. Retornar para você

OU programaticamente:

```javascript
Skill({
  skill: "squads",
  args: JSON.stringify({
    command: "invoke-capability",
    squad: "competitor-analyzer-quick",
    capability: "research.competitor.quick_scan",
    inputs: {
      competitor_name: "Linear",
      requester_icp: "founder solo de SaaS B2B 50 funcionários"
    }
  })
})
```

---

## Passo 12 — Iterar o squad

Quando precisar evoluir:

- **Adicionar segunda capability** (ex: `research.competitor.deep_dive` 30min vs quick_scan): apenas adicione no `capabilities[]` + workflow novo. Re-validate, re-index.
- **Trocar agent**: edite `agents/web-researcher.md` (frontmatter ou body). Workflow continua funcionando.
- **Pluggar mind-clone advisor**: adicione `dna_reference` no employee equivalente em business consumer (não no squad).
- **Backward compat com v4**: NÃO necessário aqui — squad já nasceu v5. Mas se você herdou squad v4 e quer migrar, veja `${SQUADS_DIR}/sales-funnel-masters/MIGRATION-NOTES.md`.

---

## Troubleshooting do tutorial

| Erro | Causa | Fix |
|---|---|---|
| `Capability id pattern violation` | <3 segmentos dotted | `research.competitor.quick_scan` ✅ |
| Warnings sobre domains | Domain não está no catalog canonical | troque para existente OU adicione `experimental_domains: true` |
| `outputs[].type: yaml` rejected | Schema só aceita types canonical | use `string` |
| `fidelity_status` rejected | Campo não existe no Pydantic v5 | remova |
| BM25 não match | Examples curtos / vocabulário distante | adicione 2-3 examples mais naturais |
| `Components: N referenced, M missing` | Path em `components[]` aponta para arquivo inexistente | crie o arquivo OU remova do manifest |

---

## Próximos passos

- Compor squad → squad: dentro de um workflow, adicione phase que invoca outra capability via `Skill({skill: "squads", ...})`
- Adicionar quality gate (NSC pattern): crie `checklists/quality-gate.md` com 6-cat veto
- Conectar com business: business pode declarar `squads_authorized: [competitor-analyzer-quick]` em `business.yaml` para usar
- Migrar v4 → v5: pegue um squad legacy de `${SQUADS_LEGACY_DIR}` (se definido) ou `${SQUADS_DIR}`, adicione `protocol: "5.0"` + `capabilities[]`, mantenha `legacy.v4_path` durante coexistência

Veja `README.md` da skill para reference completa, `SQUAD_PROTOCOL_V5.md` para spec detalhado, e `~/.claude/skills/_shared/catalogs/CAPABILITY_CATALOG_V1.yaml` para vocabulário canônico.
