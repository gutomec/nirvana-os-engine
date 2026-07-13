#!/usr/bin/env bun
// validate-chain.ts — Enforces the Nirvana audit chain integrity end-to-end.
//
// Closes F3 enforcer side from NIRVANA-OS-CORRECTION-REPORT. SKILL.md was
// hardened in C.7 to require brief-business.ts → buildEmployeePrompt → gate;
// this is the post-hoc validator that catches when the maestro (or any
// caller) deviated from the protocol.
//
// Sibling of validate-trace.ts which checks DNA injection only.
// This script checks the FULL chain: brief_received, dispatch_business,
// handoff_phase_advanced × 2 (plan→execute + execute→complete),
// verify_passed, gate_passed.
//
// Usage:
//   bun validate-chain.ts <project_id>
//   bun validate-chain.ts --all                       (validates every project today)
//   bun validate-chain.ts <project_id> --strict       (require gate_passed too)
//   bun validate-chain.ts <project_id> --verify-disk  (re-verify on-disk artifacts behind
//                                                       gate_passed/verify_passed; catches a
//                                                       forged gate with no real artifact)
//
// Exit codes:
//   0 = PASS (chain complete)
//   1 = PROTOCOL_VIOLATION (one or more gaps)
//   2 = TRACE_NOT_FOUND or bad usage

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

type AuditEvent = { ts: string; event: string; [k: string]: any };

function loadEvents(projectId: string): { events: AuditEvent[]; sources: string[] } {
  const events: AuditEvent[] = [];
  const sources: string[] = [];
  const seen = new Set<string>();
  const addEvent = (e: AuditEvent) => {
    const key = `${e.ts}|${e.event}|${e.business_slug || ""}|${e.from_phase || ""}|${e.to_phase || ""}`;
    if (!seen.has(key)) { seen.add(key); events.push(e); }
  };

  // 1. Project-local audits
  const candidateRoots = [
    path.join(process.cwd(), "outputs", projectId),            // novo default visível
    path.join(process.cwd(), ".nirvana/outputs", projectId),
    path.join(os.homedir(), ".nirvana/outputs", projectId),
  ];
  for (const root of candidateRoots) {
    if (!fs.existsSync(root)) continue;
    const bizDir = path.join(root, "businesses");
    if (fs.existsSync(bizDir)) {
      for (const biz of fs.readdirSync(bizDir)) {
        const auditPath = path.join(bizDir, biz, "audit.jsonl");
        if (fs.existsSync(auditPath)) {
          const lines = fs.readFileSync(auditPath, "utf8").split("\n").filter(l => l.trim());
          for (const l of lines) {
            try { addEvent(JSON.parse(l)); } catch {}
          }
          sources.push(auditPath);
        }
      }
    }
  }

  // 2. Global daily audits — filter by project_id or trace_id
  const { harnessLogsDir } = require(path.join(SKILLS_ROOT, "_shared/lib/log-paths.ts"));
  const globalDir = harnessLogsDir();
  if (fs.existsSync(globalDir)) {
    const dates = fs.readdirSync(globalDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    for (const date of dates) {
      const auditPath = path.join(globalDir, date, "audit.jsonl");
      if (!fs.existsSync(auditPath)) continue;
      const lines = fs.readFileSync(auditPath, "utf8").split("\n").filter(l => l.trim());
      for (const l of lines) {
        try {
          const e = JSON.parse(l);
          if (e.project_id === projectId || e.trace_id === projectId) {
            addEvent(e);
          }
        } catch {}
      }
      sources.push(auditPath);
    }
  }

  return { events, sources };
}

function listProjectsToday(): string[] {
  const roots = [
    path.join(process.cwd(), "outputs"),            // novo default visível
    path.join(os.homedir(), ".nirvana/outputs"),
    path.join(process.cwd(), ".nirvana/outputs"),
  ];
  const projects = new Set<string>();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const proj of fs.readdirSync(root)) {
      const projDir = path.join(root, proj);
      try {
        if (!fs.statSync(projDir).isDirectory()) continue;
      } catch { continue; }
      const bizDir = path.join(projDir, "businesses");
      if (fs.existsSync(bizDir)) {
        for (const biz of fs.readdirSync(bizDir)) {
          if (fs.existsSync(path.join(bizDir, biz, "HANDOFF.json"))) {
            projects.add(proj);
            break;
          }
        }
      }
    }
  }
  return [...projects].sort();
}

type ValidationResult = {
  project_id: string;
  status: "PASS" | "PROTOCOL_VIOLATION" | "TRACE_NOT_FOUND";
  events_found: Record<string, number>;
  gaps: string[];
  sources_scanned: number;
};

