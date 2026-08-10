/**
 * artifact-indexer.js — discover "what was created" across the system.
 *
 * Walks the well-known output roots and produces a normalized Artifact[]:
 *   - briefs (brief.md inside project dirs)
 *   - handoffs (HANDOFF.json + handoffs/*.md)
 *   - project plans (project-plan.json)
 *   - dag states (dag-state.json)
 *   - audit run results (audit-results.jsonl)
 *   - free-form outputs (<projectRoot>/.nirvana/outputs/<run_id>/<topic>/*)
 *
 * Output type:
 *   {
 *     id, project_id, type, title, path, created_at,
 *     parent_id?, produced_by?: { kind, slug }, size_bytes
 *   }
 *
 * Pure JS, no deps. Cross-OS via path.join. Each helper handles missing
 * dirs gracefully — returns empty array.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ARTIFACT_TYPES = {
  brief: 'brief',
  handoff: 'handoff',
  plan: 'plan',
  dag: 'dag',
  audit_run: 'audit_run',
  output: 'output',
  decision: 'decision',
};

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function isoFromMtime(stat) {
  if (!stat) return null;
  return new Date(stat.mtime || stat.ctime || Date.now()).toISOString();
}

function indexProjectLogs(rootDir, source) {
  const out = [];
  if (!rootDir || !fs.existsSync(rootDir)) return out;
  let entries;
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const projectDir = path.join(rootDir, e.name);
    const projectId = e.name;

    // brief.md
    const briefPath = path.join(projectDir, 'brief.md');
    const briefStat = safeStat(briefPath);
    if (briefStat?.isFile()) {
      out.push({
        id: `brief:${projectId}`,
        project_id: projectId,
        type: ARTIFACT_TYPES.brief,
        title: `brief · ${projectId}`,
        path: briefPath,
        created_at: isoFromMtime(briefStat),
        size_bytes: briefStat.size,
        source,
      });
    }

    // project-plan.json
    const planPath = path.join(projectDir, 'project-plan.json');
    const planStat = safeStat(planPath);
    if (planStat?.isFile()) {
      out.push({
        id: `plan:${projectId}`,
        project_id: projectId,
        type: ARTIFACT_TYPES.plan,
        title: `plan · ${projectId}`,
        path: planPath,
        created_at: isoFromMtime(planStat),
        parent_id: briefStat ? `brief:${projectId}` : null,
        size_bytes: planStat.size,
        source,
      });
    }

    // dag-state.json
    const dagPath = path.join(projectDir, 'dag-state.json');
    const dagStat = safeStat(dagPath);
    if (dagStat?.isFile()) {
      out.push({
        id: `dag:${projectId}`,
        project_id: projectId,
        type: ARTIFACT_TYPES.dag,
        title: `dag · ${projectId}`,
        path: dagPath,
        created_at: isoFromMtime(dagStat),
        parent_id: planStat ? `plan:${projectId}` : (briefStat ? `brief:${projectId}` : null),
        size_bytes: dagStat.size,
        source,
      });
    }

    // HANDOFF.json + handoffs/*.md (one entry per handoff doc)
    const handoffPath = path.join(projectDir, 'HANDOFF.json');
    const handoffStat = safeStat(handoffPath);
    if (handoffStat?.isFile()) {
      let businessSlug = null;
      try { const h = JSON.parse(fs.readFileSync(handoffPath, 'utf8')); businessSlug = h.business_slug || null; }
      catch {}
      out.push({
        id: `handoff:${projectId}`,
        project_id: projectId,
        type: ARTIFACT_TYPES.handoff,
        title: `handoff · ${projectId}`,
        path: handoffPath,
        created_at: isoFromMtime(handoffStat),
        parent_id: dagStat ? `dag:${projectId}` : null,
        produced_by: businessSlug ? { kind: 'business', slug: businessSlug } : null,
        size_bytes: handoffStat.size,
        source,
      });
    }
    // handoffs/*.md
    const handoffsDir = path.join(projectDir, 'handoffs');
    if (fs.existsSync(handoffsDir)) {
      try {
        for (const f of fs.readdirSync(handoffsDir)) {
          if (!/\.md$/i.test(f)) continue;
          const full = path.join(handoffsDir, f);
          const st = safeStat(full);
          if (!st?.isFile()) continue;
          out.push({
            id: `handoff:${projectId}:${f.replace(/\.md$/i, '')}`,
            project_id: projectId,
            type: ARTIFACT_TYPES.handoff,
            title: `handoff:${f.replace(/\.md$/i, '')}`,
            path: full,
            created_at: isoFromMtime(st),
            parent_id: handoffStat ? `handoff:${projectId}` : null,
            size_bytes: st.size,
            source,
          });
        }
      } catch {}
    }

    // audit-results.jsonl
    const auditPath = path.join(projectDir, 'audit-results.jsonl');
    const auditStat = safeStat(auditPath);
    if (auditStat?.isFile()) {
      out.push({
        id: `audit_run:${projectId}`,
        project_id: projectId,
        type: ARTIFACT_TYPES.audit_run,
        title: `audit · ${projectId}`,
        path: auditPath,
        created_at: isoFromMtime(auditStat),
        parent_id: dagStat ? `dag:${projectId}` : null,
        size_bytes: auditStat.size,
        source,
      });
    }
  }
  return out;
}

function indexOutputsDir(outputsRoot, source) {
  const out = [];
  if (!outputsRoot || !fs.existsSync(outputsRoot)) return out;
  let runs;
  try { runs = fs.readdirSync(outputsRoot, { withFileTypes: true }); }
  catch { return out; }
  for (const r of runs) {
    if (!r.isDirectory() || r.name.startsWith('.')) continue;
    const runDir = path.join(outputsRoot, r.name);
    const runId = r.name;
    // Top-level structure typically: <run>/<topic>/<files>
    let topics;
    try { topics = fs.readdirSync(runDir, { withFileTypes: true }); }
    catch { continue; }
    for (const t of topics) {
      if (t.name.startsWith('.')) continue;
      const tp = path.join(runDir, t.name);
      const stat = safeStat(tp);
      if (!stat) continue;
      if (t.isFile()) {
        out.push({
          id: `output:${runId}:${t.name}`,
          project_id: runId,
          type: ARTIFACT_TYPES.output,
          title: t.name,
          path: tp,
          created_at: isoFromMtime(stat),
          size_bytes: stat.size,
          source,
        });
      } else if (t.isDirectory()) {
        // Aggregate the topic dir as a single "output" node, with file count
        let fileCount = 0;
        let totalBytes = 0;
        try {
          for (const f of fs.readdirSync(tp)) {
            const fp = path.join(tp, f);
            const fs2 = safeStat(fp);
            if (fs2?.isFile()) { fileCount++; totalBytes += fs2.size; }
          }
        } catch {}
        out.push({
          id: `output:${runId}:${t.name}`,
          project_id: runId,
          type: ARTIFACT_TYPES.output,
          title: `${t.name} (${fileCount} files)`,
          path: tp,
          created_at: isoFromMtime(stat),
          size_bytes: totalBytes,
          file_count: fileCount,
          source,
        });
      }
    }
  }
  return out;
}

function dedupe(artifacts) {
  const seen = new Set();
  const out = [];
  for (const a of artifacts) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

const FS_INTERESTING_EXTS = new Set(['.md', '.html', '.htm', '.json', '.yaml', '.yml', '.csv', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.txt', '.tsv']);
const FS_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.nirvana', '.maestro-logs', '.harness-logs',
  'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.cache', '__pycache__',
  '.venv', 'venv', 'target', '.idea', '.vscode',
]);

/**
 * Walk projectRoot (depth-limited) and surface non-instrumented files that
 * look like deliverables: .md, .html, .json, .yaml, images, pdfs at the top
 * 2-3 levels. This catches outputs from agents that bypass Nirvana's
 * orchestration (Claude Code Task subagents writing files directly to the
 * project tree, manual edits, etc).
 *
 * Filters: extension whitelist, dir blacklist (node_modules, .git, ...),
 *          mtime > sinceMs, max files cap.
 */
