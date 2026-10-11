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
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
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

// Release channel. `releases/latest` is never a prerelease, so updating the
// engine on every run used to replace a beta (0.15.0-beta.5) with the newest
// stable (0.14.10), an older version. The installed engine's channel decides
// instead: a prerelease moves to the newest greater release (prerelease or
// stable), a stable engine to the newest greater stable, and an older or equal
// version is never installed. An explicit NIRVANA_ENGINE_URL or
// NIRVANA_ENGINE_TARBALL still wins. This file ships alone inside every pack,
// so it carries its own copy of the rule (the engine's is
// skills/nirvana/scripts/engine-release.ts).
type Sv = { core: number[]; pre: Array<string | number> };
function parseSemver(v: string | null | undefined): Sv | null {
  const m = v ? /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim()) : null;
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [] };
}
function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)!, pb = parseSemver(b)!;
  for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  if (!pa.pre.length || !pb.pre.length) return pa.pre.length === pb.pre.length ? 0 : pa.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i], y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
const isPrerelease = (v: string | null | undefined): boolean => (parseSemver(v)?.pre.length ?? 0) > 0;
// Only a greater version replaces the installed engine. An unreadable version
// is allowed over a stable engine (what every run did before) and refused over
// a prerelease.
function mayReplace(candidate: string | null, installed: string | null): boolean {
  if (!parseSemver(installed)) return true;
  if (!parseSemver(candidate)) return !isPrerelease(installed);
  return compareSemver(candidate!, installed!) > 0;
}
// What this run should do with the installed engine: the release to install,
// "current" when nothing in its channel is greater, or null when the GitHub API
// cannot be read (rate limit, offline), and then `releases/latest` is fetched
// and installed only if it is newer.
async function planEngineUpdate(installed: string | null): Promise<{ kind: "install"; version: string; url: string } | { kind: "current"; reason: string } | { kind: "fallback"; reason: string }> {
  const api = process.env.NIRVANA_ENGINE_RELEASES_API || `https://api.github.com/repos/${ENGINE_REPO}/releases?per_page=100`;
  let list: Array<Record<string, any>>;
  try {
    const res = await fetch(api, { headers: { Accept: "application/vnd.github+json", "User-Agent": "nirvana-os-pack-setup" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      const limited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
      return { kind: "fallback", reason: limited ? "GitHub API rate limit reached" : `GitHub API answered HTTP ${res.status}` };
    }
    list = await res.json();
    if (!Array.isArray(list)) return { kind: "fallback", reason: "GitHub API answered an unexpected shape" };
  } catch (e) {
    return { kind: "fallback", reason: `GitHub API unreachable (${(e as Error).message})` };
  }
  const anyChannel = isPrerelease(installed);
  const inst = parseSemver(installed) ? installed! : null;
  let best: { version: string; url: string } | null = null;
  for (const r of list) {
    const version = String(r?.tag_name ?? "").replace(/^v/, "");
    const asset = Array.isArray(r?.assets) ? r.assets.find((a: any) => a?.name === "nirvana-os-engine.tar.gz") : null;
    if (r?.draft || !parseSemver(version) || !asset?.browser_download_url) continue;
    if ((r.prerelease === true || isPrerelease(version)) && !anyChannel) continue;
    if (inst && compareSemver(version, inst) <= 0) continue;
    if (!best || compareSemver(version, best.version) > 0) best = { version, url: String(asset.browser_download_url) };
  }
  if (best) return { kind: "install", ...best };
  if (!inst) return { kind: "fallback", reason: "no release with the engine asset was listed" };
  return { kind: "current", reason: `nothing newer than ${inst} in its ${anyChannel ? "prerelease" : "stable"} channel` };
}

// Pack version (from the per-buyer PROVENANCE) → written to the manifest so
// `nrv update --check` can compare later. Absent in copies without provenance.
let packVersion: string | null = null;
try { packVersion = JSON.parse(readFileSync(join(HERE, "PROVENANCE.json"), "utf8")).version ?? null; } catch { /* no provenance */ }

// Runs a subprocess with its output NESTED under the current step.
//
// Without this the engine installer prints ITS OWN numbering ("[1/4] Copying
// skills tree...") inside this script's step [1/4], and the two scales get
// mixed: the reader sees "[2/4] Installing shared deps" and thinks the pack
// already moved to step 2. The bar on the left says, with no text needed, "this
// is detail of the step above".
//
// Desired side effect: with piped output, subprocesses stop seeing a TTY and
// swap \r spinners for plain lines, so the log stays readable when redirected
// to a file.
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

// 1. Engine: install if missing, UPDATE if already present.
//
//    `npx @nirvana-os/cli` always fetches the latest GitHub tarball and runs
//    the installer, so installing and updating are the same operation. The pack
//    is content curated and tested against an engine; leaving the buyer on an
//    old engine delivers half the product and calls it installed.
//
//    There used to be a contradiction here: with an outdated engine, this step
//    said "the content installs normally" and install-content aborted right
//    after with exit 3. The buyer read that it would work and got an error.
//    Now the engine is updated first, and the failure (if any) shows up ONCE, here.
//
//    NIRVANA_SKIP_ENGINE_UPDATE=1 skips the update (useful for offline tests
//    and for anyone who pinned a version on purpose).
const enginePresent = existsSync(join(SKILLS, "harness"));
const installedVer = installedEngineVersion();
const stale = enginePresent && requiresEngine != null && installedVer != null && cmpVer(installedVer, requiresEngine) < 0;
const unknownVer = enginePresent && requiresEngine != null && installedVer == null;
const skipUpdate = process.env.NIRVANA_SKIP_ENGINE_UPDATE === "1";

// Test/offline override: NIRVANA_CLI_LOCAL points to a local launcher.
const localCli = process.env.NIRVANA_CLI_LOCAL;
//    Installs/updates the engine WITHOUT depending on Node.
//
//    This script is already running in Bun, and Bun can do everything the
//    installer needs: `fetch` the release, `tar` to extract, and run
//    install.ts. `npx @nirvana-os/cli` was just an intermediary, and an
//    expensive one, because it dragged in Node.js as a second dependency.
//
//    The attempt to swap it for `bunx` failed, and it is worth recording why:
//    the published package's binary has the shebang `#!/usr/bin/env node`, so
//    bunx downloads the package and dies with 127 (`env: node: No such file or
//    directory`). Measured with a freshly installed Bun in a HOME without Node.
//    Downloading the tarball directly sidesteps the whole problem: there is no
//    third-party binary to execute.
//
//    `tar` exists on Windows 10+, macOS and Linux. The paths passed are
//    RELATIVE on purpose: an absolute Windows path (C:\...) has ":" and Git
//    Bash's GNU tar treats it as a remote host.
//
//    npx stays as a last resort, for when the network blocks GitHub but allows
//    the npm registry.
const ENGINE_REPO = process.env.NIRVANA_ENGINE_REPO ?? "gutomec/nirvana-os-engine";
const ENGINE_URL =
  process.env.NIRVANA_ENGINE_URL ??
  process.env.NIRVANA_ENGINE_LATEST_URL ??
  `https://github.com/${ENGINE_REPO}/releases/latest/download/nirvana-os-engine.tar.gz`;
// The source this run downloads, and whether it may install only a newer engine
// (the fallback when the release list could not be read).
let engineSource = ENGINE_URL;
let onlyIfNewer = false;
let engineKept = false;

// Removes the work directory and CONFIRMS it is gone. An rmSync that "did not
// throw" does not prove removal: on Windows an antivirus holding a handle makes
// the unlink fail silently, and on macOS a file without write permission
// survives. So the loop checks with existsSync on every attempt and only
// returns control when the directory is really no longer there.
//
// Never throws: cleanup that brings down the install would be worse than the
// litter it would leave. If the attempts run out, the user is told the exact path.
function removeWorkDir(dir: string): void {
  // Restores write permission across the tree. Measured: a directory without +w
  // makes rmSync fail with EACCES on all three attempts, since it does not chmod
  // on its own on POSIX. Without this step the loop just repeats the same error.
  const grantWrite = (p: string): void => {
    try {
      const st = statSync(p);
      chmodSync(p, st.mode | 0o200);
      if (st.isDirectory()) for (const e of readdirSync(p)) grantWrite(join(p, e));
    } catch { /* best-effort */ }
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* checked below */ }
    if (!existsSync(dir)) return;
    grantWrite(dir);
  }
  console.log(`    ⚠ Could not remove the temp dir: ${dir}`);
  console.log(`      Nothing broke; delete it when you can.`);
}

// Sweeps leftovers from previous installs. Versions up to 0.1.73 did not clean
// up, and each run left ~14 MB in /tmp. Only touches what is over an hour old,
// so it never pulls the rug from under an install running in parallel.
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
      const res = await fetch(engineSource, { redirect: "follow" });
      if (!res.ok) {
        console.error(`    ✗ Engine download failed (HTTP ${res.status}).`);
        return false;
      }
      tarball = join(work, "engine.tar.gz");
      writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
    }
    const out = join(work, "src");
    mkdirSync(out, { recursive: true });
    if (!(await okNested("tar", ["-xzf", "engine.tar.gz", "-C", "src"], work))) {
      console.error("    ✗ Could not extract the engine (needs 'tar').");
      return false;
    }
    // The asset extracts flat (scripts/ at the root); a source archive comes
    // wrapped in a single directory. Accept both.
    let root = out;
    if (!existsSync(join(root, "scripts", "install.ts"))) {
      const entries = readdirSync(out);
      if (entries.length === 1 && existsSync(join(out, entries[0], "scripts", "install.ts"))) root = join(out, entries[0]);
    }
    const installer = join(root, "scripts", "install.ts");
    if (!existsSync(installer)) {
      console.error("    ✗ Invalid engine asset (no scripts/install.ts).");
      return false;
    }
    if (onlyIfNewer) {
      let candidate: string | null = null;
      try { candidate = readFileSync(join(root, "skills", "VERSION"), "utf8").trim() || null; } catch { /* unreadable */ }
      if (!mayReplace(candidate, installedVer)) {
        console.log(`    Engine ${installedVer} kept: the latest release (${candidate ?? "unknown version"}) is not newer.`);
        engineKept = true;
        return true;
      }
    }
    return await okNested("bun", [installer, "--no-starter", ...profileArgs]);
  } catch (e) {
    console.error(`    ✗ Failed to install the engine: ${(e as Error).message}`);
    return false;
  } finally {
    if (work) removeWorkDir(work);
  }
}

