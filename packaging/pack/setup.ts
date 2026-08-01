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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

// 1. Engine: instala se faltar, ATUALIZA se já existir.
//
//    `npx @nirvana-os/cli` sempre busca o tarball mais recente do GitHub e roda
//    o instalador, então instalar e atualizar são a mesma operação. O pack é
//    conteúdo curado e testado contra um engine; deixar o comprador com um
//    engine velho é entregar metade do produto e chamar de instalado.
//
//    Antes daqui havia uma contradição: com engine desatualizado, este passo
//    dizia "o conteúdo instala normalmente" e o install-content abortava logo
//    depois com exit 3. O comprador lia que ia funcionar e levava um erro. Agora
//    o engine é atualizado antes, e a falha (se houver) aparece UMA vez, aqui.
//
//    NIRVANA_SKIP_ENGINE_UPDATE=1 pula a atualização (útil em teste offline e
//    para quem fixou uma versão de propósito).
const enginePresent = existsSync(join(SKILLS, "harness"));
const installedVer = installedEngineVersion();
const stale = enginePresent && requiresEngine != null && installedVer != null && cmpVer(installedVer, requiresEngine) < 0;
const unknownVer = enginePresent && requiresEngine != null && installedVer == null;
const skipUpdate = process.env.NIRVANA_SKIP_ENGINE_UPDATE === "1";

// Test/offline override: NIRVANA_CLI_LOCAL aponta para um launcher local.
const localCli = process.env.NIRVANA_CLI_LOCAL;
const runEngineInstaller = (): boolean =>
  localCli ? ok("node", [localCli]) : ok("npx", ["-y", "@nirvana-os/cli"]);

if (!enginePresent) {
  console.log("[1/4] Engine não encontrado — instalando do GitHub...");
  if (!runEngineInstaller() || !existsSync(join(SKILLS, "harness"))) {
    console.error("    ✗ Não consegui instalar o engine do Nirvana-OS.");
    console.error("      Instale manualmente e rode este setup de novo:  npx @nirvana-os/cli");
    console.error("      Se faltar o Bun (NUNCA use 'npm -g', dá EACCES):  curl -fsSL https://bun.sh/install | bash");
    process.exit(1);
  }
} else if (skipUpdate) {
  console.log(`[1/4] Engine ${installedVer ?? "presente"} — atualização pulada (NIRVANA_SKIP_ENGINE_UPDATE=1).`);
} else {
  console.log(`[1/4] Atualizando o engine${installedVer ? ` (atual: ${installedVer})` : ""}...`);
  const updated = runEngineInstaller();
  const nowVer = installedEngineVersion();
  if (updated) {
    console.log(`    ✓ Engine em ${nowVer ?? "versão desconhecida"}.`);
  } else if (stale || unknownVer) {
    // Não dá para seguir: o install-content abaixo tem o gate de versão e
    // abortaria de qualquer jeito. Falhar aqui, com o motivo certo, é melhor
    // que falhar depois com um erro que parece ser do conteúdo.
    console.error(`    ✗ Falha ao atualizar o engine, e o atual (${installedVer ?? "desconhecido"}) é mais antigo que o exigido por este pack (>=${requiresEngine}).`);
    console.error(`      Atualize manualmente e rode de novo:  npx @nirvana-os/cli`);
    process.exit(1);
  } else {
    // Engine já satisfaz o pack: a falha de rede não impede a instalação.
    console.log(`    ⚠ Não consegui atualizar agora (rede?). Sigo com o engine ${installedVer ?? "atual"}, que já atende este pack.`);
  }
}

// 2. Overlay content — surface the REAL error if it fails (sem isso o cliente fica cego).
console.log(`[2/4] Instalando o conteúdo do pack '${slug}' (empresas, squads e mind-clones)...`);
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

// Constrói os índices de roteamento (squads + businesses + mind-clones) para que
// `nrv route`/`nrv auto` e o chat do Glance funcionem BEM já na 1ª execução. Sem
// isso os registries de businesses/squads não existem e o roteamento roda
// degradado (chuta pelo nome em vez de casar por capability). O indexador
// respeita o escopo: global no install do pack, project se rodado num projeto.
// Best-effort — nunca bloqueia a instalação.
console.log(`[3/4] Construindo os índices de roteamento...`);
const idx = spawnSync("bun", [join(SKILLS, "harness", "scripts", "index.ts")], { stdio: "inherit", env: process.env });
if (idx.status !== 0) {
  console.log(`    ⚠ Índice não construído (exit ${idx.status ?? "?"}). O conteúdo está instalado; rode 'nrv index' quando puder — o roteamento fica mais acertivo com ele.`);
}

// Carimba a edição com o NOME DO PACK que o comprador instalou, para que
// `nrv -v` mostre o produto pago (ex.: "Nirvana-OS Genesis Circle") em vez do
// rótulo do motor grátis. O EDITION do engine é neutro ("Nirvana-OS"); aqui ele
// passa a refletir a compra. Best-effort — nunca bloqueia a instalação.
try {
  const pretty = slug.split(/[-_]/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
  writeFileSync(join(SKILLS, "EDITION"), `Nirvana-OS ${pretty}\n`);
} catch { /* best-effort */ }

// 3. Soft license check.
console.log("[4/4] Verificando a licença (soft)...");
ok("bun", [join(SKILLS, "_shared", "scripts", "license.ts"), "check"]);

console.log(`\n\x1b[1;32m✓ Pack '${slug}' instalado.\x1b[0m\n`);
