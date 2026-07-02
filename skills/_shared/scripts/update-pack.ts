#!/usr/bin/env bun
/**
 * update-pack.ts — atualiza um pack pago já instalado, autenticado pela
 * license_key do PROVENANCE (sem login). É o que `nrv update <slug>` chama.
 *
 *   nrv update <slug>            baixa a versão atual e re-aplica (overlay)
 *   nrv update <slug> --check    só compara a versão instalada com a do servidor
 *
 * Fluxo: PROVENANCE (license_key + versão) → POST /pack-update (signed URL) →
 * baixa o .zip carimbado → unzip → acha a pasta de conteúdo → install-content.
 * O uso offline nunca é bloqueado; isto só roda quando o comprador pede update.
 */
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, hostname, platform, arch, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";

const HOME = homedir();
const SKILLS = process.env.NIRVANA_SKILLS_DIR
  || (existsSync(join(HOME, ".nirvana", "skills")) ? join(HOME, ".nirvana", "skills") : join(HOME, ".claude", "skills"));
const PACKS_DIR = join(HOME, ".nirvana", "packs");
const PROV = process.env.NIRVANA_PROVENANCE
  || [join(HOME, ".nirvana-license", "PROVENANCE.json"), join(process.cwd(), "PROVENANCE.json")].find((p) => existsSync(p));
const VALIDATE_URL = process.env.NIRVANA_VALIDATE_URL || "https://squads.sh/api/nirvana/validate";
const PACK_UPDATE_URL = process.env.NIRVANA_PACK_UPDATE_URL || "https://squads.sh/api/nirvana/pack-update";

const RED = "\x1b[1;38;2;230;57;53m", DIM = "\x1b[2m", GRN = "\x1b[32m", YEL = "\x1b[33m", RST = "\x1b[0m";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const slugArg = args.find((a) => !a.startsWith("-")) || null;

function machineId(): string {
  return createHash("sha256").update(`${hostname()}|${platform()}|${arch()}|${HOME}`).digest("hex").slice(0, 32);
}

function readProvenance(): Record<string, string> | null {
  if (!PROV || !existsSync(PROV)) return null;
  try { return JSON.parse(readFileSync(PROV, "utf8")); } catch { return null; }
}

function installedVersion(slug: string): string | null {
  try { return JSON.parse(readFileSync(join(PACKS_DIR, `${slug}.json`), "utf8")).version ?? null; } catch { return null; }
}

// unzip robusto cross-platform (asset do pack é .zip, não .tar.gz): tenta unzip,
// depois tar (libarchive/Win10+ extrai zip), depois PowerShell Expand-Archive.
function extractZip(zip: string, dest: string): boolean {
  mkdirSync(dest, { recursive: true });
  // cwd + paths RELATIVOS com "/": um path absoluto do Windows (C:\...) tem ":"
  // e o GNU tar do Git Bash o trata como host remoto. Relativo funciona em
  // unzip, GNU tar e bsdtar, em qualquer OS.
  const cwd = dirname(zip);
  const rel = (p: string) => {
    const r = relative(cwd, p);
    return (r === "" ? "." : r.includes(":") ? p : r).split(sep).join("/");
  };
  const tries: [string, string[]][] = [
    ["unzip", ["-q", "-o", rel(zip), "-d", rel(dest)]],
    ["tar", ["-xf", rel(zip), "-C", rel(dest)]],
    ["powershell", ["-NoProfile", "-Command", `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${dest}'`]],
  ];
  for (const [cmd, a] of tries) {
    const r = spawnSync(cmd, a, { stdio: "ignore", cwd });
    if (r.status === 0) return true;
  }
  return false;
}

// Acha a pasta de conteúdo dentro do extraído: a que contém squads/ businesses/
// ou mind-clones/ (o starter-pack). Funciona tanto p/ bundle completo quanto
// p/ pack content-only.
function findContentRoot(root: string): string | null {
  const KINDS = ["squads", "businesses", "mind-clones"];
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const names = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
    if (KINDS.some((k) => names.has(k))) return dir;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") queue.push(join(dir, e.name));
  }
  return null;
}

