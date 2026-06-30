#!/usr/bin/env bun
/**
 * state-snapshot.ts — render markdown views of the SQLite-backed state.
 *
 * Generates audit.md, gates.md, decisions.md from the audit_events,
 * quality_gates and decisions_history tables. The DB is authoritative;
 * these markdown files are derived views for human grep/inspection.
 *
 * Usage:
 *   bun state-snapshot.ts [--out <dir>] [--project <id>] [--limit N]
 *
 * Default output:
 *   <projectRoot>/.nirvana/views/   (when inside a project)
 *   ./state-views/                  (otherwise)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs, EXIT } from "../lib/bun-helpers.ts";
import { resolveScope } from "../lib/scope.ts";

const sdb = require("../lib/state-db.js");

const { flags } = parseArgs();
const limit = Number.isFinite(flags.limit as any) ? Number(flags.limit) : 200;
const projectFilter = typeof flags.project === "string" ? flags.project : null;

const scope = resolveScope();
const handle = sdb.openDb(scope.projectRoot);
if (!handle.available) {
  console.error(`[snapshot] SQLite unavailable: ${handle.reason}`);
  process.exit(EXIT.FAILURES);
}

const outDir = (flags.out as string)
  || (scope.projectRoot ? path.join(scope.projectRoot, ".nirvana", "views") : path.join(process.cwd(), "state-views"));
fs.mkdirSync(outDir, { recursive: true });

function renderAudit(): string {
  const filters = projectFilter ? { project_id: projectFilter } : {};
  const rows = sdb.listAudit(handle, filters, limit);
  const lines = ["# Audit events", "",
    `Source: \`${handle.path}\` · ${rows.length} most recent (limit=${limit})`, ""];
  if (projectFilter) lines.push(`Filtered by project: \`${projectFilter}\``, "");
  lines.push("| ts | event | trace_id | project_id |");
  lines.push("|---|---|---|---|");
  for (const r of rows) {
    lines.push(`| \`${r.ts}\` | \`${r.event}\` | \`${r.trace_id || ""}\` | \`${r.project_id || ""}\` |`);
  }
  return lines.join("\n") + "\n";
}

function renderGates(): string {
  const filters = projectFilter ? { project_id: projectFilter } : {};
  const rows = sdb.listGates(handle, filters, limit);
  const lines = ["# Quality gates", "",
    `Source: \`${handle.path}\` · ${rows.length} most recent (limit=${limit})`, ""];
  for (const r of rows) {
    lines.push(`## ${r.phase} · ${r.task_id || "(no task)"} · ${r.ran_at}`);
    lines.push("");
    lines.push(`- **verdict:** \`${r.verdict}\` (score=${r.score ?? "n/a"})`);
    if (r.host) lines.push(`- host: \`${r.host}\``);
    if (Array.isArray(r.failed_checks) && r.failed_checks.length) {
      lines.push(`- failed checks: ${r.failed_checks.length}`);
      for (const f of r.failed_checks) lines.push(`  - ${typeof f === 'string' ? f : JSON.stringify(f)}`);
    }
    if (Array.isArray(r.evidence) && r.evidence.length) {
      lines.push(`- evidence:`);
      for (const e of r.evidence) lines.push(`  - ${typeof e === 'string' ? e : JSON.stringify(e)}`);
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

function renderDecisions(): string {
  const rows = sdb.listDecisions(handle, projectFilter, { limit });
  const lines = ["# Decisions history", "",
    `Source: \`${handle.path}\` · ${rows.length} most recent (limit=${limit})`, ""];
  if (projectFilter) lines.push(`Filtered by project: \`${projectFilter}\``, "");
  for (const r of rows) {
    lines.push(`## ${r.decision_id} · ${r.recorded_at}`);
    lines.push("");
    lines.push(`**project:** ${r.project_id}`);
    if (r.source) lines.push(`**source:** ${r.source}`);
    lines.push("");
    lines.push(r.text);
    if (r.rationale) {
      lines.push("");
      lines.push(`> ${r.rationale}`);
    }
    if (r.superseded_by) lines.push(`\n_superseded by row #${r.superseded_by}_`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

const auditFile = path.join(outDir, "audit.md");
const gatesFile = path.join(outDir, "gates.md");
const decisionsFile = path.join(outDir, "decisions.md");

fs.writeFileSync(auditFile, renderAudit());
fs.writeFileSync(gatesFile, renderGates());
fs.writeFileSync(decisionsFile, renderDecisions());

console.log(`[snapshot] wrote views to ${outDir}`);
console.log(`  - ${path.basename(auditFile)}`);
console.log(`  - ${path.basename(gatesFile)}`);
console.log(`  - ${path.basename(decisionsFile)}`);
process.exit(EXIT.OK);
