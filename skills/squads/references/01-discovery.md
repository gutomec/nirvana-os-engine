# Squad Discovery

## When to load
Intent: DISCOVER (keywords: list, show, find, search, inspect, info, describe)

## Protocol Reference
SQUAD_PROTOCOL_V4.md §5.2 (Directory Layout)

## Discovery Algorithm

### Step 1: Find all squads

Search the two canonical roots for `squad.yaml` manifests:

```bash
find ~/squads ./squads -maxdepth 2 -name "squad.yaml" -type f 2>/dev/null | sort -u
```

### Step 2: Lazy loading

For each `squad.yaml` found, parse ONLY these fields for listing:
- `name` (required)
- `version` (required)
- `protocol` (v4+)
- `description` (first 100 chars)
- `components` (count agents, tasks, workflows)
- `runtime_requirements` (runtime list for compatibility filtering)
- `tags` (if present)

### Step 3: Deduplication

If same squad name exists in both `./squads/` and `~/squads/`, prefer `./squads/` (local wins).

### Step 4: Display format

**List view** (`*squad list`):
```
Squad Protocol Engine v4.0.0
Found N squads (M local, K global)

  NAME                  VERSION   PROTOCOL  AGENTS  TASKS  WORKFLOWS  RUNTIMES          ROOT
  my-squad              1.0.0     4.0       3       5      2          claude-code,codex ~/squads
  legacy-squad          2.1.0     2.0       4       8      3          (legacy)          ./squads
```

**Inspect view** (`*squad inspect {name}`):

Read full `squad.yaml` and display all sections including:
- Manifest fields (name, version, protocol, description, author, license, tags)
- Components inventory (agents, tasks, workflows)
- Runtime requirements (minimum, compatible, incompatible)
- Features required and optional
- Runtime namespaces (keys only)
- Contracts (inter-task schemas)
- Memory configuration (if present)
- UI metadata (if present)

### Debug mode

`*squad list --debug` shows:
- Search paths attempted
- Files found per path
- Parse errors (if any)
- Dedup decisions
- Protocol version detected per squad

## Common Errors
- `~/squads` doesn't exist → create it: `mkdir -p ~/squads`
- Permission denied → check directory permissions
- `squad.yaml` parse error → check YAML syntax

---

## Runtime-Specific Details

Discovery itself is runtime-neutral. Filtering squads by runtime compatibility depends on which adapter you target:

| Runtime | See |
|---------|-----|
| Claude Code | [adapters/claude-code.md §2](../adapters/claude-code.md#2-feature-support-matrix) |
| Gemini CLI | [adapters/gemini-cli.md §2](../adapters/gemini-cli.md#2-feature-support-matrix) |
| Codex | [adapters/codex.md §2](../adapters/codex.md#2-feature-support-matrix) |
| Cursor | [adapters/cursor.md §2](../adapters/cursor.md#2-feature-support-matrix) |
| Antigravity | [adapters/antigravity.md §2](../adapters/antigravity.md#2-feature-support-matrix) |