async function main(): Promise<number> {
  const prov = readProvenance();
  if (!prov?.license_key) {
    console.log(`\n${YEL}Sem PROVENANCE com license_key — nada a atualizar.${RST}`);
    console.log(`${DIM}Packs pagos vêm com PROVENANCE; rode "bun setup.ts" da pasta do pack.${RST}\n`);
    return 1;
  }
  const slug = slugArg || prov.edition || "genesis-circle";
  const machine = machineId();
  const installed = installedVersion(slug);

  // --check: compara versão via /validate (não baixa).
  if (checkOnly) {
    try {
      const res = await fetch(VALIDATE_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ license_key: prov.license_key, machine_id: machine }),
      });
      const j: Record<string, unknown> = await res.json().catch(() => ({}));
      const remote = (j.version as string) || null;
      console.log(`\n${RED}Nirvana-OS — pack '${slug}'${RST}`);
      console.log(`  instalada: ${installed ?? "?"}   servidor: ${remote ?? "?"}   licença: ${j.status ?? "?"}`);
      if (remote && installed && remote !== installed) console.log(`  ${GRN}↑ update disponível — rode: nrv update ${slug}${RST}\n`);
      else if (remote && installed) console.log(`  ${DIM}já está atualizado.${RST}\n`);
      else console.log(`  ${DIM}(sem versão pra comparar — rode o update pra forçar).${RST}\n`);
    } catch (e) {
      console.log(`\n${YEL}Sem conexão para checar (${(e as Error).message}). Uso offline segue liberado.${RST}\n`);
    }
    return 0;
  }

  // update: pede a signed URL, baixa, extrai, overlay.
  console.log(`\n${RED}Nirvana-OS — atualizando pack '${slug}'${RST}`);
  let url: string, version: string | null;
  try {
    const res = await fetch(PACK_UPDATE_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: prov.license_key, machine_id: machine, pack: slug }),
    });
    const j: Record<string, unknown> = await res.json().catch(() => ({}));
    if (!res.ok || !j.url) {
      console.log(`  ${YEL}Não foi possível atualizar: ${(j.error as string) || `HTTP ${res.status}`}.${RST}`);
      if (j.error === "license_inactive") console.log(`  ${DIM}Sua licença não está ativa (estorno/revogação?). Contate o suporte.${RST}`);
      if (j.error === "seat_limit_reached") console.log(`  ${DIM}Limite de máquinas atingido (max_seats=${j.max_seats}).${RST}`);
      console.log(`  ${DIM}O uso offline NÃO é bloqueado.${RST}\n`);
      return 0; // soft
    }
    url = j.url as string; version = (j.version as string) || null;
  } catch (e) {
    console.log(`  ${YEL}Sem conexão para atualizar (${(e as Error).message}). Uso offline segue liberado.${RST}\n`);
    return 0;
  }

  const tmp = mkdtempSync(join(tmpdir(), "nrv-pack-"));
  const zipPath = join(tmp, "pack.zip");
  try {
    const dl = await fetch(url);
    if (!dl.ok) { console.log(`  ${YEL}Falha ao baixar o pack (HTTP ${dl.status}).${RST}\n`); return 1; }
    writeFileSync(zipPath, Buffer.from(await dl.arrayBuffer()));
  } catch (e) {
    console.log(`  ${YEL}Falha de rede no download: ${(e as Error).message}.${RST}\n`); return 1;
  }

  const xdir = join(tmp, "x");
  if (!extractZip(zipPath, xdir)) {
    console.log(`  ${RED}Falha ao extrair o .zip (precisa de unzip, tar ou PowerShell).${RST}\n`);
    rmSync(tmp, { recursive: true, force: true });
    return 1;
  }
  const content = findContentRoot(xdir);
  if (!content) {
    console.log(`  ${RED}Conteúdo (squads/businesses/mind-clones) não encontrado no pack baixado.${RST}\n`);
    rmSync(tmp, { recursive: true, force: true });
    return 1;
  }

  console.log(`  aplicando overlay (${version ?? "?"})...`);
  const ic = spawnSync(process.execPath, [
    join(SKILLS, "_shared", "scripts", "install-content.ts"),
    content, "--slug", slug, ...(version ? ["--version", version] : []),
  ], { stdio: "inherit" });
  rmSync(tmp, { recursive: true, force: true });
  if (ic.status !== 0) { console.log(`  ${RED}Overlay falhou.${RST}\n`); return 1; }
  console.log(`\n${GRN}✓ Pack '${slug}' atualizado${version ? ` para ${version}` : ""}.${RST}\n`);
  return 0;
}

process.exit(await main());
