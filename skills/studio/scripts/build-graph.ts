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
import { resolve } from "node:path";
import { buildGraph, sessions } from "../lib/builder.ts";
import { loadGraph, validateGraphStructure } from "../lib/graph-store.ts";
import { validateGraphProtocol } from "../lib/validators.ts";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

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
  await buildGraph(sessionId, graph);
  const finished = sessions.get(sessionId)?.events.at(-1);
  if (!finished || finished.kind !== "done" || !finished.ok) {
    console.error(`build failed for graph "${graph.name}"; inspect node statuses and build events before retrying`);
    process.exit(1);
  }

  // reindex: lifecycle registry commands
  const spawn = (await import("node:child_process")).spawn;
  const HOME = process.env.HOME ?? "/tmp";
  const skillsDir = process.env.NIRVANA_SKILLS_DIR ?? `${HOME}/.nirvana/skills`;
  for (const [script, extra] of [
    [`${skillsDir}/businesses/scripts/index-businesses.ts`, []],
    [`${skillsDir}/squads/scripts/index-squads.ts`, []],
  ] as const) {
    try {
      await new Promise<void>((resolveCmd) => {
        const child = spawn("bun", [script, ...extra], { cwd: process.cwd(), stdio: "ignore" });
        let settled = false;
        const settle = () => { if (!settled) { settled = true; resolveCmd(); } };
        child.on("close", settle);
        child.on("error", settle);
        setTimeout(() => { child.kill(); settle(); }, 30000);
      });
    } catch { /* index best-effort */ }
  }

  console.log(`build complete for graph "${graph.name}" — check node statuses in the graph file.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
