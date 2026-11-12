# Contract of the mind-clone `routing:` block

The orchestrator does not know anyone's name. It knows it needs "a casting director", "someone who settles the brand's tone of voice". The `routing:` block in `MANIFEST.yaml` is what makes a clone findable by **need** instead of by name. Without it, the clone is only reached by someone who already knows who to look for, which defeats discovery.

This document is the contract of the block and the record of what has already gone wrong. Each rule below exists because a real defect was measured, not out of stylistic taste.

The Portuguese phrases quoted in the examples are data: real domain items and real queries from a PT-BR library.

## The schema

```yaml
routing:
  # ── INDEXED: what this clone serves ─────────────────────────────────
  one_liner: "..."      # 1 sentence: who it is + the choice for what
  domains:              # 20-30 items, each in PT and EN as SEPARATE items
    - tom de voz de marca
    - brand tone of voice
  serves: "..."         # paragraph: when to choose it. Affirmation only.

  # ── NEVER INDEXED: read by the orchestrator AFTER retrieval ─────────
  not_for: "..."        # what it does not do, and WHO does (name the neighbor in prose)
  refuses:              # short terms for what it refuses
    - resposta direta
```

> **`delegates_to` was retired (2026-08-18).** A clone is knowledge, not an
> actor: it does not delegate. The field froze "who the right neighbor was" against a
> specific library and broke on every pack subset (805 shipped pointers
> with no resolution), while no code path consumed it. The pointer lives in
> `not_for`, in prose: a name in prose degrades to the live search by need,
> which answers against the library the user actually has. Existing lists on
> disk are ignored (they do not need to be removed); a new block does not write the field.

`serves` replaces the old `when_to_use`. Legacy blocks that still use `when_to_use` stay indexed for compatibility, but a new block must not write it.

The separation between the two sides is the reason the schema exists. See rule 3.

## Rule 1: a domain only with material backing

For each declared domain, there must be a DNA layer item that supports it: a framework, heuristic, methodology or playbook. If the person is famous for X but the clone has no method for X, **X does not go in**.

A domain declared without a method is a dispatch that arrives empty: the orchestrator convenes, pays the cost, and receives vocabulary instead of procedure.

Real cases: `greg-mckeown` declared `leadership-multiplication` and *Multipliers* as a primary source, without a line of method. `charles-duhigg` had `productivity-frameworks` in tags while the schema itself recorded the gap: "a dispatch asking to 'raise the team's productivity' receives vocabulary, not method".

## Rule 2: never summon by what the clone refuses

`saul-steinberg` declares `cartum` (cartoon) in `domains` while the `AGENT.md` opens with "Non-cartoonist" and defines cartoon as the failure mode. Whoever routes by cartoon receives a refusal.

Read the refusal sections before writing: `Limitations`, `What You Refuse to Do`, "Do NOT use when", "What it NEVER says".

Declaring the refused term in `refuses` makes the indexer warn about the contradiction (`index-clones.ts` compares `domains ∩ refuses`) and makes the corpus discard a manifest tag that contradicts it.

## Rule 3: BM25 does not understand negation

This is the reason the schema has two sides.

The index scores term overlap. "Do not use for direct answer" indexes as a vote **for** direct answer. It is not a hypothesis: two blocks written by independent authors ranked first on the very queries their prose wanted to repel.

- `brene-brown` came 1st on a clinical query because the refusal said "diagnóstico", "tratamento", "saúde mental" (diagnosis, treatment, mental health).
- `nils-leonard-cco` came 3rd on the query that negates because the refusal mirrored "custo por aquisição" (cost per acquisition).

`not_for` and `refuses` **do not enter the corpus**. Write the refusal there, in whatever words you like: it can no longer betray the block. `serves` takes affirmation only.

### 3a: the negation fits in a three-word `domains` item

A trickier variant, because it looks like a well-behaved domain. `billy-wilder` declared `sugerir em vez de explicar` (suggest instead of explaining) and `escalar até o clímax e parar sem epílogo` (escalate to the climax and stop with no epilogue). The index read `explicar` and `epílogo` as votes in favor, and he started winning "exposição explícita e didática" and "epílogo longo depois do clímax", the exact opposite of what he declared.

Name the method by what it **is** (`subtexto`, `Lubitsch Touch`, `escalada do terceiro ato até o clímax`), never by what it avoids. Forbidden in `domains` and in `serves`: "em vez de", "sem", "não", "nunca" (and their English equivalents: "instead of", "without", "not", "never").

### 3b: cover the vocabulary variants

