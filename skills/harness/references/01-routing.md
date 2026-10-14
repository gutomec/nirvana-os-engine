# Reference 01 — Routing (the deciders, and the keyword retriever stage by stage)

> Who decides which business, squad or agent-x executes a request, and how the
> keyword router (`lib/router.js`) builds the shortlists they read. The stage
> sections document what `lib/router.js` does today (routing-360 state,
> 2026-08-06). The legacy 5-stage description in the archived Harness
> Protocol v1 §6 is historical.

Two routers decide, and `routing.mode` picks which one speaks:

- **agentic (default)** — the model reads the brief plus a compact registry
  digest (`scripts/build-routing-digest.ts`, businesses + squads + per-squad
  docs, ~48k tokens) and returns a structured contract
  (`lib/agentic-router.ts`: `primary_business`, `mandatory_squads`,
  `optional_squads`, `suggested_mind_clones`, `rationale`). Higher quality,
  costs tokens. The cascade consumes its decision (`lib/dispatch-cascade.ts`).
- **cards** — one call with no tools over `.routing-cards.md` (one line per
  business and squad, what it produces first; written beside the digest) and
  the top mind-clones of the lexical clone search (`lib/cards-router.ts`). It
  answers `business:<slug>`, `squad:<slug>` or `solo` plus the brief's done
  states, mapped onto the same contract the cascade consumes. See
  [The cards call](#the-cards-call) for the prompt layout and the parts.

The orchestrator path (the harness `SKILL.md`) decides with the session's own
model, reading the `nrv find` shortlist and the finalists' cards.

**The keyword router is a retriever, never a decider.** `lib/router.js` (BM25,
documented stage by stage below) is deterministic and spends no tokens. It
builds the `nrv find` shortlist, breaks capability ties inside a squad
(`capability-resolver.ts`) and backs the clone search (`clone-search.ts`);
`nrv route` shows its pipeline as a diagnostic. It never picks the target of a
dispatch. The `fast` mode that let it do so was retired on 2026-10-13: on 48
labeled requests it answered AMBIGUOUS for 42 and found the right business for
4 of 42, and in a library written in two languages the request's language
decided the answer. Since then `--mode=fast` and `nrv config set routing.mode
fast` exit 4, a stored `routing.mode: fast` (config file or
`NIRVANA_ROUTING_MODE`) reads as unset with one warning naming where it came
from, and a router failure goes to agent-x: `routing.on_router_failure` takes
`agent-x-only` (default) or `fail`, and a stored `cascade` reads as
`agent-x-only`.

A router does NOT execute anything. It returns a decision JSON; invocation
belongs to the dispatch layer.

## The cards call

The prompt has two halves (`buildCardsStatic`, `buildCardsRequest`):

- **System prompt:** the instructions, the rules, the answer shape and the
  cards. They are the same for every request, so the runtime reads them back
  from its prompt cache from the second call on.
- **Message:** the clone candidates, the request and, on the one retry, the
  correction.

The call runs from a fixed empty folder (`routerCwd()`), because the cwd is
part of the prompt and a new temp folder per call broke the cached prefix.
Measured on 48 labeled requests (2026-10-13): $19.70 before, $6.65 after, with
the runtime's default model. A runtime with no system-prompt flag (codex,
qwen, agy, kimi, grok, opencode) gets both halves folded into one prompt by
the driver (`withPreamble`), static half first.

The answer may split the request into **parts**:

```json
{"target": "business:<slug>", "parts": [{"target": "business:<slug>", "part": "<what it delivers>", "after": ["business:<slug>"]}], "voices": [], "squads": [], "done": [], "reason": ""}
```

