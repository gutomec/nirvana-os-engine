// The Hermes audit shim, fed the payloads Hermes really sends. The shapes below
// are the output of `_serialize_payload` of the installed Hermes 0.20.5 (run on
// 2026-11-25) for `terminal`, `write_file` and `patch`; v0.23.4 adds `profile`.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SHIM = path.resolve(import.meta.dir, "../../_shared/scripts/audit-emit-from-hermes-hook.ts");
const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

/** Run the shim against a stand-in for the canonical audit script, which only
 *  records what it was handed. Returns that record, or null when nothing was handed over. */
function runShim(stage: "pre" | "post", payload: Record<string, unknown>): { argv: string[]; payload: any } | null {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-hermes-shim-"));
  roots.push(root);
  const scripts = path.join(root, "_shared", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  const out = path.join(root, "handed.json");
  fs.writeFileSync(path.join(scripts, "audit-emit-from-hook.ts"), [
    'import * as fs from "node:fs";',
    "const payload = JSON.parse(await Bun.stdin.text());",
    "fs.writeFileSync(process.env.NRV_SHIM_OUT!, JSON.stringify({ argv: process.argv.slice(2), payload }));",
    "",
  ].join("\n"));
  const r = spawnSync(process.execPath, [SHIM, stage], {
    input: JSON.stringify(payload), encoding: "utf8", windowsHide: true,
    env: { ...process.env, NIRVANA_SKILLS_DIR: root, NRV_SHIM_OUT: out },
  });
  // The golden rule: stdout empty and exit 0, or Hermes may block the tool.
  expect(r.status).toBe(0);
  expect(r.stdout).toBe("");
  return fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
}

const base = { session_id: "sess-1", cwd: os.tmpdir(), profile: "default" };

describe("Hermes audit shim", () => {
  test("a terminal command becomes a Bash event", () => {
    const got = runShim("pre", { ...base, hook_event_name: "pre_tool_call", tool_name: "terminal", tool_input: { command: "ls -la" }, extra: { task_id: "t" } });
    expect(got?.argv).toEqual(["pre", "hermes-cli"]);
    expect(got?.payload).toEqual({ tool_name: "Bash", tool_input: { command: "ls -la" }, session_id: "sess-1" });
  });

  test("write_file becomes a Write event, with the outcome Hermes reports under extra", () => {
    const got = runShim("post", { ...base, hook_event_name: "post_tool_call", tool_name: "write_file", tool_input: { path: "out/a.md", content: "x" }, extra: { result: '{"success": true}', status: "ok" } });
    expect(got?.payload).toEqual({ tool_name: "Write", tool_input: { file_path: "out/a.md" }, session_id: "sess-1", tool_response: { success: true } });
    const failed = runShim("post", { ...base, hook_event_name: "post_tool_call", tool_name: "write_file", tool_input: { path: "out/a.md", content: "x" }, extra: { result: '{"error": "denied"}', status: "error" } });
    expect(failed?.payload.tool_response).toEqual({ success: false });
  });

  test("patch becomes an Edit event in both of its modes", () => {
    const replace = runShim("pre", { ...base, hook_event_name: "pre_tool_call", tool_name: "patch", tool_input: { mode: "replace", path: "out/a.md", old_string: "x", new_string: "y" }, extra: {} });
    expect(replace?.payload).toEqual({ tool_name: "Edit", tool_input: { file_path: "out/a.md" }, session_id: "sess-1" });
    const v4a = runShim("pre", { ...base, hook_event_name: "pre_tool_call", tool_name: "patch", tool_input: { mode: "patch", patch: "*** Begin Patch\n*** Update File: out/b.md\n@@\n-x\n+y\n*** End Patch" }, extra: {} });
    expect(v4a?.payload.tool_input).toEqual({ file_path: "out/b.md" });
  });

  test("a tool that writes nothing is not handed over", () => {
    expect(runShim("pre", { ...base, hook_event_name: "pre_tool_call", tool_name: "read_file", tool_input: { path: "a.md" }, extra: {} })).toBeNull();
  });
});
