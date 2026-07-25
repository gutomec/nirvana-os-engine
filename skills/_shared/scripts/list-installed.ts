#!/usr/bin/env bun
/**
 * list-installed.ts — `nrv installed`
 *
 * Replays ~/.nirvana-installed.jsonl and prints current state of every install.
 */

import { InstallManifest, type AssetKind } from "../lib/install-manifest.ts";
import { resolveScope } from "../lib/scope.ts";

interface CliArgs {
  active_only: boolean;
  kind: AssetKind | null;
  scope: "global" | "project" | null;
  json: boolean;
  history: string | null;  // name to show full history for
  projectRoot: string | undefined;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    active_only: true,
    kind: null,
    scope: null,
    json: false,
    history: null,
    // explicitMode:"merge" avoids the project-mode throw and still returns the
    // walked-up projectRoot, so --scope=project filters to THIS project's installs.
    projectRoot: resolveScope({ explicitMode: "merge" }).projectRoot ?? undefined,
    help: false,
  };
  for (const a of argv) {
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--all") out.active_only = false;
    else if (a === "--json") out.json = true;
    else if (a.startsWith("--kind=")) out.kind = a.split("=")[1] as AssetKind;
    else if (a.startsWith("--scope=")) out.scope = a.split("=")[1] as "global" | "project";
    else if (a.startsWith("--history=")) out.history = a.split("=")[1];
    else if (a.startsWith("--project-root=")) out.projectRoot = a.split("=")[1];
  }
  return out;
}

function help(): void {
  console.log(`nrv installed — list installed assets (replay of ~/.nirvana-installed.jsonl)

USAGE
  nrv installed [options]

OPTIONS
  --all                  include uninstalled / replaced entries
  --kind=business|squad|mind-clone|pack
  --scope=global|project
  --project-root=<path>  filter project installs to this root (default: walked-up root)
  --history=<name>       print full event history for <name>
  --json                 emit JSON

OUTPUT
  status   kind          name                      version    scope    path
`);
}

function fmtCell(s: string, width: number): string {
  if (s.length <= width) return s.padEnd(width);
  return s.slice(0, Math.max(0, width - 1)) + "…";
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { help(); process.exit(0); }
  const manifest = new InstallManifest();
  if (args.history) {
    const all = manifest.list({ active_only: false, projectRoot: args.projectRoot }).filter((x) => x.name === args.history);
    if (all.length === 0) {
      console.error(`no events for '${args.history}'`);
      process.exit(1);
    }
    for (const item of all) {
      for (const ev of item.history) {
        console.log(`${ev.ts}  ${ev.action.padEnd(9)}  ${ev.kind.padEnd(11)}  ${ev.name}@${ev.version}  ${ev.path}`);
      }
    }
    return;
  }
  const items = manifest.list({
    active_only: args.active_only,
    kind: args.kind ?? undefined,
    scope: args.scope ?? undefined,
    projectRoot: args.projectRoot,
  });
  if (args.json) {
    process.stdout.write(JSON.stringify(items, null, 2) + "\n");
    return;
  }
  if (items.length === 0) {
    console.log(`No installations recorded${args.active_only ? " (active)" : ""}.`);
    return;
  }
  console.log(`status      kind         name                          version    scope    path`);
  console.log(`----------  -----------  ----------------------------  ---------  -------  -----`);
  for (const it of items) {
    console.log(
      `${fmtCell(it.status, 10)}  ${fmtCell(it.kind, 11)}  ${fmtCell(it.name, 28)}  ${fmtCell(it.version, 9)}  ${fmtCell(it.scope, 7)}  ${it.path}`,
    );
  }
}

if (import.meta.main) main();
