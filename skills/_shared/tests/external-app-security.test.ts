import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildExternalAppPlan,
  discoverExternalApps,
  executeExternalAppPlan,
  type ExternalAppDependency,
} from "../lib/external-app-dependencies.ts";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nrv-external-security-"));
  tempRoots.push(root);
  return root;
}

function commandScript(root: string, name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, body);
  return path;
}

function dependency(root: string, options: { id?: string; required?: boolean; installFails?: boolean; compatibilityFails?: boolean } = {}): ExternalAppDependency {
  const id = options.id ?? "vendor.application";
  const safe = id.replaceAll(/[._-]/g, "_");
  const marker = join(root, `${safe}.marker`);
  const order = join(root, "order.log");
  const presence = commandScript(root, `${safe}-presence.ts`, `import { appendFileSync, existsSync } from 'node:fs'; appendFileSync(${JSON.stringify(order)}, 'check:${id}\\n'); process.exit(existsSync(${JSON.stringify(marker)}) ? 0 : 1);\n`);
  const compatibility = commandScript(root, `${safe}-compat.ts`, `import { appendFileSync, readFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(order)}, 'compat:${id}\\n'); try { process.exit(readFileSync(${JSON.stringify(marker)}, 'utf8') === 'compatible' ? 0 : 1); } catch { process.exit(1); }\n`);
  const install = commandScript(root, `${safe}-install.ts`, `import { appendFileSync, writeFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(order)}, 'install:${id}\\n'); ${options.installFails ? "process.exit(1);" : `writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(options.compatibilityFails ? "incompatible" : "compatible")});`}\n`);
  return {
    id,
    name: id,
    description: "Desktop runtime.",
    required: options.required ?? false,
    capability: `capability.${safe}`,
    license: "MIT",
    homepage: "https://example.com/application",
    source: "https://github.com/vendor/application",
    platforms: ["win32"],
    permissions: ["accessibility"],
    compatibility: {
      requirement: ">=1.0.0 <2.0.0",
      check: { command: "bun", args: [compatibility] },
    },
    presence_check: { command: "bun", args: [presence] },
    install: { win32: { command: "bun", args: [install] } },
    source_squads: ["test-squad"],
  };
}

function writeSidecar(root: string, yaml: string): string {
  const squad = join(root, "squad");
  mkdirSync(squad, { recursive: true });
  writeFileSync(join(squad, "dependencies.yaml"), yaml);
  return squad;
}

const BASE_YAML = `external_apps:
  - id: vendor.application
    name: Application
    description: Desktop runtime.
    required: false
    capability: automation.desktop
    license: MIT
    homepage: https://example.com/application
    source: https://github.com/vendor/application
    platforms: [win32]
    permissions: [accessibility]
    compatibility:
      requirement: ">=1.0.0 <2.0.0"
    presence_check:
      command: application.exe
      args: [--version]
    install:
      win32:
        command: winget.exe
        args: [install, --id, Vendor.Application]
`;

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("untrusted external app declarations", () => {
  test("rejects unknown fields at app, compatibility, and install levels", () => {
    const root = tempRoot();
    expect(() => discoverExternalApps([{ slug: "squad", path: writeSidecar(root, BASE_YAML.replace("    name: Application", "    name: Application\n    surprise: true")) }])).toThrow("unsupported field 'surprise'");
    expect(() => discoverExternalApps([{ slug: "squad", path: writeSidecar(root, BASE_YAML.replace("      requirement:", "      mode: shell\n      requirement:")) }])).toThrow("unsupported field 'mode'");
    expect(() => discoverExternalApps([{ slug: "squad", path: writeSidecar(root, BASE_YAML.replace("      win32:", "      solaris:\n        command: pkg\n        args: [install]\n      win32:")) }])).toThrow("unsupported install platform 'solaris'");
  });

  test("rejects secret-bearing argv and credentialed URLs", () => {
    const root = tempRoot();
    const variants = [
      BASE_YAML.replace("args: [--version]", "args: [--token, supersecret]"),
      BASE_YAML.replace("args: [--version]", "args: [API_KEY=abc]"),
      BASE_YAML.replace("args: [--version]", "args: [--password=hunter2]"),
      BASE_YAML.replace("args: [--version]", "args: [Authorization, 'Bearer abc']"),
      BASE_YAML.replace("args: [--version]", "args: [OPENAI_API_KEY=abc]"),
      BASE_YAML.replace("args: [--version]", "args: [AWS_SECRET_ACCESS_KEY=abc]"),
      BASE_YAML.replace("args: [--version]", "args: ['--header=X-API-Key: abc']"),
      BASE_YAML.replace("args: [--version]", "args: ['Cookie: session=abc']"),
      BASE_YAML.replace("https://github.com/vendor/application", "https://user:pass@github.com/vendor/application"),
      BASE_YAML.replace("https://example.com/application", "https://example.com/application?token=abc"),
      BASE_YAML.replace("https://github.com/vendor/application", "https://github.com/vendor/ghp_1234567890abcdef"),
      BASE_YAML.replace("https://example.com/application", "https://example.com/application?ref=ghp_1234567890abcdef"),
      BASE_YAML.replace("https://example.com/application", "https://example.com/application#sk-1234567890abcdef"),
    ];
    for (const yaml of variants) {
      expect(() => discoverExternalApps([{ slug: "squad", path: writeSidecar(root, yaml) }])).toThrow(/secret-bearing|credentialed URL/);
    }
  });

  test("rejects non-https public URLs and control characters in strings", () => {
    const root = tempRoot();
    expect(() => discoverExternalApps([{ slug: "squad", path: writeSidecar(root, BASE_YAML.replace("https://example.com/application", "http://example.com/application")) }])).toThrow("must use https");
    expect(() => discoverExternalApps([{ slug: "squad", path: writeSidecar(root, BASE_YAML.replace("description: Desktop runtime.", 'description: "Desktop\\nRuntime"')) }])).toThrow("control characters");
    expect(() => discoverExternalApps([{ slug: "squad", path: writeSidecar(root, BASE_YAML.replace("args: [--version]", 'args: ["status\\u0085hidden"]')) }])).toThrow("control characters");
  });

  test("accepts macOS argv and Windows absolute executable paths with spaces", () => {
    const root = tempRoot();
    const windows = BASE_YAML.replace("command: application.exe", "command: 'C:\\\\Program Files\\\\Application\\\\application.exe'");
    expect(discoverExternalApps([{ slug: "squad", path: writeSidecar(root, windows) }])[0].presence_check.command).toContain("Program Files");

    const mac = BASE_YAML
      .replaceAll("win32", "darwin")
      .replace("command: application.exe", "command: /Applications/Application.app/Contents/MacOS/application")
      .replace("args: [--version]", "args: [status, '--output format', json]");
    expect(discoverExternalApps([{ slug: "squad", path: writeSidecar(root, mac) }])[0].presence_check.args).toEqual(["status", "--output format", "json"]);
  });
});

