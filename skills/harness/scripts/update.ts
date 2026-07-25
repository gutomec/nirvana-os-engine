#!/usr/bin/env bun
// update.ts — self-update for Nirvana-OS deployment.
//
// Pulls latest from ~/nirvana-os git origin, then re-runs the install script
// to sync skills/ into ~/.nirvana/skills/ and bin/ into ~/.local/bin/.
//
// Usage:
//   nrv update                 # pull + reinstall (default)
//   nrv update --check         # show local vs remote diff without changing anything
//   nrv update --force         # discard local changes in ~/nirvana-os
//   nrv update --branch=main   # use a non-main branch
//   nrv update --skip-pull     # just re-run installer without git pull
//
// Safety:
//   - Backs up current ~/.nirvana/skills/ to ~/.nirvana/skills-backup-<ts>/
//     before applying anything (so a bad update can be reverted in 1 cp)
//   - Refuses to discard uncommitted changes unless --force
//   - Reports what changed (commits pulled + files changed)
//
// Exit codes:
//   0 = up to date or successfully updated
//   1 = update failed (network, uncommitted changes, etc.)
//   2 = invalid usage

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

const ANSI = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", lime: "\x1b[38;5;154m", magenta: "\x1b[35m",
};
const noColor = process.argv.includes("--no-color") || !process.stdout.isTTY;
function c(color: keyof typeof ANSI, s: string): string {
  return noColor ? s : `${ANSI[color]}${s}${ANSI.reset}`;
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const force = args.includes("--force");
const skipPull = args.includes("--skip-pull");
const branchArg = args.find(a => a.startsWith("--branch="));
const branch = branchArg ? branchArg.split("=")[1] : "main";

const HOME = os.homedir();
const SKILLS_ROOT = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(HOME, ".nirvana", "skills")) ? path.join(HOME, ".nirvana", "skills") : path.join(HOME, ".claude", "skills"));
const REPO = path.join(HOME, "nirvana-os");
const INSTALL_SCRIPT = path.join(REPO, "scripts/install.ts");

// Two update paths, auto-detected:
//   - DEV (a git checkout at ~/nirvana-os): git pull + reinstall (the path below).
//   - INSTALLED (no git checkout — e.g. installed via `npx @nirvana-os/cli`):
//     re-fetch the latest ENGINE release from GitHub and re-run its installer.
// Overrides for the release path: NIRVANA_ENGINE_REPO, NIRVANA_ENGINE_URL,
// NIRVANA_ENGINE_TARBALL (local tarball, no network — used by tests).
const ENGINE_REPO = process.env.NIRVANA_ENGINE_REPO || "gutomec/nirvana-os-engine";
const ENGINE_URL = process.env.NIRVANA_ENGINE_URL
  || `https://github.com/${ENGINE_REPO}/releases/latest/download/nirvana-os-engine.tar.gz`;
