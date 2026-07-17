# Squad Activation

## When to load
Intent: ACTIVATE (keywords: activate, register, install, deps, enable, ative, instale, prepare)

## Protocol Reference
SQUAD_PROTOCOL_V5.md §5 (Squad Structure), §16 (Security), §18 (Runtime Compatibility), §22 (Capabilities).

## Sidecar `dependencies.yaml` (v5 install model)

Each squad declares external install needs in a sidecar file at `<squad>/dependencies.yaml`. This is **separate from `squad.yaml`** because the v5 SquadManifest is StrictModel and rejects extra fields. The sidecar pattern preserves the manifest schema while letting squads describe arbitrarily complex install requirements.

Template: `${CLAUDE_SKILLS_DIR}/squads/templates/dependencies.template.yaml`. Reference implementation: `${CLAUDE_SKILLS_DIR}/squads/lib/activator.js`.

### Eight categories

| Category | Purpose | Example item |
|---|---|---|
| `system` | OS-level CLIs that must be on PATH | `ffmpeg`, `git`, `uv` — checked then installed via brew/apt/choco per-platform |
| `python` | Python packages | `pip` or `uv` packages (with optional `target_dir`) |
| `node` | Node packages | `npm` / `pnpm` / `yarn` packages (with optional `cwd`) |
| `services` | Long-lived daemons (cloned + installed, NOT started) | Pixelle-Video, ComfyUI, Ollama |
| `custom_nodes` | ComfyUI-specific custom node repos | `kijai/ComfyUI-WanVideoWrapper`, etc. |
| `models` | HuggingFace / URL downloads | `Wan-AI/Wan2.1-T2V-14B`. Items with `size_gb > 1` require user consent |
| `env_vars` | Existing env vars to verify (NEVER written) | `GEMINI_API_KEY`, `RUNNINGHUB_API_KEY` — surfaced as set / missing_required / missing_optional |
| `post_install` | Hooks run after everything else | re-index registry, ping a service, run a smoke test |

### Synthesis fallback

If a squad has no `dependencies.yaml` but contains `package.json`, `pyproject.toml`, or `requirements.txt`, the activator auto-synthesizes one. Cached at `~/.claude/squads-state/<slug>/synth-deps.yaml` for the user to review and optionally promote to a proper sidecar.

## Activation Flow (`*squad activate {name}`)

The squads skill spawns the conversational driver `${CLAUDE_SKILLS_DIR}/squads/agents/squad-activator.md`. That persona:

1. Runs `bun scripts/activate-squad.ts status <slug>` first.
2. If not yet active: runs `--dry-run`, translates the JSON into a human-readable scope summary, asks `AskUserQuestion` for any item >1 GB or sudo install.
3. After consent: runs `bun scripts/activate-squad.ts activate <slug> [--confirm-heavy]`.
4. Surfaces real errors verbatim, with fixes from `${CLAUDE_SKILLS_DIR}/_shared/lib/pixelle/troubleshooting.md` when applicable.
5. Reports the final state plus start commands for any long-running services.

### Step 1: Resolve squad path
```
if exists ${SQUADS_DIR}/{name}/squad.yaml → use ${SQUADS_DIR}/{name}
else → ERROR "Squad '{name}' not found in ${SQUADS_DIR}"
```

### Step 2: Validate squad
Run full validation (see `03-validation.md`). If any Core blocking check fails → STOP.

### Step 3: Resolve target runtime

Inspect `runtime_requirements`:
- Harness detects active runtime.
- Verify it appears in `minimum` or `compatible`.
- If runtime matches `incompatible` → STOP with error.
- Load the corresponding adapter (`adapters/{runtime_id}.yaml`).

### Step 4: Check feature compatibility

For each feature in `features_required`:
- Verify adapter lists it in `features_supported`.
- If missing → STOP with error (fail-closed per P5).

For each feature in `features_optional`:
- If adapter does not support it → log degradation, continue.

### Step 5: Check dependencies

#### Package dependencies (if declared)

Squad may declare language-ecosystem dependencies via adapter-specific namespaces or a generic `dependencies:` block. Package installation is runtime-neutral:

```bash
# Node-based
node -e "try { require('{pkg}') } catch(e) { process.exit(1) }"
# Python-based
python3 -c "import {pkg}" 2>/dev/null
```

Install missing packages via the appropriate package manager if the adapter supports automated dependency resolution.

#### Environment variables

Read `env_required` from `squad.yaml`. Verify each variable is set. Missing variables → fail or warn per squad policy.

#### Secrets

Resolve secret references via the adapter's secret resolution mechanism. Never inline secrets.

### Step 6: Register with runtime

Registration is adapter-specific. The harness delegates to the adapter's invocation documentation (§11 in each adapter doc). Common patterns:

- Copy agent definitions to a runtime command directory.
- Generate slash-command stubs.
- Register subagent types with the runtime.

### Step 7: Report

```
Squad '{name}' v{version} activated for runtime '{runtime_id}'.

Runtime Compatibility:
  protocol: 4.0 ✓
  runtime_requirements.minimum: satisfied ✓
  features_required: all supported ✓
  features_optional: N/M supported, K degraded

Dependencies:
  {package manager}: installed ✓
  env_required: all set ✓

Registration:
  {adapter-specific registrations}

Ready to use.
```

## Deactivation Flow (`*squad deactivate {name}`)

1. Remove runtime registrations (adapter-specific).
2. Do NOT remove squad source files.
3. Do NOT uninstall dependencies (other squads may use them).
4. Report: "Squad '{name}' deactivated. Source files preserved."

## Common Errors

- Permission denied → check directory permissions.
- Package install fails → check network, suggest package manager alternative.
- Runtime not found in `runtime_requirements` → squad incompatible with current runtime.
- Feature missing → consult adapter's Feature Support Matrix.

---

## Runtime-Specific Details

Adapter invocation and registration specifics live in each adapter's §11:

| Runtime | See |
|---------|-----|
| Claude Code | [adapters/claude-code.md §11](../adapters/claude-code.md#11-invocation-examples) |
| Gemini CLI | [adapters/gemini-cli.md §11](../adapters/gemini-cli.md#11-invocation-examples) |
| Codex | [adapters/codex.md §11](../adapters/codex.md#11-invocation-examples) |
| Cursor | [adapters/cursor.md §11](../adapters/cursor.md#11-invocation-examples) |
| Antigravity | [adapters/antigravity.md §11](../adapters/antigravity.md#11-invocation-examples) |
