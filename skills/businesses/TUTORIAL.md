# Step-by-step tutorial · businesses skill

> From zero to a first business deliverable. About 30 minutes. Protocol reference: `BUSINESS_PROTOCOL_V2.md`.

This tutorial assumes the Nirvana-OS engine is installed (`nrv` and Bun on PATH).

---

## Scenario

You run a SaaS product called **Beta Studio**, an online video production course. You want an internal agency for content, sales and support: a business with four seats (CEO, marketing lead, sales lead, and a QA antagonist).

At the end you will have a validated, indexed business, one brief dispatched to it, and the audit trail of the run.

A dispatched business runs as **one agent** that plays its seats by opening their files (`BUSINESS_PROTOCOL_V2.md` §14). The seats are the business's structure and method, not separate running processes.

---

## Step 1: look at what exists

```bash
nrv list-businesses
bun ~/.nirvana/skills/businesses/scripts/inspect-business.ts <slug>
```

Pick a business close to what you want and read its seats, intake and antagonist.

---

## Step 2: scaffold the business

```bash
bun ~/.nirvana/skills/businesses/scripts/init-business.ts beta-studio --template council
```

Templates are `solo`, `council`, `agency` and `conglomerate`. The scaffold is created under `~/businesses/beta-studio/` (or the project's `.nirvana/businesses/` in a scoped project) and the admission gate runs over it in `--fix` mode, so `.nirvana-surface.json` is already on disk.

You get `business.yaml`, `org-chart.yaml`, `routing.yaml`, `employees/*.md`, `memory/permanent.md` and a README.

---

## Step 3: author what the gate cannot invent

Edit the files so they describe Beta Studio.

**`business.yaml`**: a concrete `description`, `domains`, and the routing metadata of §6.9: `produces`, `keywords` (EN and PT, with and without accents), at least three `example_briefs` (one EN, one PT), and short `not_for` fences that are true even if nothing else were installed. Optional: `squads_preferred`, `run_budget_usd`, and `review: required` if every delivery must be reviewed.

**Seats** (`employees/*.md`): four seats here.

| Seat | Role | `reports_to` | Flags |
|---|---|---|---|
| `beta-ceo` | CEO | none | `is_brief_intake: true` |
| `beta-marketing-lead` | Marketing lead | `beta-ceo` | |
| `beta-sales-lead` | Sales lead | `beta-ceo` | |
| `beta-qa` | QA | `beta-ceo` | `is_antagonist: true` |

Each body needs its own method (Identity, Guidelines, Process, Output, Anti-patterns). Give the intake seat an `acceptance[]`: that list is the contract the judge checks (§11). Pin a clone with `pinned_mind_clones` only for a seat whose identity is a voice; `assigned_mind_clones` is a hint.

**`routing.yaml`**: `brief_intake.default_employee: beta-ceo`, and `auto_routes` whose patterns each fire on one of your `example_briefs` (§13.2).

BP7 only applies above five seats, so the antagonist is optional here. With six or more it is required.

---

## Step 4: validate

```bash
nrv validate business beta-studio --strict
```

This runs the 41-criterion catalog of §16.2. Exit `0` means admitted. Fix mechanical findings with `--fix`; authorship findings (`acceptance_missing`, `seat_thin`, `routing_metadata_incomplete`, `auto_route_never_fires`) are yours to write. Add `--json` for the machine report.

Two more checks a new business must pass:

```bash
bun ~/.nirvana/skills/_shared/scripts/check-seat-sufficiency.ts beta-studio --strict
bun ~/.nirvana/skills/_shared/scripts/self-retrieval-gate.ts beta-studio
```

---

## Step 5: index and confirm discovery

```bash
nrv index
nrv find "launch a new filmmaking course"
```

`nrv find` is a diagnostic: it shows what the keyword router surfaces. If `beta-studio` does not appear, fix its `example_briefs`, `keywords` and routes, then re-index.

---

## Step 6: write a brief

The orchestrator writes one brief per business, in six sections:

```bash
nrv brief template > .nirvana/briefs/beta-studio.md
# fill: Request (verbatim), Decisions, Your part, Inputs, Done when, Output
nrv brief check .nirvana/briefs/beta-studio.md
```

Say what and why, never how. Mark with `(blocking)` the "Done when" items the delivery cannot fail on.

---

## Step 7: dispatch

```bash
nrv dispatch beta-studio --brief-file .nirvana/briefs/beta-studio.md --exec [--review | --no-review]
```

The engine builds the worker's prompt (a map of the brief, the business folder, the memory, the seats and the squad cards), starts one agent, and waits for it. The agent works in phases, keeps `_work/PROGRESS.md`, uses squads by reading their work cards (`nrv cards squad <slug>`), and ends with `_SUMMARY.md`, `_CLAIMS.json` and `participation.json`.

A decision you take while it runs reaches the worker without stopping it:

```bash
nrv brief decide .nirvana/briefs/beta-studio.md "<the decision>"
```

Then the engine decides on a review by rule (`review.policy`; `review: required` in the manifest forces it under the default rule), runs the verification and the quality gate, and delivers. Read `<outputs>/_SUMMARY.md`, and `_QA-RESERVATIONS.md` if it exists.

---

## Step 8: inspect the audit trail

```bash
nrv audit-tail
```

Look for `brief_received`, `dispatch_business`, `x_business_solo_started`, one `x_seat_credited` per seat the worker declared, `agent_executed`, then `gate_passed`. Without those events the run did not happen.

---

## Step 9: iterate

- **New seat**: add `employees/<name>.md`, re-run `nrv validate business beta-studio --fix`, which regenerates `org-chart.yaml` and the surface.
- **New route**: edit `routing.yaml`, validate, `nrv index`.
- **Change intake**: move `is_brief_intake: true` to the other seat; exactly one is allowed.
- **Memory**: live memory is in `.nirvana/memory/businesses/<slug>/` (machine scope) and in the project's `.nirvana` (project scope), never in the business folder. `nrv memory relocate --apply` moves strays.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `org_chart_inconsistent` | `reports_to`/`manages` and the chart disagree | `nrv validate business <slug> --fix` rederives the chart from the frontmatter |
| `antagonist_bp7` | more than 5 seats and no antagonist | set `is_antagonist: true` on one seat (a QA role fits) |
| `intake_exactly_one` | zero or several intake seats | set `is_brief_intake: true` on exactly one |
| `employee_frontmatter_invalid` | unknown key or bad value (frontmatter is strict) | remove or fix the key; the finding names it |
| Slug rejected | uppercase or special characters | kebab-case, `^[a-z][a-z0-9-]{1,63}$` |
| Business never routed to | metadata too thin or not re-indexed | complete §6.9 fields, run the self-retrieval gate, `nrv index` |
| `description` rejected | under 20 characters | write a concrete description |

---

## Next steps

- Migrate a Paperclip company (`BUSINESS_PROTOCOL_V2.md` §21).
- Read `BUSINESS_PROTOCOL_V2.md` §14 for the exact execution model and §16.2 for the full gate catalog.
- See `README.md` and `CONFIGURATION.md` for the CLI reference and every configurable field.