const ENGINE_TARBALL = (process.env.NIRVANA_ENGINE_TARBALL || "").replace(/^file:\/\//, "");

// Packs pagos instalados: depois de atualizar o engine (ou no --check), roda o
// --check de cada pack com PROVENANCE — o comprador vê engine E pack num só
// `nrv update`. Best-effort: rede fora ou sem PROVENANCE nunca quebra o update.
function checkInstalledPacks(): void {
  try {
    const prov = JSON.parse(fs.readFileSync(path.join(HOME, ".nirvana-license", "PROVENANCE.json"), "utf8"));
    if (!prov?.license_key) return;
    const slug = prov.edition || "genesis-circle";
    const script = path.join(SKILLS_ROOT, "_shared", "scripts", "update-pack.ts");
    if (!fs.existsSync(script)) return;
    console.log("");
    console.log(c("lime", "▶") + c("bold", ` Pack instalado ('${slug}') — checando update...`));
    spawnSync(process.execPath, [script, slug, "--check"], { stdio: "inherit" });
  } catch { /* sem PROVENANCE = sem pack pago; silencioso */ }
}

async function updateFromRelease(): Promise<never> {
  console.log("");
  console.log(c("lime", "▶") + c("bold", " Nirvana-OS update (engine release)"));
  if (checkOnly) {
    console.log(c("dim", `  source: ${ENGINE_TARBALL || ENGINE_URL}`));
    console.log(c("dim", "  --check: would fetch the latest engine release and re-run the installer."));
    checkInstalledPacks();
    process.exit(0);
  }
  let tarball = ENGINE_TARBALL;
  if (tarball) {
    if (!fs.existsSync(tarball)) { console.error(c("red", `tarball não encontrado: ${tarball}`)); process.exit(1); }
    console.log(c("dim", `  engine local: ${tarball}`));
  } else {
    console.log(c("dim", `  baixando: ${ENGINE_URL}`));
    let res: Response;
    try { res = await fetch(ENGINE_URL, { redirect: "follow" }); }
    catch (e) { console.error(c("red", `falha de rede ao baixar o engine: ${(e as Error).message}`)); process.exit(1); }
    if (!res.ok) {
      console.error(c("red", `falha ao baixar o engine (HTTP ${res.status}).`));
      if (res.status === 404) console.error(c("dim", `nenhum release público em ${ENGINE_REPO} (ou repo ainda privado).`));
      process.exit(1);
    }
    tarball = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-update-")), "engine.tar.gz");
    fs.writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  }
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-engine-src-"));
  // tar com cwd no dir do tarball e paths RELATIVOS com "/": um path absoluto do
  // Windows (C:\...) tem ":" e o GNU tar do Git Bash o trata como host remoto
  // ("tenta conectar no C:"). Relativo não tem ":" e funciona em GNU e bsdtar.
  const tarCwd = path.dirname(tarball);
  const rel = (p: string) => {
    const r = path.relative(tarCwd, p);
    return (r === "" ? "." : r.includes(":") ? p : r).split(path.sep).join("/");
  };
  const x = spawnSync("tar", ["-xzf", rel(tarball), "-C", rel(srcDir)], { stdio: "inherit", cwd: tarCwd });
  if (x.status !== 0) { console.error(c("red", "falha ao extrair o engine (precisa do 'tar').")); process.exit(1); }
  // Asset extracts flat (scripts/install.ts at root); a source archive wraps it
  // in a single top dir — handle both.
  let root = srcDir;
  if (!fs.existsSync(path.join(root, "scripts", "install.ts"))) {
    const entries = fs.readdirSync(srcDir);
    if (entries.length === 1 && fs.existsSync(path.join(srcDir, entries[0], "scripts", "install.ts"))) root = path.join(srcDir, entries[0]);
  }
  const installer = path.join(root, "scripts", "install.ts");
  if (!fs.existsSync(installer)) { console.error(c("red", "asset do engine inválido: scripts/install.ts não encontrado.")); process.exit(1); }
  console.log(c("lime", "▶") + c("bold", " Re-running installer (engine only)..."));
  const r = spawnSync(process.execPath, [installer, "--no-starter"], { stdio: "inherit" });
  if ((r.status ?? 1) === 0) checkInstalledPacks();
  process.exit(r.status ?? 1);
}

const isGitCheckout = fs.existsSync(REPO) && fs.existsSync(path.join(REPO, ".git"));
if (!isGitCheckout) {
  await updateFromRelease();
}

function git(...gitArgs: string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync("git", gitArgs, { cwd: REPO, encoding: "utf8" });
  return { stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), code: r.status ?? 1 };
}

// Step 1: report current state
console.log("");
console.log(c("lime", "▶") + c("bold", " Nirvana-OS update"));
console.log(c("dim", `  repo:   ${REPO}`));
console.log(c("dim", `  branch: ${branch}`));
console.log("");

const currentHead = git("rev-parse", "--short", "HEAD").stdout;
const currentRef = git("rev-parse", "--abbrev-ref", "HEAD").stdout;
console.log(c("dim", `  HEAD:   ${currentHead} (${currentRef})`));

// Detect uncommitted changes — REPORT only at this stage. We don't decide
// whether to block until we know (after fetch) if there's anything to pull.
// Blocking on uncommitted changes when there's nothing to pull is a false
// positive: re-running the installer from the current HEAD doesn't touch the
// working tree, so uncommitted files are irrelevant in that path.
const status = git("status", "--porcelain").stdout;
const dirtyFiles = status.split("\n").filter(l => l.trim()).length;
if (dirtyFiles > 0) {
  console.log(c("yellow", `  ⚠ ${dirtyFiles} uncommitted file(s) in ${REPO} (only blocks if a pull would touch them)`));
}