One part per deliverable that belongs to a different business or squad, with
`after` naming the targets whose output it needs. `target` stays the part the
others build on. An answer without `parts` reads as one part. With two parts
or more, `nrv dispatch --auto` writes a multi-target plan
(`lib/auto-parts-plan.ts`: one node per target, `depends_on` edges, one
six-section brief per node) to `.nirvana/plans/<project>.json` and runs
`scripts/multi-target.ts run` on it, passing `--runtime` when the dispatch had
one (audit: `x_route_parts`). Under `--scaffold-only` it writes the plan,
prints the command and exits 3. With the multi-target engine switched off it
warns and runs the primary part only.

The voices the router chooses (`suggested_mind_clones`) reach the worker: the
business seats, the squad and agent-x all receive them through `selectVoices`
(`lib/clone-voices.ts`), after the voices the request names and before the
lexical search. Agent-x never gets a searched voice.

## The Jev step (optional, only with a TypeSafe key)

With `TYPESAFE_API_KEY` configured (the environment, the project's `.env` or
`~/.env`) and `routing.jev` not `off`, `nrv dispatch --auto` asks TypeSafe's
Jev classifier before the LLM router (`lib/jev-router.ts`, client in
`_shared/lib/typesafe-client.ts`). Without the key nothing changes and nothing
is sent. With it, **the request text goes to TypeSafe**.

1. Code: a target the request names by slug (`detectTargetMention`) and the
   clones it names (`scanNames`). A named target is a command; the Jev is never
   asked about it.
2. Local: the `nrv find` shortlist (`lib/shortlist.ts`, businesses and squads
   apart) and voice candidates (8 from the library search, plus the voices of
   the seats of the named or best-ranked business).
3. One Jev call with Choice questions: `business`, `squad`, `shape`
   (one business / one squad / several / nothing), one business and one squad
   question per clause of the request (`clauses()`, split by code), and
   `voice` when the request names nobody.
4. Code composes the decision in the routers' contract, with `parts` for a
   `several` shape (each clause's owner at `PART` 0.5 or more, at most
   `MAX_PARTS` 3), a rationale built from the probabilities, and a confidence.

At or above `GATE` (0.8) the decision goes to `planRouteWithFallback` as if the
LLM router had made it, parts included (audit `x_jev_route_decided`). Below it
(`x_jev_route_escalated`) or on any error, timeout (3 s) or invalid answer
(`x_jev_route_failed`), the cards or agentic router decides as before. The
events carry confidence, latency, tokens and cost, never the request text or
the key. The voice selection of a business or squad run uses the same voice
question as `rerank` in `selectVoices`, between the router's suggestion and
the lexical search (a voice at `VOICE` 0.5 or more; `none` offers nothing; an
error leaves the search to decide).

Measured on 48 labeled requests (2026-10-13, `bench/jev/`): 42/48 exact with
the Jev alone, 0 wrong decisions at or above 0.8, 16/48 decided at the gate;
with the cards router behind it, 47/48. `nrv find --jev` prints the Jev's
suggestion above the shortlist; it is off by default because its effect on
the orchestrator was never measured.

## `nrv find`: the orchestrator's shortlist

`scripts/find.ts` prints what the orchestrator decides between, zero tokens,
in one BM25 pass (the ranking lives in `lib/shortlist.ts`; the named target
comes from `detectTargetMention`, not from a second run of the router; about
0.4 s on a 74-business library):

- businesses and squads in **separate** lists, best first, 8 of each
  (`SHORTLIST_SIZE`). A `business_route` match counts as its business, never
  as the seat it routes to;
- each line is the entity's routing card (what it produces, what it is, what
  it refuses), and a squad line names the capability that matched;
- the target named in the request, when there is one, and the clones the
  request names, the ambiguous names and the names missing from the library
  (`lib/clone-names.ts`).

`--json` prints the router's full decision, unchanged, plus a `shortlist`
object (`named`, `businesses`, `squads`, `clones`). Parse that, never the
human text, which is for reading. Measured on 48 labeled requests
(2026-10-13): the right business is in the first five for 95% of the parts,
against 78% with the old mixed list of five.

