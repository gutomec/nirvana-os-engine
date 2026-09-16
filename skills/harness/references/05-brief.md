# The enriched brief: shape by altitude

The enriched brief at `.nirvana/briefs/<trace_id>-enriched.md` is the one document every executor reads first. Its altitude is the `briefing.altitude` setting (`nrv config set briefing.altitude <value>`, `NIRVANA_BRIEF_ALTITUDE`, `--brief-altitude`): `outcome` by default, `guided`, or `prescriptive`. A request that says "brief detalhado" or "brief prescritivo" raises the altitude for that run; "brief simples" lowers it.

Why `outcome` is the default (vendor guidance for 2026 models): Claude Fable 5.1 "can execute very long tasks without much guidance on methodology, especially when the goal is clear"; Claude Opus 5 "performs best when given the complete task specification up front and left to run" and "verifies its own work without being told to"; for GPT-6 Astra, "overly specific guidance can now hinder results where it previously helped". A brief for these models states the result, not the method.

## `outcome` (default)

Eight sections, in this order, each as short as the truth allows. Nothing else.

1. `## Pedido (verbatim)`: the user's words, untouched.
2. `## Intenção e porquê`: one paragraph on what the user wants to exist, for whom, and why it matters. The why is what lets the executor make the calls the brief did not foresee.
3. `## Referências`: paths and URLs only (project files, upstream `_SUMMARY.md`, sources the research found, the `## Escolhas de stack` table when the freshness gate fired). Never paste content the executor can open.
4. `## Guarda-corpos`: hard constraints only: the language of the deliverable, what must not change, legal or brand limits, the budget when one is set. A preference is not a guardrail; leave it out.
5. `## Pronto quando`: three to five observable statements that are true when the work is done. End states ("the report answers the three questions with dated sources"), never steps, never a file inventory. When the user named a file, name that file; do not add others.
6. `## Verificação`: how the executor proves the end states (a command, a check, a read-back). The quality gate runs after hand-back; it is not the executor's job.
7. `## Parar quando`: the end states are true, or a blocker only the user can lift.
8. `## Autonomia`: the fixed sentence. "Method, depth and artifact layout are yours to decide. Make routine judgment calls yourself, record the assumptions you relied on under `## Premissas assumidas` in the main deliverable, and check in only when different readings of the request would lead to materially different work."

What `outcome` never contains: numbered procedures, a list of artifacts the user did not ask for, per-item formats, instructions to re-check or to run the gate, examples of output, code.

## `guided`

`outcome` plus one section, `## Estrutura sugerida`: the decomposition the author proposed (the workflow's steps as a reference, the canonical artifacts when the squad declares them), labelled as a suggestion. Use it when the brief feeds a chain of seats and the shape of the hand-off matters.

## `prescriptive`

The shape engines up to 0.13.9 produced: acceptance criteria per item, the full artifact list with paths, constraints per section, an explicit method. Use it for smaller or older models, or for regulated deliverables where the form is the requirement.

## Guard rails for the orchestrator

- The scope guard sentence still travels with every dispatch (`skills/_shared/lib/scope-guard.ts`).
- The brief scorer (`lib/brief-scorer.ts`) weighs objective, purpose, constraints and definition of done. It no longer asks for examples or in/out scope.
- Length is decided by the deliverable, not by the brief: "cover the substance, but do not pad" is the executor's rule for documents.
