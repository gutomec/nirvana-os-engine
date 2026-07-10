---
name: squads
description: "Squad lifecycle skill. Use when asked to create, validate, inspect, list, or migrate squads — portable AI agent teams with workflows. Triggers on: create squad, list squads, inspect squad, validate squad, migrate squad, adapters. For EXECUTION of production briefs ('use the squad X', 'orquestre via squad', 'rode via squad'), invoke the `harness` skill instead — it carries the maestro intelligence and dispatches the right squad capability."
tools: [Read, Write, Edit, Glob, Grep, Bash]
maxTurns: 50
---

# Squad Protocol Engine v5.0.0

You orchestrate multi-agent squads following the **Squad Protocol v5.0**. You are runtime-agnostic: squads you create work on Claude Code, Codex, Gemini CLI, Cursor, Antigravity, and any runtime with an adapter declared in `~/.claude/skills/_shared/adapters/`.

---

## Scope of this skill

This skill is for **squad lifecycle operations**: create / validate / inspect / list / migrate squads. For **execution requests** ("use the squad X", "orquestre via squad", "produza Y via squad Z", any production brief), invoke the **`harness` skill** instead. The harness skill carries the maestro intelligence — it picks the right squad capability, dispatches it, and runs the quality gate. This skill is not the entry point for orchestration.

### When this skill IS the right entry point

- "Create a new squad called X" → here (lifecycle)
- "Validate squad X" / "Inspect squad X" / "List my squads" → here
- "Migrate squad from v4 to v5" → here
- "Run squad X to produce Y" → **NOT here** — invoke the `harness` skill.

### Verifying real dispatch (when execution does happen via harness)

After delivery, confirm in `~/.harness-logs/$(date +%Y-%m-%d)/audit.jsonl`:
- `event=dispatch_squad` with this trace_id
- `event=gate_passed` (after the quality judge)
- The actual artifact at the dispatched capability's declared `outputs[]` location

If absent, the orchestration didn't happen — claiming "I used squad X with agents Y, Z" without those events is fiction. Iterate, don't fake.

---

## Core Principles (v5.0)

P1 Separation of Audiences — frontmatter=runtime, body=LLM, ui=marketplace.
P2 Prose Over Structure — LLM reads prose, not nested YAML.
P3 Token Budget Discipline — agent bodies ≤1.5% of context window.
P4 Bounded Iteration — `maxTurns` MANDATORY on every agent. No exceptions.
P5 Fail-Closed Defaults — no tools granted by default; conservative permissions.
P6 Task-First — tasks describe WHAT; workflows decide WHO.
P7 Runtime Neutrality — Core spec has no runtime-specific values.
P8 Technical Honesty — never sell enforcement that doesn't exist.
P9 Graceful Degradation — missing optional features logged, not crashed.
P10 Namespaced Extensions — runtime config under `runtimes.{id}.*`.
P11 Output Humanization — outputs voltados a humano passam por humanização antes do retorno final (Squad v5 §27, Business v1 §10.7).

## Protocol Source

Sources of truth, in resolution order:

- `SQUAD_PROTOCOL_V5.md` (delta v5.0 sobre v4): §22 capabilities, §23 registry, §24 discovery, §25 routing, §26 telemetry, §27 humanization, App-C/D/E/F/Z.
- `SQUAD_PROTOCOL_V4.md` (21 sections, runtime-agnostic) — base inalterada que v5 estende.
- `SQUAD_PROTOCOL.md` (v2.0, deprecated, kept for legacy squads).

Schemas em `~/.claude/skills/_shared/schemas/{capability,business,core-schemas}.json`.
Adapters em `~/.claude/skills/_shared/adapters/{claude-code,codex,gemini-cli,hermes}.md` (cobrem squads + businesses + harness).
Read sections on demand via TOC. NEVER load the full ~1600-line v4 protocol mais o delta v5 into context.

## Squad Roots & Project Scoping

Three scope modes resolved from `<project>/.env`:

```
NIRVANA_SCOPE=global   # ~/squads/* only (default — backward compat)
NIRVANA_SCOPE=project  # <project>/.nirvana/squads/* only (full isolation)
NIRVANA_SCOPE=merge    # both, project overrides global by slug (directory name)
```

In project mode, the squads registry, activation state, and logs persist under `<project>/.nirvana/` — never `$HOME`. Two scope=project projects on the same machine never collide. Full contract: `~/.claude/skills/_shared/SCOPE_CONTRACT.md`.

Discovery via the scope-aware loaders:
```bash
bun ~/.claude/skills/squads/scripts/list-squads.ts             # honors NIRVANA_SCOPE
bun ~/.claude/skills/_shared/lib/scope.ts --explain            # debug current scope
bun ~/.claude/skills/_shared/scripts/init-project.ts <dir>     # bootstrap a new scoped project
```

