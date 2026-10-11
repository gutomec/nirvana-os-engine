# Installing Nirvana-OS

The engine is free and installs the same way on macOS, Linux and Windows. Once it is installed you do not drive it by hand: you talk to your agent (Claude Code, Codex, Antigravity, Pi…) and the agent runs Nirvana. The commands on this page are for the install itself and for anyone who wants them.

## Install

macOS and Linux:

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | bash
```

Windows, in PowerShell (native, no WSL):

```powershell
irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
```

The script finds Bun or installs it in user space (`~/.bun`, no sudo, no admin), downloads the latest stable engine release from GitHub, and runs the engine's installer with that Bun. Running it again is safe.

Arguments reach the engine installer on macOS and Linux through `bash -s --`, for example `| bash -s -- --no-index`. `irm | iex` cannot pass arguments.

Open a new terminal when it finishes, so `~/.local/bin` is on your PATH. Then ask your agent to check the install, or run `nrv doctor` yourself.

## Prerequisites

- `curl` or `wget`, and `tar`. macOS, Linux and Windows 10+ ship them.
- **Bun** 1.0 or newer. The installer installs it when it is missing.
- At least one agent CLI: [Claude Code](https://claude.com/claude-code), [Codex](https://github.com/openai/codex), [Antigravity CLI](https://antigravity.google/docs/cli-features) (`agy`), Pi, Kimi, Grok, Qwen Code or OpenCode. Dispatched work runs on the runtime of your session unless you name another.
- **Python** 3.10+ only for squads that declare Python packages, and for the zip that `nrv export` builds.

Node is not needed.

## What the installer does

1. Copies the engine to `~/.nirvana/skills/` and installs the engine's own libraries in `~/.nirvana/node_modules`.
2. Puts `nrv` and `nrv-hermes` in `~/.local/bin` (`.cmd` launchers on Windows) and adds `~/.local/bin` to your PATH: one line in `~/.zshrc`, or `~/.bashrc` and `~/.bash_profile`, plus `~/.profile`; on Windows, the user PATH in the registry.
3. Wires audit hooks into the runtimes it finds:
   - Claude Code: `~/.claude/settings.json` (PreToolUse, PostToolUse);
   - Antigravity: `~/.gemini/config/hooks.json` (a named `nirvana-os` PreInvocation hook that gives each session Nirvana's context; entries an earlier install left in `~/.antigravity/settings.json` are removed);
   - Codex: `~/.codex/hooks.json`, plus a trust record in `~/.codex/config.toml`.
4. Links the `nirvana` skill into every runtime whose folder or binary it finds: `~/.claude/skills`, `~/.codex/skills` (always a copy), `~/.gemini/config/skills` (Antigravity), `~/.pi/agent/skills` and `~/.agents/skills` (OpenClaw). On Windows, or with `--copy-skills`, the entries are copies. A folder of yours with the same name is moved to `~/.nirvana/backups/runtime-skills/`, never deleted.
5. Creates the empty content folders `~/squads`, `~/businesses` and `~/businesses/_library/dna`. It never deletes content.
6. Rebuilds the registries (`nrv index`).
7. Offers the Hermes bridge when the `hermes` CLI is on PATH (or `--with-hermes`).

The engine ships no content. Packs install separately; see [Packs](#packs).

Settings live in `~/.nirvana/config.yaml`, which survives every update. Your agent changes them when you ask; the reference is [docs/configuration.md](docs/configuration.md).

## Verify

Ask your agent *"check that Nirvana-OS is installed correctly"*, or run:

```bash
nrv doctor            # exit 0 healthy, 1 warnings only, 2 something failed
nrv install --check   # hooks and PATH wiring, exit 0 or 1
```

When `nrv doctor` reports `registry: … missing`, run `nrv index`. Do not reinstall because doctor exited non-zero.

## Start a project

Ask your agent *"set up this folder as a Nirvana-OS project"*, or run:

```bash
nrv init ~/projects/my-project     # or, inside an existing folder: nrv init .
```

`nrv init` writes `.nirvana/project.yaml`, a `.env` with the project's library scope (`NIRVANA_SCOPE`), `.env.example`, `.gitignore`, `README.md`, the `.nirvana/{squads,businesses,mind-clones}/` folders, and the project contract in `AGENTS.md`, `CLAUDE.md` and `GEMINI.md`. An existing file keeps your own rules; the Nirvana blocks are appended under markers.

The default contract (`--orchestrators=always`) makes Nirvana the orchestrator of every concrete deliverable in the project. `--orchestrators=on-demand` writes a short note instead, and Nirvana then acts only when the user asks for it by name. Run from an interactive terminal in a folder that already has one of those files, init asks which mode to use and recommends on-demand; run by an agent or a script, it uses `always` unless told otherwise. `--scope=project|merge` decides which library the project sees.

## Packs

1. Buy a pack on [squads.sh](https://squads.sh/pt/packs) and download its zip from your dashboard.
2. Unzip the whole archive into a folder and run its setup there:

   ```bash
   bash setup.sh                                          # macOS / Linux
   powershell -ExecutionPolicy Bypass -File setup.ps1     # Windows
   ```

   Both launchers install Bun when it is missing and pass their arguments on to `setup.ts`. Setup installs the engine when it is absent and otherwise updates it on its release channel, copies the content to `~/squads/<pack>`, `~/businesses/<pack>` and `~/businesses/_library/dna/<pack>`, rebuilds the indexes, and installs the license in `~/.nirvana-license/packs/<pack>/` (and in the single `~/.nirvana-license/PROVENANCE.json` older engines read). Set `NIRVANA_SKIP_ENGINE_UPDATE=1` to leave the engine as it is.
3. Talk to your agent, naming the pack, a business or a squad.

To update a pack, ask your agent or run `nrv update <pack>` (`--check` compares versions only; `--keep-clones`, `--keep-squads` or `--keep-businesses` leave what is on disk). It reads that pack's own license, downloads the current version and applies it over the installed one. Components you edited are backed up under `~/.nirvana/backups/packs/<pack>/<stamp>/` first. If it fails with a license error, download the pack again from squads.sh and run its setup; that reinstalls the license too. `nrv license install <pack-folder>` installs only the license.

## Squad dependencies

Each squad has its own environment in `~/.nirvana/envs/<squad>/`, with the Node and Python packages its `dependencies.yaml` declares, versions as written. A squad's first dispatch prepares it; later dispatches reuse it in milliseconds. To prepare everything ahead of time, ask your agent to install the dependencies of all your squads (`nrv activate --all`). System programs such as `ffmpeg` come from your package manager; when one is missing, `nrv activate` prints the command and says it needs your permission.

## Update

Ask your agent to update Nirvana-OS, or run:

```bash
nrv update            # back up ~/.nirvana/skills, install the newer release, keep settings and content
nrv update --check    # name the release it would install, change nothing
```

An update never installs an older or equal release. A stable engine moves to the newest greater stable; a prerelease moves to the newest greater release, prerelease or stable. Pack setups follow the same rule. After an engine update, `nrv update` checks every installed pack that has a license.

If an update goes wrong, the previous skills are in `~/.nirvana/skills-backup-<stamp>`, and `nrv update` prints the command that restores them.

## Betas and pinned versions

The one-liner installs the latest stable. To install a specific release, a beta included, point `NIRVANA_ENGINE_URL` at its tarball:

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | NIRVANA_ENGINE_URL=https://github.com/gutomec/nirvana-os-engine/releases/download/v<version>/nirvana-os-engine.tar.gz bash
```

