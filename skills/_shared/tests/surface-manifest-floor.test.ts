// surface-manifest-floor.test.ts — one artifact, one version number.
//
// `version:` in the manifest and `contract_version` in the surface are two
// lines with two owners: the author writes the first, the generator derives the
// second. Nothing kept them in step, and they drifted apart on 156 of the 161
// squads that carry a surface — the Protocol 6 migration moved manifests to
// 6.0.0 while the surfaces stayed on their own 5.x, so one squad published two
// different numbers depending on which file you read.
//
// The manifest is the floor now. These cases pin what that does and, just as
// important, what it does NOT do: it never rewrites an artifact nobody touched,
// and it never lowers a derived version.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { extractSurface, manifestVersion, readSurface, writeSurface } from "../lib/surface.ts";
import { versionAbove } from "../lib/surface-diff.ts";

const SCRIPT = path.join(import.meta.dir, "..", "scripts", "nirvana-changes.ts");
const roots: string[] = [];
afterAll(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

const CAP = (id: string, produces: string) => `capabilities:
  - id: ${id}
    description: "faz ${id}"
    domains: [design]
    produces: [${produces}]
    invoke:
      type: workflow
      ref: workflows/alpha.yaml
`;

/** A squad whose manifest declares `version`, seeded with a recorded surface. */
function squad(manifestVersionText: string, recordedContract: string | null, cap = CAP("fix.alpha.run", "pdf")): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-floor-")));
  roots.push(dir);
  fs.writeFileSync(path.join(dir, "squad.yaml"), `name: fixture\nversion: "${manifestVersionText}"\nprotocol: "6.0"\n${cap}`);
  if (recordedContract) writeSurface(dir, { ...extractSurface(dir), contract_version: recordedContract });
  return dir;
}

function gen(dir: string, ...extra: string[]) {
  return spawnSync(process.execPath, [SCRIPT, "gen", dir, ...extra], { encoding: "utf8", timeout: 120_000 });
}

/** Rewrite the capability so the next gen sees a real change. */
function touch(dir: string) {
  const f = path.join(dir, "squad.yaml");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("produces: [pdf]", "produces: [pdf, html]"));
}

function latestHistoryVersion(dir: string): string | null {
  const f = path.join(dir, "CHANGES.json");
  if (!fs.existsSync(f)) return null;
  const h = JSON.parse(fs.readFileSync(f, "utf8")).history ?? [];
  return h.length ? h[0].version : null;
}

describe("versionAbove", () => {
  test("compares each field, and refuses what it cannot measure", () => {
    expect(versionAbove("6.0.0", "5.0.2")).toBe(true);
    expect(versionAbove("5.1.0", "5.0.9")).toBe(true);
    expect(versionAbove("5.0.3", "5.0.2")).toBe(true);
    expect(versionAbove("5.0.2", "5.0.2")).toBe(false);
    expect(versionAbove("5.0.2", "6.0.0")).toBe(false);
    // Two digits per field is not a string comparison: "10" beats "9".
    expect(versionAbove("5.10.0", "5.9.0")).toBe(true);
    for (const bad of ["6.0", "v6.0.0", "", "6.0.0-rc1", "latest"]) {
      expect(versionAbove(bad, "1.0.0")).toBe(false);
      expect(versionAbove("9.9.9", bad)).toBe(false);
    }
  });
});

describe("manifestVersion", () => {
  test("reads the squad manifest, and only a plain semver", () => {
    expect(manifestVersion(squad("6.0.0", null), "squad")).toBe("6.0.0");
    expect(manifestVersion(squad("6.0", null), "squad")).toBeNull();
    expect(manifestVersion(squad("v6.0.0", null), "squad")).toBeNull();
  });

  test("reads a business manifest, and answers null when the file is absent", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-floor-biz-")));
    roots.push(dir);
    fs.writeFileSync(path.join(dir, "business.yaml"), 'name: fixture\nversion: "2.1.0"\n');
    expect(manifestVersion(dir, "business")).toBe("2.1.0");
    expect(manifestVersion(dir, "squad")).toBeNull();
  });
});

