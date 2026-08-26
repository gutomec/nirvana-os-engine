#!/usr/bin/env bun
// update-check.ts — tells the user a newer engine release exists.
//
// Why this exists: `nrv update` has always worked, but nothing ever said an
// update was there. A user who never typed the command stayed on their install
// forever, including through fixes that decide whether a run delivers or dies.
// The changelog reached whoever went looking; everyone else never heard.
//
// Design constraints, in the order that shaped it:
//
//   1. NEVER cost a command any latency. `bin/nrv` execs straight into bun for
//      every subcommand, so there is no "after the command" to hook. The notice
//      therefore comes from a CACHE FILE read before the exec (one stat + one
//      read), and the network refresh runs DETACHED, benefiting the next call.
//   2. NEVER break a run. No network, GitHub down, rate limit, garbage response,
//      unwritable cache: each is recorded and swallowed. The worst outcome this
//      script may cause is silence.
//   3. NEVER nag. One line, on stderr (stdout stays machine-parseable), only
//      when a newer version actually exists, at most once per CHECK_TTL.
//   4. Opt out completely: the updates.check setting at false
//      (NIRVANA_NO_UPDATE_CHECK=1, or `nrv config set updates.check false`), or CI=1.
//
// Cache contract (`~/.nirvana/cache/update-notice.txt`) — three lines of plain
// text, because the reader is bash, and JSON parsing in bash is how you ship a
// broken CLI to someone else's machine:
//
//   line 1  epoch seconds of the last check   (always present)
//   line 2  latest version seen               (empty ⇒ nothing pending)
//   line 3  the exact message to print        (empty ⇒ nothing pending)
//
// The timestamp lives INSIDE the file rather than being read from its mtime:
// bash needs a `stat` subprocess for mtime and the two `stat` dialects disagree
// across macOS and Linux, while a backup, a restore or an rsync rewrites mtime
// and would silently reset everyone's check interval. Three `read` builtins and
// no subprocess is both cheaper and more truthful.
//
// The reader compares line 2 against the INSTALLED version and stays quiet when
// they match, so a user who updates stops seeing the notice immediately, without
// waiting for the next refresh.
//
// Usage:
//   bun update-check.ts --refresh    # hit the network, rewrite the cache
//   bun update-check.ts --print      # print the pending notice, if any
//   bun update-check.ts --status     # human-readable state (diagnostics)
//
// Exit codes: always 0 for --refresh/--print (this must never fail a caller);
// --status returns 1 when an update is pending, for scripting.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSetting } from "../../_shared/lib/settings.ts";

const HOME = process.env.NIRVANA_HOME || os.homedir();
const NIRVANA_DIR = path.join(HOME, ".nirvana");
const CACHE_DIR = path.join(NIRVANA_DIR, "cache");
const NOTICE_FILE = path.join(CACHE_DIR, "update-notice.txt");
const SKILLS_DIR = process.env.NIRVANA_SKILLS_DIR || path.join(NIRVANA_DIR, "skills");

/** How long a check stays fresh. A day is often enough to matter and rare
 *  enough that GitHub never sees a meaningful request rate from us. */
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** Same repo the updater itself uses — one source of truth, one override. */
const ENGINE_REPO = process.env.NIRVANA_ENGINE_REPO || "gutomec/nirvana-os-engine";
/** Test seam: point at a local file:// or a stub server instead of GitHub. */
const RELEASE_API = process.env.NIRVANA_RELEASE_API
  || `https://api.github.com/repos/${ENGINE_REPO}/releases/latest`;
const CHANGELOG_URL = process.env.NIRVANA_CHANGELOG_URL
  || `https://github.com/${ENGINE_REPO}/blob/main/CHANGELOG.md`;

// ── version comparison ──────────────────────────────────────────────────────

/**
 * Compare two semver-ish versions. Returns >0 when a is newer, <0 when older,
 * 0 when equal. String comparison is not an option: it puts 0.10.0 BEFORE 0.9.0
 * and would tell everyone on 0.10 to downgrade.
 *
 * A pre-release (1.0.0-rc.1) sorts BEFORE its release (1.0.0), per semver, so a
 * user on a release candidate is correctly offered the final.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    if (!m) return null;
    return { nums: [+m[1], +m[2], +m[3]], pre: m[4] ?? null };
  };
  const pa = parse(a), pb = parse(b);
  // Unparseable input must never claim "newer" — that would nag forever.
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;   // release > pre-release
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** The installed version, from the file `bin/nrv --version` already trusts. */
export function installedVersion(): string | null {
  for (const p of [path.join(SKILLS_DIR, "VERSION"), path.join(NIRVANA_DIR, "VERSION")]) {
    try {
      const v = fs.readFileSync(p, "utf8").trim();
      if (v) return v;
    } catch { /* try the next candidate */ }
  }
  return null;
}