function indexFsActivity(projectRoot, opts = {}) {
  const out = [];
  if (!projectRoot || !fs.existsSync(projectRoot)) return out;
  const maxDepth = opts.maxDepth ?? 3;
  const maxFiles = opts.maxFiles ?? 200;
  const sinceMs = opts.sinceMs ?? (Date.now() - 30 * 86400_000); // last 30 days

  function walk(dir, depth) {
    if (out.length >= maxFiles) return;
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.name.startsWith('.') && depth === 0) continue;
      if (FS_EXCLUDE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!FS_INTERESTING_EXTS.has(ext)) continue;
      const stat = safeStat(full);
      if (!stat || stat.mtimeMs < sinceMs) continue;
      const rel = path.relative(projectRoot, full);
      // Project-id heuristic: if file is under a top-level directory, use that as session
      const parts = rel.split(path.sep);
      const sessionId = parts.length > 1 ? parts[0] : 'root';
      out.push({
        id: `fs:${rel}`,
        project_id: path.basename(projectRoot) + (sessionId !== 'root' ? `/${sessionId}` : ''),
        type: ARTIFACT_TYPES.output,
        title: rel,
        path: full,
        created_at: isoFromMtime(stat),
        size_bytes: stat.size,
        source: 'fs',
      });
    }
  }
  walk(projectRoot, 0);
  return out;
}

/**
 * Index everything under the supplied roots.
 * roots: {
 *   logsDirs?: string[],       // .maestro-logs / .harness-logs project dirs
 *   outputsDirs?: string[],    // <projectRoot>/.nirvana/outputs
 *   fsRoots?: string[],        // project roots whose loose files (md/html/json/...) we should pick up
 *   fsOpts?: { maxDepth, maxFiles, sinceMs }
 * }
 */
function indexArtifacts(roots = {}) {
  const all = [];
  const logsDirs = (roots.logsDirs || []).filter(Boolean);
  const outputsDirs = (roots.outputsDirs || []).filter(Boolean);
  const fsRoots = (roots.fsRoots || []).filter(Boolean);
  for (const d of logsDirs) all.push(...indexProjectLogs(d, 'logs'));
  for (const d of outputsDirs) all.push(...indexOutputsDir(d, 'outputs'));
  for (const d of fsRoots) all.push(...indexFsActivity(d, roots.fsOpts || {}));
  return dedupe(all).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

module.exports = { indexArtifacts, indexProjectLogs, indexOutputsDir, indexFsActivity, ARTIFACT_TYPES };
