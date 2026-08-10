#!/usr/bin/env node
/**
 * @nirvana-os/cli — Nirvana-OS installer (thin launcher).
 *
 *   npx @nirvana-os/cli
 *
 * This package carries NO engine bytes. At run time it downloads the latest
 * engine from GitHub (the most recent release asset) and installs it across
 * every detected runtime — Claude Code, Codex, Gemini-CLI, Antigravity — plus
 * an optional Hermes bridge. The paid packs (squads, businesses, mind-clones)
 * install on top, gated by purchase, via squads.sh.
 *
 * Because the engine is fetched from GitHub, you ship engine updates by cutting
 * a new GitHub release — this npm package is published once and (almost) never
 * republished. npx runs on Node; the engine runs on Bun, so this bootstrap also
 * ensures Bun is present.
 *
 * Overrides (testing / air-gapped / forks):
 *   NIRVANA_ENGINE_TARBALL=/path/to/engine.tar.gz   use a local tarball, no network
 *   NIRVANA_ENGINE_URL=https://.../engine.tar.gz     full URL override
 *   NIRVANA_ENGINE_REPO=owner/repo                    default: gutomec/nirvana-os-engine
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";

const IS_WIN = process.platform === "win32";
const REPO = process.env.NIRVANA_ENGINE_REPO || "gutomec/nirvana-os-engine";
const ENGINE_URL =
  process.env.NIRVANA_ENGINE_URL ||
  `https://github.com/${REPO}/releases/latest/download/nirvana-os-engine.tar.gz`;
const LOCAL_TARBALL = process.env.NIRVANA_ENGINE_TARBALL || "";

function findBun() {
  const probe = spawnSync(IS_WIN ? "where" : "which", ["bun"], { stdio: "ignore" });
  if (probe.status === 0) return "bun";
  const local = join(homedir(), ".bun", "bin", IS_WIN ? "bun.exe" : "bun");
  return existsSync(local) ? local : null;
}

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) =>
    rl.question(question + " [Y/n] ", (a) => {
      rl.close();
      const s = a.trim().toLowerCase();
      res(s === "" || s === "y" || s === "yes" || s === "s" || s === "sim");
    }),
  );
}

async function ensureBun() {
  let bun = findBun();
  if (bun) return bun;
  console.log("\nNirvana-OS roda em Bun, que não foi encontrado.");
  // Auto-install the LATEST Bun. On a TTY we confirm (default Yes); piped/CI we proceed.
  const ok = process.stdin.isTTY ? await ask("Instalar o Bun (última versão) agora?") : true;
  if (!ok) {
    console.log(
      IS_WIN
        ? '\nInstale o Bun e rode de novo:\n  powershell -c "irm bun.sh/install.ps1 | iex"\n'
        : "\nInstale o Bun e rode de novo:\n  curl -fsSL https://bun.sh/install | bash\n",
    );
    process.exit(1);
  }
  console.log("Instalando o Bun (última versão)...");
  // Windows: PowerShell installer (no bash/curl on a clean Windows). POSIX: curl|bash.
  const installed = IS_WIN
    ? spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm bun.sh/install.ps1 | iex"], { stdio: "inherit" })
    : spawnSync("bash", ["-c", "curl -fsSL https://bun.sh/install | bash"], { stdio: "inherit" });
  if (installed.status !== 0) {
    console.log("\nFalha ao instalar o Bun. Instale manualmente: https://bun.sh");
    process.exit(1);
  }
  // findBun() probes ~/.bun/bin/bun(.exe) by ABSOLUTE path — the bun installer just
  // wrote it there and persisted PATH for new shells. We resolve it directly and
  // CONTINUE this same run, so the user never has to restart the terminal.
  bun = findBun();
  if (!bun) {
    console.log("\nBun instalado, mas não localizei o binário. Abra um novo terminal e rode: npx @nirvana-os/cli\n");
    process.exit(1);
  }
  console.log("Bun pronto. Continuando a instalação...\n");
  return bun;
}

async function fetchEngineTarball() {
  if (LOCAL_TARBALL) {
    const p = LOCAL_TARBALL.replace(/^file:\/\//, "");
    if (!existsSync(p)) {
      console.error(`NIRVANA_ENGINE_TARBALL não encontrado: ${p}`);
      process.exit(1);
    }
    console.log(`Usando engine local: ${p}`);
    return p;
  }
  console.log(`Baixando o engine mais recente: ${ENGINE_URL}`);
  let res;
  try {
    res = await fetch(ENGINE_URL, { redirect: "follow" });
  } catch (e) {
    console.error(`Falha de rede ao baixar o engine: ${e.message}`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Falha ao baixar o engine (HTTP ${res.status}).`);
    if (res.status === 404) console.error("Nenhum release publicado ainda em " + REPO + " — corte um release com o asset nirvana-os-engine.tar.gz.");
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const f = join(mkdtempSync(join(tmpdir(), "nrv-engine-")), "engine.tar.gz");
  writeFileSync(f, buf);
  return f;
}

function extract(tarball) {
  const dir = mkdtempSync(join(tmpdir(), "nrv-src-"));
  // cwd + paths RELATIVOS com "/": um path absoluto do Windows (C:\...) tem ":"
  // e o GNU tar do Git Bash o trata como host remoto ("tenta conectar no C:").
  // Relativo não tem ":" e funciona em GNU tar e bsdtar, em qualquer OS.
  const cwd = dirname(tarball);
  const rel = (p) => {
    const r = relative(cwd, p);
    return (r === "" ? "." : r.includes(":") ? p : r).split(sep).join("/");
  };
  const r = spawnSync("tar", ["-xzf", rel(tarball), "-C", rel(dir)], { stdio: "inherit", cwd });
  if (r.status !== 0) {
    console.error("Falha ao extrair o engine (precisa do 'tar' — Win10+, macOS, Linux têm).");
    process.exit(1);
  }
  // Release asset extracts flat (scripts/ at root). A GitHub source archive
  // wraps everything in a single top dir — handle both.
  const entries = readdirSync(dir);
  if (existsSync(join(dir, "scripts", "install.ts"))) return dir;
  if (entries.length === 1 && existsSync(join(dir, entries[0], "scripts", "install.ts"))) return join(dir, entries[0]);
  return dir;
}

(async () => {
  console.log("Nirvana-OS — instalador (engine vem do GitHub; conteúdo pago via squads.sh).");
  const bun = await ensureBun();
  const tarball = await fetchEngineTarball();
  const root = extract(tarball);
  const installer = join(root, "scripts", "install.ts");
  if (!existsSync(installer)) {
    console.error(`Instalador não encontrado em ${installer} — asset do engine inválido.`);
    process.exit(1);
  }
  const r = spawnSync(bun, [installer, "--no-starter", ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
})();
