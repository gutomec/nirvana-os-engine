#!/usr/bin/env bun
// studio-server.ts — serves the Nirvana Studio canvas UI and its REST/SSE API.
//
// Usage:
//   nrv studio                 → http://127.0.0.1:4225
//   nrv studio --port 8000     → custom port
//   nrv studio --host 0.0.0.0  → bind elsewhere (CI / remote dev only)
//   nrv studio --no-open       → do not open a browser automatically
//   nrv studio --new <name>    → create and open a fresh graph
//   nrv studio --open <name>   → open an existing graph
//
// Offline-first: the server binds locally by default, serves a single-page
// UI from memory, and reaches no network except (a) the optional LLM planner
// endpoint and (b) the engine's lifecycle scripts on disk. The store lives at
// ~/.nirvana/studio/graphs/ (or <project>/.nirvana/studio/graphs/) and is the
// ONLY place this module writes, apart from lifecycle outputs.

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planGraph } from "../lib/planner.ts";
import { buildGraph, sessions, type BuildEvent } from "../lib/builder.ts";
import {
  addEdge,
  addNode,
  buildOrder,
  deleteGraph,
  loadGraph,
  listGraphs,
  newGraph,
  reachableFromBriefs,
  resolveStudioScope,
  saveGraph,
  studioStoreDir,
  validateGraphStructure,
  type StudioGraph,
  type StudioNode,
} from "../lib/graph-store.ts";
import { validateGraphProtocol } from "../lib/validators.ts";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const UI_PATH = join(__dirname, "..", "ui", "studio.html");

// ── CLI arg parsing ─────────────────────────────────────────────────────────

interface Args {
  port: number;
  host: string;
  noOpen: boolean;
  open?: string;
  new?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { port: 4225, host: "127.0.0.1", noOpen: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--port" || a === "-p") && argv[i + 1]) args.port = Number(argv[++i]);
    else if (a === "--host" && argv[i + 1]) args.host = argv[++i];
    else if (a === "--open" && argv[i + 1]) args.open = argv[++i];
    else if (a === "--new" && argv[i + 1]) args.new = argv[++i];
    else if (a === "--no-open") args.noOpen = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: nrv studio [--port N] [--host ADDR] [--no-open] [--new <name>] [--open <name>]");
      process.exit(0);
    }
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return args;
}

// ── JSON helpers ────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

async function readBody(req: Request): Promise<unknown> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) return await readMultipart(req);
  if (ct.includes("application/json")) {
    const text = await req.text();
    try { return JSON.parse(text); } catch { return {}; }
  }
  const text = await req.text();
  try { return JSON.parse(text); } catch { return {}; }
}

interface UploadPart { name: string; filename: string; data: Uint8Array }

async function readMultipart(req: Request): Promise<{ fields: Record<string, string>; files: UploadPart[] }> {
  const form = await req.formData();
  const fields: Record<string, string> = {};
  const files: UploadPart[] = [];
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") fields[key] = value;
    else if (value instanceof File) {
      files.push({ name: key, filename: value.name, data: new Uint8Array(await value.arrayBuffer()) });
    }
  }
  return { fields, files };
}

// ── server ──────────────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const command = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
  try {
    Bun.spawn({ cmd: command, stdout: "ignore", stderr: "ignore" });
  } catch {
    // Serving the local UI must not fail just because the host has no browser.
  }
}