// Step 2: fetch + show diff
if (!skipPull) {
  console.log("");
  console.log(c("lime", "▶") + c("bold", " Fetching from origin..."));
  const fetch = git("fetch", "origin", branch);
  if (fetch.code !== 0) {
    console.error(c("red", "✗ git fetch failed:"));
    console.error(fetch.stderr);
    process.exit(1);
  }
  const ahead = git("rev-list", "--count", `HEAD..origin/${branch}`).stdout;
  const behind = git("rev-list", "--count", `origin/${branch}..HEAD`).stdout;

  if (ahead === "0") {
    // Nothing to pull. Uncommitted changes are irrelevant here — re-running
    // the installer from current HEAD doesn't touch the working tree.
    console.log(c("green", "  ✓ Already up to date with origin/" + branch));
    if (behind !== "0") {
      console.log(c("yellow", `  ⇩ ${behind} local commit(s) not yet on origin (push when ready)`));
    }
    if (checkOnly) {
      console.log("");
      console.log(c("dim", "  --check mode: nothing to pull. Skills can be re-applied with `nrv update`."));
      checkInstalledPacks();
      process.exit(0);
    }
    // Proceed straight to re-installing skills from current HEAD. This is the
    // common case: user runs `nrv update` to make sure the deployment reflects
    // the repo. Falls through to Step 3 (backup + reinstall) below.
    console.log("");
    console.log(c("dim", "  Nothing to pull — re-applying skills from current HEAD to your deployment."));
  } else {
    // There ARE commits to pull. NOW uncommitted changes matter, because a
    // pull could conflict with them.
    console.log(c("cyan", `  ⇧ ${ahead} commit(s) to pull from origin/${branch}:`));
    const log = git("log", `HEAD..origin/${branch}`, "--oneline", "--no-color").stdout;
    log.split("\n").forEach(l => console.log("    " + c("dim", l)));
    if (behind !== "0") {
      console.log(c("yellow", `  ⇩ ${behind} local commit(s) not on origin/${branch}`));
    }

    if (checkOnly) {
      console.log("");
      console.log(c("dim", "  --check mode: no changes applied. Run without --check to pull + reinstall."));
      checkInstalledPacks();
      process.exit(0);
    }

    // Block on uncommitted changes ONLY when a real pull is pending.
    if (dirtyFiles > 0 && !force) {
      console.log("");
      console.error(c("red", `Refusing to pull ${ahead} commit(s) over ${dirtyFiles} uncommitted file(s).`));
      console.error("Options:");
      console.error("  nrv update --force      (discards local changes — DESTRUCTIVE)");
      console.error("  cd ~/nirvana-os && git stash  (save your work, then re-run)");
      console.error("  cd ~/nirvana-os && git add -A && git commit  (keep your work)");
      process.exit(1);
    }

    // Pull
    console.log("");
    console.log(c("lime", "▶") + c("bold", " Pulling..."));
    const pullArgs = force
      ? ["reset", "--hard", `origin/${branch}`]
      : ["pull", "--ff-only", "origin", branch];
    const pull = git(...pullArgs);
    if (pull.code !== 0) {
      console.error(c("red", "✗ git pull failed:"));
      console.error(pull.stderr);
      console.error("");
      console.error("If you have local commits not on origin, try:");
      console.error("  cd ~/nirvana-os && git pull --rebase origin " + branch);
      process.exit(1);
    }
    console.log(c("green", "  ✓ Pulled. New HEAD: " + git("rev-parse", "--short", "HEAD").stdout));
  }
}

// Step 3: backup current deployment
console.log("");
const skillsDir = SKILLS_ROOT;
console.log(c("lime", "▶") + c("bold", ` Backing up ${skillsDir}/...`));
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backupDir = path.join(path.dirname(skillsDir), `skills-backup-${ts}`);
if (fs.existsSync(skillsDir)) {
  fs.cpSync(skillsDir, backupDir, { recursive: true });
  console.log(c("dim", `  → ${backupDir}`));
} else {
  console.log(c("yellow", "  no existing skills/ to backup (fresh install)"));
}

// Step 4: re-run installer
console.log("");
console.log(c("lime", "▶") + c("bold", " Re-running installer..."));
if (!fs.existsSync(INSTALL_SCRIPT)) {
  console.error(c("red", `ERRO: install script não encontrado: ${INSTALL_SCRIPT}`));
  console.error("");
  console.error(UPDATE_HELP);
  process.exit(1);
}

const installer = spawnSync("bun", [INSTALL_SCRIPT, "--no-starter"], {
  cwd: REPO,
  stdio: "inherit",
});
if (installer.status !== 0) {
  console.error(c("red", "✗ installer failed (exit code " + installer.status + ")"));
  console.error("");
  console.error(c("yellow", "Rollback your skills/:"));
  console.error(`  rm -rf ${skillsDir} && cp -r ${backupDir} ${skillsDir}`);
  process.exit(1);
}

// Step 5: re-index registries
console.log("");
console.log(c("lime", "▶") + c("bold", " Re-indexing registries..."));
const index = spawnSync("nrv", ["index"], { stdio: "inherit" });
if (index.status !== 0) {
  console.log(c("yellow", "  ⚠ nrv index failed (non-fatal). Run manually: `nrv index`"));
}

// Step 6: emit audit event
try {
  const today = new Date().toISOString().slice(0, 10);
  const auditDir = path.join(HOME, ".harness-logs", today);
  fs.mkdirSync(auditDir, { recursive: true });
  fs.appendFileSync(path.join(auditDir, "audit.jsonl"), JSON.stringify({
    ts: new Date().toISOString(),
    event: "nirvana_updated",
    from_head: currentHead,
    to_head: git("rev-parse", "--short", "HEAD").stdout,
    branch,
    force,
    skip_pull: skipPull,
    backup: backupDir,
  }) + "\n");
} catch {}

// Step 7: final report
console.log("");
console.log(c("green", "✓ Nirvana-OS updated."));
console.log("");
console.log(c("dim", "Next steps:"));
console.log("  " + c("yellow", "nrv doctor") + c("dim", "         # verify everything wired"));
console.log("  " + c("yellow", "nrv tui") + c("dim", "            # live cockpit"));
console.log("");
checkInstalledPacks();
console.log("");
console.log(c("dim", "If something broke, rollback:"));
console.log("  " + c("yellow", `rm -rf ${skillsDir} && mv ${backupDir} ${skillsDir}`));
console.log("");

process.exit(0);
