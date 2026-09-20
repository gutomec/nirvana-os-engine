import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { patchHermesAllowlist, patchHermesAuditHooks, patchHermesExternalDirs, publishHermesJson, publishHermesYaml } from "../../_shared/lib/hermes-config.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });
function temp(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-hermes-config-")); roots.push(root); return root; }

describe("Hermes installer configuration", () => {
  test("recognizes semantic external directories even when a comment mentions both paths", () => {
    const file = "/tmp/config.yaml";
    const raw = [
      "# /bridge and ${NIRVANA_PROJECT_SKILLS} are described here, not configured.",
      "skills:",
      "  external_dirs:",
      "    - /user-skills",
      "",
    ].join("\n");
    const candidate = patchHermesExternalDirs(raw, file, "/bridge", "${NIRVANA_PROJECT_SKILLS}");
    expect(candidate).toContain("- /bridge");
    expect(candidate).toContain("- ${NIRVANA_PROJECT_SKILLS}");
    expect(patchHermesExternalDirs(candidate!, file, "/bridge", "${NIRVANA_PROJECT_SKILLS}")).toBeNull();
  });

  test("repairs only the missing audit event and keeps user hooks", () => {
    const file = "/tmp/config.yaml";
    const raw = [
      "hooks:",
      "  pre_tool_call:",
      "    - matcher: terminal",
      "      command: bun /bridge/audit-emit-from-hermes-hook.ts pre",
      "      timeout: 5",
      "    - matcher: terminal",
      "      command: echo user",
      "",
    ].join("\n");
    const candidate = patchHermesAuditHooks(raw, file, "audit-emit-from-hermes-hook.ts", [
      ["pre_tool_call", "bun /bridge/audit-emit-from-hermes-hook.ts pre"],
      ["post_tool_call", "bun /bridge/audit-emit-from-hermes-hook.ts post"],
    ]);
    expect(candidate).toContain("command: echo user");
    expect((candidate!.match(/audit-emit-from-hermes-hook\.ts/g) ?? [])).toHaveLength(2);
    expect(patchHermesAuditHooks(candidate!, file, "audit-emit-from-hermes-hook.ts", [
      ["pre_tool_call", "bun /bridge/audit-emit-from-hermes-hook.ts pre"],
      ["post_tool_call", "bun /bridge/audit-emit-from-hermes-hook.ts post"],
    ])).toBeNull();
  });

  test("retrying already-wired hooks still requires a valid allowlist", () => {
    const file = "/tmp/config.yaml";
    const pairs: Array<[string, string]> = [
      ["pre_tool_call", "bun /bridge/audit-emit-from-hermes-hook.ts pre"],
      ["post_tool_call", "bun /bridge/audit-emit-from-hermes-hook.ts post"],
    ];
    const wired = [
      "hooks:",
      "  pre_tool_call:",
      "    - command: bun /bridge/audit-emit-from-hermes-hook.ts pre",
      "  post_tool_call:",
      "    - command: bun /bridge/audit-emit-from-hermes-hook.ts post",
      "",
    ].join("\n");
    expect(patchHermesAuditHooks(wired, file, "audit-emit-from-hermes-hook.ts", pairs)).toBeNull();
    expect(() => patchHermesAllowlist('{"approvals": [}', "/tmp/allowlist.json", pairs, "2026-01-01T00:00:00Z")).toThrow("invalid Hermes allowlist JSON");
    expect(JSON.parse(patchHermesAllowlist('{"approvals":[]}', "/tmp/allowlist.json", pairs, "2026-01-01T00:00:00Z")!).approvals).toHaveLength(2);
  });

  test("rejects malformed YAML without publishing a replacement", () => {
    const root = temp();
    const file = path.join(root, "config.yaml");
    const raw = "hooks: [\n";
    fs.writeFileSync(file, raw);
    expect(() => patchHermesAuditHooks(raw, file, "audit-emit-from-hermes-hook.ts", [["pre_tool_call", "bun hook pre"]])).toThrow("invalid Hermes YAML");
    expect(fs.readFileSync(file, "utf8")).toBe(raw);
    expect(fs.readdirSync(root).filter((name) => name.includes("nirvana-backup"))).toHaveLength(0);
  });

  test("rejects non-mapping YAML sections instead of replacing them", () => {
    expect(() => patchHermesExternalDirs("skills: disabled\n", "/tmp/config.yaml", "/bridge", "${NIRVANA_PROJECT_SKILLS}")).toThrow("expected a mapping");
    expect(() => patchHermesAuditHooks("hooks: disabled\n", "/tmp/config.yaml", "audit", [["pre_tool_call", "bun hook pre"]])).toThrow("expected a mapping");
  });

  test("publishes a validated YAML candidate with a backup and idempotent repeat", () => {
    const root = temp();
    const file = path.join(root, "config.yaml");
    const raw = "skills:\n  external_dirs: []\n";
    fs.writeFileSync(file, raw);
    const candidate = patchHermesExternalDirs(raw, file, "/bridge", "${NIRVANA_PROJECT_SKILLS}")!;
    publishHermesYaml(file, raw, candidate);
    expect(fs.readFileSync(file, "utf8")).toBe(candidate);
    expect(fs.readdirSync(root).filter((name) => name.includes("nirvana-backup"))).toHaveLength(1);
    expect(patchHermesExternalDirs(candidate, file, "/bridge", "${NIRVANA_PROJECT_SKILLS}")).toBeNull();
  });

  test("refuses changed candidates and concurrent writes, preserving the original", () => {
    const root = temp();
    const file = path.join(root, "config.yaml");
    const raw = "skills:\n  external_dirs: []\n";
    const candidate = patchHermesExternalDirs(raw, file, "/bridge", "${NIRVANA_PROJECT_SKILLS}")!;
    fs.writeFileSync(file, raw);
    expect(() => publishHermesYaml(file, raw, candidate, { afterTemporaryWrite: (temporary) => fs.writeFileSync(temporary, "skills: {}\n") })).toThrow("candidate changed");
    expect(fs.readFileSync(file, "utf8")).toBe(raw);
    expect(() => publishHermesYaml(file, raw, candidate, { beforePublish: () => fs.writeFileSync(file, "skills: {}\n") })).toThrow("changed while the candidate");
    expect(fs.readFileSync(file, "utf8")).toBe("skills: {}\n");
  });

  test.skipIf(process.platform === "win32")("preserves restrictive YAML file permissions", () => {
    const root = temp();
    const file = path.join(root, "config.yaml");
    const raw = "skills:\n  external_dirs: []\n";
    fs.writeFileSync(file, raw);
    fs.chmodSync(file, 0o600);
    publishHermesYaml(file, raw, patchHermesExternalDirs(raw, file, "/bridge", "${NIRVANA_PROJECT_SKILLS}")!);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test("preserves malformed allowlists and does not duplicate existing approvals", () => {
    const root = temp();
    const file = path.join(root, "shell-hooks-allowlist.json");
    const malformed = '{"approvals": [}';
    fs.writeFileSync(file, malformed);
    expect(() => patchHermesAllowlist(malformed, file, [["pre_tool_call", "bun hook pre"]], "2026-01-01T00:00:00Z")).toThrow("invalid Hermes allowlist JSON");
    expect(fs.readFileSync(file, "utf8")).toBe(malformed);

    const raw = JSON.stringify({ approvals: [{ event: "pre_tool_call", command: "bun hook pre", approved_at: "old", script_mtime_at_approval: null }], user_key: true });
    const candidate = patchHermesAllowlist(raw, file, [["pre_tool_call", "bun hook pre"], ["post_tool_call", "bun hook post"]], "2026-01-01T00:00:00Z")!;
    const parsed = JSON.parse(candidate);
    expect(parsed.user_key).toBe(true);
    expect(parsed.approvals).toHaveLength(2);
    expect(patchHermesAllowlist(candidate, file, [["pre_tool_call", "bun hook pre"], ["post_tool_call", "bun hook post"]], "2026-01-01T00:00:00Z")).toBeNull();
    fs.writeFileSync(file, raw);
    publishHermesJson(file, raw, candidate);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).approvals).toHaveLength(2);

    const created = path.join(root, "new-allowlist.json");
    publishHermesJson(created, null, '{"approvals":[]}');
    expect(JSON.parse(fs.readFileSync(created, "utf8")).approvals).toEqual([]);
  });

  test("keeps the original when JSON publication cannot rename the candidate", () => {
    const root = temp();
    const file = path.join(root, "shell-hooks-allowlist.json");
    const raw = '{"approvals":[]}';
    const candidate = '{"approvals":[{"event":"pre_tool_call","command":"bun hook pre"}]}';
    fs.writeFileSync(file, raw);
    expect(() => publishHermesJson(file, raw, candidate, { rename: () => { throw new Error("rename failed"); } })).toThrow("rename failed");
    expect(fs.readFileSync(file, "utf8")).toBe(raw);
    expect(fs.readdirSync(root).filter((name) => name.includes("nirvana-backup"))).toHaveLength(1);
  });

  test.skipIf(process.platform === "win32")("creates new allowlists with restrictive permissions", () => {
    const root = temp();
    const file = path.join(root, "shell-hooks-allowlist.json");
    publishHermesJson(file, null, '{"approvals":[]}');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
