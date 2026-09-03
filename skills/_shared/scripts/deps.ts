#!/usr/bin/env bun
/**
 * deps.ts — `nrv deps`: one home for every dependency the engine installs.
 *
 * The policy lives in `_shared/lib/deps-home.ts`; this is the door to it. It
 * exists because there was none: activating a squad wrote a full node_modules
 * into that squad's directory, nothing pinned the browser and model caches, and
 * an agent asked to run a squad script had no command to reach for — so it did
 * the obvious thing and ran `bun install` wherever it happened to be standing.
 *
 * Usage:
 *   nrv deps                       # status: the store, the caches, what is scattered
 *   nrv deps scan                  # every dependency tree that is NOT the store
 *   nrv deps adopt [--apply]       # fold scattered trees into the store, then link
 *   nrv deps link <slug|dir>       # point one directory at the store
 *   nrv deps install <pkg…>        # add packages to the store
 *   nrv deps env [--export]        # the environment that keeps tools inside ~/.nirvana
 *
 * Flags: --json (machine output) · --apply (perform, otherwise dry-run) · --all
 *
 * Exit codes: 0 ok · 1 something failed · 2 scattered trees found (scan/status)
 *             4 invalid arguments
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  depsStore, depsManifest, depsCache, pythonHome, nirvanaHome, depsEnv,
  ensureDepsHome, install, link, findStrays, defaultScanRoots, dirSize, human,
  type Stray,
} from "../lib/deps-home.ts";

const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m" };
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.filter((a) => !a.startsWith("--"));
const cmd = positional[0] || "status";
const json = flags.has("--json");
const apply = flags.has("--apply");
const noColor = flags.has("--no-color") || !process.stdout.isTTY;
const c = (color: keyof typeof ANSI, s: string) => (noColor ? s : `${ANSI[color]}${s}${ANSI.reset}`);

const EXIT = { OK: 0, FAILED: 1, SCATTER: 2, INVALID: 4 };

function out(obj: unknown, text: () => void): void {
  if (json) console.log(JSON.stringify(obj, null, 2));
  else text();
}

function storeFacts() {
  const store = depsStore();
  const exists = fs.existsSync(store);
  let packages = 0;
  if (exists) {
    try {
      for (const e of fs.readdirSync(store, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith("@")) {
          try { packages += fs.readdirSync(path.join(store, e.name)).length; } catch { /* skip */ }
        } else if (!e.name.startsWith(".")) packages++;
      }
    } catch { /* unreadable */ }
  }
  return { store, exists, packages, bytes: exists ? dirSize(store) : 0 };
}

function cacheFacts() {
  return ["puppeteer", "playwright", "huggingface", "pip"].map((t) => {
    const dir = depsCache(t);
    return { tool: t, dir, exists: fs.existsSync(dir), bytes: fs.existsSync(dir) ? dirSize(dir) : 0 };
  });
}

/** The package names a stray tree holds, so adopting it re-installs the same set. */
function packagesIn(tree: string): string[] {
  const names: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(tree, { withFileTypes: true }); } catch { return names; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === ".bin") continue;
    if (e.name.startsWith("@")) {
      try { for (const sub of fs.readdirSync(path.join(tree, e.name))) names.push(`${e.name}/${sub}`); } catch { /* skip */ }
    } else names.push(e.name);
  }
  return names;
}

/**
 * What a consumer DECLARES, which is what should end up in the store — not the
 * flattened transitive tree, which is 10x larger and whose versions the
 * resolver will pick again anyway.
 */
function declaredIn(dir: string): string[] {
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    return Object.entries(deps).map(([n, v]) => `${n}@${v}`);
  } catch { return []; }
}

