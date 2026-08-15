# Indexing what a capability does, not only what it says it does

**Status:** proposal · 2026-08-15
**Decides:** whether BM25 keeps matching against routing metadata alone, or also
against the body each capability actually executes.

---

## The finding

Measured on a catalogue of ~80,000 skills with heavy overlap
(arXiv:2603.22455, *SkillRouter*): routing that sees only names and descriptions
loses **37–44 percentage points** of accuracy against routing that sees the
body. The comparison, Hit@1:

| retrieval over | Hit@1 |
|---|---|
| trained reranker (full body) | 74.0% |
| LLM as judge | 67.3% |
| dense embeddings (full body) | 64.0% |
| **BM25 (description only)** | **31.4%** |

And the part that closes the argument for us: description-only trailed by
**≥27pp in every description-length quartile, including the longest**. Writing a
longer description does not substitute for indexing the body.

A second result, on a production catalogue of 110 agents and 584 tools
(arXiv:2606.17519): **tool-level retrieval beats pack-level and hierarchical
routing by 2–4pp**, and the first hop of a hierarchy is an unrecoverable error
source — the LLM picks only 1.2 packs on average with an 83% hit rate.

## Why this lands squarely on us

Nirvana-OS is a pure retrieval system for its content. Squads and businesses are
**not** loaded into context — they are searched. 4 skills load by description;
249 entities are retrieved. So the context-overhead half of the skill-degradation
literature does not apply to us at all (and its confidence interval already
included zero), while the discrimination half applies completely.

What the index sees today (`router.js buildMatchDocs`):

```
description + keywords ×3 + example_briefs ×2 + produces + domains
```

What it does not see: `agents/*.md`, `tasks/*.md`, `workflows/*.yaml` — 5,767
files, ~16 MB, which is where the capability's actual method lives. A squad can
have a task doc that names the exact tool, format, standard and failure mode a
user is asking about, and none of it is retrievable.

This also explains a negative result from 2026-08-14. A dense multilingual arm
was added to the router and swept across every cosine floor; cross-language
parity never rose above the 25% it already had. The arm embedded **the same
routing metadata BM25 already saw**. Swapping the matcher over identical text
buys nothing; the measured gain comes from widening what is matched.

## What is proposed

Index a **body document per capability**, alongside the metadata document that
exists now. Not per squad — per capability, because that is the granularity the
evidence favours and because `invoke.ref` already makes it resolvable: all 678
capabilities declare one (587 workflow, 80 task, 11 agent).

Resolution, per capability:

```
invoke.type=task      → the task doc
invoke.type=agent     → the agent body
invoke.type=workflow  → the workflow's steps, each step's task doc and agent body
```

A workflow expands to the union of what it runs, which is exactly the set of
material that decides whether that capability fits a brief.

### Keeping the body from swamping the metadata

Two documents per capability, not one merged blob:

- `squad_capability:<squad>:<cap>` — the metadata doc, unchanged, unchanged
  weights (keywords ×3, briefs ×2). This is the precise, hand-curated signal.
- `squad_capability_body:<squad>:<cap>` — the body doc, weight ×1, and its score
  **capped below the metadata doc's** so a long body can surface a capability
  that metadata missed, but cannot outrank a capability whose metadata actually
  matched.

That ordering matters. The body is for **recall** — finding the capability whose
declared vocabulary happened to miss the user's words. Precision stays where it
is calibrated, on curated metadata. It is the same division that made dense
recall the right idea in the wrong place: widen what can be found, do not move
where the confidence comes from.

### What gets stripped before indexing

Bodies are prose written for an executing agent, not for a matcher. Before
indexing: drop fenced code blocks, YAML front matter, file paths, URLs, and the
scaffold headings every task doc repeats (`## Objetivo`, `## Output`,
`## Anti-patterns`). What remains is the domain vocabulary — tool names, format
names, standards, failure modes — which is the part that discriminates.

Cap each body doc at a fixed budget (proposed: 4,000 characters of retained
text, longest-section-first). The largest agent body in the library is 36 KB;
indexing it whole would give one capability more length budget than a hundred
others put together, and BM25 normalizes by length precisely to stop that.

### Cost

Index build only, never context. The body index adds an estimated 3–5 MB to the
squads registry against the current 2.4 MB, and a few seconds to `nrv index`.
Nothing about a dispatch gets more expensive: `fast` stays zero-token, and the
agentic router keeps reading the digest, which does **not** carry bodies.

## How it will be judged

The same instrument the corpus already has, before and after, on the same corpus:

1. `measure-language-parity.ts --parity` — 20 held-out paraphrase pairs.
   Baseline 25%. This is the headline number.
2. `measure-language-parity.ts --safety` — the 40 golden negatives must not
   start dispatching HIGH. A recall widening that also rescues out-of-domain
   briefs is a loss, not a win.
3. `self-retrieval-gate.ts` across the library — no entity may lose its own
   briefs to a neighbour whose body now matches.
4. `routing-eval.test.ts` watermarks — no regression on same-language top-1,
   which currently sits near 100%.

**Pre-committed decision rule:** ship only if parity rises with zero negatives
lost and zero same-language regression. If parity does not move, the body index
is removed the same way the dense arm was — the measurement decides, not the
theory. That is the second time this rule applies today, and the first time it
said no.

## What this is not

Not a replacement for curated metadata. The shadowing result (arXiv:2605.24050)
puts **68% of degradation at 202 skills on description overlap**, and bodies
overlap more than descriptions do, not less. Body indexing widens recall; it can
also widen collisions. That is why the score cap and the negatives gate are part
of the proposal and not an afterthought.

Not a change to what loads in context. The body stays out of the prompt. Index
and context are different systems, and treating them as one is the confusion
this proposal exists to remove.
