# Routing metadata contract — squads, businesses, mind-clones

The system is worldwide. Every brief lands first on the **agentic router** (an LLM
reading the registries) and falls back to **BM25** (deterministic, token-overlap,
zero LLM). Both matchers see exactly one thing: the routing metadata declared in
`squad.yaml` (capabilities), `business.yaml` (+ `routing.yaml` auto_routes), and
the mind-clone `routing:` block. An entity with poor metadata does not exist for
either matcher — measured, not stylistic: clones **with** a routing block route at
MRR 1.000, clones **without** at MRR 0.05 (`MIND_CLONE_ROUTING_CONTRACT.md`, rule
3e). The same class of defect was found across the whole registry: businesses with
empty `capabilities`, descriptions truncated mid-word at an obsolete 500-char
limit, `auto_routes` in a handful of businesses with conjugation-brittle regexes,
`not_for` written as sentences no substring matcher can ever fire on.

This document is the canonical contract for **squad capabilities** and
**businesses**. For **mind-clones** the canonical contract is
`MIND_CLONE_ROUTING_CONTRACT.md` (same directory) — this file does not duplicate
it; §8 states only what creation flows must enforce and where the clone-specific
rules live.

All numeric bounds below are the defaults from `validators/limits.ts` (cascade:
env var `NIRVANA_LIMIT_*` → `.nirvana-limits.yaml` project → user → defaults).
The validators (`validators/validators.ts`) enforce them; write to the defaults
unless a project override says otherwise.

---

## 1. `description` — canonical English, concrete, front-loaded

- **Language: English.** The description is the canonical machine-facing text;
  multilingual reach comes from `keywords` and `example_briefs`, not from
  translating the description.
- **Front-load the deliverable.** The agentic router skims candidate lists; the
  first ~120 characters must already say *what this entity delivers* ("Writes
  complete non-fiction ebooks from a topic brief: chapter plan, full manuscript,
  cover copy"), not what it "is" ("A powerful multi-agent team that…").
- **No marketing fluff.** Banned: "state-of-the-art", "world-class", "powerful",
  "seamless", superlatives without a measurement. Every sentence must add a fact
  a router could match on: inputs accepted, artifacts produced, methods used,
  boundaries.
- **Length bounds** (chars): business `20–2000` (`business_description_max`),
  capability `20–1500` (`capability_description_max`). **The old 500-char limit
  is dead.** Any description that was truncated mid-word at 500 chars must be
  rewritten as a complete text — un-truncating is not enough; the cut usually
  removed the concrete half.
- Never name what the entity *refuses* inside the description — the description
  is BM25-indexed, and BM25 has no negation (see §6 and clone contract rule 3).

## 2. `domains` — controlled vocabulary only

- Values come from `catalogs/CAPABILITY_CATALOG_V1.yaml` (59 canonical
  snake_case entries). Capability: 1–5 domains. Business: 1–50.
- Out-of-catalog domains require `experimental_domains: true` on the squad and
  cost a 0.7x discovery penalty — treat that as a temporary state, then PR the
  catalog.

## 3. `produces` — artifact-type slugs

- Lowercase kebab-case slugs naming the **artifact type**, not the process:
  `ebook`, `landing-page`, `market-report`, `promo-video`, `brand-guideline`,
  `code-review-report`. Each 3–80 chars.
- Business: 1–60 items (`business_produces_max`). Capability: 1–40 items
  (`capability_produces_max`).
- One slug per artifact type. Do not enumerate synonyms here — synonyms belong
  in `keywords`.

## 4. `keywords` — multilingual synonym groups

BM25 does no stemming and no translation: `ebook` and `livro digital` are
strangers, `revisão` and `revisao` converge only inside the BM25 tokenizer
(accent folding) but **not** in the substring matchers (`not_for` penalty,
auto_routes). So:

- **Each concept ships as a group**: the EN form, the PT form (and ES where the
  audience makes it natural), and the accented **and** unaccented spellings when
  diacritics occur. Example group for one concept:
  `["ebook", "e-book", "livro digital", "libro digital"]`; for another:
  `["code review", "revisão de código", "revisao de codigo"]`.
- Include the layperson's word next to the practitioner's: `casting` **and**
  `diretora de elenco`; `IA` **and** `inteligência artificial` **and** `AI`.
- Cover the inflections users actually type (no stemming): `screen`/`screens`,
  `fontes`/`tipografia`.
- Item length 2–60 chars. Capability ≤60 items (`capability_keywords_max`),
  business ≤100 (`business_keywords_max`). Keywords are indexed with weight ×3 —
  the strongest signal you control; spend the budget on distinct concepts, not
  on a fourth synonym of a concept already covered twice.

## 5. `example_briefs` — real user asks, both languages, both verb forms

`example_briefs` are indexed verbatim (weight ×2), they build the eval golden
set (`harness/scripts/build-golden-set.ts`), and they are the input of the
self-retrieval gate (§9). They are the single highest-leverage field.

- **At least 3 briefs; at least one EN and one PT.**
- **Phrase them as a real user would** — symptom language, first person, the
  panic wording: "meu app está confuso e ninguém completa a tarefa", "our
  organic traffic dropped 60% after the last Google update". Not catalog
  language ("execute heuristic evaluation workflow").
- **Cover conjugated AND infinitive verb forms** across the set: one brief with
  "escreva um ebook…", another with "quero escrever um ebook…" / "write an
  ebook…". The BM25 tokenizer discards bare intent verbs (`quero`, `want`,
  `need`) but not conjugations of content verbs — declare the forms people type.
