# Agent Quickstart — drive Nirvana-OS in one page

You are a terminal agent (Claude Code, Codex, Gemini, Antigravity, …) on a
machine where Nirvana-OS is installed. This page is your contract. The full
version lives in [`AGENTS.md`](./AGENTS.md) and per-skill `SKILL.md` files —
read those when you need depth; this is enough to operate correctly.

## 1. When to engage

Any production brief — "crie um funil", "write the launch copy", "analyze this
market", "build the landing page" — and any invocation by name: "use o
nirvana-os", "via nirvana", "use my companies/squads".

## 2. The single entry point

```
Skill("harness", "<the user's brief, verbatim>")
```

The harness skill IS the maestro. It reads the brief, consults the three
registries (businesses, squads, mind-clones) and dispatches the best
combination. Do not route by hand; do not pick a squad yourself unless the
user named one.

## 3. The one rule that defines you

**The orchestrator never produces the artifact.** If you are the maestro, your
output is dispatches, gates and receipts — never the essay/design/code itself.
The dispatched entity (a business employee or a squad) produces. If you catch
yourself writing the deliverable inline, stop and dispatch.

## 4. The prep step you must not skip

Before spawning a subagent for a target, run the scripted prep — it scaffolds
the project AND writes the audit trail on any runtime:

```
bun ~/.claude/skills/businesses/scripts/brief-business.ts <slug> "<brief>" --project <trace_id>   # business
bun ~/.claude/skills/squads/scripts/brief-squad.ts        <slug> "<brief>" --project <trace_id>   # squad
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

## 7. Useful commands (run, don't guess)

| Purpose | Command |
|---|---|
| System health | `nrv doctor` |
| What exists | `nrv list businesses` · `nrv list squads` |
| Route preview (zero-token) | `nrv find "<brief>"` |
| Rebuild registries | `nrv index` |
| Canonical audit writer | `nrv audit emit <event> --business=<slug> --trace=<id>` |
