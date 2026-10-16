---
name: detailed
description: The six sections plus Suggested structure and Method; one criterion per item, every artifact named.
format: sections
required: [Request (verbatim), Decisions, Your part, Inputs, Done when, Output]
---

# Dispatch brief: detailed

One brief per business (or per squad you dispatch directly), for its part of the
request, when the user wants the work done a set way: every item gets its own
criterion, every artifact is named, and the method is stated. Headings exactly
as below, content in the user's language.

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

## Suggested structure
<the structure you suggest: sections, order, outline; the worker may adapt it>

## Method
<the method the work must follow, step by step where it matters>

## Done when
- <one criterion per item the user asked for, each observable; end it with (blocking) when the delivery fails without it>

## Output
- <every artifact, one per line: file name and format; the engine sets the folder>
```

## Sections the engine reads

The six of the standard brief are required (`Request (verbatim)`, `Decisions`,
`Your part`, `Inputs`, `Done when`, `Output`); `Decisions` and `Inputs` may say
`None.`. `Suggested structure` and `Method` are left out when there is nothing
to say. Each top-level `Done when` bullet becomes a criterion (`d1`, `d2`, ...)
that the review and the gate check; `nrv brief decide` appends to `Decisions`.
`Request (verbatim)` may hold the path `nrv brief request <name>` printed.

## How to write it

- **Request (verbatim):** the user's own words, unedited; they win over any summary.
- **Decisions:** `squad <slug>` for a squad whose card you read
  (`nrv cards squad <slug>`), `clone <slug>` for a voice the user asked for (the
  slug `nrv find-clone` gives), `runtime <rt>` for a runtime they named.
- **Suggested structure:** sections, order, outline. The worker may depart from
  it and says where and why.
- **Method:** what the work must follow. Where it states none, the method is
  the worker's.
- **Done when:** one observable criterion per item the user asked for, by
  reference to a test, a schema or a rubric where one exists. Ask only for what
  the run can prove: with `execution.visual_checks` off (every profile but
  `max`) workers take no screenshots and drive no GUI.
- **Output:** every artifact the user receives, file name and format. The
  engine gives each run its folder, and the delivery check reads this list.

A brief does not describe or change settings; `nrv config set` does, when the
user asked.
