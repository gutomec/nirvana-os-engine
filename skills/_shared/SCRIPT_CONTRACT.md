# Nirvana Script Contract

> **Bash (`.sh`) is no longer accepted in this system.** All scripts must be Bun TypeScript (`.ts`). Bun is OS-agnostic AND agent-runtime-agnostic (Claude Code / Codex / Gemini CLI / Cursor / Antigravity all run identical `.ts` code). New `.sh` files are forbidden; existing ones are tracked for removal — see "Legacy debt" section below.

This is the system-wide contract every script in the Nirvana framework (skills/businesses, skills/squads, skills/harness, skills/_shared, business-nirvana-maestro) must obey. The contract exists so the system runs identically across:

- macOS (default zsh user shell)
- Linux distros (Ubuntu, Debian, Fedora, Arch — bash 4+)
- Alpine / minimal Docker images (no zsh, sometimes only `ash`)
- Antigravity sandbox (PATH may be reduced; no `/bin/zsh`)
- Replit, Codespaces, Cloud Shell
- BSD-derived systems

If the contract is violated anywhere in the codebase, an automation agent (Antigravity, Claude Code agent runtime, etc.) may see opaque "fork/exec" failures, exit 1 with no log, or silent fallbacks that look like success.

## The four rules

### 1. Portable shebang (mandatory)

Every `*.sh` file must start with one of:

```bash
#!/usr/bin/env bash
#!/usr/bin/env sh
#!/usr/bin/env zsh    # very rare; only for scripts that genuinely require zsh features
```

Never `#!/bin/bash`, `#!/bin/zsh`, `#!/usr/local/bin/bash`. The shebang `/bin/zsh` is the canonical failure mode that broke Antigravity (`fork/exec /bin/zsh: no such file or directory`).

If a script uses bash-only syntax (`[[ ]]`, arrays, `${VAR,,}`, `<<<`, process substitution `<()`), it MUST use `env bash`. POSIX-only `env sh` is acceptable when the script truly is portable across `bash`/`dash`/`ash`.

Enforcement: `bun ~/.claude/skills/_shared/tests/portability-smoke.ts` (run with `--include-squads` to widen scope to user squads). The squad validator (`validate-squad.ts`) emits a warning on non-portable shebangs.

### 2. No interactive stdin reads (mandatory in framework)

Framework scripts must be deterministic — no `read VAR`, `read -p`, `select` menus, or anything that blocks waiting for terminal input. Wizard-style flows (asking the user questions) belong in the SKILL.md layer via the Claude Code `AskUserQuestion` tool, NOT in bash.

Why: an automation agent piping `bash script.sh < /dev/null` will hang. A non-tty environment (cron, CI, Docker) will hang. The clear separation is:

- **bash scripts** → deterministic scaffolding / install / validation. Take flags + env vars. Return structured exit codes.
- **SKILL.md** → conversational logic. Uses `AskUserQuestion`. Calls bash scripts with the user's answers as flags.

User squads (`~/squads/<slug>/scripts/`) MAY have interactive scripts but if so they should also expose a `--non-interactive` mode that takes flags.

### 3. Two-mode contract for any script that takes user input

If a script CAN run interactively (squad-level, user-authored), it MUST expose:

```
script.sh                          # interactive mode (default; may prompt or delegate to wizard)
script.sh --non-interactive ...    # flags-only, fail loudly if anything is missing
script.sh --from-json <path> ...   # one-shot mode, accept full spec from JSON
```

When `--non-interactive` or `--from-json` is set, the script MUST:
- Never prompt
- Never silently fall back ("template not found, using solo as base" is forbidden — fail with a clear error and list available options)
- Return non-zero with a structured error message

### 4. Structured exit codes

| Exit code | Meaning |
|-----------|---------|
| `0` | Success |
| `1` | Failures present (one or more documented operations failed) |
| `2` | Confirmation required (heavy install, sudo, destructive action) — caller must re-run with `--confirm-*` |
| `4` | Invalid args / required input missing / unknown subcommand |
| `64` | Reserved for legacy CLI usage errors |
| Anything else | Unexpected — bug |

Scripts should print a one-line summary to stderr after the JSON output (the JSON stays clean on stdout for piping). Suppressed by `--quiet` / `-q` for fully machine-driven invocations.

### 5. Verbose logging plumbed

Long-running scripts (install, build, dispatch) should support `--verbose` / `-v` that streams sub-process output in real time. Without `--verbose`, output should stay captured (so JSON on stdout is parseable). With `--verbose`, the user sees `brew install ffmpeg` progress, `git clone` percentage, `pip install` resolver chatter — exactly what an agent needs to diagnose mid-install hangs.

## Rationale

This contract was written after an Antigravity run failed with `fork/exec /bin/zsh: no such file or directory` on `index-businesses.ts`, and another run reported "exit 1 with no log" from `activate-squad.ts`. The audit (3 parallel Explore agents) found:

