# Squad Creation Wizard (v5)

## When to load

Intent: CREATE with keyword "create squad", "scaffold squad", "new squad",
"`*squad create`".

---

## Overview

Squad v5 creation is a flow of **4 rounds of questions** followed by a
deterministic scaffold via `scripts/init-squad.ts`. The LLM runs each
round with the `AskUserQuestion` tool (on runtimes that support it).
On runtimes without a prompt UI, the LLM presents the questions inline and
waits for the reply in chat.

**Final output:** `${SQUADS_DIR}/<name>/` with a valid `squad.yaml` + skeleton
of agents/tasks/workflows. Ready to validate and iterate.

---

## Round 1 — Identity

```
Q1.1  What is the squad's main objective? (1 sentence)
       → will be used as `description` (≥20 chars).

Q1.2  Squad name? (kebab-case, suggested from the objective)
       → will be used as `name`.

Q1.3  Slash prefix? (2-4 chars)
       → will be used in `*<prefix> ...` when invoking the squad. Default:
         first 3 letters of the name.
```

Validation after Round 1:
- `name` matches `^[a-z][a-z0-9-]+$`
- `description` ≥ 20 chars
- `prefix` 2-4 chars

If invalid, re-ask only the problematic field.

---

## Round 2 — Components

```
Q2.1  How many agents? (default 2)
       → each agent becomes agents/<slug>.md (template applied later)

Q2.2  What are the agents' roles?
       → example: ["orchestrator", "researcher", "writer"]
       → becomes slugs in agents/orchestrator.md, agents/researcher.md, ...

Q2.3  How many workflows? (default 1)
       → a workflow is the sequence of tasks that orchestrates agents

Q2.4  What are the workflow names?
       → example: ["main-pipeline", "quick-review"]
       → becomes workflows/main-pipeline.yaml
```

Validation:
- agent names in kebab-case
- workflow names in kebab-case
- ≥1 agent, ≥1 workflow

---

## Round 3 — Capabilities

This is the v5-specific part. Without capabilities, the squad is invisible
to the harness.

```
Q3.1  How many capabilities does the squad expose? (default 1, max 50)
       → capability = one NL intent that triggers a workflow.

For EACH capability:

Q3.2  Capability id? (dotted, ≥3 segments)
       → example: marketing.funnel.create
       → pattern: <domain>.<feature>.<action>

Q3.3  Capability description? (20-500 chars)
       → will be indexed by BM25. Concrete > generic.

Q3.4  Domains? (1-5 from CAPABILITY_CATALOG_V1)
       → list relevant domains; if not in the catalog,
         confirm experimental_domains: true.

Q3.5  Which workflow of this squad implements this capability?
       → invoke.ref points to workflows/<name>.yaml.

Q3.6  Give 3 examples of NL phrases that should match this capability.
       → they go into examples[]. Cover PT-BR / EN variation / synonyms.

Q3.7  Is there a nearby NL phrase that should NOT match? (optional)
       → goes into not_for[]. Cite the alternative capability when known.

Q3.8  Is the output human-facing (text, copy, doc)?
       → yes → humanize: true (default)
       → no (json/binary/tech) → humanize: false
```

Validation:
- id matches `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$`
- description 20-500 chars
- domains non-empty, ≤5
- invoke.ref points to a workflow declared in Round 2
- examples[] ≥1

If any domain is outside the catalog, ask explicitly:

```
Q3.4a  '<domain>' is not in CAPABILITY_CATALOG_V1. Do you want to:
       (a) swap it for a canonical one (suggestion: <closest>)
       (b) mark the squad as experimental_domains: true and proceed
       (c) cancel and revise
```

---

## Round 4 — Review

Present the resulting `squad.yaml` and ask:

```
Q4.1  Here is the generated squad.yaml:
       <pretty-print>

       Confirm creation at ${SQUADS_DIR}/<name>/? (yes/edit/cancel)
```

On "edit", go back to Round 1/2/3 as appropriate.
On "cancel", abort without writing anything.
On "yes", proceed to the scaffold.

---

## Deterministic scaffold

After confirmation, the LLM runs:

```bash
bun ~/.claude/skills/squads/scripts/init-squad.ts ${SQUADS_DIR}/<name> \
  --name <name> \
  --description "<description>" \
  --prefix <prefix> \
  --capability-id <cap_id> \
  --capability-description "<cap_description>" \
  --capability-domains "<d1,d2>" \
  --workflow-ref <workflow_name>
```

`init-squad.ts` replaces placeholders in `templates/squad.yaml.tmpl`,
creates the `agents/`, `tasks/`, `workflows/`, `schemas/` subdirs, and
writes `squad.yaml`.

After that the LLM:

1. For each declared agent, copies `templates/agent.md.tmpl` to
   `agents/<name>.md` and fills in the frontmatter (`maxTurns: 25`,
   `tools: [read, write]`, `model: sonnet`).
2. For each implicit task, copies `templates/task.md.tmpl`.
3. For each workflow, copies `templates/workflow.yaml.tmpl` and fills in
   `steps[]` with agent+task pairs.

---

## Final validation (loop until it passes)

```bash
bun ~/.claude/skills/squads/scripts/validate-squad.ts ${SQUADS_DIR}/<name>
```

If it fails, read the output and fix:
- capability error → revisit Round 3
- missing agent/task/workflow file → fill in the skeleton
- domain outside the catalog → confirm experimental_domains

Do not declare the squad ready until validation passes.

---

## Index and test

```bash
bun ~/.claude/skills/squads/scripts/index-squads.ts
bun ~/.claude/skills/squads/scripts/list-squads.ts --proto 5.0
```

The newly created squad must appear with `caps=N` matching the declared
capabilities.

---

## Operational notes

- The wizard works on **Claude Code**, **Codex** and **Gemini CLI** —
  use `AskUserQuestion` when available, otherwise inline prompts.
- The LLM must never **invent capabilities** or agents the user did not
  request (P5 Surgical Changes).
- If the user wants a legacy v4 squad, use `--legacy-v4`:
  `bun scripts/init-squad.ts ... --legacy-v4` (generates from
  `templates/squad-v4.yaml.tmpl`, without capabilities[]).
- If the user provides a brief like "crie uma squad para X" without
  details, the LLM runs Rounds 1-3 with `AskUserQuestion`. If the brief
  already has all the fields, skip to Round 4 (review).
- After scaffold + validation, always run `index-squads.ts` so the
  harness discovers the new squad.