BM25 matches tokens, not meaning. `IA` and `inteligência artificial` are strangers to each other; `diretora de elenco` and `casting` too. A clone that declared only one of the forms is invisible to whoever wrote the other.

Include the acronym and the long form, the synonym a layperson would use, and the Portuguese form even when the source material is all in English: 21 of the 542 clones have mostly English material and depend on the block to exist in a PT-BR query.

Also cover inflections, because the tokenizer does no stemming: `buy` and `buying` are distinct tokens, as are `sentiria` and `sentiriam`, `screen` and `screens`, `fontes` and `tipografia`. Declare the form the person will type, not only the canonical one.

### 3d: declare the symptom, not only the method

The costliest defect found so far, and the easiest to commit precisely for those who write well.

Seven UX clones had a block (heuristic evaluation, severity rating, forms, microcopy, ethos, atomic hierarchy, animation) and none was found by **"meu app está confuso e os usuários não conseguem completar as tarefas"** (my app is confusing and users cannot complete tasks). The query fell on `donald-miller`, `andrew-chen-cgo` and `anne-lamott`. Each had declared the instrument precisely; no one declared the problem as the owner describes it.

Whoever searches does not know the method's name: if they did, they would search by the specialist's name. Declare at least three or four items in the register of someone who has the problem:

- the **symptom** (`app confuso`, `usuário abandona no meio`, `time repete a mesma discussão`, `a margem caiu dois meses seguidos`)
- the **consequence** (`ninguém completa a tarefa`, `perdemos o cliente na renovação`)
- the **broad request** the owner would make (`melhorar a experiência do produto`, `organizar a área de RH`)

This does not conflict with rule 3c: the ceiling of 20-30 items stays, and the cut comes from redundant technical domains. If `avaliação heurística` and `heuristic evaluation` are already there, the third technical synonym is worth less than a symptom.

Test before delivering: write the query the way a non-technical owner would write it, with no jargon at all, and check that it lands on someone in the right cluster.

Real case: `reuven-avi-yonah` won "transfer pricing Pillar Two BEPS" in English and was invisible to "preços de transferência e imposto mínimo global", leaving the query to fall on a VAT clone that only matched the word `imposto`.

**Declare the symptom, not the scaffolding.** Write `o app está confuso e ninguém completa a tarefa`, never `quero consertar o app que está confuso`. The intent verb is the frame of the sentence and not its subject; and since almost no block declares it, it is rare in the corpus, and IDF pays for rarity. `quero` came to weigh 4.28 against 1.40 for `marca`: three times the weight of the noun that names the domain. The tokenizer now discards `quero`, `quer`, `queria`, `gostaria`, `want` and `need`, but the list does not cover everything (`preciso` and `ajuda` were left out because they are also an adjective and a noun). It works as a writing discipline, not only as an engine fix.

### 3e: a long `serves` gets diluted

BM25 normalizes by length, and the corpus averages ~145 tokens because most clones have not been enriched yet. A `serves` of 1,200 tokens receives per term occurrence about a quarter of what a 110-token legacy block receives; to tie with a legacy block that says the term once, the full block has to repeat it six times.

Three independent authors stumbled on this in the same batch and solved it the same way: `john-maeda-products-practice` cut from 1,214 to 1,064 tokens, `caio-braga-products-practice` from 983 to 707 and flipped all three queries at once, `aarron-walter-products-practice` saw a clone **lose** a query it already won when it was a short document. The practical yardstick: **a `serves` above ~500 tokens costs more than it earns.**

Writing more is not declaring better. Cut the prose, keep the numbers and the proper names of the frameworks.

This is **not** a case for recalibrating BM25's `b`. The sweep was done (2026-07-27, b from 0.0 to 0.9 against 47 need queries written before the blocks existed): the target with a block comes 1st at **every** value of `b`, and the target without a block loses at every one. What decides is having a block, not the calibration: MRR 1.000 against 0.05. Do not repeat the sweep.

### 3c: density also steals queries

Not every theft is a negation leak. `chris-mercer-tracking` won a BigQuery query that it refuses because it had four domains carrying `GA4` plus three mentions in `serves`; it became a magnet for any heavy GA4 query.

The fix is to narrow the claim to what the material supports, not to stack more items: BM25 normalizes by length, so accumulating dilutes what already scored.

## Rule 4: neighborhood before writing

