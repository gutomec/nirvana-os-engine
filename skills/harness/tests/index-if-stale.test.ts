// index-if-stale.test.ts — regression for `nrv index --if-stale`.
//
// The staleness comparison is a pure helper pair exported from
// scripts/index.ts (the indexer scripts themselves take roots from scope/env,
// so the helpers are tested directly with temp-dir fixtures):
//   newestManifestMtime(roots, names, depth) — newest mtime among root dirs,
//     asset dirs and manifest files (-1 when nothing exists);
//   registryIsFresh(registryPath, newest)    — fresh iff the registry exists
//     and is strictly newer than every manifest.
// Runs with: bun test skills/harness/tests
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { newestManifestMtime, registryIsFresh } from "../scripts/index.ts";

let tmp: string;
let root: string;
let registry: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-ifstale-"));
  root = path.join(tmp, "squads");
  registry = path.join(tmp, ".squads-registry.json");
  fs.mkdirSync(path.join(root, "alpha"), { recursive: true });
  fs.writeFileSync(path.join(root, "alpha", "squad.yaml"), "name: alpha\n");
});

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

const at = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000);

describe("nrv index --if-stale — staleness helpers", () => {
  test("missing registry is never fresh", () => {
    expect(registryIsFresh(path.join(tmp, "does-not-exist.json"), 0)).toBe(false);
  });

  test("registry newer than every manifest is fresh (skip)", () => {
    fs.writeFileSync(registry, "{}");
    fs.utimesSync(registry, at(60), at(60)); // registry 60s in the future
    const newest = newestManifestMtime([root], ["squad.yaml"]);
    expect(newest).toBeGreaterThan(0);
    expect(registryIsFresh(registry, newest)).toBe(true);
  });

  test("a manifest edited after the registry write makes it stale (reindex)", () => {
    fs.writeFileSync(registry, "{}");
    fs.utimesSync(registry, at(60), at(60));
    fs.utimesSync(path.join(root, "alpha", "squad.yaml"), at(120), at(120));
    const newest = newestManifestMtime([root], ["squad.yaml"]);
    expect(registryIsFresh(registry, newest)).toBe(false);
  });

  test("adding a new asset dir after the registry write makes it stale", () => {
    fs.writeFileSync(registry, "{}");
    fs.utimesSync(registry, at(60), at(60));
    fs.mkdirSync(path.join(root, "beta"));
    fs.writeFileSync(path.join(root, "beta", "squad.yaml"), "name: beta\n");
    fs.utimesSync(path.join(root, "beta"), at(120), at(120));
    fs.utimesSync(path.join(root, "beta", "squad.yaml"), at(120), at(120));
    const newest = newestManifestMtime([root], ["squad.yaml"]);
    expect(registryIsFresh(registry, newest)).toBe(false);
  });

  test("no manifests at all (-1) leaves an existing registry fresh", () => {
    fs.writeFileSync(registry, "{}");
    const emptyRoot = path.join(tmp, "empty");
    fs.mkdirSync(emptyRoot);
    expect(newestManifestMtime([path.join(tmp, "nope")], ["squad.yaml"])).toBe(-1);
    expect(registryIsFresh(registry, -1)).toBe(true);
  });

  test("depth 2 sees legacy nested manifests that depth 1 misses", () => {
    const dna = path.join(tmp, "dna");
    fs.mkdirSync(path.join(dna, "category", "clone-x"), { recursive: true });
    const nested = path.join(dna, "category", "clone-x", "MANIFEST.yaml");
    fs.writeFileSync(nested, "slug: clone-x\n");
    fs.utimesSync(nested, at(300), at(300));
    const shallow = newestManifestMtime([dna], ["MANIFEST.yaml"], 1);
    const deep = newestManifestMtime([dna], ["MANIFEST.yaml"], 2);
    expect(deep).toBeGreaterThan(shallow);
  });
});
