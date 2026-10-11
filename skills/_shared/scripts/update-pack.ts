#!/usr/bin/env bun
/**
 * update-pack.ts — updates an already-installed paid pack, authenticated by the
 * PROVENANCE's license_key (no login). It is what `nrv update <slug>` calls.
 *
 *   nrv update <slug>                 downloads the current version and re-applies (overlay)
 *   nrv update <slug> --keep-clones   …but leaves every mind-clone already on disk as it is
 *                                     (--keep-squads / --keep-businesses likewise)
 *   nrv update <slug> --check         only compares the installed version with the server's
 *
 * Components the buyer changed since the pack installed them are backed up
 * under ~/.nirvana/backups/packs/<slug>/<stamp>/ before the overlay writes
 * over them (install-content.ts); --keep-<kind> leaves them in place instead.
 *
 * Flow: PROVENANCE (license_key + version) → POST /pack-update (signed URL) →
 * download the stamped .zip → unzip → find the content folder → install-content.
 * Offline use is never blocked; this only runs when the buyer asks for an update.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, hostname, platform, arch, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { decideLicenseRefresh } from "../lib/license-refresh.ts";
import { findProvenance, legacyProvenancePath, packLicenseDir, provenanceCandidates } from "../lib/license-store.ts";

const HOME = homedir();
const SKILLS = process.env.NIRVANA_SKILLS_DIR
  || (existsSync(join(HOME, ".nirvana", "skills")) ? join(HOME, ".nirvana", "skills") : join(HOME, ".claude", "skills"));
const PACKS_DIR = join(HOME, ".nirvana", "packs");
const VALIDATE_URL = process.env.NIRVANA_VALIDATE_URL || "https://squads.sh/api/nirvana/validate";
const PACK_UPDATE_URL = process.env.NIRVANA_PACK_UPDATE_URL || "https://squads.sh/api/nirvana/pack-update";

const RED = "\x1b[1;38;2;230;57;53m", DIM = "\x1b[2m", GRN = "\x1b[32m", YEL = "\x1b[33m", RST = "\x1b[0m";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const slugArg = args.find((a) => !a.startsWith("-")) || null;
// The pack's own license first (~/.nirvana-license/packs/<slug>/), then the
// single legacy file, then the current folder (license-store.ts).
const PROV = process.env.NIRVANA_PROVENANCE || findProvenance(slugArg, { home: HOME, env: {} });

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

// Robust cross-platform unzip (the pack asset is .zip, not .tar.gz): tries unzip,
// then tar (libarchive/Win10+ extracts zip), then PowerShell Expand-Archive.
function extractZip(zip: string, dest: string): boolean {
  mkdirSync(dest, { recursive: true });
  // cwd + RELATIVE paths with "/": an absolute Windows path (C:\...) has ":"
  // and Git Bash's GNU tar treats it as a remote host. Relative works with
  // unzip, GNU tar and bsdtar, on any OS.
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
    const r = spawnSync(cmd, a, { windowsHide: true, stdio: "ignore", cwd });
    if (r.status === 0) return true;
  }
  return false;
}

// Finds the content folder inside the extracted tree: the one holding squads/
// businesses/ or mind-clones/ (the starter-pack). Works both for a full bundle
// and for a content-only pack.
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
    // Say WHERE we looked. The old message named neither path, so a buyer who
    // hit it had nothing to check and nothing to report: the same three causes
    // (setup.ts never run · run from a folder without PROVENANCE.json · run
    // under a different user, which on Windows means an elevated prompt with a
    // different profile) all produced one identical, undebuggable line.
    const found = PROV && existsSync(PROV);
    console.log(`\n${YEL}No PROVENANCE with a license_key — nothing to update.${RST}`);
    console.log(`${DIM}Searched in:${RST}`);
    for (const p of provenanceCandidates(slugArg, { home: HOME, env: {} })) console.log(`${DIM}  ${p}${RST}`);
    if (found) {
      console.log(`\n${YEL}Found ${PROV}, but with no license_key field.${RST}`);
      console.log(`${DIM}That file came from an unprovenanced copy. Use the zip you received with your purchase.${RST}\n`);
      return 1;
    }
    console.log(`\n${DIM}Paid packs ship PROVENANCE.json next to setup.ts. To install just the license:${RST}`);
    console.log(`${DIM}  nrv license install                      ${RST}${DIM}# searches Downloads, Desktop and the current folder${RST}`);
    console.log(`${DIM}  nrv license install <pack-folder>      ${RST}${DIM}# or point at it directly${RST}`);
    console.log(`${DIM}Reinstalling the whole pack (bun setup.ts) also works, but costs far more.${RST}`);
    console.log(`${DIM}If you already ran the setup, check it ran as the SAME user you are now`);
    console.log(`(a terminal run "as administrator" has a different profile, and the license lands in the profile that ran it).${RST}\n`);
    return 1;
  }
  const slug = slugArg || prov.edition || "genesis-circle";
  const machine = machineId();
  const installed = installedVersion(slug);

  // --check: compares versions via /validate (no download).
  if (checkOnly) {
    try {
      const res = await fetch(VALIDATE_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        // pack: with Genesis Circle (full access), the --check of ANOTHER pack
        // needs THAT pack's version, not the genesis one's.
        body: JSON.stringify({ license_key: prov.license_key, machine_id: machine, pack: slug }),
      });
      const j: Record<string, unknown> = await res.json().catch(() => ({}));
      const remote = (j.version as string) || null;
      console.log(`\n${RED}Nirvana-OS — pack '${slug}'${RST}`);
      console.log(`  installed: ${installed ?? "?"}   server: ${remote ?? "?"}   license: ${j.status ?? "?"}`);
      if (remote && installed && remote !== installed) console.log(`  ${GRN}↑ update available — run: nrv update ${slug}${RST}\n`);
      else if (remote && installed) console.log(`  ${DIM}already up to date.${RST}\n`);
      else console.log(`  ${DIM}(no version to compare — run the update to force it).${RST}\n`);
    } catch (e) {
      console.log(`\n${YEL}No connection to check (${(e as Error).message}). Offline use stays available.${RST}\n`);
    }
    return 0;
  }

  // update: requests the signed URL, downloads, extracts, overlays.
  console.log(`\n${RED}Nirvana-OS — updating pack '${slug}'${RST}`);
  let url: string, version: string | null;
  try {
    const res = await fetch(PACK_UPDATE_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: prov.license_key, machine_id: machine, pack: slug }),
    });
    const j: Record<string, unknown> = await res.json().catch(() => ({}));
    if (!res.ok || !j.url) {
      console.log(`  ${YEL}Could not update: ${(j.error as string) || `HTTP ${res.status}`}.${RST}`);
      if (j.error === "license_inactive") console.log(`  ${DIM}Your license is not active (refund/revocation?). Contact support.${RST}`);
      if (j.error === "seat_limit_reached") console.log(`  ${DIM}Machine limit reached (max_seats=${j.max_seats}).${RST}`);
      console.log(`  ${DIM}Offline use is NOT blocked.${RST}\n`);
      return 0; // soft
    }
    url = j.url as string; version = (j.version as string) || null;
  } catch (e) {
    console.log(`  ${YEL}No connection to update (${(e as Error).message}). Offline use stays available.${RST}\n`);
    return 0;
  }

  const tmp = mkdtempSync(join(tmpdir(), "nrv-pack-"));
  const zipPath = join(tmp, "pack.zip");
  try {
    const dl = await fetch(url);
    if (!dl.ok) { console.log(`  ${YEL}Failed to download the pack (HTTP ${dl.status}).${RST}\n`); return 1; }
    writeFileSync(zipPath, Buffer.from(await dl.arrayBuffer()));
  } catch (e) {
    console.log(`  ${YEL}Network failure during download: ${(e as Error).message}.${RST}\n`); return 1;
  }

  const xdir = join(tmp, "x");
  if (!extractZip(zipPath, xdir)) {
    console.log(`  ${RED}Failed to extract the .zip (needs unzip, tar or PowerShell).${RST}\n`);
    rmSync(tmp, { recursive: true, force: true });
    return 1;
  }
  const content = findContentRoot(xdir);
  if (!content) {
    console.log(`  ${RED}Content (squads/businesses/mind-clones) not found in the downloaded pack.${RST}\n`);
    rmSync(tmp, { recursive: true, force: true });
    return 1;
  }

  console.log(`  applying overlay (${version ?? "?"})...`);
  const ic = spawnSync(process.execPath, [
    join(SKILLS, "_shared", "scripts", "install-content.ts"),
    content, "--slug", slug, ...(version ? ["--version", version] : []),
    // Pass-through: --keep-clones / --keep-squads / --keep-businesses / --no-index.
    ...args.filter((a) => a.startsWith("--keep") || a === "--no-index"),
  ], { windowsHide: true, stdio: "inherit" });

  // Refresh the license from the artifact that was just downloaded.
  //
  // The zip is built per buyer and carries their PROVENANCE.json, so an update
  // already holds everything needed to repair a license store that is missing,
  // stale, or from an older purchase — and it used to walk past it. A buyer who
  // could run this command at all (from the pack folder, say) still had to go
  // find `nrv license install` on their own.
  //
  // It used to write unconditionally, and that was destructive. The store holds
  // ONE file, so updating any single pack replaced whatever license was there
  // with the edition of that pack: a buyer whose license was a bundle ran
  // `nrv update <one vertical>` and came out holding a license for that vertical
  // alone. Every other pack then answered `pack_mismatch` to every later update,
  // and the packs they had paid for stopped being updatable — the failure lands
  // on the next command, far from the one that caused it. So the repair is
  // scoped to what the comment above always meant: a missing, stale or older
  // license OF THE SAME EDITION. A different edition is never overwritten in
  // silence; it is reported, with the command that switches deliberately.
  //
  // Best-effort: the content is already installed and correct by this point.
  //
  // The pack's own copy (~/.nirvana-license/packs/<slug>/) follows the same
  // rule against its own file, so updating one pack never touches another
  // pack's license; the legacy single file keeps the rule above for the
  // engines that read only it.
  const freshProv = [join(content, "PROVENANCE.json"), join(dirname(content), "PROVENANCE.json")]
    .find((p) => existsSync(p));
  if (freshProv) {
    const notice = join(dirname(freshProv), "LICENSE.txt");
    const targets = [packLicenseDir(slug, HOME), dirname(legacyProvenancePath(HOME))].filter((d): d is string => Boolean(d));
    try {
      const incoming = JSON.parse(readFileSync(freshProv, "utf8")) as Record<string, unknown>;
      for (const licDir of targets) {
        const licPath = join(licDir, "PROVENANCE.json");
        const own = licDir !== dirname(legacyProvenancePath(HOME));
        try {
          mkdirSync(licDir, { recursive: true });
          const decision = decideLicenseRefresh(licPath, incoming);
          if (decision.refresh) {
            copyFileSync(freshProv, licPath);
            if (existsSync(notice)) copyFileSync(notice, join(licDir, "LICENSE.txt"));
            console.log(`  ${DIM}license${own ? ` of '${slug}'` : ""} refreshed: ${decision.reason}${RST}`);
          } else {
            console.log(`  ${DIM}license${own ? ` of '${slug}'` : ""} kept: ${decision.reason}${RST}`);
            if (!own) console.log(`  ${DIM}This pack updated fine; the license on this machine was not touched.${RST}`);
          }
        } catch (e) {
          console.log(`  ${YEL}could not refresh the license at ${licDir}: ${(e as Error).message}${RST}`);
          console.log(`  ${DIM}The content updated fine. Run 'nrv license install' when the permission is sorted.${RST}`);
        }
      }
    } catch (e) {
      console.log(`  ${YEL}could not read the downloaded license ${freshProv}: ${(e as Error).message}${RST}`);
    }
  }

  rmSync(tmp, { recursive: true, force: true });
  if (ic.status !== 0) { console.log(`  ${RED}Overlay failed.${RST}\n`); return 1; }
  console.log(`\n${GRN}✓ Pack '${slug}' updated${version ? ` to ${version}` : ""}.${RST}\n`);
  return 0;
}

process.exit(await main());
