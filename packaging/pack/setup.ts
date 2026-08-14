#!/usr/bin/env bun
/**
 * Content pack bootstrap (generic — same for every paid pack).
 *
 *   bun setup.ts
 *
 * 1. Ensures the Nirvana-OS engine is installed/updated (downloads the release
 *    tarball with Bun — no Node.js required).
 * 2. Overlays this pack's content (starter-pack/) onto the engine via
 *    nrv install-content.
 * 3. Soft license check (heartbeat; never blocks).
 *
 * The pack carries NO engine — only content. Re-running is safe (idempotent).
 */
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

// Roda um subprocesso com a saida ANINHADA sob o passo atual.
//
// Sem isto o instalador do engine imprime a numeracao DELE ("[1/4] Copying
// skills tree...") por dentro do passo [1/4] deste script, e as duas escalas se
// misturam: quem le ve "[2/4] Installing shared deps" e acha que o pack ja
// passou para o passo 2. A barra a esquerda diz, sem precisar de texto, "isto e
// detalhe do passo acima".
//
// Efeito colateral desejado: com a saida em pipe, os subprocessos deixam de ver
// um TTY e trocam spinners com \r por linhas simples — o log fica legivel
// tambem quando redirecionado para arquivo.
function runNested(cmd: string, args: string[], cwd?: string): Promise<{ status: number | null; error?: Error }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"], env: process.env, cwd });
    const relay = (from: NodeJS.ReadableStream | null, to: NodeJS.WriteStream) => {
      let buf = "";
      from?.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) to.write(`\x1b[2m  │\x1b[0m ${l}\n`);
      });
      from?.on("end", () => { if (buf) to.write(`\x1b[2m  │\x1b[0m ${buf}\n`); });
    };
    relay(child.stdout, process.stdout);
    relay(child.stderr, process.stderr);
    child.on("error", (error) => resolve({ status: null, error }));
    child.on("close", (status) => resolve({ status }));
  });
}
const okNested = async (cmd: string, args: string[], cwd?: string): Promise<boolean> =>
  (await runNested(cmd, args, cwd)).status === 0;

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
//    Instala/atualiza o engine SEM depender de Node.
//
//    Este script ja esta rodando em Bun, e o Bun sabe fazer tudo que o
//    instalador precisa: `fetch` do release, `tar` para extrair, e rodar o
//    install.ts. O `npx @nirvana-os/cli` era so um intermediario — e um
//    intermediario caro, porque arrastava Node.js como segunda dependencia.
//
//    A tentativa de trocar por `bunx` falhou e vale registrar por que: o binario
//    do pacote publicado tem shebang `#!/usr/bin/env node`, entao o bunx baixa o
//    pacote e morre com 127 (`env: node: No such file or directory`). Medido com
//    um Bun recem-instalado num HOME sem Node. Baixar o tarball direto contorna
//    o problema inteiro: nao ha binario de terceiro para executar.
//
//    `tar` existe em Windows 10+, macOS e Linux. Os paths passados sao
//    RELATIVOS de proposito: um path absoluto do Windows (C:\...) tem ":" e o
//    GNU tar do Git Bash o trata como host remoto.
//
//    npx fica como ultimo recurso, para o caso de a rede bloquear o GitHub mas
//    liberar o registro do npm.
const ENGINE_URL =
  process.env.NIRVANA_ENGINE_URL ??
  `https://github.com/${process.env.NIRVANA_ENGINE_REPO ?? "gutomec/nirvana-os-engine"}/releases/latest/download/nirvana-os-engine.tar.gz`;

// Remove o diretorio de trabalho e CONFIRMA que sumiu. Um rmSync que "nao
// lancou" nao prova remocao: no Windows um antivirus segurando um handle faz o
// unlink falhar silenciosamente, e no macOS um arquivo sem permissao de escrita
// sobrevive. Por isso o laco verifica com existsSync a cada tentativa e so
// devolve o controle quando o diretorio realmente nao esta mais la.
//
// Nunca lanca: limpeza que derruba a instalacao seria pior que o lixo que ela
// deixaria. Se as tentativas se esgotarem, o usuario e avisado do path exato.
function removeWorkDir(dir: string): void {
  // Devolve permissao de escrita na arvore. Medido: um diretorio sem +w faz o
  // rmSync falhar com EACCES nas tres tentativas — ele nao tenta o chmod sozinho
  // em POSIX. Sem este passo o laco so repete o mesmo erro.
  const grantWrite = (p: string): void => {
    try {
      const st = statSync(p);
      chmodSync(p, st.mode | 0o200);
      if (st.isDirectory()) for (const e of readdirSync(p)) grantWrite(join(p, e));
    } catch { /* best-effort */ }
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* verifica abaixo */ }
    if (!existsSync(dir)) return;
    grantWrite(dir);
  }
  console.log(`    ⚠ Could not remove the temp dir: ${dir}`);
  console.log(`      Nada quebrou — apague quando puder.`);
}

