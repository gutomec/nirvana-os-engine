#!/usr/bin/env bun
// verify-deliverable.ts — Compare what the brief promised vs what's on disk.
//
// Closes F2 from NIRVANA-OS-CORRECTION-REPORT. Previously, the maestro
// trusted the subagent's summary ("delivered X files!") without verifying.
// This script does the disk-truth check: parse expected paths from the brief,
// stat each one, report missing + stubs.
//
// Exposes verifyDeliverableOnDisk() as a PURE function (no audit emit, no
// process.exit) so other tools — notably `validate-chain --verify-disk` —
// reuse the exact disk-truth logic without spawning a process or polluting
// the audit log. The CLI wrapper (guarded by import.meta.main) keeps the
// original behavior: print the report, emit the audit event, exit by status.
//
// Usage:
//   bun verify-deliverable.ts <project_id> <business_slug>
//   bun verify-deliverable.ts <project_id> <business_slug> --outputs-root /path
//   bun verify-deliverable.ts <project_id> <business_slug> --min-bytes 200
//
// Exit codes:
//   0 = 100% delivered (PASS)
//   1 = some missing or stubbed (FAIL)
//   2 = brief unparseable or project dir not found (FAIL_INDETERMINATE)

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { businessDirFor, readAcceptance } from "../lib/acceptance.ts";

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

export type DeliverableReport = {
  status: "PASS" | "FAIL" | "FAIL_INDETERMINATE";
  project_id: string;
  business_slug: string;
  manifest_source: string;
  expected: number;
  found: number;
  missing: string[];
  empty_or_stub: string[];
  delta_pct: number;
  min_bytes_threshold: number;
  reason?: string;
};

