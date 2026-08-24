import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dir, "../../..");
const installerScript = join(repoRoot, "skills", "_shared", "scripts", "install-asset.ts");
const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nrv-pack-external-apps-"));
  tempRoots.push(root);
  return root;
}

function externalAppYaml(root: string, required: boolean): string {
  const marker = join(root, "external-app.marker");
  const presence = join(root, "presence.ts");
  const install = join(root, "install.ts");
  writeFileSync(presence, "import { existsSync } from 'node:fs'; process.exit(existsSync(process.argv[2]) ? 0 : 1);\n");
  writeFileSync(install, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'installed');\n");
  return `external_apps:
  - id: vendor.application
    name: Application
    description: Desktop automation runtime.
    required: ${required}
    capability: automation.desktop
    license: MIT
    homepage: https://example.com/application
    source: https://github.com/vendor/application
    platforms: [${process.platform}]
    permissions: [accessibility]
    compatibility:
      requirement: ">=1.0.0 <2.0.0"
    presence_check:
      command: bun
      args: [${JSON.stringify(presence)}, ${JSON.stringify(marker)}]
    install:
      ${process.platform}:
        command: bun
        args: [${JSON.stringify(install)}, ${JSON.stringify(marker)}]
`;
}

function writeSquad(dir: string, slug: string, dependencies?: string): string {
  const squad = join(dir, slug);
  mkdirSync(join(squad, "agents"), { recursive: true });
  mkdirSync(join(squad, "workflows"), { recursive: true });
  writeFileSync(join(squad, "squad.yaml"), `name: ${slug}\nversion: 1.0.0\ndescription: Test squad\n`);
  if (dependencies !== undefined) writeFileSync(join(squad, "dependencies.yaml"), dependencies);
  return squad;
}

function writePack(root: string, options: { required?: boolean; includeRequiredSquad?: boolean; legacy?: boolean } = {}): string {
  const pack = join(root, "pack");
  const bundledRoot = join(pack, "squads");
  mkdirSync(bundledRoot, { recursive: true });
  writeSquad(bundledRoot, "bundled", options.legacy ? "schema_version: '1.0'\n" : externalAppYaml(root, options.required ?? false));
  const requiredBlock = options.includeRequiredSquad
    ? "dependencies:\n  required_squads:\n    - required\n"
    : "";
  writeFileSync(join(pack, "pack.yaml"), `name: test-pack
version: 1.0.0
description: Test pack
contents:
  squads:
    - path: squads/bundled
${requiredBlock}`);
  return pack;
}

function runInstall(root: string, pack: string, args: string[] = []): { status: number; json: any; stderr: string } {
  const squads = join(root, "installed-squads");
  mkdirSync(squads, { recursive: true });
  const result = spawnSync("bun", [installerScript, pack, "--scope=project", `--project-root=${root}`, "--skip-reindex", "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      NIRVANA_HOME: root,
      SQUADS_DIR: squads,
      NO_COLOR: "1",
    },
  });
  return {
    status: result.status ?? -1,
    json: JSON.parse(result.stdout),
    stderr: result.stderr,
  };
}

function runInstallHuman(root: string, pack: string, args: string[] = []): { status: number; stdout: string; stderr: string } {
  const squads = join(root, "installed-squads");
  mkdirSync(squads, { recursive: true });
  const result = spawnSync("bun", [installerScript, pack, "--scope=project", `--project-root=${root}`, "--skip-reindex", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      NIRVANA_HOME: root,
      SQUADS_DIR: squads,
      NO_COLOR: "1",
    },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function preflightDigest(root: string, pack: string): string {
  const preflight = runInstall(root, pack, ["--dry-run"]);
  expect(preflight.status).toBe(0);
  return preflight.json.external_plan_digest;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pack external application dependencies", () => {
  test("discovers bundled and installed required squads and deduplicates the plan", () => {
    const root = tempRoot();
    const declaration = externalAppYaml(root, false);
    const pack = writePack(root, { includeRequiredSquad: true });
    writeFileSync(join(pack, "squads", "bundled", "dependencies.yaml"), declaration);
    writeSquad(join(root, "installed-squads"), "required", declaration);

    const result = runInstall(root, pack, ["--dry-run"]);

    expect(result.status).toBe(0);
    expect(result.json.external_dependencies).toHaveLength(1);
    expect(result.json.external_dependencies[0].source_squads).toEqual(["bundled", "required"]);
    expect(result.json.readiness).toBe("confirmation_required");
  });

  test("installs the parent pack but degrades an explicitly declined optional capability", () => {
    const root = tempRoot();
    const pack = writePack(root);

    const result = runInstall(root, pack, ["--decline-external-apps"]);

    expect(result.status).toBe(0);
    expect(result.json.ok).toBe(true);
    expect(result.json.readiness).toBe("degraded");
    expect(result.json.degraded_capabilities).toEqual(["automation.desktop"]);
    expect(result.json.external_dependencies[0].status).toBe("declined");
    expect(existsSync(join(root, ".nirvana", "squads", "bundled"))).toBe(true);
  });

  test("enables a previously deferred optional app through the documented force flow", () => {
    const root = tempRoot();
    const pack = writePack(root, { required: false });

    const deferred = runInstall(root, pack);
    expect(deferred.status).toBe(0);
    expect(deferred.json.readiness).toBe("degraded");

    const preflight = runInstall(root, pack, ["--force", "--dry-run"]);
    expect(preflight.status).toBe(0);
    expect(preflight.json.external_plan_digest).toMatch(/^sha256:/);

    const accepted = runInstall(root, pack, ["--force", `--accept-external-apps=${preflight.json.external_plan_digest}`]);
    expect(accepted.status).toBe(0);
    expect(accepted.json.readiness).toBe("ready");
    expect(accepted.json.external_dependencies[0].status).toBe("installed");
  });

  test("blocks an explicitly declined required dependency before copying pack assets", () => {
    const root = tempRoot();
    const pack = writePack(root, { required: true });

    const result = runInstall(root, pack, ["--decline-external-apps"]);

    expect(result.status).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.readiness).toBe("blocked");
    expect(result.json.errors[0]).toContain("required external app unavailable");
    expect(existsSync(join(root, ".nirvana", "squads", "bundled"))).toBe(false);
  });

  test("explains a declined required capability and a safe next action in human output", () => {
    const root = tempRoot();
    const pack = writePack(root, { required: true });

    const result = runInstallHuman(root, pack, ["--decline-external-apps"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("automation.desktop");
    expect(result.stderr).toContain("preflight and accept its exact digest");
  });

  test("installs an accepted external application once and reports it", () => {
    const root = tempRoot();
    const pack = writePack(root, { required: true });

    const digest = preflightDigest(root, pack);
    const result = runInstall(root, pack, [`--accept-external-apps=${digest}`]);

    expect(result.status).toBe(0);
    expect(result.json.readiness).toBe("ready");
    expect(result.json.external_dependencies[0].status).toBe("installed");
    expect(existsSync(join(root, "external-app.marker"))).toBe(true);
  });

  test("preserves legacy pack results when no external applications are declared", () => {
    const root = tempRoot();
    const pack = writePack(root, { legacy: true });

    const result = runInstall(root, pack);

    expect(result.status).toBe(0);
    expect(result.json.ok).toBe(true);
    expect(result.json.readiness).toBeUndefined();
    expect(result.json.external_dependencies).toBeUndefined();
    expect(existsSync(join(root, ".nirvana", "squads", "bundled"))).toBe(true);
  });
});
