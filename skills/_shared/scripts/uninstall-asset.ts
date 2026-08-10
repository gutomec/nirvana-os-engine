#!/usr/bin/env bun
/**
 * uninstall-asset.ts — `nrv uninstall <name> [flags]`
 *
 * Uses ~/.nirvana-installed.jsonl to identify what was installed under this
 * name, removes the directories, appends 'uninstall' events, and re-indexes.
 *
 * Refuses if multiple installs match (different kinds) — caller passes --kind.
 */

import { uninstall, type UninstallOptions } from "../lib/installer.ts";
import type { AssetKind } from "../lib/install-manifest.ts";

interface CliArgs extends UninstallOptions {
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    name: "",
    scope: "global",
    dryRun: false,
    quiet: false,
    json: false,
    help: false,
  };
  for (const a of argv) {
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--json") out.json = true;
    else if (a === "--skip-reindex") out.skipReindex = true;
    else if (a.startsWith("--kind=")) out.kind = a.split("=")[1] as AssetKind;
    else if (a.startsWith("--scope=")) out.scope = a.split("=")[1] as UninstallOptions["scope"];
    else if (a.startsWith("--reason=")) out.reason = a.split("=")[1];
    else if (!a.startsWith("-")) out.name = a;
  }
  return out;
}

function help(): void {
  console.log(`nrv uninstall — remove an installed asset (uses manifest to know what to remove)

USAGE
  nrv uninstall <name> [options]

OPTIONS
  --kind=business|squad|mind-clone|pack
                                  disambiguate when same name across kinds
  --scope=global|project          default 'global'
  --dry-run                       show what would be removed
  --skip-reindex                  skip nrv index after uninstall
  --reason="..."                  recorded in the manifest event
  --quiet
  --json

NOTES
  - For packs, removes ALL items installed with the pack (linked by pack_install_id).
  - Backups created by previous --force installs are NOT touched (you can restore manually).
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.name) {
    help();
    process.exit(args.help ? 0 : 2);
  }
  try {
    const result = await uninstall(args);
    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else if (result.ok) {
      const dr = result.dry_run ? " [DRY-RUN]" : "";
      console.log(`${dr} ✓ uninstalled '${args.name}' (${result.removed_paths.length} path${result.removed_paths.length === 1 ? "" : "s"})`);
      for (const p of result.removed_paths) console.log(`   - ${p}`);
    } else {
      console.error("✗ uninstall failed");
      for (const e of result.errors) console.error(`  ${e}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`uninstall: ${(e as Error).message}`);
    process.exit(1);
  }
}

if (import.meta.main) void main();