// Pure disk-truth check. No console, no audit emit, no exit — returns a report
// the caller acts on. Indeterminate (project/brief/markers absent) is a status,
// not a thrown error, so callers can treat it as a gap.
export function verifyDeliverableOnDisk(
  projectId: string,
  businessSlug: string,
  opts: { outputsRoot?: string; minBytes?: number; businessDir?: string | null } = {}
): DeliverableReport {
  const minBytes = opts.minBytes ?? 200;
  const outputsRoot = opts.outputsRoot;

  const base = (
    status: DeliverableReport["status"],
    extra: Partial<DeliverableReport> = {}
  ): DeliverableReport => ({
    status,
    project_id: projectId,
    business_slug: businessSlug,
    manifest_source: "none",
    expected: 0,
    found: 0,
    missing: [],
    empty_or_stub: [],
    delta_pct: 100,
    min_bytes_threshold: minBytes,
    ...extra,
  });

  // Find the project root (.nirvana/outputs in project cwd, or ~/.nirvana/outputs)
  const projectRootCandidates = [
    path.join(process.cwd(), "outputs"),            // novo default visível
    path.join(process.cwd(), ".nirvana/outputs"),   // compat: runs antigos
    path.join(os.homedir(), ".nirvana/outputs"),
  ];
  // Two layouts, both legitimate. The scripted path nests a run under
  // `outputs/<project_id>/`; `nrv team` writes a chain into a FLAT outputs root
  // with `_team/<seat>/` beside the finals. This checker knew only the first, so
  // it answered FAIL_INDETERMINATE for a chain run whose files were on disk —
  // "project not found" for work that was right there. `projectDir` is whichever
  // one actually holds the run.
  const projectsRoot = projectRootCandidates.find(p => fs.existsSync(path.join(p, projectId)));
  const flatRoot = !projectsRoot
    ? projectRootCandidates.find(p => fs.existsSync(path.join(p, "brief.md")) || fs.existsSync(path.join(p, "_team")))
    : null;
  if (!projectsRoot && !flatRoot) {
    return base("FAIL_INDETERMINATE", { reason: `project not found in ${projectRootCandidates.join(" or ")} (neither nested nor flat layout)` });
  }
  const projectDir = projectsRoot ? path.join(projectsRoot, projectId) : flatRoot!;

  const briefPath = path.join(projectDir, "brief.md");
  if (!fs.existsSync(briefPath)) {
    return base("FAIL_INDETERMINATE", { reason: `brief not found: ${briefPath}` });
  }
  const brief = fs.readFileSync(briefPath, "utf8");

  // F11 fix: prefer canonical deliverables.json (written by brief-business.ts
  // --manifest). It's authoritative; brief.md regex is best-effort fallback.
  let expectedPathsRaw: string[] = [];
  let manifestSource = "brief-regex";
  // A run files its manifest under the target that produced it: `businesses/<slug>/`
  // for a business, `squads/<slug>/` for a squad, or at the run root. This check
  // knew the first and the last. On 2026-09-04 a squad run had two manifests under
  // `squads/`, every promised file on disk, and got FAIL_INDETERMINATE "no
  // deliverables.json" — a verdict about where the tool looked, not about the work.
  const manifestCandidates = [
    path.join(projectDir, "businesses", businessSlug, "deliverables.json"),
    path.join(projectDir, "squads", businessSlug, "deliverables.json"),
    path.join(projectDir, "deliverables.json"), // run-level fallback
  ];
  const manifestFile: string | null = manifestCandidates.find(p => fs.existsSync(p)) ?? null;

  if (manifestFile) {
    try {
      const data = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      if (Array.isArray(data)) expectedPathsRaw = data;
      else if (data && Array.isArray(data.deliverables)) expectedPathsRaw = data.deliverables;
      manifestSource = `manifest:${path.relative(process.cwd(), manifestFile)}`;
    } catch (e: any) {
      // fall back to brief regex below; record why
      manifestSource = `brief-regex (manifest parse failed: ${e.message})`;
    }
  }

  // Business Protocol 2.0 §11: an `acceptance[]` entry that names a `path` is a
  // promise the disk can be checked against — the same completeness proof a
  // deliverables.json gives, declared by the role instead of written per run. Read
  // only when there is no manifest: a manifest is the run's own list and wins.
  let acceptanceMinBytes: Map<string, number> = new Map();
  if (expectedPathsRaw.length === 0) {
    const bizDir = opts.businessDir ?? businessDirFor(businessSlug);
    const promised = bizDir ? readAcceptance(bizDir).paths : [];
    if (promised.length > 0) {
      const base = outputsRoot ?? projectDir;
      expectedPathsRaw = promised.map(entry => path.isAbsolute(entry.path) ? entry.path : path.resolve(base, entry.path));
      acceptanceMinBytes = new Map(promised.map((entry, index) => [expectedPathsRaw[index], entry.minBytes ?? minBytes]));
      manifestSource = "acceptance";
    }
  }

  // Fallback: scan brief.md for explicit absolute paths
  if (expectedPathsRaw.length === 0) {
    const pathRegex = /\/(?:Users|home|tmp|opt)\/[^\s`'"\)\]]+\.(md|json|ya?ml|png|jpg|jpeg|html|txt|pdf|csv|tsv|svg|webp)/g;
    expectedPathsRaw = [...new Set(brief.match(pathRegex) || [])];

    // If outputs-root override given, also search for paths starting with it
    if (outputsRoot) {
      const rootRegex = new RegExp(outputsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/[^\\s`'\"\\)\\]]+\\.(md|json|ya?ml|png|jpg|jpeg|html|txt|pdf|csv|tsv|svg|webp)", "g");
      const moreMatches = brief.match(rootRegex) || [];
      for (const m of moreMatches) {
        if (!expectedPathsRaw.includes(m)) expectedPathsRaw.push(m);
      }
    }
  }

  if (expectedPathsRaw.length === 0) {
    return base("FAIL_INDETERMINATE", {
      manifest_source: manifestSource,
      reason: `no deliverables.json (looked in ${manifestCandidates.map(p => path.relative(projectDir, p)).join(", ")}), no acceptance[] entry with a path, and brief.md has no /path markers`,
    });
  }

  const results = expectedPathsRaw.map(p => {
    const exists = fs.existsSync(p);
    const bytes = exists ? fs.statSync(p).size : 0;
    // An acceptance entry may declare its own `min_bytes`; otherwise the run's threshold.
    const threshold = acceptanceMinBytes.get(p) ?? minBytes;
    return { path: p, exists, bytes, isStub: exists && bytes < threshold };
  });

  const found = results.filter(r => r.exists).length;
  const expected = results.length;
  const missing = results.filter(r => !r.exists).map(r => r.path);
  const empty = results.filter(r => r.isStub).map(r => `${r.path} (${r.bytes}B)`);
  const status = (found === expected && empty.length === 0) ? "PASS" : "FAIL";
  const deltaPct = Math.round((1 - found / expected) * 100);

  return {
    status,
    project_id: projectId,
    business_slug: businessSlug,
    manifest_source: manifestSource,
    expected,
    found,
    missing,
    empty_or_stub: empty,
    delta_pct: deltaPct,
    min_bytes_threshold: minBytes,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const argFlag = (name: string, fallback?: string): string | undefined => {
    const i = process.argv.indexOf(name);
    if (i === -1) return fallback;
    const next = process.argv[i + 1];
    if (!next || next.startsWith("--")) return fallback;
    return next;
  };

  const positional = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const projectId = positional[0];
  const businessSlug = positional[1];
  const outputsRoot = argFlag("--outputs-root");
  const minBytes = parseInt(argFlag("--min-bytes", "200") || "200", 10);

  if (!projectId || !businessSlug) {
    console.error("Usage: bun verify-deliverable.ts <project_id> <business_slug> [--outputs-root <dir>] [--min-bytes N]");
    process.exit(2);
  }

  const r = verifyDeliverableOnDisk(projectId, businessSlug, { outputsRoot, minBytes });

  if (r.status === "FAIL_INDETERMINATE") {
    console.error(`WARN: ${r.reason || "indeterminate"}`);
    if (r.reason && r.reason.startsWith("no deliverables.json")) {
      console.error("To fix: write the run's manifest next time — `brief-business.ts --manifest <paths.json>` for a business, or `squads/<slug>/deliverables.json` beside a squad's outputs.");
    }
  }

  const report = {
    trace_id: process.env.NIRVANA_TRACE_ID || null,
    project_id: r.project_id,
    business_slug: r.business_slug,
    manifest_source: r.manifest_source,
    expected: r.expected,
    found: r.found,
    missing: r.missing,
    empty_or_stub: r.empty_or_stub,
    delta_pct: r.delta_pct,
    min_bytes_threshold: r.min_bytes_threshold,
    status: r.status,
    timestamp: new Date().toISOString(),
    ...(r.reason ? { reason: r.reason } : {}),
  };
  console.log(JSON.stringify(report, null, 2));

  // Audit emit — only for an actual verdict (PASS/FAIL); indeterminate stays
  // silent in the audit (matches the original, which exited before emit).
  if (r.status === "PASS" || r.status === "FAIL") {
    try {
      const projectsRoot = [
        path.join(process.cwd(), "outputs"),
        path.join(process.cwd(), ".nirvana/outputs"),
        path.join(os.homedir(), ".nirvana/outputs"),
      ].find(p => fs.existsSync(path.join(p, projectId)))!;
      const projectDir = path.join(projectDir, "businesses", businessSlug);
      fs.mkdirSync(projectDir, { recursive: true });
      const auditEntry = JSON.stringify({
        ts: report.timestamp,
        event: r.status === "PASS" ? "verify_passed" : "verify_failed",
        trace_id: report.trace_id,
        project_id: projectId,
        business_slug: businessSlug,
        expected: r.expected,
        found: r.found,
        missing_count: r.missing.length,
        stub_count: r.empty_or_stub.length,
        delta_pct: r.delta_pct,
      });
      fs.appendFileSync(path.join(projectDir, "audit.jsonl"), auditEntry + "\n");

      // Also emit to harness daily audit (per-project when inside a project, else $HOME)
      const { harnessLogsDir } = require(path.join(SKILLS_ROOT, "_shared/lib/log-paths.ts"));
      const today = new Date().toISOString().slice(0, 10);
      const auditDir = path.join(harnessLogsDir({ cwd: projectDir }), today);
      fs.mkdirSync(auditDir, { recursive: true });
      fs.appendFileSync(path.join(auditDir, "audit.jsonl"), auditEntry + "\n");
    } catch (e: any) {
      console.error(`(audit emit failed non-fatal: ${e.message})`);
    }
  }

  process.exit(r.status === "PASS" ? 0 : (r.status === "FAIL_INDETERMINATE" ? 2 : 1));
}
