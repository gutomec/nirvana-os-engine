#!/usr/bin/env bun
/**
 * check-published-packs.ts — is what buyers can download right now the thing we
 * think we published?
 *
 * On 2026-08-08 every base zip was rebuilt. On 2026-08-13 the installer inside
 * them was fixed. For a day, fifteen of the sixteen packs on sale shipped an
 * installer that never installed a license, and nothing anywhere knew. The
 * builder copies packaging/pack/setup.* at build time and records nothing about
 * which version that was, so the drift is invisible unless someone hashes it —
 * which nothing did.
 *
 * This hashes it. For each product it downloads the base artifact and asserts:
 *
 *   1. setup.ts is byte-identical to the engine's current packaging/pack/setup.ts
 *   2. setup.sh and setup.ps1 likewise
 *   3. zero watermark markers (a contaminated base attributes every buyer's
 *      leak to the owner)
 *   4. no PROVENANCE.json / LICENSE.txt — those are injected per buyer at
 *      download time and must never live in a base
 *   5. no engine leak (skills/ or bin/ in a content pack)
 *   6. pack.yaml declares the expected slug
 *   7. component counts match the composition the storefront advertises
 *
 * Usage:
 *   bun scripts/check-published-packs.ts                  # every product
 *   bun scripts/check-published-packs.ts genesis-circle   # one
 *   bun scripts/check-published-packs.ts --strict         # exit 1 on any drift
 *
 * Credentials come from the environment, so this runs anywhere the bucket is
 * reachable:
 *   NIRVANA_ARTIFACTS_URL   base URL of the storage API
 *   NIRVANA_ARTIFACTS_KEY   bearer token
 *   NIRVANA_PRODUCTS_FILE   path to squads-sh-v2's product.ts (for the catalog)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO = new URL("..", import.meta.url).pathname;
const RED = "\x1b[31m", GRN = "\x1b[32m", YEL = "\x1b[33m", DIM = "\x1b[2m", RST = "\x1b[0m";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const only = args.filter((a) => !a.startsWith("-"));

const ARTIFACTS_URL = process.env.NIRVANA_ARTIFACTS_URL || "https://squads.sh/storage/v1/object/nirvana-artifacts";
const ARTIFACTS_KEY = process.env.NIRVANA_ARTIFACTS_KEY || "";
const PRODUCTS_FILE = process.env.NIRVANA_PRODUCTS_FILE
  || join(homedir(), "squads-sh-v2", "apps", "web", "lib", "nirvana", "product.ts");

interface Product { slug: string; version: string; basePath: string; squads: number; businesses: number; clones: number; storefrontPath: string | null; }

/**
 * Parse the catalog out of product.ts. Reading the TypeScript rather than
 * importing it keeps this script runnable without the storefront's dependency
 * tree — and the storefront is a separate private repo.
 */
function readProducts(): Product[] {
  if (!existsSync(PRODUCTS_FILE)) {
    console.error(`${RED}product catalog not found: ${PRODUCTS_FILE}${RST}`);
    console.error(`${DIM}set NIRVANA_PRODUCTS_FILE to squads-sh-v2/apps/web/lib/nirvana/product.ts${RST}`);
    process.exit(2);
  }
  const src = readFileSync(PRODUCTS_FILE, "utf8");
  const out: Product[] = [];
  for (const m of src.matchAll(/"([a-z0-9-]+)":\s*\{([\s\S]*?)\n {2}\},/g)) {
    const [, slug, body] = m;
    const version = body.match(/version:\s*"([^"]+)"/)?.[1];
    const basePath = body.match(/baseArtifactPath:\s*"([^"]+)"/)?.[1];
    const comp = body.match(/composition:\s*\{\s*squads:\s*(\d+),\s*businesses:\s*(\d+),\s*mindClones:\s*(\d+)/);
    if (!version || !basePath) continue;
    out.push({
      slug, version, basePath,
      storefrontPath: body.match(/storefrontPath:\s*"([^"]+)"/)?.[1] ?? null,
      squads: comp ? Number(comp[1]) : -1,
      businesses: comp ? Number(comp[2]) : -1,
      clones: comp ? Number(comp[3]) : -1,
    });
  }
  return out;
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Same six extensions and three tag shapes the watermarker emits. */
const WM = {
  ".md": /^\[\/\/\]: # \([A-Za-z0-9_-]{22}\)$/,
  ".markdown": /^\[\/\/\]: # \([A-Za-z0-9_-]{22}\)$/,
  ".yaml": /^#[A-Za-z0-9_-]{22}$/,
  ".yml": /^#[A-Za-z0-9_-]{22}$/,
  ".ts": /^\/\/[A-Za-z0-9_-]{22}$/,
  ".js": /^\/\/[A-Za-z0-9_-]{22}$/,
} as const;