## Pipeline order (what `route()` actually runs)

```
brief
  ↓ Stage -2    brief strength classifier      (WEAK | NORMAL | STRONG, zero LLM)
  ↓ Stage -1.5  amplifier                      (only when WEAK, or --force-amplify)
  ↓ Stage 1     intent classification          (heuristic verbs; LLM hook optional)
  ↓ Stage 0.5   explicit target mention        (short-circuit: named slug = command)
  ↓ Stage -1    meta-intent detection          (short-circuit: orchestrator briefs)
  ↓ Stage 0     business auto_route coverage   (ranked list, no short-circuit)
  ↓ Stage 2     BM25 capability matching       (zero LLM; dense fusion RETIRED)
  ↓ Stage 2.7   amplification bridge           (coverage probe → aliases → amplifier)
  ↓ Stage 2.5   business-first ordering        (tiebreak, not an override)
  ↓ Stage 3     routing decision               (HIGH | AMBIGUOUS | NO_MATCH + coverage gates)
  ↓ Stage 3.5   dense NO_MATCH fallback        (OFF by default; suggestion-only)
  ↓ Stage 4     budget pre-flight              (cap 0 = unlimited, no-op)
  ↓ Stage 5     lazy invocation plan
  → decision JSON + audit events
```

## Stage -2 — Brief strength classifier

`classifyBriefStrength(brief)` — pure heuristic, zero LLM. Signals: token
count, action-verb density (PT + EN verb sets), vagueness markers, specificity
markers (URLs, handles, numbers, named entities). Output `WEAK | NORMAL |
STRONG` with a score and the signal breakdown.

## Stage -1.5 — Amplifier (WEAK briefs only)

`amplifyBrief(brief, opts)` rewrites a fragmentary brief into an explicit one
via the host-agent driver. Persona: the maestro's `brief-interpreter.md` when
the `business-nirvana-maestro` squad is installed, else a built-in amplifier
persona — the engine works with zero squads installed. Disabled by
`--no-amplify`; forced by `--force-amplify`. NORMAL/STRONG briefs skip this
stage (but see Stage 2.7 — low coverage can still trigger amplification).

## Stage 1 — Intent classification

`stage1IntentClassify(brief, ctx)` — verb-set heuristic (`WORK` / `RUN_ORG` /
`BOTH`) plus domain extraction by token overlap with the known-domains list.
An async `ctx.classifier` hook can replace it with an LLM call.

**The intent FILTER is opt-in and off by default.** Measured on the 2026-07-27
census (n=2,358 example_briefs): with the filter on, post-adjustment accuracy
was 94.1% vs 99.8% for raw BM25, and ALL 133 dropped cases were the filter's
fault — mundane verbs ("run", "organize") classified RUN_ORG and hid whole
classes of squad capabilities. Re-enable to re-measure with
`NIRVANA_ROUTER_INTENT_FILTER=1`.

## Stage 0.5 — Explicit target mention (short-circuit)

`detectTargetMention` — naming a registered squad or business in the brief is
a COMMAND, not a retrieval hint. It wins over meta-intent, Stage 0 and
business-first. Guards: the slug must appear as a whole token
(hyphen/accent-normalized) AND be distinctive (multi-token, e.g.
"code-review") OR have an instrumental cue nearby ("use o squad X"); exactly
one distinct target must match (0 or 2+ → no short-circuit). Runs on the
ORIGINAL brief (amplification could dilute the mention). Result: `HIGH`,
`route_tier: explicit_mention`, score forced to 1.0. Disable with
`context.disableExplicitMention`.

## Stage -1 — Meta-intent detection (short-circuit)

`stageMinusOneMetaIntentDetect` — detects orchestrator-shaped briefs
(meta-keywords like "orquestrar", "projeto completo", "use suas melhores";
or 3+ distinct action verbs AND 2+ list separators) and routes them to the
canonical `business.project.orchestrate` capability. **No substring
fallback**: if that capability is not indexed, Stage -1 abstains and the
normal pipeline routes (the old "first capability containing 'orchestrate'"
fallback hijacked 56 census briefs with 0 correct hits). Disable with
`--no-stage-minus-1`.

