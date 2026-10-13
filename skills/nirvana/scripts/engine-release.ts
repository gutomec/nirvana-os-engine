#!/usr/bin/env bun
/**
 * engine-release.ts — which engine release an implicit update may install.
 *
 * Every implicit engine fetch (`nrv update`, the bootstrap of the `nirvana`
 * skill, a pack's setup.ts) used to download `releases/latest`. GitHub's
 * "latest" is never a prerelease, so an engine on a beta (0.15.0-beta.5) was
 * silently replaced by the newest stable (0.14.10) on the next update or pack
 * install. The rule here keeps each engine on its own channel:
 *
 *   installed is a prerelease (a hyphen in the version) → the newest release
 *     greater than it, prerelease or stable (beta.5 → beta.6, or → 0.15.0);
 *   installed is stable, or unknown → the newest stable greater than it;
 *   nothing greater → nothing to install. Never a downgrade, never a reinstall
 *     of the same version.
 *
 * An explicit source (NIRVANA_ENGINE_URL, NIRVANA_ENGINE_TARBALL) is the
 * caller's business and never comes through here.
 *
 * Releases come from the GitHub releases API of the repository the installer
 * already uses, unauthenticated (60 requests an hour per address). When the API
 * cannot be reached or answers with its rate limit, the plan is "fallback": the
 * caller downloads `releases/latest` as before and checks the downloaded
 * VERSION with `mayReplace` before installing it, so a prerelease is still
 * never replaced by an older stable.
 *
 * Self-contained on purpose (node builtins only): the bootstrap runs it from
 * the skill folder before any engine exists.
 *
 * CLI, for the shell bootstraps:
 *   bun engine-release.ts plan --installed <version> [--repo <owner/repo>]
 *     stdout line 1: "<install|current|fallback> <version|-> <url>"; line 2: the reason.
 *     Nothing goes to stderr: Windows PowerShell can turn a native command's
 *     stderr into an error record under ErrorActionPreference=Stop.
 *   bun engine-release.ts may-replace <candidate> <installed> [--allow-equal]
 *     exit 0 when the candidate may replace the installed engine, 1 otherwise;
 *     --allow-equal also accepts the same version (a repair reinstall)
 *
 * Overrides (tests, mirrors): NIRVANA_ENGINE_RELEASES_API (the release list
 * URL), NIRVANA_ENGINE_LATEST_URL (where "latest" is downloaded on fallback).
 */

export const ENGINE_ASSET = "nirvana-os-engine.tar.gz";
export const DEFAULT_ENGINE_REPO = "gutomec/nirvana-os-engine";

interface Semver { core: [number, number, number]; pre: Array<string | number> }

/** `1.2.3`, `v1.2.3`, `1.2.3-beta.5`, `1.2.3+build`; null for anything else. */
export function parseSemver(v: string | null | undefined): Semver | null {
  if (!v) return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

/** Semver precedence (semver.org §11): a prerelease sorts below its release,
 *  numeric identifiers below alphanumeric ones, build metadata ignored.
 *  Null when either side does not parse. */
export function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a), pb = parseSemver(b);
  if (!pa || !pb) return null;
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

/** A version with a hyphen is a prerelease (the release workflow's own rule). */
export function isPrerelease(v: string | null | undefined): boolean {
  return (parseSemver(v)?.pre.length ?? 0) > 0;
}

export interface EngineRelease { version: string; prerelease: boolean; url: string }

/** The GitHub release list, reduced to releases that carry the engine asset. */
export function parseReleaseList(json: unknown, asset = ENGINE_ASSET): EngineRelease[] {
  if (!Array.isArray(json)) return [];
  const out: EngineRelease[] = [];
  for (const r of json as Array<Record<string, any>>) {
    if (!r || r.draft) continue;
    const version = String(r.tag_name ?? "").replace(/^v/, "");
    if (!parseSemver(version)) continue;
    const a = Array.isArray(r.assets) ? r.assets.find((x: any) => x?.name === asset) : null;
    if (!a?.browser_download_url) continue; // a release still uploading its asset would 404
    out.push({ version, prerelease: r.prerelease === true || isPrerelease(version), url: String(a.browser_download_url) });
  }
  return out;
}

/** The newest release the installed engine's channel allows, or null when none
 *  is greater than what is installed. */
export function pickEngineRelease(installed: string | null, releases: EngineRelease[]): EngineRelease | null {
  const inst = parseSemver(installed) ? installed! : null;
  const anyChannel = isPrerelease(inst);
  let best: EngineRelease | null = null;
  for (const r of releases) {
    if (r.prerelease && !anyChannel) continue;
    if (inst && (compareSemver(r.version, inst) ?? 0) <= 0) continue;
    if (!best || (compareSemver(r.version, best.version) ?? 0) > 0) best = r;
  }
  return best;
}

/** The newest release of the installed engine's channel, greater or not
 *  (for the "already current" message). */
