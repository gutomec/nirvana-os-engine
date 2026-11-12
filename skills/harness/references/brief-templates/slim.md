---
name: slim
description: Short brief with labelled lines; the user's words travel by path.
format: labels
required: [Request, Done when]
---

# Dispatch brief: slim

One brief per business (or per squad you dispatch directly), for its part of the
request: short, with what matters to do the work well, and pointers instead of
pasted content.

## The brief

```
Goal: <what done looks like and for whom, in one or two sentences; what another business covers instead>
Request: <the path `nrv brief request <name>` printed>
Decisions:
- <what the user already decided, one per line: squad <slug>, clone <slug>, runtime <rt>, a choice they made>
Inputs: <paths the work needs: attachments, another business's _SUMMARY.md>
Deliver: <what the deliverable is made of: files and formats; the engine sets the folder>
Done when:
- <a check that decides, by reference where one exists (a test, a schema, a rubric); end it with (blocking) when the delivery fails without it>
Session: new
```

At most 150 words besides the paths. A line with nothing to say is left out.

## Labels the engine reads

`Request` and `Done when` are required; `nrv brief check` refuses a brief
without them. Each label starts a line and ends in a colon; `Decisions` and
`Done when` take `-` bullets below. Each `Done when` bullet becomes a criterion
(`d1`, `d2`, ...) that the review and the gate check. `nrv brief decide` appends
to `Decisions`. `Session` is `new`, or `continue <project>` to continue that
project's worker session (the same as `--continue-from <project>`).

## How to write it

- **The goal, not a list of rules.** Say what done looks like and why it
  matters. Name a limit only where crossing it does harm.
- **What and why, never how.** No method, no steps, no seats, no file list the
  user did not ask for: those are the worker's.
- **Pointers, not pastes.** Name the files; the worker opens them when its
  work needs them.
- **What decides, by reference.** Point to the test, the schema, the mockup or
  the rubric that judges the work instead of describing it.
- **Nothing the worker can find** in its business folder, its seats or a squad card.
- **The user's words travel by path.** Write them once, unedited, with
  `nrv brief request <name>`, and put the path it prints on `Request`. The
  brief never retells them; the worker, the reviewer and the judges read that file.

## Squads, voices and runtimes

- `squad <slug>` only for a squad whose card you read (`nrv cards squad <slug>`)
  and that delivers a part no seat of the business covers. A squad `nrv find`
  listed and nobody read is a guess, not a decision.
- `clone <slug>` for a voice the user asked for: the slug `nrv find-clone`
  gives for the person they named or described. A name listed as a fact about
  the product is not a request.
- `runtime <rt>` when the user named a runtime for this part.

## What the run can prove

Ask only for what the run can prove under its settings. With
`execution.visual_checks` off (every profile but `max`) workers take no
screenshots and drive no GUI, so evidence of a visual review is the user's to
give, never a criterion. A brief does not describe or change settings;
`nrv config set` does, before the dispatch, when the user asked.
