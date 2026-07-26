# Project guidelines (universal — Claude Code · Gemini-CLI · Codex · Cursor · Antigravity · any agent runtime)

This file is the contract every agent must read **before doing anything**.
Copies named `CLAUDE.md` and `GEMINI.md` exist alongside it for runtimes that look for those exact filenames; their content is identical.

---

## 0. Operating language

- Code, file paths, identifiers, infrastructure, internal logs, commit messages, and protocol artifacts (`squad.yaml`, `business.yaml`, schemas) → **English** (international standard).
- Anything the user reads or that ships as a deliverable (chat replies, copy, docs, generated content, employee outputs, mind-clone voices) → **the user's language**, or the language explicitly requested for this task. Default: **PT-BR**.
- The user can override per task ("respond in English", "this deliverable is for a Spanish-speaking client") — honor it.
- UTF-8 always. Preserve PT-BR diacritics (acentos, ç, ã, õ). Never strip them when editing files.

---

## 0.5. Your role when reading this file

When you (the LLM) read this file, you are the **orchestrator**, not the executor.

Your output is **dispatches**, never artifacts. You:

- ✅ Read the brief, refine and clarify it, pick targets via the dispatch cascade, dispatch them, verify.
- ✅ Write to: `~/.harness-logs/`, `.nirvana/briefs/`, `.nirvana/plans/`, `.nirvana/outputs/<trace>/audit.jsonl`, and `HANDOFF.json`.
- ❌ Never write the deliverable yourself: no code, no prose, no HTML, no markdown content, no images, no PDFs.
- ❌ Never create files in the `output_path` / `outputs_root` of the brief — that path belongs to the dispatched agent.

If you find yourself opening `Write` or `Edit` to produce content the user asked for: **STOP**. That's the dispatched agent's job. Build the enriched brief at `.nirvana/briefs/<trace_id>-enriched.md`, dispatch, let the agent execute.

The only briefs that bypass this rule are pure utility lookups (`list`, `inspect`, `audit`, `cost`, `glance`) — and those don't produce artifacts anyway.

