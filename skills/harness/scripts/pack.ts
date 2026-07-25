#!/usr/bin/env bun
// pack.ts — package a business / squad / mind-clone for distribution.
//
// Usage:
//   nrv pack create <source-dir>              # auto-detect kind, create tarball
//   nrv pack create <source-dir> --kind=squad
//   nrv pack create <source-dir> --output=./dist/
//   nrv pack create <source-dir> --sign       # placeholder for future GPG sign
//   nrv pack inspect <pack.tgz>               # show manifest of a pack
//   nrv pack publish <pack.tgz> --to=github  # placeholder (no domain yet)
//
// What it does:
//   1. Detect kind (business/squad/mind-clone) by looking for manifest files
//   2. Validate the source dir using the appropriate schema
//   3. Create a tarball: <slug>-<version>.tgz with sha256 sum
//   4. Write a pack.json manifest with kind, slug, version, sha256, files
//
// Output structure:
//   <slug>-<version>.tgz                       # the asset
//   <slug>-<version>.tgz.sha256                # checksum
//   <slug>-<version>.pack.json                 # metadata for nrv install <pack.tgz>

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";

const ANSI = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", lime: "\x1b[38;5;154m",
};
const noColor = process.argv.includes("--no-color") || !process.stdout.isTTY;
function c(color: keyof typeof ANSI, s: string): string {
  return noColor ? s : `${ANSI[color]}${s}${ANSI.reset}`;
}

const args = process.argv.slice(2);
const sub = args[0];
const positional = args.slice(1).filter(a => !a.startsWith("--"));
const flags = args.filter(a => a.startsWith("--"));
function flag(name: string, fallback?: string): string | undefined {
  const f = flags.find(x => x === name || x.startsWith(`${name}=`));
  if (!f) return fallback;
  return f.includes("=") ? f.split("=").slice(1).join("=") : (positional[positional.indexOf(f) + 1] || fallback);
}

if (!sub || !["create", "inspect", "publish"].includes(sub)) {
  console.error("Uso: nrv pack <create|inspect|publish> ...");
  console.error("");
  console.error("  create <source-dir> [--kind=business|squad|mind-clone] [--output=dir] [--sign]");
  console.error("  inspect <pack.tgz>");
  console.error("  publish <pack.tgz> --to=github       (creates GitHub release asset)");
  console.error("  publish <pack.tgz> --to=local        (just copies to ~/.nirvana/packs/)");
  process.exit(2);
}

function detectKind(dir: string): "business" | "squad" | "mind-clone" | null {
  if (fs.existsSync(path.join(dir, "business.yaml"))) return "business";
  if (fs.existsSync(path.join(dir, "squad.yaml"))) return "squad";
  if (fs.existsSync(path.join(dir, "MANIFEST.yaml"))) return "mind-clone";
  return null;
}

