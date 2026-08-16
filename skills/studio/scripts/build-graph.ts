#!/usr/bin/env bun
// build-graph.ts — headless builder for Studio graphs (CI / scripts).
//
// Usage:
//   bun build-graph.ts <graph-name> --approve  → build an approved graph
//   bun build-graph.ts --from-file <path.json> --approve → build an approved graph file
//
// Mirrors the Studio Protocol v1 pipeline: load → validate → topological build
// through lifecycle scripts → reindex registries.

import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { buildGraph, sessions } from "../lib/builder.ts";
import { loadGraph, saveGraph, validateGraphStructure } from "../lib/graph-store.ts";
import { validateGraphProtocol } from "../lib/validators.ts";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function reindexStudioArtifacts(cwd: string): Promise<void> {
  const skillsDir = process.env.NIRVANA_SKILLS_DIR ?? resolve(import.meta.dir, "..", "..");
  const scripts = [
    join(skillsDir, "businesses", "scripts", "index-businesses.ts"),
    join(skillsDir, "squads", "scripts", "index-squads.ts"),
    join(skillsDir, "_shared", "scripts", "index-clones.ts"),
  ];
  for (const script of scripts) {
    const proc = Bun.spawn({
      cmd: ["bun", script, "--quiet"],
      cwd,
      env: { ...process.env, NIRVANA_SKILLS_DIR: skillsDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (await proc.exited !== 0) {
      throw new Error(`registry indexer failed: ${basename(script)}: ${(await new Response(proc.stderr).text()).slice(0, 300)}`);
    }
  }
}

async function main() {
  const fromFile = arg("--from-file");
  const name = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : undefined;
  if (!process.argv.includes("--approve")) {
    console.error("refusing to materialize without --approve; review the graph in Studio or validate it explicitly first");
    process.exit(1);
  }

  let graph;
  if (fromFile) {
    graph = JSON.parse(readFileSync(resolve(fromFile), "utf8"));
  } else if (name) {
    graph = loadGraph(name);
    if (!graph) {
      console.error(`graph not found: ${name}`);
      process.exit(1);
    }
  } else {
    console.error("usage: build-graph.ts <graph-name> --approve | --from-file <path.json> --approve");
    process.exit(1);
  }

  const struct = validateGraphStructure(graph);
  if (struct.length) {
    console.error("invalid graph structure:", JSON.stringify(struct, null, 2));
    process.exit(1);
  }
  const proto = validateGraphProtocol(graph);
  if (!proto.ok) {
    console.error("protocol checks failed:");
    for (const c of proto.checks.filter((c) => !c.ok)) console.error(`  - ${c.name}: ${c.message}`);
    process.exit(1);
  }

  const sessionId = `cli-${Date.now().toString(36)}`;
  const cwd = process.cwd();
  await buildGraph(sessionId, graph, {
    // The file is the recovery record for headless builds, so persist every
    // terminal node transition before continuing to the next lifecycle step.
    onNodeStateChange: (updated) => { saveGraph(updated, cwd); },
    // Reindexing is deliberately last: registries must observe the durable
    // graph state, including any per-node lifecycle failures.
    afterBuild: async (updated) => {
      saveGraph(updated, cwd);
      await reindexStudioArtifacts(cwd);
    },
  });
  const session = sessions.get(sessionId);
  const finished = session?.events.at(-1);
  const registryFailure = session?.events.find((event) => event.kind === "node_failed" && event.nodeId === "registry");
  if (registryFailure && registryFailure.kind === "node_failed") {
    console.error(`registry reindex failed for graph "${graph.name}": ${registryFailure.error}`);
    process.exit(1);
  }
  if (!finished || finished.kind !== "done" || !finished.ok) {
    console.error(`build failed for graph "${graph.name}"; inspect node statuses and build events before retrying`);
    process.exit(1);
  }

  console.log(`build complete for graph "${graph.name}" — check node statuses in the graph file.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
