// driver-workspace.test.ts — runHeadless with a workspace: the child starts in
// its run folder, the project stays granted, and on claude-code the runs
// beside it arrive as deny rules through --settings.
//
// Hermetic: fake CLIs on a temp PATH record their cwd, their argv and the
// settings file as it was when they started (the driver removes it after).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runHeadless } from "../../_shared/lib/host-agent-driver.ts";
import { claudeAbsolutePattern, workspaceDirective } from "../../_shared/lib/run-workspace.ts";
import { writeFakeCli } from "./helpers/fake-cli.ts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-driver-workspace-")));
const BIN = path.join(TMP, "bin");
const CAP = path.join(TMP, "capture");
const ROOT = path.join(TMP, "project");
const MINE = path.join(ROOT, "outputs", "run-mine");
const OTHER = path.join(ROOT, "outputs", "run-other");

const KEYS = ["PATH", "FAKE_CAPTURE_DIR", "CLAUDE_CONFIG_DIR", "NIRVANA_MODEL", "ANTHROPIC_MODEL", "NIRVANA_ORCA_HOST"];
const saved: Record<string, string | undefined> = {};

/** Records cwd, argv and the --settings file (read while it still exists). */
const RECORDER = `
import * as fs from "node:fs";
import * as path from "node:path";
const argv = Bun.argv.slice(2);
const name = path.basename(import.meta.path).replace(/\\.ts$/, "");
const i = argv.indexOf("--settings");
const settings = i >= 0 ? fs.readFileSync(argv[i + 1], "utf8") : null;
fs.writeFileSync(path.join(process.env.FAKE_CAPTURE_DIR!, name + ".json"), JSON.stringify({ cwd: process.cwd(), argv, settings, workspace: process.env.NIRVANA_RUN_WORKSPACE ?? null }));
try { await Bun.stdin.text(); } catch {}
`;

function captured(name: string): { cwd: string; argv: string[]; settings: string | null; workspace: string | null } {
  return JSON.parse(fs.readFileSync(path.join(CAP, `${name}.json`), "utf8"));
}

beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  for (const d of [BIN, CAP, path.join(ROOT, ".nirvana"), MINE, OTHER]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(ROOT, ".nirvana", "project.yaml"), "name: fixture\n");
  fs.mkdirSync(path.join(ROOT, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Read(./.env)"] } }));
  delete process.env.NIRVANA_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  process.env.NIRVANA_ORCA_HOST = "off";
  process.env.CLAUDE_CONFIG_DIR = path.join(TMP, "claude-config");
  process.env.PATH = `${BIN}${path.delimiter}${saved.PATH ?? ""}`;
  process.env.FAKE_CAPTURE_DIR = CAP;
  writeFakeCli(BIN, "claude", RECORDER + `process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s1", total_cost_usd: 0 }));`);
  writeFakeCli(BIN, "codex", RECORDER + `const oi = argv.indexOf("-o"); if (oi >= 0) fs.writeFileSync(argv[oi + 1], "ok"); console.log(JSON.stringify({ type: "turn.completed" }));`);
});

afterAll(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("runHeadless with a workspace", () => {
  test("claude-code starts in the run folder, with the project granted and the sibling run denied", () => {
    const r = runHeadless({ runtime: "claude-code", prompt: "p", cwd: ROOT, workspace: MINE, addDirs: [path.join(MINE, "agent-x")], timeoutMs: 60_000 });
    expect(r.ok).toBe(true);
    const c = captured("claude");
    expect(fs.realpathSync(c.cwd)).toBe(MINE);
    expect(c.argv[c.argv.indexOf("--add-dir", c.argv.indexOf("--add-dir") + 1) + 1]).toBe(ROOT);
    const deny: string[] = JSON.parse(c.settings!).permissions.deny;
    const other = claudeAbsolutePattern(OTHER)!;
    expect(deny).toEqual(expect.arrayContaining([`Read(${other})`, `Read(${other}/**)`, `Edit(${other}/**)`, `Read(${claudeAbsolutePattern(ROOT)}/.env)`]));
    expect(deny.some((rule) => rule.includes("run-mine"))).toBe(false);
    // The settings file is the run's own and does not outlive it.
    expect(fs.existsSync(c.argv[c.argv.indexOf("--settings") + 1])).toBe(false);
    // The child knows its run folder, so a dispatch it starts nests inside it.
    expect(c.workspace).toBe(MINE);
  });

  test("codex starts in the run folder too (-C), with no Claude settings", () => {
    const r = runHeadless({ runtime: "codex", prompt: "p", cwd: ROOT, workspace: MINE, timeoutMs: 60_000 });
    expect(r.ok).toBe(true);
    const c = captured("codex");
    expect(fs.realpathSync(c.cwd)).toBe(MINE);
    expect(c.argv[c.argv.indexOf("-C") + 1]).toBe(MINE);
    expect(c.argv).not.toContain("--settings");
  });

  test("without a workspace nothing moves", () => {
    runHeadless({ runtime: "claude-code", prompt: "p", cwd: ROOT, timeoutMs: 60_000 });
    const c = captured("claude");
    expect(fs.realpathSync(c.cwd)).toBe(ROOT);
    expect(c.argv).not.toContain("--settings");
    expect(c.workspace).toBeNull();
  });

  test("the directive line names the run folder and the folders beside it", () => {
    expect(workspaceDirective(MINE)).toContain(MINE);
    expect(workspaceDirective(MINE)).toContain(path.dirname(MINE));
  });
});
