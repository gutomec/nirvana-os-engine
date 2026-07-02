#!/usr/bin/env bun
/**
 * install-asset.ts — `nrv install <source> [flags]` entry point.
 *
 * Auto-detects business / squad / mind-clone / pack, validates, atomic move,
 * reindex, register in ~/.nirvana-installed.jsonl.
 *
 * See skills/_shared/lib/installer.ts for the core lib.
 */

import { install, type InstallOptions } from "../lib/installer.ts";

interface CliArgs extends InstallOptions {
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    source: "",
    type: "auto",
    scope: "global",
    force: false,
    dryRun: false,
    quiet: false,
    json: false,
    help: false,
  };
  for (const a of argv) {
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--force") out.force = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--json") out.json = true;
    else if (a === "--skip-reindex") out.skipReindex = true;
    else if (a === "--skip-validate") out.skipValidate = true;
    else if (a.startsWith("--type=")) out.type = a.split("=")[1] as InstallOptions["type"];
    else if (a.startsWith("--scope=")) out.scope = a.split("=")[1] as InstallOptions["scope"];
    else if (a.startsWith("--project-root=")) out.projectRoot = a.split("=")[1];
    else if (!a.startsWith("-")) out.source = a;
  }
  return out;
}

function help(): void {
  console.log(`nrv install — install a business, squad, mind-clone, or pack

USAGE
  nrv install <source> [options]

SOURCES
  <local-dir>                     directory containing business.yaml / squad.yaml / MANIFEST.yaml / pack.yaml
  <local-tarball>.tar(.gz|.bz2)   extracted into a temp dir first
  https://...../archive.tar.gz    downloaded then extracted
  git+https://github.com/u/r      git clone --depth=1, then installed
  git@github.com:u/r.git          same, via SSH

OPTIONS
  --type=business|squad|mind-clone|pack|auto
                                  default 'auto' (detected from manifest files)
  --scope=global|project          default 'global' (~ paths). 'project' writes to .nirvana/
  --project-root=PATH             override cwd for --scope=project
  --force                         replace existing install (auto-backs up to <path>.<version>.bak.<ts>/)
  --dry-run                       show what would happen, do not write
  --skip-reindex                  skip nrv index call (faster batch installs)
  --skip-validate                 skip light validation (NOT recommended)
  --quiet                         suppress stderr progress
  --json                          emit JSON result on stdout

EXAMPLES
  nrv install ~/Downloads/my-business
  nrv install ./packs/marketing-pack.tar.gz
  nrv install git+https://github.com/me/my-squad
  nrv install ~/dna/leadership --type=mind-clone
  nrv install ~/business-creator --scope=project
  nrv install ./brandcraft --force            # replace and back up the old version
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.source) {
    help();
    process.exit(args.help ? 0 : 2);
  }

  try {
    const result = await install(args);
    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else if (result.ok) {
      const dr = result.dry_run ? " [DRY-RUN]" : "";
      console.log(`${dr} ✓ installed ${result.kind}: ${result.name}@${result.version}`);
      console.log(`   path:     ${result.path}`);
      console.log(`   checksum: ${result.checksum}`);
      if (result.prev_version) console.log(`   replaced: ${result.prev_version} → ${result.version}`);
      if (result.backup_path) console.log(`   backup:   ${result.backup_path}`);
      if (result.items && result.items.length > 0) {
        console.log(`   items (${result.items.length}):`);
        for (const it of result.items) console.log(`     - ${it.kind} · ${it.name} → ${it.path}`);
      }
      if (result.warnings.length > 0) {
        console.log(`   warnings:`);
        for (const w of result.warnings) console.log(`     ! ${w}`);
      }
    } else {
      console.error("✗ install failed");
      for (const e of result.errors) console.error(`  ${e}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`install: ${(e as Error).message}`);
    process.exit(1);
  }
}

if (import.meta.main) void main();