const runEngineInstaller = async (): Promise<boolean> => {
  if (localCli) return okNested("node", [localCli]);
  if (await installEngineWithBun()) return true;
  // npx installs the latest stable whatever is installed: over a prerelease
  // that is a downgrade, so it is not tried there.
  if (enginePresent && isPrerelease(installedVer) && !process.env.NIRVANA_ENGINE_URL) {
    console.log(`    Not trying npm (npx): it installs the latest stable, older than the installed ${installedVer}.`);
    return false;
  }
  console.log("    Trying npm (npx)...");
  return okNested("npx", ["-y", "@nirvana-os/cli"]);
};

// Performance profile: asked HERE, where the terminal is. The engine installer
// runs nested with its output relayed line by line, so a question it printed
// would never show; it gets the answer as --profile instead.
const PROFILES = ["max", "balanced", "economy"];
const profileFlag = process.argv.find((a) => a.startsWith("--profile="))?.slice("--profile=".length) ?? "";
function recordedProfile(): string {
  try {
    const m = /^\s*profile:\s*["']?(max|balanced|economy)/m.exec(readFileSync(join(HOME, ".nirvana", "config.yaml"), "utf8"));
    return m ? m[1] : "";
  } catch { return ""; }
}
async function askProfile(): Promise<string> {
  console.log("\n[profile] How should Nirvana spend tokens? (change it later with: nrv config set execution.profile <name> --global)");
  console.log("  1) max       highest quality and highest usage: xhigh effort, no context cap, every delivery reviewed, up to two correction rounds");
  console.log("  2) balanced  recommended: high effort, 400k context cap, review when a rule asks for it");
  console.log("  3) economy   lowest usage: medium effort, 200k context cap, review only when requested");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((done) => rl.question("Choose 1-3 [2]: ", (a) => {
    rl.close();
    const v = a.trim().toLowerCase();
    done(PROFILES[Number(v) - 1] ?? (PROFILES.includes(v) ? v : "balanced"));
  }));
}
const chosenProfile = PROFILES.includes(profileFlag) ? profileFlag
  : !recordedProfile() && process.stdin.isTTY ? await askProfile() : "";
const profileArgs = chosenProfile ? [`--profile=${chosenProfile}`] : [];

if (!enginePresent) {
  console.log("[1/4] Engine not found — installing from GitHub...");
  if (!(await runEngineInstaller()) || !existsSync(join(SKILLS, "harness"))) {
    console.error("    ✗ Could not install the Nirvana-OS engine.");
    console.error("      Check your internet connection and run this setup again.");
    console.error(`      The engine comes from:  ${ENGINE_URL}`);
    console.error("      Behind a proxy/firewall? Download the .tar.gz and point to it:  NIRVANA_ENGINE_TARBALL=/path/engine.tar.gz bun setup.ts");
    process.exit(1);
  }
} else if (skipUpdate) {
  console.log(`[1/4] Engine ${installedVer ?? "present"} — update skipped (NIRVANA_SKIP_ENGINE_UPDATE=1).`);
} else {
  const explicitSource = Boolean(process.env.NIRVANA_ENGINE_URL || process.env.NIRVANA_ENGINE_TARBALL || localCli);
  const plan = explicitSource ? null : await planEngineUpdate(installedVer);
  if (plan?.kind === "install") engineSource = plan.url;
  if (plan?.kind === "fallback") onlyIfNewer = true;
  let updated = true;
  if (plan?.kind === "current") {
    console.log(`[1/4] Engine ${installedVer} is current (${plan.reason}).`);
  } else {
    console.log(`[1/4] Updating the engine${installedVer ? ` (current: ${installedVer})` : ""}${plan?.kind === "install" ? ` to ${plan.version}` : ""}...`);
    if (plan?.kind === "fallback") console.log(`    ${plan.reason}; the latest stable release is installed only if it is newer.`);
    updated = await runEngineInstaller();
  }
  const nowVer = installedEngineVersion();
  if (plan?.kind === "current" || (updated && engineKept)) {
    // Already said above: nothing was installed.
  } else if (updated) {
    console.log(`    ✓ Engine at ${nowVer ?? "unknown version"}.`);
  } else if (stale || unknownVer) {
    // Cannot go on: install-content below has the version gate and would abort
    // anyway. Failing here, with the right reason, beats failing later with an
    // error that looks like it comes from the content.
    console.error(`    ✗ Failed to update the engine, and the current one (${installedVer ?? "unknown"}) is older than this pack requires (>=${requiresEngine}).`);
    console.error(`      Update manually and run again:  curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | bash   (Windows: irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex)`);
    process.exit(1);
  } else {
    // The engine already satisfies the pack: the network failure does not block the install.
    console.log(`    ⚠ Could not update right now (network?). Carrying on with engine ${installedVer ?? "as installed"}, which already serves this pack.`);
  }
}

// The installer records the profile when it runs; a skipped or failed update
// does not, so it is recorded here through the installed engine.
if (chosenProfile && recordedProfile() !== chosenProfile && existsSync(join(SKILLS, "harness", "scripts", "config.ts"))) {
  spawnSync("bun", [join(SKILLS, "harness", "scripts", "config.ts"), "set", "execution.profile", chosenProfile, "--global"], { cwd: HOME, stdio: "ignore" });
}

// 2. Overlay content — surface the REAL error if it fails (without it the customer is left blind).
console.log(`[2/4] Installing pack '${slug}' content (businesses, squads and mind-clones)...`);
if (!existsSync(CONTENT)) {
  console.error(`    ✗ Content folder not found: ${CONTENT}`);
  console.error(`      The zip must be extracted IN FULL (the 'starter-pack/' folder sits next to this setup.ts).`);
  process.exit(1);
}
const icArgs = [
  join(SKILLS, "_shared", "scripts", "install-content.ts"),
  CONTENT, "--slug", slug, ...(packVersion ? ["--version", packVersion] : []),
];
const ic = await runNested("bun", icArgs);
if (ic.status !== 0) {
  console.error(`\n    ✗ Failed to install the content (exit ${ic.status ?? "?"}).`);
  if (ic.error) {
    const e = ic.error as NodeJS.ErrnoException;
    console.error(`      process: ${e.message}${e.code === "ENOENT" ? " (the 'bun' command is not on this session's PATH)" : ""}`);
  }
  console.error(`      contentDir: ${CONTENT}`);
  console.error(`      skills:     ${SKILLS}`);
  console.error(`      Windows/WSL: run everything INSIDE WSL (Linux bun, zip in ~/, not in /mnt/c).`);
  console.error(`      To see the full error, run manually:`);
  console.error(`        bun ${icArgs.join(" ")}`);
  process.exit(1);
}

// Builds the routing indexes (squads + businesses + mind-clones) so that
// `nrv route`/`nrv auto` and the Glance chat work WELL from the first run.
// Without this the businesses/squads registries do not exist and routing runs
// degraded (guesses by name instead of matching by capability). The indexer
// respects scope: global on the pack install, project if run inside a project.
// Best-effort — never blocks the install.
console.log(`[3/4] Building the routing indexes...`);
const idx = await runNested("bun", [join(SKILLS, "harness", "scripts", "index.ts")]);
if (idx.status !== 0) {
  console.log(`    ⚠ Index not built (exit ${idx.status ?? "?"}). The content is installed; run 'nrv index' when you can — routing gets sharper with it.`);
}

// Stamps the edition with the NAME OF THE PACK the buyer installed, so that
// `nrv -v` shows the paid product (e.g. "Nirvana-OS Genesis Circle") instead of
// the free engine's label. The engine's EDITION is neutral ("Nirvana-OS"); here
// it comes to reflect the purchase. Best-effort — never blocks the install.
try {
  const pretty = slug.split(/[-_]/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
  writeFileSync(join(SKILLS, "EDITION"), `Nirvana-OS ${pretty}\n`);
} catch { /* best-effort */ }

// 3. Install the license, THEN verify.
//
// This step was missing. The installer read PROVENANCE.json only to find out
// the pack version (line ~51) and never copied it to ~/.nirvana-license/, the
// only place `nrv update <slug>` knows to look, outside the current directory.
// The buyer finished setup with "✓ Pack installed", went to update days later
// from any other folder, and heard they had no license at all.
//
// Failing here must not be silent: the pack works without the installed
// license, only the authenticated update breaks, and now is when we can say so.
console.log("[4/4] Installing and checking the license (soft)...");
const provSrc = join(HERE, "PROVENANCE.json");
if (existsSync(provSrc)) {
  const licDir = join(HOME, ".nirvana-license");
  // Each pack also keeps its own copy (~/.nirvana-license/packs/<slug>/): the
  // single file above is written by every pack's setup, so the last pack
  // installed used to take the others' licenses away and `nrv update <other>`
  // was refused. Engines that know the per-pack copy read it first; older ones
  // keep reading the single file, written exactly as before.
  const packLicDir = /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(slug) && !slug.includes("..") ? join(licDir, "packs", slug) : null;
  try {
    mkdirSync(licDir, { recursive: true });
    copyFileSync(provSrc, join(licDir, "PROVENANCE.json"));
    const licNotice = join(HERE, "LICENSE.txt");
    if (existsSync(licNotice)) copyFileSync(licNotice, join(licDir, "LICENSE.txt"));
    if (packLicDir) {
      mkdirSync(packLicDir, { recursive: true });
      copyFileSync(provSrc, join(packLicDir, "PROVENANCE.json"));
      if (existsSync(licNotice)) copyFileSync(licNotice, join(packLicDir, "LICENSE.txt"));
    }
  } catch (e) {
    console.log(`    \x1b[31m✗ could not install the license at ${licDir}: ${(e as Error).message}\x1b[0m`);
    console.log(`    \x1b[2mThe pack works. What will not work is 'nrv update ${slug}'.\x1b[0m`);
    console.log(`    \x1b[2mOnce the permission is sorted, run: nrv license install "${HERE}"\x1b[0m`);
  }
} else {
  // A copy without provenance runs the same; what it lacks is the authenticated update.
  console.log(`    \x1b[2m(no PROVENANCE.json in this folder — the pack runs, but 'nrv update ${slug}' will find no license)\x1b[0m`);
}
// `--pack` makes an engine that knows per-pack licenses check this pack's own;
// an older engine ignores the extra argument and checks the single file.
await okNested("bun", [join(SKILLS, "_shared", "scripts", "license.ts"), "check", "--pack", slug]);

console.log(`\n\x1b[1;32m✓ Pack '${slug}' installed.\x1b[0m\n`);
