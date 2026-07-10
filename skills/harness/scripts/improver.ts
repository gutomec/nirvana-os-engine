#!/usr/bin/env bun
/**
 * improver.ts — the `nrv improver` CLI.
 *
 * Phase 8 (meta-Nirvana). Mines audit logs, analyzes patterns, writes proposals,
 * persists them via ProposalStore, and lets the user review / apply.
 *
 * Subcommands:
 *   nrv improver run [--days=30] [--dry-run]
 *   nrv improver list [--status=pending|accepted|rejected|applied]
 *   nrv improver show <proposal_id>
 *   nrv improver accept <proposal_id> [--note=...]
 *   nrv improver reject <proposal_id> [--note=...]
 *   nrv improver applied <proposal_id> [--note=...]
 */

import { mine } from "../lib/audit-miner.ts";
import { analyzePatterns } from "../lib/pattern-analyzer.ts";
import { writeProposals } from "../lib/proposal-writer.ts";
import { ProposalStore, type ProposalStatus } from "../lib/proposal-store.ts";

function parseValueAfter(argv: string[], flag: string): string | null {
  const f = argv.find((a) => a.startsWith(`${flag}=`));
  if (f) return f.split("=")[1] ?? null;
  const i = argv.indexOf(flag);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return null;
}

async function cmdRun(argv: string[]): Promise<number> {
  // E5a — `run --help` não pode minerar nem persistir proposals: intercepta cedo.
  if (argv.includes("--help") || argv.includes("-h")) { help(); return 0; }
  const days = Number(parseValueAfter(argv, "--days") ?? 30) || 30;
  const dryRun = argv.includes("--dry-run");
  const store = new ProposalStore();

  process.stderr.write(`improver: mining last ${days}d…\n`);
  const report = await mine({ days, high_cost_z: 2 });
  process.stderr.write(`improver: analyzing ${report.total_traces} traces (businesses=${report.businesses.length}, squads=${report.squads.length})\n`);

  const patterns = analyzePatterns(report);
  process.stderr.write(`improver: ${patterns.length} pattern(s) detected\n`);

  const proposals = writeProposals(patterns);
  process.stderr.write(`improver: ${proposals.length} proposal(s) generated\n`);

  if (dryRun) {
    process.stdout.write(JSON.stringify({ dry_run: true, patterns, proposals }, null, 2) + "\n");
    return 0;
  }

  for (const p of proposals) store.add(p);
  process.stderr.write(`improver: persisted to ${store.rootPath()}\n`);
  for (const p of proposals) {
    console.log(`  [${p.severity.toUpperCase()}] ${p.id} · ${p.title}`);
  }
  return 0;
}

function cmdList(argv: string[]): number {
  const status = parseValueAfter(argv, "--status") as ProposalStatus | null;
  const store = new ProposalStore();
  const items = store.list(status ? { status: [status] } : undefined);
  if (items.length === 0) {
    console.log("No proposals.");
    return 0;
  }
  console.log(`status   sev    id                                 entity                                 title`);
  console.log(`-------  -----  ---------------------------------  -------------------------------------  -----------------------------`);
  for (const p of items) {
    const id = p.id.padEnd(33);
    const entity = `${p.entity_type}:${p.entity_id}`.slice(0, 37).padEnd(37);
    console.log(`${p.status.padEnd(7)}  ${p.severity.padEnd(5)}  ${id}  ${entity}  ${p.title}`);
  }
  return 0;
}

function cmdShow(argv: string[]): number {
  const id = argv[0];
  if (!id) { console.error("usage: nrv improver show <proposal_id>"); return 2; }
  const store = new ProposalStore();
  const p = store.get(id);
  if (!p) { console.error(`proposal not found: ${id}`); return 1; }
  console.log(`# ${p.title}`);
  console.log(`id: ${p.id}`);
  console.log(`status: ${p.status}`);
  console.log(`severity: ${p.severity}`);
  console.log(`entity: ${p.entity_type}:${p.entity_id}`);
  console.log(`generated_at: ${p.generated_at}`);
  console.log(``);
  console.log(`## Rationale`);
  console.log(p.rationale);
  console.log(``);
  console.log(`## Hypothesis`);
  console.log(p.hypothesis);
  console.log(``);
  console.log(`## Proposed change`);
  console.log(p.proposed_change);
  console.log(``);
  console.log(`## Expected metric delta`);
  console.log(p.expected_metric_delta);
  if (p.status_history.length > 1) {
    console.log(``);
    console.log(`## History`);
    for (const h of p.status_history) {
      console.log(`  ${h.ts} → ${h.status}${h.note ? ` (${h.note})` : ""}`);
    }
  }
  return 0;
}

function cmdSetStatus(argv: string[], status: ProposalStatus): number {
  const id = argv[0];
  if (!id) { console.error(`usage: nrv improver ${status} <proposal_id> [--note=...]`); return 2; }
  const note = parseValueAfter(argv, "--note") ?? undefined;
  const store = new ProposalStore();
  const p = store.get(id);
  if (!p) { console.error(`proposal not found: ${id}`); return 1; }
  store.setStatus(id, status, note);
  console.log(`${id} → ${status}${note ? ` (${note})` : ""}`);
  return 0;
}

function help(): number {
  console.log(`nrv improver — meta-Nirvana self-improvement loop

USAGE
  nrv improver run [--days=N] [--dry-run]
                              Mine audit, analyze, write proposals, persist
  nrv improver list [--status=pending|accepted|rejected|applied]
  nrv improver show <id>
  nrv improver accept <id> [--note=...]
  nrv improver reject <id> [--note=...]
  nrv improver applied <id> [--note=...]   Mark applied after you edit the codebase
`);
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const sub = argv[0] ?? "help";
  const rest = argv.slice(1);
  switch (sub) {
    case "run": return await cmdRun(rest);
    case "list": return cmdList(rest);
    case "show": return cmdShow(rest);
    case "accept": return cmdSetStatus(rest, "accepted");
    case "reject": return cmdSetStatus(rest, "rejected");
    case "applied": return cmdSetStatus(rest, "applied");
    case "help":
    case "-h":
    case "--help":
    case "":
      return help();
    default:
      console.error(`improver: unknown subcommand '${sub}'`);
      return 2;
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
