# Nirvana Project Skeleton

This is what every Nirvana-scoped project looks like.

> 📖 **Quer entender como project se relaciona com global?** Veja **[../../STRUCTURE.md](../../STRUCTURE.md)** — diagrama lado-a-lado, tabela de paths e os 3 scope modes.

## Layout

```
<project>/
├── .env                  # active config (this project's scope + paths)
├── .env.example          # full reference of every configurable variable
├── .gitignore
├── .agents/skills/       # ← canonical source-of-truth for skill files
├── .claude/skills        # → symlink to .agents/skills (claude-code reads here)
├── .continue/skills      # → symlink to .agents/skills
├── .windsurf/skills      # → symlink to .agents/skills
├── .goose/skills         # → symlink to .agents/skills
├── .kilocode/skills      # → symlink to .agents/skills
├── .roo/skills           # → symlink to .agents/skills
├── .openhands/skills     # → symlink to .agents/skills
├── .qwen/skills          # → symlink to .agents/skills
├── .aider-desk/skills    # → symlink to .agents/skills
└── .nirvana/             # project-scoped data (not skills)
    ├── squads/
    ├── businesses/
    └── mind-clones/
```

## Why this layout

- **`.agents/skills/`** is the universal convention from `skills.sh` (`vercel-labs/skills`). 15+ agents read directly from there: Antigravity, Codex, Cursor, GitHub Copilot, OpenCode, Cline, Replit, Warp, Amp, Gemini CLI, Deep Agents, Firebender, Dexto, Kimi CLI, plus the `universal` profile.
- **Per-agent directories** (`.claude/skills`, `.continue/skills`, etc.) are required by tools that don't use the universal location. They are **symlinks** to `.agents/skills/`, so a single edit propagates everywhere — exactly the same `--copy=false` pattern that `npx skills add` defaults to.
- **`.nirvana/`** is a separate concept from skills. It holds squads/businesses/mind-clones — the **data** that the orchestration skills *operate on*. Setting `NIRVANA_SCOPE=project` in `.env` makes this project blind to anything outside `.nirvana/`.

## Quick start

```bash
# 1. Edit .env to choose scope (default: global)
$EDITOR .env

# 2. Materialize symlinks for every agent (idempotent)
bun ~/.claude/skills/_shared/scripts/init-project.ts --link

# 3. Install or copy specific skills into .agents/skills/
#    Either via skills.sh:
npx skills add vercel-labs/agent-skills --skill frontend-design
#    Or by copying from your global ~/.claude/skills/:
cp -R ~/.claude/skills/businesses .agents/skills/

# 4. (Optional) seed .nirvana/ with project-scoped squads
mkdir -p .nirvana/squads/<slug>
# ...author squad.yaml + agents/ etc.

# 5. Verify
bun ~/.claude/skills/_shared/lib/scope.ts --explain
```

## Three scope modes (set in `.env`)

| `NIRVANA_SCOPE` | Sees ~/squads | Sees `.nirvana/squads` | Override on slug clash |
|---|---|---|---|
| `global`  | ✅ | ❌ | n/a |
| `project` | ❌ | ✅ | n/a |
| `merge`   | ✅ | ✅ | project wins |

See `.env.example` for the full configuration surface (paths, API keys, runtime flags, agent overrides, Stage 6.5 / DAG toggles).
