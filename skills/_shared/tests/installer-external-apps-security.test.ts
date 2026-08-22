import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dir, "../../..");
const installerScript = join(repoRoot, "skills", "_shared", "scripts", "install-asset.ts");
const platform = process.platform;
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nrv-pack-security-"));
  roots.push(root);
  return root;
}

function writeSquad(root: string, slug: string, dependencies?: string): string {
  const squad = join(root, slug);
  mkdirSync(join(squad, "agents"), { recursive: true });
  mkdirSync(join(squad, "workflows"), { recursive: true });
  writeFileSync(join(squad, "squad.yaml"), `name: ${slug}\nversion: 1.0.0\ndescription: Test squad\n`);
  if (dependencies !== undefined) writeFileSync(join(squad, "dependencies.yaml"), dependencies);
  return squad;
}

function writeSingleAssetPack(root: string, collection: "businesses" | "mind-clones", slug: string): { pack: string; asset: string } {
  const pack = join(root, `pack-${slug}`);
  const asset = join(pack, collection, slug);
  mkdirSync(asset, { recursive: true });
  if (collection === "businesses") {
    writeFileSync(join(asset, "business.yaml"), `name: ${slug}\nversion: 1.0.0\ndescription: Test business\n`);
  } else {
    mkdirSync(join(asset, "agent"), { recursive: true });
    writeFileSync(join(asset, "MANIFEST.yaml"), `name: ${slug}\nversion: 1.0.0\ncategory: test\n`);
    writeFileSync(join(asset, "agent", "AGENT.md"), "# Test clone\n");
  }
  writeFileSync(join(pack, "pack.yaml"), `name: security-${slug}-pack
version: 1.0.0
description: Security test pack
contents:
  ${collection}:
    - path: ${collection}/${slug}
`);
  return { pack, asset };
}

interface AppFixture {
  id: string;
  required: boolean;
  installFails?: boolean;
  mutatingCheck?: boolean;
}

function appYaml(root: string, app: AppFixture): string {
  const safe = app.id.replaceAll(/[._-]/g, "_");
  const marker = join(root, `${safe}.installed`);
  const checkMarker = join(root, `${safe}.checked`);
  const presence = join(root, `${safe}-presence.ts`);
  const install = join(root, `${safe}-install.ts`);
  writeFileSync(presence, `import { existsSync${app.mutatingCheck ? ", writeFileSync" : ""} } from 'node:fs'; ${app.mutatingCheck ? `writeFileSync(${JSON.stringify(checkMarker)}, 'checked');` : ""} process.exit(existsSync(${JSON.stringify(marker)}) ? 0 : 1);\n`);
  writeFileSync(install, `import { writeFileSync } from 'node:fs'; ${app.installFails ? "process.exit(1);" : `writeFileSync(${JSON.stringify(marker)}, 'installed');`}\n`);
  return `  - id: ${app.id}
    name: ${app.id}
    description: Desktop runtime for ${app.id}.
    required: ${app.required}
    capability: capability.${safe}
    license: MIT
    homepage: https://example.com/${safe}
    source: https://github.com/vendor/${safe}
    platforms: [${platform}]
    permissions: [accessibility, screen-recording]
    compatibility:
      requirement: ">=1.0.0 <2.0.0"
    presence_check:
      command: bun
      args: [${JSON.stringify(presence)}]
    install:
      ${platform}:
        command: bun
        args: [${JSON.stringify(install)}]
`;
}

function writePack(root: string, apps: AppFixture[], options: { itemPath?: string; requiredSquad?: string } = {}): string {
  const pack = join(root, "pack");
  mkdirSync(join(pack, "squads"), { recursive: true });
  const dependencies = apps.length > 0 ? `external_apps:\n${apps.map((app) => appYaml(root, app)).join("")}` : undefined;
  writeSquad(join(pack, "squads"), "bundled", dependencies);
  const dependencyBlock = options.requiredSquad ? `dependencies:\n  required_squads:\n    - ${options.requiredSquad}\n` : "";
  writeFileSync(join(pack, "pack.yaml"), `name: security-pack
version: 1.0.0
description: Security test pack
contents:
  squads:
    - path: ${options.itemPath ?? "squads/bundled"}
${dependencyBlock}`);
  return pack;
}