export function newestInChannel(installed: string | null, releases: EngineRelease[]): string | null {
  const anyChannel = isPrerelease(installed);
  let best: string | null = null;
  for (const r of releases) {
    if (r.prerelease && !anyChannel) continue;
    if (!best || (compareSemver(r.version, best) ?? 0) > 0) best = r.version;
  }
  return best;
}

/** Whether a downloaded engine may replace the installed one: only a greater
 *  version (or the same one, for a repair, with `allowEqual`). An unreadable
 *  candidate is allowed over a stable engine (what every update did before)
 *  and refused over a prerelease. */
export function mayReplace(candidate: string | null, installed: string | null, allowEqual = false): boolean {
  if (!parseSemver(installed)) return true;
  if (!parseSemver(candidate)) return !isPrerelease(installed);
  const d = compareSemver(candidate!, installed!) ?? 0;
  return d > 0 || (allowEqual && d === 0);
}

export function latestEngineUrl(repo = DEFAULT_ENGINE_REPO, env: Record<string, string | undefined> = process.env): string {
  return env.NIRVANA_ENGINE_LATEST_URL || `https://github.com/${repo}/releases/latest/download/${ENGINE_ASSET}`;
}

export function tagEngineUrl(repo: string, version: string): string {
  return `https://github.com/${repo}/releases/download/v${version.replace(/^v/, "")}/${ENGINE_ASSET}`;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The release list, or why it could not be read. Never throws. */
export async function fetchEngineReleases(
  repo = DEFAULT_ENGINE_REPO,
  opts: { env?: Record<string, string | undefined>; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<{ releases: EngineRelease[] } | { error: string }> {
  const env = opts.env ?? process.env;
  const url = env.NIRVANA_ENGINE_RELEASES_API || `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const doFetch = opts.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  try {
    const res = await doFetch(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "nirvana-os-engine-update" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const when = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC` : "";
      return { error: res.headers.get("x-ratelimit-remaining") === "0" || res.status === 429
        ? `GitHub API rate limit reached${when}` : `GitHub API refused the request (HTTP ${res.status})` };
    }
    if (!res.ok) return { error: `GitHub API answered HTTP ${res.status}` };
    return { releases: parseReleaseList(await res.json()) };
  } catch (e) {
    return { error: `GitHub API unreachable (${(e as Error).message})` };
  }
}

export type EnginePlan =
  | { kind: "install"; version: string; url: string; reason: string }
  | { kind: "current"; installed: string; newest: string | null; url: string; reason: string }
  | { kind: "fallback"; url: string; reason: string };

/** What an implicit update of `installed` should do. */
export async function planEngineUpdate(
  installed: string | null,
  opts: { repo?: string; env?: Record<string, string | undefined>; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<EnginePlan> {
  const repo = opts.repo || DEFAULT_ENGINE_REPO;
  const env = opts.env ?? process.env;
  const inst = parseSemver(installed) ? installed!.trim().replace(/^v/, "") : null;
  const channel = isPrerelease(inst) ? "prerelease" : "stable";
  const list = await fetchEngineReleases(repo, { env, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
  if ("error" in list) {
    return {
      kind: "fallback", url: latestEngineUrl(repo, env),
      reason: `${list.error}; falling back to the latest stable release${inst ? `, installed only if newer than ${inst}` : ""}`,
    };
  }
  const pick = pickEngineRelease(inst, list.releases);
  if (pick) {
    return { kind: "install", version: pick.version, url: pick.url, reason: `${inst ?? "no engine"} → ${pick.version} (${channel} channel)` };
  }
  if (!inst) return { kind: "fallback", url: latestEngineUrl(repo, env), reason: "no release with the engine asset was listed" };
  const newest = newestInChannel(inst, list.releases);
  // The installed version's own release, for a repair that reinstalls it.
  const own = list.releases.find((r) => compareSemver(r.version, inst) === 0);
  return {
    kind: "current", installed: inst, newest, url: own?.url ?? tagEngineUrl(repo, inst),
    reason: `engine ${inst} is current${newest && newest !== inst ? ` (newest ${channel === "prerelease" ? "release" : "stable"}: ${newest})` : ""}; nothing newer to install`,
  };
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] ?? "" : ""; };
  if (cmd === "plan") {
    const plan = await planEngineUpdate(flag("--installed") || null, { repo: flag("--repo") || undefined });
    if (plan.kind === "install") console.log(`install ${plan.version} ${plan.url}`);
    else if (plan.kind === "current") console.log(`current ${plan.installed} ${plan.url}`);
    else console.log(`fallback - ${plan.url}`);
    console.log(plan.reason);
    process.exit(0);
  } else if (cmd === "may-replace") {
    process.exit(mayReplace(rest[0] || null, rest[1] || null, rest.includes("--allow-equal")) ? 0 : 1);
  } else {
    console.error("usage: engine-release.ts plan --installed <version> [--repo <owner/repo>] | may-replace <candidate> <installed> [--allow-equal]");
    process.exit(2);
  }
}
