/**
 * race-detector.ts — given a planned layer of parallel nodes, detects
 * resource contention (write conflicts, handoff destination collisions).
 *
 * Conservative by design: any potential conflict triggers a "fallback to
 * serial" recommendation. Caller can then either accept (run in serial,
 * losing the parallelism gain) or use this as a hint to fix the manifests.
 *
 * Phase 5 da nirvana-evolution.
 */

export interface NodeIO {
  id: string;
  writes_paths?: string[];    // file/memory paths the node writes
  handoff_to?: string[];      // recipient ids for handoff messages
  reads_paths?: string[];     // optional; for read/write conflict detection
}

export interface RaceConflict {
  kind: "write_write" | "handoff_collision" | "read_write";
  nodes: string[];
  resource: string;
  message: string;
}

export interface RaceReport {
  conflicts: RaceConflict[];
  safe: boolean;                    // true ↔ conflicts.length === 0
  recommend: "parallel" | "serial"; // "serial" when conflicts ≥ 1
}

function buildIndex<T extends string>(items: NodeIO[], pick: (n: NodeIO) => T[] | undefined): Map<T, string[]> {
  const idx = new Map<T, string[]>();
  for (const n of items) {
    for (const v of pick(n) ?? []) {
      if (!idx.has(v)) idx.set(v, []);
      idx.get(v)!.push(n.id);
    }
  }
  return idx;
}

export function detectRaces(layer: NodeIO[]): RaceReport {
  const conflicts: RaceConflict[] = [];

  // write-write conflicts
  const writeIdx = buildIndex(layer, (n) => n.writes_paths);
  for (const [path, nodes] of writeIdx.entries()) {
    if (nodes.length > 1) {
      conflicts.push({
        kind: "write_write",
        nodes: [...nodes].sort(),
        resource: path,
        message: `nodes [${nodes.join(", ")}] all write to '${path}' — write order undefined under parallelism`,
      });
    }
  }

  // handoff collisions
  const handoffIdx = buildIndex(layer, (n) => n.handoff_to);
  for (const [recipient, nodes] of handoffIdx.entries()) {
    if (nodes.length > 1) {
      conflicts.push({
        kind: "handoff_collision",
        nodes: [...nodes].sort(),
        resource: recipient,
        message: `nodes [${nodes.join(", ")}] all hand off to '${recipient}' — recipient receives concurrent inputs`,
      });
    }
  }

  // read-write conflicts: a node reads a path that another node writes.
  for (const n of layer) {
    for (const p of n.reads_paths ?? []) {
      const writers = writeIdx.get(p) ?? [];
      const otherWriters = writers.filter((w) => w !== n.id);
      if (otherWriters.length > 0) {
        conflicts.push({
          kind: "read_write",
          nodes: [n.id, ...otherWriters].sort(),
          resource: p,
          message: `node '${n.id}' reads '${p}' while [${otherWriters.join(", ")}] write to it — read may see partial state`,
        });
      }
    }
  }

  // Deduplicate by (kind|resource|sorted nodes)
  const seen = new Set<string>();
  const uniq: RaceConflict[] = [];
  for (const c of conflicts) {
    const k = `${c.kind}|${c.resource}|${c.nodes.join("|")}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(c);
  }

  return {
    conflicts: uniq,
    safe: uniq.length === 0,
    recommend: uniq.length === 0 ? "parallel" : "serial",
  };
}

/**
 * Helper: check all layers of a plan and return per-layer race reports.
 */
export function detectRacesInPlan(
  layers: string[][],
  ioByNode: Map<string, NodeIO>,
): RaceReport[] {
  return layers.map((layer) => detectRaces(layer.map((id) => ioByNode.get(id) ?? { id })));
}