/** True when the user asked us to stay out of the way (`updates.check: false`,
 *  by the variable or the global config), or we are in CI. */
export function checkDisabled(): boolean {
  if (!resolveSetting("updates.check").value) return true;
  return !!process.env.CI;
}

// ── cache ───────────────────────────────────────────────────────────────────

export interface Notice { latest: string; message: string; }

/** Read the pending notice. Returns null when the cache is absent, unreadable,
 *  or says "checked, nothing to say" — which is a real state, not a gap. */
export function readNotice(file: string = NOTICE_FILE): Notice | null {
  const lines = readCache(file);
  if (!lines) return null;
  const latest = (lines[1] ?? "").trim();
  const message = (lines[2] ?? "").trim();
  if (!latest || !message) return null;
  return { latest, message };
}

function readCache(file: string): string[] | null {
  try { return fs.readFileSync(file, "utf8").split("\n"); } catch { return null; }
}

/** Milliseconds since the last check, or Infinity when never checked. */
export function ageMs(file: string = NOTICE_FILE, now: number = Date.now()): number {
  const lines = readCache(file);
  const stamp = Number.parseInt((lines?.[0] ?? "").trim(), 10);
  if (!Number.isFinite(stamp) || stamp <= 0) return Infinity;
  return now - stamp * 1000;
}

export function isStale(file: string = NOTICE_FILE, now: number = Date.now()): boolean {
  return ageMs(file, now) >= CHECK_TTL_MS;
}

/** Write the cache. Stamping it on EVERY check — including the up-to-date and
 *  the offline case — is what keeps the TTL honest; without it a current user
 *  would re-hit the network on every single command. */
function writeNotice(notice: Notice | null, now: number = Date.now()): void {
  const stamp = Math.floor(now / 1000);
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(NOTICE_FILE, `${stamp}\n${notice?.latest ?? ""}\n${notice?.message ?? ""}\n`, "utf8");
  } catch { /* an unwritable cache costs a re-check, never a failure */ }
}

// ── network ─────────────────────────────────────────────────────────────────

/** Latest published version, or null when we could not find out. */
export async function fetchLatestVersion(url: string = RELEASE_API): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "nirvana-os-update-check" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    const tag = typeof body?.tag_name === "string" ? body.tag_name
              : typeof body?.name === "string" ? body.name : null;
    if (!tag) return null;
    const cleaned = tag.trim().replace(/^v/, "");
    return /^\d+\.\d+\.\d+/.test(cleaned) ? cleaned : null;
  } catch { return null; }
}

export function renderMessage(current: string, latest: string): string {
  return `Nirvana-OS ${latest} is available (you have ${current}) — run \`nrv update\`. Changelog: ${CHANGELOG_URL}`;
}

// ── commands ────────────────────────────────────────────────────────────────

async function refresh(): Promise<void> {
  // Switched off: stamp the cache with nothing pending, so bin/nrv (which reads
  // only the variable) prints no notice and stops respawning this refresher.
  if (checkDisabled()) { writeNotice(null); return; }
  const current = installedVersion();
  if (!current) return;                       // unknown install — nothing to compare
  const latest = await fetchLatestVersion();
  if (!latest) {
    // Network trouble. Touch the cache so we back off for a full TTL instead of
    // retrying on every command while the user is offline; keep any pending
    // notice intact rather than dropping a valid one over a failed request.
    const pending = readNotice();
    writeNotice(pending);
    return;
  }
  writeNotice(compareVersions(latest, current) > 0 ? { latest, message: renderMessage(current, latest) } : null);
}

function printPending(): void {
  if (checkDisabled()) return;
  const notice = readNotice();
  if (!notice) return;
  const current = installedVersion();
  // The user may have updated since the check — say nothing rather than tell
  // someone on 0.3.0 that 0.3.0 awaits them.
  if (current && compareVersions(notice.latest, current) <= 0) return;
  console.error(notice.message);
}

function status(): number {
  const current = installedVersion() ?? "unknown";
  const notice = readNotice();
  const age = ageMs();
  console.log(`installed:   ${current}`);
  console.log(`last check:  ${age === Infinity ? "never" : `${Math.floor(age / 60000)} min ago`}`);
  console.log(`disabled:    ${checkDisabled() ? "yes (updates.check=false or CI)" : "no"}`);
  if (notice && current !== "unknown" && compareVersions(notice.latest, current) > 0) {
    console.log(`pending:     ${notice.latest}`);
    return 1;
  }
  console.log("pending:     none");
  return 0;
}

if (import.meta.main) {
  const arg = process.argv[2] ?? "--print";
  if (arg === "--refresh") { await refresh(); process.exit(0); }
  if (arg === "--status") { process.exit(status()); }
  printPending();
  process.exit(0);
}