async function fetchBase(basePath: string, dest: string): Promise<boolean> {
  const headers: Record<string, string> = {};
  if (ARTIFACTS_KEY) headers.Authorization = `Bearer ${ARTIFACTS_KEY}`;
  try {
    const r = await fetch(`${ARTIFACTS_URL}/${basePath}`, { headers });
    if (!r.ok) { console.log(`    ${RED}download failed: HTTP ${r.status}${RST}`); return false; }
    writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    return true;
  } catch (e) {
    console.log(`    ${RED}download failed: ${(e as Error).message}${RST}`);
    return false;
  }
}

/** Read the zip with python3 — no dependency, present on every platform CI uses. */
function inspectZip(zip: string): { names: string[]; read: (p: string) => Buffer } {
  const r = spawnSync("python3", ["-c", `
import zipfile, sys, json
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps(z.namelist()))
`, zip], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cannot read zip: ${r.stderr}`);
  const names: string[] = JSON.parse(r.stdout);
  const read = (p: string): Buffer => {
    const g = spawnSync("python3", ["-c", `
import zipfile, sys
sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))
`, zip, p], { encoding: "buffer" });
    if (g.status !== 0) throw new Error(`cannot read ${p} from zip`);
    return g.stdout as unknown as Buffer;
  };
  return { names, read };
}

interface Finding { slug: string; problem: string; }

async function checkProduct(p: Product, expected: Record<string, string>): Promise<Finding[]> {
  const found: Finding[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "nrv-pack-check-"));
  const zip = join(tmp, "base.zip");
  try {
    if (!(await fetchBase(p.basePath, zip))) return [{ slug: p.slug, problem: `base artifact unreachable at ${p.basePath}` }];
    const { names, read } = inspectZip(zip);

    // 1-2. The installer must be the one this engine ships.
    for (const [file, want] of Object.entries(expected)) {
      const hit = names.find((n) => n === file);
      if (!hit) { found.push({ slug: p.slug, problem: `${file} missing from the base` }); continue; }
      const got = sha(read(hit));
      if (got !== want) {
        found.push({ slug: p.slug, problem: `${file} is not the engine's current one (${got.slice(0, 12)} != ${want.slice(0, 12)})` });
      }
    }

    // 3. Watermark markers.
    let marked = 0;
    for (const n of names) {
      const ext = n.slice(n.lastIndexOf("."));
      const re = (WM as Record<string, RegExp>)[ext];
      if (!re || n.includes("/node_modules/")) continue;
      const lines = read(n).toString("utf8").split("\n");
      if (lines.some((l) => re.test(l.trimEnd()))) marked++;
    }
    if (marked > 0) found.push({ slug: p.slug, problem: `${marked} watermarked file(s) — this base would attribute every buyer's leak to the owner` });

    // 4. Per-buyer markers. The stripper cannot see these two.
    for (const marker of ["PROVENANCE.json", "LICENSE.txt"]) {
      if (names.some((n) => n.endsWith(marker))) found.push({ slug: p.slug, problem: `${marker} in the base — that is injected per buyer` });
    }

    // 5. Engine leak.
    for (const d of ["skills/", "bin/"]) {
      if (names.some((n) => n.startsWith(d))) found.push({ slug: p.slug, problem: `engine leak: ${d} in a content pack` });
    }

    // 6. pack.yaml slug.
    const py = names.find((n) => n === "pack.yaml");
    if (!py) found.push({ slug: p.slug, problem: "pack.yaml missing" });
    else {
      const declared = read(py).toString("utf8").match(/^slug:\s*(\S+)/m)?.[1];
      if (declared !== p.slug) found.push({ slug: p.slug, problem: `pack.yaml declares slug '${declared}'` });
    }

    // 7. Composition. A count that drifts from what the storefront advertises is
    //    either a build that lost content or a sales page that overstates it.
    if (p.squads >= 0) {
      const count = (kind: string) => {
        const pre = `starter-pack/${kind}/`;
        const tops = new Set<string>();
        for (const n of names) {
          if (!n.startsWith(pre) || n.length <= pre.length) continue;
          const seg = n.slice(pre.length).split("/")[0];
          // Only directories count — a README.md at that level is not a component.
          if (seg && n.slice(pre.length).includes("/")) tops.add(seg);
        }
        return tops.size;
      };
      const actual = { squads: count("squads"), businesses: count("businesses"), clones: count("mind-clones") };
      for (const k of ["squads", "businesses", "clones"] as const) {
        if (actual[k] !== p[k]) found.push({ slug: p.slug, problem: `${k}: base has ${actual[k]}, product.ts advertises ${p[k]}` });
      }
    }
    return found;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 8. the LIVE page says what the catalog says.
 *
 * Item 7 compares the bucket against product.ts ON DISK — which approved a day
 * where the deploy never landed: composition was corrected and deployed, the
 * runner's ssh timed out before the build step, and the page kept advertising
 * 42/11/159 in six languages while every check here stayed green. The only
 * thing that caught it was fetching the page and reading it. So the gate does
 * exactly that: for every product with its own storefront page, the served
 * HTML must contain the catalog's version and its three composition counts.
 *
 * Pure so it can be tested by planting a stale page; the fetch wiring stays
 * thin. Exported for the test.
 */
