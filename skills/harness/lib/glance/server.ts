/**
 * server.ts — Bun.serve() ephemeral HTTP server for Nirvana Glance.
 *
 * Random localhost port, opens browser, auto-shutdown after idle timeout
 * or SIGINT. Read-only by default. No persistence outside ~/.claude/.glance.pid
 * (auto-cleanup on exit).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  getScope,
  listSquads,
  getSquadDetail,
  listBusinesses,
  getBusinessDetail,
  listProjects,
  getProjectDag,
  tailLogs,
  tailJsonlEvents,
  listAvailableLogDates,
  listMindClones,
  getMindClone,
  getDecisions,
  getDecision,
  appendDecision,
  getGates,
  getAuditEvents,
  getMemoryStats,
  buildGraph,
  buildRuns,
  getRun,
  diagnoseMindClones,
} from "./data-loader.ts";
import { startJob, getJob, listJobs, streamJob, cancelJob, isMutatingActive } from "./action-runner.ts";
import { deriveAgentStates, summarizeStates } from "./agent-state.ts";
import { paths, invalidatePathsCache } from "../../../_shared/lib/bun-helpers.ts";
import { readEnvFile, writeEnvFile, setVar, deleteVar, getVar, toMap } from "../../../_shared/lib/env-file.ts";
import { CONFIG_SCHEMA, getField, isEditableKey, maskSecret } from "./config-schema.ts";
import { validateMindCloneFile, type ValidationResult } from "../../../_shared/lib/mindclone-validator.ts";
import { handleObservabilityRoute } from "./views/observability-handler.ts";

const VIEWS_DIR = path.dirname(import.meta.path) + "/views";
const PID_FILE = path.join(os.homedir(), ".claude", ".glance.pid");
const STARTED_AT = Date.now();

// Neutral skills-tree root. Resolves to ~/.nirvana/skills when present so the
// tree survives ~/.claude removal; falls back to the legacy ~/.claude/skills.
const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

interface ServerOptions {
  port: number | "auto";
  open: boolean;
  idleMin: number;
  allowActions: boolean;  // future use; default false
  theme: "apple" | "apple-dark" | "awwwards";
}

// ─── Setup copy helper (used by /api/setup/copy-batch and /api/setup/copy-stream) ───
// kind=squads|businesses → source is a directory `<slug>/`, copy recursively.
// kind=mind-clones → slug is `<category>/<baseSlug>`, source is one or more
//   `<baseSlug>*.md` files inside the category dir. Copy every locale variant
//   (`<baseSlug>.md`, `<baseSlug>.en.md`, `<baseSlug>.pt.md`, etc) into the same
//   target category subdir.
function copyAsset(opts: {
  kind: string;
  slug: string;
  sourceRoot: string;       // e.g. ~/squads or ~/businesses or DNA_LIBRARY
  targetSub: string;        // e.g. .nirvana/squads
  targetDir: string;        // project root
  overwrite: boolean;
}): { ok: boolean; target?: string; error?: string; copied?: number } {
  const { kind, slug, sourceRoot, targetSub, targetDir, overwrite } = opts;
  if (kind === "mind-clones") {
    const [category, baseSlug] = String(slug).split("/", 2);
    if (!category || !baseSlug) return { ok: false, error: "expected slug as 'category/baseSlug'" };
    // Resolve the source directory:
    //  - synthetic _root category → source is sourceRoot/<baseSlug>
    //  - real category, canonical → source is sourceRoot/<category>/<baseSlug>
    //  - real category, flat .md  → source files live in sourceRoot/<category>/
    const catDir = category === "_root" ? sourceRoot : path.join(sourceRoot, category);
    if (!fs.existsSync(catDir)) return { ok: false, error: `category not found: ${catDir}` };

    // Path 1 — canonical: <catDir>/<baseSlug>/MANIFEST.yaml exists
    const canonicalDir = path.join(catDir, baseSlug);
    const isCanonical = fs.existsSync(canonicalDir)
      && (fs.existsSync(path.join(canonicalDir, "MANIFEST.yaml"))
       || fs.existsSync(path.join(canonicalDir, "manifest.yaml")));
    if (isCanonical) {
      const targetMcDir = path.join(targetDir, targetSub, category, baseSlug);
      try { fs.mkdirSync(path.dirname(targetMcDir), { recursive: true }); }
      catch (e: any) { return { ok: false, error: e.message }; }
      try {
        fs.cpSync(canonicalDir, targetMcDir, { recursive: true, errorOnExist: false, force: overwrite });
        return { ok: true, target: targetMcDir, copied: 1 };
      } catch (e: any) {
        return { ok: false, error: `copy failed (${baseSlug}): ${e.message}` };
      }
    }

    // Path 2 — legacy flat: <catDir>/<baseSlug>.md (+ locale variants)
    let entries: string[];
    try { entries = fs.readdirSync(catDir); }
    catch (e: any) { return { ok: false, error: `cannot read ${catDir}: ${e.message}` }; }
    const matches = entries.filter(f => {
      if (!f.endsWith(".md") || f.startsWith(".")) return false;
      if (f === `${baseSlug}.md`) return true;
      const re = new RegExp(`^${baseSlug.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\.[a-z]{2}(?:-[A-Z]{2})?\\.md$`);
      return re.test(f);
    });
    if (matches.length === 0) {
      return { ok: false, error: `no canonical dir or flat .md found for '${baseSlug}' in ${catDir}` };
    }

    // Validate the canonical .md before copying. Refuse to install malformed clones.
    const canonicalMd = path.join(catDir, `${baseSlug}.md`);
    if (fs.existsSync(canonicalMd)) {
      const v = validateMindCloneFile(canonicalMd);
      if (!v.ok) {
        const summary = v.errors.slice(0, 3).map(e => `${e.code}: ${e.message}`).join("; ");
        return {
          ok: false,
          error: `validation failed (${v.errors.length} error${v.errors.length === 1 ? "" : "s"}): ${summary}`,
          validation: v,
        } as any;
      }
    }

    const targetCatDir = path.join(targetDir, targetSub, category);
    try { fs.mkdirSync(targetCatDir, { recursive: true }); }
    catch (e: any) { return { ok: false, error: e.message }; }
    let copied = 0;
    for (const f of matches) {
      const src = path.join(catDir, f);
      const dst = path.join(targetCatDir, f);
      try {
        if (!overwrite && fs.existsSync(dst)) continue;
        fs.copyFileSync(src, dst);
        copied++;
      } catch (e: any) {
        return { ok: false, error: `copy failed (${f}): ${e.message}`, copied };
      }
    }
    return { ok: true, target: path.join(targetCatDir, `${baseSlug}.md`), copied };
  }
  // squads / businesses → directory copy
  const sourcePath = path.join(sourceRoot, slug);
  const targetPath = path.join(targetDir, targetSub, slug);
  if (!fs.existsSync(sourcePath)) return { ok: false, error: `source not found: ${sourcePath}` };
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.cpSync(sourcePath, targetPath, { recursive: true, errorOnExist: false, force: overwrite });
    return { ok: true, target: targetPath };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

let lastActivity = Date.now();
const bumpActivity = () => { lastActivity = Date.now(); };

function readView(name: string): string {
  const p = path.join(VIEWS_DIR, name);
  if (!fs.existsSync(p)) throw new Error(`view not found: ${p}`);
  return fs.readFileSync(p, "utf8");
}

// Token de cache-busting = maior mtime entre os assets .js/.css. Muda sempre que
// QUALQUER view é editada em disco (mesmo com o servidor rodando), então o
// `glance.js?v=<token>` vira uma URL nova e o browser é OBRIGADO a rebuscar —
// sem depender de restart. (STARTED_AT sozinho não bastava: era fixo por sessão
// do servidor, mas o glance.js muda durante a sessão.)
function assetVersion(): string {
  try {
    let mx = 0;
    for (const f of fs.readdirSync(VIEWS_DIR)) {
      if (!/\.(js|css)$/.test(f)) continue;
      const m = fs.statSync(path.join(VIEWS_DIR, f)).mtimeMs;
      if (m > mx) mx = m;
    }
    return mx ? String(Math.floor(mx)) : String(STARTED_AT);
  } catch { return String(STARTED_AT); }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function notFound(msg = "not found"): Response {
  return json({ error: msg }, 404);
}

function methodNotAllowed(): Response {
  return json({ error: "method not allowed; glance is read-only without --allow-actions" }, 405);
}

function openBrowser(url: string) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open"
            : platform === "win32" ? "start ''"
            : "xdg-open";
  try {
    Bun.spawn([cmd.split(" ")[0], ...(cmd.split(" ").slice(1)), url], { stdout: "ignore", stderr: "ignore" });
  } catch (e) {
    console.error(`[glance] couldn't auto-open browser; visit ${url} manually`);
  }
}

function findFreePort(start = 3737, attempts = 50): number {
  // Best-effort: try a deterministic-ish range, fallback to random
  for (let i = 0; i < attempts; i++) {
    const port = start + i;
    try {
      const probe = Bun.serve({ port, fetch: () => new Response("") });
      probe.stop(true);
      return port;
    } catch {}
  }
  return Math.floor(Math.random() * (65535 - 49152)) + 49152;
}

export async function startServer(opts: ServerOptions) {
  const port = opts.port === "auto" ? findFreePort() : opts.port;
  const url = `http://localhost:${port}`;

  // Write PID file (auto-cleanup on exit)
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port, url, started_at: STARTED_AT }, null, 2));
  } catch {}

  const server = Bun.serve({
    port,
    // Liga só no loopback: o cockpit (com actions) fica restrito a esta máquina,
    // nunca exposto à LAN por padrão.
    hostname: "127.0.0.1",
    async fetch(req) {
      bumpActivity();
      const u = new URL(req.url);
      const p = u.pathname;

      // ─── Project-scope filter (?project=<absolute_path>) ────────────────
      // Frontend sends this on Agents/Runs/Cost/Memory/Activity when the user
      // toggles the "Project" pill. Squads/Businesses/Mind-clones IGNORE it
      // (those are always global capability libraries).
      // The filter normalises "/" and "-" because Claude Code transcripts
      // encode paths as dir names with "-" as separator, which our importer
      // turns back into "/", losing the original dashes.
      const projectParam = (u.searchParams.get("project") || "").trim();
      const normalizePath = (s: string) =>
        s.toLowerCase().replace(/[\\/_\-]+/g, "/").replace(/^\/+|\/+$/g, "");
      const projectRootN = projectParam ? normalizePath(projectParam) : "";

      const eventMatchesProject = (ev: any): boolean => {
        if (!projectRootN) return true;
        if (ev.cwd) {
          const cwd = String(ev.cwd).replace(/\/+$/, "");
          if (cwd === projectParam || cwd.startsWith(projectParam + "/")) return true;
        }
        if (ev.project_id) {
          const pidN = normalizePath(String(ev.project_id));
          if (pidN === projectRootN || pidN.startsWith(projectRootN + "/")) return true;
        }
        return false;
      };
      const filterEventsByProject = (events: any[]): any[] => {
        if (!projectRootN) return events;
        return (events || []).filter(eventMatchesProject);
      };

      // ─── Observability (Fase 2 — nirvana-evolution) ───
      // /observability             — HTML page
      // /api/observability/traces  — JSON
      // /api/observability/traces/:id, /anomalies, /dashboards/*
      try {
        const obs = await handleObservabilityRoute(req, u);
        if (obs) return obs;
      } catch (e) {
        return new Response(JSON.stringify({ error: "observability_handler_failed", message: (e as Error).message }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }

      // ─── ACTION endpoints (POST) — gated by --allow-actions ───
      if (req.method === "POST" && p.startsWith("/api/actions/")) {
        if (!opts.allowActions) {
          return json({ error: "actions disabled; restart Glance with --allow-actions to enable", action: p }, 403);
        }
        return handleAction(req, p, opts);
      }

      // ─── Setup endpoints — gated by --allow-actions ───
      if (p === "/api/setup/status") {
        const scope = getScope();
        const cwd = process.env.NIRVANA_PROJECT_ROOT || process.cwd();
        const projectDir = scope.projectRoot || cwd;
        const hasNirvana = fs.existsSync(path.join(projectDir, ".nirvana"));
        const hasEnv = fs.existsSync(path.join(projectDir, ".env"));
        const localSquads = fs.existsSync(path.join(projectDir, ".nirvana", "squads"))
          ? fs.readdirSync(path.join(projectDir, ".nirvana", "squads")).filter(x => !x.startsWith("."))
          : [];
        const localBusinesses = fs.existsSync(path.join(projectDir, ".nirvana", "businesses"))
          ? fs.readdirSync(path.join(projectDir, ".nirvana", "businesses")).filter(x => !x.startsWith("."))
          : [];
        const localMindClones = fs.existsSync(path.join(projectDir, ".nirvana", "mind-clones"))
          ? fs.readdirSync(path.join(projectDir, ".nirvana", "mind-clones")).filter(x => !x.startsWith("."))
          : [];
        return json({
          project_root: projectDir,
          scope_mode: scope.mode,
          has_nirvana: hasNirvana,
          has_env: hasEnv,
          local: {
            squads: localSquads,
            businesses: localBusinesses,
            "mind-clones": localMindClones,
          },
          mind_clones_diagnostic: diagnoseMindClones(),
        });
      }

      if (req.method === "POST" && p === "/api/setup/init") {
        if (!opts.allowActions) {
          return json({ error: "actions disabled; restart Glance with --allow-actions to enable" }, 403);
        }
        try {
          const body = await req.json().catch(() => ({})) as any;
          const targetDir = body.target_dir || process.env.NIRVANA_PROJECT_ROOT || process.cwd();
          const scope = body.scope || "global";
          const initScript = path.join(SKILLS_ROOT, "_shared", "scripts", "init-project.ts");
          const args = ["run", initScript, targetDir];
          if (scope === "project" || scope === "merge") args.push(`--scope=${scope}`);
          const result = await new Promise<any>((resolve) => {
            const child = require("child_process").spawn("bun", args, {
              env: { ...process.env },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "", stderr = "";
            child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
            child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
            child.on("close", (code: number) => resolve({ code, stdout, stderr }));
          });
          return json({
            ok: result.code === 0,
            target_dir: targetDir,
            scope,
            stdout: result.stdout?.slice(-2000),
            stderr: result.stderr?.slice(-1000),
          }, result.code === 0 ? 200 : 500);
        } catch (e: any) {
          return json({ error: e.message }, 500);
        }
      }

      // Validate one or all mind-clones against dna.schema.json + 10-section body rule.
      // GET /api/mind-clones/validate?cat=01-marketing-copy-vendas&slug=alex-hormozi
      //   → single-file validation
      // GET /api/mind-clones/validate-all
      //   → batch audit; returns {total, ok, failed, results: [{cat, slug, ok, errors, warnings}]}
      if (p === "/api/mind-clones/validate" && req.method === "GET") {
        const cat = u.searchParams.get("cat") || "";
        const slug = u.searchParams.get("slug") || "";
        if (!cat || !slug) return json({ error: "cat and slug query params are required" }, 400);
        const filePath = path.join(paths.DNA_LIBRARY, cat, `${slug}.md`);
        const v = validateMindCloneFile(filePath);
        return json({ cat, slug, path: filePath, ...v });
      }
      if (p === "/api/mind-clones/validate-all" && req.method === "GET") {
        const root = paths.DNA_LIBRARY;
        const results: any[] = [];
        if (!fs.existsSync(root)) return json({ total: 0, ok: 0, failed: 0, results: [] });
        for (const cat of fs.readdirSync(root).filter(x => !x.startsWith("."))) {
          const catDir = path.join(root, cat);
          try { if (!fs.statSync(catDir).isDirectory()) continue; } catch { continue; }
          try {
            for (const f of fs.readdirSync(catDir)) {
              if (!f.endsWith(".md") || f.startsWith(".")) continue;
              if (/\.[a-z]{2}(?:-[A-Z]{2})?\.md$/.test(f)) continue;
              const slug = f.replace(/\.md$/, "");
              const v = validateMindCloneFile(path.join(catDir, f));
              results.push({
                cat, slug,
                ok: v.ok,
                error_count: v.errors.length,
                warning_count: v.warnings.length,
                errors: v.errors.slice(0, 3),  // truncate for response size
              });
            }
          } catch {}
        }
        const okCount = results.filter(r => r.ok).length;
        return json({
          total: results.length,
          ok: okCount,
          failed: results.length - okCount,
          results,
        });
      }

      // Lista assets a partir do GLOBAL (~/squads, ~/businesses, ~/businesses/_library/dna),
      // independente do NIRVANA_SCOPE ativo. Usado pelo Setup mode pra mostrar o que
      // pode ser copiado pro projeto. Marca cada item com `local: true` se já existir
      // em .nirvana/ do projeto-alvo.
      if (p === "/api/setup/source" && req.method === "GET") {
        const kind = u.searchParams.get("kind") || "";
        const scope = getScope();
        const projectDir = scope.projectRoot || process.cwd();
        const localOf = (sub: string) => {
          const dir = path.join(projectDir, ".nirvana", sub);
          if (!fs.existsSync(dir)) return new Set<string>();
          try { return new Set(fs.readdirSync(dir).filter(x => !x.startsWith("."))); }
          catch { return new Set<string>(); }
        };
        // For mind-clones we need per-file presence, not per-category. Build a Set of
        // "<category>/<baseSlug>" keys that exist in .nirvana/mind-clones/<cat>/<base>.md
        // Build "<category>/<slug>" keys for clones that already exist in
        // .nirvana/mind-clones/. Recognises BOTH legacy flat files and the
        // canonical directory format (matches listMindClones() shape).
        const localMindCloneSet = (() => {
          const root = path.join(projectDir, ".nirvana", "mind-clones");
          const out = new Set<string>();
          if (!fs.existsSync(root)) return out;
          const isCanonicalDir = (p: string): boolean =>
            fs.existsSync(path.join(p, "MANIFEST.yaml"))
            || fs.existsSync(path.join(p, "manifest.yaml"));
          try {
            for (const top of fs.readdirSync(root).filter(x => !x.startsWith("."))) {
              const topPath = path.join(root, top);
              try {
                if (!fs.statSync(topPath).isDirectory()) continue;
              } catch { continue; }
              // Top-level persona (canonical) → key "_root/<persona>"
              if (isCanonicalDir(topPath)) {
                out.add(`_root/${top}`);
                continue;
              }
              // Otherwise top is a category — walk one deeper
              try {
                for (const entry of fs.readdirSync(topPath).filter(x => !x.startsWith("."))) {
                  const entryPath = path.join(topPath, entry);
                  let isDir = false;
                  try { isDir = fs.statSync(entryPath).isDirectory(); } catch { continue; }
                  if (isDir) {
                    if (isCanonicalDir(entryPath)) out.add(`${top}/${entry}`);
                  } else if (entry.endsWith(".md")) {
                    // strip locale variants (foo.en.md → foo.md key)
                    const base = entry.replace(/\.[a-z]{2}(?:-[A-Z]{2})?\.md$/, ".md").replace(/\.md$/, "");
                    out.add(`${top}/${base}`);
                  }
                }
              } catch {}
            }
          } catch {}
          return out;
        })();
        if (kind === "squads") {
          const root = paths.SQUADS_DIR;
          const localSet = localOf("squads");
          if (!fs.existsSync(root)) return json({ items: [] });
          const reg = (() => { try { return JSON.parse(fs.readFileSync(paths.SQUADS_REGISTRY_PATH, "utf8")); } catch { return { squads: {} }; } })();
          const items = fs.readdirSync(root).filter(x => !x.startsWith(".") && fs.statSync(path.join(root, x)).isDirectory()).map(slug => {
            const m = reg.squads?.[slug] || {};
            return { slug, source: "global", local: localSet.has(slug), capabilities: m.capabilities ?? [], domains: m.domains ?? [] };
          }).sort((a, b) => a.slug.localeCompare(b.slug));
          return json({ items });
        }
        if (kind === "businesses") {
          const root = paths.BUSINESSES_DIR;
          const localSet = localOf("businesses");
          if (!fs.existsSync(root)) return json({ items: [] });
          const reg = (() => { try { return JSON.parse(fs.readFileSync(paths.BUSINESSES_REGISTRY_PATH, "utf8")); } catch { return { businesses: {} }; } })();
          const items = fs.readdirSync(root).filter(x => !x.startsWith(".") && !x.startsWith("_") && fs.statSync(path.join(root, x)).isDirectory()).map(slug => {
            const m = reg.businesses?.[slug] || {};
            return { slug, source: "global", local: localSet.has(slug), team_size: m.team_size, domain: m.domain };
          }).sort((a, b) => a.slug.localeCompare(b.slug));
          return json({ items });
        }
        if (kind === "mind-clones") {
          const root = paths.DNA_LIBRARY;
          if (!fs.existsSync(root)) return json({ items: [] });
          // Canonical-aware walker: handles both
          //   <root>/<category>/<persona>/MANIFEST.yaml  (canonical, categorized)
          //   <root>/<persona>/MANIFEST.yaml             (canonical, top-level persona → _root)
          //   <root>/<category>/<slug>.md                (legacy flat)
          // Mirrors listMindClones() from data-loader.ts so setup mode sees
          // the same library the rest of Glance does (391 entries, not 1).
          const isCanonicalDir = (p: string): boolean =>
            fs.existsSync(path.join(p, "MANIFEST.yaml"))
            || fs.existsSync(path.join(p, "manifest.yaml"));
          const items: any[] = [];
          const seen = new Set<string>();
          const LOCALE_RE = /\.[a-z]{2}(?:-[A-Z]{2})?\.md$/;
          for (const top of fs.readdirSync(root).filter(x => !x.startsWith("."))) {
            const topPath = path.join(root, top);
            let topIsDir = false;
            try { topIsDir = fs.statSync(topPath).isDirectory(); } catch { continue; }
            if (!topIsDir) continue;
            // Case A — top-level persona (canonical): <root>/<persona>/...
            if (isCanonicalDir(topPath)) {
              const key = `_root/${top}`;
              if (!seen.has(key)) {
                seen.add(key);
                items.push({
                  slug: top, category: "_root", source: "global",
                  format: "canonical",
                  local: localMindCloneSet.has(key),
                });
              }
              continue;
            }
            // Case B — top is a category, walk one deeper
            for (const entry of fs.readdirSync(topPath).filter(x => !x.startsWith("."))) {
              const entryPath = path.join(topPath, entry);
              let entryIsDir = false;
              try { entryIsDir = fs.statSync(entryPath).isDirectory(); } catch { continue; }
              if (entryIsDir) {
                if (!isCanonicalDir(entryPath)) continue;
                const key = `${top}/${entry}`;
                if (seen.has(key)) continue;
                seen.add(key);
                items.push({
                  slug: entry, category: top, source: "global",
                  format: "canonical",
                  local: localMindCloneSet.has(key),
                });
              } else if (entry.endsWith(".md") && !LOCALE_RE.test(entry)) {
                const slug = entry.replace(/\.md$/, "");
                const key = `${top}/${slug}`;
                if (seen.has(key)) continue;
                seen.add(key);
                items.push({
                  slug, category: top, source: "global",
                  format: "flat",
                  local: localMindCloneSet.has(key),
                });
              }
            }
          }
          items.sort((a, b) => (a.category + a.slug).localeCompare(b.category + b.slug));
          return json({ items });
        }
        return json({ error: "kind must be squads | businesses | mind-clones" }, 400);
      }

      if (req.method === "POST" && p === "/api/setup/estimate") {
        try {
          const body = await req.json() as any;
          const items = Array.isArray(body.items) ? body.items : [];
          const SOURCES: Record<string, string> = {
            squads: paths.SQUADS_DIR,
            businesses: paths.BUSINESSES_DIR,
            "mind-clones": paths.DNA_LIBRARY,
          };
          const byKind: Record<string, { bytes: number; files: number }> = {
            squads: { bytes: 0, files: 0 },
            businesses: { bytes: 0, files: 0 },
            "mind-clones": { bytes: 0, files: 0 },
          };
          const measure = (full: string): { bytes: number; files: number } => {
            try {
              const st = fs.statSync(full);
              if (st.isFile()) return { bytes: st.size, files: 1 };
              if (st.isDirectory()) {
                let bytes = 0, files = 0;
                for (const e of fs.readdirSync(full)) {
                  const sub = measure(path.join(full, e));
                  bytes += sub.bytes; files += sub.files;
                }
                return { bytes, files };
              }
            } catch {}
            return { bytes: 0, files: 0 };
          };
          for (const it of items) {
            const src = SOURCES[it.kind];
            if (!src || !it.slug) continue;
            const m = measure(path.join(src, it.slug));
            if (!byKind[it.kind]) byKind[it.kind] = { bytes: 0, files: 0 };
            byKind[it.kind].bytes += m.bytes;
            byKind[it.kind].files += m.files;
          }
          const totalBytes = Object.values(byKind).reduce((s, k) => s + k.bytes, 0);
          const totalFiles = Object.values(byKind).reduce((s, k) => s + k.files, 0);
          return json({ ok: true, totalBytes, totalFiles, byKind });
        } catch (e: any) {
          return json({ error: e.message }, 500);
        }
      }

      if (req.method === "POST" && p === "/api/setup/copy-stream") {
        if (!opts.allowActions) {
          return json({ error: "actions disabled; restart Glance with --allow-actions to enable" }, 403);
        }
        const body = await req.json().catch(() => ({})) as any;
        const targetDir = body.target_dir || process.env.NIRVANA_PROJECT_ROOT || process.cwd();
        const items = Array.isArray(body.items) ? body.items : [];
        const overwrite = !!body.overwrite;
        if (!fs.existsSync(targetDir) || items.length === 0) {
          return json({ error: !fs.existsSync(targetDir) ? `target_dir does not exist: ${targetDir}` : "items[] required" }, 400);
        }
        const SOURCES: Record<string, string> = {
          squads: paths.SQUADS_DIR,
          businesses: paths.BUSINESSES_DIR,
          "mind-clones": paths.DNA_LIBRARY,
        };
        const TARGET_SUB: Record<string, string> = {
          squads: ".nirvana/squads",
          businesses: ".nirvana/businesses",
          "mind-clones": ".nirvana/mind-clones",
        };
        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
            let ok = 0, failed = 0;
            for (const it of items) {
              const { kind, slug } = it;
              if (!SOURCES[kind] || !slug) {
                send({ type: "item", kind, slug, ok: false, error: "invalid kind or slug" });
                failed++; continue;
              }
              const r = copyAsset({
                kind, slug,
                sourceRoot: SOURCES[kind],
                targetSub: TARGET_SUB[kind],
                targetDir,
                overwrite,
              });
              send({ type: "item", kind, slug, ...r });
              if (r.ok) ok++; else failed++;
            }
            // Re-index (best-effort, silent)
            const reindex = (script: string) => new Promise<void>((resolve) => {
              require("child_process").spawn("bun", ["run", path.join(SKILLS_ROOT, script)], {
                env: { ...process.env, NIRVANA_PROJECT_ROOT: targetDir, NIRVANA_SCOPE: "project" },
                stdio: "ignore",
              }).on("close", () => resolve()).on("error", () => resolve());
            });
            await Promise.all([reindex("squads/scripts/index-squads.ts"), reindex("businesses/scripts/index-businesses.ts")]);
            send({ type: "done", summary: { ok, failed, total: items.length } });
            controller.close();
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      }

      if (req.method === "POST" && p === "/api/setup/copy-batch") {
        if (!opts.allowActions) {
          return json({ error: "actions disabled; restart Glance with --allow-actions to enable" }, 403);
        }
        try {
          const body = await req.json() as any;
          const targetDir = body.target_dir || process.env.NIRVANA_PROJECT_ROOT || process.cwd();
          if (!fs.existsSync(targetDir)) {
            return json({ error: `target_dir does not exist: ${targetDir}` }, 400);
          }
          const items = Array.isArray(body.items) ? body.items : [];
          if (items.length === 0) {
            return json({ error: "items[] required: [{kind, slug}, ...]" }, 400);
          }
          const SOURCES: Record<string, string> = {
            squads: paths.SQUADS_DIR,
            businesses: paths.BUSINESSES_DIR,
            "mind-clones": paths.DNA_LIBRARY,
          };
          const TARGET_SUB: Record<string, string> = {
            squads: ".nirvana/squads",
            businesses: ".nirvana/businesses",
            "mind-clones": ".nirvana/mind-clones",
          };
          const results: any[] = [];
          for (const it of items) {
            const kind = it.kind;
            const slug = it.slug;
            if (!SOURCES[kind] || !slug) {
              results.push({ kind, slug, ok: false, error: "invalid kind or slug" });
              continue;
            }
            const r = copyAsset({
              kind, slug,
              sourceRoot: SOURCES[kind],
              targetSub: TARGET_SUB[kind],
              targetDir,
              overwrite: !!body.overwrite,
            });
            results.push({ kind, slug, ...r });
          }
          // Re-index local registries (best-effort) — silent fail
          const reindex = (script: string) => new Promise<void>((resolve) => {
            require("child_process").spawn("bun", ["run", path.join(SKILLS_ROOT, script)], {
              env: { ...process.env, NIRVANA_PROJECT_ROOT: targetDir, NIRVANA_SCOPE: "project" },
              stdio: "ignore",
            }).on("close", () => resolve()).on("error", () => resolve());
          });
          await Promise.all([
            reindex("squads/scripts/index-squads.ts"),
            reindex("businesses/scripts/index-businesses.ts"),
          ]);
          return json({
            ok: results.every(r => r.ok),
            target_dir: targetDir,
            applied: results.filter(r => r.ok).length,
            failed: results.filter(r => !r.ok).length,
            results,
          });
        } catch (e: any) {
          return json({ error: e.message }, 500);
        }
      }

      // ─── Config (.env) endpoints — read whitelisted keys, write gated by --allow-actions ───
      if (p === "/api/config" && req.method === "GET") {
        const scope = getScope();
        const projectDir = scope.projectRoot || process.cwd();
        const projectEnvPath = path.join(projectDir, ".env");
        const globalEnvPath = path.join(os.homedir(), ".env");
        const projectEntries = readEnvFile(projectEnvPath);
        const globalEntries = readEnvFile(globalEnvPath);
        const projectMap = toMap(projectEntries);
        const globalMap = toMap(globalEntries);

        const groups = CONFIG_SCHEMA.map(g => ({
          ...g,
          fields: g.fields.map(f => {
            const projectVal = projectMap[f.key];
            const globalVal = globalMap[f.key];
            const effective = projectVal !== undefined ? projectVal : (globalVal !== undefined ? globalVal : f.default || "");
            const source: "project" | "global" | "default" =
              projectVal !== undefined ? "project" :
              globalVal !== undefined ? "global" : "default";
            return {
              ...f,
              project_value: f.sensitive ? (projectVal ? maskSecret(projectVal) : "") : (projectVal ?? ""),
              global_value: f.sensitive ? (globalVal ? maskSecret(globalVal) : "") : (globalVal ?? ""),
              effective_value: f.sensitive ? (effective ? maskSecret(effective) : "") : effective,
              source,
              has_project: projectVal !== undefined,
              has_global: globalVal !== undefined,
            };
          }),
        }));
        return json({
          project_env_path: projectEnvPath,
          global_env_path: globalEnvPath,
          project_env_exists: fs.existsSync(projectEnvPath),
          global_env_exists: fs.existsSync(globalEnvPath),
          allow_actions: opts.allowActions,
          groups,
        });
      }

      if (p === "/api/config" && req.method === "PUT") {
        if (!opts.allowActions) {
          return json({ error: "actions disabled; restart Glance with --allow-actions to enable" }, 403);
        }
        try {
          const body = await req.json() as any;
          const targetScope: "project" | "global" = body.scope === "global" ? "global" : "project";
          const updates: Record<string, string> = body.updates || {};
          const deletes: string[] = Array.isArray(body.deletes) ? body.deletes : [];

          const scope = getScope();
          const projectDir = scope.projectRoot || process.cwd();
          const filePath = targetScope === "global"
            ? path.join(os.homedir(), ".env")
            : path.join(projectDir, ".env");

          // Validate keys against whitelist
          const invalid: string[] = [];
          for (const k of Object.keys(updates)) if (!isEditableKey(k)) invalid.push(k);
          for (const k of deletes) if (!isEditableKey(k)) invalid.push(k);
          if (invalid.length) {
            return json({ error: `keys not in editable schema: ${invalid.join(", ")}` }, 400);
          }

          // Validate enum values
          for (const [k, v] of Object.entries(updates)) {
            const f = getField(k);
            if (f?.type === "enum" && f.options && !f.options.includes(v)) {
              return json({ error: `${k}: value '${v}' not in allowed [${f.options.join(", ")}]` }, 400);
            }
          }

          let entries = readEnvFile(filePath);
          const before = toMap(entries);
          const applied: Array<{ key: string; from: string; to: string; action: string }> = [];

          for (const [k, v] of Object.entries(updates)) {
            // For sensitive fields, empty string means "leave unchanged"
            const f = getField(k);
            if (f?.sensitive && v === "") continue;
            const from = before[k] ?? "";
            entries = setVar(entries, k, String(v));
            applied.push({ key: k, from: f?.sensitive ? maskSecret(from) : from, to: f?.sensitive ? maskSecret(v) : v, action: "set" });
          }
          for (const k of deletes) {
            const from = before[k] ?? "";
            if (from === "") continue;
            entries = deleteVar(entries, k);
            const f = getField(k);
            applied.push({ key: k, from: f?.sensitive ? maskSecret(from) : from, to: "", action: "delete" });
          }

          writeEnvFile(filePath, entries, { backup: true });

          // Live-reload: update process.env so resolveScope() and other readers
          // see new values immediately. Without this the running Glance process
          // keeps the values it had when Bun loaded the .env at boot.
          for (const [k, v] of Object.entries(updates)) {
            const f = getField(k);
            if (f?.sensitive && v === "") continue;
            process.env[k] = String(v);
          }
          for (const k of deletes) delete process.env[k];
          // Invalidate paths cache so SQUADS_DIR / NIRVANA_HOME etc are re-derived
          invalidatePathsCache();

          return json({
            ok: true,
            file: filePath,
            scope: targetScope,
            applied,
            applied_count: applied.length,
            restart_required: false,  // values reloaded in-process
            live_reloaded: true,
            backup: filePath + ".bak",
          });
        } catch (e: any) {
          return json({ error: e.message }, 500);
        }
      }

      // ─── Runtime routing rules (USE_* / NOT_USE_*) — dynamic keys, fora do
      //     whitelist estático. Cada regra é linguagem natural: "USE_CODEX=quando
      //     gerar imagens". GET lê todas; PUT grava/apaga (gated por allow-actions).
      const RULE_KEY_RE = /^(NOT_USE|USE)_[A-Z0-9_]+$/;
      if (p === "/api/config/rules" && req.method === "GET") {
        const scope = getScope();
        const projectDir = scope.projectRoot || process.cwd();
        const readRules = (fp: string) => {
          const out: Array<{ key: string; value: string }> = [];
          if (!fs.existsSync(fp)) return out;
          const m = toMap(readEnvFile(fp));
          for (const [k, v] of Object.entries(m)) if (RULE_KEY_RE.test(k) && String(v).trim()) out.push({ key: k, value: String(v) });
          return out;
        };
        return json({
          project: readRules(path.join(projectDir, ".env")),
          global: readRules(path.join(os.homedir(), ".env")),
          runtimes: ["claude-code", "codex", "gemini-cli", "antigravity-cli", "hermes"],
          allow_actions: opts.allowActions,
        });
      }
      if (p === "/api/config/rules" && req.method === "PUT") {
        if (!opts.allowActions) {
          return json({ error: "actions disabled; restart Glance with --allow-actions to enable" }, 403);
        }
        try {
          const body = await req.json() as any;
          const targetScope: "project" | "global" = body.scope === "global" ? "global" : "project";
          const updates: Record<string, string> = body.updates || {};
          const deletes: string[] = Array.isArray(body.deletes) ? body.deletes : [];
          // Só chaves USE_*/NOT_USE_* válidas — nunca escreve fora do padrão.
          const invalid = [...Object.keys(updates), ...deletes].filter(k => !RULE_KEY_RE.test(k));
          if (invalid.length) return json({ error: `chaves de regra inválidas: ${invalid.join(", ")}` }, 400);

          const scope = getScope();
          const projectDir = scope.projectRoot || process.cwd();
          const filePath = targetScope === "global" ? path.join(os.homedir(), ".env") : path.join(projectDir, ".env");
          let entries = readEnvFile(filePath);
          const applied: Array<{ key: string; action: string }> = [];
          for (const [k, v] of Object.entries(updates)) { entries = setVar(entries, k, String(v)); process.env[k] = String(v); applied.push({ key: k, action: "set" }); }
          for (const k of deletes) { entries = deleteVar(entries, k); delete process.env[k]; applied.push({ key: k, action: "delete" }); }
          writeEnvFile(filePath, entries, { backup: true });
          return json({ ok: true, file: filePath, scope: targetScope, applied, applied_count: applied.length, live_reloaded: true, backup: filePath + ".bak" });
        } catch (e: any) {
          return json({ error: e.message }, 500);
        }
      }

      if (p === "/api/config/validate-path" && req.method === "GET") {
        const raw = u.searchParams.get("p") || "";
        const expanded = raw.replace(/^~/, os.homedir()).replace(/\$HOME/g, os.homedir());
        if (!expanded || !path.isAbsolute(expanded)) {
          return json({ ok: true, exists: false, reason: !expanded ? "empty" : "not absolute" });
        }
        try {
          const st = fs.statSync(expanded);
          let entryCount: number | undefined;
          let readable = false;
          if (st.isDirectory()) {
            try { entryCount = fs.readdirSync(expanded).filter(x => !x.startsWith(".")).length; readable = true; } catch {}
          } else if (st.isFile()) {
            try { fs.accessSync(expanded, fs.constants.R_OK); readable = true; } catch {}
          }
          return json({
            ok: true,
            exists: true,
            isDir: st.isDirectory(),
            isFile: st.isFile(),
            readable,
            entryCount,
            resolved: expanded,
          });
        } catch (e: any) {
          return json({ ok: true, exists: false, reason: e.code || "stat_failed" });
        }
      }

      if (p === "/api/config/secret" && req.method === "GET") {
        if (!opts.allowActions) {
          return json({ error: "actions disabled; restart Glance with --allow-actions to enable" }, 403);
        }
        const key = u.searchParams.get("key") || "";
        const scopeQ = (u.searchParams.get("scope") || "project") === "global" ? "global" : "project";
        const f = getField(key);
        if (!f || !f.sensitive) {
          return json({ error: "key is not a sensitive field" }, 400);
        }
        const scope = getScope();
        const projectDir = scope.projectRoot || process.cwd();
        const filePath = scopeQ === "global"
          ? path.join(os.homedir(), ".env")
          : path.join(projectDir, ".env");
        const entries = readEnvFile(filePath);
        const v = getVar(entries, key) ?? "";
        return json({ ok: true, key, scope: scopeQ, value: v });
      }

      if (p === "/api/config/restart" && req.method === "POST") {
        if (!opts.allowActions) {
          return json({ error: "actions disabled; restart Glance with --allow-actions to enable" }, 403);
        }
        // Schedule async exit so the response flushes first; supervisor (or user) restarts.
        setTimeout(() => {
          console.error("[glance] restart requested via /api/config/restart");
          process.exit(0);
        }, 200);
        return json({
          ok: true,
          message: "Glance is shutting down. Restart with: bun ~/.nirvana/skills/harness/scripts/glance.ts --allow-actions",
        });
      }

      // POST decisions (memory append-only) — gated by --allow-actions
      if (req.method === "POST" && p === "/api/decisions") {
        if (!opts.allowActions) {
          return json({ error: "actions disabled; restart Glance with --allow-actions to enable" }, 403);
        }
        try {
          const body = await req.json() as any;
          if (!body || typeof body !== "object" || !body.decision_id || !body.text) {
            return json({ error: "POST /api/decisions requires {decision_id, text, project_id?, source?, rationale?}" }, 400);
          }
          const r = appendDecision({
            project_id: body.project_id || "_global",
            decision_id: String(body.decision_id),
            text: String(body.text),
            source: body.source || "glance",
            rationale: body.rationale || null,
          });
          return json(r, r.ok ? 201 : 500);
        } catch (e: any) {
          return json({ error: e.message }, 400);
        }
      }
      // GET on action endpoints (SSE stream + listing)
      if (req.method === "GET" && p.startsWith("/api/actions/")) {
        if (p === "/api/actions/jobs") return json({ jobs: listJobs(), allow_actions: opts.allowActions, mutating_active: isMutatingActive() });
        const m = p.match(/^\/api\/actions\/jobs\/([^/]+)\/stream$/);
        if (m) return streamJobSSE(req, m[1]);
        const m2 = p.match(/^\/api\/actions\/jobs\/([^/]+)$/);
        if (m2) {
          const j = getJob(m2[1]);
          return j ? json(j) : notFound("job not found");
        }
      }

      if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed();

      // ─── Static frontend ───
      // no-store em TODOS os assets: sem isso o browser serve glance.js/css
      // do cache após um update do engine — causa clássica de "atualizei mas
      // continua quebrado". Assets são pequenos e locais; revalidar sempre.
      if (p === "/" || p === "/index.html") {
        // __ASSET_VER__ vira o timestamp de boot: cada restart do Glance muda a
        // URL dos assets (glance.js?v=…), forçando o browser a buscar a versão
        // nova mesmo se tiver uma cópia velha em cache. Blinda o "reiniciei o
        // glance mas o browser continua com o js antigo".
        const html = readView("index.html")
          .replace("__GLANCE_THEME__", opts.theme)
          .replaceAll("__ASSET_VER__", assetVersion());
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      const STATIC_ASSETS: Record<string, string> = {
        "/tokens.css": "text/css",
        "/components.css": "text/css",
        "/glance.css": "text/css",
        "/glance.js": "application/javascript",
        "/dag-renderer.js": "application/javascript",
        "/org-chart-renderer.js": "application/javascript",
        "/graph-renderer.js": "application/javascript",
        "/chart-renderer.js": "application/javascript",
        "/awwwards-hero.js": "application/javascript",
        "/agent-swimlane-renderer.js": "application/javascript",
        "/agent-workspace-renderer.js": "application/javascript",
      };
      if (STATIC_ASSETS[p]) {
        return new Response(readView(p.slice(1)), { headers: { "content-type": STATIC_ASSETS[p], "cache-control": "no-store" } });
      }

      // ─── API ───
      if (p === "/api/health") {
        return json({
          ok: true,
          version: "1.0.0",
          uptime_ms: Date.now() - STARTED_AT,
          idle_ms: Date.now() - lastActivity,
          idle_timeout_ms: opts.idleMin * 60_000,
          allow_actions: opts.allowActions,
          scope: getScope(),
        });
      }
      if (p === "/api/scope") return json(getScope());

      if (p === "/api/audit/report") {
        const sc = getScope();
        const stateDir = sc.projectRoot
          ? path.join(sc.projectRoot, ".nirvana", ".audit-state")
          : path.join(SKILLS_ROOT, "squads", ".audit-state");
        const f = path.join(stateDir, "scores.json");
        if (!fs.existsSync(f)) return json({ error: "audit not run yet; run audit-squads-score.ts first", state_dir: stateDir }, 404);
        return new Response(fs.readFileSync(f, "utf8"), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      if (p === "/api/businesses/audit/report") {
        const sc = getScope();
        const stateDir = sc.projectRoot
          ? path.join(sc.projectRoot, ".nirvana", ".audit-state")
          : path.join(SKILLS_ROOT, "businesses", ".audit-state");
        const f = path.join(stateDir, sc.projectRoot ? "businesses-scores.json" : "scores.json");
        if (!fs.existsSync(f)) return json({ error: "audit not run yet; run audit-businesses-score.ts first", state_dir: stateDir }, 404);
        return new Response(fs.readFileSync(f, "utf8"), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      if (p === "/api/mind-clones/audit/report") {
        const sc = getScope();
        const stateDir = sc.projectRoot
          ? path.join(sc.projectRoot, ".nirvana", ".audit-state")
          : path.join(SKILLS_ROOT, "businesses", ".audit-state");
        const f = path.join(stateDir, "mindclones-scores.json");
        if (!fs.existsSync(f)) return json({ error: "audit not run yet; run audit-mindclones-score.ts first", state_dir: stateDir }, 404);
        return new Response(fs.readFileSync(f, "utf8"), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      if (p.startsWith("/api/audit/squad/")) {
        const slug = decodeURIComponent(p.slice("/api/audit/squad/".length));
        const sc = getScope();
        const stateDir = sc.projectRoot
          ? path.join(sc.projectRoot, ".nirvana", ".audit-state", slug)
          : path.join(SKILLS_ROOT, "squads", ".audit-state", slug);
        if (!fs.existsSync(stateDir)) return notFound(`no audit history for ${slug}`);
        const result: any = {};
        for (const f of ["score-before.json", "score-after.json", "consensus.json", "validation.json", "result.json"]) {
          const p2 = path.join(stateDir, f);
          if (fs.existsSync(p2)) {
            try { result[f.replace(".json", "")] = JSON.parse(fs.readFileSync(p2, "utf8")); } catch {}
          }
        }
        return json({ slug, audit_state_dir: stateDir, ...result });
      }

      if (p === "/api/squads") return json({ squads: listSquads(), scope: getScope() });
      if (p.startsWith("/api/squads/")) {
        const slug = decodeURIComponent(p.slice("/api/squads/".length));
        const detail = getSquadDetail(slug);
        return detail ? json(detail) : notFound(`squad '${slug}' not in current scope`);
      }

      if (p === "/api/businesses") return json({ businesses: listBusinesses(), scope: getScope() });
      if (p.startsWith("/api/businesses/")) {
        const slug = decodeURIComponent(p.slice("/api/businesses/".length));
        const detail = getBusinessDetail(slug);
        return detail ? json(detail) : notFound(`business '${slug}' not in current scope`);
      }

      if (p === "/api/projects") {
        let projects = listProjects();
        if (projectRootN) {
          const lastSeg = (s: string) => (s || "").split("/").filter(Boolean).slice(-1)[0] || s;
          const projectBasename = lastSeg(projectParam).toLowerCase();
          projects = (projects || []).filter((p: any) => {
            const idLast  = lastSeg(p.id || "").toLowerCase();
            const slugLow = (p.slug || "").toLowerCase();
            const lblLow  = (p.label || "").toLowerCase();
            return idLast === projectBasename
                || slugLow === projectBasename
                || lblLow === projectBasename
                || normalizePath(p.id || "") === projectRootN;
          });
        }
        return json({ projects });
      }
      if (p.startsWith("/api/projects/") && p.endsWith("/dag")) {
        const id = decodeURIComponent(p.slice("/api/projects/".length, -"/dag".length));
        const dag = getProjectDag(id);
        return dag ? json(dag) : notFound(`project '${id}' not found`);
      }

      // Runs — audit-derived run summaries grouped by trace_id (any agent that emits)
      if (p === "/api/runs") {
        const days = Number(u.searchParams.get("days") || "7");
        const limit = Number(u.searchParams.get("limit") || "100");
        const result = buildRuns({ days, limit });
        if (projectRootN) {
          const runs = (result.runs || []).filter((r: any) => eventMatchesProject(r));
          return json({ runs, total: runs.length });
        }
        return json(result);
      }
      // /api/runs/:id/stream ANTES do /api/runs/:id genérico (senão "id/stream"
      // seria lido como um trace_id inteiro).
      {
        const rsm = p.match(/^\/api\/runs\/([^/]+)\/stream$/);
        if (rsm) {
          const traceId = decodeURIComponent(rsm[1]);
          const stream = new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              const readTrace = (limit: number) => {
                let events: any[] = [];
                try { const r = getAuditEvents({ trace_id: traceId, limit }); if (r?.events?.length) events = r.events; } catch {}
                if (!events.length) events = tailJsonlEvents(500).filter((e: any) => e.trace_id === traceId || e.project_id === traceId);
                return events;
              };
              try {
                const snap = readTrace(200);
                controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify({ trace_id: traceId, events: snap })}\n\n`));
              } catch {}
              let lastId = 0;
              try { const init = readTrace(1); if (init?.length) lastId = Math.max(...init.map((e: any) => e.id || 0)); } catch {}
              const tick = setInterval(() => {
                try {
                  const events = readTrace(50);
                  const fresh = events.filter((e: any) => (e.id || 0) > lastId).sort((a: any, b: any) => (a.id || 0) - (b.id || 0));
                  for (const ev of fresh) {
                    controller.enqueue(encoder.encode(`event: event\ndata: ${JSON.stringify(ev)}\n\n`));
                    if ((ev.id || 0) > lastId) lastId = ev.id;
                    if (ev.event === "delivered" || ev.event === "cascade_exhausted") {
                      controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ final: ev.event })}\n\n`));
                    }
                  }
                  controller.enqueue(encoder.encode(`: ping\n\n`));
                } catch { /* swallow */ }
              }, 2000);
              (controller as any)._tick = tick;
            },
            cancel() { const tick = (this as any)._tick; if (tick) clearInterval(tick); },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" } });
        }
      }
      if (p.startsWith("/api/runs/")) {
        const tid = decodeURIComponent(p.slice("/api/runs/".length));
        const run = getRun(tid);
        return run ? json(run) : notFound(`run '${tid}' not found`);
      }

      if (p === "/api/logs") {
        const type = (u.searchParams.get("type") as "harness" | "maestro") || "harness";
        const date = u.searchParams.get("date") || undefined;
        const limit = u.searchParams.get("limit") ? Number(u.searchParams.get("limit")) : 200;
        return json(tailLogs({ type, date, limit }));
      }
      if (p === "/api/logs/dates") {
        const type = (u.searchParams.get("type") as "harness" | "maestro") || "harness";
        return json({ type, dates: listAvailableLogDates(type) });
      }

      // ─── SSE log tail ───
      if (p === "/api/logs/stream") {
        const type = (u.searchParams.get("type") as "harness" | "maestro") || "harness";
        const date = u.searchParams.get("date") || undefined;
        const stream = new ReadableStream({
          start(controller) {
            const send = (data: any) => {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
              bumpActivity();
            };
            // Initial dump
            send({ kind: "snapshot", ...tailLogs({ type, date, limit: 50 }) });
            // Poll every 3s for new events
            const iv = setInterval(() => {
              send({ kind: "tick", ...tailLogs({ type, date, limit: 200 }) });
            }, 3000);
            // Heartbeat
            const hb = setInterval(() => {
              try { controller.enqueue(new TextEncoder().encode(": heartbeat\n\n")); } catch {}
            }, 15_000);
            req.signal.addEventListener("abort", () => {
              clearInterval(iv); clearInterval(hb);
              try { controller.close(); } catch {}
            });
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "connection": "keep-alive",
          },
        });
      }

      // ───────────────────── Activity feed (SSE) ─────────────────────
      if (p === "/api/activity/stream") {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();

            // Helper: read events from state-db first, fallback to JSONL.
            // Fixes "activity sidebar empty" bug when state.db is missing
            // or hasn't been written yet. Honors ?project= filter.
            const readEvents = (limit: number) => {
              let events: any[] = [];
              try {
                const r = getAuditEvents({ limit });
                if (r?.events?.length) events = r.events;
              } catch {}
              if (!events.length) events = tailJsonlEvents(limit);
              return filterEventsByProject(events);
            };

            // Initial snapshot
            try {
              const initEvents = readEvents(30);
              controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify({ events: initEvents })}\n\n`));
            } catch {}
            let lastId = 0;
            try {
              const init = readEvents(1);
              if (init?.[0]?.id) lastId = init[0].id;
            } catch {}
            const tick = setInterval(() => {
              try {
                const events = readEvents(50);
                const fresh = events.filter((e: any) => e.id > lastId).reverse();
                for (const ev of fresh) {
                  controller.enqueue(encoder.encode(`event: event\ndata: ${JSON.stringify(ev)}\n\n`));
                  if (ev.id > lastId) lastId = ev.id;
                }
                // heartbeat to keep connection alive
                controller.enqueue(encoder.encode(`: ping\n\n`));
              } catch { /* swallow */ }
            }, 2000);
            // @ts-ignore — store interval for cleanup
            (controller as any)._tick = tick;
          },
          cancel(reason) {
            // @ts-ignore
            const tick = (this as any)._tick;
            if (tick) clearInterval(tick);
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "connection": "keep-alive",
          },
        });
      }

      // ───────────────────── Live Agents (snapshot) ─────────────────────
      if (p === "/api/agents") {
        const rawEvents = tailJsonlEvents(500);
        const events = filterEventsByProject(rawEvents);
        const states = deriveAgentStates(events);
        const summary = summarizeStates(states);
        return json({ agents: states, summary, total: states.length });
      }

      // ───────────────────── Live Agents (SSE) ─────────────────────
      if (p === "/api/agents/live") {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            // Initial snapshot
            try {
              const events = filterEventsByProject(tailJsonlEvents(500));
              const states = deriveAgentStates(events);
              const summary = summarizeStates(states);
              controller.enqueue(encoder.encode(
                `event: snapshot\ndata: ${JSON.stringify({ agents: states, summary })}\n\n`
              ));
            } catch {}

            // Track previous status by trace_id for delta detection
            let prevStatus = new Map<string, string>();
            const tick = setInterval(() => {
              try {
                const events = filterEventsByProject(tailJsonlEvents(500));
                const states = deriveAgentStates(events);
                const summary = summarizeStates(states);
                // emit full snapshot every tick (UI re-syncs from this)
                controller.enqueue(encoder.encode(
                  `event: snapshot\ndata: ${JSON.stringify({ agents: states, summary })}\n\n`
                ));
                // emit delta events for status flips
                for (const s of states) {
                  const prev = prevStatus.get(s.trace_id);
                  if (prev && prev !== s.status) {
                    controller.enqueue(encoder.encode(
                      `event: status_change\ndata: ${JSON.stringify({
                        trace_id: s.trace_id,
                        from: prev,
                        to: s.status,
                        agent: { label: s.label, current_tool: s.current_tool, cost_session_usd: s.cost_session_usd }
                      })}\n\n`
                    ));
                  }
                  prevStatus.set(s.trace_id, s.status);
                }
                // heartbeat
                controller.enqueue(encoder.encode(`: ping\n\n`));
              } catch { /* swallow */ }
            }, 2000);
            (controller as any)._tick = tick;
          },
          cancel(reason) {
            const tick = (this as any)._tick;
            if (tick) clearInterval(tick);
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "connection": "keep-alive",
          },
        });
      }

      // ───────────────────── Knowledge Graph ─────────────────────
      if (p === "/api/graph") {
        const includeDecisions = u.searchParams.get("include_decisions") === "true";
        const full = buildGraph({ include_decisions: includeDecisions });
        // Project filter: when ?project=<path> is present, narrow the graph
        // to nodes anchored on the matching project — its meta node, its
        // artifacts/decisions/audit nodes, plus any capability/squad/business/
        // mind-clone reachable in 2 hops (so the user still sees what their
        // project consumes/depends on).
        if (!projectRootN) return json(full);

        const lastSeg = (s: string) => (s || "").split("/").filter(Boolean).slice(-1)[0] || s;
        const projectBasename = lastSeg(projectParam).toLowerCase();
        // The project_id stored on artifact nodes is usually just the basename
        // (e.g. "marca-exemplo") — sometimes a path. Compare on the
        // last segment, lowercased, hyphens preserved.

        const keep = new Set<string>();
        const matchProject = (n: any): boolean => {
          if (n.type === "project") {
            const id = (n.id || "").replace(/^project:/, "").toLowerCase();
            const lbl = (n.label || "").toLowerCase();
            return id === projectBasename || lbl === projectBasename;
          }
          if (n.project_id) {
            const pidLast = lastSeg(String(n.project_id)).toLowerCase();
            return pidLast === projectBasename
                || normalizePath(String(n.project_id)) === projectRootN;
          }
          return false;
        };
        for (const n of (full.nodes || [])) if (matchProject(n)) keep.add(n.id);

        // Stage 2: expand via edges to reach capability nodes (2 hops)
        const adj = new Map<string, Set<string>>();
        for (const e of (full.edges || [])) {
          const s = (e.source && e.source.id) || e.source;
          const t = (e.target && e.target.id) || e.target;
          if (!adj.has(s)) adj.set(s, new Set());
          if (!adj.has(t)) adj.set(t, new Set());
          adj.get(s)!.add(t); adj.get(t)!.add(s);
        }
        const expand = (depth: number) => {
          let frontier = [...keep];
          for (let d = 0; d < depth; d++) {
            const next: string[] = [];
            for (const id of frontier) {
              for (const n of adj.get(id) || []) {
                if (!keep.has(n)) { keep.add(n); next.push(n); }
              }
            }
            frontier = next;
          }
        };
        expand(2);

        const nodes = (full.nodes || []).filter((n: any) => keep.has(n.id));
        const edges = (full.edges || []).filter((e: any) => {
          const s = (e.source && e.source.id) || e.source;
          const t = (e.target && e.target.id) || e.target;
          return keep.has(s) && keep.has(t);
        });
        // Recompute totals.by_type for the filtered subset
        const by_type: Record<string, number> = {};
        for (const n of nodes) by_type[n.type] = (by_type[n.type] || 0) + 1;
        return json({ nodes, edges, totals: { by_type, total_nodes: nodes.length, total_edges: edges.length } });
      }

      // ───────────────────── Cost & Tokens ─────────────────────
      if (p === "/api/cost/summary") {
        const period = u.searchParams.get("period") || "7d";
        const days = period === "30d" ? 30 : period === "all" ? 365 : 7;
        const sinceMs = Date.now() - days * 86400_000;
        const since = new Date(sinceMs).toISOString();
        let events: any[] = getAuditEvents({ event: "cost_emission", since, limit: 50_000 }).events || [];
        // Fallback: state.db may be empty/disabled — pull from JSONL.
        if (events.length === 0) {
          const tail = tailJsonlEvents(50_000);
          events = tail.filter(e => e.event === "cost_emission" && new Date(e.ts).getTime() >= sinceMs);
        }
        // Project filter: ALWAYS applied here — Cost is a per-project view when scoped.
        events = filterEventsByProject(events);
        const aggregator = require(path.join(VIEWS_DIR, "..", "cost-aggregator.js"));
        const agg = aggregator.aggregate(events);
        // Enriquece cada session (trace_id) com o brief do run — pra tabela
        // mostrar O QUE a tarefa era, não só o UUID.
        try {
          const runs = buildRuns({ days: 365, limit: 5000 }).runs || [];
          const briefByTrace = new Map(runs.map((r: any) => [r.trace_id, r.brief]));
          agg.sessions = (agg.sessions || []).map((s: any) => ({ ...s, brief: briefByTrace.get(s.trace_id) || null }));
        } catch { /* sessions ficam sem brief */ }
        return json({ period, scoped_to: projectParam || null, ...agg });
      }

      // ───────────────────── Memory layer (state.db) ─────────────────────
      if (p === "/api/memory/stats") return json(getMemoryStats());
      if (p === "/api/decisions") {
        const filters = {
          project_id: u.searchParams.get("project_id") || undefined,
          limit: u.searchParams.get("limit") ? parseInt(u.searchParams.get("limit")!, 10) : undefined,
        };
        const result = getDecisions(filters);
        if (projectRootN) {
          const decisions = ((result as any).decisions || []).filter(eventMatchesProject);
          return json({ ...(result as any), decisions });
        }
        return json(result);
      }
      if (p.startsWith("/api/decisions/")) {
        const id = decodeURIComponent(p.slice("/api/decisions/".length));
        const r = getDecision(id);
        return r ? json({ decision_id: id, history: r }) : notFound(`decision ${id} not found`);
      }
      if (p === "/api/gates") {
        const filters = {
          project_id: u.searchParams.get("project_id") || undefined,
          phase: u.searchParams.get("phase") || undefined,
          verdict: u.searchParams.get("verdict") || undefined,
          limit: u.searchParams.get("limit") ? parseInt(u.searchParams.get("limit")!, 10) : undefined,
        };
        const result = getGates(filters);
        if (projectRootN) {
          const gates = ((result as any).gates || []).filter(eventMatchesProject);
          return json({ ...(result as any), gates });
        }
        return json(result);
      }
      if (p === "/api/audit/events") {
        const filters = {
          event: u.searchParams.get("event") || undefined,
          trace_id: u.searchParams.get("trace_id") || undefined,
          project_id: u.searchParams.get("project_id") || undefined,
          since: u.searchParams.get("since") || undefined,
          limit: u.searchParams.get("limit") ? parseInt(u.searchParams.get("limit")!, 10) : undefined,
        };
        const result = getAuditEvents(filters);
        if (projectRootN) {
          const events = ((result as any).events || []).filter(eventMatchesProject);
          return json({ ...(result as any), events });
        }
        return json(result);
      }

      if (p === "/api/mind-clones") return json({ mind_clones: listMindClones() });
      if (p.startsWith("/api/mind-clones/")) {
        const rest = decodeURIComponent(p.slice("/api/mind-clones/".length)).split("/");
        if (rest.length !== 2) return notFound("expected /api/mind-clones/<category>/<slug>");
        const mc = getMindClone(rest[0], rest[1]);
        return mc ? json(mc) : notFound(`mind-clone ${rest[0]}/${rest[1]} not found`);
      }

      if (p === "/api/search") {
        const q = (u.searchParams.get("q") || "").toLowerCase().trim();
        if (!q) return json({ q, results: [] });
        const out: Array<{ kind: string; slug: string; meta?: any; source: string }> = [];
        for (const s of listSquads()) {
          if (s.slug.toLowerCase().includes(q) || s.domains.some((d: string) => d.toLowerCase().includes(q))) {
            out.push({ kind: "squad", slug: s.slug, source: s.source, meta: { caps: s.capabilities.length, domains: s.domains } });
          }
        }
        for (const b of listBusinesses()) {
          if (b.slug.toLowerCase().includes(q) || b.domains.some((d: string) => d.toLowerCase().includes(q))) {
            out.push({ kind: "business", slug: b.slug, source: b.source, meta: { domains: b.domains, employees: b.employee_count } });
          }
        }
        for (const m of listMindClones()) {
          if (m.slug.toLowerCase().includes(q) || m.category.toLowerCase().includes(q)) {
            out.push({ kind: "mind-clone", slug: `${m.category}/${m.slug}`, source: m.source });
          }
        }
        return json({ q, results: out.slice(0, 50) });
      }

      return notFound();
    },
    error(err) {
      console.error("[glance] error:", err);
      return new Response(`error: ${err.message}`, { status: 500 });
    },
  });

  console.error(`[glance] up on ${url}  (scope=${getScope().mode}, allow_actions=${opts.allowActions}, theme=${opts.theme})`);
  console.error(`[glance] auto-shutdown after ${opts.idleMin}min idle  ·  Ctrl+C to exit`);
  if (opts.open) openBrowser(url);

  // Idle watchdog
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > opts.idleMin * 60_000) {
      console.error(`[glance] idle ${opts.idleMin}min — shutting down`);
      shutdown(server, watchdog);
    }
  }, 30_000);

  // SIGINT cleanup
  const onSignal = () => { console.error("\n[glance] SIGINT — shutting down"); shutdown(server, watchdog); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return { server, url, port };
}

// ─────────────────────────────────────────────────────────────────────
// Action handling — spawn whitelisted commands and return the job id.
// ─────────────────────────────────────────────────────────────────────

interface ActionDef {
  command: string;
  argsBuilder: (body: any) => string[];
  mutating: boolean;
  cwd?: () => string | undefined;
  lane?: "maintenance" | "chat";
  // Deriva o trace_id/chatId a ser devolvido (para o cliente assinar o stream do run).
  traceId?: (body: any) => string | null;
}

const SKILLS = process.env.NIRVANA_SKILLS_DIR || process.env.CLAUDE_SKILLS_DIR || (fs.existsSync(`${os.homedir()}/.nirvana/skills`) ? `${os.homedir()}/.nirvana/skills` : `${process.env.HOME}/.claude/skills`);

const ACTIONS: Record<string, ActionDef> = {
  "audit-score": {
    command: "bun",
    argsBuilder: () => [`${SKILLS}/squads/scripts/audit-squads-score.ts`],
    mutating: false,
  },
  "audit-improve": {
    command: "bun",
    argsBuilder: (b) => {
      const slug = (b?.slug || "").toString();
      if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw new Error("invalid or missing slug");
      const apply = b?.dry_run === false;
      return [`${SKILLS}/squads/scripts/improve-squad.ts`, slug, apply ? "--apply" : "--dry-run", "--verbose"];
    },
    mutating: true,
  },
  "audit-batch": {
    command: "bun",
    argsBuilder: (b) => {
      const apply = b?.dry_run === false;
      const args = [`${SKILLS}/squads/scripts/audit-batch-orchestrator.ts`];
      args.push(apply ? "--apply" : "--dry-run");
      if (b?.tier && ["red", "yellow"].includes(b.tier)) args.push("--tier", b.tier);
      if (b?.limit) args.push("--limit", String(parseInt(b.limit, 10) || 0));
      return args;
    },
    mutating: true,
  },
  "activate-dry-run": {
    command: "bun",
    argsBuilder: (b) => {
      const slug = (b?.slug || "").toString();
      if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw new Error("invalid or missing slug");
      return [`${SKILLS}/squads/scripts/activate-squad.ts`, "activate", slug, "--dry-run", "--verbose"];
    },
    mutating: false,
  },
  "index-squads": {
    command: "bun",
    argsBuilder: () => [`${SKILLS}/squads/scripts/index-squads.ts`],
    mutating: true,
  },
  "index-businesses": {
    command: "bun",
    argsBuilder: () => [`${SKILLS}/businesses/scripts/index-businesses.ts`],
    mutating: true,
  },
  "run-smoke": {
    command: "bun",
    argsBuilder: () => [`${SKILLS}/_shared/tests/scope-isolation-smoke.ts`],
    mutating: false,
  },
  "run-test": {
    command: "bun",
    argsBuilder: () => [`${SKILLS}/_shared/tests/scope.test.ts`],
    mutating: false,
  },

  // ── Chat / session actions. Lane "chat". Texto do usuário é ARGV element
  //    (Bun.spawn = argv-exec, não shell) → sem injeção de comando. ──
  //
  // chat-agent: o turno conversacional PADRÃO. Um concierge que RESPONDE
  // perguntas e só despacha quando o usuário pede trabalho concreto. É o que
  // faz "oi" receber uma resposta em vez de um pipeline.
  "chat-agent": {
    command: "bun",
    lane: "chat",
    mutating: true,
    traceId: (b) => (b?.chat_id || "").toString() || null,
    argsBuilder: (b) => {
      const msg = (b?.message || "").toString();
      const chatId = (b?.chat_id || "").toString();
      const resume = (b?.resume_session || "").toString();
      const runtime = (b?.runtime || "").toString();
      if (!msg.trim()) throw new Error("message vazia");
      if (!/^[a-z0-9-]+$/.test(chatId)) throw new Error("chat_id inválido");
      const args = [`${SKILLS}/harness/scripts/chat-concierge.ts`, msg];
      if (resume && /^[A-Za-z0-9_-]+$/.test(resume)) args.push("--resume", resume);
      if (runtime && /^[a-z-]+$/.test(runtime)) args.push("--runtime", runtime);
      if (b?.fast === true) args.push("--fast");  // modo rápido/econômico (opt-in)
      return args;
    },
  },
  // chat-shell: execução de comando de shell arbitrário pelo chat (o `!` do
  // composer). LIVRE por escolha do dono — roda `sh -c "<cmd>"`. Contido a:
  // localhost + gate --allow-actions. O cmd é UM argv de sh -c (é execução de
  // shell de verdade, não injeção no argv do action-runner).
  "chat-shell": {
    command: "sh",
    lane: "chat",
    mutating: true,
    traceId: (b) => (b?.chat_id || "").toString() || null,
    argsBuilder: (b) => {
      const cmd = (b?.command || "").toString();
      const chatId = (b?.chat_id || "").toString();
      if (!cmd.trim()) throw new Error("comando vazio");
      if (!/^[a-z0-9-]+$/.test(chatId)) throw new Error("chat_id inválido");
      return ["-c", cmd];
    },
  },
  "chat-run": {
    command: "bun",
    lane: "chat",
    mutating: true,
    traceId: (b) => (b?.chat_id || "").toString() || null,
    argsBuilder: (b) => {
      const slug = (b?.slug || "").toString();
      const msg = (b?.message || "").toString();
      const chatId = (b?.chat_id || "").toString();
      const budget = (b?.max_budget || "0.50").toString();
      if (!msg.trim()) throw new Error("message vazia");
      if (!/^[a-z0-9-]+$/.test(chatId)) throw new Error("chat_id inválido");
      // slug vazio → --auto (roteador agêntico escolhe a empresa)
      const args = [`${SKILLS}/harness/scripts/dispatch.ts`];
      if (slug) { if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("slug inválido"); args.push(slug, msg); }
      else args.push("--auto", msg);
      args.push("--exec", `--project=${chatId}`, "--safe", `--max-budget=${budget}`);
      return args;
    },
  },
  "chat-revise": {
    command: "bun",
    lane: "chat",
    mutating: true,
    traceId: (b) => (b?.chat_id || "").toString() || null,
    argsBuilder: (b) => {
      const chatId = (b?.chat_id || "").toString();
      const msg = (b?.message || "").toString();
      if (!/^[a-z0-9-]+$/.test(chatId)) throw new Error("chat_id inválido");
      if (!msg.trim()) throw new Error("message vazia");
      return [`${SKILLS}/harness/scripts/revise.ts`, chatId, msg, "--safe"];
    },
  },
  "chat-resume": {
    command: "bun",
    lane: "chat",
    mutating: true,
    traceId: (b) => (b?.chat_id || "").toString() || null,
    argsBuilder: (b) => {
      const chatId = (b?.chat_id || "").toString();
      if (!/^[a-z0-9-]+$/.test(chatId)) throw new Error("chat_id inválido");
      return [`${SKILLS}/_shared/scripts/resume-project.ts`, chatId, "--dispatch"];
    },
  },
};

async function handleAction(req: Request, p: string, opts: any): Promise<Response> {
  const name = p.replace(/^\/api\/actions\//, "");
  if (name === "jobs") return methodNotAllowed();
  // Cancel job
  const cancelMatch = name.match(/^jobs\/([^/]+)\/cancel$/);
  if (cancelMatch) {
    return json({ cancelled: cancelJob(cancelMatch[1]) });
  }
  const def = ACTIONS[name];
  if (!def) return notFound(`unknown action: ${name}`);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  let args: string[];
  try { args = def.argsBuilder(body); }
  catch (e: any) { return json({ error: e.message }, 400); }

  const scope = getScope();
  const result = startJob({
    action: name,
    command: def.command,
    args,
    cwd: scope.projectRoot || undefined,
    mutating: def.mutating,
    lane: def.lane,
    scope_mode: scope.mode,
    project_root: scope.projectRoot,
  });
  if ("error" in result) return json({ error: result.error }, 409);
  const traceId = def.traceId ? def.traceId(body) : null;
  return json({ job: result.job, stream_url: `/api/actions/jobs/${result.job.id}/stream`, trace_id: traceId, run_stream_url: traceId ? `/api/runs/${encodeURIComponent(traceId)}/stream` : null }, 202);
}

function streamJobSSE(req: Request, id: string): Response {
  if (!getJob(id)) return notFound("job not found");
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (data: any) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
      };
      // Heartbeat rápido: jobs headless (claude -p --output-format json) passam
      // ~10-20s sem stdout. Sem bytes trafegando, a conexão SSE cai por
      // ociosidade antes do 1º pulso. 5s fica abaixo de qualquer idle-timeout.
      const hb = setInterval(() => {
        try { controller.enqueue(enc.encode(`: heartbeat\n\n`)); } catch {}
      }, 5_000);
      try {
        for await (const ev of streamJob(id)) {
          send(ev);
          if (ev.kind === "done") break;
        }
      } catch (e: any) {
        send({ kind: "error", message: e.message });
      } finally {
        clearInterval(hb);
        try { controller.close(); } catch {}
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
  });
}

function shutdown(server: any, watchdog: ReturnType<typeof setInterval>) {
  clearInterval(watchdog);
  try { server.stop(true); } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
  process.exit(0);
}