```powershell
$env:NIRVANA_ENGINE_URL = "https://github.com/gutomec/nirvana-os-engine/releases/download/v<version>/nirvana-os-engine.tar.gz"
irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
Remove-Item Env:NIRVANA_ENGINE_URL
```

The tag carries a leading `v` (`v0.15.0-beta.5`); without it GitHub answers 404. The releases are listed at [github.com/gutomec/nirvana-os-engine/releases](https://github.com/gutomec/nirvana-os-engine/releases). While `NIRVANA_ENGINE_URL` is set, `nrv update` and pack setups install that tarball, which is why the PowerShell form removes the variable afterwards. `NIRVANA_ENGINE_TARBALL=<file>` installs from a local tarball, offline.

A beta stays on the beta channel: `nrv update` moves it to newer betas and then to the stable release that follows them. To return to stable now, run the plain one-liner: it installs the latest stable over the beta and keeps your content and settings.

## Other ways in

**The `nirvana` skill through skills.sh.** `npx skills add gutomec/nirvana-os-engine -g` installs only the `nirvana` skill into the agents skills.sh detects (on Windows, add `--copy` when symlinks are not enabled). On first use, when `nrv` is missing, the skill explains what will change, asks, and runs its own `scripts/bootstrap.sh` (`bootstrap.ps1` on Windows), which installs Bun and the engine release. skills.sh updates its copy of the skill with `npx skills update`; `nrv update` updates the engine.

**From a clone (development).**

```bash
bun scripts/install.ts                 # install from this checkout
bun scripts/install.ts --check         # status only, exit 0/1, no changes
bun scripts/install.ts --dry           # report what would change, write nothing
bun scripts/install.ts --no-index      # skip registry indexing
bun scripts/install.ts --with-hermes   # wire the Hermes bridge non-interactively
bun scripts/install.ts --copy-skills   # copy the skill into runtimes instead of linking
```

## Uninstall

```bash
nrv uninstall --engine   # remove the engine, its hooks, runtime entries and nrv; keep your content
nrv uninstall --hooks    # remove only the audit hooks
```

`--engine` keeps `~/squads`, `~/businesses`, `~/.nirvana/packs/`, `~/.nirvana-license/` and `~/.harness-logs/`. To remove content too, delete those folders yourself; `~/squads` and `~/businesses` are your library.

## Windows: the user PATH

On Windows the installer adds `%USERPROFILE%\.local\bin` to the **user** PATH in the registry (`HKCU\Environment\Path`) and broadcasts the change, so `nrv` resolves in new terminals without a logoff. Two things keep that write from landing where it should not:

- **`NIRVANA_SKIP_PATH_PERSIST=1`** skips the registry write and the broadcast (and the shell-profile append on macOS and Linux). The current process still gets `.local\bin` on its own PATH. The engine tests set it whenever they install into a temporary HOME.
- **A temporary HOME is never persisted.** When `%USERPROFILE%\.local\bin` resolves under `%TEMP%`, `%TMP%`, `%LOCALAPPDATA%\Temp` or the process tmpdir, the installer says so and leaves the registry alone, flag or not.

Engines up to 0.8.0 had neither, and running the test suite on Windows left `%TEMP%\nrv-*\home\.local\bin` entries on the real user PATH (issue #87). `nrv doctor` reports them. To remove them:

```bash
nrv install --repair-path          # lists the temporary nrv-* entries, writes nothing
nrv install --repair-path --apply  # removes exactly those, keeps every other entry and its order
```

The repair rewrites the value with the kind it had (a `REG_EXPAND_SZ` stays unexpanded) and broadcasts `WM_SETTINGCHANGE`. Open a new terminal to see the clean PATH.

## Troubleshooting

**`nrv: command not found`.** `~/.local/bin` is not on the PATH of this terminal. Open a new one; if it is still missing, add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile.

**`bun: not found`.** Install Bun with `curl -fsSL https://bun.sh/install | bash` (Windows: `powershell -c "irm bun.sh/install.ps1 | iex"`) and open a new terminal.

**The download returns 404.** A pinned `NIRVANA_ENGINE_URL` is missing the `v` before the version, or names a release that does not exist.

**Hooks not firing in Claude Code.** Restart it; hook configuration is read at startup.

**Hooks not firing in Antigravity.** Run `nrv install --check`. If it reports ready and hooks still do not fire, check that `~/.gemini/config/hooks.json` is valid JSON.

**You used the Gemini CLI with Nirvana.** The Gemini CLI is no longer a supported runtime. The next install or update takes Nirvana's hooks out of `~/.gemini/settings.json` and its skill link out of `~/.gemini/skills`, and leaves everything else in them alone. A setting, a `USE_GEMINI` rule or an `LLM_CASCADE` entry that still names `gemini-cli` is skipped with "Gemini CLI is no longer supported; pick another runtime", and the next runtime takes over. Gemini models stay available through Antigravity (`agy`).

**A squad fails on a missing package or program.** Ask your agent to activate that squad (`nrv activate <squad>`). It lists each failure with the command that fixes it.
