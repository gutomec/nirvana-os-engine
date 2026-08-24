import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildExternalAppPlan,
  confirmationRequiredExternalAppPlan,
  declineExternalAppPlan,
  discoverExternalApps,
  executeExternalAppPlan,
  type ExternalAppDependency,
} from "../lib/external-app-dependencies.ts";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nrv-external-apps-"));
  tempRoots.push(root);
  return root;
}

function writeSidecar(root: string, slug: string, yaml: string): string {
  const squadDir = join(root, slug);
  mkdirSync(squadDir, { recursive: true });
  writeFileSync(join(squadDir, "dependencies.yaml"), yaml);
  return squadDir;
}

const APP = `
external_apps:
  - id: vendor.application
    name: Application
    description: Desktop automation runtime.
    required: false
    capability: automation.desktop
    license: MIT
    homepage: https://example.com/application
    source: https://github.com/vendor/application
    platforms: [win32, darwin]
    permissions: [accessibility, screen-recording]
    compatibility:
      requirement: ">=1.4.0 <2.0.0"
      check:
        command: application
        args: [status, --json]
    presence_check:
      command: application
      args: [--version]
    install:
      win32:
        command: winget
        args: [install, --id, Vendor.Application, --exact]
      darwin:
        command: brew
        args: [install, --cask, application]
`;

