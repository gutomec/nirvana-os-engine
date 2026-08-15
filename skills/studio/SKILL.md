---
name: studio
description: "Visual conglomerate builder (Studio Protocol v1): an infinite-canvas, ComfyUI-style environment for composing businesses, squads, mind-clones, employees and materials as interconnected blocks, then materializing them through the engine's existing lifecycle pipelines. Triggers: studio, canvas, visual builder, graph builder, 'construir no canvas', 'montar visualmente'. Read-only when listing graphs; creation flows need the `studio-server.ts` live."
compatibility: "Requires the Nirvana-OS engine: the `nrv` CLI and Bun on PATH. Install: npx @nirvana-os/cli. The server binds to 127.0.0.1 by default (`nrv studio --host 0.0.0.0` overrides). The planner optionally uses NIRVANA_STUDIO_BASE_URL / NIRVANA_STUDIO_API_KEY for an OpenAI-compatible endpoint; without it, the local LLM helper is used."
tools: [Read, Write, Edit, Glob, Grep, Bash]
maxTurns: 50
metadata:
  openclaw:
    emoji: "🎨"
    requires:
      bins: ["bun"]
---

# Studio Protocol Engine v1.0 — Visual Conglomerate Builder

ComfyUI-style infinite canvas for Nirvana-OS. The user describes **what must be
built** in the entry block (the build block), optionally attaching
materials (documents, URLs, transcripts), and the Studio proposes the graph —
companies, squads, mind-clones, employees, deliverables — wired with typed
edges. The user approves or edits on the canvas; the engine then materializes
each node through the **existing lifecycle pipelines**, so a visually built
business is byte-equivalent in protocol terms to one built through prose.

Source of truth for the protocol: `STUDIO_PROTOCOL_V1.md` in this directory.
Schema: `schemas/studio-graph.schema.json`. Lib: `lib/`. Server: `scripts/studio-server.ts`.

---

## Scope of this skill

Lifecycle operations on Studio graphs only: list / create / open / save /
validate / plan / build. The server (`nrv studio`) is the interactive surface;
this skill documents and governs the headless path (`scripts/build-graph.ts`)
and the protocol rules the UI enforces.

**Studio never replaces prose.** The harness remains the maestro and prose
remains first-class. Studio is a projection of the same protocols.

### Position relative to the other pillars

| Surface | Entry | Writes to |
|---|---|---|
| Prose factory (harness / businesses / squads skills) | brief in chat | lifecycle pipelines → `~/businesses`, `~/squads`, `_library/dna` |
| **Studio (this skill)** | graph on canvas | **the same lifecycle pipelines** → same paths |
| `nrv list-*` | — | reads the same registries (Studio triggers a reindex after build) |

---

## Commands

| Command | Implementation | Description |
|---|---|---|
| `nrv studio` | `bun skills/studio/scripts/studio-server.ts` | Serve the canvas UI (default `http://127.0.0.1:4222`) |
| `nrv studio --port N` | same | custom port |
| `nrv studio --new <name>` | same | create + open a fresh graph |
| `nrv studio --open <name>` | same | open an existing graph |
| headless build | `bun skills/studio/scripts/build-graph.ts <graph>` | plan + build a graph without the UI (CI / scripts) |

Graphs persist at `~/.nirvana/studio/graphs/<name>.json` (project-scoped under
`<project>/.nirvana/studio/graphs/` when `NIRVANA_SCOPE=project`).

## Hard rules (non-negotiable)

1. **Validation before build.** `validateGraphStructure` +
   `validateGraphProtocol` must pass before any materialization. A graph with
   no `brief` node, an empty company, a clone without a declared source, or an
   invalid capability id never builds.
2. **No registry mutation.** The studio store is the only place this module
   writes. Registries are refreshed by the lifecycle index commands after a
   build, never edited directly.
3. **No audit fabrication.** Studio never emits audit events itself; the
   lifecycle pipelines it invokes carry the real `dispatch_*` and gate events
   when they are wired. Never claim a dispatch happened because a node turned
   green on the canvas.
4. **Offline-first.** Server binds locally; the UI reaches no network.
5. **Attachments are resolved, never trusted.** Uploaded materials land in
   `_library/dna/materials/` or the graph's own `assets/` folder with
   sanitized names; URLs are kept as strings until the pipeline fetches them.

## The build block (entry node)

The `brief` node carries `instruction` (min 3 chars) and `attachments`.
Sending the block → running `/api/plan` → approving the proposal on the canvas
→ `/api/build` is the canonical flow. Headless equivalent:
`build-graph.ts --from-file <graph.json>`.

Mind-clone nodes created through the Studio are **permanent artifacts** in the
user's library: the planner must declare their source, and the build confirms
with the user before emitting persona DNA (same bar as the prose path, Rule 9
of the harness).

## Canvas model (quick reference)

- Nodes: `brief`, `company`, `squad`, `mind_clone`, `employee`, `material`,
  `deliverable`. Edges: `briefs`, `owns`, `staffs`, `embodies`, `covers`,
  `feeds`, `depends_on`, `yields` — see `STUDIO_PROTOCOL_V1.md §2.2` for the
  full compatibility table.
- Build order: topological over `depends_on` + implicit creation edges
  (`briefs → …`, `owns`, `feeds`, `yields`). Cycles are rejected at
  edge-insertion time.
- Every company must own ≥ 1 employee; employees belong to exactly one
  company; squad capabilities are dotted hierarchical ids
  (`domain.subdomain.verb`).
