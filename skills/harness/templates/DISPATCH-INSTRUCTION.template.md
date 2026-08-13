---
target: {type}/{slug}
phase_id: {phase_id}
trace_id: {trace_id}
created_at: {iso_timestamp}
---

# Your mission in this dispatch

You are **{target_slug}** within project `{trace_id}`. This file is your specific scope. The full project context lives elsewhere — read it first.

## 1. Read the full context (mandatory, first action)

`Read` the file at `../../brief-enriched.md`. **Do not start producing** before reading it end-to-end. It contains the original brief, clarifications, the landscape, and the global dispatch plan.

## 2. Your specific part

You produce: **{your_deliverable_summary}**. Output goes under `outputs/`.

### Acceptance criteria for your part
- {criterion_1}
- {criterion_2}
- {criterion_3}

### Constraints
- {constraint_1}
- {constraint_2}

## 3. What ran before you (upstream phases)

{if depends_on empty:}
This is the first wave — nothing ran before you. Produce from `brief-enriched.md` alone.

{else: for each upstream phase}
- **{upstream_phase_id}** (`{upstream_target}`) — status: completed.
  - Read first: `../{upstream_target_dir}/outputs/_SUMMARY.md` (1-page exec summary).
  - Read deeper only if you need: `../{upstream_target_dir}/outputs/{specific_files_mentioned}`.
  - What they produced for you: {brief_description_of_handoff}.

## 4. What runs after you (downstream phases)

These phases will read your outputs. Produce them in the shape they expect.

{for each downstream phase in consumed_by}
- **{downstream_phase_id}** (`{downstream_target}`) needs from you:
  - `outputs/{file_1}` — {what_it_should_contain}
  - `outputs/{file_2}` — {what_it_should_contain}

## 5. Where you write

| What | Where |
|---|---|
| Final deliverables | `outputs/<file>` |
| Phase tracking | Update `HANDOFF.json` at each phase advance |
| **Executive summary (mandatory)** | `outputs/_SUMMARY.md` — 1 page max. Write this LAST. It's the public API for downstream phases. |
| Internal scratchpads | `scratch/` (gitignored, not consumed by anyone) |

## 6. Coordination rules

- **Discovered the plan needs to change?** Emit `plan_change_request` audit event + write `../../plan-change-requests/{target_slug}.md` with the change you propose and why. **Do not modify other phases' outputs.** The orchestrator decides whether to re-plan.
- **Need a sibling phase's intermediate result before they're done?** Emit `mention` event referencing their `outputs/` path; they may write partial files (clearly named `_PARTIAL_*`) that you can read.
- **Truly blocked** (missing credential, hard external dependency, conflicting requirements you can't reconcile): emit `notify_human` audit event with `reason` + `blocker` + abort cleanly. Do not improvise around blockers.

## 7. Scope isolation (hard rule)

You write **only** under your own target directory (`{target_dir}/`) and the shared coordination paths (`../../plan-change-requests/`, `~/.harness-logs/<date>/audit.jsonl`). You **never** write to other targets' `outputs/` directories.

## 8. If your deliverable is prose, check it before you hand it back

This section travels with the dispatch because it cannot be assumed to be
anywhere else. The writing contract lives in the project's `CLAUDE.md` /
`AGENTS.md`, which only exists when the project was created with `nrv init` —
most are not. Without it you would be judged at the gate by a rule nobody gave
you.

The rules the gate actually applies to `.md` and `.txt`:

- **Dashes.** Em-dash and en-dash: at most one per 200 words. Hyphens only for
  compound words and ranges. Never a dash to glue two clauses, replace a comma,
  hedge, or add emphasis.
- **No filler openers.** "In summary", "In conclusion", "It's worth noting",
  "Em resumo", "É importante notar".
- **No vague attribution.** "Experts say", "Studies show", "Especialistas
  afirmam". Name the source with a date or drop the claim.
- **No negative parallelism.** "Not only X, but Y" / "Não é só X, é Y".
- **No chat artifacts** ("Great question!", "I hope this helps", "Espero que
  ajude") and no AI self-reference.
- Sentence case in headings, no decorative emoji, varied sentence length.

The dash budget is the one that gets missed, because it is quantitative and
nobody counts while drafting. A 2.400-word report gets **12** — a real dispatch
came back with 38 and had to be rewritten. So do not rely on judgement; run the
check:

```bash
bun ~/.nirvana/skills/harness/scripts/quality-gate.ts <your-artifact> --auto
```

Exit 0 means it passes. Fix what it flags and re-run until it does, **before**
writing `_SUMMARY.md` and handing back. Catching it here costs one re-read;
catching it at the gate costs a full rewrite of a finished document.
