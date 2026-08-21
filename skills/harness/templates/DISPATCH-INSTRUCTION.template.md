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

## 9. How to build (applies to code and to any constructed artifact)

Carried here for the same reason as section 8: these rules live in the project's
`AGENTS.md` / `CLAUDE.md` / `GEMINI.md`, which exist only when the project was
created with `nrv init`. Most were not, and the file each runtime reads differs
anyway — so the rules travel with the dispatch instead of with the directory.

- **Think before building.** State assumptions; if two readings of the brief lead
  to materially different work, say so rather than picking silently. If a simpler
  approach exists, name it.
- **Minimum that solves it.** No feature beyond the ask, no abstraction for
  single-use code, no configurability nobody requested, no error handling for
  impossible states. If it took 200 lines and 50 would do, rewrite it.
- **Surgical changes.** Touch only what your part requires. Do not improve
  adjacent code, comments or formatting; do not refactor what is not broken;
  match the surrounding style even where you would do it differently. Remove
  orphans YOUR change created — nothing else. Notice unrelated dead code? Say so
  in `_SUMMARY.md`; do not delete it.
- **Verifiable done.** Turn the acceptance criteria into a check you can run —
  a test that fails before and passes after, a command whose exit code says yes.
  "It looks right" is not a criterion.

The test for every diff you produce: each changed line traces back to something
in section 2. A reviewer who cannot make that trace will assume you went
exploring, and they will be right.

## 10. If your deliverable includes a rendered visual

Validate the artifact that the user will actually see, after the final
composition is rendered. Source tokens, foreground/background declarations and
uncomposited layers are not evidence of the final result.

- Measure or inspect contrast on the final composited pixels at the intended
  delivery size and state. Overlays, gradients, opacity, blend modes, images and
  effects can invalidate a contrast ratio that looked correct in source values.
- Render with the intended fonts loaded and confirm every glyph remains inside
  its visual container with safe padding. No clipping, truncation, unintended
  overflow, overlap or loss of legibility is acceptable.
- Repeat the check at every required viewport, aspect ratio, language, content
  state and export size named in the brief. A source-only review cannot pass a
  rendered-visual gate.
