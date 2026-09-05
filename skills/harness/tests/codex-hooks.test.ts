// codex-hooks.test.ts — the trust hash Codex computes for a hook, reproduced;
// the trust record written and removed in a config.toml without touching the
// rest of it; our handlers in a hooks.json recognised with their trust state.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { codexHookHash, codexHookStateKey, codexHookTrustEntries, readCodexHookState, removeCodexHookTrust, upsertCodexHookTrust } from "../../_shared/lib/codex-hooks.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });
function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-codex-hooks-")); roots.push(d); return d; }

describe("codexHookHash — the hash Codex 0.153 records under hooks.state", () => {
  test("golden: canonical JSON of {event_name, hooks:[normalized], matcher}, sha256", () => {
    // Identity: {"event_name":"pre_tool_use","hooks":[{"async":true,"command":"bun \"/x/audit-emit-from-hook.ts\" pre codex","timeout":5,"type":"command"}],"matcher":"Bash|apply_patch"}
    const h = codexHookHash("PreToolUse", "Bash|apply_patch", { type: "command", command: 'bun "/x/audit-emit-from-hook.ts" pre codex', timeout: 5, async: true });
    expect(h).toBe("sha256:1068ce4e949c54cfdb58dce274a2dbb4047af82d76799d5f3d61f578f30239c3");
  });

  test("normalization: timeout defaults to 600, async to false, matcher only when given, statusMessage only when set", () => {
    const base = codexHookHash("PostToolUse", undefined, { type: "command", command: "x" });
    expect(base).toBe(codexHookHash("PostToolUse", undefined, { type: "command", command: "x", timeout: 600, async: false }));
    expect(base).not.toBe(codexHookHash("PostToolUse", "Bash", { type: "command", command: "x" }));
    expect(base).not.toBe(codexHookHash("PostToolUse", undefined, { type: "command", command: "x", statusMessage: "hi" }));
    // A handler key Codex ignores (name) never enters the identity.
    expect(base).toBe(codexHookHash("PostToolUse", undefined, { type: "command", command: "x", name: "ours" }));
    // commandWindows never survives normalization off Windows.
    expect(base).toBe(codexHookHash("PostToolUse", undefined, { type: "command", command: "x", commandWindows: "y" }, "darwin"));
  });

  test("state key is <file>:<label>:<group>:<handler>", () => {
    expect(codexHookStateKey("/h/.codex/hooks.json", "PreToolUse", 2, 0)).toBe("/h/.codex/hooks.json:pre_tool_use:2:0");
  });
});

describe("trust records in config.toml", () => {
  test("upsert appends, is idempotent, replaces a stale hash, and leaves the rest of the file byte-identical", () => {
    const d = tmp();
    const cfg = path.join(d, "config.toml");
    const before = 'model = "gpt-5.6-sol"\n\n[projects."/x"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(cfg, before);
    const key = "/h/.codex/hooks.json:pre_tool_use:0:0";
    expect(upsertCodexHookTrust(cfg, key, "sha256:aaa")).toBe(true);
    expect(upsertCodexHookTrust(cfg, key, "sha256:aaa")).toBe(false);
    let raw = fs.readFileSync(cfg, "utf8");
    expect(raw.startsWith(before.trimEnd())).toBe(true);
    expect(readCodexHookState(cfg).get(key)?.trusted_hash).toBe("sha256:aaa");
    expect(upsertCodexHookTrust(cfg, key, "sha256:bbb")).toBe(true);
    raw = fs.readFileSync(cfg, "utf8");
    expect(raw.match(/hooks\.state/g)!.length).toBe(1);
    expect(readCodexHookState(cfg).get(key)?.trusted_hash).toBe("sha256:bbb");
    expect(removeCodexHookTrust(cfg, [key])).toBe(true);
    expect(fs.readFileSync(cfg, "utf8").trim()).toBe(before.trim());
    expect(removeCodexHookTrust(cfg, [key])).toBe(false);
  });

  test("a key with backslashes (Windows path) round-trips through TOML escaping", () => {
    const d = tmp();
    const cfg = path.join(d, "config.toml");
    const key = "C:\\Users\\me\\.codex\\hooks.json:post_tool_use:1:0";
    upsertCodexHookTrust(cfg, key, "sha256:ccc");
    expect(readCodexHookState(cfg).get(key)?.trusted_hash).toBe("sha256:ccc");
    expect(removeCodexHookTrust(cfg, [key])).toBe(true);
    expect(readCodexHookState(cfg).size).toBe(0);
  });

  test("codexHookTrustEntries finds ours by token and reports trust per handler", () => {
    const d = tmp();
    const hooks = path.join(d, "hooks.json");
    const cfg = path.join(d, "config.toml");
    fs.writeFileSync(hooks, JSON.stringify({ hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] },
        { matcher: "Bash|apply_patch", hooks: [{ type: "command", command: 'bun "/s/audit-emit-from-hook.ts" pre codex', async: true, timeout: 5 }] },
      ],
      PostToolUse: [{ matcher: "Bash|apply_patch", hooks: [{ type: "command", command: 'bun "/s/audit-emit-from-hook.ts" post codex', async: true, timeout: 5 }] }],
    } }));
    let entries = codexHookTrustEntries(hooks, cfg, "audit-emit-from-hook.ts");
    expect(entries.map((e) => e.key)).toEqual([`${hooks}:pre_tool_use:1:0`, `${hooks}:post_tool_use:0:0`]);
    expect(entries.every((e) => !e.trusted)).toBe(true);
    for (const e of entries) upsertCodexHookTrust(cfg, e.key, e.hash);
    entries = codexHookTrustEntries(hooks, cfg, "audit-emit-from-hook.ts");
    expect(entries.every((e) => e.trusted)).toBe(true);
  });
});