## Stage 0 — Business auto_route coverage (ranked list, no short-circuit)

`businessRouteCoverageRanked` — for every `auto_routes` pattern of every
business, computes keyword coverage against the brief (patterns like
`type:refund-request` → tokens `refund`, `request`). It used to short-circuit
BM25 entirely — an artifact-pattern match ("modelos" → ml-model) hijacked
briefs that matched a squad by CONTENT (finding #4d). Now it only produces a
ranked list; that list joins the RRF fusion ONLY when
`NIRVANA_ROUTER_FUSION=1` (fusion is off by default, see Stage 2).

Two abstentions: patterns made only of generic-object keywords
(landing/page/copy/post/...) carry no domain signal and are skipped; briefs
containing premium-quality keywords (awwwards, cinematic, webgl, ...) skip
Stage 0 so generic business routes cannot hijack premium squad work.

## Stage 2 — BM25 capability matching (zero LLM)

`stage2MatchHybrid` builds one BM25 index (`lib/bm25.js`, k1=1.5, b=0.75,
max-score normalization) over four doc families:

| Doc | Text (with term-repetition field weights) |
|---|---|
| `squad_capability` (one per capability × provider) | capId + description + examples + domains + **keywords ×3** + **example_briefs ×2** + produces |
| `squad` (one per squad — routing-360 Phase 2 per-squad doc) | name + squad-level description + domains + capability ids + keywords (example_briefs/produces deliberately excluded — they already power the capability docs; duplicating them dilutes business matches) |
| `business` (one per business) | slug + description + domains + capabilities + example_briefs + produces + keywords |
| `business_route` (one per auto_route pattern) | pattern keywords ×2 + route_to + slug + business domains |

v4 squads without explicit `capabilities[]` get inferred capability docs
(`_v4_inferred_capabilities` from the registry loader) so they stay
discoverable.

The tokenizer (`bm25.tokenize`) is Unicode-aware: NFD accent folding plus
PT/EN stopword and scaffold-verb removal, so "revisão"/"revisao" and
PT-BR/EN spellings land on the same tokens.

Post-BM25 adjustments (`applyAdjustments`):
- `score_boost` clamped to **[1.0, 1.3]** — a boost is a curation tiebreak,
  never a veto (declared 0 used to self-annihilate capabilities) and never a
  magnet (1.5 let broad-vocabulary squads steal foreign domains).
- `not_for` penalty ×0.4 when an entry fires. Firing rule: entries ≤25 chars
  use the substring fast-path; longer entries use token overlap (≥2 content
  tokens and ≥60% of them present in the brief) — the old whole-string
  substring test was inert (98.9% of live entries are >40 chars).
- Re-rank and re-normalize so top = 1.0.

**The dense/BM25 RRF fusion is RETIRED** (Phase 3.4). Two measurements
condemned it: 2026-07 (n=41): BM25 alone 100% top-1, fusion with the dense arm
29%, without it 63% — structural, not calibration (RRF is rank-only with k=60
over a ~1,500-doc corpus, so a mediocre candidate present in two lists
outranks the champion of one). 2026-08-05 re-evaluation: the paraphrase
embedder measures SUBJECT proximity, not declared competence. The dense arm
survives ONLY in the Stage 3.5 fallback slot. `NIRVANA_ROUTER_FUSION=1`
re-enables the coverage list (third ranked list) for re-measurement; nothing
re-enables the fusion's dense arm.

Every candidate carries `coverage` — how many content tokens of the ORIGINAL
brief the doc matches (`bm25.coverage`) — measured against the original brief
even after amplification, because the census bands are defined on it.

## Stage 2.7 — Amplification bridge (the inversion fix)

The old amplify trigger was brief STRENGTH; what predicts "this brief needs
help" is the COVERAGE PROBE — the same census bands Stage 3 abstains on. When
the top candidate's coverage is below the gate:

1. **(a) done** — coverage clears the gate → no bridge.
2. **(b) alias re-coverage (zero LLM, deterministic)** — re-score the
   retrieved candidates' coverage through the cross-language alias groups in
   `.keyword-aliases.json` (emitted next to the squads registry; absence
   tolerated). Adopt only when the top candidate then clears the gate.
   Aliases are used ONLY for coverage re-scoring, never for BM25 re-querying
   — measured 2026-08-05: appending 30-47 alias siblings to a 5-token query
   hands the ranking to IDF-rare junk.
3. **(c) amplifier** — if still low and no LLM amplification ran yet, run the
   Stage -1.5 amplifier regardless of strength class and re-run the match on
   the amplified brief.

Two post-amplify guards keep amplification a lens, never a replacement
(Phase 4): **(guard a)** an amplified winner sharing ZERO tokens with the
user's own words reverts to the pre-amplify pass
(`amplified_discarded: winner_zero_original_coverage`); **(guard b)** an
amplified pass that still ends NO_MATCH reverts too
(`no_match_after_amplify`). The result can never be worse than the
pre-amplify pass.

## Stage 2.5 — Business-first ordering (tiebreak, not an override)

`orderAndDecide` — default preference `business` (`--prefer squad|auto`
overrides). The best GENUINE business doc (type `business`, matched by
content — a `business_route` is never promoted) is moved to the top ONLY when
it is competitive: `normalized >= 0.45` AND within **0.08** of the best
non-business rival. A materially better squad wins; a tie goes to the
business (richer orchestration, observability, humanization). Route tiers:
`stage2_business`, `stage2_squad_fallback`, `stage2_squad`,
`stage2_squad_forced`, `stage2_combined`.

## Stage 3 — Routing decision (signals + coverage gates)

`stage3Decide(matches, {thresholds, brief})`, defaults in
`DEFAULT_THRESHOLDS`:

```
top   = matches[0].normalized        # 1.0 by construction
lead  = top - matches[1].normalized

HIGH       top >= 0.80 AND lead >= 0.15
AMBIGUOUS  >= 2 candidates >= 0.60 within 0.15 of top, OR single top in [0.60, 0.80)
NO_MATCH   top < 0.60
```

Three refinements on top of the thresholds:

1. **Coverage gates (census 2026-07-27).** Normalized score cannot separate a
   real brief from an out-of-domain one (top is always 1.0); the COUNT of
   matched content tokens can, with an empty band between: real briefs match
   ≥3 winner tokens, out-of-domain match ≤2.
   - `matched <= 1 AND total >= 3` → **NO_MATCH** (count band)
   - `matched == 2 AND total >= 4 AND fraction <= 0.5` → **AMBIGUOUS** (confirm)
   - `matched <= 1 AND total == 2` → **AMBIGUOUS** (mixed signals never HIGH)
   A legitimate 2-token brief whose winner matches both ("escreva o ebook",
   2/2) is untouched. Count and fraction are always combined — either alone
   was measured to punish honest briefs.
2. **business_route regex-fire filter.** A route declares an activation
   regex; when the LEADER is a route whose regex fires, competing routes
   whose regexes demonstrably do NOT fire are dropped from the window — they
   are BM25 noise (same-business patterns share almost all tokens and used to
   fabricate near-ties that downgraded HIGH to AMBIGUOUS). Deliberately
   narrow: filtering whenever any route failed to fire was measured and
   REJECTED (it turned safe abstentions into confident errors).
3. **Same-destination cluster collapse.** A cluster that resolves to one
   destination squad/business is not ambiguity — "escreva o ebook" bringing
   the squad capability 1st and the business route to the same squad 2nd is
   HIGH, not a question the user can answer better than the router.

## Stage 3.5 — Dense NO_MATCH fallback (OFF by default)

The ONLY slot where the neural arm (multilingual MiniLM via
`_shared/lib/dense-index.ts`) may speak: when the final signal — after the
bridge — is NO_MATCH, the dense index is consulted and a candidate clearing
cosine **≥ 0.55** returns as an **AMBIGUOUS suggestion** (never HIGH; never a
dispatch). Alternatives dedupe by destination, cap 3. Golden briefs cannot be
touched by construction (measured 2026-08-05: 0 of 2,963 golden cases reach
NO_MATCH).

Why off, and why 0.55: the 22 true negatives have dense top-1 cosines
0.161-0.471 (subject proximity, not competence), and the multilingual probes
that would benefit sit at 0.335-0.655 — the bands OVERLAP, so no threshold
recovers the majority while holding the 73% NO_MATCH safety floor. At 0.55
the fallback recovers 3/12 probes — real but marginal, hence opt-in. Enable:
`nrv embeddings enable` (sets `routing.dense: "fallback"` after verifying the
neural backend loads) or `NIRVANA_ROUTER_DENSE=1`; `NIRVANA_ROUTER_DENSE=0`
forces off. Without the backend, the slot is a clean no-op.

## Stage 4 — Budget pre-flight

`stage4BudgetCheck` delegates to `lib/budget.js`. **Default caps are 0 =
unlimited** — the pre-flight is a no-op until the user sets a positive cap
(`config.yaml`, `ctx.budget`, per-business `run_budget_usd`). A positive cap
is hard. Details: `references/02-budget.md`.

## Stage 5 — Lazy invocation plan

`stage5Invoke` produces a plan, never an execution: `target_type`
(`business` | `business_route` | `squad` | `squad_capability`), ids, manifest
path, loader hint, `inherit_context`, `handoff_artifact_required`,
`max_handoff_tokens: 800`. A squad-level match (per-squad doc) means "load
the squad manifest and dispatch its best capability agentically".

## CLI

```bash
nrv route "<brief>"                     # full pipeline, human summary
nrv find  "<brief>"                     # the shortlist: businesses and squads apart, with cards
nrv find  "<brief>" --json              # the router decision plus `shortlist`
bun skills/harness/lib/router.js route --json "<brief>"

# flags: --json · --prefer business|squad|auto · --no-amplify ·
#        --force-amplify · --prefer-amplifier builtin|maestro ·
#        --no-stage-minus-1
```

The CLI emits `brief_received`, `brief_amplified` (when the amplifier ran),
`context_budget_warning` (when crossing the threshold) and `routing_decision`
(signal, target, route_tier, alternatives) through the canonical audit writer.

## Evaluation (the numbers behind the claims)

`skills/harness/tests/routing-eval.test.ts` runs the golden set
(`example_briefs` ground truth + negatives + multilingual probes) on every
suite run. State at 2026-08-06: n=2,963 · top-1 98.1% · top-3 99.3% ·
MRR 0.987 · squad_capability top-1 99.8% · business top-1 87.7% · negatives
NO_MATCH 73.3% (n=30). Coverage-gate and watermark cases are locked by
`router-coverage.test.ts`, `router-stage3.test.ts` and `router.test.ts` —
recalibrations must keep those green.

## Anti-patterns

- Do NOT auto-invoke on AMBIGUOUS. HP2: failure-loud; confirm with the user.
- Do NOT load full manifests during Stage 2 — registries only (HP5).
- Do NOT treat `nrv route`/`nrv find` output as a decision. `nrv find` is the
  shortlist a model reads before it decides; `nrv route` is a diagnostic.
- Do NOT re-enable the dense fusion by "just trying it" — it was measured
  twice; the fallback slot is where the dense arm lives now.
- Do NOT tune thresholds without re-running the eval suite; the golden set is
  the contract.
