import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectManagedUpdateRisks,
  createCustomizationSnapshot,
  hashManagedTree,
} from "../../_shared/lib/update-safety.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const INSTALL_CONTENT = join(REPO, "skills", "_shared", "scripts", "install-content.ts");
const INSTALL_ENGINE = join(REPO, "scripts", "install.ts");
const roots: string[] = [];

function fixtureRoot(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "nrv-update-safety-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  roots.push(root);
  return { root, home };
}

function packContent(root: string, label: string): string {
  const content = join(root, `content-${label}`);
  const business = join(content, "businesses", "demo-business");
  mkdirSync(business, { recursive: true });
  mkdirSync(join(content, "squads"), { recursive: true });
  mkdirSync(join(content, "mind-clones"), { recursive: true });
  writeFileSync(join(business, "business.yaml"), `name: demo-business\ndescription: ${label}\n`);
  return content;
}

function emptyPackContent(root: string, label: string): string {
  const content = join(root, `content-${label}`);
  mkdirSync(join(content, "businesses"), { recursive: true });
  mkdirSync(join(content, "squads"), { recursive: true });
  mkdirSync(join(content, "mind-clones"), { recursive: true });
  return content;
}

function runPack(home: string, content: string, version: string): { code: number; out: string } {
  const run = spawnSync(process.execPath, [
    INSTALL_CONTENT,
    content,
    "--slug",
    "fixture-pack",
    "--version",
    version,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      NIRVANA_SCOPE: "global",
    },
  });
  return { code: run.status ?? 1, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

function runEngine(home: string, options: { starter?: boolean; packsDir?: string; copySkills?: boolean } = {}): { code: number; out: string } {
  const run = spawnSync(process.execPath, [
    INSTALL_ENGINE,
    options.starter ? "--starter" : "--no-starter",
    ...(options.copySkills ? ["--copy-skills"] : []),
    "--no-hermes",
    "--no-index",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      NIRVANA_SCOPE: "global",
      NIRVANA_PACKS_DIR: options.packsDir ?? join(home, "packs-not-installed"),
    },
  });
  return { code: run.status ?? 1, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

function findFiles(root: string, name: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === name) found.push(full);
    }
  };
  walk(root);
  return found;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
}, 120_000);