function validateProject(projectId: string, opts: { strict: boolean; verifyDisk?: boolean; minBytes?: number }): ValidationResult {
  const { events, sources } = loadEvents(projectId);
  if (events.length === 0) {
    return {
      project_id: projectId,
      status: "TRACE_NOT_FOUND",
      events_found: {},
      gaps: ["no audit trail for this project_id anywhere"],
      sources_scanned: sources.length,
    };
  }

  const counts: Record<string, number> = {};
  for (const e of events) counts[e.event] = (counts[e.event] || 0) + 1;

  const gaps: string[] = [];

  // Required events
  if (!counts["brief_received"]) gaps.push("missing event: brief_received (brief-business.ts not run?)");
  if (!counts["dispatch_business"]) gaps.push("missing event: dispatch_business (maestro did not emit?)");
  if ((counts["handoff_phase_advanced"] || 0) < 2) {
    gaps.push(`handoff_phase_advanced count = ${counts["handoff_phase_advanced"] || 0}; expected ≥ 2 (plan→execute + execute→complete)`);
  }
  if (!counts["verify_passed"]) {
    gaps.push("missing event: verify_passed (verify-deliverable.ts not run, or returned FAIL/INDETERMINATE)");
  }
  if (opts.strict && !counts["gate_passed"]) {
    gaps.push("strict mode: missing event: gate_passed (quality-gate.ts not run per artifact)");
  }

  // Chronological sanity
  const brief = events.find(e => e.event === "brief_received");
  const dispatch = events.find(e => e.event === "dispatch_business");
  if (brief && dispatch) {
    if (Date.parse(dispatch.ts) < Date.parse(brief.ts)) {
      gaps.push(`chronological: dispatch_business (${dispatch.ts}) before brief_received (${brief.ts})`);
    }
  }

  // Phase progression sanity
  const phaseEvents = events
    .filter(e => e.event === "handoff_phase_advanced")
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const phases = phaseEvents.map(e => `${e.from_phase}→${e.to_phase}`);
  const expectedSequence = ["plan→execute", "execute→complete"];
  if (phases.length >= 2) {
    const hasPlanToExecute = phases.some(p => p === "plan→execute");
    const hasExecuteToComplete = phases.some(p => p === "execute→complete");
    if (!hasPlanToExecute) gaps.push("phase: missing plan→execute transition");
    if (!hasExecuteToComplete) gaps.push("phase: missing execute→complete transition");
  }

  // --verify-disk: re-verify the on-disk artifacts behind each gate_passed/
  // verify_passed. Catches a forged gate (event emitted with no real artifact).
  // Opt-in: default behavior is unchanged. Reuses verify-deliverable's pure
  // disk-truth check (imported, not spawned — no audit pollution).
  if (opts.verifyDisk) {
    const verifySlugs = new Set<string>();
    for (const e of events) {
      const bslug = e.business_slug ?? (e as any).business; // alias agêntico (E3)
      if ((e.event === "gate_passed" || e.event === "verify_passed") && bslug) {
        verifySlugs.add(bslug);
      }
    }
    if (verifySlugs.size === 0) {
      gaps.push("verify-disk: requested but no gate_passed/verify_passed event carries a business_slug to disk-verify");
    } else {
      const { verifyDeliverableOnDisk } = require(path.join(SKILLS_ROOT, "businesses/scripts/verify-deliverable.ts"));
      for (const slug of verifySlugs) {
        let r: any;
        try {
          r = verifyDeliverableOnDisk(projectId, slug, { minBytes: opts.minBytes });
        } catch (err: any) {
          gaps.push(`verify-disk: ${slug} — check threw: ${err.message}`);
          continue;
        }
        if (r.status !== "PASS") {
          const detail = r.status === "FAIL_INDETERMINATE"
            ? (r.reason || "indeterminate")
            : `${r.found}/${r.expected} on disk${r.missing.length ? `, missing ${r.missing.length}` : ""}${r.empty_or_stub.length ? `, stub ${r.empty_or_stub.length}` : ""}`;
          gaps.push(`verify-disk: ${slug} claimed gate_passed/verify_passed but artifact check = ${r.status} (${detail})`);
        }
      }
    }
  }

  return {
    project_id: projectId,
    status: gaps.length === 0 ? "PASS" : "PROTOCOL_VIOLATION",
    events_found: counts,
    gaps,
    sources_scanned: sources.length,
  };
}

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const all = args.includes("--all");
const jsonOnly = args.includes("--json");
const verifyDisk = args.includes("--verify-disk");
const mbArg = args.find(a => a.startsWith("--min-bytes="));
const minBytes = mbArg ? parseInt(mbArg.slice("--min-bytes=".length), 10) : undefined;

if (all) {
  const projects = listProjectsToday();
  const results = projects.map(p => validateProject(p, { strict, verifyDisk, minBytes }));
  const passed = results.filter(r => r.status === "PASS").length;
  const violations = results.filter(r => r.status === "PROTOCOL_VIOLATION").length;
  const notFound = results.length - passed - violations;
  const output = {
    summary: { total: results.length, passed, violations, not_found: notFound, strict },
    results,
  };
  if (jsonOnly) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`Scanned ${results.length} projects. PASS=${passed} VIOLATION=${violations} NOT_FOUND=${notFound}`);
    for (const r of results) {
      const icon = r.status === "PASS" ? "✓" : (r.status === "PROTOCOL_VIOLATION" ? "✗" : "?");
      console.log(`  ${icon} ${r.project_id}: ${r.status}${r.gaps.length ? " — " + r.gaps[0] : ""}`);
    }
  }
  process.exit(violations === 0 ? 0 : 1);
}

const projectId = args.find(a => !a.startsWith("--"));
if (!projectId) {
  console.error("Uso: bun validate-chain.ts <project_id> [--strict] [--verify-disk] [--min-bytes=N] [--json]");
  console.error("     bun validate-chain.ts --all [--strict] [--verify-disk] [--min-bytes=N] [--json]");
  process.exit(2);
}

const result = validateProject(projectId, { strict, verifyDisk, minBytes });
if (jsonOnly) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Project: ${result.project_id}`);
  console.log(`Status:  ${result.status}`);
  console.log(`Events:  ${JSON.stringify(result.events_found)}`);
  if (result.gaps.length) {
    console.log("Gaps:");
    for (const g of result.gaps) console.log(`  - ${g}`);
  }
}
process.exit(result.status === "PASS" ? 0 : (result.status === "TRACE_NOT_FOUND" ? 2 : 1));
