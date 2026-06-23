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
let requiresEngine: string | null = null; // min engine version, e.g. "0.1.21"
try {
  const y = readFileSync(join(HERE, "pack.yaml"), "utf8");
  const ms = y.match(/^slug:\s*(\S+)/m); if (ms) slug = ms[1];
  const mr = y.match(/^requires_engine:\s*["']?>=?\s*([0-9][^"'\s]*)/m); if (mr) requiresEngine = mr[1];
} catch { /* default */ }

// Numeric semver compare (x.y.z; pre-release suffixes ignored). a<b → -1, a==b → 0, a>b → 1.
function cmpVer(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
function installedEngineVersion(): string | null {
  try { return readFileSync(join(SKILLS, "VERSION"), "utf8").trim() || null; } catch { return null; }
}

// Versão do pack (do PROVENANCE injetado por-comprador) → grava no manifesto p/
// o `nrv update --check` comparar depois. Ausente em cópias sem procedência.
let packVersion: string | null = null;
try { packVersion = JSON.parse(readFileSync(join(HERE, "PROVENANCE.json"), "utf8")).version ?? null; } catch { /* sem provenance */ }

const ok = (cmd: string, args: string[], env?: NodeJS.ProcessEnv): boolean =>
  spawnSync(cmd, args, { stdio: "inherit", env: env ?? process.env }).status === 0;

console.log(`\n\x1b[1mNirvana-OS — pack '${slug}'\x1b[0m\n`);

// 1. Ensure engine — present AND new enough (requires_engine). An engine that
//    exists but is older than the pack needs is upgraded, not skipped: the npx
//    launcher fetches the latest release and overwrites the skills tree.
const enginePresent = existsSync(join(SKILLS, "harness"));
const installedVer = installedEngineVersion();
const stale = enginePresent && requiresEngine != null && installedVer != null && cmpVer(installedVer, requiresEngine) < 0;
const unknownVer = enginePresent && requiresEngine != null && installedVer == null; // can't prove it's new enough

if (!enginePresent || stale || unknownVer) {
  const why = !enginePresent
    ? "não encontrado"
    : `desatualizado (${installedVer ?? "versão desconhecida"} < requer ${requiresEngine})`;
  console.log(`[1/3] Engine ${why} — instalando/atualizando o engine do GitHub...`);
  // Test/offline override: point NIRVANA_CLI_LOCAL at a local launcher (cli.mjs),
  // optionally with NIRVANA_ENGINE_TARBALL. Otherwise use the published npm CLI.
  const localCli = process.env.NIRVANA_CLI_LOCAL;
  const installed = localCli ? ok("node", [localCli]) : ok("npx", ["-y", "@nirvana-os/cli"]);
  const nowVer = installedEngineVersion();
  const okVer = !requiresEngine || (nowVer != null && cmpVer(nowVer, requiresEngine) >= 0);
  if (!installed || !existsSync(join(SKILLS, "harness")) || !okVer) {
    console.error(`    ✗ Falha ao instalar/atualizar o engine (requer >=${requiresEngine ?? "?"}, achei ${nowVer ?? "nenhum"}).`);
    console.error("      Rode antes:  npx @nirvana-os/cli");
    process.exit(1);
  }
} else {
  console.log(`[1/3] Engine já instalado${installedVer ? ` (${installedVer})` : ""}.`);
}

// 2. Overlay content — surface the REAL error if it fails (sem isso o cliente fica cego).
console.log(`[2/3] Instalando o conteúdo do pack '${slug}'...`);
if (!existsSync(CONTENT)) {
  console.error(`    ✗ Pasta de conteúdo não encontrada: ${CONTENT}`);
  console.error(`      O zip deve ser descompactado INTEIRO (a pasta 'starter-pack/' fica ao lado deste setup.ts).`);
  process.exit(1);
}
const icArgs = [
  join(SKILLS, "_shared", "scripts", "install-content.ts"),
  CONTENT, "--slug", slug, ...(packVersion ? ["--version", packVersion] : []),
];
const ic = spawnSync("bun", icArgs, { stdio: "inherit", env: process.env });
if (ic.status !== 0) {
  console.error(`\n    ✗ Falha ao instalar o conteúdo (exit ${ic.status ?? "?"}${ic.signal ? `, signal ${ic.signal}` : ""}).`);
  if (ic.error) {
    const e = ic.error as NodeJS.ErrnoException;
    console.error(`      processo: ${e.message}${e.code === "ENOENT" ? " — o comando 'bun' não está no PATH desta sessão" : ""}`);
  }
  console.error(`      contentDir: ${CONTENT}`);
  console.error(`      skills:     ${SKILLS}`);
  console.error(`      Windows/WSL: rode tudo DENTRO do WSL (bun do Linux, zip em ~/, não em /mnt/c).`);
  console.error(`      Para ver o erro completo, rode manualmente:`);
  console.error(`        bun ${icArgs.join(" ")}`);
  process.exit(1);
}

// 3. Soft license check.
console.log("[3/3] Verificando a licença (soft)...");
ok("bun", [join(SKILLS, "_shared", "scripts", "license.ts"), "check"]);

console.log(`\n\x1b[1;32m✓ Pack '${slug}' instalado.\x1b[0m\n`);