function run(root: string, pack: string, args: string[] = [], json = true): { status: number; stdout: string; stderr: string; result?: any } {
  const squads = join(root, "installed-squads");
  mkdirSync(squads, { recursive: true });
  const cliArgs = [installerScript, pack, "--scope=project", `--project-root=${root}`, "--skip-reindex", ...(json ? ["--json"] : []), ...args];
  const child = spawnSync("bun", cliArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    env: { ...process.env, HOME: root, USERPROFILE: root, NIRVANA_HOME: root, SQUADS_DIR: squads, NO_COLOR: "1" },
  });
  return {
    status: child.status ?? -1,
    stdout: child.stdout,
    stderr: child.stderr,
    ...(json && child.stdout.trim() ? { result: JSON.parse(child.stdout) } : {}),
  };
}

function digestFor(root: string, pack: string): string {
  const preflight = run(root, pack, ["--dry-run"]);
  expect(preflight.status).toBe(0);
  return preflight.result.external_plan_digest;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("external app consent protocol", () => {
  test("dry-run stays pure while optional-only no-decision installs degraded without commands", () => {
    const root = tempRoot();
    const pack = writePack(root, [{ id: "vendor.application", required: false, mutatingCheck: true }]);
    const checked = join(root, "vendor_application.checked");

    const dry = run(root, pack, ["--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.result.readiness).toBe("confirmation_required");
    expect(dry.result.external_plan_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(existsSync(checked)).toBe(false);

    const undecided = run(root, pack);
    expect(undecided.status).toBe(0);
    expect(undecided.result.readiness).toBe("degraded");
    expect(undecided.result.confirmation_required).toBe(false);
    expect(undecided.result.external_dependencies[0].status).toBe("pending_decision");
    expect(undecided.result.external_dependencies[0].enable_hint).toContain("exact digest");
    expect(existsSync(checked)).toBe(false);
    expect(existsSync(join(root, ".nirvana", "squads", "bundled"))).toBe(true);
  });

  test("required no-decision stays fail-closed without commands or pack assets", () => {
    const root = tempRoot();
    const pack = writePack(root, [{ id: "vendor.required", required: true, mutatingCheck: true }]);

    const undecided = run(root, pack);

    expect(undecided.status).toBe(2);
    expect(undecided.result.readiness).toBe("confirmation_required");
    expect(undecided.result.confirmation_required).toBe(true);
    expect(existsSync(join(root, "vendor_required.checked"))).toBe(false);
    expect(existsSync(join(root, ".nirvana", "squads", "bundled"))).toBe(false);
  });

  test("optional-only no-decision human output explains later enablement", () => {
    const root = tempRoot();
    const pack = writePack(root, [{ id: "vendor.optional", required: false }]);

    const human = run(root, pack, [], false);

    expect(human.status).toBe(0);
    expect(human.stdout).toContain("degraded capabilities");
    expect(human.stdout).toContain("--force --dry-run");
    expect(human.stdout).toContain("--force --accept-external-apps=");
  });

  test("rejects a bare acceptance flag and a mismatched digest without commands", () => {
    const root = tempRoot();
    const pack = writePack(root, [{ id: "vendor.application", required: true, mutatingCheck: true }]);
    const checked = join(root, "vendor_application.checked");

    const bare = run(root, pack, ["--accept-external-apps"]);
    expect(bare.status).toBe(2);
    expect(existsSync(checked)).toBe(false);

    const mismatch = run(root, pack, ["--accept-external-apps=sha256:" + "0".repeat(64)]);
    expect(mismatch.status).toBe(2);
    expect(mismatch.result.errors[0]).toContain("digest mismatch");
    expect(existsSync(checked)).toBe(false);
  });

  test("explicit decline degrades optional apps but blocks required apps without checks", () => {
    const optionalRoot = tempRoot();
    const optionalPack = writePack(optionalRoot, [{ id: "vendor.optional", required: false, mutatingCheck: true }]);
    const optional = run(optionalRoot, optionalPack, ["--decline-external-apps"]);
    expect(optional.status).toBe(0);
    expect(optional.result.readiness).toBe("degraded");
    expect(optional.result.external_dependencies[0].status).toBe("declined");
    expect(existsSync(join(optionalRoot, "vendor_optional.checked"))).toBe(false);
    expect(existsSync(join(optionalRoot, ".nirvana", "squads", "bundled"))).toBe(true);

    const requiredRoot = tempRoot();
    const requiredPack = writePack(requiredRoot, [{ id: "vendor.required", required: true, mutatingCheck: true }]);
    const required = run(requiredRoot, requiredPack, ["--decline-external-apps"]);
    expect(required.status).toBe(1);
    expect(required.result.readiness).toBe("blocked");
    expect(required.result.external_dependencies[0].status).toBe("declined");
    expect(existsSync(join(requiredRoot, "vendor_required.checked"))).toBe(false);
    expect(existsSync(join(requiredRoot, ".nirvana", "squads", "bundled"))).toBe(false);
  });

  test("human preflight shows digest and complete metadata without claiming installation", () => {
    const root = tempRoot();
    const pack = writePack(root, [{ id: "vendor.application", required: false }]);

    const human = run(root, pack, ["--dry-run"], false);

    expect(human.status).toBe(0);
    const output = human.stdout + human.stderr;
    for (const value of ["vendor.application", "MIT", "https://github.com/vendor/vendor_application", "https://example.com/vendor_application", "accessibility", platform, ">=1.0.0 <2.0.0", "bun", "sha256:"]) {
      expect(output).toContain(value);
    }
    expect(output).not.toContain("✓ installed");
  });
});

describe("pack source containment", () => {
  test("rejects traversal and absolute bundled squad paths", () => {
    const traversalRoot = tempRoot();
    const traversalPack = writePack(traversalRoot, [], { itemPath: "../outside" });
    writeSquad(traversalRoot, "outside");
    const traversal = run(traversalRoot, traversalPack);
    expect(traversal.status).toBe(1);
    expect(traversal.result.errors[0]).toContain("unsafe pack item path");

    const absoluteRoot = tempRoot();
    const outside = writeSquad(absoluteRoot, "absolute-outside");
    expect(isAbsolute(outside)).toBe(true);
    const absolutePack = writePack(absoluteRoot, [], { itemPath: outside });
    const absolute = run(absoluteRoot, absolutePack);
    expect(absolute.status).toBe(1);
    expect(absolute.result.errors[0]).toContain("unsafe pack item path");
  });

  test("rejects a bundled squad symlink escape and an unsafe required squad slug", () => {
    const symlinkRoot = tempRoot();
    const pack = writePack(symlinkRoot, []);
    const outside = writeSquad(symlinkRoot, "outside");
    rmSync(join(pack, "squads", "bundled"), { recursive: true, force: true });
    symlinkSync(outside, join(pack, "squads", "bundled"), process.platform === "win32" ? "junction" : "dir");
    const escaped = run(symlinkRoot, pack);
    expect(escaped.status).toBe(1);
    expect(escaped.result.errors[0]).toContain("escapes pack root");

    const slugRoot = tempRoot();
    const slugPack = writePack(slugRoot, [], { requiredSquad: "../required" });
    writeSquad(slugRoot, "required");
    const unsafeSlug = run(slugRoot, slugPack);
    expect(unsafeSlug.status).toBe(1);
    expect(unsafeSlug.result.errors[0]).toContain("invalid required squad slug");
  });

  test("rejects a nested squad junction before reading or copying it", () => {
    const root = tempRoot();
    const pack = writePack(root, []);
    const outside = join(root, "outside-nested");
    mkdirSync(outside);
    writeFileSync(join(outside, "payload.txt"), "outside");
    symlinkSync(outside, join(pack, "squads", "bundled", "nested-link"), process.platform === "win32" ? "junction" : "dir");

    const result = run(root, pack);

    expect(result.status).toBe(1);
    expect(result.result.errors.join(" ")).toContain("symbolic link");
    expect(existsSync(join(root, ".nirvana", "squads", "bundled"))).toBe(false);
  });

  test("rejects a nested business junction before checksum or copy", () => {
    const root = tempRoot();
    const { pack, asset } = writeSingleAssetPack(root, "businesses", "bundled-business");
    const outside = join(root, "outside-business");
    mkdirSync(outside);
    writeFileSync(join(outside, "payload.txt"), "outside");
    symlinkSync(outside, join(asset, "nested-link"), process.platform === "win32" ? "junction" : "dir");

    const result = run(root, pack);

    expect(result.status).toBe(1);
    expect(result.result.errors.join(" ")).toContain("symbolic link");
    expect(existsSync(join(root, ".nirvana", "businesses", "bundled-business"))).toBe(false);
  });

  test("rejects a nested mind-clone junction before checksum or copy", () => {
    const root = tempRoot();
    const { pack, asset } = writeSingleAssetPack(root, "mind-clones", "bundled-clone");
    const outside = join(root, "outside-clone");
    mkdirSync(outside);
    writeFileSync(join(outside, "payload.txt"), "outside");
    symlinkSync(outside, join(asset, "nested-link"), process.platform === "win32" ? "junction" : "dir");

    const result = run(root, pack);

    expect(result.status).toBe(1);
    expect(result.result.errors.join(" ")).toContain("symbolic link");
    expect(existsSync(join(root, ".nirvana", "mind-clones", "bundled-clone"))).toBe(false);
  });

  test("rejects a self-referential nested junction without traversing the cycle", () => {
    const root = tempRoot();
    const { pack, asset } = writeSingleAssetPack(root, "businesses", "cyclic-business");
    symlinkSync(asset, join(asset, "cycle"), process.platform === "win32" ? "junction" : "dir");

    const result = run(root, pack);

    expect(result.status).toBe(1);
    expect(result.result?.errors.join(" ")).toContain("symbolic link");
  });

  test("rejects an external junction in an unlisted pack directory during checksum", () => {
    const root = tempRoot();
    const pack = writePack(root, []);
    const unused = join(pack, "unused");
    const outside = join(root, "outside-unlisted");
    mkdirSync(unused);
    mkdirSync(outside);
    writeFileSync(join(outside, "payload.txt"), "outside");
    symlinkSync(outside, join(unused, "external"), process.platform === "win32" ? "junction" : "dir");

    const result = run(root, pack, ["--dry-run"]);

    expect(result.status).toBe(1);
    expect(result.result?.errors.join(" ")).toContain("symbolic link");
  });

  test("rejects a cyclic junction in an unlisted pack directory without traversing it", () => {
    const root = tempRoot();
    const pack = writePack(root, []);
    const unused = join(pack, "unused");
    mkdirSync(unused);
    symlinkSync(unused, join(unused, "cycle"), process.platform === "win32" ? "junction" : "dir");

    const result = run(root, pack, ["--dry-run"]);

    expect(result.status).toBe(1);
    expect(result.result?.errors.join(" ")).toContain("symbolic link");
  });
});

describe("external effects survive later failures", () => {
  test("reports partial required installs and skips optional installs after a blocker", () => {
    const root = tempRoot();
    const pack = writePack(root, [
      { id: "vendor.a-success", required: true },
      { id: "vendor.b-fail", required: true, installFails: true },
      { id: "vendor.c-optional", required: false },
    ]);
    const digest = digestFor(root, pack);

    const result = run(root, pack, [`--accept-external-apps=${digest}`]);

    expect(result.status).toBe(1);
    expect(result.result.changed_external_apps).toEqual(["vendor.a-success"]);
    expect(result.result.external_dependencies.find((app: any) => app.id === "vendor.c-optional").status).toBe("not_attempted");
    expect(result.result.external_actions.filter((action: any) => action.phase === "install")).toHaveLength(2);
    expect(result.result.warnings.join(" ")).toContain("not rolled back");
    expect(existsSync(join(root, ".nirvana", "squads", "bundled"))).toBe(false);
  });

  test("retains external changes when pack asset copying fails", () => {
    const root = tempRoot();
    const pack = writePack(root, [{ id: "vendor.required", required: true }]);
    const digest = digestFor(root, pack);
    mkdirSync(join(root, ".nirvana"), { recursive: true });
    writeFileSync(join(root, ".nirvana", "squads"), "blocks target directory");

    const result = run(root, pack, [`--accept-external-apps=${digest}`]);

    expect(result.status).toBe(1);
    expect(result.result.changed_external_apps).toEqual(["vendor.required"]);
    expect(result.result.external_dependencies[0].status).toBe("installed");
    expect(result.result.warnings.join(" ")).toContain("not rolled back");
    expect(existsSync(join(root, "vendor_required.installed"))).toBe(true);
  });
});