// ─── status ──────────────────────────────────────────────────────────
if (cmd === "status") {
  const s = storeFacts();
  const caches = cacheFacts();
  const strays = findStrays(defaultScanRoots());
  const py = pythonHome();
  const payload = {
    home: nirvanaHome(),
    store: s,
    manifest: depsManifest(),
    python: { dir: py, exists: fs.existsSync(py), bytes: fs.existsSync(py) ? dirSize(py) : 0 },
    caches,
    strays: strays.map((x) => ({ ...x, size: human(x.bytes) })),
  };
  out(payload, () => {
    console.log(c("bold", "\nDependency home") + c("dim", `  ${nirvanaHome()}`));
    console.log(`  ${s.exists ? c("green", "✓") : c("red", "✗")} store      ${s.store}`);
    console.log(`    ${c("dim", `${s.packages} package(s) · ${human(s.bytes)}`)}`);
    console.log(`  ${fs.existsSync(py) ? c("green", "✓") : c("dim", "·")} python     ${py} ${c("dim", fs.existsSync(py) ? human(dirSize(py)) : "(empty)")}`);
    for (const ch of caches) {
      console.log(`  ${ch.exists ? c("green", "✓") : c("dim", "·")} cache/${ch.tool.padEnd(11)} ${c("dim", ch.exists ? human(ch.bytes) : "(empty)")}`);
    }
    if (strays.length === 0) {
      console.log(c("green", "\n  ✓ nothing installed outside the store\n"));
    } else {
      const total = strays.reduce((a, x) => a + x.bytes, 0);
      console.log(c("yellow", `\n  ⚠ ${strays.length} dependency tree(s) outside the store · ${human(total)}`));
      for (const x of strays.slice(0, 10)) console.log(`      ${human(x.bytes).padStart(7)}  ${x.dir}`);
      if (strays.length > 10) console.log(c("dim", `      … and ${strays.length - 10} more`));
      console.log(c("dim", "\n  Fold them in:  nrv deps adopt --apply\n"));
    }
  });
  process.exit(strays.length ? EXIT.SCATTER : EXIT.OK);
}

// ─── scan ────────────────────────────────────────────────────────────
if (cmd === "scan") {
  const roots = positional.slice(1).length ? positional.slice(1) : defaultScanRoots();
  const strays = findStrays(roots);
  out({ roots, strays: strays.map((x) => ({ ...x, size: human(x.bytes) })) }, () => {
    if (strays.length === 0) { console.log(c("green", `✓ no dependency tree outside the store under: ${roots.join(", ")}`)); return; }
    const total = strays.reduce((a, x) => a + x.bytes, 0);
    console.log(c("bold", `\n${strays.length} tree(s) outside the store · ${human(total)}\n`));
    for (const x of strays) console.log(`  ${human(x.bytes).padStart(7)}  ${c("dim", `${x.entries} pkg`)}  ${x.dir}`);
    console.log("");
  });
  process.exit(strays.length ? EXIT.SCATTER : EXIT.OK);
}

