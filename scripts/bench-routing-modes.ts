#!/usr/bin/env bun
// bench-routing-modes.ts — route the same briefs with more than one routing
// mode and compare what each one chose, how long it took and what it cost.
//
// It calls the routers the dispatch calls (lib/agentic-router.ts and
// lib/cards-router.ts) and stops there: nothing is dispatched and no work runs.
// Calls go ONE AT A TIME, brief by brief and mode by mode, so no two routing
// calls compete for the same runtime and the seconds are comparable.
//
// The library routed against is whatever the current scope resolves: run it
// from a directory outside any project to measure the machine's library, or
// inside a project to measure that project's. Point HARNESS_LOGS_DIR somewhere
// disposable if the routers' audit events should not land in the real log.
//
// Usage:
//   bun scripts/bench-routing-modes.ts --briefs <dir|file.json> [--runtime claude-code]
//        [--modes agentic,cards] [--out results.json]
//
//   --briefs  a directory (each *.md / *.txt file is one brief, named by its
//             file) or a JSON array of {"id": "...", "brief": "..."}.
//   --out     also write every decision as JSON.
import * as fs from "node:fs";
import * as path from "node:path";
import { agenticRoute, type AgenticRouteDecision } from "../skills/harness/lib/agentic-router.ts";
import { cardsRoute } from "../skills/harness/lib/cards-router.ts";
import { listRuntimes, type Runtime } from "../skills/_shared/lib/host-agent-driver.ts";
import { canonicalRuntimeName } from "../skills/harness/lib/runtime-rules.ts";

type Mode = "agentic" | "cards";
const MODES: Mode[] = ["agentic", "cards"];

function flag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function loadBriefs(source: string): { id: string; brief: string }[] {
  if (fs.statSync(source).isDirectory()) {
    return fs.readdirSync(source)
      .filter((f) => /\.(md|txt)$/i.test(f))
      .sort()
      .map((f) => ({ id: f.replace(/\.(md|txt)$/i, ""), brief: fs.readFileSync(path.join(source, f), "utf8").trim() }));
  }
  const list = JSON.parse(fs.readFileSync(source, "utf8"));
  if (!Array.isArray(list)) throw new Error(`${source}: expected a JSON array of {id, brief}`);
  return list.map((x: any, i: number) => ({ id: String(x.id ?? i + 1), brief: String(x.brief ?? "").trim() }));
}

/** What the decision sends the dispatch to, in the cards' id grammar. */
export function targetOf(d: AgenticRouteDecision): string {
  if (!d.ok) return `failed (${(d.error || "unknown").slice(0, 60)})`;
  if (d.kind === "no_match") return "solo";
  if (d.kind === "ambiguous") return `ambiguous: ${d.candidates.map((c) => `${c.type}:${c.target}`).join(", ")}`;
  if (d.primary_business) return `business:${d.primary_business}`;
  return d.mandatory_squads.length ? `squad:${d.mandatory_squads[0]}` : "solo";
}

/** The squads riding along with the target (never the target itself). */
export function squadsOf(d: AgenticRouteDecision): string[] {
  const all = [...d.mandatory_squads, ...d.optional_squads];
  return d.primary_business ? all : all.slice(1);
}

if (import.meta.main) {
  const source = flag("briefs");
  if (!source) {
    console.error("usage: bun scripts/bench-routing-modes.ts --briefs <dir|file.json> [--runtime claude-code] [--modes agentic,cards] [--out results.json]");
    process.exit(2);
  }
  const runtime = canonicalRuntimeName(flag("runtime") ?? "claude-code") as Runtime;
  if (!listRuntimes().some((r) => r.name === runtime)) {
    console.error(`unknown runtime '${runtime}'; one of: ${listRuntimes().map((r) => r.name).join(", ")}`);
    process.exit(2);
  }
  const modes = (flag("modes") ?? MODES.join(",")).split(",").map((m) => m.trim()).filter(Boolean) as Mode[];
  const unknown = modes.filter((m) => !MODES.includes(m));
  if (unknown.length) { console.error(`unknown mode(s): ${unknown.join(", ")}; one of: ${MODES.join(", ")}`); process.exit(2); }

  const briefs = loadBriefs(source);
  const rows: Record<string, any>[] = [];
  for (const { id, brief } of briefs) {
    for (const mode of modes) {
      console.error(`[bench] ${id} · ${mode} · ${runtime} …`);
      const args = { brief, runtime, cwd: process.cwd() };
      const d = mode === "cards" ? await cardsRoute(args) : await agenticRoute(args);
      const row = {
        brief: id, mode, runtime,
        seconds: Math.round(d.duration_ms / 100) / 10,
        target: targetOf(d),
        squads: squadsOf(d),
        clones: d.suggested_mind_clones,
        cost_usd: d.cost_usd,
        ...("done" in d ? { done: (d as any).done, dropped: (d as any).dropped, attempts: (d as any).attempts } : {}),
        rationale: d.rationale,
        warnings: d.warnings,
      };
      rows.push(row);
      console.log(`| ${id} | ${mode} | ${row.seconds}s | ${row.target} | ${row.squads.join(", ") || "—"} | ${row.clones.join(", ") || "—"} | ${row.cost_usd == null ? "n/a" : `$${row.cost_usd.toFixed(4)}`} |`);
    }
  }

  if (modes.length > 1) {
    let agree = 0;
    for (const { id } of briefs) {
      const targets = new Set(rows.filter((r) => r.brief === id).map((r) => r.target));
      if (targets.size === 1) agree++;
    }
    console.log(`\nsame target in every mode: ${agree}/${briefs.length}`);
    for (const mode of modes) {
      const mine = rows.filter((r) => r.mode === mode);
      const secs = mine.map((r) => r.seconds).sort((a, b) => a - b);
      const median = secs.length ? secs[Math.floor((secs.length - 1) / 2)] : 0;
      const costs = mine.map((r) => r.cost_usd).filter((c): c is number => typeof c === "number");
      console.log(`${mode}: median ${median}s · total ${Math.round(secs.reduce((a, b) => a + b, 0))}s · cost ${costs.length ? `$${costs.reduce((a, b) => a + b, 0).toFixed(4)}` : "n/a"}`);
    }
  }

  const out = flag("out");
  if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 2) + "\n", "utf8");
}
