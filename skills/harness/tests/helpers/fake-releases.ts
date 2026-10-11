// fake-releases.ts — a GitHub release list and its engine tarballs, served
// locally, for the tests of the release channel (engine-release.ts and the
// three implicit fetchers: nrv update, the nirvana bootstrap, pack setup.ts).
//
// Each tarball is a stub engine: skills/VERSION names its version and
// scripts/install.ts writes that VERSION into the skills tree it would install
// (NIRVANA_SKILLS_DIR, else ~/.nirvana/skills) and appends one line to
// <HOME>/installs.log, so a test reads what was installed, and how many times.
//
// The server answers in-process, so the code under test must run in a child
// started with Bun.spawn and awaited: spawnSync would block the event loop
// that serves the answer.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface FakeRelease { version: string; prerelease?: boolean; noAsset?: boolean }

export function buildStubEngine(dir: string, version: string): string {
  const src = path.join(dir, `engine-src-${version}`);
  fs.mkdirSync(path.join(src, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(src, "skills"), { recursive: true });
  fs.writeFileSync(path.join(src, "skills", "VERSION"), `${version}\n`);
  fs.writeFileSync(path.join(src, "scripts", "install.ts"), [
    'import * as fs from "node:fs";',
    'import * as path from "node:path";',
    'import { homedir } from "node:os";',
    'const skills = process.env.NIRVANA_SKILLS_DIR || path.join(homedir(), ".nirvana", "skills");',
    'fs.mkdirSync(path.join(skills, "harness"), { recursive: true });',
    `fs.writeFileSync(path.join(skills, "VERSION"), ${JSON.stringify(`${version}\n`)});`,
    'const bin = path.join(homedir(), ".local", "bin");',
    'fs.mkdirSync(bin, { recursive: true });',
    'fs.writeFileSync(path.join(bin, "nrv"), "#!/bin/sh\\necho stub\\n");',
    'fs.chmodSync(path.join(bin, "nrv"), 0o755);',
    'fs.writeFileSync(path.join(bin, "nrv.cmd"), "@echo stub\\r\\n");',
    `fs.appendFileSync(path.join(homedir(), "installs.log"), ${JSON.stringify(version)} + "\\n");`,
  ].join("\n"));
  const name = `engine-${version}.tar.gz`;
  const t = spawnSync("tar", ["-czf", name, "-C", path.basename(src), "."], { cwd: dir, encoding: "utf8" });
  if (t.status !== 0) throw new Error(`tar failed: ${t.stderr}`);
  return path.join(dir, name);
}

export interface FakeReleaseServer {
  base: string;
  /** NIRVANA_ENGINE_RELEASES_API / NIRVANA_ENGINE_LATEST_URL for the child. */
  env: Record<string, string>;
  setReleases(list: FakeRelease[]): void;
  /** The version /latest serves (GitHub's "latest": the newest stable). */
  setLatest(version: string): void;
  /** Answer the release list with GitHub's rate-limit response. */
  setRateLimited(on: boolean): void;
  /** Paths the server was asked for, in order. */
  hits: string[];
  stop(): void;
}

export function startFakeReleases(dir: string): FakeReleaseServer {
  let releases: FakeRelease[] = [];
  let latest = "";
  let limited = false;
  const tarballs = new Map<string, string>();
  const tarball = (v: string) => {
    if (!tarballs.has(v)) tarballs.set(v, buildStubEngine(dir, v));
    return tarballs.get(v)!;
  };
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      hits.push(url.pathname);
      if (url.pathname === "/releases") {
        if (limited) {
          return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) },
          });
        }
        const base = `http://127.0.0.1:${server.port}`;
        return Response.json(releases.map((r) => ({
          tag_name: `v${r.version}`, draft: false, prerelease: Boolean(r.prerelease),
          assets: r.noAsset ? [] : [{ name: "nirvana-os-engine.tar.gz", browser_download_url: `${base}/download/v${r.version}/nirvana-os-engine.tar.gz` }],
        })));
      }
      const m = /^\/download\/v([^/]+)\/nirvana-os-engine\.tar\.gz$/.exec(url.pathname);
      if (m) return new Response(fs.readFileSync(tarball(m[1])));
      if (url.pathname === "/latest/nirvana-os-engine.tar.gz" && latest) return new Response(fs.readFileSync(tarball(latest)));
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    base,
    env: { NIRVANA_ENGINE_RELEASES_API: `${base}/releases`, NIRVANA_ENGINE_LATEST_URL: `${base}/latest/nirvana-os-engine.tar.gz` },
    setReleases(list) { releases = list; },
    setLatest(v) { latest = v; },
    setRateLimited(on) { limited = on; },
    hits,
    stop() { server.stop(true); },
  };
}

/** Run a command to completion without blocking the in-process server. */
export async function runAsync(cmd: string[], opts: { cwd: string; env: Record<string, string | undefined>; timeoutMs?: number }): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env as Record<string, string>, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 60_000);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out: `${out}${err}` };
}
