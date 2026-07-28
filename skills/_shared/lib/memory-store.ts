/**
 * memory-store.ts — unified memory API across file backend (compat) and
 * embedding-backed retrieval. Put/get/delete are pass-through to files;
 * retrieve(query, k) does semantic ranking using the embedder.
 *
 * Phase 6 da nirvana-evolution.
 *
 * Storage model:
 *   - Files live under <business-dir>/memory/{permanent|projects/<id>}/<key>.yaml
 *   - An in-memory index (rebuilt on demand) maps key → {content, embedding, metadata}
 *   - The index can be persisted to <business-dir>/memory/.embeddings.json
 *     (optional; default is rebuild-on-load).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";

import { DEFAULT_EMBEDDER, cosine, type Embedder } from "./embedder.ts";

export interface MemoryEntry {
  key: string;
  content: string;
  metadata: Record<string, unknown>;
  business_slug?: string;
  project_id?: string;
  scope: "permanent" | "project";
  tags?: string[];
  written_at: string;
  hash: string;
  ttl_days?: number | null;
}

export interface MemoryRetrieveOptions {
  k?: number;                    // default 5
  filter?: {
    business?: string;
    project_id?: string;
    scope?: "permanent" | "project";
    tags?: string[];
  };
  min_score?: number;            // default 0.0
}

export interface MemoryRetrieveResult {
  entry: MemoryEntry;
  score: number;
}

export interface MemoryStoreOpts {
  root: string;                  // base dir, e.g. ~/businesses/<slug>/memory
  embedder?: Embedder;
  persistIndex?: boolean;        // default false (rebuild on load)
}

interface IndexEntry extends MemoryEntry {
  embedding: number[];
}

export class MemoryStore {
  private root: string;
  private embedder: Embedder;
  private persistIndex: boolean;
  private index: Map<string, IndexEntry> = new Map();
  private loaded = false;

  constructor(opts: MemoryStoreOpts) {
    this.root = opts.root;
    this.embedder = opts.embedder ?? DEFAULT_EMBEDDER;
    this.persistIndex = opts.persistIndex ?? false;
  }

  private indexPath(): string {
    return join(this.root, ".embeddings.json");
  }

  private fileFor(key: string, scope: "permanent" | "project", projectId?: string): string {
    if (scope === "project") {
      if (!projectId) throw new Error("project scope requires projectId");
      return join(this.root, "projects", projectId, `${key}.yaml`);
    }
    return join(this.root, "permanent", `${key}.yaml`);
  }

  private hashContent(content: string): string {
    // Simple stable hash (djb2)
    let h = 5381;
    for (let i = 0; i < content.length; i++) h = ((h << 5) + h + content.charCodeAt(i)) | 0;
    return Math.abs(h).toString(16);
  }

  private async embed(text: string): Promise<number[]> {
    const v = await this.embedder.embed(text);
    return Array.from(v);
  }

  async load(): Promise<void> {
    this.index.clear();
    if (!existsSync(this.root)) {
      this.loaded = true;
      return;
    }

    // Try to load persisted index first
    if (this.persistIndex && existsSync(this.indexPath())) {
      try {
        const data = JSON.parse(readFileSync(this.indexPath(), "utf8")) as { entries: IndexEntry[] };
        for (const e of data.entries) this.index.set(this.indexKey(e), e);
        this.loaded = true;
        return;
      } catch {
        // fall through to rebuild
      }
    }

    // Rebuild from filesystem
    const scopes: { scope: "permanent" | "project"; dir: string; projectId?: string }[] = [];
    const permanentDir = join(this.root, "permanent");
    if (existsSync(permanentDir)) scopes.push({ scope: "permanent", dir: permanentDir });
    const projectsDir = join(this.root, "projects");
    if (existsSync(projectsDir)) {
      for (const p of readdirSync(projectsDir)) {
        const pd = join(projectsDir, p);
        try { if (statSync(pd).isDirectory()) scopes.push({ scope: "project", dir: pd, projectId: p }); } catch {}
      }
    }

    for (const s of scopes) {
      for (const f of readdirSync(s.dir)) {
        if (!f.endsWith(".yaml") && !f.endsWith(".yml") && !f.endsWith(".md")) continue;
        const key = basename(f, extname(f));
        const content = readFileSync(join(s.dir, f), "utf8");
        const entry: MemoryEntry = {
          key,
          content,
          metadata: {},
          scope: s.scope,
          project_id: s.projectId,
          written_at: new Date().toISOString(),
          hash: this.hashContent(content),
        };
        const embedding = await this.embed(content);
        const idx: IndexEntry = { ...entry, embedding };
        this.index.set(this.indexKey(idx), idx);
      }
    }
    this.loaded = true;

    if (this.persistIndex) {
      this.saveIndex();
    }
  }

  private indexKey(e: MemoryEntry): string {
    return `${e.scope}:${e.project_id ?? "_"}:${e.key}`;
  }

  private saveIndex(): void {
    try {
      if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
      writeFileSync(this.indexPath(), JSON.stringify({ entries: [...this.index.values()] }, null, 2));
    } catch {}
  }

  async put(entry: Omit<MemoryEntry, "hash" | "written_at"> & { written_at?: string }): Promise<void> {
    if (!this.loaded) await this.load();
    const filePath = this.fileFor(entry.key, entry.scope, entry.project_id);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, entry.content, "utf8");

    const full: MemoryEntry = {
      ...entry,
      hash: this.hashContent(entry.content),
      written_at: entry.written_at ?? new Date().toISOString(),
    };
    const embedding = await this.embed(entry.content);
    this.index.set(this.indexKey(full), { ...full, embedding });
    if (this.persistIndex) this.saveIndex();
  }

  async get(key: string, scope: "permanent" | "project", projectId?: string): Promise<MemoryEntry | null> {
    if (!this.loaded) await this.load();
    const entry = this.index.get(this.indexKey({ key, scope, project_id: projectId, content: "", metadata: {}, hash: "", written_at: "" }));
    if (!entry) return null;
    const { embedding, ...rest } = entry;
    void embedding;
    return rest;
  }

  async retrieve(query: string, opts: MemoryRetrieveOptions = {}): Promise<MemoryRetrieveResult[]> {
    if (!this.loaded) await this.load();
    const k = Math.max(1, opts.k ?? 5);
    const minScore = opts.min_score ?? 0;
    const qVec = await this.embed(query);
    const results: MemoryRetrieveResult[] = [];
    for (const entry of this.index.values()) {
      if (opts.filter?.business && entry.business_slug && entry.business_slug !== opts.filter.business) continue;
      if (opts.filter?.project_id && entry.project_id !== opts.filter.project_id) continue;
      if (opts.filter?.scope && entry.scope !== opts.filter.scope) continue;
      if (opts.filter?.tags && opts.filter.tags.length > 0) {
        const tags = entry.tags ?? [];
        if (!opts.filter.tags.every((t) => tags.includes(t))) continue;
      }
      const score = cosine(qVec, entry.embedding);
      if (score < minScore) continue;
      const { embedding, ...rest } = entry;
      void embedding;
      results.push({ entry: rest, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  async delete(key: string, scope: "permanent" | "project", projectId?: string): Promise<boolean> {
    if (!this.loaded) await this.load();
    const filePath = this.fileFor(key, scope, projectId);
    if (existsSync(filePath)) unlinkSync(filePath);
    const k = this.indexKey({ key, scope, project_id: projectId, content: "", metadata: {}, hash: "", written_at: "" });
    const removed = this.index.delete(k);
    if (this.persistIndex) this.saveIndex();
    return removed;
  }

  size(): number { return this.index.size; }

  // Exposed for tests + GC
  _allEntries(): IndexEntry[] { return [...this.index.values()]; }
}