function readManifest(dir: string, kind: string): { slug: string; version: string } | null {
  let manifestPath: string;
  if (kind === "business") manifestPath = path.join(dir, "business.yaml");
  else if (kind === "squad") manifestPath = path.join(dir, "squad.yaml");
  else manifestPath = path.join(dir, "MANIFEST.yaml");
  if (!fs.existsSync(manifestPath)) return null;
  const content = fs.readFileSync(manifestPath, "utf8");
  const nameMatch = content.match(/^\s*(?:name|slug):\s*['"]?([^\s'"\n]+)/m);
  const versionMatch = content.match(/^\s*version:\s*['"]?([^\s'"\n]+)/m);
  return {
    slug: nameMatch?.[1] || path.basename(dir),
    version: versionMatch?.[1] || "0.0.0",
  };
}

if (sub === "create") {
  const sourceDir = positional[0];
  if (!sourceDir || !fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    console.error(c("red", "ERRO: source-dir inválido"));
    console.error("Uso: nrv pack create <source-dir> [--kind=...] [--output=...]");
    process.exit(2);
  }
  const explicitKind = flag("--kind");
  const kind = (explicitKind as any) || detectKind(sourceDir);
  if (!kind) {
    console.error(c("red", `ERRO: não consegui detectar kind em ${sourceDir}`));
    console.error("Esperava encontrar business.yaml, squad.yaml ou MANIFEST.yaml");
    process.exit(1);
  }
  const manifest = readManifest(sourceDir, kind);
  if (!manifest) {
    console.error(c("red", "ERRO: manifest inválido ou ausente"));
    process.exit(1);
  }

  const outputDir = flag("--output", "./dist") || "./dist";
  fs.mkdirSync(outputDir, { recursive: true });
  const tarballName = `${manifest.slug}-${manifest.version}.tgz`;
  const tarballPath = path.join(outputDir, tarballName);

  console.log("");
  console.log(c("lime", "▶") + c("bold", " nrv pack create"));
  console.log(c("dim", `  source: ${sourceDir}`));
  console.log(c("dim", `  kind:   ${kind}`));
  console.log(c("dim", `  slug:   ${manifest.slug}`));
  console.log(c("dim", `  version: ${manifest.version}`));
  console.log("");

  // Create tarball using `tar`
  const parent = path.resolve(sourceDir, "..");
  const basename = path.basename(sourceDir);
  console.log(c("lime", "▶") + " Creating tarball...");
  // tar com cwd + paths relativos: um path absoluto do Windows (C:\...) tem ":"
  // e o GNU tar do Git Bash o trata como host remoto. cwd = parent dispensa o -C.
  const absOut = path.resolve(tarballPath);
  const relOutRaw = path.relative(parent, absOut);
  const relOut = (relOutRaw === "" || relOutRaw.includes(":") ? absOut : relOutRaw).split(path.sep).join("/");
  const tar = spawnSync(
    "tar",
    ["-czf", relOut, basename],
    { encoding: "utf8", cwd: parent }
  );
  if (tar.status !== 0) {
    console.error(c("red", "✗ tar failed:"));
    console.error(tar.stderr);
    process.exit(1);
  }
  const tarStat = fs.statSync(tarballPath);
  console.log(c("dim", `  ${tarballPath} (${(tarStat.size / 1024).toFixed(1)} KB)`));

  // Compute sha256
  const buf = fs.readFileSync(tarballPath);
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  fs.writeFileSync(`${tarballPath}.sha256`, `${hash}  ${tarballName}\n`);
  console.log(c("dim", `  sha256: ${hash.slice(0, 16)}...`));

  // Count files
  let fileCount = 0;
  let totalBytes = 0;
  function walk(d: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        fileCount++;
        try { totalBytes += fs.statSync(p).size; } catch {}
      }
    }
  }
  walk(sourceDir);

  // pack.json manifest
  const packJson = {
    kind,
    slug: manifest.slug,
    version: manifest.version,
    tarball: tarballName,
    sha256: hash,
    size_bytes: tarStat.size,
    file_count: fileCount,
    source_bytes: totalBytes,
    created_at: new Date().toISOString(),
    nirvana_os_version: "0.5+",
  };
  const packJsonPath = path.join(outputDir, `${manifest.slug}-${manifest.version}.pack.json`);
  fs.writeFileSync(packJsonPath, JSON.stringify(packJson, null, 2));

  // Audit
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(harnessLogsDir(), today);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify({
      ts: new Date().toISOString(),
      event: "pack_created",
      kind,
      slug: manifest.slug,
      version: manifest.version,
      sha256: hash,
      tarball: tarballPath,
    }) + "\n");
  } catch {}

  console.log("");
  console.log(c("green", "✓ Pack created:"));
  console.log(`  ${tarballPath}`);
  console.log(`  ${tarballPath}.sha256`);
  console.log(`  ${packJsonPath}`);
  console.log("");
  console.log(c("dim", "To install on another machine:"));
  console.log("  " + c("yellow", `nrv install ${tarballPath}`));
  process.exit(0);
}