const PLATFORM_CHECKS_APP = APP
  .replace(`      check:
        command: application
        args: [status, --json]`, `      check:
        win32:
          command: winget
          args: [list, --id, Vendor.Application, --exact]
        darwin:
          command: brew
          args: [list, --cask, application]`)
  .replace(`    presence_check:
      command: application
      args: [--version]`, `    presence_check:
      win32:
        command: winget
        args: [list, --id, Vendor.Application, --exact]
      darwin:
        command: brew
        args: [list, --cask, application]`);

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("discoverExternalApps", () => {
  test("discovers declarations from bundled and installed required squads", () => {
    const root = tempRoot();
    const bundled = writeSidecar(root, "bundled", APP);
    const required = writeSidecar(root, "required", APP.replaceAll("vendor.application", "vendor.second").replaceAll("Application", "Second"));

    const apps = discoverExternalApps([
      { slug: "bundled", path: bundled },
      { slug: "required", path: required },
    ]);

    expect(apps.map((app) => app.id)).toEqual(["vendor.application", "vendor.second"]);
    expect(apps[0].source_squads).toEqual(["bundled"]);
    expect(apps[1].source_squads).toEqual(["required"]);
  });

  test("deduplicates an identical stable id and records every source squad", () => {
    const root = tempRoot();
    const first = writeSidecar(root, "first", APP);
    const second = writeSidecar(root, "second", APP);

    const apps = discoverExternalApps([
      { slug: "first", path: first },
      { slug: "second", path: second },
    ]);

    expect(apps).toHaveLength(1);
    expect(apps[0].source_squads).toEqual(["first", "second"]);
  });

  test("deduplicates declarations whose platform and permission order differs", () => {
    const root = tempRoot();
    const first = writeSidecar(root, "first", APP);
    const reordered = APP
      .replace("platforms: [win32, darwin]", "platforms: [darwin, win32]")
      .replace("permissions: [accessibility, screen-recording]", "permissions: [screen-recording, accessibility]");
    const second = writeSidecar(root, "second", reordered);

    const apps = discoverExternalApps([
      { slug: "first", path: first },
      { slug: "second", path: second },
    ]);

    expect(apps).toHaveLength(1);
    expect(apps[0].source_squads).toEqual(["first", "second"]);
  });

  test("rejects conflicting declarations that share a stable id", () => {
    const root = tempRoot();
    const first = writeSidecar(root, "first", APP);
    const second = writeSidecar(root, "second", APP.replace("license: MIT", "license: Proprietary"));

    expect(() => discoverExternalApps([
      { slug: "first", path: first },
      { slug: "second", path: second },
    ])).toThrow("conflicting external app declaration 'vendor.application'");
  });

  test("keeps legacy sidecars without external apps valid", () => {
    const root = tempRoot();
    const legacy = writeSidecar(root, "legacy", "schema_version: '1.0'\nenv_vars:\n  - name: TOKEN\n    required: false\n");

    expect(discoverExternalApps([{ slug: "legacy", path: legacy }])).toEqual([]);
  });

  test("keeps legacy single-command checks valid on every declared platform", () => {
    const root = tempRoot();
    const squad = writeSidecar(root, "legacy-checks", APP);
    const app = discoverExternalApps([{ slug: "legacy-checks", path: squad }])[0];

    expect(buildExternalAppPlan([app], { platform: "win32" }).results[0].presence_check?.command).toBe("application");
    expect(buildExternalAppPlan([app], { platform: "darwin" }).results[0].presence_check?.command).toBe("application");
  });

  test("selects platform-specific presence and compatibility checks into the consent plan", () => {
    const root = tempRoot();
    const squad = writeSidecar(root, "platform-checks", PLATFORM_CHECKS_APP);
    const app = discoverExternalApps([{ slug: "platform-checks", path: squad }])[0];

    const windows = buildExternalAppPlan([app], { platform: "win32" });
    const macos = buildExternalAppPlan([app], { platform: "darwin" });

    expect(windows.results[0].presence_check).toEqual({
      command: "winget",
      args: ["list", "--id", "Vendor.Application", "--exact"],
    });
    expect(windows.results[0].compatibility_check?.command).toBe("winget");
    expect(macos.results[0].presence_check).toEqual({
      command: "brew",
      args: ["list", "--cask", "application"],
    });
    expect(macos.results[0].compatibility_check?.command).toBe("brew");
    expect(windows.digest).not.toBe(macos.digest);

    const changedMacSquad = writeSidecar(root, "platform-checks", PLATFORM_CHECKS_APP.replaceAll(
      "args: [list, --cask, application]",
      "args: [list, --cask, application-renamed]",
    ));
    const changedMacApp = discoverExternalApps([{ slug: "platform-checks", path: changedMacSquad }])[0];
    expect(buildExternalAppPlan([changedMacApp], { platform: "win32" }).digest).toBe(windows.digest);
    expect(buildExternalAppPlan([changedMacApp], { platform: "darwin" }).digest).not.toBe(macos.digest);
  });

  test("rejects shell-shaped or extensible command declarations", () => {
    const root = tempRoot();
    const shellCommand = writeSidecar(root, "shell-command", APP.replace("command: application", "command: application --version"));
    expect(() => discoverExternalApps([{ slug: "shell-command", path: shellCommand }])).toThrow("must be an executable name or absolute path");

    const unknownField = writeSidecar(root, "unknown-field", APP.replace("args: [--version]", "args: [--version]\n      shell: true"));
    expect(() => discoverExternalApps([{ slug: "unknown-field", path: unknownField }])).toThrow("contains unsupported field 'shell'");

    for (const [slug, command, args] of [
      ["powershell", "powershell.exe", "[-Command, Write-Host pwned]"],
      ["cmd", "cmd.exe", "[/c, echo pwned]"],
      ["bash", "bash", "[-c, echo pwned]"],
      ["python-inline", "python", "[-c, print('pwned')]"],
      ["python-concatenated", "python", "[-cprint('pwned')]"],
      ["bun-inline", "bun", "[-e, console.log('pwned')]"],
      ["node-equals", "node", "[--eval=process.exit()]"],
      ["env-wrapper", "env", "[bash, -c, echo pwned]"],
      ["busybox-wrapper", "busybox", "[sh, -c, echo pwned]"],
      ["wsl-wrapper", "wsl.exe", "[sh, -c, echo pwned]"],
    ]) {
      const malicious = APP.replace(
        "command: application\n      args: [--version]",
        `command: ${command}\n      args: ${args}`,
      );
      expect(() => discoverExternalApps([{ slug, path: writeSidecar(root, slug, malicious) }])).toThrow("shell or inline interpreter");
    }
  });
});