// Varre sobras de instalacoes anteriores. As versoes ate 0.1.73 nao limpavam, e
// cada execucao deixava ~14 MB em /tmp. Só toca no que tem mais de uma hora,
// para nunca puxar o tapete de uma instalacao rodando em paralelo.
function sweepStaleWorkDirs(): void {
  const cutoff = Date.now() - 3600_000;
  try {
    for (const e of readdirSync(tmpdir(), { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith("nrv-engine-")) continue;
      const abs = join(tmpdir(), e.name);
      try { if (statSync(abs).mtimeMs < cutoff) rmSync(abs, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  } catch { /* tmpdir ilegivel: segue */ }
}

async function installEngineWithBun(): Promise<boolean> {
  let work: string | null = null;
  sweepStaleWorkDirs();
  try {
    const local = process.env.NIRVANA_ENGINE_TARBALL;
    let tarball: string;
    work = mkdtempSync(join(tmpdir(), "nrv-engine-"));
    if (local && existsSync(local)) {
      tarball = join(work, "engine.tar.gz");
      writeFileSync(tarball, readFileSync(local));
    } else {
      const res = await fetch(ENGINE_URL, { redirect: "follow" });
      if (!res.ok) {
        console.error(`    ✗ Download do engine falhou (HTTP ${res.status}).`);
        return false;
      }
      tarball = join(work, "engine.tar.gz");
      writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
    }
    const out = join(work, "src");
    mkdirSync(out, { recursive: true });
    if (!(await okNested("tar", ["-xzf", "engine.tar.gz", "-C", "src"], work))) {
      console.error("    ✗ Nao consegui extrair o engine (precisa do 'tar').");
      return false;
    }
    // O asset extrai plano (scripts/ na raiz); um archive de source vem
    // embrulhado num diretorio unico. Aceita os dois.
    let root = out;
    if (!existsSync(join(root, "scripts", "install.ts"))) {
      const entries = readdirSync(out);
      if (entries.length === 1 && existsSync(join(out, entries[0], "scripts", "install.ts"))) root = join(out, entries[0]);
    }
    const installer = join(root, "scripts", "install.ts");
    if (!existsSync(installer)) {
      console.error("    ✗ Asset do engine invalido (sem scripts/install.ts).");
      return false;
    }
    return await okNested("bun", [installer, "--no-starter"]);
  } catch (e) {
    console.error(`    ✗ Falha ao instalar o engine: ${(e as Error).message}`);
    return false;
  } finally {
    if (work) removeWorkDir(work);
  }
}

const runEngineInstaller = async (): Promise<boolean> => {
  if (localCli) return okNested("node", [localCli]);
  if (await installEngineWithBun()) return true;
  console.log("    Tentando pelo npm (npx)...");
  return okNested("npx", ["-y", "@nirvana-os/cli"]);
};

if (!enginePresent) {
  console.log("[1/4] Engine not found — installing from GitHub...");
  if (!(await runEngineInstaller()) || !existsSync(join(SKILLS, "harness"))) {
    console.error("    ✗ Não consegui instalar o engine do Nirvana-OS.");
    console.error("      Verifique a conexão com a internet e rode este setup de novo.");
    console.error(`      O engine vem de:  ${ENGINE_URL}`);
    console.error("      Atrás de proxy/firewall? Baixe o .tar.gz e aponte:  NIRVANA_ENGINE_TARBALL=/caminho/engine.tar.gz bun setup.ts");
    process.exit(1);
  }
} else if (skipUpdate) {
  console.log(`[1/4] Engine ${installedVer ?? "present"} — update skipped (NIRVANA_SKIP_ENGINE_UPDATE=1).`);
} else {
  console.log(`[1/4] Atualizando o engine${installedVer ? ` (atual: ${installedVer})` : ""}...`);
  const updated = await runEngineInstaller();
  const nowVer = installedEngineVersion();
  if (updated) {
    console.log(`    ✓ Engine at ${nowVer ?? "unknown version"}.`);
  } else if (stale || unknownVer) {
    // Não dá para seguir: o install-content abaixo tem o gate de versão e
    // abortaria de qualquer jeito. Falhar aqui, com o motivo certo, é melhor
    // que falhar depois com um erro que parece ser do conteúdo.
    console.error(`    ✗ Falha ao atualizar o engine, e o atual (${installedVer ?? "desconhecido"}) é mais antigo que o exigido por este pack (>=${requiresEngine}).`);
    console.error(`      Atualize manualmente e rode de novo:  npx @nirvana-os/cli`);
    process.exit(1);
  } else {
    // Engine já satisfaz o pack: a falha de rede não impede a instalação.
    console.log(`    ⚠ Could not update right now (network?). Carrying on with engine ${installedVer ?? "as installed"}, which already serves this pack.`);
  }
}

// 2. Overlay content — surface the REAL error if it fails (sem isso o cliente fica cego).
console.log(`[2/4] Installing pack '${slug}' content (businesses, squads and mind-clones)...`);
if (!existsSync(CONTENT)) {
  console.error(`    ✗ Pasta de conteúdo não encontrada: ${CONTENT}`);
  console.error(`      O zip deve ser descompactado INTEIRO (a pasta 'starter-pack/' fica ao lado deste setup.ts).`);
  process.exit(1);
}
const icArgs = [
  join(SKILLS, "_shared", "scripts", "install-content.ts"),
  CONTENT, "--slug", slug, ...(packVersion ? ["--version", packVersion] : []),
];
const ic = await runNested("bun", icArgs);
if (ic.status !== 0) {
  console.error(`\n    ✗ Falha ao instalar o conteúdo (exit ${ic.status ?? "?"}).`);
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
console.log(`[3/4] Building the routing indexes...`);
const idx = await runNested("bun", [join(SKILLS, "harness", "scripts", "index.ts")]);
if (idx.status !== 0) {
  console.log(`    ⚠ Index not built (exit ${idx.status ?? "?"}). The content is installed; run 'nrv index' when you can — routing gets sharper with it.`);
}

// Carimba a edição com o NOME DO PACK que o comprador instalou, para que
// `nrv -v` mostre o produto pago (ex.: "Nirvana-OS Genesis Circle") em vez do
// rótulo do motor grátis. O EDITION do engine é neutro ("Nirvana-OS"); aqui ele
// passa a refletir a compra. Best-effort — nunca bloqueia a instalação.
try {
  const pretty = slug.split(/[-_]/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
  writeFileSync(join(SKILLS, "EDITION"), `Nirvana-OS ${pretty}\n`);
} catch { /* best-effort */ }

// 3. Instala a licença, DEPOIS verifica.
//
// Este passo faltava. O instalador lia o PROVENANCE.json só para descobrir a
// versão do pack (linha ~51) e nunca o copiava para ~/.nirvana-license/ — que é
// o único lugar onde `nrv update <slug>` sabe procurar, fora do diretório atual.
// O comprador terminava o setup com "✓ Pack instalado", ia atualizar dias depois
// de qualquer outra pasta, e ouvia que não tinha licença nenhuma.
//
// Falhar aqui não pode ser silencioso: o pack funciona sem a licença instalada,
// o que quebra é só o update autenticado, e é agora que dá para dizer isso.
console.log("[4/4] Installing and checking the license (soft)...");
const provSrc = join(HERE, "PROVENANCE.json");
if (existsSync(provSrc)) {
  const licDir = join(HOME, ".nirvana-license");
  try {
    mkdirSync(licDir, { recursive: true });
    copyFileSync(provSrc, join(licDir, "PROVENANCE.json"));
    const licNotice = join(HERE, "LICENSE.txt");
    if (existsSync(licNotice)) copyFileSync(licNotice, join(licDir, "LICENSE.txt"));
  } catch (e) {
    console.log(`    \x1b[31m✗ could not install the license at ${licDir}: ${(e as Error).message}\x1b[0m`);
    console.log(`    \x1b[2mThe pack works. What will not work is 'nrv update ${slug}'.\x1b[0m`);
    console.log(`    \x1b[2mOnce the permission is sorted, run: nrv license install "${HERE}"\x1b[0m`);
  }
} else {
  // Cópia sem procedência roda igual; o que ela não tem é update autenticado.
  console.log(`    \x1b[2m(no PROVENANCE.json in this folder — the pack runs, but 'nrv update ${slug}' will find no license)\x1b[0m`);
}
await okNested("bun", [join(SKILLS, "_shared", "scripts", "license.ts"), "check"]);

console.log(`\n\x1b[1;32m✓ Pack '${slug}' installed.\x1b[0m\n`);