if (sub === "inspect") {
  const tgz = positional[0];
  if (!tgz || !fs.existsSync(tgz)) {
    console.error(c("red", "ERRO: tarball não encontrado"));
    process.exit(2);
  }
  console.log("");
  console.log(c("lime", "▶") + c("bold", " nrv pack inspect"));
  console.log(c("dim", `  file: ${tgz}`));
  console.log("");

  // List contents (cwd + basename: path absoluto do Windows tem ":" e o GNU tar
  // do Git Bash o trata como host remoto)
  const listing = spawnSync("tar", ["-tzf", path.basename(tgz)], { encoding: "utf8", cwd: path.dirname(path.resolve(tgz)) });
  if (listing.status !== 0) {
    console.error(c("red", "✗ tar listing failed"));
    process.exit(1);
  }
  const files = listing.stdout.split("\n").filter(l => l.trim());
  console.log(c("cyan", `  ${files.length} files:`));
  for (const f of files.slice(0, 30)) {
    console.log("    " + c("dim", f));
  }
  if (files.length > 30) console.log(c("dim", `    ... +${files.length - 30} more`));

  // Compute checksum
  const buf = fs.readFileSync(tgz);
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  console.log("");
  console.log(c("dim", `  sha256: ${hash}`));
  console.log(c("dim", `  size:   ${(fs.statSync(tgz).size / 1024).toFixed(1)} KB`));

  // Try to find pack.json sibling
  const sibling = tgz.replace(/\.tgz$/, ".pack.json");
  if (fs.existsSync(sibling)) {
    console.log("");
    console.log(c("cyan", "  pack.json:"));
    try {
      const data = JSON.parse(fs.readFileSync(sibling, "utf8"));
      for (const [k, v] of Object.entries(data)) {
        console.log(`    ${k.padEnd(20)} ${v}`);
      }
    } catch {}
  }
  process.exit(0);
}

if (sub === "publish") {
  const tgz = positional[0];
  const to = flag("--to", "local") || "local";
  if (!tgz || !fs.existsSync(tgz)) {
    console.error(c("red", "ERRO: tarball não encontrado"));
    process.exit(2);
  }

  if (to === "local") {
    const dest = path.join(os.homedir(), ".nirvana/packs");
    fs.mkdirSync(dest, { recursive: true });
    const target = path.join(dest, path.basename(tgz));
    fs.copyFileSync(tgz, target);
    // also copy sibling files
    const sha = `${tgz}.sha256`;
    const meta = tgz.replace(/\.tgz$/, ".pack.json");
    if (fs.existsSync(sha)) fs.copyFileSync(sha, path.join(dest, path.basename(sha)));
    if (fs.existsSync(meta)) fs.copyFileSync(meta, path.join(dest, path.basename(meta)));
    console.log("");
    console.log(c("green", "✓ Published locally"));
    console.log(c("dim", `  ${target}`));
    console.log("");
    console.log(c("dim", "Share via:"));
    console.log("  " + c("yellow", `scp ${target} user@host:~/`));
    console.log("  " + c("yellow", `# or upload to GitHub release assets`));
    process.exit(0);
  }

  if (to === "github") {
    console.log("");
    console.log(c("yellow", "  GitHub release publication"));
    console.log("");
    console.log(c("dim", "  Requires `gh` CLI authenticated. To create a release with this pack:"));
    console.log("");
    console.log("    " + c("yellow", `gh release create v<version> ${tgz} ${tgz}.sha256`));
    console.log("");
    console.log(c("dim", "  No automated GitHub publish yet — running gh CLI manually keeps you in control of release notes."));
    process.exit(0);
  }

  if (to === "npm") {
    console.log("");
    console.log(c("yellow", "  npm publish — not implemented yet"));
    console.log("");
    console.log(c("dim", "  Roadmap: nrv pack publish --to=npm will wrap `npm publish` after generating a package.json"));
    console.log(c("dim", "  with the right metadata. For now, use --to=local + scp, or --to=github."));
    process.exit(0);
  }

  console.error(c("red", `ERRO: --to=${to} desconhecido. Use local | github | npm`));
  process.exit(2);
}
