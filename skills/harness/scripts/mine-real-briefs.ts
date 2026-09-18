#!/usr/bin/env bun
// mine-real-briefs.ts — build a routing eval corpus out of work that already ran.
//
// The golden corpus is generated from each entity's own `example_briefs`, which
// is the text BM25 indexes. It measures the index against itself: every repair
// scored 1.000 on it, so it can neither show an improvement nor catch a
// regression. Replacing it is the highest-value routing work available, and the
// blocker was always thought to be the price of labels — the agentic router
// costs about $1.47 and 67s per route, so labelling a few hundred briefs by
// re-routing them would cost a few hundred dollars of someone's subscription.
//
// It does not have to. The labels were already bought. Every dispatch this
// engine ever ran wrote what it decided into the audit: `dispatch_business`,
// `dispatch_squad`, `target_plan_committed`. And a brief that was dispatched,
// executed and then PASSED THE GATE is a stronger label than a fresh routing
// opinion — it is what actually delivered, not what something guessed.
//
// So this mines, and costs nothing: no LLM, no network, no dispatch.
//
//   nrv mine-briefs                      # report what is minable
//   nrv mine-briefs --write              # write the corpus
//   nrv mine-briefs --write --all        # include runs that did not pass the gate
//
// The corpus is PRIVATE. It is real client work, and it lands beside
// golden-routing.json, which .gitignore already excludes for the same reason.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(`--${f}`);
if (has("help") || argv.includes("-h")) {
  console.error("Usage: nrv mine-briefs [--write] [--all] [--out <file>] [--min-chars <n>]");
  console.error("");
  console.error("  Builds a routing eval corpus from dispatches that already ran.");
  console.error("  No LLM, no network, no dispatch: the labels were bought when the work ran.");
  console.error("");
  console.error("  --write            write the corpus (default: report only)");
  console.error("  --all              include runs that did not pass the gate");
  console.error("  --out <file>       where to write (default: baselines/real-briefs.json)");
  console.error("  --min-chars <n>    shortest brief to keep (default 25)");
  process.exit(0);
}
const val = (f: string, d: string) => { const i = argv.indexOf(`--${f}`); return i >= 0 ? argv[i + 1] : d; };
const MIN_CHARS = Number(val("min-chars", "25"));
const OUT = path.resolve(val("out", path.join(import.meta.dir, "..", "baselines", "real-briefs.json")));

/** Every audit file this machine wrote, from both roots and every project. */
function auditFiles(): string[] {
  const roots = [
    harnessLogsDir({}),
    path.join(os.homedir(), ".harness-logs"),
    path.join(os.homedir(), "orca", "projects"),
  ];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name === "audit.jsonl") out.push(full);
    }
  };
  for (const r of roots) walk(r, 0);
  return [...new Set(out)];
}

const traceOf = (e: any): string | null =>
  e.subject || e.trace_id || e.project_id || e.data?.trace_id || e.data?.project_id || null;
const eventOf = (e: any): string => String(e.type || e.event || "").split(".").pop() ?? "";

type Target = { kind: "business" | "squad"; slug: string };

const briefs = new Map<string, string>();
const targets = new Map<string, Target>();
const passed = new Set<string>();

for (const f of auditFiles()) {
  let text: string;
  try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const t = eventOf(e), k = traceOf(e), d = e.data ?? e;
    if (!k) continue;
    if (t === "brief_received") {
      // `brief_excerpt` is what the event carries; the whole brief is never in
      // the log. An excerpt is the honest input anyway — a router sees the
      // user's own words, and real ones are short.
      const b = d.brief_excerpt ?? d.brief;
      if (typeof b === "string" && b.trim().length >= MIN_CHARS && !briefs.has(k)) briefs.set(k, b.trim());
    } else if (t === "dispatch_business" && d.business_slug) {
      targets.set(k, { kind: "business", slug: String(d.business_slug) });
    } else if (t === "dispatch_squad" && (d.squad_slug || d.squad)) {
      targets.set(k, { kind: "squad", slug: String(d.squad_slug ?? d.squad) });
    } else if (t === "target_plan_committed" && d.target && !targets.has(k)) {
      const raw = String(d.target);
      const m = /^(business|squad):(.+)$/.exec(raw);
      if (m) targets.set(k, { kind: m[1] as Target["kind"], slug: m[2] });
      else if (raw !== "agent-x") targets.set(k, { kind: "squad", slug: raw });
    } else if (t === "gate_passed") {
      passed.add(k);
    }
  }
}

