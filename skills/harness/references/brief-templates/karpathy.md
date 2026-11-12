---
name: karpathy
description: Slim, in plain controlled language, plus an explain-back (plain summary, a diagram, an HTML explainer when it helps). Costs more tokens per delivery.
format: labels
required: [Request, Done when]
---

# Dispatch brief: karpathy

The slim brief, plus one more thing: the worker explains its result back in the
format a person reads fastest. The idea is Andrej Karpathy's (post on X,
2026-10-02: https://x.com/karpathy/status/2105819303471976479; and the
"2025 LLM Year in Review": https://karpathy.bearblog.dev/year-in-review-2025/).
More of our work is to oversee and understand what a model made, and a large,
custom, discardable artifact is now cheap enough to make just to understand
something.

This template costs more tokens per delivery than slim. Use it when the user
asked for it.

## The brief

```
Goal: <what done looks like and for whom, in one or two sentences>
Request: <the path `nrv brief request <name>` printed>
Decisions:
- <what the user already decided, one per line: squad <slug>, clone <slug>, runtime <rt>, a choice they made>
Inputs: <paths the work needs>
Deliver: <the files and formats of the work>; _SUMMARY.md with one diagram; _explain/ for the HTML explainer
Explain back:
- _SUMMARY.md about 80% of the way to ASD-STE100, in the user's language: short sentences, active voice, no jargon; every number, name and path exact
- One diagram of how the result works or where things are: Mermaid in _SUMMARY.md, or an SVG in _explain/
- An interactive HTML explainer (one self-contained file in _explain/) only when the work has data or structure worth exploring; if you skip it, say why in _SUMMARY.md
- An explainer video only when the request asks for one
Done when:
- <a check that decides, by reference where one exists; end it with (blocking) when the delivery fails without it>
- _SUMMARY.md explains the result in plain language and holds a diagram, or names the SVG (non-blocking)
- The HTML explainer exists in _explain/, or _SUMMARY.md says why it was not made (non-blocking)
Session: new
```

At most 150 words besides the paths and the Explain back lines. A line with
nothing to say is left out; the Explain back lines stay.

## Labels the engine reads

`Request` and `Done when` are required; `nrv brief check` refuses a brief
without them. Each label starts a line and ends in a colon; `Decisions`,
`Explain back` and `Done when` take `-` bullets below. Each `Done when` bullet
becomes a criterion (`d1`, `d2`, ...) for the review and the gate. The explain-back
checks are `(non-blocking)`: they count toward the score and never withhold the
work. `Session` is `new`, or `continue <project>`.

## How to write it

Write the brief itself in plain controlled language: short sentences, active
voice, one term for one thing. Do not force strict ASD-STE100: a strict rewrite
drops facts, and a dropped fact in a brief is a dropped requirement. Numbers,
names, paths, quotes and the user's own words are never simplified.

- **The goal, not a list of rules.** Say what done looks like and why.
- **What and why, never how.** Method, steps and seats are the worker's.
- **Pointers, not pastes.** Name the files; the worker opens them.
- **What decides, by reference:** the test, the schema, the rubric.
- **The user's words travel by path** (`nrv brief request <name>`), never retold.
- `squad <slug>` only for a squad whose card you read (`nrv cards squad <slug>`);
  `clone <slug>` for a voice the user asked for (`nrv find-clone`).

## What the run can prove

The explain-back files live in `_explain/` and in `_SUMMARY.md`, which the
quality gate does not judge as deliverables, so the project's prose rules
cannot fail the work over them. With `execution.visual_checks` off (every
profile but `max`) the worker makes the diagram and the HTML page but takes no
screenshots and drives no GUI to check them, and no criterion asks for that.
A brief does not change settings; `nrv config set` does, when the user asked.
