# Workflow Orchestration

## When to load
Intent: EXECUTE (keywords: run, execute, start, launch, resume)

## Protocol Reference
SQUAD_PROTOCOL_V4.md §8

## Workflow Types

### Story Development Cycle (SDC)
Sequential 4-phase pipeline:
```
create → validate → implement → gate → release
```
| Phase | Role | Output |
|-------|------|--------|
| 1 | story creator | story file |
| 2 | validator | GO (score ≥ threshold) or NO-GO |
| 3 | implementer | working code |
| 4 | QA | PASS / CONCERNS / FAIL / WAIVED |

### QA Loop (Review-Fix Cycle)
Iterative review-fix cycle with bounded iterations:
```
review → verdict → fix → re-review (max 5 iterations)
```
**Verdicts:**
- `APPROVE` — work accepted, workflow continues
- `REJECT` — send back for fix (within loop budget)
- `BLOCKED` — escalate to human

**Escalation triggers:** `max_iterations_reached`, `verdict_blocked`, `fix_failure`, `manual_escalate`.

### Spec Pipeline
Sequential with skippable phases:
| Phase | Skip Condition |
|-------|---------------|
| Gather | Never |
| Assess | source is simple |
| Research | SIMPLE complexity class |
| Write | Never |
| Critique | Never |
| Plan | If previously APPROVED |

**Complexity classes:** SIMPLE (≤ 8), STANDARD (9–15), COMPLEX (≥ 16).

### DAG Workflows
Steps declare `depends_on`; harness computes parallel execution waves:

```yaml
steps:
  - id: analyze
    agent: architect
    task: analyze-requirements
    depends_on: []

  - id: design-db
    agent: data-engineer
    task: design-schema
    depends_on: [analyze]

  - id: design-api
    agent: architect
    task: design-api
    depends_on: [analyze]

  - id: implement
    agent: dev
    task: implement
    depends_on: [design-db, design-api]
```

## Wave Execution

Steps at the same dependency level form a wave. Waves execute sequentially; steps within a wave execute in parallel **when the runtime supports `subagent_spawning`**. Runtimes without this feature degrade to sequential execution of the workflow in topological order (Core P9 Graceful Degradation).

## Workflow Patterns

| Pattern | Description | Use case |
|---------|-------------|----------|
| Pipeline | A → B → C (linear) | Simple sequential work |
| Validated Pipeline | A → [GATE] → B → [GATE] → C | Quality-gated progression |
| Human-Gated | A → [HUMAN] → B → [HUMAN] → C | Requires approval |
| Hub-and-Spoke | Leader delegates to parallel workers | Coordinated parallel work |
| Review Loop | Worker → Reviewer → [PASS/FAIL] | QA iterations |
| Parallel | Split → Workers A/B/C → Merge | Independent parallel tasks |
| DAG | Topological order with depends_on | Complex dependencies |

## Execution Modes

| Mode | Interactions | Use case |
|------|-------------|----------|
| `yolo` | 0–1 | Fast autonomous execution |
| `interactive` | 5–10 | Balanced, educational |
| `preflight` | comprehensive | Planning-heavy |

## Model Routing (Reasoning Sandwich)

Squads can declare per-phase model hints under `runtimes.{id}` namespaces:

```yaml
runtimes:
  claude-code:
    model_strategy:
      orchestrator: opus   # planning phase
      workers: sonnet      # implementation phase
      reviewers: sonnet    # verification phase
```

Adapters resolve family hints (`haiku`, `sonnet`, `opus`) to concrete model identifiers (§3 Concept Mapping in each adapter).

## Running a Workflow

1. Resolve squad path.
2. Read `squad.yaml`, find the workflow file.
3. Read workflow YAML.
4. Verify all referenced agents and tasks exist.
5. Determine execution waves (or sequential if `subagent_spawning` unavailable).
6. Execute steps per wave.
7. Apply verification after each step (if configured).
8. Track state in `.squad-state/{run-id}/`.
9. Report results.

---

## Runtime-Specific Details

Subagent spawning mechanics and parallelism behavior vary by runtime:

| Runtime | See |
|---------|-----|
| Claude Code | [adapters/claude-code.md §7](../adapters/claude-code.md#7-subagent-spawning) |
| Gemini CLI | [adapters/gemini-cli.md §7](../adapters/gemini-cli.md#7-subagent-spawning) |
| Codex | [adapters/codex.md §7](../adapters/codex.md#7-subagent-spawning) |
| Cursor | [adapters/cursor.md §7](../adapters/cursor.md#7-subagent-spawning) |
| Antigravity | [adapters/antigravity.md §7](../adapters/antigravity.md#7-subagent-spawning) |