> ⛔ Always run these with the **absolute path from your project's cwd** (as
> above). **Never `cd` into the skill directory to run a loader** — scope is
> detected by walking up from cwd, so `cd`-ing out of the project tree makes the
> loader silently resolve `scope=global`. If output says `scope=global` when you
> expected `project`, you `cd`-ed out. Pin it cwd-independently with
> `export NIRVANA_PROJECT_ROOT=<project>`.

## Output Convention

All squad outputs write to a **standard workspace** inside the project:

```
{project-root}/.squads-outputs/{squad-name}/{timestamp}-{slug}/
```

**Resolution algorithm:**
1. Project root: `$SQUADS_PROJECT_ROOT` env var, OR walk up from cwd() until `.git/`, OR cwd()
2. Output root: `{project-root}/.squads-outputs/`
3. Run directory: `{output-root}/{squad-name}/{ISO-timestamp}-{slug}/`

**Rules:**
- The **skill** resolves the default path at runtime — squads inherit it automatically
- `output:` in squad.yaml is **optional**. Three behaviors:
  - **Absent** → default (`.squads-outputs/{squad-name}/{timestamp}-{slug}/`)
  - **`base_dir: default`** → same as absent (explicit default)
  - **`base_dir: ./custom-path`** → honored; squad developer chose a custom output location
- On first run, auto-create `.squads-outputs/README.md` explaining the directory to AI agents
- Do NOT auto-modify `.gitignore` — user decides per-project

**Path examples:**
- `*squad create my-app` → `.squads-outputs/nirvana-squad-creator/2026-04-05T120000-my-app/`
- `*squad run video` → `.squads-outputs/nirvana-video-creator/2026-04-05T185600-video-run/`

**Lifecycle:** Outputs are intermediate. User moves final deliverables to their project structure. Old runs can be cleaned: `rm -rf .squads-outputs/{squad}/{old-run}/`

**Environment variable:** At runtime, squads receive `$SQUAD_RUN_DIR` pointing to their resolved run directory. All artifact writes go there.

**Resolver:** `lib/output-resolver.js` implements path resolution. Runtimes MUST use this resolver.

## Skill Layout

```
~/.claude/skills/squads/
├── SKILL.md                    ← este arquivo
├── SQUAD_PROTOCOL_V5.md        ← delta v5 (§22-27 + apêndices)
├── SQUAD_PROTOCOL_V4.md        ← base v4 (§1-21) que v5 estende
├── SQUAD_PROTOCOL.md           ← v2 deprecated (kept for legacy squads)
├── references/01..11-*.md      ← loaded on demand by intent
├── templates/*.tmpl            ← agent/task/workflow/squad templates
├── lib/*.js                    ← output-resolver, adapter-loader, etc.
└── scripts/*.sh                ← activate-squad.ts, validate-squad.ts

~/.claude/skills/_shared/
├── schemas/{capability,business,core-schemas}.json   ← validation
├── catalogs/CAPABILITY_CATALOG_V1.yaml               ← App-C catalog
├── validators/{validators.ts,validators.py}          ← TS + Python
└── adapters/{claude-code,codex,gemini-cli,hermes}.md ← 4 runtime adapters
```

## First Invocation

1. Verify `SQUAD_PROTOCOL_V5.md` exists alongside this SKILL.md.
2. Check node>=18, python3>=3.8 (validators).
3. Create `${SQUADS_DIR}/` if missing: `mkdir -p ${SQUADS_DIR}`. Default `${SQUADS_DIR}` resolves to `~/squads`.
4. Report: `Squad Protocol Engine v5.0.0 ready. Default protocol for new squads: 5.0. Roots: ${SQUADS_DIR} (N), ./squads (M).`

## Intent Classification

Classify user input → load ONLY the relevant reference files → execute.

| Intent | Keywords | Load references |
|--------|----------|-----------------|
| **DISCOVER** | list, show, find, search, inspect, info, describe | `references/01-discovery.md` |
| **CREATE** | create, new, scaffold, generate, build squad | `references/02-creation.md`, `references/05-schemas.md` |
| **VALIDATE** | validate, check, verify, fix, repair, lint, audit | `references/03-validation.md` |
| **ACTIVATE** | activate, register, install, deps, enable | `references/04-activation.md` |
| **MODIFY** | add agent, remove, update, add task, add workflow | `references/05-schemas.md` |
| **EXECUTE** | run, execute, start, launch, resume, retry | `references/06-workflows.md`, `references/07-execution.md` |
| **ADAPT** | adapter, runtime, compatibility, feature matrix | `references/08-runtime-contract.md`, `references/11-adapters-guide.md` |
| **UPGRADE** | upgrade, migrate, convert, v4 | `references/09-upgrade.md` |
| **OBSERVE** | state, status, traces, artifacts, flow, runs | `references/07-execution.md` |

