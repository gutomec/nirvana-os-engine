# Hierarchical review — the superior is the reviewer

**Status:** proposal · **Date:** 2026-09-04 · **Language:** English (engine documentation)

A business runs its org chart. Each seat's work is reviewed by its immediate
superior, against the criteria that seat declares. Approved work rises; the head
of the house signs for the delivery and hands the orchestrator a short receipt.

This document says how it works, what it touches, what is already built, what
proves it will work — and what would prove it will not.

---

## 1. Why, in one measurement

A run on 2026-09-04, on two installed businesses with 23 seats between them:

```
business A    9 seats  →  1 dispatch_business, 0 per-employee events, 0 clones
business B   14 seats  →  1 dispatch_business, 0 per-employee events, 0 clones
```

The deliverables credited six seats by name. None had a dispatch event behind it.
Work attributed to people who did not work is the fiction the audit exists to
prevent, and it was not anyone's bug: no procedure existed for walking an org
chart from an interactive session.

Two separate defects produced it, both now fixed:

- The prep step every business dispatch runs (`brief-business.ts`) ended with
  *"Next step: Spawn employee `<intake>`"* — one seat, in the output the caller
  actually reads.
- The director's rule asked who was **capable**. The same model sits in every
  chair, so "the synthesizer could do this" is always true, and every chain
  collapsed to one seat.

Fixing those makes the chain form. This document is about what happens next: who
checks the work.

## 2. The gap this closes

Today the quality gate is a rubric-driven judge that is not a seat and has no
domain. It asks whether a document is well-formed, not whether the argument
holds. A backend lead reading a backend engineer's diff knows things a rubric
cannot express, and the business already declares who that lead is.

The review also gives the org chart a job. It is validated on every business and
read by nothing — `fromOrgChart()` in `dag-planner.ts` has zero callers, because
it maps `deps = reports[]`, which is backwards for execution. For **review** it
is exactly right: the result rises through `reports`.

## 3. How it works

```
orchestrator picks the business
   │
   ├─ team plan → route: which seat executes, and the review path above it
   │              (derived from org-chart.yaml, not invented)
   │
   ├─ team step --index n        → the executor's prompt, clone injected
   │     └─ executor works, writes to its outputs dir
   │
   ├─ team step --review --of <seat>   → the IMMEDIATE superior's prompt:
   │        the brief (company-level and seat-level), the subordinate's
   │        declared acceptance[], and the artifact. Returns a verdict object.
   │
   │     rejected → back to the executor IN THE SAME SESSION, with the
   │                unconfirmed criteria and the evidence gap named
   │     approved → rises one level
   │
   ├─ each level above countersigns (cheap: aggregate, not a re-read)
   │
   └─ the head returns a receipt to the orchestrator:
      what passed, who did what, where the files are — three lines
         │
         └─ engine gate (unchanged, fail-closed) → delivered
```

### 3.1 The reviewer answers a form, not a question

The rubber-stamp risk is the whole design problem: the same model asked "is your
subordinate's work good?" says yes. The defence is to make approval **expensive
to fake and cheap to verify** — the reviewer fills a structured object, and an
entry exists only when it was confirmed with evidence.

```json
{
  "seat": "sf-backend-lead",
  "reviewing": "sf-backend-engineer",
  "confirmed": [
    {
      "id": "objections_specific_and_falsifiable",
      "evidence": "src/queue/consumer.ts:88 — retry has no ceiling; test at tests/queue.test.ts:41 reproduces",
      "note": ""
    }
  ],
  "unconfirmed": [
    { "id": "test_strategy_by_layer_with_targets", "why": "no coverage target stated for any critical module" }
  ],
  "verdict": "rejected",
  "score": 0.66
}
```

Rules that make this work:

- **`id` must match an acceptance id from the subordinate's own frontmatter,
  verbatim.** An id that does not exist is dropped and logged; a review of
  invented criteria is not a review.
- **A criterion appears under `confirmed` only with evidence** — a path, a line,
  a quote. Empty evidence moves it to `unconfirmed`. Silence is not approval.
- **Anything not mentioned counts as unconfirmed.** A reviewer that writes
  `{"verdict":"approved"}` and nothing else scores zero and fails. This is the
  property that defeats the stamp: laziness produces rejection, not approval.
- **`score` = confirmed ÷ total applicable, floor 0.90.** Not 1.0: one
  unconfirmable micro-check should not block a good delivery. The author keeps
  the escape hatch already in the protocol — a criterion marked
  `blocking: true` must be confirmed regardless of score, which is how a business
  says "this one is absolute."
- **The engine recomputes the score.** The reviewer reports observations; the
  arithmetic is not its opinion.

`readAcceptance(bizDir, [seat])` already returns exactly this list, deduped, with
`blocking` and `minimum_score` per entry, and defaults its floor to 0.92 — one
line from the 0.90 proposed here.

### 3.2 Correction keeps the session

A rejected step goes back to the executor through `runWithSession`, which already
resumes the entity's session per project and falls back to one cold attempt when
the resume fails. The executor does not re-derive its context; it is told which
criteria came back unconfirmed and what evidence was missing.

Ceilings already exist and apply unchanged: `NIRVANA_MAX_GATE_RETRIES` and the
loop guard (`max_steps`, `max_repeat`, `max_flat_steps`). A review loop that will
not converge ends in delivery **with reservations**, not in a stall.

### 3.3 Only the immediate superior reads

Every level above aggregates and countersigns. Without this rule a five-level
chart reads the same artifact five times, and the cost argument in §5 collapses.

### 3.4 The engine gate stays, last

The superior answers *is this good work in my domain, and does it match what was
asked*. The engine's gate answers *is there a deliverable at all, is it a stub,
does it match the promised manifest* — deterministically, fail-closed, for free.

