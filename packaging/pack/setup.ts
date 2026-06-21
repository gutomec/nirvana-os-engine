#!/usr/bin/env bun
/**
 * Content pack bootstrap (generic — same for every paid pack).
 *
 *   bun setup.ts
 *
 * 1. Ensures the Nirvana-OS engine is installed (npx @nirvana-os/cli if missing).
 * 2. Overlays this pack's content (starter-pack/) onto the engine via
 *    nrv install-content.
 * 3. Soft license check (heartbeat; never blocks).
 *
 * The pack carries NO engine — only content. Re-running is safe (idempotent).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const SKILLS = join(HOME, ".nirvana", "skills");
const CONTENT = join(HERE, "starter-pack");

let slug = "pack";
try { const m = readFileSync(join(HERE, "pack.yaml"), "utf8").match(/^slug:\s*(\S+)/m); if (m) slug = m[1]; } catch { /* default */ }

// Versão do pack (do PROVENANCE injetado por-comprador) → grava no manifesto p/
// o `nrv update --check` comparar depois. Ausente em cópias sem procedência.
let packVersion: string | null = null;
try { packVersion = JSON.parse(readFileSync(join(HERE, "PROVENANCE.json"), "utf8")).version ?? null; } catch { /* sem provenance */ }

const ok = (cmd: string, args: string[], env?: NodeJS.ProcessEnv): boolean =>
  spawnSync(cmd, args, { stdio: "inherit", env: env ?? process.env }).status === 0;

console.log(`\n\x1b[1mNirvana-OS — pack '${slug}'\x1b[0m\n`);

// 1. Ensure engine.
if (!existsSync(join(SKILLS, "harness"))) {
  console.log("[1/3] Engine não encontrado — instalando o engine free do GitHub...");
  // Test/offline override: point NIRVANA_CLI_LOCAL at a local launcher (cli.mjs),
  // optionally with NIRVANA_ENGINE_TARBALL. Otherwise use the published npm CLI.
  const localCli = process.env.NIRVANA_CLI_LOCAL;
  const installed = localCli ? ok("node", [localCli]) : ok("npx", ["-y", "@nirvana-os/cli"]);
  if (!installed || !existsSync(join(SKILLS, "harness"))) {
    console.error("    ✗ Falha ao instalar o engine. Rode antes:  npx @nirvana-os/cli");
    process.exit(1);
  }
} else {
  console.log("[1/3] Engine já instalado.");
}

// 2. Overlay content.
console.log(`[2/3] Instalando o conteúdo do pack '${slug}'...`);
if (!ok("bun", [join(SKILLS, "_shared", "scripts", "install-content.ts"), CONTENT, "--slug", slug, ...(packVersion ? ["--version", packVersion] : [])])) {
  console.error("    ✗ Falha ao instalar o conteúdo.");
  process.exit(1);
}

// 3. Soft license check.
console.log("[3/3] Verificando a licença (soft)...");
ok("bun", [join(SKILLS, "_shared", "scripts", "license.ts"), "check"]);

console.log(`\n\x1b[1;32m✓ Pack '${slug}' instalado.\x1b[0m\n`);
