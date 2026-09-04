// preflight-index.test.ts — routing-360 Phase 2.5 route-entrypoint pre-flight.
//
// find.ts / route.ts / dispatch.ts call preflightReindex() before routing:
// stale registries trigger a synchronous `index.ts --if-stale --quiet`,
// fresh registries cost mtime stats only (<50ms budget). The probe spawns a
// child process with a fixture HOME + env-pinned roots/registry paths, so the
// real path resolution chain (paths.js + scope.ts + index.ts) is exercised
// end-to-end.
//
// Runs with: bun test skills/harness/tests
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { TEARDOWN_BUDGET_MS } from "./helpers/test-budgets.ts";

const REPO_SKILLS = path.join(import.meta.dir, "..", "..");
const INDEX_TS = path.join(import.meta.dir, "..", "scripts", "index.ts");
const PREFLIGHT_TS = path.join(import.meta.dir, "..", "lib", "preflight-index.ts");

let home: string;
let work: string;
let probe: string;

function fixtureEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env.NIRVANA_PROJECT_ROOT;
  delete env.NRV_IN_PREFLIGHT;
  delete env.NRV_PREFLIGHT;
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,   // os.homedir() follows USERPROFILE on Windows
    NIRVANA_HOME: home,
    NIRVANA_SKILLS_DIR: REPO_SKILLS,
    NIRVANA_SCOPE_QUIET: "1",
    SQUADS_DIR: path.join(home, "squads"),
    SQUADS_LEGACY_DIR: path.join(home, "squads-legacy"),
    BUSINESSES_DIR: path.join(home, "businesses"),
    DNA_LIBRARY: path.join(home, "dna"),
    SQUADS_REGISTRY_PATH: path.join(home, ".squads-registry.json"),
    BUSINESSES_REGISTRY_PATH: path.join(home, ".businesses-registry.json"),
    ...extra,
  };
}

const squadsRegistryPath = () => path.join(home, ".squads-registry.json");
const registryPaths = () => [
  squadsRegistryPath(),
  path.join(home, ".businesses-registry.json"),
  path.join(home, ".nirvana", ".mind-clones-registry.json"),
];

function runProbe(extraEnv: Record<string, string> = {}): { ran: boolean; ms: number } {
  const r = spawnSync(process.execPath, [probe], {
    encoding: "utf8", env: fixtureEnv(extraEnv), cwd: work, timeout: 60_000,
  });
  expect(r.status).toBe(0);
  return JSON.parse((r.stdout || "").trim().split("\n").pop()!);
}

const at = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000);

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-preflight-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-preflight-work-"));

  fs.mkdirSync(path.join(home, "squads", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(home, "squads", "alpha", "squad.yaml"), [
    "name: alpha",
    "version: 1.0.0",
    'protocol: "5.0"',
    "description: A fixture squad for the route-entrypoint pre-flight test.",
    "capabilities: []",
    "",
  ].join("\n"));
  fs.mkdirSync(path.join(home, "businesses"), { recursive: true });
  fs.mkdirSync(path.join(home, "dna", "clone-x"), { recursive: true });
  fs.writeFileSync(path.join(home, "dna", "clone-x", "MANIFEST.yaml"), "slug: clone-x\n");

  probe = path.join(work, "preflight-probe.ts");
  fs.writeFileSync(probe, [
    `import { preflightReindex } from ${JSON.stringify(PREFLIGHT_TS)};`,
    "const t0 = performance.now();",
    "const ran = preflightReindex();",
    "console.log(JSON.stringify({ ran, ms: performance.now() - t0 }));",
    "",
  ].join("\n"));

  // Seed all three registries once with the real indexers.
  const seed = spawnSync(process.execPath, [INDEX_TS, "--quiet"], {
    encoding: "utf8", env: fixtureEnv(), cwd: work, timeout: 120_000,
  });
  if (seed.status !== 0) {
    throw new Error(`fixture seed index failed (exit ${seed.status}): ${seed.stderr}`);
  }
  for (const reg of registryPaths()) {
    if (!fs.existsSync(reg)) throw new Error(`fixture seed did not write ${reg}`);
  }
});

afterAll(() => {
  for (const d of [home, work]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}, TEARDOWN_BUDGET_MS);

describe("route-entrypoint pre-flight (routing-360 Phase 2.5)", () => {
  test("fresh registries: no reindex, check under the 50ms budget", () => {
    // Registries strictly newer than every manifest → fresh.
    for (const reg of registryPaths()) fs.utimesSync(reg, at(60), at(60));
    const before = fs.readFileSync(squadsRegistryPath(), "utf8");
    const { ran, ms } = runProbe();
    expect(ran).toBe(false);
    expect(ms).toBeLessThan(50);
    expect(fs.readFileSync(squadsRegistryPath(), "utf8")).toBe(before);
  }, 60_000);

  test("stale squads registry: pre-flight reindexes before routing", () => {
    // A squad.yaml newer than the (future-dated) registry → stale.
    fs.utimesSync(path.join(home, "squads", "alpha", "squad.yaml"), at(120), at(120));
    const beforeGeneratedAt = JSON.parse(fs.readFileSync(squadsRegistryPath(), "utf8")).generated_at;
    const { ran } = runProbe();
    expect(ran).toBe(true);
    const afterGeneratedAt = JSON.parse(fs.readFileSync(squadsRegistryPath(), "utf8")).generated_at;
    expect(afterGeneratedAt).not.toBe(beforeGeneratedAt);
  }, 60_000);

  test("recursion guard: NRV_IN_PREFLIGHT=1 short-circuits even when stale", () => {
    // The squads registry is still older than the future-dated squad.yaml.
    const { ran } = runProbe({ NRV_IN_PREFLIGHT: "1" });
    expect(ran).toBe(false);
  }, 60_000);

  test("opt-out: NRV_PREFLIGHT=0 short-circuits even when stale", () => {
    const { ran } = runProbe({ NRV_PREFLIGHT: "0" });
    expect(ran).toBe(false);
  }, 60_000);
});
