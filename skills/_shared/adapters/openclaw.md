# Adapter · OpenClaw

> Runtime adapter for Squad Protocol v6 + Business Protocol v2 + Harness Protocol v2.
> System identity + capabilities: see `../NIRVANA-OS.md` (single source).
> Researched on 2026-08-13 against `docs.openclaw.ai` and `openclaw/openclaw` on GitHub.

---

## 1. Adapter Metadata

| Field | Value |
|---|---|
| Runtime | OpenClaw (`openclaw`) |
| Skills spec | [AgentSkills](https://agentskills.io): `SKILL.md` with YAML frontmatter |
| Skills roots (precedence) | `<workspace>/skills` → `<workspace>/.agents/skills` → `~/.agents/skills` → `<state-dir>/skills` → bundled |
| Where the engine installs | `~/.agents/skills` (personal), via `RUNTIME_SKILL_DIRS` |
| Discovery | scans up to 6 levels deep, matches on the frontmatter `name` field, **not** on the folder name |
| Invocation | `/harness` (slash), `$harness` (reference in the prompt), or direct dispatch by tool |
| Project contract | **there is no** equivalent of `CLAUDE.md` / `AGENTS.md` read by the runtime |
| In-process subagent | **does not exist** |
| Delegation | `bash background:true` → child CLI; follow-up by `process poll` / `process log` |

---

## 1.1 Fresh install: the ~/.agents trap (fixed in 0.7.4)

A machine where OpenClaw was just installed via npm has the `openclaw` binary
on PATH but NO `~/.agents` yet: the directory is created on first run. Engine
installers before 0.7.4 gated linking on the directory existing, so the skills
link was silently skipped: no error, no `~/.agents/skills`, and the buyer
concluded the product was broken. Since 0.7.4 the installer probes the binary
too and creates the directory itself; `nrv doctor` reports a `skills link:
openclaw` line either way. On an older engine, the workaround order is:

    npm i -g openclaw@latest
    mkdir -p ~/.agents        # or `openclaw setup`, which creates it
    bun scripts/install.ts    # now links

Remember the two facts the runtime cannot teach (also printed by the
installer): OpenClaw reads no project contract, so invoke explicitly with
`/harness <brief>`, and it has no in-process subagent, so the scripted path
(`nrv dispatch --exec`) is the real dispatch.

---

## 2. The difference that decides everything

Claude Code, Codex and Antigravity have a subagent primitive that runs inside
the session and returns the result. OpenClaw **does not**. What it has is the
same pattern its own `coding-agent` skill uses:

```
bash background:true workdir:<dir> command:"claude --permission-mode bypassPermissions --print < $PROMPT"
```

This returns a **session id** right away. Follow-up is by `process poll`
(status) and `process log` (output). And completion **does not arrive on its
own**: the worker is instructed to announce its own end with

```
openclaw message send --channel <channel> --target '<target>' --message '<brief result>'
```

Three consequences for Nirvana, and none is optional:

1. **The dispatch path here is the SCRIPTED one**, not the agentic in-process one.
   `nrv dispatch --exec` (which is `runHeadless` firing a child CLI) is
   exactly the form OpenClaw already uses. The harness §Phase 4 `Agent(...)`
   does not exist in this runtime.
2. **The "never forgotten" guarantee depends on the ledger**, not on a runtime
   notification. This is precisely the scenario the run-ledger and the
   supervisor were built for: with no automatic callback, proof of life is the
   activity on disk under `--outputs`, the lease expires, and the supervisor
   escalates and notifies. See `harness/references/05-subsystems.md` §Run ledger & supervisor internals.
3. **The invocation contract cannot live in a project file**, because
   OpenClaw reads none. It lives in the skill, which is exactly where Nirvana
   has put it since 2026-08-13. A project without `nrv init` is not a partial
   degradation here: it is the only mode that exists.

---

## 3. Concept Mapping

| Nirvana concept | OpenClaw |
|---|---|
| Skill (harness/squads/businesses) | `SKILL.md` in `~/.agents/skills/<name>/` |
| Invoke the maestro | `/harness` or `$harness` in the prompt |
| Dispatch to business/squad | `bash background:true` → `nrv dispatch --exec --target <slug>` |
| Target's return | `process poll` until it finishes + `_SUMMARY.md` on disk |
| End notification | the worker announces via `openclaw message send`, or the Nirvana supervisor notifies |
| Quality gate | identical: `quality-gate.ts`, runs in the shell |
| Audit | identical: `~/.harness-logs/<date>/audit.jsonl` |
| Mind-clone | identical: DNA injected into the child CLI's prompt |

---

## 4. Frontmatter

OpenClaw requires `name` + `description` and accepts `metadata.openclaw` for
gating. The block below is what makes the skill appear only where it works;
without it, a user with no Bun sees the skill, invokes it and gets an error:

```yaml
metadata:
  openclaw:
    emoji: "🎼"
    requires:
      bins: ["bun"]        # every Nirvana script is Bun-native; without bun nothing runs
      anyBins: ["claude", "codex", "opencode"]   # some CLI to receive the dispatch
```

`user-invocable` stays at its default (`true`), so `/harness` works.
Do not use `disable-model-invocation`: the harness needs to activate by
description when the user asks for an artifact without naming the system.

---

## 5. Dispatch: the correct form on this runtime

```bash
# 1. prep (identical on every runtime): opens the run in the ledger, emits audit
bun ~/.nirvana/skills/squads/scripts/brief-squad.ts <slug> "<brief>" --project <trace_id>

# 2. dispatch in the background, with whichever child CLI OpenClaw has
bash background:true workdir:<project_dir> \
  command:"nrv dispatch '<brief>' --target squad:<slug> --project <trace_id> --exec"

# 3. follow up WITHOUT scanning the disk
process poll <session_id>

# 4. when it finishes: gate, close the run, notify
bun ~/.nirvana/skills/harness/scripts/quality-gate.ts <artifact> --auto
nrv run-track close <run-id> --state delivered|withheld|failed
```

The harness rules that **hold the same here**: a receipt is not a result (here
the receipt is the session id); never infer completion by scanning a file, use
`process poll`, which is the authoritative answer; dispatch carries no timeout; and a
wave of independent targets fires every `bash background:true` before waiting
on any of them.

---

## 6. Known limits

- **No project contract.** There is no `CLAUDE.md`/`AGENTS.md` that OpenClaw
  reads, so activation depends entirely on the skill's description. Writing the
  description well is here a matter of function, not of style.
- **Completion is announced, not delivered.** If the worker dies before announcing,
  whoever notices is the Nirvana supervisor through the expired lease, not OpenClaw.
- **`~/.agents/skills` is shared.** Other tools write there (the `agentskills`
  CLI, for example). The engine links per skill, never the whole directory:
  a directory symlink into another runtime's tree makes each skill
  reachable twice and produces "Skill conflict detected".