// A brief file on disk recovers what the excerpt truncated; the trace is in the path.
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const walkBriefs = (dir: string, depth: number) => {
  if (depth > 8) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walkBriefs(full, depth + 1); continue; }
    if (e.name !== "brief.md") continue;
    const m = UUID.exec(full);
    if (!m || briefs.has(m[1])) continue;
    try {
      const body = fs.readFileSync(full, "utf8").trim();
      if (body.length >= MIN_CHARS) briefs.set(m[1], body.slice(0, 600));
    } catch { /* unreadable is not a reason to stop */ }
  }
};
walkBriefs(path.join(os.homedir(), "orca", "projects"), 0);

// Only targets that still exist: the library moves, and a case pointing at an
// entity nobody has is a permanent false negative rather than a measurement.
function liveSlugs(): { businesses: Set<string>; squads: Set<string> } {
  const read = (p: string, key: string) => {
    try { return new Set(Object.keys(JSON.parse(fs.readFileSync(p, "utf8"))[key] ?? {})); }
    catch { return new Set<string>(); }
  };
  return {
    businesses: read(path.join(os.homedir(), ".businesses-registry.json"), "businesses"),
    squads: read(path.join(os.homedir(), ".squads-registry.json"), "squads"),
  };
}
const live = liveSlugs();

const seen = new Set<string>();
const cases: Array<{ kind: string; slug: string; brief: string; trace: string; gate_passed: boolean; language: string }> = [];
let droppedUnknown = 0, droppedDuplicate = 0, droppedNoGate = 0;

for (const [trace, brief] of briefs) {
  const target = targets.get(trace);
  if (!target) continue;
  const known = target.kind === "business" ? live.businesses.has(target.slug) : live.squads.has(target.slug);
  if (!known) { droppedUnknown++; continue; }
  if (!has("all") && !passed.has(trace)) { droppedNoGate++; continue; }
  // Near-duplicate briefs inflate a rate without adding evidence.
  const fingerprint = `${target.slug}::${brief.toLowerCase().replace(/\s+/g, " ").slice(0, 120)}`;
  if (seen.has(fingerprint)) { droppedDuplicate++; continue; }
  seen.add(fingerprint);
  cases.push({
    kind: target.kind === "business" ? "business" : "squad",
    slug: target.slug,
    brief,
    trace,
    gate_passed: passed.has(trace),
    language: /[ãõçáéíóúâêô]/i.test(brief) ? "pt" : "en",
  });
}

const byKind = cases.reduce<Record<string, number>>((a, c) => ({ ...a, [c.kind]: (a[c.kind] ?? 0) + 1 }), {});
const byLang = cases.reduce<Record<string, number>>((a, c) => ({ ...a, [c.language]: (a[c.language] ?? 0) + 1 }), {});
console.log(`audit files scanned ....... ${auditFiles().length}`);
console.log(`briefs recovered .......... ${briefs.size}`);
console.log(`traces with a named target  ${targets.size}`);
console.log(`CASES ..................... ${cases.length}`);
console.log(`  by kind ................. ${JSON.stringify(byKind)}`);
console.log(`  by language ............. ${JSON.stringify(byLang)}`);
console.log(`  distinct targets ........ ${new Set(cases.map((c) => c.slug)).size}`);
console.log(`dropped: ${droppedUnknown} target no longer installed · ${droppedNoGate} never passed the gate · ${droppedDuplicate} near-duplicate`);

if (!has("write")) {
  console.log(`\n(report only — pass --write to save to ${OUT.replace(os.homedir(), "~")})`);
  process.exit(0);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ recorded_at: new Date().toISOString(), source: "audit", cases }, null, 1) + "\n");
console.log(`\nwritten → ${OUT.replace(os.homedir(), "~")}`);
console.log("This corpus is real client work. It is gitignored, like golden-routing.json.");
