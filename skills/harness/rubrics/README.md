# Rubrics — Phase 3 (Quality Gate with Revision Loop)

Each rubric lives in a `<name>.md` file with YAML frontmatter declaring:

```yaml
---
name: prose_shortform                # internal slug
display_name: "Prose — Shortform …"  # human-readable
type: harness_rubric                  # REQUIRED — the loader's filter
version: 1.0.0
target_model: inherit
pass_threshold: 75                    # 0-100; below this → fail
applies_to_produces:                  # list of `produces` slugs that trigger this rubric
  - blog-post
  - instagram-post
description: |
  Short description of the rubric's scope.
---
```

After the frontmatter, the Markdown body contains:
- `## Inputs` — JSON schema of the fields the judge receives
- `## Criteria` — numbered list of criteria with weights (normally summing to 100)
- `## Output schema` — schema of the judge's JSON response

## Components that consume rubrics

| Module | Function |
|---|---|
| `lib/rubric-selector.ts` | Loads every rubric; maps `produces[]` → applicable rubrics. |
| `lib/judge.ts` | Receives `(rubric, artifact)`, invokes the host agent (Claude Code / Codex / Gemini), validates the response against the schema. |
| `lib/critique.ts` | Turns a critique into an actionable revision instruction. |
| `lib/revision-dispatch.ts` | Orchestrates `judge → critique → revise → judge` in a loop until it converges or exceeds `max_revisions`. |

## When the judge runs

`quality_gate.judge_enabled` has three values:

- `reports` (default): the judge evaluates the text deliverables (`.md`, `.txt`) against the brief; code, images and data stay on the heuristic rubrics.
- `true`: the judge evaluates every file the gate covers.
- `false`: offline heuristics only.

With `delivery.produces_to_rubric` (on by default), the target's `produces[]` picks the domain rubric, such as `data_research` for a research piece; a produces with no rubric falls back to the rubric the extension indicates.

1. To change the mode: `nrv config set quality_gate.judge_enabled <reports|true|false>`.
2. The delivery pipeline (`lib/delivery-pipeline.ts`) calls the gate with the run's brief.
3. Run `bun test skills/harness/tests/` to confirm 100%.
4. Monitor the audit log for the new events:
   - `judge_invoked` — judge LLM call started
   - `critique_generated` — verdict + critique returned
   - `revision_dispatched` — re-invocation with a revision instruction
   - `revision_loop_exhausted` — `max_revisions` reached without converging

## When to create a new rubric

When a new deliverable type does not match any of the 8 existing ones:

1. Define the `produces` slug (e.g. `podcast-episode`).
2. Create `<name>.md` in this directory with complete frontmatter.
3. Ensure ≥ 5 criteria with weights summing to 100.
4. Include the JSON output schema.
5. Add tests in `tests/rubric-selector.test.ts` covering the mapping.
6. Run the suite.

## When NOT to create a rubric

- For a small variation of an existing type (e.g. an Instagram "carousel" → use `prose_shortform` with a hint).
- For a single one-off test — use `mock_judge` instead.
- For a change to an existing criterion — version the existing rubric, do not create a new one.

## Hard gates (an individual failure fails the artifact without revision)

Some rubrics declare criteria with a **HARD GATE** in the body:

- `data-research.md`: `source_grounding` (no source = full regeneration)
- `juridical.md`: `citation_verifiability` (an invented citation = full regeneration)
- `design.md`: `wcag_2_2_AA` (accessibility failure)
- `image.md`: traditionally `no_artifacts` when critical

`judge.ts` must flag severity:"high" on any of these items; the loop then
decides whether to accept a revision (severity high is fixable=true) or abort (fixable=false).
