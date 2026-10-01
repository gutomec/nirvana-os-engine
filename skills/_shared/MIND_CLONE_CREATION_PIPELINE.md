# Native mind-clone creation pipeline

> **This pipeline IS the engine's clone creator.** The nirvana-os-engine
> installs with no businesses, no squads and no clones, and still creates a
> mind-clone end to end, agentically, without depending on any squad.
> Factory squads (e.g. `fabrica-de-genios`, sold as a pack) are an OPTIONAL
> heavy pipeline for large collections; never a prerequisite.
>
> Mandatory sibling document: `MIND_CLONE_ROUTING_CONTRACT.md` (the `routing:`
> block that makes the clone findable: measured rules, not style).

## When to create

Only with the user aware: a clone is a permanent artifact of their library
(harness Rule 9: ask first). And only with real material: **a clone without a
source is an invented persona wearing a real person's name**, and harness Rule 4
forbids claiming fidelity that does not exist.

## Phase 1: Sources (web, mandatory)

Research the person's REAL material: books, articles, talks, interviews,
posts, code. Build the source list with name and date; it becomes the
`source_material` of the MANIFEST and the backing of every `^[FONTE]`.

Accept the user's own material (files, transcripts) as a primary
source when provided.

**Material gate:** without enough sources to sustain the 5 layers,
STOP and say so. Offering a declared "archetype" (a constructed persona, with
no real person's name) is honest; delivering a shallow clone with a real name is not.

## Phase 2: Distillation into a 5-layer DNA

Write `dna/dna-schema.md` with the layers, each claim carrying `^[FONTE]`
pointing to Phase 1:

| layer | what it is | quality test |
|---|---|---|
| L1 Philosophies | background beliefs | quotable from the source, not paraphraseable from anyone |
| L2 Mental models | how the person sees the problem | specific enough to disagree with another expert |
| L3 Heuristics | fast decision rules | actionable in 1 sentence |
| L4 Frameworks | named structures | has its own name and steps |
| L5 Methodologies | complete processes | reproducible by someone who never saw the person |

**Golden rule (it is rule 1 of the routing contract):** what has no method
in the layers does not become declared territory. Fame without material is a
corpus gap: record it, do not invent.

## Phase 3: Embodiment

```
~/businesses/_library/dna/<slug>/          # FLAT layout, kebab-case slug
├── MANIFEST.yaml                          # manifest + routing: block
├── agent/
│   ├── AGENT.md                           # operable persona: when to invoke, what it delivers, refusals
│   ├── SOUL.md                            # voice and temperament: how the person speaks
│   └── DNA-CONFIG.yaml                    # injection config (no model pin)
└── dna/
    └── dna-schema.md                      # the 5 layers with ^[FONTE]
```

`AGENT.md` declares refusals consistent with the material (what the person
publicly does not do). No file pins a model: the system is
model-agnostic.

## Phase 4: `routing:` block in the MANIFEST (MANDATORY, a clone without it does not exist)

The `routing:` block is not optional for a new clone: measured, a clone with
the block routes at MRR 1.000 and without it at MRR 0.05
(`MIND_CLONE_ROUTING_CONTRACT.md`; summary in
`ROUTING_METADATA_CONTRACT.md` §8). Follow `MIND_CLONE_ROUTING_CONTRACT.md`
to the letter: `one_liner` ≤120 chars; 20-30 `domains` as EN + PT pairs
(separate items); rule 3d (symptom in the owner's voice, NO intent verb) and
rule 3e (length: `serves` beyond ~500 tokens costs more than it earns).
Always the new schema: `serves` / `not_for` / `refuses` (`delegates_to` is retired; name the neighbor in `not_for` prose).

With a non-empty library, read the neighbors' blocks in the territory before
writing (contract rule 4) and delegate by name only to a slug that
exists. Empty library (clean install): there is no neighbor to protect.
The best neighbor for what the clone refuses is named in prose in `not_for` (`delegates_to` retired 2026-08-18).

## Phase 5: Index + gates (all blocking)

```bash
bun ~/.nirvana/skills/_shared/scripts/index-clones.ts   # mirrors the global scope by itself
```

1. **Self-retrieval (the SELF-RETRIEVAL GATE: creation is NOT done until it
   passes):** the `one_liner` retrieves the clone at #1
   (`nrv find-clone "<one_liner>"`, or the standard gate command:
   `bun ~/.nirvana/skills/_shared/scripts/self-retrieval-gate.ts <clone-slug>`
   with exit 0 required). This is the universal invariant: it holds for a
   library of 1 clone or of 542, and it is the same axis
   `_shared/scripts/eval-clone-routing.ts` measures continuously (axis 1);
   run that eval before and after touching the block when the library is
   non-empty, and keep its watermarks green.
2. **Need:** 2-3 SYMPTOM queries that the target user would type
   (plain language, no jargon) bring the clone up at #1.
3. **Neighbors intact:** with a non-empty library, the home queries of the
   cited neighbors stay with their owners.
4. **Zero warnings** about `domains ∩ refuses` or a malformed domain on reindex.

At most 3 tuning iterations; if it does not hit, report the real number instead of
stacking tokens (rule 3e: stacking dilutes).

## What to NEVER do

- Claim fidelity for a clone whose material does not support it (harness Rule 9.4:
  degrade honestly, do not lie).
- A real person's name on a clone of invented material: use an archetype.
- Delegate to a nonexistent slug (precedent `sendak`/`lobel`).
- Copy another clone's `routing:` block as a content template: the
  territory comes from the MATERIAL, not from the format.
