# Installing Nirvana-OS

The engine is free and installs on macOS, Windows (PowerShell), Windows with WSL (Ubuntu) and Linux. Once it is installed you do not drive it by hand: you talk to your AI agent (Claude Code, Codex, Antigravity, Pi…) and the agent runs Nirvana-OS. The commands on this page are for the install itself, and for anyone who wants them.

The illustrated guide, in Portuguese, with a tab per system, is at [gutomec.github.io/nirvana-os-engine/install.html](https://gutomec.github.io/nirvana-os-engine/install.html).

There are two release channels:

| Channel | Version | Who it is for |
|---|---|---|
| Stable | 0.14.11 | everyone; the one-liner installs it |
| Beta | `v0.15.0-beta.7` | people who want the 0.15 changes now (see [Install a beta](#install-a-beta)) |

## Before you start

| System | What you need |
|---|---|
| macOS | nothing; `curl` and `tar` ship with it |
| Windows (PowerShell) | Windows 10 or 11. No administrator rights |
| Windows with WSL | WSL with Ubuntu (see [Windows with WSL](#windows-with-wsl-ubuntu)), then the Ubuntu line below, inside Ubuntu |
| Linux (Ubuntu) | `sudo apt update && sudo apt install -y curl unzip` |

On Ubuntu and WSL, `unzip` is needed by the Bun installer and to open pack zips. On every system the installer installs [Bun](https://bun.sh) in your user folder when it is missing (`~/.bun`, no sudo, no admin). Node is not needed.

You also need at least one agent CLI: [Claude Code](https://claude.com/claude-code), [Codex](https://github.com/openai/codex), [Antigravity CLI](https://antigravity.google/docs/cli-features) (`agy`), Pi, Kimi, Grok, Qwen Code or OpenCode. Python 3.10+ only matters for squads that declare Python packages, and for the zip that `nrv export` builds.

## Install the stable engine

macOS, Linux and WSL:

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | bash
```

Windows, in PowerShell:

```powershell
irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
```

The script finds Bun or installs it, downloads the latest stable engine release from GitHub, and runs the engine's installer with that Bun. Running it again is safe.

**Close the terminal and open a new one** when it finishes, so `~/.local/bin` is on your PATH. Then check:

```bash
nrv --version
```

Arguments reach the engine installer on macOS, Linux and WSL through `bash -s --`, for example `| bash -s -- --no-index`. `irm | iex` cannot pass arguments.

## Install a beta

Betas are GitHub prereleases. The one-liner above always installs the latest stable, so a beta is installed by pointing `NIRVANA_ENGINE_URL` at its tarball. The current beta is **`v0.15.0-beta.7`**. The tag has a leading `v`; without it GitHub answers 404. To install a newer beta later, replace `v0.15.0-beta.7` in the commands below with its tag from the [release list](https://github.com/gutomec/nirvana-os-engine/releases).

macOS, Linux and WSL:

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | NIRVANA_ENGINE_URL=https://github.com/gutomec/nirvana-os-engine/releases/download/v0.15.0-beta.7/nirvana-os-engine.tar.gz bash
```

Windows, in PowerShell. Paste it as one line:

```powershell
$env:NIRVANA_ENGINE_URL='https://github.com/gutomec/nirvana-os-engine/releases/download/v0.15.0-beta.7/nirvana-os-engine.tar.gz'; irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
```

Then, if the window is still open:

```powershell
Remove-Item Env:NIRVANA_ENGINE_URL
```

In PowerShell the variable lives for the whole window, and while it is set `nrv update` and pack setups reinstall that pinned tarball. A window that closed took the variable with it. Every Windows command on this page uses single quotes on purpose: a double quote lost in a copy and paste (a chat app can drop it) leaves PowerShell waiting on a `>>` prompt.

Close the terminal, open a new one and check that `nrv --version` shows `0.15.0-beta.7`.

What changes on the beta:

- `nrv init` writes the on-demand note by default: your agent works as usual and uses Nirvana only when a request asks for it. See [Start a project](#start-a-project).
- Performance profiles exist (`max`, `balanced`, `economy`). Through `curl | bash` there is no terminal to ask in, so pass one with `| NIRVANA_ENGINE_URL=… bash -s -- --profile=balanced`, or ask your agent later (*"put Nirvana in economy mode"*, which runs `nrv config set execution.profile economy --global`).

To leave the beta, see [Back to stable](#back-to-stable-from-a-beta).

## Windows with WSL (Ubuntu)

WSL runs Ubuntu inside Windows. If you choose it, Nirvana-OS and your AI agent both live inside Ubuntu.

1. Open PowerShell **as administrator** and run `wsl --install`. Reboot when it asks.
2. Open the **Ubuntu** app from the Start menu and create your Linux user and password.
3. Inside Ubuntu: `sudo apt update && sudo apt install -y curl unzip`, then the macOS/Linux/WSL install line above.
4. Install your AI agent (Claude Code, Codex, Antigravity…) **inside Ubuntu** too. An agent installed on the Windows side does not see the engine installed in Ubuntu.
5. Keep your projects in your Ubuntu home (`~`), not under `/mnt/c`. Files under `/mnt/c` go through the Windows file system and are much slower.
6. A pack downloaded with the Windows browser is in `/mnt/c/Users/<your-windows-user>/Downloads`. Copy it into Ubuntu before unzipping:

   ```bash
   mkdir -p ~/Downloads && cp /mnt/c/Users/<your-windows-user>/Downloads/<file>.zip ~/Downloads/
   ```

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

The engine ships no content. Packs install separately; see [Install a pack](#install-a-pack-from-squadssh).

Settings live in `~/.nirvana/config.yaml`, which survives every update. Your agent changes them when you ask; the reference is [docs/configuration.md](docs/configuration.md).

## Verify

Ask your agent *"check that Nirvana-OS is installed correctly"*, or run:

```bash
nrv --version         # the installed version; a beta shows "beta"
nrv doctor            # exit 0 healthy, 1 warnings only, 2 something failed
nrv install --check   # hooks and PATH wiring, exit 0 or 1
```

When `nrv doctor` reports `registry: … missing`, run `nrv index`. Do not reinstall because doctor exited non-zero.

## Install a pack from squads.sh

Packs are curated businesses, squads and mind-clones. Genesis Circle is the example here; every pack installs the same way.

1. Buy the pack on [squads.sh](https://squads.sh/pt/packs) and download its zip from your dashboard.
2. Unzip the **whole** archive and open a terminal in the folder that holds `setup.sh` and `setup.ps1`:
   - **macOS:** double-click the zip in Finder. In Terminal, type `cd ` (with the space), drag the unzipped folder onto the Terminal window and press Enter.
   - **Windows:** right-click the zip, choose **Extract All** (*Extrair tudo*), open the extracted folder, right-click an empty area and choose **Open in Terminal** (*Abrir no Terminal*).
   - **Linux and WSL:** `cd ~/Downloads && unzip <file>.zip -d <folder> && cd <folder>` (on WSL, copy the zip from `/mnt/c` first, as above).
3. Run the setup:

   ```bash
   bash setup.sh                                          # macOS, Linux, WSL
   ```

   ```powershell
   powershell -ExecutionPolicy Bypass -File setup.ps1     # Windows
   ```

Setup installs Bun when it is missing, installs the engine when it is absent and otherwise updates it on its release channel, copies the content to `~/squads/<pack>`, `~/businesses/<pack>` and `~/businesses/_library/dna/<pack>`, rebuilds the indexes, and installs the license in `~/.nirvana-license/packs/<pack>/` (and in the single `~/.nirvana-license/PROVENANCE.json` older engines read). Set `NIRVANA_SKIP_ENGINE_UPDATE=1` to leave the engine as it is.

**Pack setup never replaces a newer engine.** On a beta it keeps the beta (it may move it to a newer beta or to the stable release that follows); on stable it only moves to a newer stable. This rule is in the setup of packs built from engine 0.14.11 on; a zip downloaded before that may predate it, so download it again.

Then talk to your agent: *"Use Nirvana to list what the Genesis Circle pack gave me."*

## Start a project

Every piece of work happens inside a project folder. Open the folder, start your agent there and say *"set up this folder as a Nirvana-OS project"*, or run:

```bash
nrv init .
```

`nrv init` writes `.nirvana/project.yaml`, a `.env` with the project's library scope (`NIRVANA_SCOPE`), `.env.example`, `.gitignore`, `README.md`, the `.nirvana/{squads,businesses,mind-clones}/` folders, and the project contract in `AGENTS.md`, `CLAUDE.md` and `GEMINI.md`. An existing file keeps your own lines; the Nirvana blocks go in under markers. Deliverables land in `outputs/` inside the project.

How Nirvana behaves in the project depends on the mode, and the two channels differ here:

| | 0.14.11 (stable) | 0.15 (beta) |
|---|---|---|
| Default | `always`: Nirvana orchestrates every concrete deliverable | `on-demand`: your agent works as usual and uses Nirvana only when a request asks for it |
| Asks? | Only when you run it yourself in a terminal **and** the folder already has `AGENTS.md`, `CLAUDE.md` or `GEMINI.md`; it then recommends on-demand. Run by your agent, or in a folder without those files, it uses `always` | Never |
| Other mode | `nrv init . --orchestrators=on-demand` | `nrv init . --orchestrators=always` |

On-demand means Nirvana acts when you name it (*"use Nirvana to…"*), name one of your businesses, squads or mind-clones, or ask for work on another runtime. `--scope=project|merge` decides which library the project sees.

## Talk to your agent

You do not type `nrv` commands day to day. You ask in plain language and your agent uses Nirvana-OS:

- *"What businesses, squads and mind-clones do I have?"*
- *"Use Nirvana to write the launch copy for my course."*
- *"Use the Genesis Circle businesses to build a landing page and a competitive teardown for X."*
- *"Run this through the copy squad, on Codex."*
- *"Change the headline in what you delivered."*
- *"Show me what that run did."*

The agent picks the businesses and squads, writes each one a brief, dispatches them and reports what came back, with the audit trail on disk.

## Activate squads the first time

Some squads call real tools: `ffmpeg`, a Python library, a browser, a downloaded model, an API. Activation installs and checks them ahead of time. Ask your agent:

- *"Activate all my Nirvana squads."*
- *"Install the dependencies of every squad."*
- *"Prepare the video squad."*

The agent runs `nrv activate --all` (or `nrv activate <squad>`). When something fails it gets a list with, for each failure, the squad, what is missing, the error and the exact command that fixes it. It runs the safe fixes and asks your permission before anything that uses `brew`, `sudo` or `winget`, and before any API key or secret, which only you can supply (in your environment or the project's `.env`).

Activation covers:

- each squad's own Node and Python environment in `~/.nirvana/envs/<squad>/`, with the packages its `dependencies.yaml` declares. A squad's first dispatch prepares it anyway; activating only does it ahead of time;
- system programs such as `ffmpeg`, from your package manager;
- API keys and environment variables the squad needs;
- MCP servers and models (large downloads need `--confirm-heavy`).

A first `--all` on a big pack takes several minutes; later runs only re-check. If you run `nrv activate --all` yourself in a terminal, it prints a summary and offers to hand the failures to an installed agent to fix.

## Configure briefs per project

Two things shape what your agent hands to the businesses it dispatches.

**Brief altitude.** One setting, per project:

```bash
nrv config set briefing.altitude guided --project
nrv config get briefing.altitude
```

| Value | What the brief carries |
|---|---|
| `outcome` (default) | the result, the guardrails and the definition of done |
| `guided` | the above plus the structure the author suggests |
| `prescriptive` | per-item criteria, the artifact list and the method (the brief's form up to 0.13.9) |

Run it inside a project that `nrv init` set up; `--project` writes `.nirvana/config.yaml` there. On 0.14.11 a request that says "brief detalhado" raises the altitude for that run, and "brief simples" lowers it.

**Project rules in free text.** Write them in the project's `CLAUDE.md`, `AGENTS.md` or `GEMINI.md` (the one your agent reads), **above** the first line that starts with `<!-- nirvana-os:`. Everything from that marker down is the Nirvana block, and `nrv init` rewrites it when the engine's text changes. Your agent reads these files when the session starts and carries your rules into the briefs it writes.

In plain language: *"In this project, use guided briefs"* and *"Add to this project's CLAUDE.md, above the Nirvana block: every deliverable in Brazilian Portuguese, with sources dated."*

## Update

Ask your agent *"update Nirvana-OS"*, or run:

```bash
nrv update            # back up ~/.nirvana/skills, install the newer release, keep settings and content
nrv update --check    # name the release it would install, change nothing
```

An update never installs an older or equal release. A stable engine moves only to a newer stable. A beta moves to the newest greater release, beta or stable, so a 0.15 beta becomes 0.15.0 when that ships; it never goes back to 0.14. After an engine update, `nrv update` checks every installed pack that has a license.

If an update goes wrong, the previous skills are in `~/.nirvana/skills-backup-<stamp>`, and `nrv update` prints the command that restores them.

To update a pack, ask your agent or run `nrv update <pack-slug>`, for example `nrv update genesis-circle`. `--check` compares versions only; `--keep-clones`, `--keep-squads` or `--keep-businesses` leave what is on disk. Components you edited are backed up under `~/.nirvana/backups/packs/<pack>/<stamp>/` first. If it fails with a license error, download the pack again from squads.sh and run its setup again; that reinstalls the license. `nrv license install <pack-folder>` installs only the license.

## Back to stable from a beta

1. On Windows, open a **new** PowerShell window first and run `Remove-Item Env:NIRVANA_ENGINE_URL`. An error saying it does not exist is fine.
2. Run the stable one-liner from [Install the stable engine](#install-the-stable-engine). It installs the latest stable over the beta and keeps your content, packs and settings.
3. Close the terminal, open a new one and check that `nrv --version` no longer shows `beta`.
4. In each project you used with the beta, run `nrv init .` again (or ask your agent to). 0.14.11 does not recognise the note the beta wrote, so first delete the Nirvana block the beta left in `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` (from the `<!-- nirvana-os:on-demand-contract:v3 -->` or `<!-- nirvana-os:invocation-contract:v4 -->` line to the end of that block), keeping your own lines. To keep the beta's on-demand behaviour, run `nrv init . --orchestrators=on-demand`.

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

`NIRVANA_ENGINE_TARBALL=<file>` makes the one-liner install from a local tarball, offline.

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

**PowerShell shows `>>` and waits.** A quote was left open, usually because a closing quote got lost in the paste. Press Ctrl+C (or close the window and open a new one) and paste the single line again, exactly as written on this page.

**macOS prints "Saving session… [Processo concluído]" after you close Terminal** (in English, "[Process completed]"). That is Terminal closing the shell. It is not an error.

**The download returns 404.** A pinned `NIRVANA_ENGINE_URL` is missing the `v` before the version (`v0.15.0-beta.7`, not `0.15.0-beta.7`), or names a release that does not exist. Check the [release list](https://github.com/gutomec/nirvana-os-engine/releases).

**`nrv: command not found`.** `~/.local/bin` is not on the PATH of this terminal. Close it and open a new one; if `nrv` is still missing, add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile.

**`bun: not found`, or the Bun install fails on Ubuntu or WSL.** Install `unzip` (`sudo apt install -y unzip`) and run the one-liner again. To install Bun alone: `curl -fsSL https://bun.sh/install | bash` (Windows: `powershell -c 'irm bun.sh/install.ps1 | iex'`), then open a new terminal.

**`nrv update <pack>` fails with a license error.** Download the pack again from your squads.sh dashboard, unzip it and run its setup; that reinstalls the license. `nrv license install` looks for the license in Downloads, Desktop and the current folder. If you ran the setup in an administrator terminal, run the update as that same user.

**Something else looks wrong.** `nrv doctor` checks runtimes, hooks, skill links, dependencies, registries and licenses (exit 1 means warnings only). `nrv install --check` checks the hooks and the PATH wiring.

**Hooks not firing in Claude Code.** Restart it; hook configuration is read at startup.

**Hooks not firing in Antigravity.** Run `nrv install --check`. If it reports ready and hooks still do not fire, check that `~/.gemini/config/hooks.json` is valid JSON.

**You used the Gemini CLI with Nirvana.** The Gemini CLI is no longer a supported runtime. The next install or update takes Nirvana's hooks out of `~/.gemini/settings.json` and its skill link out of `~/.gemini/skills`, and leaves everything else in them alone. A setting, a `USE_GEMINI` rule or an `LLM_CASCADE` entry that still names `gemini-cli` is skipped with "Gemini CLI is no longer supported; pick another runtime", and the next runtime takes over. Gemini models stay available through Antigravity (`agy`).

**A squad fails on a missing package or program.** Ask your agent to activate that squad (`nrv activate <squad>`). It lists each failure with the command that fixes it.