export function livePageFindings(p: Product, html: string): string[] {
  const out: string[] = [];
  if (!html.includes(p.version)) out.push(`live page does not mention v${p.version} — the deploy may not have landed`);
  for (const [label, n] of [["squads", p.squads], ["businesses", p.businesses], ["mind-clones", p.clones]] as const) {
    if (n >= 0 && !new RegExp(`(?<!\\d)${n}(?!\\d)`).test(html)) {
      out.push(`live page never shows the count ${n} (${label}) the catalog declares`);
    }
  }
  return out;
}

const STOREFRONT_URL = process.env.NIRVANA_STOREFRONT_URL || "https://squads.sh";
async function checkLivePage(p: Product): Promise<Finding[]> {
  if (!p.storefrontPath) return [];
  try {
    const r = await fetch(`${STOREFRONT_URL}${p.storefrontPath}`, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return [{ slug: p.slug, problem: `live page ${p.storefrontPath}: HTTP ${r.status}` }];
    return livePageFindings(p, await r.text()).map((problem) => ({ slug: p.slug, problem }));
  } catch (e) {
    return [{ slug: p.slug, problem: `live page unreachable: ${String(e).slice(0, 80)}` }];
  }
}

// CLI entry — guarded so the pure helpers above stay importable by tests
// without running sixteen network fetches at import time.
if (import.meta.main) {
  const packDir = join(REPO, "packaging", "pack");
  const expected: Record<string, string> = {};
  for (const f of ["setup.ts", "setup.sh", "setup.ps1"]) {
    const p = join(packDir, f);
    if (!existsSync(p)) { console.error(`${RED}engine is missing packaging/pack/${f}${RST}`); process.exit(2); }
    expected[f] = sha(readFileSync(p));
  }

  const products = readProducts().filter((p) => only.length === 0 || only.includes(p.slug));
  if (products.length === 0) { console.error(`${RED}no matching product${RST}`); process.exit(2); }

  console.log(`\nPUBLISHED PACKS — do the bases carry this engine's installer?`);
  console.log(`${DIM}  engine setup.ts: ${expected["setup.ts"].slice(0, 12)}  ·  ${products.length} product(s)${RST}\n`);

  const all: Finding[] = [];
  for (const p of products) {
    process.stdout.write(`  ${p.slug.padEnd(26)} v${p.version.padEnd(9)} `);
    const f = await checkProduct(p, expected);
    f.push(...await checkLivePage(p));
    all.push(...f);
    console.log(f.length === 0 ? `${GRN}ok${RST}` : `${RED}${f.length} problem(s)${RST}`);
    for (const x of f) console.log(`      ${YEL}${x.problem}${RST}`);
  }

  console.log();
  if (all.length === 0) {
    console.log(`${GRN}Every published base carries the current installer.${RST}\n`);
    process.exit(0);
  }
  const stale = new Set(all.map((f) => f.slug));
  console.log(`${RED}${all.length} problem(s) across ${stale.size} pack(s): ${[...stale].join(", ")}${RST}`);
  console.log(`${DIM}Rebuild and republish those bases. A pack whose setup.ts predates the engine${RST}`);
  console.log(`${DIM}is a pack whose buyers get whatever bug that installer had.${RST}\n`);
  process.exit(strict ? 1 : 0);
}