describe("pure preflight and digest-bound execution", () => {
  test("builds a complete canonical plan without running a mutating check", () => {
    const root = tempRoot();
    const app = dependency(root, { required: true });
    const order = join(root, "order.log");

    const first = buildExternalAppPlan([app], { platform: "win32" });
    const second = buildExternalAppPlan([app], { platform: "win32" });

    expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second.digest).toBe(first.digest);
    expect(existsSync(order)).toBe(false);
    expect(first.results[0]).toMatchObject({
      name: app.name,
      license: "MIT",
      source: app.source,
      homepage: app.homepage,
      permissions: ["accessibility"],
      platform: "win32",
      compatibility_requirement: ">=1.0.0 <2.0.0",
      install_action: app.install.win32,
      status: "pending_decision",
    });
  });

  test("digest mismatch executes zero commands", () => {
    const root = tempRoot();
    const plan = buildExternalAppPlan([dependency(root, { required: true })], { platform: "win32" });

    const result = executeExternalAppPlan(plan, "sha256:" + "0".repeat(64));

    expect(result.readiness).toBe("confirmation_required");
    expect(result.actions).toEqual([]);
    expect(result.changedApps).toEqual([]);
    expect(existsSync(join(root, "order.log"))).toBe(false);
  });

  test("rejects a plan whose execution-relevant status changed after consent", () => {
    const root = tempRoot();
    const plan = buildExternalAppPlan([dependency(root, { required: true })], { platform: "win32" });
    plan.results[0].status = "already_present";

    const result = executeExternalAppPlan(plan, plan.digest);

    expect(result.readiness).toBe("confirmation_required");
    expect(result.actions).toEqual([]);
    expect(existsSync(join(root, "order.log"))).toBe(false);
  });

  test("uses a minimal environment and completes all checks before required then optional installs", () => {
    const root = tempRoot();
    process.env.NIRVANA_TEST_SECRET = "must-not-leak";
    const environmentProbe = commandScript(root, "environment-probe.ts", `import { appendFileSync, existsSync, writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(root, "env.txt"))}, process.env.NIRVANA_TEST_SECRET ?? 'absent'); appendFileSync(${JSON.stringify(join(root, "order.log"))}, 'check:vendor.required\\n'); process.exit(existsSync(${JSON.stringify(join(root, "vendor_required.marker"))}) ? 0 : 1);\n`);
    const required = dependency(root, { id: "vendor.required", required: true });
    required.presence_check = { command: "bun", args: [environmentProbe] };
    const optional = dependency(root, { id: "vendor.optional", required: false });
    const plan = buildExternalAppPlan([optional, required], { platform: "win32" });

    const result = executeExternalAppPlan(plan, plan.digest);

    expect(result.readiness).toBe("ready");
    expect(readFileSync(join(root, "env.txt"), "utf8")).toBe("absent");
    const order = readFileSync(join(root, "order.log"), "utf8").trim().split("\n");
    expect(order.indexOf("install:vendor.required")).toBeGreaterThan(order.indexOf("check:vendor.optional"));
    expect(order.indexOf("install:vendor.optional")).toBeGreaterThan(order.indexOf("install:vendor.required"));
    expect(result.changedApps).toEqual(["vendor.required", "vendor.optional"]);
    expect(result.actions.filter((action) => action.phase === "install")).toHaveLength(2);
    delete process.env.NIRVANA_TEST_SECRET;
  });

  test("uses status-specific remediation for unsupported and compatibility failures", () => {
    const root = tempRoot();
    const unsupportedPlan = buildExternalAppPlan([dependency(root)], { platform: "darwin" });
    const unsupported = executeExternalAppPlan(unsupportedPlan, unsupportedPlan.digest);
    expect(unsupported.results[0].status).toBe("unsupported_platform");
    expect(unsupported.results[0].enable_hint).not.toContain("consent");

    const incompatiblePlan = buildExternalAppPlan([dependency(root, { required: true, compatibilityFails: true })], { platform: "win32" });
    const incompatible = executeExternalAppPlan(incompatiblePlan, incompatiblePlan.digest);
    expect(incompatible.results[0].status).toBe("compatibility_failed");
    expect(incompatible.results[0].error).toBe("compatibility check failed after installation");
    expect(incompatible.results[0].enable_hint).toContain(">=1.0.0 <2.0.0");
  });
});
