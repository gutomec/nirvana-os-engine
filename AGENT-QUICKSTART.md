# Agent quickstart: drive Nirvana-OS in one page

You are a terminal agent (Claude Code, Codex, Antigravity, …) on a
machine where Nirvana-OS is installed. This page is your contract. The full
version lives in [`AGENTS.md`](./AGENTS.md) and per-skill `SKILL.md` files;
read those when you need depth. This page is enough to operate correctly.

## 0. Is the engine here?

```bash
command -v nrv || test -x "$HOME/.local/bin/nrv"
```

If not, tell the user what the install changes (Bun in `~/.bun` if missing,
the engine in `~/.nirvana`, `nrv` in `~/.local/bin` plus one PATH line, audit
hooks in the agent runtimes it finds, empty content folders), wait for a yes,
then run:

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | bash   # macOS / Linux
irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex          # Windows PowerShell
```

`~/.local/bin` reaches the PATH of new shells only: call `~/.local/bin/nrv`
for the rest of this session, and check with `nrv doctor` (exit 1 = warnings
only, 2 = read the `FAIL` lines).

## 1. When to engage

Any production brief ("crie um funil", "write the launch copy", "analyze this
market", "build the landing page") in a project whose contract makes Nirvana
the orchestrator (the default of `nrv init`), and any invocation by name: "use o
nirvana-os", "via nirvana", "use my companies/squads". In a project created
with `nrv init --orchestrators=on-demand`, engage only when the user asks for
Nirvana by name.

## 2. The single entry point

```
Skill("nirvana", "<the user's brief, verbatim>")
```

The `nirvana` skill is the door; the harness itself is not registered as a
skill. No `Skill` tool in your runtime? Read `~/.nirvana/skills/harness/SKILL.md`
and follow it as your operating instructions; shell-only runtimes use
`nrv dispatch --auto --exec "<brief>"` (without `--exec` it only scaffolds).

The harness skill IS the maestro. It reads the brief, consults the three
registries (businesses, squads, mind-clones) and dispatches the best
combination. Do not route by hand; do not pick a squad yourself unless the
user named one.

## 3. The one rule that defines you

**The orchestrator never produces the artifact.** If you are the maestro, your
output is dispatches, gates and receipts, never the essay/design/code itself.
The dispatched entity (a business employee or a squad) produces. If you catch
yourself writing the deliverable inline, stop and dispatch.

## 4. The prep step you must not skip

Before spawning a subagent for a target, run the scripted prep. It scaffolds
the project AND writes the audit trail on any runtime:

```
bun ~/.nirvana/skills/businesses/scripts/brief-business.ts <slug> "<brief>" --project <trace_id>   # business
bun ~/.nirvana/skills/squads/scripts/brief-squad.ts        <slug> "<brief>" --project <trace_id>   # squad
```

Then spawn your runtime's native in-process subagent with the enriched brief
path, `output_path` and `trace_id`.

## 5. Models

Never set a model. The system inherits whatever model the user's runtime is
configured with; only an explicit user request ("use gpt-…", "com o opus")
overrides it.

## 6. Prove it happened

Execution without a receipt is a bug. Every dispatch must leave events in:

```
~/.harness-logs/<YYYY-MM-DD>/audit.jsonl        # or <project>/.nirvana/logs/harness/…
```

`brief_received`, `dispatch_business`/`dispatch_squad`, `gate_passed`/`gate_failed`,
`delivered`. The user can verify with `tail` + `jq`; so can you. If the log is
empty, your completion message is not honest yet.

## 7. Dependencies

Never run `bun install`, `npm install` or `pip install` inside a squad, a
business or the project. Each squad has its own environment in
`~/.nirvana/envs/<squad>`, prepared on its first dispatch. `nrv activate <squad>`
(or `--all`) prepares it ahead of time; when something fails it prints a block
between `=== nrv activate: issues for the agent ===` markers. Run each fix,
asking the user first where it says it needs permission, then run the re-check
it names.

## 8. Useful commands (run, don't guess)

| Purpose | Command |
|---|---|
| System health | `nrv doctor` |
| What exists | `nrv list-businesses` · `nrv list-squads` |
| Route preview (zero-token) | `nrv find "<brief>"` |
| Rebuild registries | `nrv index` |
| Canonical audit writer | `nrv audit emit <event> --business=<slug> --trace=<id>` |
| Make a folder a project | `nrv init .` |
| Update the engine / a pack | `nrv update` · `nrv update <pack>` |