// ─── adopt ───────────────────────────────────────────────────────────
if (cmd === "adopt") {
  const roots = positional.slice(1).length ? positional.slice(1) : defaultScanRoots();
  const strays = findStrays(roots);
  if (strays.length === 0) {
    out({ adopted: [], strays: [] }, () => console.log(c("green", "✓ nothing to adopt — every tree is already the store")));
    process.exit(EXIT.OK);
  }
  ensureDepsHome();
  const results: Array<Record<string, unknown>> = [];
  let failed = 0;
  for (const s of strays) {
    const consumer = path.dirname(s.dir);
    const declared = declaredIn(consumer);
    // No manifest to read: adopt what the tree actually holds at top level.
    const wanted = declared.length ? declared : packagesIn(s.dir);
    const entry: Record<string, unknown> = { consumer, tree: s.dir, size: human(s.bytes), packages: wanted.length, source: declared.length ? "package.json" : "tree" };
    if (!apply) {
      entry.action = "would_adopt";
      results.push(entry);
      continue;
    }
    const res = install(wanted);
    entry.install = res.status;
    if (res.warning) entry.warning = res.warning.split("\n")[0].slice(0, 160);
    if (res.status === "failed") { entry.error = res.error; failed++; results.push(entry); continue; }
    // Remove the tree, then link — in that order, because link() refuses to
    // overwrite a real directory (by design: it is somebody's install).
    try { fs.rmSync(s.dir, { recursive: true, force: true }); entry.removed = true; }
    catch (e) { entry.removed = false; entry.error = (e as Error).message; failed++; results.push(entry); continue; }
    entry.linked = link(consumer).status;
    results.push(entry);
  }
  out({ applied: apply, results }, () => {
    console.log(c("bold", `\n${apply ? "Adopted" : "Would adopt"} ${results.length} tree(s)\n`));
    for (const r of results) {
      const mark = r.error ? c("red", "✗") : c("green", "✓");
      console.log(`  ${mark} ${r.consumer}`);
      console.log(c("dim", `      ${r.size} · ${r.packages} declared package(s) from ${r.source}${r.linked ? ` · link: ${r.linked}` : ""}${r.error ? ` · ${r.error}` : ""}`));
      if (r.warning) console.log(c("yellow", `      note: ${r.warning}`));
    }
    if (!apply) console.log(c("dim", "\n  Dry run. Re-run with --apply to perform it.\n"));
    else console.log("");
  });
  process.exit(failed ? EXIT.FAILED : EXIT.OK);
}

// ─── link ────────────────────────────────────────────────────────────
if (cmd === "link") {
  const targets = positional.slice(1);
  if (targets.length === 0) { console.error("usage: nrv deps link <dir|slug> [...]"); process.exit(EXIT.INVALID); }
  const results = targets.map((t) => {
    const dir = fs.existsSync(t) ? path.resolve(t) : path.join(process.env.SQUADS_DIR || path.join(process.env.NIRVANA_HOME || process.env.HOME || "", "squads"), t);
    return { target: dir, ...link(dir) };
  });
  out({ results }, () => {
    for (const r of results) {
      const ok = r.status === "linked" || r.status === "already_linked";
      console.log(`  ${ok ? c("green", "✓") : c("yellow", "⚠")} ${r.status.padEnd(15)} ${r.target}`);
      if (r.status === "occupied") console.log(c("dim", "      a real node_modules is there — run: nrv deps adopt --apply"));
    }
  });
  process.exit(results.some((r) => r.status === "failed") ? EXIT.FAILED : EXIT.OK);
}

// ─── install ─────────────────────────────────────────────────────────
if (cmd === "install" || cmd === "add") {
  const pkgs = positional.slice(1);
  if (pkgs.length === 0) { console.error("usage: nrv deps install <pkg>[@version] [...]"); process.exit(EXIT.INVALID); }
  const res = install(pkgs, { dryRun: !apply && flags.has("--dry-run") });
  out(res, () => {
    if (res.status === "failed") console.error(c("red", `✗ ${res.error}`));
    else console.log(c("green", `✓ ${res.status} → ${depsStore()}`) + (res.added.length ? c("dim", `\n  added: ${res.added.join(", ")}`) : ""));
  });
  process.exit(res.status === "failed" ? EXIT.FAILED : EXIT.OK);
}

// ─── env ─────────────────────────────────────────────────────────────
if (cmd === "env") {
  const env = depsEnv({});
  out(env, () => {
    const prefix = flags.has("--export") ? "export " : "";
    for (const [k, v] of Object.entries(env)) console.log(`${prefix}${k}=${v}`);
  });
  process.exit(EXIT.OK);
}

console.error(`unknown sub-command: ${cmd}

usage:
  nrv deps [status]              the store, the caches, what is scattered
  nrv deps scan [root…]          every dependency tree that is NOT the store
  nrv deps adopt [--apply]       fold scattered trees into the store, then link
  nrv deps link <slug|dir>…      point a directory at the store
  nrv deps install <pkg>…        add packages to the store
  nrv deps env [--export]        the environment that keeps tools inside ~/.nirvana`);
process.exit(EXIT.INVALID);