- Each brief 20–1000 chars (`*_example_briefs_item_max`). Business ≤30 briefs
  (`business_example_briefs_max`), capability ≤20 (`capability_example_briefs_max`).
- **Never put the entity's own slug inside an example brief.** The router's
  explicit-mention stage short-circuits on slugs, which would make the
  self-retrieval gate pass for the wrong reason.

## 6. `not_for` — short token lists, never sentences

The router applies the `not_for` penalty by **lowercase substring match against
the brief** (`router.js` — `lc.includes(nf)`, penalty ×0.4). A sentence like
"do not use this for fiction ghostwriting because…" will never appear verbatim
inside a user brief, so it never fires. Additionally, for capabilities `not_for`
is **not** BM25-indexed — it is metadata read after retrieval — so it is safe to
name refused territory here (and only here).

- **Each entry: 2–4 content words** (min 5 chars), exactly the substring a brief
  would contain: `"fiction ghostwriting"`, `"video promocional"`, `"código"`.
- **One concept per entry.** EN and PT forms are separate entries. Accented and
  unaccented forms are separate entries (substring matching does NOT fold
  accents): `"revisão de código"` and `"revisao de codigo"`.
- No parentheses, no "(use X instead)" suffixes, no arrows — anything appended
  makes the whole entry unmatchable. If users need to know who owns the refused
  territory, that owner's own metadata is where they will find it; the agentic
  router reads both sides.

## 7. `auto_routes` — patterns generated from example_briefs (businesses)

`auto_routes` live in the business's `routing.yaml` and become `business_route`
candidates. Stage 3 of the router **discards a route whose regex does not fire
on the brief** — a conjugation-brittle pattern silently disables the route.

- **Derive each pattern from the example_briefs**, then verify: every
  example_brief the route should catch must make the regex fire.
- **Match infinitive AND conjugated forms** with stems, never a single form:
  `\b(escrev\w*|redig\w*|write|writing)\b.*\b(ebook|e-?book|livro)\b` — the stem
  `escrev\w*` covers escrever / escreva / escrevo / escrevendo.
- Cover EN and PT in the same pattern (alternation), plus unaccented variants
  where diacritics occur (`código|codigo`).
- Do not write the `(?i)` inline flag — the router compiles with `i` already and
  strips the prefix for JS compatibility. Write plain patterns.
- Anchor patterns on **content nouns + verb stems**, never on scaffold words
  ("quero", "preciso", "please") — scaffolding is what varies most across users.

## 8. Mind-clones — the `routing:` block is mandatory

For every **new or edited** mind-clone, the `routing:` block in `MANIFEST.yaml`
is mandatory. The full contract is `MIND_CLONE_ROUTING_CONTRACT.md`; creation
flows enforce at minimum:

- `one_liner` ≤120 chars — who the clone is + the choice it is *the* answer for.
- `domains`: 20–30 items, each concept as **EN + PT pairs (separate items)**,
  including symptom-phrased items in the owner's voice (clone contract rule 3d).
