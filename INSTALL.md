# Installing Nirvana-OS

The engine is free and installs the same way everywhere: macOS, Linux, and Windows.

## Quick install (recommended)

```bash
npx @nirvana-os/cli
```

The launcher fetches the latest engine, ensures Bun is present, and installs it. Nothing else to clone or configure.

## Prerequisites

- **Bun** ≥ 1.0 ([install](https://bun.sh)) — the runtime for everything. The launcher offers to install it if missing.
- **Node** ≥ 18 and `tar` — only so the installer can run via `npx`. (Win10+, macOS, and Linux already ship `tar`.)
- **Python** 3.10+ *(optional)* — only for the opt-in export features (`nrv export --pdf` / `--zip`).
- At least one supported agent CLI:
  - [Claude Code](https://claude.com/claude-code)
  - [Antigravity CLI](https://antigravity.google/docs/cli-features) (binary `agy`) — recommended for Google AI users
  - [Gemini-CLI](https://github.com/google-gemini/gemini-cli) — consumer tier sunsets 2026-06-18, migrate to Antigravity
  - [Codex](https://github.com/microsoft/codex-cli) (optional)

---

## What the installer does

1. Copies `skills/*` to `~/.nirvana/skills/` — the one shared tree every runtime reads.
2. Installs shared deps to `~/.nirvana/node_modules/` and links them into the tree.
3. Copies `nrv`, `nrv-gemini`, and `nrv-hermes` to `~/.local/bin/` (and warns if it is not on `$PATH`).
4. Wires audit hooks into the runtimes it finds:
   - `~/.claude/settings.json` — PreToolUse + PostToolUse for Write/Edit/Bash
   - `~/.gemini/settings.json` — BeforeTool + AfterTool + SessionStart
   - `~/.antigravity/settings.json` — BeforeTool + AfterTool + SessionStart
5. Links the shared tree into every detected runtime (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.antigravity`).
6. Offers the Hermes bridge if the `hermes` CLI is present (opt-in).

The free engine ships no content, so there is no starter pack to copy. Curated packs install separately (see the README).

**Idempotent.** Re-running is safe. Hooks you configured yourself are preserved; the Nirvana hooks are added once.

---

## Install from source (development)

Clone the engine repository, then run the installer with Bun:

```bash
bun scripts/install.ts
```

Useful flags:

```bash
bun scripts/install.ts --check       # status only, exit 0/1, no changes
bun scripts/install.ts --dry         # report what would change, write nothing
bun scripts/install.ts --no-index    # skip registry indexing
bun scripts/install.ts --with-hermes # wire the Hermes bridge non-interactively
```

---

## Verify

```bash
nrv install --check   # exits 0 if ready, 1 if anything is missing
nrv validate          # registry + audit smoke tests
nrv glance            # opens the cockpit at http://localhost:5050
```

---

## Bootstrap your first project

```bash
nrv init ~/projects/my-agentic-project
cd ~/projects/my-agentic-project
claude        # or: agy, gemini, codex
```

`nrv init` scaffolds `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.nirvana/`, and a `briefs/` folder. Any agent launched in this directory discovers the harness skill and routes briefs through it.

---

## Update

```bash
npx @nirvana-os/cli   # re-run to pull the latest engine (idempotent)
```

---

## Uninstall

```bash
nrv uninstall
```

Removes only the hooks Nirvana added; your other settings are preserved (timestamped backups at `~/.claude/settings.json.bak.*` and `~/.gemini/settings.json.bak.*`).

To also wipe runtime data:

```bash
rm -rf ~/.harness-logs/
rm -rf ~/squads/ ~/businesses/    # this deletes your capability library
```

---

## Troubleshooting

**`nrv: command not found`** — `~/.local/bin` is not on `$PATH`. Add `export PATH="$HOME/.local/bin:$PATH"` to your shell rc and open a new terminal.

**`bun: not found`** — install Bun: `curl -fsSL https://bun.sh/install | bash`.

**Hooks not firing in Claude Code** — restart it. Hook config is read at startup.

**Hooks not firing in Gemini-CLI or Antigravity** — run `nrv install --check`. If it reports ready but hooks do not fire, confirm the runtime's `settings.json` is valid JSON.

**Migrating from Gemini-CLI to Antigravity** — install `agy`, then run `agy plugin import gemini` to carry over extensions, commands, and MCP. Skills, hooks, subagents, and MCP all map over; remote MCP servers need the `url` → `serverUrl` rename. The Gemini-CLI consumer tier stops serving requests on 2026-06-18; enterprise continues unchanged.
