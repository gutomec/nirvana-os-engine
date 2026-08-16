# Studio — Infinite-Canvas Builder for Nirvana-OS

Studio is the visual layer of Nirvana-OS: a **ComfyUI-style infinite canvas**
where a conglomerate — companies, squads, mind-clones, employees, materials —
is composed as interconnected blocks and then materialized by the engine's
existing lifecycle pipelines.

```bash
nrv studio            # open the canvas at http://127.0.0.1:4225
nrv studio --no-open  # serve without opening a browser
nrv studio --new my-company
```

## How it works

1. **Build block.** Drop the entry block on the canvas, describe what must be
   built, attach materials (docs, URLs, transcripts).
2. **Generate.** The planner proposes the full graph: which companies, squads,
   mind-clones and employees, and how they connect.
3. **Approve & edit.** Rewire edges, rename blocks, add employees, drop the
   proposal onto the infinite canvas (pan, zoom, minimap).
4. **Validate & build.** The engine materializes only entities and relationships
   with a canonical non-interactive lifecycle adapter. Company nodes and
   single-capability squad skeletons are supported; mind-clones and relationship
   links that lack a lifecycle adapter remain reviewable plans and fail closed.
   Successful lifecycle outputs are reindexed before the build reports success.

Every successful Studio build is validated by the same protocols and indexers
the prose factories use. Unsupported planning relationships are visible and
reviewable, but never reported as materialized.

## Protocol

- `STUDIO_PROTOCOL_V1.md` — the full specification (node/edge types, build
  rules, server contract, invariants).
- `schemas/studio-graph.schema.json` — the graph document schema.
- `lib/` — graph store, exporters, validators, planner, builder.
- `scripts/studio-server.ts` — the self-hosted server + REST/SSE API.
- `scripts/build-graph.ts` — headless builder.
- `ui/studio.html` — the zero-dependency canvas UI (pan/zoom, drag-drop nodes,
  typed edge linking, minimap, validation and build panels).

## Storage

`~/.nirvana/studio/graphs/<name>.json` — the Studio store. It never touches
the business/squad registries or the audit log; registries are reindexed by the
lifecycle commands after a build.

## Environment

| Variable | Purpose | Default |
|---|---|---|
| `NIRVANA_STUDIO_BASE_URL` | OpenAI-compatible planner endpoint | local helper |
| `NIRVANA_STUDIO_API_KEY` | API key for the planner endpoint | — |
| `NIRVANA_STUDIO_MODEL` | model name sent to the planner | `local` |
| `NIRVANA_SCOPE=project` | project-scoped graphs (`.nirvana/studio/`) | global |
