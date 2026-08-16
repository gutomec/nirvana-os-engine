# Studio Protocol v1 — Visual Conglomerate Builder

**Status:** specification — first implementation lives in `skills/studio/`.
**Owner:** Nirvana engine (visual builder layer).
**Last updated:** 2026-08-15

## 1. Purpose and position in the engine

The **Studio** is the visual, node-graph layer of Nirvana-OS. It lets the user
compose a conglomerate — businesses, squads, mind-clones, employees — on an
**infinite canvas** (ComfyUI-style), connect the pieces with typed edges, and
hand the whole graph to the engine, which materializes it into the exact same
validated artifacts the prose factories produce today.

Studio is a **layer, not a replacement**. The harness remains the maestro and
prose remains a first-class interface. Every artifact Studio emits passes
through the existing protocols and validators, so a business built visually is
indistinguishable, on disk, from one built through the prose factory:

| Studio artifact | Materialized through | Validated by |
|---|---|---|
| `company` node | Business Protocol v1 (`init-business.ts` + wizard logic) | `validate-business.ts` |
| `squad` node | Squad Protocol v5 creation pipeline | squad validators (`_shared`) |
| `mind_clone` node | Planning only until Genius Factory provides a source-backed non-interactive adapter | `validate-mind-clones` |
| `employee` node (child of a company) | Verified only when produced by the selected Business Protocol template | Business Protocol BP1–BP12 |
| `material` / `deliverable` node | Planning metadata retained in the graph; not an independently materialized artifact | graph validators |

If Studio is absent, nothing changes. If the graph store is missing or corrupt,
`nrv studio` rebuilds scaffolding and never loses data outside its own store.

## 2. The graph

The unit of persistence is a **graph document** at
`~/.nirvana/studio/graphs/<slug>.json` (project-scoped graphs live at
`<project>/.nirvana/studio/graphs/` when `NIRVANA_SCOPE=project`).

```json
{
  "schema_version": "1.0.0",
  "name": "podcast-empire",
  "created_at": "2026-08-15T19:00:00Z",
  "updated_at": "2026-08-15T20:10:00Z",
  "canvas": { "x": 0, "y": 0, "zoom": 1 },
  "nodes": [ { ... } ],
  "edges": [ { ... } ]
}
```

### 2.1 Node types

| Type | Purpose | Required payload |
|---|---|---|
| `brief` | What must be built; the entry block the user fills in (text + attachments) | `instruction` (string), `attachments` (optional, resolved file paths) |
| `company` | A business (Business Protocol v1) | `slug`, `description`, `domains[]`, `template` |
| `squad` | A portable team (Squad Protocol v5) | `slug`, `description`, `capabilities[]` |
| `mind_clone` | Persona DNA (5 layers) | `slug`, `source`, `one_liner` |
| `employee` | A seat inside a company | `slug`, `role`, `title` |
| `material` | Raw material fed into a clone/company (docs, URLs, transcripts) | `path` or `url`, `kind` |
| `deliverable` | Expected output of the conglomerate | `description` |

Each node carries, beyond its payload: `id` (deterministic: `<type>-<slug>` or
`<type>-<uuid>` for unsaved drafts), `position` (`x, y`), `status`
(`draft | queued | building | built | failed`), `meta` (free object).

### 2.2 Edge types

Edges are typed contracts. An edge is invalid unless both endpoint types allow it.

| Edge | From → To | Effect at materialization |
|---|---|---|
| `briefs` | `brief → company|squad|mind_clone` | Supplies the reviewed instruction to supported lifecycle nodes |
| `owns` | `company → employee` | Verifies a canonical employee file created by the selected business template |
| `staffs` | `employee → squad` | Planning relation; fails closed until an employee-to-squad lifecycle adapter exists |
| `embodies` | `employee → mind_clone` | Planning relation; fails closed until a canonical assignment adapter exists |
| `embodies` | `company → mind_clone` | Planning relation; fails closed until a canonical assignment adapter exists |
| `covers` | `squad → company` | Planning relation; fails closed until a business authorization adapter exists |
| `feeds` | `material → mind_clone|company|squad` | Retained as reviewed build context |
| `depends_on` | any → any | Build order; target is built before source |
| `yields` | `company|squad → deliverable` | Retained as a declared output for a downstream quality gate |

### 2.3 Graph rules

1. A graph with zero `brief` nodes cannot be built (a brief is the entry).
2. The build proceeds **topologically** over every effective creation dependency.
   Both interactive and hand-authored graphs are rejected if they contain a
   cycle before a build session is acknowledged.
3. A materializable node is marked `built` only after its canonical lifecycle
   script succeeds and its expected artifact exists. Briefs, materials and
   deliverables are planning metadata and retain their draft status.
4. A build persists node `status`, `built_at`, `artifact_path`, and errors after
   every lifecycle result; restart-safe graph state is therefore authoritative.
5. The graph store is never an alternate registry: after lifecycle output is
   persisted, Studio runs the standard business, squad, and clone indexers. A
   build reports success only if those indexers succeed.

## 3. The build block (entry node)

The `brief` node is the "bloco de construção" of the idea: a free-form text
field (**what must be built**) plus an **attachment zone** (files, URLs,
transcripts — anything that describes the thing to be built). When the user
requests a build:

1. The server resolves attachments into the engine's content paths
   (`_library/dna` for persona material; a per-graph `assets/` folder for the
   rest) and rewrites the node payload to absolute paths.
2. A **planner pass** (the harness in prose mode, invoked by the skill) reads
   the instruction + materials and proposes the node set and edges (which
   companies, squads, clones, employees, and how they connect).
3. The user **approves or edits the proposed graph** on the canvas — drag,
   rewire, rename, drop.
4. Each approved **supported** node is then materialized one by one through its
   lifecycle pipeline, with `status` updates streamed to the client.

Material attached to a `mind_clone` is retained as an approved creation plan.
Materialization is deliberately fail-closed until the engine exposes a
non-interactive Genius Factory adapter that produces the source-cited five-layer
DNA required by the mind-clone pipeline; Studio never registers draft personas
as usable clones.

## 4. Server contract (`nrv studio`)

A zero-dependency Bun HTTP server (`studio-server.ts`) that serves a single-page
UI and exposes:

| Endpoint | Method | Purpose |
|---|---|---|
| `/` | GET | The canvas UI |
| `/api/graph` | GET/POST | Load / save the graph |
| `/api/graphs` | GET | List saved graphs |
| `/api/plan` | POST | Planner pass: `{ instruction, attachments }` → proposed nodes + edges |
| `/api/build` | POST | Start materialization of an approved graph |
| `/api/build/:id` | GET | SSE/status stream for build progress |
| `/api/validate` | POST | Run the protocol validators over the current graph |
| `/api/attachments` | POST | Multipart upload → resolved engine paths |

The server binds to `127.0.0.1` by default (`--host` accepts loopback aliases
only; `--port` chooses a port, default 4225). It has no CORS policy or remote
bind because materialization is a local privileged operation. The UI reaches no
network itself.

## 5. Invariants the Studio must never violate

- **No silent writes outside its own store** except through the lifecycle
  pipelines (which already carry the audit events).
- **No registry mutation**: `~/.businesses-registry.json` and
  `~/.squads-registry.json` are regenerated by the standard index commands;
  Studio invokes them after a build (`nrv index` semantics), never edits them.
- **Prose parity**: anything expressible on the canvas is expressible in prose;
  the canvas is a projection of the same protocols.
- **Offline-first**: the server and the UI are local; no telemetry, no cloud.