- 22 scripts with non-portable shebangs (now patched).
- The activator engine (`activator.js`) was always exiting 0 regardless of failures (now fixed to return 0/1/2/4).
- No script in the framework was actually mixing interactive prompts with deterministic logic — that risk turned out to be a false alarm. The contract is documented to keep it that way.

## Reference utilities

- `~/.claude/skills/_shared/scripts/paths.sh` — sourced by every wrapper for portable env vars (`SQUADS_DIR`, `BUSINESSES_DIR`, `MAESTRO_DIR`, etc.).
- `~/.claude/skills/_shared/tests/portability-smoke.ts` — scans for non-portable shebangs.
- `~/.claude/skills/squads/scripts/validate-squad.ts` — warns on shebang violations during validation.
- `~/.claude/skills/squads/lib/activator.js` — reference implementation of the exit-code contract + `--verbose` plumbing.
- `~/.claude/skills/businesses/scripts/init-business.ts` — reference implementation of the two-mode contract (`--template` + `--from-json` + `--non-interactive`).

## When in doubt

Read these implementations as canonical references and copy their structure. The contract is a guarantee to automation agents that any framework script can be invoked reliably from a sandbox, container, or CI runner.

---

## Cross-platform: Bun + Windows native support

The Nirvana framework is migrating from `.sh` to **Bun TypeScript** (`.ts`) for its scripts to support **Windows native** (cmd.exe / PowerShell), Antigravity sandbox, Alpine Docker, and any environment without `/bin/bash`.

### File pattern (per script)

Every framework script ships in three flavors:

| File | Used by | What it does |
|---|---|---|
| `<name>.ts` | All platforms (canonical) | Real implementation. Run via `bun <name>.ts ...` |
| `<name>.sh` | macOS / Linux / WSL / Git Bash callers | One-line delegator that forwards to `_shared/lib/_delegator.sh` which finds the sibling `.ts` and runs it under Bun (or Node 22+ as fallback) |
| `<name>.cmd` | Windows native (cmd.exe / PowerShell) | Forwards to Bun on `%PATH%`; falls back to `node --experimental-strip-types`; reports a clear error if neither is installed |

A user on Windows runs:
```cmd
.claude\skills\squads\scripts\activate-squad.cmd activate brandcraft
```
And it works exactly like the `.sh` would on Linux/macOS.

### Runtime priority

The `.sh` delegator and `.cmd` wrapper both prefer Bun. Falls back to Node 22+ (which supports `--experimental-strip-types` for `.ts` execution natively). Reports a clear install command if neither is found.

### Install commands

| OS | Bun (recommended) | Node 22+ (fallback) |
|---|---|---|
| macOS / Linux | `curl -fsSL https://bun.sh/install \| bash` | `brew install node@22` / `apt install nodejs` |
| Windows | `powershell -c "irm bun.sh/install.ps1 \| iex"` | https://nodejs.org/en/download |
| Docker / CI | `RUN curl -fsSL https://bun.sh/install \| bash` | official `node:22-alpine` image |

### Bash prohibition (2026-05-04 onwards)

**New rule:** `.sh` files are forbidden in this system. Every script must be `.ts` (Bun runtime). Rationale:

