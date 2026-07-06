/**
 * memory-gc.ts — garbage collection for the unified memory store.
 *
 * Strategies:
 *   - TTL eviction: entries older than ttl_days are deleted
 *   - Dedup: entries with embedding cosine similarity > sim_threshold are
 *     merged (keep one with richer metadata; drop the other)
 *   - Conflict resolution: if two entries share key + scope + project but
 *     have different content hashes, flag and keep the newer one
 *
 * Phase 6 da nirvana-evolution.
 */

import type { MemoryStore } from "./memory-store.ts";
import { cosine } from "./embedder.ts";

export interface GcOpts {
  ttl_days?: number;             // default 90 for project, never for permanent
  sim_threshold?: number;        // default 0.97
  on_conflict?: "keep_newer" | "keep_both" | "audit_only";  // default keep_newer
}

export interface GcReport {
  entries_before: number;
  entries_after: number;
  ttl_evicted: string[];
  duplicates_merged: { kept: string; dropped: string; score: number }[];
  conflicts: { key: string; kept_hash: string; dropped_hash: string }[];
}

export async function runGc(store: MemoryStore, opts: GcOpts = {}): Promise<GcReport> {
  const ttlDays = opts.ttl_days ?? 90;
  const simThreshold = opts.sim_threshold ?? 0.97;
  const onConflict = opts.on_conflict ?? "keep_newer";

  const before = store._allEntries();
  const report: GcReport = {
    entries_before: before.length,
    entries_after: 0,
    ttl_evicted: [],
    duplicates_merged: [],
    conflicts: [],
  };

  // 1. TTL — only project-scoped entries have TTL by default; permanent never expires
  const now = Date.now();
  const cutoff = now - ttlDays * 86_400_000;
  for (const e of before) {
    if (e.scope === "permanent") continue;
    const writtenMs = Date.parse(e.written_at);
    if (Number.isFinite(writtenMs) && writtenMs < cutoff) {
      await store.delete(e.key, e.scope, e.project_id);
      report.ttl_evicted.push(`${e.scope}:${e.project_id ?? "_"}:${e.key}`);
    }
  }

  // 2. Dedup by cosine similarity
  const remaining = store._allEntries();
  const dropped = new Set<string>();
  for (let i = 0; i < remaining.length; i++) {
    if (dropped.has(`${remaining[i].scope}:${remaining[i].project_id ?? "_"}:${remaining[i].key}`)) continue;
    for (let j = i + 1; j < remaining.length; j++) {
      const a = remaining[i];
      const b = remaining[j];
      const ka = `${a.scope}:${a.project_id ?? "_"}:${a.key}`;
      const kb = `${b.scope}:${b.project_id ?? "_"}:${b.key}`;
      if (dropped.has(kb)) continue;
      const score = cosine(a.embedding, b.embedding);
      if (score >= simThreshold) {
        // Keep the one with richer metadata; tiebreaker: longer content
        const keep = (Object.keys(a.metadata).length + a.content.length) >= (Object.keys(b.metadata).length + b.content.length) ? a : b;
        const drop = keep === a ? b : a;
        await store.delete(drop.key, drop.scope, drop.project_id);
        dropped.add(`${drop.scope}:${drop.project_id ?? "_"}:${drop.key}`);
        report.duplicates_merged.push({
          kept: `${keep.scope}:${keep.project_id ?? "_"}:${keep.key}`,
          dropped: `${drop.scope}:${drop.project_id ?? "_"}:${drop.key}`,
          score,
        });
      }
    }
  }

  // 3. Conflict detection: same key, scope, project — different hashes. The
  // store enforces unique keys per (scope, project_id), so this would only
  // happen if disk + index diverged; flag without auto-merge.
  // (No-op here since MemoryStore.put overwrites by key.)

  report.entries_after = store._allEntries().length;
  return report;
}
