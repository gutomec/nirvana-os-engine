# Mind-Clone Locale Contract

**Status:** active · **Owner:** `_shared/lib/locale-resolver.ts` · **Cache convention:** sibling files

## Goal

Mind-clone DNA documents (under `$BUSINESSES_LIBRARY/dna/<category>/<slug>.md`)
are authored in Portuguese (Brazil) as the canonical source of truth. Other
locales are **derived caches** stored alongside the canonical file as
`<slug>.<locale>.md` (e.g. `alex-hormozi.en.md`). Translation is **lazy and
on-demand**; nothing is auto-translated at boot.

## Naming

- **Canonical:** `<slug>.md` — author-managed, treated as source.
- **Translated cache:** `<slug>.<locale>.md` where `<locale>` is BCP-47
  (`en`, `pt-BR`, `es-MX`, `de`, `fr`, …).
- The audit scorer (`audit-mindclones-score.ts`) considers only canonical
  files. Locale variants are derivative artifacts and not separately scored.

## Locale resolution

`locale-resolver.ts` selects the active locale, in this order:

1. `NIRVANA_LOCALE` env var
2. `<project-root>/.nirvana/config.yaml` `locale:` key
3. POSIX `LC_ALL` or `LANG` (e.g. `en_US.UTF-8` → `en-US`)
4. Default `pt-BR`

The locale is cached for 30 seconds within a process.

## Lookup

`getMindClone(category, slug, locale?)` in `harness/lib/glance/data-loader.ts`
attempts in order:

1. `<slug>.<full-locale>.md` (e.g. `alex-hormozi.en-US.md`)
2. `<slug>.<language>.md` (e.g. `alex-hormozi.en.md`)
3. `<slug>.md` (canonical fallback, always succeeds when the persona exists)

The return value carries `is_translation: boolean` and `locale: string | null`
so callers know whether they got a derived or the canonical version.

`listMindClones()` filters out locale-variant filenames so registries and the
Glance sidebar do not duplicate personas.

## Translation

`bun ~/.claude/skills/_shared/scripts/translate-mindclone.ts <category>/<slug> --to <locale>`
translates a single canonical to the target locale. `--all` translates the
whole library. The translator runs through the host agent runtime
(`host-agent-driver.ts`) — Claude Code, Codex, Gemini CLI, etc. — using the
host's default model and authentication. No model is hard-coded.

### Cache invalidation

Each translated file carries these keys in its frontmatter:

```yaml
source_hash: "<first-16-hex-of-sha256-of-canonical-bytes>"
source_locale: "pt-BR"
target_locale: "en"
translated_at: "<ISO-8601 timestamp>"
```

A re-run skips files whose `source_hash` already matches the canonical's hash.
Pass `--force` to retranslate regardless. Editing the canonical changes the
hash and the next run will regenerate the affected translations.

### Quality preservation

The translator persona (built into the script) enforces:

- Voice, register, and rhetorical force preserved.
- First-person and third-person persona patterns kept intact.
- YAML frontmatter structure preserved (keys never renamed; values translated).
- Markdown structure preserved (headings, lists, tables, code blocks).
- Domain jargon (CAC, LTV, Grand Slam Offer, etc.) kept canonical.
- Proper nouns and trademarks not translated.

## Commits and review

- Canonical files: review like any other authored content.
- Translated caches: treat as build artifacts. Review-light unless the user
  reports a fidelity issue with a specific persona; in that case the fix is
  almost always to improve the canonical (which then invalidates the cache
  and forces a re-translation).

## When NOT to use this contract

- For squads or businesses, where the protocols (`squad.yaml`, `business.yaml`)
  are themselves system contracts and must remain in English. Only the
  free-form persona content of mind-clones is treated as locale-bearing.
- For runtime user-facing output. Agents responding to the user mirror the
  user's conversation language directly, without consulting this cache.
