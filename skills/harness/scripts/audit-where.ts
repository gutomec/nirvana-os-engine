#!/usr/bin/env bun
/**
 * audit-where.ts — which audit files a run wrote, and why those.
 *
 * A run writes to up to four places: the project's daily log, one per dispatched
 * target under its outputs tree, the global fallback, and — for handoff — the
 * project's own `audit.jsonl`. Answering "where did this run write?" meant
 * knowing `harnessLogsDir`'s three-rung precedence by heart and then guessing at
 * the rest, and a reader who checked only one file concluded a healthy run had
 * never dispatched. That happened, and it nearly got reported as fraud.
 *
 * This prints the resolution and the reason for it, plus every file that holds
 * events for the trace, with a provenance count per file.
 *
 * Usage:
 *   nrv audit where [--project <dir>] [--trace <id>] [--json]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { auditProvenanceSummary } from "../../_shared/lib/audit-provenance.js";

const argv = process.argv.slice(2);
const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const asJson = argv.includes("--json");
const projectDir = path.resolve(arg("--project") ?? process.cwd());
const trace = arg("--trace");

/** Why the resolver landed where it did — the part nobody could see. */
function why(): { root: string; reason: string } {
  if (process.env.HARNESS_LOGS_DIR) {
    return { root: path.resolve(process.env.HARNESS_LOGS_DIR), reason: "HARNESS_LOGS_DIR is set — an explicit override wins everywhere" };
  }
  const projectLog = path.join(projectDir, ".nirvana", "logs", "harness");
  if (fs.existsSync(path.join(projectDir, ".nirvana"))) {
    return { root: projectLog, reason: `inside a project (${projectDir} has .nirvana/) — the run logs with the project` };
  }
  return { root: path.join(os.homedir(), ".harness-logs"), reason: "no project context here — the global fallback" };
}

/** Every audit file under a root, however deep. Per-target logs live inside the
 *  outputs tree, which is why a flat listing of the log root misses them. */
function auditFilesUnder(root: string, cap = 400): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < cap) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (stack.length < 512) stack.push(full); }
      else if (e.name === "audit.jsonl") out.push(full);
    }
  }
  return out;
}

const resolution = why();
const candidates = [
  ...auditFilesUnder(resolution.root),
  ...auditFilesUnder(path.join(projectDir, "outputs")),
  path.join(projectDir, "audit.jsonl"),
  ...auditFilesUnder(path.join(os.homedir(), ".harness-logs")),
].filter((f, i, a) => fs.existsSync(f) && a.indexOf(f) === i);

const files = candidates.map(f => {
  const prov = auditProvenanceSummary(f);
  let matched = prov.total;
  if (trace) {
    matched = 0;
    try {
      for (const l of fs.readFileSync(f, "utf8").split("\n")) {
        if (l.includes(trace)) matched++;
      }
    } catch { matched = 0; }
  }
  return { file: f, events: prov.total, for_trace: matched, engine: prov.engine, unsigned: prov.unsigned, tampered: prov.tampered };
}).filter(r => !trace || r.for_trace > 0);

if (asJson) {
  console.log(JSON.stringify({ resolved_root: resolution.root, reason: resolution.reason, project_dir: projectDir, trace: trace ?? null, files }, null, 2));
} else {
  console.log(`resolved root: ${resolution.root}`);
  console.log(`  because:     ${resolution.reason}`);
  console.log(`  project:     ${projectDir}`);
  if (trace) console.log(`  trace:       ${trace}`);
  console.log("");
  if (!files.length) {
    console.log(trace ? "No audit file holds events for that trace." : "No audit files found.");
  } else {
    console.log("files holding events" + (trace ? " for this trace" : "") + ":");
    for (const f of files) {
      const prov = `engine=${f.engine} unsigned=${f.unsigned}${f.tampered ? ` TAMPERED=${f.tampered}` : ""}`;
      console.log(`  ${f.file}`);
      console.log(`      ${trace ? `${f.for_trace} of ` : ""}${f.events} event(s) · ${prov}`);
    }
    console.log("");
    console.log("`unsigned` on an old event means it predates stamping, not that it was forged.");
  }
}
