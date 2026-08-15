// builder.ts — materializes an approved Studio graph into the engine's
// canonical libraries.
//
// Order: topological (depends_on + implicit creation edges). For each node,
// the corresponding lifecycle pipeline is invoked (engine convention:
// creation is engine work, executed through the lifecycle scripts). Node
// status updates are streamed back through the BuildSession events so the
// canvas shows progress.
//
// The builder never edits registries directly: after a successful build, the
// caller is expected to reindex (`nrv index` semantics), which is done by
// studio-server via the lifecycle scripts' own index commands.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOrder,
  inboundEdges,
  type StudioGraph,
  type StudioNode,
} from "./graph-store.ts";
import { resolveScope, writeDir } from "../../_shared/lib/scope.ts";

export type BuildEvent =
  | { kind: "start"; total: number }
  | { kind: "node_start"; nodeId: string; type: string; slug?: string }
  | { kind: "node_done"; nodeId: string; artifact_path?: string }
  | { kind: "node_failed"; nodeId: string; error: string }
  | { kind: "done"; ok: boolean; built: number; failed: number };

export interface BuildSession {
  id: string;
  graphName: string;
  events: BuildEvent[];
  startedAt: string;
}

export const sessions = new Map<string, BuildSession>();

const HOME = process.env.HOME ?? "/tmp";

// Resolved once at module load, the same way the engine's bun-helpers resolve
// the skills root (env override → ~/.nirvana/skills → ~/.claude/skills), with
// an extra fallback to the Studio module's own repository checkout.
function resolveSkillsRoot(): string {
  const candidates = [
    process.env.NIRVANA_SKILLS_DIR,
    join(HOME, ".nirvana", "skills"),
    join(HOME, ".claude", "skills"),
    dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  ].filter((p): p is string => typeof p === "string");
  return candidates.find((p) => existsSync(join(p, "_shared", "scripts"))) ?? candidates[0];
}
const SKILLS_DIR = resolveSkillsRoot();