function appForMarker(root: string, required: boolean, installContent = "compatible"): ExternalAppDependency {
  const marker = join(root, "application.marker");
  const presenceScript = join(root, "presence.ts");
  const compatibilityScript = join(root, "compatibility.ts");
  const installScript = join(root, "install.ts");
  writeFileSync(presenceScript, "import { existsSync } from 'node:fs'; process.exit(existsSync(process.argv[2]) ? 0 : 1);\n");
  writeFileSync(compatibilityScript, "import { readFileSync } from 'node:fs'; try { process.exit(readFileSync(process.argv[2], 'utf8') === 'compatible' ? 0 : 1); } catch { process.exit(1); }\n");
  writeFileSync(installScript, `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], ${JSON.stringify(installContent)});\n`);
  return {
    id: "vendor.application",
    name: "Application",
    description: "Desktop automation runtime.",
    required,
    capability: "automation.desktop",
    license: "MIT",
    homepage: "https://example.com/application",
    source: "https://github.com/vendor/application",
    platforms: ["win32"],
    permissions: ["accessibility"],
    compatibility: {
      requirement: ">=1.4.0 <2.0.0",
      check: { command: "bun", args: [compatibilityScript, marker] },
    },
    presence_check: { command: "bun", args: [presenceScript, marker] },
    install: {
      win32: { command: "bun", args: [installScript, marker] },
    },
    source_squads: ["test-squad"],
  };
}

describe("external app planning and accepted execution", () => {
  test("reuses an existing compatible application without reinstalling it", () => {
    const root = tempRoot();
    const marker = join(root, "application.marker");
    writeFileSync(marker, "compatible");

    const plan = buildExternalAppPlan([appForMarker(root, true)], { platform: "win32" });
    const execution = executeExternalAppPlan(plan, plan.digest);

    expect(execution.readiness).toBe("ready");
    expect(execution.results[0].status).toBe("already_present");
    expect(execution.actions.some((action) => action.phase === "install")).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe("compatible");
  });

  test("pure preflight exposes install argv without mutating the machine", () => {
    const root = tempRoot();
    const marker = join(root, "application.marker");

    const plan = buildExternalAppPlan([appForMarker(root, true)], { platform: "win32" });
    const preflight = confirmationRequiredExternalAppPlan(plan);

    expect(preflight.readiness).toBe("confirmation_required");
    expect(plan.results[0].status).toBe("pending_decision");
    expect(plan.results[0].install_action?.command).toBe("bun");
    expect(existsSync(marker)).toBe(false);
  });

  test("degrades an optional capability when explicitly declined", () => {
    const root = tempRoot();

    const plan = buildExternalAppPlan([appForMarker(root, false)], { platform: "win32" });
    const execution = declineExternalAppPlan(plan);

    expect(execution.readiness).toBe("degraded");
    expect(execution.degradedCapabilities).toEqual(["automation.desktop"]);
    expect(execution.results[0].status).toBe("declined");
    expect(execution.results[0].enable_hint).toContain("exact digest");
  });

  test("blocks a required dependency when explicitly declined", () => {
    const root = tempRoot();

    const plan = buildExternalAppPlan([appForMarker(root, true)], { platform: "win32" });
    const execution = declineExternalAppPlan(plan);

    expect(execution.readiness).toBe("blocked");
    expect(execution.blockingErrors).toEqual(["required external app unavailable: vendor.application (declined)"]);
  });

  test("installs an accepted missing application and verifies compatibility", () => {
    const root = tempRoot();
    const marker = join(root, "application.marker");

    const plan = buildExternalAppPlan([appForMarker(root, true)], { platform: "win32" });
    const execution = executeExternalAppPlan(plan, plan.digest);

    expect(execution.readiness).toBe("ready");
    expect(execution.results[0].status).toBe("installed");
    expect(readFileSync(marker, "utf8")).toBe("compatible");
  });

  test("reports unsupported platforms and degrades optional capabilities", () => {
    const root = tempRoot();

    const plan = buildExternalAppPlan([appForMarker(root, false)], { platform: "darwin" });
    const execution = executeExternalAppPlan(plan, plan.digest);

    expect(execution.readiness).toBe("degraded");
    expect(execution.results[0].status).toBe("unsupported_platform");
    expect(execution.degradedCapabilities).toEqual(["automation.desktop"]);
  });

  test("blocks when post-install compatibility validation fails", () => {
    const root = tempRoot();

    const plan = buildExternalAppPlan([appForMarker(root, true, "incompatible")], { platform: "win32" });
    const execution = executeExternalAppPlan(plan, plan.digest);

    expect(execution.readiness).toBe("blocked");
    expect(execution.results[0].status).toBe("compatibility_failed");
    expect(execution.results[0].error).toContain("compatibility check failed");
    expect(execution.changedApps).toEqual(["vendor.application"]);
    expect(execution.warnings.join(" ")).toContain("not rolled back");
  });
});