describe("gen adopts the manifest when the manifest is ahead", () => {
  test("a manifest at 6.0.0 over a surface at 5.0.1 publishes 6.0.0, in the surface AND in the history", () => {
    const dir = squad("6.0.0", "5.0.1");
    touch(dir);
    const r = gen(dir);
    expect(r.status).toBe(0);
    expect(readSurface(dir)!.contract_version).toBe("6.0.0");
    expect(latestHistoryVersion(dir)).toBe("6.0.0");
    // The derived bump would have been 5.1.0 (a new `produces` is additive);
    // the floor replaced it.
    expect(fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8")).toContain("6.0.0");
  }, 180_000);

  test("a manifest behind the surface changes nothing: the floor never lowers a version", () => {
    const dir = squad("1.0.0", "5.0.1");
    touch(dir);
    expect(gen(dir).status).toBe(0);
    expect(readSurface(dir)!.contract_version).toBe("5.1.0");
    expect(latestHistoryVersion(dir)).toBe("5.1.0");
  }, 180_000);

  test("a manifest with no readable version leaves the derivation alone", () => {
    const dir = squad("6.0", "5.0.1");
    touch(dir);
    expect(gen(dir).status).toBe(0);
    expect(readSurface(dir)!.contract_version).toBe("5.1.0");
  }, 180_000);

  test("once adopted, the next change derives from the manifest floor, not from the old line", () => {
    const dir = squad("6.0.0", "5.0.1");
    touch(dir);
    expect(gen(dir).status).toBe(0);
    expect(readSurface(dir)!.contract_version).toBe("6.0.0");
    fs.writeFileSync(path.join(dir, "squad.yaml"),
      fs.readFileSync(path.join(dir, "squad.yaml"), "utf8").replace("produces: [pdf, html]", "produces: [pdf, html, docx]"));
    expect(gen(dir).status).toBe(0);
    expect(readSurface(dir)!.contract_version).toBe("6.1.0");
  }, 240_000);
});

describe("what the floor must not disturb", () => {
  test("idempotence survives: an artifact nobody touched is not rewritten, even with the manifest ahead", () => {
    const dir = squad("6.0.0", "5.0.1");
    touch(dir);
    expect(gen(dir).status).toBe(0);
    const before = fs.readdirSync(dir).filter((f) => f.startsWith(".nirvana") || f === "CHANGES.json" || f === "CHANGELOG.md")
      .map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")] as const);
    expect(gen(dir).status).toBe(0);
    for (const [f, content] of before) {
      expect(fs.readFileSync(path.join(dir, f), "utf8"), `${f} mudou numa segunda passada`).toBe(content);
    }
  }, 240_000);

  test("a squad with no pending change keeps its recorded number: the floor is not a rewrite of history", () => {
    // The manifest is far ahead and the surface is untouched. `gen` reports
    // nothing to do and writes nothing — the adoption waits for a real change.
    const dir = squad("6.0.0", "5.0.1");
    const surfaceBefore = fs.readFileSync(path.join(dir, ".nirvana-surface.json"), "utf8");
    expect(gen(dir).status).toBe(0);
    expect(fs.readFileSync(path.join(dir, ".nirvana-surface.json"), "utf8")).toBe(surfaceBefore);
    expect(readSurface(dir)!.contract_version).toBe("5.0.1");
  }, 180_000);

  test("--dry writes nothing while reporting the adopted number", () => {
    const dir = squad("6.0.0", "5.0.1");
    touch(dir);
    const surfaceBefore = fs.readFileSync(path.join(dir, ".nirvana-surface.json"), "utf8");
    const r = gen(dir, "--dry");
    expect(r.status).toBe(0);
    expect(`${r.stdout}`).toContain("6.0.0");
    expect(fs.readFileSync(path.join(dir, ".nirvana-surface.json"), "utf8")).toBe(surfaceBefore);
    expect(fs.existsSync(path.join(dir, "CHANGES.json"))).toBe(false);
  }, 180_000);
});