function studioApp(args: Args) {
  const cwd = process.cwd();
  let currentGraphName = args.open ?? args.new;

  function current(): { graph: StudioGraph; isNew: boolean } {
    if (currentGraphName) {
      const loaded = loadGraph(currentGraphName, cwd);
      if (loaded) return { graph: loaded, isNew: false };
    }
    const name = args.new ?? "studio-graph";
    const g = newGraph(name, cwd);
    g.name = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "studio-graph";
    return { graph: g, isNew: true };
  }

  let currentRef = current();
  if (currentRef.isNew) {
    saveGraph(currentRef.graph, cwd);
  }

  async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url, `http://${args.host}:${args.port}`);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
    }

    // ── static UI ──
    if (path === "/" || path === "/index.html") {
      return new Response(readFileSync(UI_PATH, "utf8"), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // ── graph list ──
    if (path === "/api/graphs" && req.method === "GET") {
      return json(listGraphs(cwd));
    }

    // ── load current graph ──
    if (path === "/api/graph" && req.method === "GET") {
      const g = loadGraph(currentGraphName ?? "studio-graph", cwd);
      if (!g) return json({ error: "graph not found" }, 404);
      return json(g);
    }

    // ── save graph ──
    if (path === "/api/graph" && req.method === "POST") {
      const body = (await readBody(req)) as Partial<StudioGraph>;
      const struct = validateGraphStructure(body);
      if (struct.length) return json({ ok: false, errors: struct }, 422);
      const proto = validateGraphProtocol(body as StudioGraph);
      const graph: StudioGraph = body as StudioGraph;
      saveGraph(graph, cwd);
      currentGraphName = graph.name;
      currentRef = { graph, isNew: false };
      return json({ ok: true, graph });
    }

    // ── create new graph ──
    if (path === "/api/graph" && req.method === "PUT") {
      const body = (await readBody(req)) as { name?: string };
      const name = (body?.name ?? "studio-graph").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "studio-graph";
      if (existsSync(join(studioStoreDir(cwd), `${name}.json`))) {
        return json({ error: "graph already exists" }, 409);
      }
      const g = newGraph(name, cwd);
      saveGraph(g, cwd);
      currentGraphName = name;
      currentRef = { graph: g, isNew: true };
      return json({ ok: true, graph: g });
    }

    // ── delete graph ──
    if (path.startsWith("/api/graph/") && req.method === "DELETE") {
      const name = decodeURIComponent(path.slice("/api/graph/".length));
      const removed = deleteGraph(name, cwd);
      if (!removed) return json({ error: "graph not found" }, 404);
      if (currentGraphName === name) {
        currentRef = current();
        currentGraphName = currentRef.graph.name;
      }
      return json({ ok: true });
    }

    // ── planner pass ──
    if (path === "/api/plan" && req.method === "POST") {
      const body = (await readBody(req)) as { instruction?: string; attachments?: unknown[] };
      const instruction = typeof body.instruction === "string" ? body.instruction : "";
      if (instruction.trim().length < 3) return json({ error: "instruction too short (min 3 chars)" }, 400);
      try {
        const plan = await planGraph({
          instruction,
          attachments: Array.isArray(body.attachments) ? body.attachments as Array<{ name?: string; path?: string; url?: string; kind?: string }> : undefined,
        });
        // merge into the current graph so the user can approve on the canvas
        const base = currentRef.graph;
        for (const n of plan.nodes) addNode(base, n as StudioNode);
        const nodeIdSet = new Set(base.nodes.map((n) => n.id));
        let auto = 0;
        for (const e of plan.edges) {
          const edge = {
            ...e,
            id: typeof e.id === "string" && e.id.length >= 3 ? e.id : `e-${Date.now().toString(36)}-${(auto++).toString(36)}`,
          };
          if (!nodeIdSet.has(edge.source) || !nodeIdSet.has(edge.target)) continue;
          try { addEdge(base, edge); } catch { /* incompatible/dupe proposals are skipped */ }
        }
        saveGraph(base, cwd);
        return json({ ok: true, plan });
      } catch (err) {
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // ── validate graph ──
    if (path === "/api/validate" && req.method === "POST") {
      const body = (await readBody(req)) as Partial<StudioGraph> | undefined;
      // an empty body ({}) means "validate the current graph"
      const target: StudioGraph =
        body && Object.keys(body).length > 0 ? (body as StudioGraph) : currentRef.graph;
      const struct = validateGraphStructure(target);
      const proto = validateGraphProtocol(target);
      return json({ ok: proto.ok && struct.length === 0, structure: struct, protocol: proto.checks });
    }

    // ── start build (SSE) ──
    if (path === "/api/build" && req.method === "POST") {
      const body = (await readBody(req)) as { graph?: StudioGraph; confirm?: boolean };
      const graph = (body.graph ?? currentRef.graph) as StudioGraph;
      if (body.confirm !== true) {
        return json({ ok: false, error: "explicit confirmation is required before materialization" }, 400);
      }
      const struct = validateGraphStructure(graph);
      if (struct.length) return json({ ok: false, errors: struct }, 400);
      const proto = validateGraphProtocol(graph);
      if (!proto.ok) return json({ ok: false, checks: proto.checks }, 400);
      try {
        buildOrder(graph);
      } catch (err) {
        return json({ ok: false, error: err instanceof Error ? err.message : "graph has invalid build dependencies" }, 400);
      }
      const sessionId = `build-${Date.now().toString(36)}`;
      saveGraph(graph, cwd);
      buildGraph(sessionId, graph).catch((err) => console.error("studio-server: build error:", err instanceof Error ? err.message : String(err)));
      return json({ ok: true, sessionId, graph });
    }

    // ── build SSE stream ──
    if (path.startsWith("/api/build/") && req.method === "GET") {
      const sessionId = path.slice("/api/build/".length);
      const session = sessions.get(sessionId);
      if (!session) return json({ error: "session not found" }, 404);
      const stream = new ReadableStream({
        start(controller) {
          const emit = (events: BuildEvent[]) => {
            for (const e of events) controller.enqueue(`data: ${JSON.stringify(e)}\n\n`);
          };
          // late subscribers get the accumulated history so the UI can
          // resume progress even if the build finished before the SSE connect
          let cursor = session.events.length;
          emit(session.events);
          const interval = setInterval(() => {
            if (cursor < session.events.length) emit(session.events.slice(cursor));
            cursor = session.events.length;
            const last = session.events[session.events.length - 1];
            if (last && last.kind === "done") {
              clearInterval(interval);
              controller.close();
            }
          }, 400);
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" } });
    }

    // ── attachment upload ──
    if (path === "/api/attachments" && req.method === "POST") {
      const { fields, files } = await readMultipart(req) as { fields: Record<string, string>; files: UploadPart[] };
      const destDir = fields.dest === "dna"
        ? join(process.env.HOME ?? "/tmp", "businesses", "_library", "dna", "materials")
        : join(studioStoreDir(cwd), "..", "assets");
      mkdirSync(destDir, { recursive: true });
      const saved: Array<{ name: string; path: string; size_bytes: number }> = [];
      for (const f of files) {
        const safeName = basename(f.filename).replace(/[^a-z0-9._-]+/gi, "_") || "attachment";
        const dest = join(destDir, `${Date.now()}-${safeName}`);
        await Bun.write(dest, f.data);
        saved.push({ name: f.filename, path: dest, size_bytes: f.data.byteLength });
      }
      return json({ ok: true, attachments: saved });
    }

    return json({ error: "not found" }, 404);
  }

  const server = Bun.serve({
    port: args.port,
    hostname: args.host,
    async fetch(req) {
      try {
        return await handler(req);
      } catch (err) {
        console.error("studio-server: unhandled error:", err instanceof Error ? err.message : String(err));
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
      }
    },
    error(err) {
      console.error("studio-server: runtime error:", err?.message ?? String(err));
      return new Response("internal error", { status: 500 });
    },
  });
  const browserHost = args.host === "0.0.0.0" ? "127.0.0.1" : args.host;
  const url = `http://${browserHost}:${args.port}`;
  console.log(`Nirvana Studio · ${url}  (graph: ${currentGraphName ?? "none"})`);
  console.log(`store: ${studioStoreDir(cwd)}`);
  if (!args.noOpen) openBrowser(url);
  return server;
}

const args = parseArgs(process.argv.slice(2));
studioApp(args);
