# Squad Creation Wizard (v5)

## Quando carregar

Intent: CREATE com keyword "create squad", "scaffold squad", "new squad",
"`*squad create`".

---

## Visão geral

A criação de squad v5 é um fluxo de **4 rounds de perguntas** seguido de
scaffold determinístico via `scripts/init-squad.ts`. O LLM faz cada
round com a ferramenta `AskUserQuestion` (em runtimes que suportam).
Em runtimes sem prompt UI, o LLM apresenta as perguntas inline e aguarda
resposta no chat.

**Saída final:** `${SQUADS_DIR}/<name>/` com `squad.yaml` válido + skeleton
de agents/tasks/workflows. Pronto para validar e iterar.

---

## Round 1 — Identidade

```
Q1.1  Qual o objetivo principal da squad? (1 frase)
       → será usado como `description` (≥20 chars).

Q1.2  Nome da squad? (kebab-case, sugerido a partir do objetivo)
       → será usado como `name`.

Q1.3  Slash prefix? (2-4 chars)
       → será usado em `*<prefix> ...` ao invocar a squad. Default:
         primeiras 3 letras do nome.
```

Validação após Round 1:
- `name` matches `^[a-z][a-z0-9-]+$`
- `description` ≥ 20 chars
- `prefix` 2-4 chars

Se inválido, repergunte só o campo problemático.

---

## Round 2 — Componentes

```
Q2.1  Quantos agents? (default 2)
       → cada agent vira agents/<slug>.md (template aplicado depois)

Q2.2  Quais os papéis dos agents?
       → exemplo: ["orchestrator", "researcher", "writer"]
       → vira slug em agents/orchestrator.md, agents/researcher.md, ...

Q2.3  Quantos workflows? (default 1)
       → workflow é a sequência de tasks que orquestra agents

Q2.4  Quais os nomes dos workflows?
       → exemplo: ["main-pipeline", "quick-review"]
       → vira workflows/main-pipeline.yaml
```

Validação:
- agent names em kebab-case
- workflow names em kebab-case
- ≥1 agent, ≥1 workflow

---

## Round 3 — Capabilities

Esta é a parte v5-específica. Sem capabilities, a squad fica invisível
ao harness.

```
Q3.1  Quantas capabilities a squad expõe? (default 1, max 50)
       → capability = uma intenção NL que dispara um workflow.

Para CADA capability:

Q3.2  Capability id? (dotted, ≥3 segmentos)
       → exemplo: marketing.funnel.create
       → padrão: <domain>.<feature>.<action>

Q3.3  Descrição da capability? (20-500 chars)
       → será indexada por BM25. Concreto > genérico.

Q3.4  Domains? (1-5 do CAPABILITY_CATALOG_V1)
       → liste domains relevantes; se não estiver no catálogo,
         confirme experimental_domains: true.

Q3.5  Qual workflow desta squad implementa esta capability?
       → invoke.ref aponta para workflows/<nome>.yaml.

Q3.6  Dê 3 exemplos de frases NL que devem casar com esta capability.
       → vão para examples[]. Cobrir variação PT-BR / EN / sinônimos.

Q3.7  Tem alguma frase NL próxima que NÃO deveria casar? (opcional)
       → vai para not_for[]. Cite capability alternativa quando souber.

Q3.8  O output é voltado para humano (texto, copy, doc)?
       → sim → humanize: true (default)
       → não (json/binary/tech) → humanize: false
```

Validação:
- id matches `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$`
- description 20-500 chars
- domains não vazio, ≤5
- invoke.ref aponta para workflow declarado em Round 2
- examples[] ≥1

Se algum domain estiver fora do catálogo, pergunte explicitamente:

```
Q3.4a  '<domain>' não está em CAPABILITY_CATALOG_V1. Quer:
       (a) trocar por um canônico (sugestão: <closest>)
       (b) marcar a squad como experimental_domains: true e seguir
       (c) cancelar e revisar
```

---

## Round 4 — Review

Apresente o `squad.yaml` resultante e pergunte:

```
Q4.1  Aqui está o squad.yaml gerado:
       <pretty-print>

       Confirma a criação em ${SQUADS_DIR}/<name>/? (sim/editar/cancelar)
```

Em caso de "editar", volte ao Round 1/2/3 conforme apropriado.
Em caso de "cancelar", aborte sem escrever nada.
Em caso de "sim", proceda ao scaffold.

---

## Scaffold determinístico

Após confirmação, o LLM executa:

```bash
bun ~/.claude/skills/squads/scripts/init-squad.ts ${SQUADS_DIR}/<name> \
  --name <name> \
  --description "<description>" \
  --prefix <prefix> \
  --capability-id <cap_id> \
  --capability-description "<cap_description>" \
  --capability-domains "<d1,d2>" \
  --workflow-ref <workflow_name>
```

`init-squad.ts` substitui placeholders em `templates/squad.yaml.tmpl`,
cria os subdirs `agents/`, `tasks/`, `workflows/`, `schemas/`, e grava
`squad.yaml`.

Depois disso o LLM:

1. Para cada agent declarado, copia `templates/agent.md.tmpl` para
   `agents/<name>.md` e preenche frontmatter (`maxTurns: 25`,
   `tools: [read, write]`, `model: sonnet`).
2. Para cada task implícito, copia `templates/task.md.tmpl`.
3. Para cada workflow, copia `templates/workflow.yaml.tmpl` e preenche
   `steps[]` com agent+task pairs.

---

## Validação final (loop até passar)

```bash
bun ~/.claude/skills/squads/scripts/validate-squad.ts ${SQUADS_DIR}/<name>
```

Se falhar, leia o output e conserte:
- erro de capability → revise Round 3
- arquivo de agent/task/workflow ausente → preencha skeleton
- domain fora do catálogo → confirme experimental_domains

Não declare a squad pronta enquanto a validação não passar.

---

## Index e teste

```bash
bun ~/.claude/skills/squads/scripts/index-squads.ts
bun ~/.claude/skills/squads/scripts/list-squads.ts --proto 5.0
```

A squad recém-criada deve aparecer com `caps=N` correspondendo às
capabilities declaradas.

---

## Notas operacionais

- O wizard funciona em **Claude Code**, **Codex** e **Gemini CLI** —
  use `AskUserQuestion` quando disponível, senão prompt inline.
- O LLM nunca deve **inventar capabilities** ou agents que o usuário
  não pediu (P5 Surgical Changes).
- Se o usuário quer uma squad v4 legacy, use `--legacy-v4`:
  `bun scripts/init-squad.ts ... --legacy-v4` (gera com
  `templates/squad-v4.yaml.tmpl`, sem capabilities[]).
- Se o usuário fornece um brief tipo "crie uma squad para X" sem
  detalhes, o LLM faz Round 1-3 com `AskUserQuestion`. Se o brief
  já tem todos os campos, pular para Round 4 (review).
- Após scaffold + validação, sempre rode `index-squads.ts` para que o
  harness descubra a nova squad.