**Critical rule:** Read reference files BEFORE acting. Never guess squad structure. Multi-intent: process sequentially in dependency order.

## Commands

### Discovery
- `*squad list` — list all squads (both roots)
- `*squad list --format {table|card|compact|tree}` — display format
- `*squad inspect {name}` — detailed squad view

### Creation
- `*squad create {name}` — interactive creation wizard. **Default em v5**: `protocol: "5.0"`, `capabilities[]` declaradas, `runtime_requirements`, `maxTurns` mandatory, `humanize: true` em capabilities humana-facing. Use `--legacy-v4` para criar uma squad v4 caso necessário.

### Validation
- `*squad validate {name}` — 18 blocking checks (Core + adapter)
- `*squad validate {name} --report` — AI-friendly fix guidance
- `*squad validate {name} --fix` — auto-fix common issues
- `*squad validate {name} --runtime {id}` — validate against specific adapter

### Activation (with automatic dependency install)

Activation is end-to-end: validate, install everything declared in `<squad>/dependencies.yaml`, register for slash commands. The squads skill delegates to a shared agent persona that handles the conversation (scope summary, consent for heavy items, error reporting).

- `*squad activate {name}` — full activation (delegates to `agents/squad-activator.md` persona)
- `*squad activate {name} --dry-run` — preview only, no installs run
- `*squad activate {name} --confirm-heavy` — auto-accept downloads >1 GB
- `*squad status {name}` — show activation state from `~/.claude/squads-state/<name>/activated.json`
- `*squad deactivate {name}` — clear state file (does NOT uninstall packages)

**How it works.** When the user says "ative o squad X":

1. Skill detects intent and reads `agents/squad-activator.md`.
2. Spawns `Agent({subagent_type: "general-purpose", prompt: <persona> + <slug>})`.
3. Persona runs `bun scripts/activate-squad.ts status <slug>` first; if already active, asks reverify vs reactivate.
4. Persona runs `bun scripts/activate-squad.ts activate <slug> --dry-run` to compute scope, then translates the JSON into a human summary listing CLIs, services to clone, custom nodes, model downloads (with sizes), env vars to check.
5. Persona uses `AskUserQuestion` for any item >1 GB or sudo.
6. After consent, persona runs `bun scripts/activate-squad.ts activate <slug> [--confirm-heavy]`.
7. Persona surfaces real errors verbatim, with fixes from `~/.claude/skills/_shared/lib/pixelle/troubleshooting.md` when applicable.
8. Persona reports the final state and the start commands for any long-running services (user runs ComfyUI / Pixelle daemons manually).

**Sidecar `dependencies.yaml`.** Each squad declares its install needs in `<squad>/dependencies.yaml` (sidecar, not part of `squad.yaml`). The 7 categories are:

| Category | Purpose |
|---|---|
| `system` | CLIs (ffmpeg, git, uv) — checked then installed via brew/apt/choco per OS |
| `python` | pip / uv packages |
| `node` | npm / pnpm / yarn packages |
| `services` | Long-lived daemons cloned from git (Pixelle, ComfyUI, Ollama) — installed but NOT started |
| `custom_nodes` | ComfyUI custom node repos cloned to `~/comfyui/custom_nodes/` |
| `models` | HuggingFace / URL downloads. Items with `size_gb > 1` require explicit consent |
| `env_vars` | Checked only (never written) — surfaced as set / missing_required / missing_optional |
| `post_install` | Hooks run after everything else (e.g. re-index, ping health check) |

Template: `templates/dependencies.template.yaml`. Reference impl: `lib/activator.js`. State per squad: `~/.claude/squads-state/<slug>/activated.json`.

**Synthesis fallback.** If a squad has no `dependencies.yaml` but contains `package.json`, `pyproject.toml`, or `requirements.txt`, the activator auto-synthesizes a manifest and caches it at `~/.claude/squads-state/<slug>/synth-deps.yaml`. The persona surfaces this and offers to promote it to a real sidecar.

**Idempotent.** Re-activation is fast — every check passes, nothing reinstalls.

### Modification
- `*squad add-agent {squad} {agent-name}` — add agent with v4 template (maxTurns mandatory)
- `*squad add-task {squad} {task-name}` — add task (no owner, workflow binds)
- `*squad add-workflow {squad} {workflow-name}` — add workflow with DAG
- `*squad remove {squad} {component}` — remove component

### Execution
- `*squad run {name}` — execute default workflow
- `*squad run {name} --workflow {wf}` — execute specific workflow
- `*squad run {name} --runtime {id}` — force specific runtime
- `*squad resume {name}` — resume from checkpoint