Delegation only after confirming the destination exists. A handoff to a nonexistent clone has already happened (`sendak`, `lobel` in `saul-steinberg`'s block) and is a dead end.

Find the neighbors in two ways, because one alone is not enough:

**By name**: finds the sibling with the same surname and a different role suffix. Precedent: the three `david-droga` (`-ceo`, `-cco`, `-brand-practice`), each winning its own query and falling to 4th on its siblings'.

**By topic, using the search itself**: grep by name only finds whoever happens to be named like the subject. In a tax dispatch this missed 13 real neighbors, because `humberto-avila` and `paulo-barros-carvalho` do not have "tributo" in their names. Run the candidate domains against the index and see who wins today:

```
bun -e 'const {findCloneForTask}=await import("./skills/_shared/lib/clone-search.ts");for(const q of ["dominio candidato"]){console.log(q,"->",findCloneForTask(q,{limit:5}).map(h=>h.slug).join(", "))}'
```

Whoever shows up there is the actual competitor. After writing, run each one's home query and confirm they keep winning. **Taking the place of a neighbor with better backing is worse than not being found.**

When two clones share a body of work (co-authors, or the same person in different cuts), write the boundary on both sides. Precedent: `chan-kim` and `renee-mauborgne` split Blue Ocean by layer (his analytical machinery, her human side) and the buyer utility map by framing (he tests feasibility of a ready idea, she hunts for a blocker the industry ignores). The generic query became a real contest, 1.00 against 0.96, instead of a win by absence.

## Mandatory verification

**Integrity**: the YAML parses, `domains` has no item with a slash (PT and EN are separate items), no other MANIFEST section was touched, the diff is insertion only.

**Reindex in both scopes**: the registry is a derived cache; without reindexing, the search does not see the new block. The write is atomic, so it can run with other agents working.

There are **two** registries, and the scope depends on the directory you run from:

```
cd ~/nirvana-os && bun skills/_shared/scripts/index-clones.ts   # project scope
cd ~            && bun nirvana-os/skills/_shared/scripts/index-clones.ts   # global scope
```

The first writes to `~/nirvana-os/.nirvana/`, the second to `~/.nirvana/`, which is the install of whoever actually uses the system. Running only the first leaves the block invisible to the install, and that has already happened: the global registry sat stale for five days while dozens of blocks went into the project one. Run both.

**Search by need**: 3 natural-language queries (2 PT, 1 EN) that describe the need **without naming the clone**. The clone must come 1st. Use the whole, realistic query; a keyword fragment proves nothing, and shortening the query changes the test.

**Negative control**: a query about a subject the clone refuses. It must **not** come 1st. If it does, the problem is almost always rule 3 (refusal vocabulary leaking) or 3c (density). Fix it and repeat.

## What the engine does for you

- **Accents are folded** in the tokenizer, so `perícia` and `pericia` match. Before, the accent was a separator and `hábito` became `h`+`bito`, which penalized domains written in Portuguese.
- **PT/EN function words are discarded.** In a mostly Portuguese collection English stopwords are rare, and IDF rewards rarity: `and` came to weigh more than `marca`.
- **`refuses` filters manifest tags.** A tag from before the block that contradicts the refusal does not enter the corpus; that is how `lex-fridman` closed the leak of the tags `tecnologia` and `ia-filosofia-politica`. Matching is by **normalized exact equality**, so write a canonical term, not boundary prose: `pesquisa de palavras-chave` in the plural never filters a singular tag. The boundary in prose goes in `not_for`; `refuses` is a list of terms.
- **The discarded function words include the intent verb**: `quero`, `quer`, `queria`, `gostaria`, `want`, `need` and inflections. See 3d.
- **A spelled-out numeral in `serves` prose becomes a high-IDF token.** `kevin-indig` won a query about traffic drop after an update without matching `google`, `atualização` or `recuperar`; it scored on `cento`, coming from "as citações sobem cento e vinte" (citations rise a hundred and twenty). Write the number in digits, or rephrase.
- **A `domains ∩ refuses` contradiction becomes a warning** on reindex. It is a warning, not an error: a gate that fails on a false positive teaches everyone to ignore warnings.

## Known debt

`slug` and `display_name` are indexed, and a surname collides with a common Portuguese noun: "meu filho desiste na primeira dificuldade" falls on `mario-filho-data`, "a rocha da estratégia" on `melina-rocha`. There are 8 collisions hitting 15 clones.

The fix is to take the name out of the need corpus: search by name runs earlier, in the orchestrator's REQUESTED step. It is not safe while there are clones without a block: `billy-wilder` did not even have tags, and the name was his only anchor. Do it when the enrichment closes.
