# Nirvana Structure — Global vs Project

> **TL;DR.** You have **two parallel hierarchies**: the **global** one (in your HOME), which serves any project, and the **project** one (inside each project), which isolates data when you want. The `scope` in each project's `.nirvana/project.yaml` decides which one the system reads (the `NIRVANA_SCOPE` env var overrides it).

This document is the visual reference. For the legal details of the contract:
- Modes (`global`/`project`/`merge`) and the override rule → [`SCOPE_CONTRACT.md`](./SCOPE_CONTRACT.md)
- Mind-clone schema (frontmatter + 10 sections) → [`templates/MIND_CLONE_TEMPLATE.md`](./templates/MIND_CLONE_TEMPLATE.md) and [`schemas/dna.schema.json`](./schemas/dna.schema.json)
- Bootstrap of a new project → [`templates/project-skeleton/README.md`](./templates/project-skeleton/README.md)

---

## Side-by-side view

```
┌──────────────────────────── GLOBAL  (your HOME) ─────────────────────────────┐
│  ~/                                                                          │
│  ├── .env                          ← global config (models, API keys, etc)  │
│  ├── .claude/                                                                │
│  │   ├── skills/                   ← 50+ official skills (harness, squads,  │
│  │   │   ├── _shared/                businesses, …) — never duplicate       │
│  │   │   ├── harness/                                                        │
│  │   │   ├── squads/                                                         │
│  │   │   └── businesses/                                                     │
│  │   ├── agents/                   ← auto-discovered agents                 │
│  │   ├── plugins/                                                            │
│  │   └── settings.json             ← Claude Code runtime config             │
│  │                                                                           │
│  ├── squads/                       ← GLOBAL squad library                   │
│  │   ├── alex-data-explorer/                                                 │
│  │   ├── adaptive-tutor-k12/                                                 │
│  │   └── … (153 today)                                                       │
│  │                                                                           │
│  ├── businesses/                   ← GLOBAL business library                │
│  │   ├── _library/                                                           │
│  │   │   └── dna/                  ← DNA library (canonical mind-clones)    │
│  │   │       ├── 01-marketing-copy-vendas/                                   │
│  │   │       │   ├── alex-hormozi.md       ← canonical                      │
│  │   │       │   ├── alex-hormozi.en.md    ← locale variant                 │
│  │   │       │   └── …                                                       │
│  │   │       └── … (61 categories, 408 mind-clones)                          │
│  │   ├── ads-intelligence/                                                   │
│  │   ├── agency-hq/                                                          │
│  │   └── … (32 today)                                                        │
│  │                                                                           │
│  ├── .squads-registry.json         ← cache: squad index                     │
│  ├── .businesses-registry.json     ← cache: business index                  │
│  ├── .harness-logs/                ← harness execution logs                 │
│  └── .claude/squads-state/         ← per-squad SQLite state (global mode)   │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────── PROJECT  (any project) ─────────────────────────────┐
│  /Users/<you>/Projects/<project-name>/                                      │
│  ├── .nirvana/project.yaml         ← PROJECT identity + scope               │
│  │     scope: project   →  isolated (only sees .nirvana/)                   │
│  │     scope: merge     →  sees both (project overrides)                    │
│  │     scope: global    →  global only (default; .nirvana/ ignored)         │
│  │                                                                           │
│  ├── .agents/skills/               ← canonical "skills.sh" (15+ runtimes    │
│  │                                   read it directly: Codex, Cursor,       │
│  │                                   OpenCode, Cline, Gemini CLI, Warp,     │
│  │                                   Amp, …)                                │
│  ├── .claude/skills        ─────→ symlink → ../.agents/skills              │
│  ├── .continue/skills      ─────→ symlink → ../.agents/skills              │
│  ├── .windsurf/skills      ─────→ symlink → ../.agents/skills              │
│  └── …  (35+ symlinks via init-project.ts)                                  │
│                                                                              │
│  └── .nirvana/                     ← DATA scoped to the project             │
│      ├── README.md                                                           │
│      ├── squads/                   ← this project's own squads              │
│      │   ├── adaptive-tutor-k12/                                             │
│      │   └── …                                                               │
│      ├── businesses/               ← its own businesses                     │
│      │   ├── api-development/                                                │
│      │   └── …                                                               │
│      ├── mind-clones/              ← mind-clones COPIED from global         │
│      │   ├── 01-marketing-copy-vendas/                                       │
│      │   │   ├── alex-hormozi.md                                             │
│      │   │   └── alex-hormozi.en.md                                          │
│      │   └── …                                                               │
│      ├── outputs/                  ← artifacts generated by squads          │
│      └── state/                    ← SQLite state local to the project      │
│          └── squads/                                                         │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Equivalence table

| Concept                     | GLOBAL                                       | PROJECT                                            | Env var override                |
|-----------------------------|----------------------------------------------|----------------------------------------------------|---------------------------------|
| Skills (code)               | `~/.nirvana/skills/`                          | `<proj>/.agents/skills/` (+ symlinks)              | `CLAUDE_SKILLS_DIR`             |
| Squads                      | `~/squads/`                                  | `<proj>/.nirvana/squads/`                          | `SQUADS_DIR`, `NIRVANA_PROJECT_SQUADS_DIR` |
| Businesses                  | `~/businesses/`                              | `<proj>/.nirvana/businesses/`                      | `BUSINESSES_DIR`, `NIRVANA_PROJECT_BUSINESSES_DIR` |
| Mind-clones (DNA library)   | `~/businesses/_library/dna/`                 | `<proj>/.nirvana/mind-clones/`                     | `DNA_LIBRARY`, `NIRVANA_PROJECT_MIND_CLONES_DIR` |
| Squads registry (cache)     | `~/.squads-registry.json`                    | regenerated in project mode                        | `SQUADS_REGISTRY_PATH`          |
| Businesses registry (cache) | `~/.businesses-registry.json`                | regenerated in project mode                        | `BUSINESSES_REGISTRY_PATH`      |
| Harness logs                | `~/.harness-logs/`                           | `~/.harness-logs/` (shared)                        | `HARNESS_LOGS_DIR`              |
| Squad state (SQLite)        | `~/.claude/squads-state/`                    | `<proj>/.nirvana/state/squads/`                    | `NIRVANA_STATE_DIR`             |
| Outputs                     | (not applicable)                             | `<proj>/.nirvana/outputs/`                         | `PROJECTS_OUTPUT_DIR`           |
| Project root detection      | (n/a)                                        | walk up to `.env` / `.nirvana` / `.git`            | `NIRVANA_PROJECT_ROOT`          |

---

## The 3 scope modes: what each one sees

| Mode      | Visible squads/businesses                           | Mind-clones                       | When to use                                                  |
|-----------|-----------------------------------------------------|-----------------------------------|--------------------------------------------------------------|
| `global`  | only `~/squads/*` and `~/businesses/*`              | only `~/businesses/_library/dna/` | Default; every project shares the library                    |
| `project` | only `<proj>/.nirvana/squads/*` and `…/businesses/*`| only `<proj>/.nirvana/mind-clones/` | Client handoff: must be portable and self-contained        |
| `merge`   | union (project overrides global by slug)            | union (project overrides)         | Local customization without losing what is in the global     |

Override rule (`merge` mode): if the same slug exists in both, **the project wins**. Use `NIRVANA_GLOBAL_INCLUDE_ONLY` or `NIRVANA_GLOBAL_EXCLUDE` in `.env` to filter globals when in merge.

---

## Mind-clones: how the canonical format works

Each mind-clone is a **single, self-contained `.md` file**, valid on any machine.

**Location (global):** `~/businesses/_library/dna/<category>/<slug>.md`
The category follows the pattern `^[0-9]{2}-[a-z][a-z0-9-]+$` (e.g. `01-marketing-copy-vendas`).

**Locale variants:** parallel files `<slug>.<locale>.md` (e.g. `alex-hormozi.en.md`, `alex-hormozi.pt.md`). The resolver (`locale-resolver.ts`) picks the appropriate one by preference.

**Required frontmatter** (validated against [`schemas/dna.schema.json`](./schemas/dna.schema.json)):

```yaml
---
name: alex-hormozi              # kebab-case, must match the file name
description: "Use when … Use for: … Do NOT use for: …"   # ≥40 chars
model: inherit                    # haiku | sonnet | opus | inherit
maxTurns: 40                     # 1..200
tools: [Read, Write, Grep, …]    # non-empty array
---
```

**Required body:** all 10 canonical sections (`## 1.` through `## 10.`):

```
## 1. PHILOSOPHY           ## 6. VOICE & PERSONALITY
## 2. MENTAL MODELS        ## 7. PLAYBOOKS
## 3. HEURISTICS           ## 8. INVOCATION TRIGGERS
## 4. FRAMEWORKS           ## 9. SOURCES & TRACEABILITY
## 5. METHODOLOGIES        ## 10. USAGE PROTOCOL
```

Ready-to-copy skeleton: [`templates/MIND_CLONE_TEMPLATE.md`](./templates/MIND_CLONE_TEMPLATE.md).

**Validation:** the Setup mode copy (Glance) **validates before copying**. A malformed mind-clone is rejected with error `SECTIONS_MISSING` or `NAME_PATTERN`. Audit with `GET /api/mind-clones/validate-all` (in Glance) or via the CLI.

---

## Quickstart

### Scenario 1: global-only user (no per-project isolation)

This is the default path. You do not need to do anything: every project where you invoke the harness/squads uses `~/squads/`, `~/businesses/` and `~/businesses/_library/dna/` automatically.

```bash
# List the squads available globally
bun ~/.nirvana/skills/squads/scripts/index-squads.ts

# Invoke the harness (reads from global)
bun ~/.nirvana/skills/harness/scripts/route.ts "make me a landing page"
```

### Scenario 2: isolated project (client handoff, or versioning)

```bash
# 1. Create the project with the full structure (.agents/skills + symlinks + .nirvana/)
bun ~/.nirvana/skills/_shared/scripts/init-project.ts ~/Projects/my-project --scope=project

cd ~/Projects/my-project

# 2. Open Glance and use Setup mode to choose what to copy from global into .nirvana/
bun ~/.nirvana/skills/harness/scripts/glance.ts --allow-actions
# (click the Setup button, choose squads/businesses/mind-clones, Apply)

# 3. Index the local ones
bun ~/.nirvana/skills/squads/scripts/index-squads.ts
bun ~/.nirvana/skills/businesses/scripts/index-businesses.ts

# 4. Work normally: now everything is resolved from .nirvana/
```

### Scenario 3: merge (90% global + per-project customizations)

```bash
bun ~/.nirvana/skills/_shared/scripts/init-project.ts ~/Projects/client-X --scope=merge
cd ~/Projects/client-X

# Override ONE specific squad: edit .nirvana/squads/<slug>/
# Everything else keeps being read from global ~/squads/, ~/businesses/, etc.
```

---

## How the system resolves the path

Each call goes through:

1. **Detect project root**: walk up looking first for `.env` / `.nirvana/` / `.git/`. If nothing is found → pure `global` mode.
2. **Read scope**: CLI flag `--scope` > `process.env.NIRVANA_SCOPE` > `scope` in `<root>/.nirvana/project.yaml` > `NIRVANA_SCOPE` in a legacy `.env` > default `global`.
3. **Build search paths**: in priority order according to the mode (project-only, global-only, or merge).
4. **Resolve slug**: the first hit wins. In `merge`, the project beats global.

Full details in [`SCOPE_CONTRACT.md`](./SCOPE_CONTRACT.md).

---

## Where to look when something goes wrong

| Symptom                                         | Probable cause                                     | Where to investigate                             |
|-------------------------------------------------|----------------------------------------------------|--------------------------------------------------|
| "no squads found" in project mode               | `.nirvana/squads/` empty                           | Use Glance Setup mode to copy from global        |
| Mind-clones do not show up in Setup             | DNA library not mounted / broken symlinks          | `GET /api/setup/status` → `mind_clones_diagnostic` field |
| Mind-clone copied but invalid                   | Sections 1-10 missing or incomplete frontmatter    | `GET /api/mind-clones/validate-all` in Glance    |
| Saving in Settings does not apply               | Bun cached `.env` at boot                          | Live-reload is already implemented; if not, restart |
| Wrong scope even after editing the manifest     | An exported `NIRVANA_SCOPE` in the environment wins | `unset NIRVANA_SCOPE` or use `--scope`          |

---

## References

- [`SCOPE_CONTRACT.md`](./SCOPE_CONTRACT.md): formal contract of the 3 modes + verification matrix
- [`templates/project-skeleton/README.md`](./templates/project-skeleton/README.md): skeleton that `init-project.ts` materializes
- [`templates/MIND_CLONE_TEMPLATE.md`](./templates/MIND_CLONE_TEMPLATE.md): template for creating a new mind-clone
- [`schemas/dna.schema.json`](./schemas/dna.schema.json): canonical frontmatter schema
- [`lib/scope.ts`](./lib/scope.ts): resolver implementation
- [`lib/locale-resolver.ts`](./lib/locale-resolver.ts): locale variant choice
- [`lib/mindclone-validator.ts`](./lib/mindclone-validator.ts): validator (frontmatter + 10 sections)
- [`scripts/init-project.ts`](./scripts/init-project.ts): bootstrap of a new project
