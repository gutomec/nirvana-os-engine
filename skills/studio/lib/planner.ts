// planner.ts — the planner pass of Studio Protocol v1 §3.
//
// Reads a build-block instruction (+ resolved attachments) and proposes the
// node set and edges that would realize it. The proposal is rendered on the
// canvas for the user to approve or edit; only approved graphs are built.
//
// The planner itself is a structured prompt over a language model available in
// the sandbox (engine convention: prose factories delegate to the runtime's
// model; here the Studio server uses the local LLM helper when
// NIRVANA_STUDIO_MODEL is unset, or any OpenAI-compatible endpoint when
// NIRVANA_STUDIO_BASE_URL / NIRVANA_STUDIO_API_KEY are set).
//
// Output shape is constrained to the graph schema so the UI can place nodes
// deterministically.

import type { StudioGraph, StudioNode, StudioEdge } from "./graph-store.ts";

export interface PlannerInput {
  instruction: string;
  attachments?: Array<{ name?: string; path?: string; url?: string; kind?: string }>;
  existingGraph?: StudioGraph; // continue/edit an existing graph
}

export interface PlannerOutput {
  name: string;
  nodes: Array<Omit<StudioNode, "status" | "built_at" | "artifact_path">>;
  edges: StudioEdge[];
  reasoning: string;
}

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

const SYSTEM_PROMPT = `You are the Nirvana-OS Studio planner: given a free-form instruction about what
the user wants to build, propose a node-graph on the Studio canvas that realizes it using
Nirvana-OS concepts.

Available node types:
- brief: the entry block carrying the instruction and attachments
- company: an autonomous business with an org chart of employees (Business Protocol v1)
- squad: a portable agent team with capabilities (Squad Protocol v5)
- mind_clone: persona DNA of an expert (5 layers: philosophies, mental_models, heuristics, frameworks, methodologies)
- employee: a seat inside a company
- material: raw material (docs, URLs, transcripts) feeding a creation node
- deliverable: expected output of the conglomerate

Edge types and allowed directions:
- briefs: brief -> company|squad|mind_clone
- owns: company -> employee
- staffs: employee -> squad
- embodies: employee -> mind_clone
- covers: squad -> company
- feeds: material -> mind_clone|company|squad
- depends_on: any -> any (build order)
- yields: company|squad -> deliverable

Rules:
- Every company MUST own at least one employee.
- Squad capabilities are dotted hierarchical ids: domain.subdomain.verb (e.g. marketing.copywriting.write).
- Mind-clone nodes need a source (the person/work/method they embody) and a one_liner.
- Slugs: lowercase, hyphens, 3-60 chars.
- Keep the graph minimal: only propose entities the instruction actually calls for.
- Place nodes with sensible x/y coordinates (grid, step ~300px) so the canvas is readable.

Respond ONLY with JSON matching the PlannerOutput shape.`;

function buildUserPrompt(input: PlannerInput): string {
  const lines = [`Instruction: ${input.instruction}`];
  if (input.attachments?.length) {
    lines.push("", "Attachments:");
    for (const a of input.attachments) {
      lines.push(`- ${a.name ?? a.path ?? a.url ?? "unnamed"} (${a.kind ?? "file"})`);
    }
  }
  if (input.existingGraph) {
    lines.push("", "Existing graph to edit/extend (reuse ids where sensible):");
    lines.push(JSON.stringify(input.existingGraph, null, 2).slice(0, 6000));
  }
  return lines.join("\n");
}

