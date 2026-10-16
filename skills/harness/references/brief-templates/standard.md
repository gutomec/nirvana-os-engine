---
name: standard
description: The six-section brief (Request verbatim, Decisions, Your part, Inputs, Done when, Output).
format: sections
required: [Request (verbatim), Decisions, Your part, Inputs, Done when, Output]
---

# Dispatch brief: standard

One brief per business (or per squad you dispatch directly), for its part of the
request. Six sections, headings exactly as below, content in the user's
language. It says what and why, never how.

## The brief

```
## Request (verbatim)
<the user's own words, pasted, unedited>

## Decisions
- <what the user already decided in the conversation, one per line; "None." when there is none>

## Your part
<what THIS business delivers, and what another business covers instead>

## Inputs
- <paths: attachments, another business's _SUMMARY.md; "None." when there is none>

## Done when
- <an observable criterion; end it with (blocking) when the delivery fails without it>

## Output
<what the deliverable is made of: files and formats; the engine sets the folder>
```

## Sections the engine reads

All six are required; `Decisions` and `Inputs` may say `None.`. Each top-level
`Done when` bullet becomes a criterion (`d1`, `d2`, ...) that the review and the
gate check; `nrv brief decide` appends to `Decisions`. `Request (verbatim)` may
hold the path `nrv brief request <name>` printed instead of the pasted words.
An optional `## Suggested structure` (sections, order, outline) above
`## Done when` is a structure the worker may adapt, saying why.

## How to write it

- **Request (verbatim):** the user's own words, unedited. They win over any
  summary, so a bad paraphrase is caught.
- **Decisions:** what the user already settled. `squad <slug>` for a squad whose
  card you read (`nrv cards squad <slug>`) and that delivers a part no seat
  covers; `clone <slug>` for a voice the user asked for, the slug
  `nrv find-clone` gives; `runtime <rt>` for a runtime they named for this part.
  A squad nobody read is a guess, and a name listed as a fact about the product
  is not a request for a voice.
- **Your part:** what this business delivers, and what another one covers.
- **Inputs:** the paths the worker needs, never their content.
- **Done when:** observable criteria, by reference to a test, a schema or a
  rubric where one exists. Mark with `(blocking)` the ones the delivery fails
  without. Ask only for what the run can prove: with `execution.visual_checks`
  off (every profile but `max`) workers take no screenshots and drive no GUI.
- **Output:** files and formats. The engine gives each run its folder.

No method, no steps, no seats, no file list the user did not ask for. A brief
does not describe or change settings; `nrv config set` does, when the user asked.
