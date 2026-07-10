#!/usr/bin/env bun
/**
 * build-free-edition.ts — produce the @nirvana-os/cli npm package (the LAUNCHER).
 *
 * The npm package is a thin Node bootstrap that, at run time, downloads the
 * engine from GitHub (latest release asset) and installs it. It carries NO
 * engine bytes and NO content — so the engine ships updates by pushing to GitHub
 * and cutting a release; this npm package is published ONCE and (almost) never
 * republished (only when bin/cli.mjs logic itself changes).
 *
 * Output: dist/nirvana-os-cli/  (publishable with `npm publish --access public`)
 *   package.json   @nirvana-os/cli, bin { nirvana: bin/cli.mjs }, zero-dep
 *   bin/cli.mjs    the launcher
 *   README.md, LICENSE, NOTICE
 *
 * The engine release asset is built separately by build-engine-tarball.ts.
 *
 * Usage: bun scripts/build-free-edition.ts [outDir]
 */
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Launcher version is independent of the engine version — it bumps only when
// bin/cli.mjs changes. Engine/content updates never touch npm.
const LAUNCHER_VERSION = "1.0.1";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(SCRIPT_DIR, "..");
const OUT = resolve(process.argv[2] ?? join(SRC, "dist", "nirvana-os-cli"));
const PKG_SRC = join(SRC, "packaging", "cli");

console.log("Building @nirvana-os/cli (launcher — engine fetched from GitHub at run time)");
console.log(`  src: ${SRC}`);
console.log(`  out: ${OUT}`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "bin"), { recursive: true });

cpSync(join(PKG_SRC, "bin", "cli.mjs"), join(OUT, "bin", "cli.mjs"));
if (existsSync(join(PKG_SRC, "README.md"))) cpSync(join(PKG_SRC, "README.md"), join(OUT, "README.md"));
for (const f of ["LICENSE", "NOTICE"]) if (existsSync(join(SRC, f))) cpSync(join(SRC, f), join(OUT, f));

const repoPkg = JSON.parse(readFileSync(join(SRC, "package.json"), "utf8"));
const outerPkg = {
  name: "@nirvana-os/cli",
  version: LAUNCHER_VERSION,
  description:
    "Nirvana-OS installer — fetches the latest engine from GitHub and installs it across Claude Code, Codex, Gemini-CLI, Antigravity and Hermes. Paid packs (squads, businesses, mind-clones) install on top via squads.sh.",
  type: "module",
  bin: { nirvana: "bin/cli.mjs" },
  license: "SEE LICENSE IN LICENSE",
  author: repoPkg.author,
  homepage: repoPkg.homepage,
  publishConfig: { access: "public" },
  engines: { node: ">=18" },
  files: ["bin", "README.md", "LICENSE", "NOTICE"],
  keywords: repoPkg.keywords,
};
writeFileSync(join(OUT, "package.json"), JSON.stringify(outerPkg, null, 2) + "\n");
writeFileSync(join(OUT, ".npmignore"), ["**/.DS_Store", ""].join("\n"));

console.log(`\nBuilt @nirvana-os/cli@${LAUNCHER_VERSION}`);
console.log(`  bin/cli.mjs: ${existsSync(join(OUT, "bin", "cli.mjs")) ? "ok" : "MISSING"}`);
console.log(`  engine:      fetched from GitHub at run time (not bundled)`);
console.log("\nOK.");