function runLifecycle(script: string, args: string[], cwd: string = HOME, env?: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Subprocesses read NIRVANA_SKILLS_DIR the same way the engine helpers
    // do, so the lifecycle scripts resolve templates inside the same tree.
    const child = spawn("bun", [script, ...args], { cwd, env: { ...process.env, NIRVANA_SKILLS_DIR: SKILLS_DIR, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function pickSlug(node: StudioNode): string | undefined {
  const p = (node.payload ?? {}) as Record<string, unknown>;
  return typeof p.slug === "string" ? p.slug : undefined;
}

/** Build one node through the lifecycle pipeline that matches its type. */
async function buildNode(node: StudioNode, cwd: string): Promise<string | undefined> {
  const skillsDir = SKILLS_DIR;
  const scope = resolveScope({ cwd });
  const businessesDir = writeDir(scope, "businesses");
  const squadsDir = writeDir(scope, "squads");
  switch (node.type) {
    case "company": {
      const slug = pickSlug(node) ?? node.id.replace(/^company-/, "");
      // businesses init via the lifecycle script; --non-interactive skips the
      // AskUserQuestion wizard rounds (the canvas prompt already captured the
      // build block), and a description is passed from the node payload when
      // the user provided one on the canvas.
      const payload2 = (node.payload ?? {}) as Record<string, unknown>;
      const template = typeof payload2.template === "string" && payload2.template
        ? String(payload2.template)
        : "solo"; // default scaffold type; the engine's interactive wizard picks
                  // "solo" when no template is supplied, so non-interactive mode
                  // needs the flag explicitly
      const args = [slug, "--non-interactive", "--template", template];
      const desc = String(payload2.description ?? "");
      if (desc.trim()) args.push("--description", desc.trim());
      const res = await runLifecycle(join(skillsDir, "businesses", "scripts", "init-business.ts"), args, cwd);
      if (res.code !== 0) throw new Error(res.stderr.slice(0, 500) || `init-business exited ${res.code}`);
      return join(businessesDir, slug);
    }
    case "squad": {
      const slug = pickSlug(node) ?? node.id.replace(/^squad-/, "");
      // squad creation through the engine's own scaffold (squad lifecycle).
      // init-squad.ts expects the TARGET DIRECTORY as positional and uses
      // SQUAD_NAME/SQUAD_DESCRIPTION environment variables for the template.
      const env = {
        ...process.env,
        SQUAD_NAME: slug,
        SQUAD_DESCRIPTION: String((node.payload as Record<string, unknown>)?.description ?? ""),
      };
      const res = await runLifecycle(join(skillsDir, "squads", "scripts", "init-squad.ts"), [join(squadsDir, slug)], cwd, env);
      if (res.code !== 0) throw new Error(res.stderr.slice(0, 500) || `init-squad exited ${res.code}`);
      return join(squadsDir, slug);
    }
    case "mind_clone": {
      // A canonical clone requires source-backed five-layer DNA, persona files,
      // citations, and Genius Factory review. Studio must never register an
      // invented scaffold as a usable clone. Until the engine exposes a
      // non-interactive Genius Factory adapter, fail closed and keep the graph
      // as the approved build plan rather than producing invalid library data.
      throw new Error("mind-clone materialization requires the Genius Factory lifecycle adapter; Studio will not create a draft persona without source-backed DNA");
    }
    case "employee":
      // Employee nodes are resolved in buildGraph only after their parent
      // business lifecycle has produced a matching canonical employee file.
      return undefined;
    case "material":
    case "deliverable":
      // Structural nodes: no lifecycle artifact of their own; they describe
      // inputs and expected outputs for the lifecycle nodes they attach to.
      return undefined;
    default:
      throw new Error(`cannot build node type: ${node.type}`);
  }
}

export async function buildGraph(sessionId: string, graph: StudioGraph): Promise<void> {
  const order = buildOrder(graph);
  const session: BuildSession = { id: sessionId, graphName: graph.name, events: [{ kind: "start", total: order.length }], startedAt: new Date().toISOString() };
  sessions.set(sessionId, session);

  let built = 0;
  let failed = 0;
  for (const node of order) {
    // The entry brief and already-built/failed nodes are structural or
    // terminal states: they do not produce lifecycle artifacts.
    if (node.type === "brief" || node.status === "built" || node.status === "failed") continue;
    session.events.push({ kind: "node_start", nodeId: node.id, type: node.type, slug: pickSlug(node) });
    try {
      let artifact: string | undefined;
      if (node.type === "employee") {
        const ownerEdge = inboundEdges(graph, node.id).find((edge) => edge.type === "owns");
        const owner = ownerEdge ? graph.nodes.find((candidate) => candidate.id === ownerEdge.source) : undefined;
        const employeeSlug = pickSlug(node) ?? node.id.replace(/^employee-/, "");
        const candidate = owner?.artifact_path
          ? join(owner.artifact_path, "employees", `${employeeSlug}.md`)
          : undefined;
        if (!candidate || !existsSync(candidate)) {
          throw new Error(`employee "${employeeSlug}" was not produced by the selected business lifecycle template; Studio will not mark an unmaterialized seat as built`);
        }
        artifact = candidate;
      } else {
        artifact = await buildNode(node, process.cwd());
      }
      node.status = "built";
      node.built_at = new Date().toISOString();
      if (artifact) node.artifact_path = artifact;
      session.events.push({ kind: "node_done", nodeId: node.id, artifact_path: artifact });
      built += 1;
    } catch (err) {
      node.status = "failed";
      node.error = err instanceof Error ? err.message : String(err);
      session.events.push({ kind: "node_failed", nodeId: node.id, error: node.error });
      failed += 1;
    }
  }
  session.events.push({ kind: "done", ok: failed === 0, built, failed });
}
