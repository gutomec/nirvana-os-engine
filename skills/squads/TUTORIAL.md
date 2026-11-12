# Tutorial: your first v6 squad

From nothing to a validated, discoverable squad, then using it on its own and from a business. About 30 minutes. It assumes the engine is installed (`nrv` on PATH). The rules behind each step are in `SQUAD_PROTOCOL_V6.md`.

## The scenario

A reusable squad that scans a SaaS competitor: it takes a competitor name, researches it, and returns a one-page market-fit report. You will build `competitor-analyzer-quick` with:

- one capability, `research.competitor.quick_scan`
- two agents, `web-researcher` and `report-synthesizer`
- two tasks, `scan-competitor` and `synthesize-report`
- one workflow, `quick-scan`

## Step 1. Look at a mature squad

```bash
nrv list-squads --format table | head
cat ${SQUADS_DIR:-~/squads}/<some-squad>/squad.yaml | head -60
```

Note the top level: `name`, `version`, `protocol`, `description`, `capabilities[]`, `components`, `runtime_requirements`.

## Step 2. Scaffold

```bash
SQUAD_AGENT_1=web-researcher SQUAD_AGENT_2=report-synthesizer \
SQUAD_TASK_1=scan-competitor SQUAD_TASK_2=synthesize-report \
bun ~/.nirvana/skills/squads/scripts/init-squad.ts ${SQUADS_DIR:-~/squads}/competitor-analyzer-quick \
  --name competitor-analyzer-quick \
  --description "Researches a SaaS competitor and writes a one-page market-fit report." \
  --capability-id research.competitor.quick_scan \
  --capability-domains "research,strategy" \
  --workflow-ref quick-scan
```

This writes `squad.yaml`, `workflows/quick-scan.md`, stub agents and tasks, and runs the create gate. The directories are `agents/`, `tasks/`, `workflows/` and `schemas/`.

## Step 3. Fill in the manifest

Open `squad.yaml` and replace every placeholder in the capability (`SQUAD_PROTOCOL_V6.md` §22):

- `description`: 20 to 1,500 characters, in English, front-loaded with what it delivers: "Researches a SaaS competitor on the web and writes a one-page market-fit report: positioning, pricing, strengths, gaps."
- `domains`: 1 to 5 from `skills/_shared/catalogs/CAPABILITY_CATALOG_V1.yaml`.
- `examples`: natural intents ("analyze our competitor Notion", "analisar o concorrente Notion").
- Routing metadata: `produces` (`competitor-report`), `keywords` (English, Portuguese and unaccented groups), three or more `example_briefs` (at least one English and one Portuguese, phrased as a real user would), and `not_for` entries of at most 25 characters (`"consumer apps"`, `"legal review"`). A `not_for` states what the squad never does, not what a neighbour does better (§33.1).
- `acceptance`: binary criteria the judge will charge, for example `{ id: one_page, description: "the report fits one page and covers positioning, pricing, strengths and gaps", blocking: true }`.

## Step 4. Write agents and tasks

An agent (`agents/web-researcher.md`) has frontmatter with `name`, `description`, `maxTurns`, `tools`, then a short body: identity, `# Guidelines` (`## DO`, `## DO NOT`), `# Process`, `# Output`, `# Safety Boundaries`. `templates/agent.md.tmpl` is the shape.

A task (`tasks/scan-competitor.md`) states its outcome, not its method:

```markdown
---
name: scan-competitor
description: "Collects positioning, pricing and product facts about one competitor from public sources"
---

# Scan competitor

## Outcome
A sourced fact sheet on the competitor: positioning, pricing tiers, main features, and a link for each claim.

## Input
The competitor name and the market it competes in.

## Output
`fact-sheet.md` in the run directory.

## Acceptance Criteria
- Every claim has a source link.
- Pricing is listed per tier, or marked as not public.
```

No `## Steps` section unless the order is itself a requirement (§36).

## Step 5. Write the workflow

`workflows/quick-scan.md` is one document: frontmatter is the graph, the body is prose per step.

```markdown
---
name: quick-scan
description: "Scans the competitor, then synthesizes the report"
version: "1.0.0"
steps:
  - id: scan
    agent: web-researcher
    task: scan-competitor
    creates: [fact-sheet]
  - id: synthesize
    agent: report-synthesizer
    task: synthesize-report
    requires: [scan]
    creates: [report]
success_indicators:
  - "the report fits one page"
---

## scan

Read the competitor's site, pricing page and two independent reviews. Hand the fact sheet to the next step.

## synthesize

Turn the fact sheet into the one-page report. Cut anything without a source.
```

Rules: `name` equals the file name, a `task` is a reference to `tasks/<task>.md` and never prose, and `requires` lists step ids (§28.1).

## Step 6. Validate and fix

```bash
nrv validate squad competitor-analyzer-quick
nrv validate squad competitor-analyzer-quick --fix     # mechanical repairs, backup, rollback
```

Errors block, warnings advise, and `--strict` makes warnings reject too. The catalog is in `SQUAD_PROTOCOL_V6.md` §34.1. Add `dependencies.yaml` and a `README.md` to clear the quality warnings.

## Step 7. Index and check routing

```bash
nrv index
nrv find "analyze our competitor Notion and write a one-page report"
bun ~/.nirvana/skills/_shared/scripts/self-retrieval-gate.ts competitor-analyzer-quick
```

`nrv find` prints the signal (`MATCH_HIGH`, `MATCH_AMBIGUOUS` or `NO_MATCH`), the capability and the score. The gate checks that each of your `example_briefs` finds this squad first. Creation is not finished until it passes.

## Step 8. Run the squad on its own

```bash
nrv dispatch --squad competitor-analyzer-quick:research.competitor.quick_scan "Analyze Notion" --exec
```

One agent plays the whole squad: it reads the capability, the workflow table, the agents and tasks the workflow references, and writes the deliverable to the run's output directory. `:<capabilityId>` is optional: with one capability it is implied, with several it is chosen by the brief (§32.2).

## Step 9. Use it from a business

A business runs as one agent. It never dispatches the squad; it reads the squad's work card and works as its agents:

```bash
nrv cards squad competitor-analyzer-quick
```

The card is built from frontmatter at run time: one line per capability, agent, task and workflow, each with the file to open (§32.3). Write clear `description` fields, because that is what the card shows.

## Step 10. Maintain

- After editing the manifest or workflows, `nrv validate squad <slug>` and `nrv index`.
- Declare external programs and credentials in `dependencies.yaml`, then `nrv activate competitor-analyzer-quick`.
- To convert a v5 squad: `nrv migrate <slug> --to 6` (dry run), then `--apply` (`references/09-upgrade.md`).
- Never install packages inside the squad: use `nrv deps install` (`nrv deps status` shows where things are).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `workflow_ref_unresolved` | A step names an agent or task with no file. Create it, or fix the name |
| `invoke_ref_extension` | Write `invoke.ref: workflows/quick-scan`, without extension |
| `not_for_too_long` | Shorten to two to four words |
| `routing_metadata_incomplete` | Add `keywords`, three `example_briefs` (English and Portuguese) and `not_for` |
| `nrv find` returns `NO_MATCH` | Rewrite the capability `description` and `example_briefs` in the vocabulary of a real request |

More: `CONFIGURATION.md` for flags and settings, `references/` for per-topic guides, `SQUAD_PROTOCOL_V6.md` for the rules.