- `serves`: affirmation only, ≤~500 tokens (rule 3e — longer dilutes).
- `not_for`, `refuses`, `delegates_to`: never indexed; write refusals there and
  nowhere else (rule 3). `delegates_to` only to slugs that exist (rule 4).
- Self-retrieval: the `one_liner` must retrieve the clone top-1 via
  `nrv find-clone` — the invariant of `MIND_CLONE_CREATION_PIPELINE.md` phase 5,
  measured continuously by `_shared/scripts/eval-clone-routing.ts`.

## 8bis. Never cut for cost

Two reasons lead people to remove routing metadata, and only one is legitimate.

**Precision.** A redundant keyword, a fourth synonym of a concept already covered
twice, a sentence that states nothing a router could match on. This is real: BM25
normalizes by length, so redundancy inside one document costs that document
precision. The test is measurable — run the self-retrieval gate before and after,
and on the neighbours. If retrieval does not improve, the removal was loss, not
precision.

**Cost.** Shortening descriptions, dropping example briefs or deleting
capabilities to reduce tokens. **This is prohibited.** It degrades the product to
save money on the path that is already the cheap one:

- The default router is agentic. It reads for meaning, and a more accurate,
  more complete description is strictly better for it. There is no budget being
  spent that a shorter description would save.
- `fast` is BM25 and **indexes one document per capability** (`buildMatchDocs`).
  A squad with 18 capabilities produces 19 documents. Declaring another one does
  not dilute the others — they never shared a length budget.

So neither matcher charges for size. What both punish is redundancy inside a
single field, which is a precision problem with a precision fix.

This is not hypothetical damage. The 500-character limit named in §1 was applied
across this library and truncated descriptions mid-word; the correction there —
"un-truncating is not enough, rewrite as complete text" — exists because someone
optimized the wrong quantity.

If a corpus does not fit a context budget, the budget is an engineering problem:
tier the digest, escalate on demand, split the file. The answer is never to make
the library know less.

**For reviewers:** reject any change whose justification is token cost, and ask
for the before/after retrieval numbers instead.

## 9. The SELF-RETRIEVAL GATE (blocking)

**A newly created or edited entity's own `example_briefs` must route back to
that entity top-1 — before that, creation is not done.** This is the cheapest
possible ground truth: the entity itself declared "briefs like this are mine";
if the router disagrees, the metadata is the defect, never the router.

```bash
bun ~/.nirvana/skills/_shared/scripts/self-retrieval-gate.ts <entity> [--lenient] [--json]
```

- `<entity>` = business slug | squad slug | capability id (optionally
  `<squad>:<capability-id>`) | mind-clone slug. Kind is auto-detected; force
  with `--kind business|squad|capability|clone`.
- The gate reindexes stale registries automatically (`nrv index --if-stale`),
  routes every example_brief with the deterministic router (amplify off), and
  reports per-brief top-1 hit/miss with the actual top-3.
- **Exit 0 = pass. Exit 1 = at least one brief missed top-1** (with `--lenient`:
  missed top-3 — use only for triage, never to declare creation done).
- Clones: the gate checks `one_liner` self-retrieval over the clone corpus (the
  same axis as `eval-clone-routing.ts`).
- **Neighbors stay intact.** When your new metadata overlaps an existing
  entity's territory, run the neighbor's home briefs too and confirm they still
  win. Taking a query from a better-grounded neighbor is worse than not being
  found (clone contract rule 4).

On failure, iterate on the metadata (up to 3 passes is the norm) — sharpen
keywords, rephrase briefs as symptoms, shorten `not_for` tokens. Do not lower
thresholds, do not pad text (BM25 normalizes by length — padding dilutes), and
do not ship with the gate red.

## 10. Writing for two matchers at once

Everything above serves both matchers simultaneously:

- The **agentic router** reads `description` and `not_for` as prose — so they
  must be honest, concrete, and complete sentences (description) or scannable
  refusal tokens (`not_for`).
- **BM25** matches tokens — so `keywords` (×3) and `example_briefs` (×2) carry
  the multilingual and inflectional load, accents fold inside the tokenizer,
  intent verbs are discarded, and nothing negative may enter an indexed field.

When the two audiences conflict, split the content: prose goes where only the
LLM reads (description, not_for), tokens go where BM25 weighs (keywords,
example_briefs).