describe("pack update safety", () => {
  test("blocks drift in pack-managed content before replacing it and writes a recoverable snapshot", () => {
    const { root, home } = fixtureRoot();
    const first = runPack(home, packContent(root, "pack-v1"), "1.0.0");
    expect(first.code).toBe(0);

    const installed = join(home, "businesses", "demo-business", "business.yaml");
    writeFileSync(installed, "name: demo-business\ndescription: my direct customization\n");

    const update = runPack(home, packContent(root, "pack-v2"), "2.0.0");
    expect(update.code).toBe(1);
    expect(update.out).toContain("UPDATE BLOCKED");
    expect(update.out).toContain("pack-managed drift");
    expect(readFileSync(installed, "utf8")).toContain("my direct customization");

    const snapshots = join(home, ".nirvana", "customization-snapshots", "pack-fixture-pack");
    const metadataFiles = findFiles(snapshots, "metadata.json");
    expect(metadataFiles).toHaveLength(1);
    const metadata = JSON.parse(readFileSync(metadataFiles[0], "utf8"));
    expect(metadata.items[0]).toMatchObject({
      ownership: "pack-managed",
      reason: "managed-drift",
      kind: "businesses",
      slug: "demo-business",
      base_version: "1.0.0",
      incoming_version: "2.0.0",
    });
    expect(metadata.items[0].base_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata.items[0].installed_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata.items[0].incoming_hash).toMatch(/^[a-f0-9]{64}$/);

    const saved = findFiles(snapshots, "business.yaml");
    expect(saved).toHaveLength(1);
    expect(readFileSync(saved[0], "utf8")).toContain("my direct customization");

    const manifest = JSON.parse(readFileSync(join(home, ".nirvana", "packs", "fixture-pack.json"), "utf8"));
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.ownership).toBe("pack-managed");
  }, 30_000);

  test("treats a same-slug component never owned by the pack as user-owned and leaves it untouched", () => {
    const { root, home } = fixtureRoot();
    const installed = join(home, "businesses", "demo-business", "business.yaml");
    mkdirSync(join(home, "businesses", "demo-business"), { recursive: true });
    writeFileSync(installed, "name: demo-business\ndescription: mine\n");

    const install = runPack(home, packContent(root, "pack-v1"), "1.0.0");
    expect(install.code).toBe(1);
    expect(install.out).toContain("user-owned collision");
    expect(readFileSync(installed, "utf8")).toContain("description: mine");

    const metadataFiles = findFiles(
      join(home, ".nirvana", "customization-snapshots", "pack-fixture-pack"),
      "metadata.json",
    );
    expect(metadataFiles).toHaveLength(1);
    const metadata = JSON.parse(readFileSync(metadataFiles[0], "utf8"));
    expect(metadata.items[0]).toMatchObject({ ownership: "user-owned", reason: "user-owned-collision" });
  }, 30_000);

  test("updates unchanged pack-managed content normally", () => {
    const { root, home } = fixtureRoot();
    expect(runPack(home, packContent(root, "pack-v1"), "1.0.0").code).toBe(0);

    const update = runPack(home, packContent(root, "pack-v2"), "2.0.0");
    expect(update.code).toBe(0);
    expect(readFileSync(join(home, "businesses", "demo-business", "business.yaml"), "utf8"))
      .toContain("description: pack-v2");
  }, 30_000);

  test("removing a pack-owned component preserves its excluded run state", () => {
    const { root, home } = fixtureRoot();
    expect(runPack(home, packContent(root, "pack-v1"), "1.0.0").code).toBe(0);

    const installed = join(home, "businesses", "demo-business");
    const projectState = join(installed, "memory", "projects", "job-42", "state.json");
    const learnedMemory = join(installed, "memory", "learned.md");
    mkdirSync(join(projectState, ".."), { recursive: true });
    writeFileSync(projectState, '{"step":"approved"}\n');
    writeFileSync(learnedMemory, "customer-specific learning\n");

    const removal = runPack(home, emptyPackContent(root, "pack-v2"), "2.0.0");
    expect(removal.code).toBe(0);
    expect(removal.out).toContain("1 removed");
    expect(existsSync(join(installed, "business.yaml"))).toBe(false);
    expect(readFileSync(projectState, "utf8")).toContain("approved");
    expect(readFileSync(learnedMemory, "utf8")).toContain("customer-specific learning");

    const manifest = JSON.parse(readFileSync(join(home, ".nirvana", "packs", "fixture-pack.json"), "utf8"));
    expect(manifest.businesses).toEqual({});
  }, 30_000);
});

