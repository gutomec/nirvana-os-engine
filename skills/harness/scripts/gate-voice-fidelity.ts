#!/usr/bin/env bun
/**
 * nrv gate voice-fidelity <artifact_path> --slugs <comma-list> [opts]
 *
 * Layer 3 of the dispatch-quality plan
 * (docs/plans/dispatch-quality-gate-and-mind-clone-injection.md).
 *
 * Reads the artifact + each declared mind-clone's SOUL.md/AGENT.md from
 * the canonical library, runs the deterministic precheck, and prints
 * either:
 *   - a "FAIL — short-circuit" verdict if density < 30 (DNA likely unused)
 *   - the LLM grading pack on stdout for the maestro to feed to its grader
 *     agent (see harness/rubrics/mind-clone-voice-fidelity.md)
 *   - or, when --grader-result <path> is provided, parse the agent's JSON
 *     output and emit gate_passed/gate_failed via audit.
 *
 * Examples:
 *   nrv gate voice-fidelity sales-page.md --slugs alex-hormozi,david-ogilvy
 *   nrv gate voice-fidelity sales-page.md --slugs alex-hormozi --json
 *   nrv gate voice-fidelity sales-page.md --slugs alex-hormozi --grader-result /tmp/grader.json --trace-id <uuid>
 */

import * as fs from "node:fs";
import * as path from "node:path";

const {
  buildVoiceFidelityPack,
  emitVoiceFidelityGate,
} = await import("../lib/dispatch.ts");

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.findIndex(a => a === `--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const artifactPath = process.argv.slice(2).find(a => !a.startsWith("--") && a !== "voice-fidelity");
const slugsCsv = arg("slugs");
const traceId = arg("trace-id") || arg("trace");
const projectId = arg("project");
const businessSlug = arg("business");
const graderResult = arg("grader-result");
const threshold = arg("threshold") ? Number(arg("threshold")) : undefined;
const kind = arg("kind") || "doc";
const jsonOut = flag("json");

if (!artifactPath || !slugsCsv) {
  console.error(`usage: nrv gate voice-fidelity <artifact_path> --slugs alex-hormozi,david-ogilvy [--threshold 70] [--kind copy] [--trace-id <uuid> --grader-result <path>] [--json]`);
  process.exit(2);
}

let artifact = "";
try { artifact = fs.readFileSync(path.resolve(artifactPath), "utf8"); }
catch (e: any) { console.error(`cannot read artifact: ${e.message}`); process.exit(2); }

const slugs = slugsCsv.split(",").map(s => s.trim()).filter(Boolean);
const pack = buildVoiceFidelityPack({ artifact, artifact_kind: kind, slugs, threshold });
if (!pack) {
  console.error(`no resolvable mind-clones for slugs: ${slugs.join(", ")}`);
  process.exit(2);
}

// MODE 1 — grader already ran, emit the gate event.
if (graderResult) {
  if (!traceId) {
    console.error(`--grader-result requires --trace-id <uuid>`);
    process.exit(2);
  }
  let result: any;
  try { result = JSON.parse(fs.readFileSync(graderResult, "utf8")); }
  catch (e: any) { console.error(`cannot parse grader-result: ${e.message}`); process.exit(2); }
  // Sanity-check structure
  if (typeof result.overall_score !== "number" || !["pass", "fail"].includes(result.verdict)) {
    console.error(`grader-result missing required fields (overall_score, verdict). Got:`, Object.keys(result));
    process.exit(2);
  }
  emitVoiceFidelityGate({
    trace_id: traceId,
    project_id: projectId,
    business_slug: businessSlug,
    result,
    threshold: pack.threshold,
  });
  console.log(`✓ ${result.verdict.toUpperCase()} · score=${result.overall_score} · ${slugs.length} clone(s) · gate event emitted`);
  process.exit(result.verdict === "pass" ? 0 : 1);
}

// MODE 2 — short-circuit when marker density is BELOW the realistic floor.
// Calibration note: a SOUL.md+AGENT.md typically yields 60-150 distinct
// markers. A high-fidelity artifact naturally uses 5-15 of them — so 5%
// of all markers is the floor that signals "the canon was touched at all".
// Anything lower is the W3 incident class: the artifact ignores the DNA.
const SHORTCIRCUIT_FLOOR = Number(process.env.NIRVANA_VOICE_FIDELITY_FLOOR) || 5;
if (pack.deterministic_signals.overall_marker_density < SHORTCIRCUIT_FLOOR) {
  const out = {
    verdict: "fail",
    overall_score: pack.deterministic_signals.overall_marker_density,
    short_circuit: `marker_density_below_${SHORTCIRCUIT_FLOOR}`,
    summary: `Deterministic precheck found only ${pack.deterministic_signals.total_markers_found}/${pack.deterministic_signals.total_markers_searched} canon markers in the artifact (${pack.deterministic_signals.overall_marker_density}%). The artifact does not channel the declared mind-clone(s) at all — likely the W3 incident class (DNA was declared but never actually used). LLM grader skipped to save tokens.`,
    per_clone_density: pack.deterministic_signals.markers_found_per_clone,
  };
  if (traceId) emitVoiceFidelityGate({
    trace_id: traceId, project_id: projectId, business_slug: businessSlug,
    threshold: pack.threshold,
    result: {
      overall_score: out.overall_score, verdict: "fail",
      per_clone: slugs.map(s => ({ slug: s, score: pack.deterministic_signals.markers_found_per_clone[s] || 0, voice_match: 0, framework_use: 0, vocabulary_match: 0, evidence: [] })),
      summary: out.summary,
      fix_list: ["Re-run dispatch with injectMindClones() and verify the agent's system prompt actually contains the SOUL.md content (not just the name)."],
    },
  });
  if (jsonOut) console.log(JSON.stringify(out, null, 2));
  else console.log(`✗ FAIL (short-circuit) · density=${pack.deterministic_signals.overall_marker_density}%\n  ${out.summary}`);
  process.exit(1);
}

// MODE 3 — emit the grading pack so the maestro feeds it to a Haiku Agent.
if (jsonOut) {
  console.log(JSON.stringify(pack, null, 2));
} else {
  console.log(`Grading pack ready · ${pack.mind_clones.length} clone(s) · density=${pack.deterministic_signals.overall_marker_density}%`);
  console.log(`\nFeed this JSON to a Haiku Agent with the rubric at:\n  ${pack.rubric_path}\n`);
  console.log(`Use --json to dump the pack to stdout, or pipe the agent's output back via --grader-result <file> --trace-id <uuid> to emit the gate event.`);
}
process.exit(0);
