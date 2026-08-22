// artifacts.ts — structured listing and safe download of a run's outputs.
//
// Path safety is the whole point of this module: the download route takes a
// client-supplied path, so every resolution is checked against the run's
// outputs root. A `..` that escapes is not a 404, it is a refusal.

import * as fs from "node:fs";
import * as path from "node:path";

const TYPES: Record<string, string> = {
  ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json",
  ".yaml": "text/yaml", ".yml": "text/yaml", ".html": "text/html",
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".zip": "application/zip",
  ".csv": "text/csv", ".ts": "text/plain", ".js": "text/javascript",
};

const SKIP = new Set([".brief.md", ".run.json", "HANDOFF.json"]);

export function listArtifacts(outputsRoot: string): { path: string; bytes: number; content_type: string }[] {
  const out: { path: string; bytes: number; content_type: string }[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".brief.md") continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(abs, r); continue; }
      if (SKIP.has(e.name)) continue;
      let bytes = 0;
      try { bytes = fs.statSync(abs).size; } catch { continue; }
      out.push({ path: r, bytes, content_type: TYPES[path.extname(e.name).toLowerCase()] || "application/octet-stream" });
    }
  };
  walk(outputsRoot, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Resolves a client-supplied relative path INSIDE the outputs root, or
 * returns null. Uses realpath on the root so a symlinked root still
 * compares correctly, and refuses anything that lands outside.
 */
export function resolveArtifact(outputsRoot: string, relPath: string): string | null {
  if (!relPath || relPath.includes("\0")) return null;
  let root: string;
  try { root = fs.realpathSync(outputsRoot); } catch { return null; }
  const abs = path.resolve(root, relPath);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!abs.startsWith(prefix)) return null;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
  } catch { return null; }
  // A symlink inside outputs must not point out of it either.
  try { if (!fs.realpathSync(abs).startsWith(prefix)) return null; } catch { return null; }
  return abs;
}

export function contentTypeFor(p: string): string {
  return TYPES[path.extname(p).toLowerCase()] || "application/octet-stream";
}