describe("managed update transaction safety", () => {
  test("rejects a symlink or Windows junction without traversing or copying its external target", () => {
    const { root } = fixtureRoot();
    const sourceRoot = join(root, "source");
    const targetRoot = join(root, "target");
    const source = join(sourceRoot, "demo");
    const target = join(targetRoot, "demo");
    const external = join(root, "external");
    mkdirSync(source, { recursive: true });
    mkdirSync(target, { recursive: true });
    mkdirSync(external, { recursive: true });
    writeFileSync(join(source, "business.yaml"), "name: demo\n");
    writeFileSync(join(target, "business.yaml"), "name: demo\n");
    writeFileSync(join(external, "secret.txt"), "must never be traversed or copied\n");
    symlinkSync(external, join(target, "external-state"), process.platform === "win32" ? "junction" : "dir");

    const risks = collectManagedUpdateRisks({
      ownership: "pack-managed",
      ownerId: "fixture-pack",
      kind: "businesses",
      sourceRoot,
      targetRoot,
      incomingSlugs: ["demo"],
      installedHashes: { demo: hashManagedTree(source) },
    });

    expect(risks).toHaveLength(1);
    expect(risks[0].reason).toBe("unsafe-link");
    expect(risks[0].unsafe_links?.[0]?.relative_path).toBe("external-state");

    const snapshot = createCustomizationSnapshot(risks, join(root, "snapshots"));
    expect(existsSync(join(snapshot, "metadata.json"))).toBe(true);
    expect(findFiles(snapshot, "secret.txt")).toHaveLength(0);
  });

  test("blocks and snapshots a target changed after preflight but before mutation", async () => {
    const { root } = fixtureRoot();
    const target = join(root, "target", "demo");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "business.yaml"), "name: demo\ndescription: baseline\n");

    const safety = await import("../../_shared/lib/update-safety.ts") as Record<string, any>;
    const observed = safety.observeManagedTarget({
      ownership: "pack-managed",
      ownerId: "fixture-pack",
      kind: "businesses",
      slug: "demo",
      targetPath: target,
      baseHash: hashManagedTree(target),
      incomingHash: null,
      excludes: [],
    });
    writeFileSync(join(target, "business.yaml"), "name: demo\ndescription: changed between phases\n");

    let mutated = false;
    const guarded = safety.guardManagedMutation(observed, join(root, "snapshots"), () => {
      mutated = true;
    });

    expect(guarded.ok).toBe(false);
    expect(mutated).toBe(false);
    expect(guarded.risk.reason).toBe("concurrent-change");
    expect(readFileSync(findFiles(guarded.snapshot_dir, "business.yaml")[0], "utf8"))
      .toContain("changed between phases");
  });
});