- **OS-agnostic**: Bun runs identically on macOS, Linux, Windows, WSL2, Alpine. No `bash` dependency on Windows. No subtle differences between `bash` 3.2 (macOS default) and 5.x.
- **Agent-runtime-agnostic**: Bun scripts run unchanged whether the host is Claude Code, Codex, Gemini CLI, Cursor, Antigravity, or any other runtime that has Bun on PATH.
- **One language**: TS is the canonical language for libs (`*.js`/`*.ts`), validators (`validators.ts`), tests (`*.test.ts`). Removing `.sh` removes a parallel world.
- **No more `_delegator.sh`**: the bridge between `.sh` callers and `.ts` implementations is no longer needed. `.cmd` Windows wrappers stay (they're 5 lines and pure passthrough).

What `.sh` files looked like:
- 1-line delegators: `exec bash _delegator.sh "$0" "$@"` — DELETED (paired `.ts` is invoked directly)
- Smokes: real bash test logic — REPLACED with `.ts` equivalents
- `_delegator.sh`, `paths.sh`, `portability-smoke.ts`: support infra — DELETED (no longer needed)

### Legacy debt (10 `.sh` files still pending conversion)

These exist for backward compatibility while their `.ts` replacements are authored. **Do not extend them** — convert or delete:

| File | Lines | Replacement plan |
|---|---|---|
| `squads/scripts/validate-squad.ts` | 194 | rewrite as `.ts` calling Pydantic validators directly |
| `squads/scripts/activate-squad.ts` | 5 | delete (the .ts wrapper handles everything) |
| `squads/scripts/init-squad.ts` | 154 | port to `init-squad.ts` |
| `squads/lib/migrate-batch-orchestrator.ts` | 121 | port to `migrate-batch-orchestrator.ts` |
| `businesses/scripts/init-business.ts` | 199 | port to `init-business.ts` |
| `businesses/scripts/brief-business.ts` | 125 | port to `brief-business.ts` |
| `businesses/tests/smoke.ts` | 60 | port to `smoke.ts` |
| `harness/tests/smoke.ts` | 102 | port to `smoke.ts` |
| `squads/tests/smoke-v5.ts` | 131 | port to `smoke-v5.ts` |
| `business-nirvana-maestro/tests/smoke.ts` | 107 | port to `smoke.ts` |

Already eliminated (this session): `_delegator.sh`, `paths.sh`, `portability-smoke.ts`, 27 1-line delegators in scripts/, `audit-batch-orchestrator.ts`, `scope-isolation-smoke.ts`, `glance-smoke.ts`. **Total `.sh` in repo dropped from 43 → 10.**

### Migration status (2026-05) — COMPLETE

- ✅ **Phase 1 — Framework core (15 scripts)**: `activate-squad`, `index-squads`, `index-businesses`, `list-squads`, `list-businesses`, `validate-business`, `inspect-business`, `find` (harness), `route` (harness), `index` (harness), `validate` (harness), `audit-content` (maestro), `dag-status` (maestro), `check-handoff` (maestro), `enforce-output` (maestro).
- ✅ **Phase 2 — Maestro complex (9 scripts)**: `audit-wave`, `check-all-handoffs`, `rebuild-dna-symlinks`, `discover-portfolio`, `draft-project-plan`, `synthesize-outputs`, `execute-project`, `enable-max-power`, `disable-max-power`.
- ✅ **Phase 3 — User squad scripts (13 scripts)**: instagram-intelligence-nirvana/`collect-all-profiles`, nirvana-ai-trading/`start-channels` + `test-channels`, nirvana-crypto-trading/`start-channels` + `test-channels`, nirvana-visualizer-squad/`setup`, paperclip-command-center/`upgrade-to-v6` + `auto-setup` + `paperclip-api` + 2 vendored, visual-law-transformer/`pdf-to-png` + `validate-output`.
- ✅ **`paths.sh` stays as bash**. It's `source`-d by other shell scripts to set parent-shell env vars; that pattern can't be replaced by Bun (which is a separate process). The companion `paths.js` already covers the JS/TS use case.
- ✅ **Smoke tests** (`tests/smoke.ts` in each skill) stay as bash — they orchestrate many sub-scripts and bash is fine when run from a Unix shell.

**Total**: 37 scripts migrated to Bun TypeScript, each with `.ts` (canonical) + `.sh` (Unix delegator) + `.cmd` (Windows native) entry points. 100% cross-platform: macOS / Linux / Windows native (cmd.exe / PowerShell) / WSL2 / Alpine Docker / Antigravity sandbox.

### When migrating a new script

```bash
# 1. Write the .ts using shared helpers
#    Import: ../../_shared/lib/bun-helpers.ts
#    Use: paths.SQUADS_DIR, exec(), parseArgs(), EXIT.OK / EXIT.FAILURES / EXIT.CONFIRMATION_REQUIRED / EXIT.INVALID_ARGS
# 2. Replace the .sh content with the delegator one-liner:
#    exec bash "${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/_shared/lib/_delegator.sh" "$0" "$@"
# 3. Add a .cmd next to it (copy the template from any existing .cmd in the framework)
# 4. Smoke: `bun <name>.ts <typical args>` and `bash <name>.sh <typical args>` produce identical output
```

The shared helper `~/.claude/skills/_shared/lib/bun-helpers.ts` provides `paths`, `exec`, `parseArgs`, `EXIT`, `commandExists`, `readJson`, `writeJson`, `ensureDir`, `expandPath`, `log`. Use them — they are the canonical cross-platform primitives.

### Scope awareness for new scripts

Any new loader (lists / reads / scans squads, businesses, or mind-clones) MUST honor `NIRVANA_SCOPE`. Use the resolver:

```ts
import { resolveScope, enumerate } from "../../_shared/lib/scope.ts";
const scope = resolveScope();                        // reads <project>/.env + cwd walk
const entries = enumerate(scope, "squads");          // [{slug, dir, source, overridden?}]
```

Or, for path-only needs, just read `paths.SQUADS_REGISTRY_PATH` / `paths.SQUADS_STATE_DIR` / etc. — `paths.js` is already scope-aware. Subprocess writes that target a specific scope must inherit `NIRVANA_STATE_DIR` / `NIRVANA_RESOLVED_SQUAD_PATH` via the env passed to `exec()`. Full contract: `SCOPE_CONTRACT.md` (sibling).
