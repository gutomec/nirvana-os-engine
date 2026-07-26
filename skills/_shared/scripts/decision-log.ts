#!/usr/bin/env bun
/**
 * decision-log.ts — append/list/show decisions for the current project.
 *
 * Memory-lite: persists project decisions in the SQLite-backed
 * decisions_history table (managed by ~/.nirvana/skills/_shared/lib/state-db.js).
 *
 * Usage:
 *   bun decision-log.ts add "<id>: <text>" [--source X] [--rationale "..."]
 *   bun decision-log.ts list [--project <id>] [--limit 20]
 *   bun decision-log.ts show <decision_id>
 *
 * Project ID resolution:
 *   1. --project flag
 *   2. NIRVANA_PROJECT_ID env var
 *   3. basename of the resolved project root (from scope resolver)
 *   4. literal '_global' when no project is detected
 */

import * as path from "node:path";
import { parseArgs, EXIT } from "../lib/bun-helpers.ts";
import { resolveScope } from "../lib/scope.ts";

const sdb = require("../lib/state-db.js");

const { positional, flags } = parseArgs();
const cmd = positional[0];

function resolveProjectId(): string {
  if (typeof flags.project === "string") return flags.project;
  if (process.env.NIRVANA_PROJECT_ID) return process.env.NIRVANA_PROJECT_ID;
  const scope = resolveScope();
  if (scope.projectRoot) return path.basename(scope.projectRoot);
  return "_global";
}

function openHandle() {
  const scope = resolveScope();
  const handle = sdb.openDb(scope.projectRoot);
  if (!handle.available) {
    console.error(`[decision-log] SQLite unavailable: ${handle.reason}`);
    console.error(`  bun:sqlite is required. Are you running this with Bun ≥ 1.0?`);
    process.exit(EXIT.FAILURES);
  }
  return handle;
}

function cmdAdd() {
  const phrase = positional[1];
  if (!phrase) {
    console.error('usage: decision-log add "<id>: <text>" [--source X] [--rationale "..."]');
    process.exit(EXIT.INVALID_ARGS);
  }
  const m = phrase.match(/^([A-Za-z][\w-]*)\s*:\s*(.+)$/);
  if (!m) {
    console.error(`[decision-log] phrase must start with "<id>:" — e.g. "D-01: ES como base"`);
    process.exit(EXIT.INVALID_ARGS);
  }
  const decision_id = m[1];
  const text = m[2].trim();
  const project_id = resolveProjectId();
  const handle = openHandle();
  const id = sdb.appendDecision(handle, {
    project_id,
    decision_id,
    text,
    source: typeof flags.source === "string" ? flags.source : null,
    rationale: typeof flags.rationale === "string" ? flags.rationale : null,
  });
  console.log(`[decision-log] recorded ${decision_id} (row #${id}) for project ${project_id}`);
  process.exit(EXIT.OK);
}

function cmdList() {
  const project_id = typeof flags.project === "string" ? flags.project : resolveProjectId();
  const limit = Number.isFinite(flags.limit as any) ? Number(flags.limit) : 20;
  const handle = openHandle();
  const rows = sdb.listDecisions(handle, project_id, { limit });
  if (rows.length === 0) {
    console.log(`[decision-log] no decisions for project ${project_id}`);
    process.exit(EXIT.OK);
  }
  console.log(`[decision-log] ${rows.length} decision(s) for project ${project_id} (most recent first):`);
  console.log("");
  for (const r of rows) {
    const supersedeMark = r.superseded_by ? ` (superseded by #${r.superseded_by})` : "";
    console.log(`  ${r.decision_id} · ${r.recorded_at}${supersedeMark}`);
    console.log(`    ${r.text}`);
    if (r.source) console.log(`    source: ${r.source}`);
    if (r.rationale) console.log(`    why: ${r.rationale}`);
    console.log("");
  }
  process.exit(EXIT.OK);
}

function cmdShow() {
  const id = positional[1];
  if (!id) {
    console.error("usage: decision-log show <decision_id>");
    process.exit(EXIT.INVALID_ARGS);
  }
  const handle = openHandle();
  const rows = sdb.findDecision(handle, id);
  if (!rows || rows.length === 0) {
    console.error(`[decision-log] no decision with id '${id}'`);
    process.exit(EXIT.FAILURES);
  }
  for (const r of rows) {
    console.log(`──── ${r.decision_id} (row #${r.id}) ────`);
    console.log(`project:    ${r.project_id}`);
    console.log(`recorded:   ${r.recorded_at}`);
    console.log(`text:       ${r.text}`);
    if (r.source) console.log(`source:     ${r.source}`);
    if (r.rationale) console.log(`rationale:  ${r.rationale}`);
    if (r.superseded_by) console.log(`superseded_by: row #${r.superseded_by}`);
    console.log("");
  }
  process.exit(EXIT.OK);
}

switch (cmd) {
  case "add": cmdAdd(); break;
  case "list": cmdList(); break;
  case "show": cmdShow(); break;
  default:
    console.error("usage: decision-log <add|list|show> ...");
    process.exit(EXIT.INVALID_ARGS);
}