export async function planGraph(input: PlannerInput, opts: { model?: string; temperature?: number } = {}): Promise<PlannerOutput> {
  // NOTE: the builtin proxy only accepts a fixed model list; `local` is a
  // sentinel resolved below to the fastest safe model when upstream is set.
  function resolveModel(): string {
    const m = process.env.NIRVANA_STUDIO_MODEL;
    if (m) return m;
    const baseUrl = process.env.NIRVANA_STUDIO_BASE_URL;
    return baseUrl ? "gpt-5-nano" : "local";
  }
  const { model = resolveModel(), temperature = 0.4 } = opts;
  const baseUrl = process.env.NIRVANA_STUDIO_BASE_URL;
  const apiKey = process.env.NIRVANA_STUDIO_API_KEY;

  let content: string;
  if (baseUrl) {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        temperature,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(input) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`planner upstream returned ${res.status}: ${await res.text().then((t) => t.slice(0, 300))}`);
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    content = data.choices?.[0]?.message?.content ?? "";
    if (!content) {
      throw new Error(`planner returned empty content; finish=${data.choices?.[0]?.finish_reason ?? "unknown"} error=${JSON.stringify(data.error).slice(0, 300)}`);
    }
  } else {
    // Local sandbox LLM helper (builtin catalog; JSON shape respected).
    const helper = await import("./local-llm.ts");
    content = await helper.chatLocal(SYSTEM_PROMPT, buildUserPrompt(input), { model, temperature });
  }

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`planner did not return JSON; received: ${content.slice(0, 400)}`);
  }
  let parsed: Partial<PlannerOutput>;
  try {
    parsed = JSON.parse(jsonMatch[0]) as Partial<PlannerOutput>;
  } catch {
    // The blob may be JSON nested inside JSON-in-JSON; try the first balanced
    // parse and fall back to a repair pass.
    const repaired = jsonMatch[0].replace(/,\s*([\]}])/g, "$1").replace(/([\[{])(\s*[\]}])/g, "{}");
    parsed = JSON.parse(repaired) as Partial<PlannerOutput>;
  }
  const name = (typeof parsed.name === "string" && parsed.name) ? parsed.name : "studio-graph";
  const baseName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "studio-graph";
  const nodes = (parsed.nodes ?? []).map((n) => {
    const payload = { ...(n.payload ?? {}) } as Record<string, unknown>;
    if (n.type === "brief") {
      payload.instruction = typeof payload.instruction === "string" ? payload.instruction : input.instruction;
      if (input.attachments?.length) payload.attachments = input.attachments;
    } else if (n.type === "mind_clone") {
      const bag = n.payload ?? {};
      payload.source = typeof bag.source === "string" && bag.source.trim()
        ? bag.source
        : String(bag.one_liner ?? bag.name ?? bag.slug ?? "persona").slice(0, 120);
      payload.one_liner = typeof bag.one_liner === "string" && bag.one_liner.trim()
        ? bag.one_liner
        : input.instruction.slice(0, 160);
    } else if (n.type === "company" || n.type === "squad" || n.type === "employee") {
      if (!payload.slug) payload.slug = (n.slug ?? n.id ?? "").slice(0, 60);
    }
    return {
      ...n,
      id: n.id ?? uid(n.type ?? "node"),
      position: n.position ?? { x: 0, y: 0 },
      payload,
      status: "draft",
    } as PlannerOutput["nodes"][number];
  });
  const out: PlannerOutput = {
    name: baseName,
    nodes,
    edges: inferEdges({ ...parsed } as PlannerOutput, { name: baseName, nodes, edges: [], reasoning: "" }),
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
  };
  return out;
}

// The LLM may omit edges even when the node set clearly implies them.
// This pass re-derives the structural edges from node types and existing
// explicit edges, so the graph always satisfies the protocol:
// brief -> every root target, company -> employees (owns),
// squad -> company (covers), employees -> squads (staffs),
// employees -> clones they embody (embodies).
function inferEdges(parsed: PlannerOutput, out: PlannerOutput): PlannerOutput["edges"] {
  const existing = parsed.edges ?? [];
  const pairs = new Set(existing.map((e) => `${e.source}:${e.target}:${e.type}`));
  const byId = new Map(out.nodes.map((n) => [n.id, n]));
  const byType = new Map<string, PlannerOutput["nodes"]>();
  for (const n of out.nodes) {
    const t = n.type ?? "node";
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(n);
  }
  const edges: PlannerOutput["edges"] = [...existing];
  const add = (source: string, target: string, type: string) => {
    if (pairs.has(`${source}:${target}:${type}`)) return;
    pairs.add(`${source}:${target}:${type}`);
    edges.push({ id: uid("edge"), source, target, type } as PlannerOutput["edges"][number]);
  };
  const briefs = byType.get("brief") ?? [];
  const companies = byType.get("company") ?? [];
  const employees = byType.get("employee") ?? [];
  const squads = byType.get("squad") ?? [];
  const clones = byType.get("mind_clone") ?? [];
  const rootTargets = [...companies, ...squads, ...clones];
  for (const b of briefs) for (const t of rootTargets) add(b.id, t.id, "briefs");
  for (const c of companies) for (const e of employees) add(c.id, e.id, "owns");
  for (const s of squads) for (const c of companies) add(s.id, c.id, "covers");
  for (const e of employees) for (const s of squads) add(e.id, s.id, "staffs");
  for (const e of employees) for (const c of clones) add(e.id, c.id, "embodies");
  return edges;
}