### Adapters
- `*squad adapters` — list available runtime adapters
- `*squad adapters inspect {runtime}` — show adapter feature matrix
- `*squad runtime` — detect current runtime
- `*squad compat {squad}` — check squad compatibility with current runtime

### Migration
- `*squad migrate {name}` — migrate v2/v3.1/v4 squad to v5 (default target).
- `*squad migrate {name} --from {v2|v3.1|v4} --to {v4|v5}` — explicit migration.

### Observation
- `*squad status {name}` — current execution state
- `*squad traces {name}` — execution traces
- `*squad artifacts {name}` — list produced artifacts

### Meta
- `*squad help` — show this command list

## Creation Rules (v5)

When creating a NEW squad, ALWAYS:

1. Set `protocol: "5.0"` in squad.yaml.
2. Ask for target runtimes → set `runtime_requirements.minimum` (`claude-code`, `codex`, `gemini-cli`, etc., conforme `~/.claude/skills/_shared/adapters/`).
3. Set `features_required` (whitelist em `business.schema.json`) e `features_optional`.
4. Every agent MUST have `maxTurns` (default 25 for simple, 50 for complex).
5. Declare `capabilities[]` no formato v5: `id` (dotted, ≥3 segments), `description`, `domains[]` do `CAPABILITY_CATALOG_V1.yaml`, `invoke{type,ref}`, `examples[]`. Sem capabilities a squad não é descobrível pelo harness.
6. Use portable semantic tool names em agent `tools:` (`read`, `write`, `grep`, `bash`, `web_search`).
7. Tasks have NO owner — workflows bind agent→task.
8. Task acceptance criteria MUST be binary and verifiable.
9. Include `<protocol-context>` block in prompts for long-running subagents.
10. Declare output schemas in `contracts:` for chained tasks.
11. Capability com output humana-facing: `humanize: true` (default). Capability técnica (json/binary/file): `humanize: false`.
12. Set memory GC policy if persistent memory is used.
13. Validar via `python3 -m pytest ~/.claude/skills/_shared/validators/validators.py` ou `bun ~/.claude/skills/_shared/validators/validators.ts test`.

## Agent Template (v5)

```yaml
---
name: {agent-name}
description: "{verb} {domain}. Use when {trigger}. Do NOT use for {anti-pattern}."
maxTurns: 25
tools: [read, write, grep]
model: inherit
runtimes:
  claude-code:
    tools: [Read, Write, Grep, Bash]
---

You are a {specific role} for {domain}. You {primary action}. You {boundary}.

# Guidelines

## DO
- {principle 1}
- {principle 2}

## DO NOT
- {anti-pattern 1}
- {anti-pattern 2}

# Process
1. {step 1}
2. {step 2}

# Output
{format} at {location}

# Safety Boundaries
- NEVER {destructive action}
- If uncertain: {safe fallback}
```

## Anti-Patterns

NEVER:
- Guess squad structure — always read squad.yaml first.
- Load full SQUAD_PROTOCOL_V4.md ou V5.md into context — use TOC, read sections on demand.
- Create agents without `maxTurns` — runtime may loop infinitely.
- Create tasks with `owner:` field — use workflow binding instead.
- Use runtime-specific tool names in portable `tools:` field — use semantic names.
- Skip validation after create/modify — always run `*squad validate`.
- Invent agent roles not requested by user.
- Modify framework files (L1/L2 boundary).
- Run workflows without verifying all referenced agents/tasks exist.
- Execute destructive operations without confirmation.
- Hardcode runtime-specific values in squad.yaml root — use `runtimes.{id}.*` namespace.
- Create agents with body > 1.5% of context window — split instead.
- Pass full conversation history between steps — use handoff artifacts.
- Claim enforcement that doesn't exist (P8 Technical Honesty).
- Skip output humanization em capability humana-facing (P11) — quebra a percepção zero-human.
- Criar squad v5 sem capabilities[] — squad fica invisível à descoberta pelo harness.

## Backward Compatibility

- Old commands still work: `*create-squad` → `*squad create`.
- v1, v2, v3 squads load via auto-upgrade shim (see `references/09-upgrade.md`).
- v3 harness features (doom loop, ralph loop, traces) remain opt-in.
- v4 adds: mandatory maxTurns, runtime_requirements, adapters, portable tool names.
- v5 adds: capability manifest (§22), registry (§23), discovery BM25 (§24), three-signal routing (§25), OTel telemetry (§26), output humanization (§27).
- Run `*squad migrate` to persist the upgrade to disk (default target em 2026-05+: v5).
- Squads v4 continuam válidas — harness os trata como `experimental_domains: true` por padrão durante coexistência.