A model asked "is this a stub?" is usually right and fails **open**;
`isDeliverable` fails **closed** and cannot be talked out of a verdict. The
superior judging it too is more eyes, not a replacement. Losing fail-closed would
give back something this engine earned the hard way: `gateableFiles`, exit 2 for
withheld, `_QA-RESERVATIONS.md`, and the completeness ceiling that outranks
acceptance.

## 4. What it touches

### Already built — no work

| Piece | Where | State |
|---|---|---|
| `org-chart.yaml` with `reports` | every business | validated, loaded, unused |
| `fromOrgChart(chart)` → `deps = reports[]` | `dag-planner.ts:134` | written, zero callers, right shape for review |
| `readAcceptance(bizDir, [seat])` | `businesses/lib/acceptance.ts:78` | written and tested |
| session reuse + cold retry | `runWithSession`, `team-orchestrator.ts:239` | in use |
| per-seat prompt with clone ranked by task | `employee-prompt.ts` + `nrv team step` | shipped 2026-09-04 |
| retry ceiling, loop guard, ledger, supervisor | across the engine | in use |
| fail-closed delivery gate | `delivery-pipeline.ts` | untouched by this |

### To build — engine only

| Change | Size |
|---|---|
| `team plan` returns a route (executor + review path) instead of a flat chain | small |
| `team step --review --of <seat>` — the superior's prompt and the verdict schema | medium |
| verdict parser + score recomputation + id validation against the real acceptance list | small |
| rejection path: same session, unconfirmed criteria in the follow-up | small |
| audit: `x_review_requested`, `x_review_rejected` (with the ids it cites), `x_review_approved`, `x_review_ceiling_reached` | small |
| `SKILL.md` Phase 4 + `brief-business.ts` output describe the loop | small |

### The businesses — measured, not assumed

```
businesses with org-chart.yaml ....................... 65 / 65
with exactly one root, every seat under a superior ... 64 / 65
with more than one orphan seat ....................... 0
employees ............................................ 611
declaring acceptance[] ............................... 611  (100%)
```

**No business needs restructuring.** The route exists and the contract exists,
everywhere.

One open question, worth measuring before committing to a date: the *quality* of
those 611 acceptance blocks. They are present universally; if a seat's criteria
are vague, its superior reviews against vagueness and the verdict becomes taste.
That is a curation pass, not a rewrite, and it is measurable mechanically — a
criterion with no `path`, no falsifiable verb, or under a length floor.

## 5. Cost, honestly

Today a business costs **one** agent call. Under this model, per executing seat:

```
1 executor
+ 1 immediate superior (substantive review)
+ k countersignatures (cheap aggregation)
+ r rejection rounds × (1 executor + 1 review)
```

A three-level chart with one rejection is roughly **5 calls against today's 1**.
That is the price of a review that has a name attached, and it is the main thing
to decide before building.

Three things hold it down, and all three already exist: only the immediate
superior reads (§3.3); the director decides how many seats run at all and must
justify the count (`x_chain_shape_decided`); and the rejection ceiling ends the
loop in a delivery rather than a spiral.

## 6. What proves it will work

Measured, not argued:

1. **The route is derivable today.** 65/65 charts, 64/65 single-root, zero
   orphans. No business blocks this.
2. **The contract exists today.** 611/611 seats declare `acceptance[]` with
   `blocking` and `minimum_score`.
3. **The pieces are written.** `readAcceptance`, `runWithSession`,
   `fromOrgChart`, per-seat prompts with clone injection — all present, four of
   them already in production paths.
4. **Delegation now happens when the org chart says so.** With the mandate rule,
   a comedy-scene brief routed to the screenwriter seat and the head of the house
   only signed, declining the researcher with a specific reason. Before the
   change, the same brief collapsed to one seat.
5. **The failure mode is already instrumented.** `dispatch_business` carries the
   employee; a deliverable crediting a seat with no such event is detectable
   mechanically, which is what makes item 4 checkable rather than anecdotal.

## 7. What would prove it will NOT work

Written down first, so the answer is not decided after the fact.

**The falsification test.** Give `studio-probe` a brief, then hand the reviewer a
deliberately weak artifact — a scene that is an outline, with no joke, ignoring
the reference. The superior must reject it, and the rejection must cite the
acceptance id and name what is missing.

- If it approves → the structured form is not enough, and the design needs
  something stronger than a checklist (an adversarial second reader, or the
  engine seeding the form with criteria the reviewer must actively knock down).
- If it rejects but cites nothing → the id-validation and evidence rules are not
  binding, and the verdict parser must reject the verdict itself.
- If the loop does not converge within the ceiling on a *fixable* artifact → the
  rejection message is not actionable, and the follow-up needs the missing
  evidence spelled out rather than the criterion named.

**The cost test.** Run the same brief through the probe with and without review.
If a three-seat chart costs more than ~5x the single-seat run, §3.3 is not being
honored and the countersignatures are doing substantive reads.

Both probes are installed and cost cents: `chain-probe` (4 seats, relay, proves
the hierarchy from the artifact) and `studio-probe` (3 seats, separate mandates,
proves delegation happens because the chart asked).

## 8. Order

1. **The chain must actually form.** Shipped 2026-09-04; awaiting a fresh session
   to confirm the instruction reaches a maestro that did not read it before.
2. **Review by the immediate superior**, bound to declared acceptance, engine
   gate kept last.
3. **Full route with countersignature to the head**, and the head's receipt to
   the orchestrator.

Step 2 has nothing to review while a business still runs as one agent. Step 1 is
not a prerequisite by taste; it is the thing being reviewed.
