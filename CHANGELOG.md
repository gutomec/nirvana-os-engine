# Changelog

All notable changes to the Nirvana-OS engine. Versions map to GitHub releases
(`nirvana-os-engine`); each release ships the full engine tarball that
`npx @nirvana-os/cli` and pack installs consume.

## 0.1.58 — 2026-07-17

### The engine never prescribes a model
- The model used is ALWAYS the one configured in the user's own agent runtime
  (Claude Code, Codex, Gemini, Antigravity, …). The engine only overrides it when
  the user explicitly asks for a specific model.
- Removed every default model from the engine: judge config (`default_judge_model:
  inherit`), capability `model_hint` default, rubric `target_model` (now
  telemetry-only `inherit`), adapter docs, and the pixelle client (now
  `gemini-flash-latest`, the provider's non-versioned pointer — no more 404s from
  retired model slugs).

### Router: explicit mention wins; business-first stops hijacking
- New Stage 0.5: naming a squad or business by slug ("use o squad code-review…")
  deterministically short-circuits routing (`route_tier: explicit_mention`) —
  before any scoring. Accent/hyphen-normalized, guarded against false positives.
- Business-first preference is now a relative tiebreak against the best squad,
  never an absolute floor; artifact-pattern routes (`business_route`) compete
  inside the RRF fusion as a third ranked list instead of short-circuiting ahead
  of content matching. Briefs that clearly match a squad no longer get hijacked
  by unrelated business routes.

### Repo & docs
- `CHANGELOG.md` (this file), `AGENT-QUICKSTART.md` (one-page agent onboarding),
  `SECURITY.md`, issue/PR templates, `examples/` end-to-end walkthrough.
- README hero image + CI badge; version badge now rewritten from `package.json`
  at publish time.
- `AGENTS.md` is the single source for the agent contract; `CLAUDE.md`/`GEMINI.md`
  are generated copies (drift fails the publish).
- `skills/harness/SKILL.md` normalized to English throughout.
- New tests: audit event emission (`audit-emit`) and quality-gate selection/fail-closed paths.

## 0.1.57 — 2026-07-13

- **Windows:** `nrv index` fixed (POSIX-only bun-path check made every indexer
  spawn fail with ENOENT when Bun wasn't on PATH); shell-string quoting replaced
  by argv-based `run()`; 11 `.cmd` wrappers fixed (`>nul` instead of
  `/dev/null`); spawn errors now surface their cause.
- **Install anywhere:** the npx installer auto-installs the latest Bun on Windows
  (PowerShell) and continues in the same run; `nrv` is added to the user PATH via
  registry + `WM_SETTINGCHANGE` broadcast so new terminals work without a
  restart; post-install indexing now runs on Windows (`nrv.cmd`); hook commands
  are quoted and use per-OS stderr suppression; `fileURLToPath` fixes repo-root
  resolution on Windows.

## 0.1.56 — 2026-07-13

- Grok-aware ENGINE-MENU (Grok Imagine i2v across video squads' guidance).
- `brief-squad.ts`: squad dispatch now scaffolds the project dir, HANDOFF and
  brief AND emits `brief_received`/`dispatch_squad` automatically — the audit
  trail exists on any runtime, no reliance on the agent obeying SKILL.md.

## 0.1.55 — 2026-07-10

- `nrv doctor` reports honestly: "last activity <date>" instead of a false
  "no dispatches yet?"; detects outputs-without-audit (agent not emitting
  events) and squad dispatches (not only businesses); OS-safe paths.

## 0.1.54 — 2026-07-10

- Security hardening: removed `js-yaml` (DoS advisory GHSA-h67p-54hq-rp68) —
  the two remaining users migrated to `yaml` v2; `bun audit` clean.
- Embedder locked with `allowLocalModels=false` (closes the local-model vector
  of the ONNX CVEs; hub/cache behavior unchanged).

## 0.1.53 — 2026-07-10

- Hybrid retrieval: BM25 + optional local dense arm (transformers.js/ONNX,
  multilingual MiniLM) fused with Reciprocal Rank Fusion; opt-in via
  `nrv embeddings enable` — the core stays zero-hard-dep with graceful fallback.
- Router calibration (E1–E7 external audit): capability `keywords`/
  `example_briefs`/`produces` indexed with field weighting; org-noun vs verb
  separation; best-business-only promotion; generic-object abstention in the
  keyword stage; meta-intent pruning.
- Retroactive learning loop: audit readers accept `business_slug`/`squad_name`
  aliases (history recovered); `nrv audit emit` canonical writer CLI.
- First router test suite (69 tests) + YAML/HTML validation rubrics.

---

Earlier releases (0.1.9 → 0.1.52) predate this changelog; see the GitHub
release notes of each tag for their summaries.
