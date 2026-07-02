# Wiki Pattern — How Nirvana Treats Knowledge

> Inspired by Karpathy's "LLM Wiki" (gist 442a6bf555914893e9891c11519de94f).
> Nirvana already implemented ~75% of the pattern under different names;
> this doc names the convention, fixes the leftover gaps, and explains how
> the agents should consume it.

## Three layers

```
raw/                — immutable source documents (research files, articles, briefs you drop in)
wiki layer/         — entity pages (businesses, squads, mind-clones, decisions, gates)
schema layer/       — universal frontmatter + CLAUDE.md/SKILL.md conventions
```

In Nirvana terms:

- **raw/** ≈ `(base de conhecimento interna)/` (output of `/nrv:research`) + briefs handed to `brief-business`.
- **wiki/** ≈ `~/squads/<slug>/`, `~/businesses/<slug>/`, `~/mind-clones/<slug>/`, plus the SQLite tables `decisions_history`, `quality_gates`, `audit_events`.
- **schema/** ≈ `~/.claude/CLAUDE.md`, `~/.claude/skills/<skill>/SKILL.md`, plus the **Universal Asset Metadata** schema below.

## Universal Asset Metadata

Every markdown/yaml file in the wiki layer should declare frontmatter with these
optional fields. None are mandatory — the loader infers what it can — but
declaring them unlocks the graph view, cross-document lint, and search.

```yaml
---
type: business | squad | mind-clone | research | decision | brief | output | task
slug: <kebab-case>
title: <human-readable>
created: <ISO 8601>
updated: <ISO 8601>
links: [other-slugs]               # outbound cross-references
tags: [...]
source: <URL | file path | manual>
status: experimental | stable | archived
version: <semver>
---
```

Schema: `~/.claude/skills/_shared/schemas/asset-meta.schema.json`.
Loader: `~/.claude/skills/_shared/lib/asset-meta.js` (`loadMeta(file)`).

The loader is **backwards-compatible**. Legacy task formats (v2 nested,
v4 flat), raw `squad.yaml`/`business.yaml`, and frontmatter-less markdown
all return a normalized struct with the best-guess `type` and `slug`.

## Operations

### Ingest

When you add a source:

1. Drop it into `(base de conhecimento interna)/` or the project's brief pipeline.
2. Run `/nrv:research <topic>` for web research, OR drop a markdown file with
   the universal frontmatter, OR call `brief-business` with a domain brief.
3. Agents that consume the source: read it, write entity pages or update
   existing ones, append to `decisions_history` if the source locked a choice.

### Query

`bun ~/.claude/skills/harness/scripts/find.ts "<your query>"` routes to the
right asset. The router reads the registries (the Karpathy-equivalent of
`index.md`).

### Lint

`bun ~/.claude/skills/_shared/scripts/lint-wiki.ts <doc1> <doc2> [...]`
runs the cross-document consistency rubric (`~/.claude/skills/_shared/rubrics/wiki-lint.md`)
through quality-judge. Returns a JSON list of factual contradictions classified
by category (naming/strategy/fact/temporal/scope) and severity.

Use it before shipping a multi-doc deliverable. Custo: ~$0.05-0.20 per run.

### View

`bun ~/.claude/skills/harness/scripts/glance.ts` opens the cockpit:

- **Squads / Businesses / Mind-clones / Projects** — entity browser
- **Memory** — Decisions, Quality Gates, Audit events from the SQLite layer
- **Graph** — D3 force-directed knowledge graph (clickable navigation)
- **Cost** — token + USD dashboard with cache hit ratio
- **Activity** — live SSE feed of audit events (right sidebar)

## What the agents should do (instructions for an LLM consuming this)

- **Before answering a non-trivial question**: read the relevant entity pages
  via the registries; do not search the raw docs from scratch.
- **After producing a meaningful output**: append a `decisions_history` row
  if a choice was locked (`bun decision-log.ts add "D-<n>: <text>"`).
- **Before shipping a multi-doc deliverable**: run `lint-wiki` over the docs
  + their anchors (brand book, strategy doc).
- **When stuck on a stalled call**: the host-agent-driver heartbeat watchdog
  will kill + retry. You don't need to detect this manually.
- **When in doubt**: prefer reading the existing entity page over re-deriving
  knowledge.

## What this is NOT

- Not Obsidian. Not a fancy graph viewer. Not a wiki SaaS.
- Not a replacement for orchestration. Nirvana stays an executor; the wiki is
  a knowledge layer that supports execution.
- Not a knowledge graph database (Neo4j, Cypher). The graph is computed
  on-demand from the registries; we don't materialize it.

## What changes over time

The registries (`~/.squads-registry.json`, `~/.businesses-registry.json`)
are rebuilt by the indexers. The SQLite tables grow append-only. Markdown
views are regenerated from the DB via `state-snapshot.ts`. Nothing is
precious; everything is reproducible.