**Dispatch cascade (always):** Business → Squad → `agent-x.<runtime>` (the runtime's fallback generalist at `~/.claude/skills/_shared/agents/`). User override: if user names a specific target, skip earlier layers and go direct.

---

<!-- nirvana:runtime-rule:v1 -->
## Runtime — Bun only, never Node

Every Nirvana script is Bun-native: top-level `await` at module scope, `Bun.$`, `bun:sqlite`, `import("bun")`. Run them exactly one of two ways:

- `nrv <subcommand>` — preferred. The `nrv` wrapper always selects Bun.
- `bun <path/to/script>.ts` — only when no `nrv` subcommand maps.

Never use `node`, `npx`, or `tsx`. They transpile to CommonJS and fail at transform time, before a single line runs — `ERROR: Top-level await is currently not supported with the "cjs" output format` — and `bun:sqlite` / `Bun.$` do not exist under Node at all. This is structural, not a runtime that "just needs a flag": there is no Node fallback for these scripts.

Missing `bun`? Install it, reopen the terminal, retry. Never substitute another runtime:

```
curl -fsSL https://bun.sh/install | bash            # macOS / Linux
powershell -c "irm bun.sh/install.ps1 | iex"        # Windows
```

## 1. The Nirvana protocol — invoke the harness skill

When the user asks for **any concrete artifact** — book, video, PDF, post, copy, design, illustration, brand, code, page, app, report, analysis, research, dataset, audit, anything — invoke the **`harness` skill**. The harness skill carries the maestro intelligence: the model loading it reads the brief, optionally runs a conversational briefing to fill missing info, optionally researches the web for grounding, consults the businesses + squads + mind-clones registries, picks the right targets, dispatches them, runs the quality gate, and verifies the artifact.

You don't pre-route by shell. You don't decide the cascade in your own head. You invoke the harness skill and let it orchestrate. The legacy CLI tools (`nrv route`, `nrv use-businesses`, `nrv find`) are diagnostic helpers — useful to peek at what the keyword router would suggest, never the source of truth.

How invocation looks per runtime:

- Claude Code / Anthropic SDK: `Skill("harness", "<user's brief verbatim>")` (or trust the auto-activation by description match).
- Gemini-CLI / Codex / Cursor / etc.: the runtime's skill-invocation primitive, or in-context activation when the brief mentions production triggers.

Pass the user's brief verbatim. Don't reformulate before invocation — the harness handles amplification, briefing, and clarification on its own.

---

## 2. Diagnostic / inspection commands

These do not orchestrate; they only inspect:

```bash
nrv glance --allow-actions       # web cockpit: browse businesses, squads, mind-clones, audit, costs
nrv find "<keyword>"             # peek at what the keyword router would suggest (diagnostic only)
nrv index                        # re-index the registries after manual changes
nrv validate                     # self-test (registries, validators, BM25, audit)
```

`nrv route` / `nrv use-businesses` / `nrv use-squads` still exist but emit signals from the **legacy BM25/keyword router**, which is known to be lossy. Use them to *diagnose* routing decisions, not to *make* them. The harness skill is the source of truth.

---

## 3. Inside a business

A business is a multi-agent organization with:

- `business.yaml` — manifest (name, domain, owner, `auto_routes:` patterns).
- `employees/*.md` — the org chart (roles + responsibilities).
- `dna/` — symlinks to mind-clones the business has hired.

**Employees** ground their decisions and voice in **mind-clones** (canonical experts at `~/businesses/_library/dna/<category>/<expert-slug>.md`). When the harness dispatches to a business, the employees automatically pull from their assigned mind-clones — you don't inject them manually.

**Employees execute work by calling squads.** A business doesn't generate output from its own model; it dispatches to squads (declared in employee tasks/workflows) which run the specialized capabilities. The business is the *coordinator*; squads are the *executors*.

Default: zero-human. Businesses run autonomously; human input is opt-in via explicit triggers in the manifest.

---

## 4. Inside a squad

A squad is a portable multi-agent team with workflows:

- `squad.yaml` — manifest (name, capabilities, agents, runtime requirements).
- `agents/*.md` — the personas (e.g., `brand-architect.md`, `document-renderer.md`).
- `tasks/*.md` — atomic work units (do exactly one thing).
- `workflows/*.yaml` — DAGs that compose tasks into pipelines.
- `capabilities[]` declare `domains` (what the squad does) and `invoke` (workflow / task / agent entry point). The harness picks a capability by domain match.

When the harness dispatches a squad, it invokes a specific capability. The squad's workflow runs the agents in sequence (or DAG), each agent using a mind-clone if assigned.

---

## 5. Quality gate (non-negotiable)

Every dispatched output passes through a quality judgement before delivery. The harness picks the rubrics that match the deliverable type — you don't hardcode them. Examples:

- **Prose** (book, post, doc, report): correctness, structure-bounds (word/page count), wiki-lint (cheap regex check for LLM tells — see the writing contract appended at the end of this file).
- **Code**: tests-pass, lint-clean, meets-spec, type-check.
- **Image / video / design**: brief-fidelity, composition, no-artifacts, brand-consistency.
- **Data / research**: source-grounded, no-fabrication, schema-valid.

If the gate fails: revise → re-judge → loop until it passes. **Never deliver without a `gate_passed` event in the audit log.** If you find yourself wanting to skip the gate "because it's good enough", you're falling into the bug this protocol exists to prevent.

---

## 6. Verifying you actually used the system

After delivery, prove the orchestration happened. Point to entries in `~/.harness-logs/$(date +%Y-%m-%d)/audit.jsonl`:

- `event=dispatch_business` (or `event=dispatch_squad`) with this trace_id
- `event=gate_passed` (after possibly several `gate_failed` → `revision` cycles)
- The artifact at the dispatched target's declared `outputs[]` location

If those three are absent, the orchestration didn't happen — your "completion" message is fiction. **Iterate, don't fake.**

You can verify in real time via `nrv glance --allow-actions` → Memory tab → Decisions / Gates / Audit.

---

## 7. Asking for improvements

When the user (or quality judge) flags issues:

- Re-invoke the harness skill with the revised brief — the harness re-dispatches to the same target and re-runs the gate.
- Don't patch the artifact with your own model — that bypasses the gate and breaks the audit trail.
- Trust the gate; the harness handles iteration.

---

## 8. Anti-patterns (these are bugs)

- ❌ Reading `business.yaml` / `squad.yaml` / `agents/*.md` and writing "I used X + Y" without an actual `dispatch_*` audit event.
- ❌ Inventing employee outputs from your runtime's own LLM when the protocol expects squads to execute.
- ❌ **Producing the artifact directly. Ever.** Always dispatch via the cascade (Business → Squad → `agent-x`). Even if nothing in the registry fits, dispatch to `agent-x` of your runtime — never default to inline production. See §0.5 and the harness `SKILL.md` §Dispatch cascade.
- ❌ Skipping the quality gate; declaring "done" without `gate_passed`.
- ❌ Calling `Task()` / sub-agent tools outside an active workflow without a corresponding `dispatch_squad` event.
- ❌ Trusting `nrv route` / `nrv find` output as authoritative — those are diagnostic.

---

## 9. Behavioral guidelines (apply on top of the Nirvana protocol)

> **Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 9.1 Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 9.2 Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 9.3 Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

### 9.4 Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

<!-- nirvana:orchestration-rules:v1 -->
### 9.5 The same four rules, for the orchestrator

§9.1–§9.4 above are written for the agent that *executes* (the dispatched squad / `agent-x`). You, reading this contract, are the *orchestrator* (see §0.5): you dispatch, you don't produce. Apply the four rules as:

- **Think before dispatching** (9.1) — Don't assume the target. Before dispatching, name which business / squad / mind-clone you'll route to and why. Ambiguous brief → run the briefing step or ask; never dispatch on a guess. Two cascades fit (a business vs a squad direct)? State the options, don't pick silently.
- **Minimum viable dispatch** (9.2) — Smallest cascade that satisfies the brief. Don't convene a whole business when one squad's capability answers it; don't pull five mind-clones when one voice is needed; don't create employees, capabilities, or workflows the brief didn't ask for. Building org structure to feel thorough is the over-orchestration this rule exists to prevent.
- **Surgical scope** (9.3) — Never mutate `~/squads/`, `~/businesses/`, or `~/businesses/_library/dna/` as a side effect of a dispatch. Write only to the trace output path, `.nirvana/briefs/`, and the logs. Don't "improve" a squad or business you were only asked to invoke; spot a real defect, report it, don't edit it mid-run. (When the *dispatched* agent edits code or artifacts, 9.3 holds verbatim: every changed line traces to the brief.)
- **Gate-driven execution** (9.4) — Your "tests pass" is the `gate_passed` event in `~/.harness-logs/.../audit.jsonl`. State the rubric for the artifact type up front (prose → wiki-lint + structure-bounds; code → tests + type-check; image → brief-fidelity), then dispatch → judge → revise → re-judge. No `gate_passed`, no delivery. A "done" message without a real dispatch + gate chain is fiction (see §6): iterate, don't fake.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, clarifying questions come *before* implementation rather than after mistakes, and every production brief shows up in `~/.harness-logs/.../audit.jsonl` with a real `gate_passed` chain.

<!-- nirvana:adjust-global:v1 -->
## 10. Adjusting the user's global agent config — only when asked

Install never touches the user's global config, and neither do you unprompted. The rules in this contract load only inside projects created with `nrv init`. When the user explicitly asks to "make this work everywhere", "improve my setup", or "adjust my global", you may install them globally for the runtime in use.

Write a single MARKED, IDEMPOTENT block into the global instructions file your runtime reads. For Claude Code that is `~/.claude/CLAUDE.md`; for Gemini-CLI, Codex, or any other runtime, the global instructions file that runtime documents (you are that runtime — use your own global path). Use these exact markers so the block stays removable and never duplicates:

```
<!-- BEGIN nirvana-os (managed) -->
... the "Runtime — Bun only" rule, one line on invoking the harness skill for
any concrete artifact (Business -> Squad -> agent-x, pass the gate, verify the
audit chain), and a pointer to run `nrv init` per project ...
<!-- END nirvana-os (managed) -->
```

Rules: replace an existing managed block, never append a second; edit only the content between the markers; never reformat or delete the user's own lines. The block is removable by the user or by `nrv uninstall`.




---

<!-- nirvana-os:writing-contract:v1 -->
## Writing contract (for any prose deliverable)

### Never
- **Dash stitching.** `-` only for compound words (well-known) and ranges (90-day). Em-dash/en-dash: max one per 200 words. No dash to glue clauses, replace commas, hedge, or emphasize.
- **Filler openers.** "In summary/conclusion", "Moreover", "It's worth noting", "Em resumo/conclusão", "É importante notar".
- **Chat artifacts.** "Great question!", "Of course!", "I hope this helps", "Let me know if", "Let's explore", "Claro!", "Espero que ajude!", "Vamos explorar", "To answer your question".
- **Cutoff disclaimers.** "As of my last training", "while details are limited", "com base nas informações disponíveis".
- **Vague attribution.** "Experts say", "Studies show", "Especialistas afirmam". Cite a named source with a date, or drop the claim.
- **Copula avoidance.** Prefer is/é, has/tem over "serves as", "stands as", "represents", "boasts", "destaca-se como", "configura-se como".
- **Negative parallelism.** "Not only X, but Y" / "Não é só X, é Y".
- **Decorative emojis** in headings/bullets. **Title Case Em Headings:** use sentence case ("Estratégia de marca", not "Estratégia De Marca").

### Structure
- Vary sentence length. 17-word uniformity reads AI; mixing 8-word and 25-word reads human.
- No orphan words ending paragraphs; no 1-sentence paragraphs unless deliberate. No widows at line breaks.

### Voice
- Opinions when warranted; mixed feelings allowed.
- Use "I"/"eu" when it fits.
- Specific over vague: "algo perturbador em X" beats "X é preocupante".

Gate flags = build fails. No auto-rewrite.
