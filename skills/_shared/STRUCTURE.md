# Nirvana Structure — Global vs Project

> **TL;DR.** Você tem **duas hierarquias paralelas**: a **global** (na sua HOME) que serve qualquer projeto e a **project** (dentro de cada projeto) que isola dados quando você quer. O `.env` de cada projeto + a env var `NIRVANA_SCOPE` decidem qual delas o sistema lê.

Este documento é a referência visual. Para detalhes legais do contrato:
- Modes (`global`/`project`/`merge`) e regra de override → [`SCOPE_CONTRACT.md`](./SCOPE_CONTRACT.md)
- Esquema de mind-clones (frontmatter + 10 seções) → [`templates/MIND_CLONE_TEMPLATE.md`](./templates/MIND_CLONE_TEMPLATE.md) e [`schemas/dna.schema.json`](./schemas/dna.schema.json)
- Bootstrap de um novo projeto → [`templates/project-skeleton/README.md`](./templates/project-skeleton/README.md)

---

## Visão lado a lado

```
┌──────────────────────────── GLOBAL  (sua HOME) ─────────────────────────────┐
│  ~/                                                                          │
│  ├── .env                          ← config global (modelos, API keys, etc) │
│  ├── .claude/                                                                │
│  │   ├── skills/                   ← 50+ skills oficiais (harness, squads,  │
│  │   │   ├── _shared/                businesses, …) — nunca duplicar        │
│  │   │   ├── harness/                                                        │
│  │   │   ├── squads/                                                         │
│  │   │   └── businesses/                                                     │
│  │   ├── agents/                   ← agents auto-descobertos                │
│  │   ├── plugins/                                                            │
│  │   └── settings.json             ← config de runtime do Claude Code       │
│  │                                                                           │
│  ├── squads/                       ← biblioteca GLOBAL de squads            │
│  │   ├── alex-data-explorer/                                                 │
│  │   ├── adaptive-tutor-k12/                                                 │
│  │   └── … (153 hoje)                                                        │
│  │                                                                           │
│  ├── businesses/                   ← biblioteca GLOBAL de businesses        │
│  │   ├── _library/                                                           │
│  │   │   └── dna/                  ← DNA library (mind-clones canônicos)    │
│  │   │       ├── 01-marketing-copy-vendas/                                   │
│  │   │       │   ├── alex-hormozi.md       ← canônico                       │
│  │   │       │   ├── alex-hormozi.en.md    ← variante locale                │
│  │   │       │   └── …                                                       │
│  │   │       └── … (61 categorias, 408 mind-clones)                          │
│  │   ├── ads-intelligence/                                                   │
│  │   ├── agency-hq/                                                          │
│  │   └── … (32 hoje)                                                         │
│  │                                                                           │
│  ├── .squads-registry.json         ← cache: índice de squads                │
│  ├── .businesses-registry.json     ← cache: índice de businesses            │
│  ├── .harness-logs/                ← logs de execução do harness            │
│  └── .claude/squads-state/         ← state SQLite por squad (modo global)   │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────── PROJECT  (qualquer projeto) ────────────────────────┐
│  /Users/<você>/Projects/<nome-do-projeto>/                                  │
│  ├── .env                          ← scope + overrides do PROJETO           │
│  │     NIRVANA_SCOPE=project   →  isolado (só vê .nirvana/)                 │
│  │     NIRVANA_SCOPE=merge     →  vê os dois (project sobrescreve)          │
│  │     NIRVANA_SCOPE=global    →  só global (default; .nirvana/ ignorado)   │
│  │                                                                           │
│  ├── .agents/skills/               ← canonical "skills.sh" (15+ runtimes    │
│  │                                   leem direto: Codex, Cursor, OpenCode,  │
│  │                                   Cline, Gemini CLI, Warp, Amp, …)      │
│  ├── .claude/skills        ─────→ symlink → ../.agents/skills              │
│  ├── .continue/skills      ─────→ symlink → ../.agents/skills              │
│  ├── .windsurf/skills      ─────→ symlink → ../.agents/skills              │
│  └── …  (35+ symlinks via init-project.ts)                                  │
│                                                                              │
│  └── .nirvana/                     ← DADOS escopados ao projeto             │
│      ├── README.md                                                           │
│      ├── squads/                   ← squads próprios deste projeto          │
│      │   ├── adaptive-tutor-k12/                                             │
│      │   └── …                                                               │
│      ├── businesses/               ← businesses próprios                    │
│      │   ├── api-development/                                                │
│      │   └── …                                                               │
│      ├── mind-clones/              ← mind-clones COPIADOS do global         │
│      │   ├── 01-marketing-copy-vendas/                                       │
│      │   │   ├── alex-hormozi.md                                             │
│      │   │   └── alex-hormozi.en.md                                          │
│      │   └── …                                                               │
│      ├── outputs/                  ← artefatos gerados pelos squads         │
│      └── state/                    ← state SQLite local ao projeto         │
│          └── squads/                                                         │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Tabela de equivalência

| Conceito                    | GLOBAL                                       | PROJECT                                            | Env var override                |
|-----------------------------|----------------------------------------------|----------------------------------------------------|---------------------------------|
| Skills (código)             | `~/.claude/skills/`                          | `<proj>/.agents/skills/` (+ symlinks)              | `CLAUDE_SKILLS_DIR`             |
| Squads                      | `~/squads/`                                  | `<proj>/.nirvana/squads/`                          | `SQUADS_DIR`, `NIRVANA_PROJECT_SQUADS_DIR` |
| Businesses                  | `~/businesses/`                              | `<proj>/.nirvana/businesses/`                      | `BUSINESSES_DIR`, `NIRVANA_PROJECT_BUSINESSES_DIR` |
| Mind-clones (DNA library)   | `~/businesses/_library/dna/`                 | `<proj>/.nirvana/mind-clones/`                     | `DNA_LIBRARY`, `NIRVANA_PROJECT_MIND_CLONES_DIR` |
| Squads registry (cache)     | `~/.squads-registry.json`                    | re-gerado em modo project                          | `SQUADS_REGISTRY_PATH`          |
| Businesses registry (cache) | `~/.businesses-registry.json`                | re-gerado em modo project                          | `BUSINESSES_REGISTRY_PATH`      |
| Harness logs                | `~/.harness-logs/`                           | `~/.harness-logs/` (compartilhado)                 | `HARNESS_LOGS_DIR`              |
| Squad state (SQLite)        | `~/.claude/squads-state/`                    | `<proj>/.nirvana/state/squads/`                    | `NIRVANA_STATE_DIR`             |
| Outputs                     | (não aplicável)                              | `<proj>/.nirvana/outputs/`                         | `PROJECTS_OUTPUT_DIR`           |
| Project root detection      | (n/a)                                        | walk-up até `.env` / `.nirvana` / `.git`           | `NIRVANA_PROJECT_ROOT`          |

---

## Os 3 scope modes — o que cada um vê

| Modo      | Squads/Businesses visíveis                          | Mind-clones                       | Quando usar                                                  |
|-----------|-----------------------------------------------------|-----------------------------------|--------------------------------------------------------------|
| `global`  | só `~/squads/*` e `~/businesses/*`                  | só `~/businesses/_library/dna/`   | Default; todos os projetos compartilham a biblioteca         |
| `project` | só `<proj>/.nirvana/squads/*` e `…/businesses/*`    | só `<proj>/.nirvana/mind-clones/` | Cliente entrega: deve ser portável e auto-contido            |
| `merge`   | união (project sobrescreve global por slug)         | união (project sobrescreve)       | Customização local sem perder o que está no global           |

Override rule (modo `merge`): se o mesmo slug existe em ambos, **o project vence**. Use `NIRVANA_GLOBAL_INCLUDE_ONLY` ou `NIRVANA_GLOBAL_EXCLUDE` em `.env` para filtrar globais quando estiver em merge.

---

## Mind-clones: como funciona o formato canônico

Cada mind-clone é um **arquivo `.md` único, auto-contido**, válido em qualquer máquina.

**Localização (global):** `~/businesses/_library/dna/<categoria>/<slug>.md`
Categoria segue padrão `^[0-9]{2}-[a-z][a-z0-9-]+$` (ex: `01-marketing-copy-vendas`).

**Variantes locale:** arquivos paralelos `<slug>.<locale>.md` (ex: `alex-hormozi.en.md`, `alex-hormozi.pt.md`). O resolver (`locale-resolver.ts`) escolhe a apropriada por preferência.

**Frontmatter obrigatório** (validado contra [`schemas/dna.schema.json`](./schemas/dna.schema.json)):

```yaml
---
name: alex-hormozi              # kebab-case, deve casar com o nome do arquivo
description: "Use quando … Invocar para: … NÃO usar para: …"   # ≥40 chars
model: inherit                    # haiku | sonnet | opus | inherit
maxTurns: 40                     # 1..200
tools: [Read, Write, Grep, …]    # array não-vazio
---
```

**Body obrigatório:** todas as 10 seções canônicas (`## 1.` até `## 10.`):

```
## 1. FILOSOFIA            ## 6. VOZ & PERSONALIDADE
## 2. MODELOS MENTAIS      ## 7. PLAYBOOKS
## 3. HEURÍSTICAS          ## 8. GATILHOS DE INVOCAÇÃO
## 4. FRAMEWORKS           ## 9. FONTES & RASTREABILIDADE
## 5. METODOLOGIAS         ## 10. PROTOCOLO DE USO
```

Esqueleto pronto para copiar: [`templates/MIND_CLONE_TEMPLATE.md`](./templates/MIND_CLONE_TEMPLATE.md).

**Validação:** o copy do Setup mode (Glance) **valida antes de copiar**. Mind-clone malformado é rejeitado com erro `SECTIONS_MISSING` ou `NAME_PATTERN`. Audite com `GET /api/mind-clones/validate-all` (no Glance) ou via CLI.

---

## Quickstart

### Cenário 1 — usuário só global (sem isolamento por projeto)

Esse é o caminho default. Você não precisa fazer nada — todos os projetos onde você invocar o harness/squads usam `~/squads/`, `~/businesses/` e `~/businesses/_library/dna/` automaticamente.

```bash
# Listar squads disponíveis globalmente
bun ~/.claude/skills/squads/scripts/index-squads.ts

# Invocar o harness (lê do global)
bun ~/.claude/skills/harness/scripts/route.ts "make me a landing page"
```

### Cenário 2 — projeto isolado (entrega para cliente, ou versionamento)

```bash
# 1. Criar o projeto com a estrutura completa (.agents/skills + symlinks + .nirvana/)
bun ~/.claude/skills/_shared/scripts/init-project.ts ~/Projects/meu-projeto --scope=project

cd ~/Projects/meu-projeto

# 2. Abrir o Glance e usar Setup mode pra escolher o que copiar do global pra .nirvana/
bun ~/.claude/skills/harness/scripts/glance.ts --allow-actions
# (clica no botão de Setup, escolhe squads/businesses/mind-clones, Apply)

# 3. Indexar os locais
bun ~/.claude/skills/squads/scripts/index-squads.ts
bun ~/.claude/skills/businesses/scripts/index-businesses.ts

# 4. Trabalhar normalmente — agora tudo é resolvido a partir de .nirvana/
```

### Cenário 3 — merge (90% global + customizações por projeto)

```bash
bun ~/.claude/skills/_shared/scripts/init-project.ts ~/Projects/cliente-X --scope=merge
cd ~/Projects/cliente-X

# Override de UM squad específico: edite .nirvana/squads/<slug>/
# Tudo o mais continua sendo lido do global ~/squads/, ~/businesses/, etc.
```

---

## Como o sistema resolve o caminho

Cada chamada passa por:

1. **Detect project root** — walk-up procurando primeiro `.env` / `.nirvana/` / `.git/`. Se nada → modo `global` puro.
2. **Read scope** — CLI flag `--scope` > `process.env.NIRVANA_SCOPE` > `<root>/.env` > default `global`.
3. **Build search paths** — em ordem de prioridade conforme o modo (project-only, global-only, ou merge).
4. **Resolve slug** — primeiro hit ganha. Em `merge`, project vence global.

Detalhes completos em [`SCOPE_CONTRACT.md`](./SCOPE_CONTRACT.md).

---

## Para onde olhar quando algo dá errado

| Sintoma                                         | Causa provável                                     | Onde investigar                                  |
|-------------------------------------------------|----------------------------------------------------|--------------------------------------------------|
| "no squads found" em modo project               | `.nirvana/squads/` vazio                            | Use Glance Setup mode pra copiar do global       |
| Mind-clones não aparecem no Setup               | DNA library não montada / symlinks quebrados       | `GET /api/setup/status` → campo `mind_clones_diagnostic` |
| Mind-clone copiado mas inválido                 | Faltam seções 1-10 ou frontmatter incompleto       | `GET /api/mind-clones/validate-all` no Glance    |
| Save em Settings não aplica                     | Bun cacheou `.env` no boot                          | Live-reload já está implementado; se não, restart |
| Scope errado mesmo após editar `.env`           | Process já rodando com env antigo                  | Restart o processo que está consumindo           |

---

## Referências

- [`SCOPE_CONTRACT.md`](./SCOPE_CONTRACT.md) — contrato formal dos 3 modes + verification matrix
- [`templates/project-skeleton/README.md`](./templates/project-skeleton/README.md) — esqueleto que `init-project.ts` materializa
- [`templates/MIND_CLONE_TEMPLATE.md`](./templates/MIND_CLONE_TEMPLATE.md) — template para criar novo mind-clone
- [`schemas/dna.schema.json`](./schemas/dna.schema.json) — schema canônico do frontmatter
- [`lib/scope.ts`](./lib/scope.ts) — implementação do resolver
- [`lib/locale-resolver.ts`](./lib/locale-resolver.ts) — escolha de variante locale
- [`lib/mindclone-validator.ts`](./lib/mindclone-validator.ts) — validador (frontmatter + 10 seções)
- [`scripts/init-project.ts`](./scripts/init-project.ts) — bootstrap de novo projeto
