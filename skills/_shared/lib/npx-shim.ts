#!/usr/bin/env bun
/**
 * npx-shim.ts — `npx <bin>` that runs a squad environment's own binary.
 *
 * A squad's packages live in `~/.nirvana/envs/<slug>/node_modules` (squad-env.ts),
 * and the real npx resolves a bin only from the folder it runs in: measured, it
 * went to the registry for a bin sitting in an env's `.bin` that was first on
 * PATH. Squad steps and scripts say `npx remotion render …` all the same, so the
 * worker's PATH starts with `<env>/.shim`, holding an `npx` (POSIX sh) and an
 * `npx.cmd` (Windows) that both run this file.
 *
 * planNpx() is the whole decision and is pure: when the requested bin is in a
 * `node_modules/.bin` on PATH (the env's own, a carded squad's, any env's), it
 * runs that binary with the remaining arguments. Anything it does not
 * understand (`-c`, an unknown flag, a bin no env has) falls through to the
 * next real npx on PATH, skipping every shim folder, or to `bun x` when the
 * machine has no npx at all.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

/** The folder name squad-env.ts writes the shims into; skipped when looking for the real npx. */
export const SHIM_DIR = ".shim";

/** npx flags that take no value and change nothing about which bin runs. */
const BOOLEAN_FLAGS = new Set(["-y", "--yes", "--no", "--no-install", "--install", "-q", "--quiet", "--ignore-existing", "--prefer-offline", "--prefer-online", "--offline"]);

export type NpxPlan =
  | { kind: "bin"; bin: string; args: string[] }
  | { kind: "fallthrough"; reason: string };

/** `pkg@1.2`, `@scope/pkg@^4` → `pkg`, `@scope/pkg`. */
export function stripVersion(spec: string): string {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at > 0 ? spec.slice(0, at) : spec;
}

/** The bin names a package spec may stand for: its own name, the unscoped one,
 *  and what its package.json `bin` declares when a node_modules has it. */
export function binNamesFor(spec: string, modulesDirs: string[], read: (file: string) => string | null): string[] {
  const name = stripVersion(spec);
  const names = [name, name.includes("/") ? name.split("/").pop()! : name];
  for (const m of modulesDirs) {
    const raw = read(path.join(m, name, "package.json"));
    if (!raw) continue;
    try {
      const bin = JSON.parse(raw).bin;
      if (typeof bin === "string") names.push(names[1]);
      else if (bin && typeof bin === "object") {
        const keys = Object.keys(bin);
        // One bin, or the one named after the package: what npx itself would pick.
        names.push(...(keys.length === 1 ? keys : keys.filter((k) => k === names[1])));
      }
    } catch { /* unreadable manifest: the names above stand */ }
    break;
  }
  return [...new Set(names)];
}

/** Path rules and PATH separator of a platform, so Windows decisions test anywhere. */
const pathsOf = (platform: NodeJS.Platform) => platform === "win32" ? { p: path.win32, sep: ";" } : { p: path.posix, sep: ":" };

/** The node_modules/.bin folders on a PATH, in PATH order. */
export function binDirsOn(pathValue: string, platform: NodeJS.Platform = process.platform): string[] {
  const { p, sep } = pathsOf(platform);
  return pathValue.split(sep).filter((d) => d && p.basename(d) === ".bin" && p.basename(p.dirname(d)) === "node_modules");
}

/** The executable a bin name resolves to in one `.bin` folder, per platform. */
export function binFile(dir: string, name: string, platform: NodeJS.Platform, exists: (p: string) => boolean): string | null {
  const exts = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const ext of exts) {
    const file = pathsOf(platform).p.join(dir, name + ext);
    if (exists(file)) return file;
  }
  return null;
}

/**
 * What `npx <args>` should do, given the `.bin` folders it may use. Pure: the
 * filesystem arrives as `exists` and `read`.
 */
export function planNpx(
  args: string[],
  binDirs: string[],
  opts: { platform?: NodeJS.Platform; exists: (p: string) => boolean; read: (file: string) => string | null },
): NpxPlan {
  const platform = opts.platform ?? process.platform;
  const packages: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { i++; break; }
    if (BOOLEAN_FLAGS.has(a)) continue;
    if (a === "-p" || a === "--package") { if (i + 1 >= args.length) return { kind: "fallthrough", reason: `${a} without a value` }; packages.push(args[++i]); continue; }
    if (a.startsWith("--package=")) { packages.push(a.slice("--package=".length)); continue; }
    if (a.startsWith("-")) return { kind: "fallthrough", reason: `flag ${a} is the real npx's to interpret` };
    break;
  }
  const command = args[i];
  if (!command) return { kind: "fallthrough", reason: "no command" };
  const rest = args.slice(i + 1);
  const modules = binDirs.map((d) => pathsOf(platform).p.dirname(d));
  // With --package the positional is already a bin name; without it, it is a
  // package spec whose bin npx would have to look up.
  const names = packages.length ? [command] : binNamesFor(command, modules, opts.read);
  for (const dir of binDirs) {
    for (const name of names) {
      const bin = binFile(dir, name, platform, opts.exists);
      if (bin) return { kind: "bin", bin, args: rest };
    }
  }
  return { kind: "fallthrough", reason: `no environment has a bin for ${command}` };
}

/** The next real npx on PATH, never one of the shims. */
export function realNpx(pathValue: string, platform: NodeJS.Platform, exists: (p: string) => boolean): string | null {
  const { p, sep } = pathsOf(platform);
  for (const dir of pathValue.split(sep)) {
    if (!dir || p.basename(dir) === SHIM_DIR) continue;
    const bin = binFile(dir, "npx", platform, exists);
    if (bin) return bin;
  }
  return null;
}

/** cmd.exe's line for a `.cmd`/`.bat`: every argument quoted, so `^ & | < >` stay data. */
export function windowsCmdLine(file: string, args: string[]): string {
  return [file, ...args].map((a) => `"${a}"`).join(" ");
}

/** Run `file args` with the terminal attached and return its exit code. */
function run(file: string, args: string[]): number {
  const isCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
  const r = isCmd
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${windowsCmdLine(file, args)}"`], { stdio: "inherit", windowsHide: true, windowsVerbatimArguments: true })
    : spawnSync(file, args, { stdio: "inherit", windowsHide: true });
  if (r.error) { console.error(`npx (nirvana shim): ${r.error.message}`); return 127; }
  return r.status ?? 1;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const pathValue = process.env[pathKey] ?? "";
  const exists = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
  const plan = planNpx(args, binDirsOn(pathValue), { exists, read });
  if (plan.kind === "bin") process.exit(run(plan.bin, plan.args));
  const npx = realNpx(pathValue, process.platform, exists);
  if (npx) process.exit(run(npx, args));
  // No npx on this machine: bun's own runner, without the npx-only flags it does not take.
  process.exit(run(process.execPath, ["x", ...args.filter((a) => !BOOLEAN_FLAGS.has(a))]));
}
