/**
 * chunk-writer.ts — persists streaming output chunks to disk and emits
 * audit events. Designed to be lightweight enough to be called from inside
 * a long-running agent loop without blocking.
 *
 * Phase 7 da nirvana-evolution.
 *
 * Layout: <chunks_root>/<trace_id>/<NNN-seq>.<ext>
 *   ex: ~/Projects/myproj/.nirvana/outputs/<trace>/chunks/0001.md
 *
 * Aggregation: finalize(trace_id) concatenates all chunks (sorted by seq)
 * into one file `<trace_id>.final.<ext>` and optionally deletes the chunk
 * directory if `keep_chunks: false`.
 */

import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";

let _audit: { emit: (e: string, payload: unknown, ctx?: unknown) => void } | null = null;
function audit() {
  if (_audit) return _audit;
  try { _audit = require("./audit.js"); return _audit!; }
  catch { _audit = { emit: () => {} }; return _audit!; }
}

export interface ChunkInput {
  trace_id: string;
  sequence: number;
  content: string;
  content_format?: "markdown" | "text" | "json" | "html" | "base64";
  is_final?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ChunkRecord extends ChunkInput {
  chunk_id: string;
  emitted_at: string;
  path: string;
  size_bytes: number;
  content_format: NonNullable<ChunkInput["content_format"]>;
  is_final: boolean;
  metadata: Record<string, unknown>;
}

function extFor(format: ChunkRecord["content_format"]): string {
  switch (format) {
    case "json": return ".json";
    case "html": return ".html";
    case "base64": return ".bin";
    case "text": return ".txt";
    default: return ".md";
  }
}

function pad(n: number, width = 4): string { return String(n).padStart(width, "0"); }

export class ChunkWriter {
  private root: string;
  constructor(opts: { root: string }) {
    this.root = opts.root;
  }

  private dirFor(traceId: string): string {
    return join(this.root, traceId, "chunks");
  }

  write(input: ChunkInput): ChunkRecord {
    const format = input.content_format ?? "markdown";
    const dir = this.dirFor(input.trace_id);
    mkdirSync(dir, { recursive: true });
    const filename = `${pad(input.sequence)}${extFor(format)}`;
    const filePath = join(dir, filename);
    writeFileSync(filePath, input.content, "utf8");

    const record: ChunkRecord = {
      ...input,
      content_format: format,
      is_final: input.is_final ?? false,
      metadata: input.metadata ?? {},
      chunk_id: `${input.trace_id}-${pad(input.sequence)}`,
      emitted_at: new Date().toISOString(),
      path: filePath,
      size_bytes: Buffer.byteLength(input.content, "utf8"),
    };

    audit().emit("chunk_emitted", {
      sequence: input.sequence,
      size_bytes: record.size_bytes,
      is_final: record.is_final,
      format,
    }, { trace_id: input.trace_id });

    return record;
  }

  list(traceId: string): ChunkRecord[] {
    const dir = this.dirFor(traceId);
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).sort();
    const records: ChunkRecord[] = [];
    for (const f of files) {
      const filePath = join(dir, f);
      const seq = Number(basename(f, extname(f)));
      const content = readFileSync(filePath, "utf8");
      const st = statSync(filePath);
      records.push({
        trace_id: traceId,
        sequence: seq,
        content,
        content_format: ((extname(f).slice(1) || "markdown") as ChunkRecord["content_format"]),
        chunk_id: `${traceId}-${pad(seq)}`,
        emitted_at: st.mtime.toISOString(),
        path: filePath,
        size_bytes: st.size,
        is_final: false,
        metadata: {},
      });
    }
    return records;
  }

  finalize(traceId: string, opts: { keep_chunks?: boolean } = {}): { final_path: string; total_bytes: number; chunk_count: number } | null {
    const dir = this.dirFor(traceId);
    if (!existsSync(dir)) return null;
    const records = this.list(traceId);
    if (records.length === 0) return null;
    const finalExt = extFor(records[0].content_format);
    const finalPath = join(dirname(dir), `${traceId}.final${finalExt}`);
    const merged = records.sort((a, b) => a.sequence - b.sequence).map((r) => r.content).join("\n");
    writeFileSync(finalPath, merged, "utf8");
    if (opts.keep_chunks !== true) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    audit().emit("chunk_emitted", {
      sequence: -1,
      size_bytes: Buffer.byteLength(merged, "utf8"),
      is_final: true,
      aggregated: true,
      chunk_count: records.length,
      final_path: finalPath,
    }, { trace_id: traceId });
    return { final_path: finalPath, total_bytes: Buffer.byteLength(merged, "utf8"), chunk_count: records.length };
  }
}