describe("engine update safety", () => {
  test("snapshots a legacy engine install before establishing its first ownership baseline", () => {
    const { home } = fixtureRoot();
    const legacySkill = join(home, ".nirvana", "skills", "harness");
    mkdirSync(legacySkill, { recursive: true });
    writeFileSync(join(legacySkill, "SKILL.md"), "LEGACY LOCAL CONTENT\n");

    const install = runEngine(home);
    expect(install.code).toBe(0);
    expect(install.out).toContain("compatibility snapshot created");
    expect(existsSync(join(home, ".nirvana", "engine-install.json"))).toBe(true);

    const snapshots = join(home, ".nirvana", "customization-snapshots", "engine");
    const saved = findFiles(snapshots, "SKILL.md");
    expect(saved).toHaveLength(1);
    expect(readFileSync(saved[0], "utf8")).toContain("LEGACY LOCAL CONTENT");
    const metadata = JSON.parse(readFileSync(findFiles(snapshots, "metadata.json")[0], "utf8"));
    expect(metadata.items[0]).toMatchObject({
      ownership: "engine-managed",
      reason: "legacy-baseline",
      slug: "harness",
    });
  }, 180_000);

  test("records the managed baseline and blocks a later reinstall over direct skill edits", () => {
    const { home } = fixtureRoot();
    const first = runEngine(home);
    expect(first.code).toBe(0);

    const manifestPath = join(home, ".nirvana", "engine-install.json");
    expect(existsSync(manifestPath)).toBe(true);
    const baseline = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(baseline.ownership).toBe("engine-managed");
    expect(baseline.skills.harness).toMatch(/^[a-f0-9]{64}$/);

    const customized = join(home, ".nirvana", "skills", "harness", "SKILL.md");
    writeFileSync(customized, `${readFileSync(customized, "utf8")}\nLOCAL CUSTOMIZATION\n`);

    const reinstall = runEngine(home);
    expect(reinstall.code).toBe(1);
    expect(reinstall.out).toContain("UPDATE BLOCKED");
    expect(reinstall.out).toContain("engine-managed drift");
    expect(readFileSync(customized, "utf8")).toContain("LOCAL CUSTOMIZATION");

    const snapshots = join(home, ".nirvana", "customization-snapshots", "engine");
    const metadataFiles = findFiles(snapshots, "metadata.json");
    expect(metadataFiles).toHaveLength(1);
    const metadata = JSON.parse(readFileSync(metadataFiles[0], "utf8"));
    expect(metadata.items[0]).toMatchObject({
      ownership: "engine-managed",
      reason: "managed-drift",
      kind: "skills",
      slug: "harness",
    });
  }, 180_000);

  test("applies the same drift protection to the starter pack path", () => {
    const { root, home } = fixtureRoot();
    const packsDir = join(root, "packs");
    const starterBusiness = join(packsDir, "starter-pack", "businesses", "demo-business");
    mkdirSync(starterBusiness, { recursive: true });
    mkdirSync(join(packsDir, "starter-pack", "squads"), { recursive: true });
    mkdirSync(join(packsDir, "starter-pack", "mind-clones"), { recursive: true });
    writeFileSync(join(starterBusiness, "business.yaml"), "name: demo-business\ndescription: starter-v1\n");

    expect(runEngine(home, { starter: true, packsDir }).code).toBe(0);
    const installed = join(home, "businesses", "demo-business", "business.yaml");
    writeFileSync(installed, "name: demo-business\ndescription: my starter customization\n");
    writeFileSync(join(starterBusiness, "business.yaml"), "name: demo-business\ndescription: starter-v2\n");

    const update = runEngine(home, { starter: true, packsDir });
    expect(update.code).toBe(1);
    expect(update.out).toContain("UPDATE BLOCKED");
    expect(update.out).toContain("pack-managed drift");
    expect(readFileSync(installed, "utf8")).toContain("my starter customization");

    const metadata = findFiles(
      join(home, ".nirvana", "customization-snapshots", "pack-starter-pack"),
      "metadata.json",
    );
    expect(metadata).toHaveLength(1);
  }, 180_000);

  test("blocks drift in marked Codex and generic copy-mode runtime mirrors before regenerating them", () => {
    const { home } = fixtureRoot();
    mkdirSync(join(home, ".gemini"), { recursive: true });
    expect(runEngine(home, { copySkills: true }).code).toBe(0);

    const mirror = join(home, ".codex", "skills", "harness", "SKILL.md");
    const genericMirror = join(home, ".gemini", "skills", "harness", "SKILL.md");
    expect(existsSync(mirror)).toBe(true);
    expect(existsSync(genericMirror)).toBe(true);
    writeFileSync(mirror, `${readFileSync(mirror, "utf8")}\nRUNTIME MIRROR CUSTOMIZATION\n`);
    writeFileSync(genericMirror, `${readFileSync(genericMirror, "utf8")}\nGENERIC MIRROR CUSTOMIZATION\n`);

    const reinstall = runEngine(home, { copySkills: true });
    expect(reinstall.code).toBe(1);
    expect(reinstall.out).toContain("runtime mirror drift");
    expect(readFileSync(mirror, "utf8")).toContain("RUNTIME MIRROR CUSTOMIZATION");
    expect(readFileSync(genericMirror, "utf8")).toContain("GENERIC MIRROR CUSTOMIZATION");

    const snapshotRoot = join(home, ".nirvana", "customization-snapshots", "runtime-mirrors");
    const metadataFiles = findFiles(snapshotRoot, "metadata.json");
    expect(metadataFiles).toHaveLength(1);
    const metadata = JSON.parse(readFileSync(metadataFiles[0], "utf8"));
    expect(metadata.items).toEqual(expect.arrayContaining([expect.objectContaining({
      ownership: "engine-managed",
      reason: "runtime-mirror-drift",
      kind: "runtime-mirror",
      slug: "codex--harness",
    }), expect.objectContaining({
      ownership: "engine-managed",
      reason: "runtime-mirror-drift",
      kind: "runtime-mirror",
      slug: "gemini-cli--harness",
    })]));
  }, 180_000);
});
