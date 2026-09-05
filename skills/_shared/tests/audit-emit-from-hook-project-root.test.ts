// audit-emit-from-hook-project-root.test.ts — the hook's own log-directory
// resolver, isolated from every other writer.
//
// audit-emit-from-hook.ts is the bridge between Claude Code's PreToolUse/
// PostToolUse hooks and the harness audit log. It has always computed its own
// log root by hand (HARNESS_LOGS_DIR or straight to ~/.harness-logs) instead
// of calling log-paths.ts::harnessLogsDir() like every other writer/reader in
// the engine. The result: a dispatched agent whose hooks fire inside a real
// project (cwd = project root, no HARNESS_LOGS_DIR pinned — the common case,
// since host-agent-driver.ts's spawns never set it) writes tool_invoked /
// artifact_touched / bash_completed events straight past the project into
// ~/.harness-logs, while the orchestrator's own dispatch_* / gate_* events for
// the SAME trace land in <project>/.nirvana/logs/harness. One run, two files.
//
// Measured live on 2026-08-28 (trace eb39d239, this very dispatch): 3 hook
// events in ~/.harness-logs, 5 orchestrator events in the project log, same
// run, same day, joined nowhere.
//
// Hermetic: no HARNESS_LOGS_DIR set (pinning it would hide the defect), no
// NIRVANA_PROJECT_ROOT either — the fallback must find the project by walking
// up from cwd, the same way log-paths.ts does for everyone else.
// Runs with: bun test skills/_shared/tests
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseAuditLine } from "../lib/cloudevents.js";
import { makeTempRoot } from "../../harness/tests/helpers/temp-dirs.ts";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

const SCRIPT = path.resolve(import.meta.dir, "..", "scripts", "audit-emit-from-hook.ts");

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = makeTempRoot("nrv-hook-projroot-"); roots.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NIRVANA_|HARNESS_)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    // USERPROFILE too: os.homedir() follows it on Windows, not HOME. Without it the
    // ~/.harness-logs fallback resolves to the REAL home, outside the tree this test
    // scans, and a leak there would go unseen.
    HOME: home, USERPROFILE: home,
    // The one built-in filter knob, used deliberately instead of naming the temp dir
    // to match a substring heuristic (fragile) or pinning NIRVANA_PROJECT_ROOT (which
    // would test the pin path, not the cwd-walk fallback this defect lives in).
    NIRVANA_AUDIT_PREFIXES: projectRoot,
  });

  const run = (stage: "pre" | "post", payload: Record<string, unknown>) =>
    spawnSync(process.execPath, [SCRIPT, stage, "claude-code"], {
      cwd: projectRoot, env, encoding: "utf8", input: JSON.stringify(payload),
    });

  return { root, home, projectRoot, env, run };
}

function eventsIn(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => parseAuditLine(l) as Record<string, unknown>);
}

describe("audit-emit-from-hook.ts — where the hook's own events land", () => {
  test("a Bash tool call inside a project writes to the project's log, not ~/.harness-logs", () => {
    const fx = fixture();
    const today = new Date().toISOString().slice(0, 10);
    const projectLog = path.join(fx.projectRoot, ".nirvana", "logs", "harness", today, "audit.jsonl");
    const homeLog = path.join(fx.home, ".harness-logs", today, "audit.jsonl");

    const result = fx.run("post", {
      session_id: "sess-fixture",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      tool_response: { success: true },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);

    expect(fs.existsSync(homeLog), "hook event must not fall through to the home root").toBe(false);
    const events = eventsIn(projectLog);
    expect(events.some(e => e.event === "bash_completed")).toBe(true);
  }, spawnBudgetMs(1));

  test("a Bash tool call with no project in reach still logs somewhere sane (~/.harness-logs)", () => {
    const fx = fixture();
    const today = new Date().toISOString().slice(0, 10);
    // No project markers anywhere between here and home: the standalone case
    // this cut must not break (`nrv dispatch` from an arbitrary directory).
    const standalone = path.join(fx.root, "standalone");
    fs.mkdirSync(standalone, { recursive: true });
    const env = { ...fx.env, NIRVANA_AUDIT_PREFIXES: standalone };
    const result = spawnSync(process.execPath, [SCRIPT, "post", "claude-code"], {
      cwd: standalone, env, encoding: "utf8",
      input: JSON.stringify({ session_id: "sess-standalone", tool_name: "Bash", tool_input: { command: "echo hi" }, tool_response: { success: true } }),
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);

    const homeLog = path.join(fx.home, ".harness-logs", today, "audit.jsonl");
    const events = eventsIn(homeLog);
    expect(events.some(e => e.event === "bash_completed")).toBe(true);
  }, spawnBudgetMs(1));
});

describe("audit-emit-from-hook.ts — the Codex shape", () => {
  test("apply_patch: one artifact_touched per file named in the patch, success from the exit code", () => {
    const fx = fixture();
    const today = new Date().toISOString().slice(0, 10);
    const projectLog = path.join(fx.projectRoot, ".nirvana", "logs", "harness", today, "audit.jsonl");
    const target = path.join(fx.projectRoot, "note.txt");
    fs.writeFileSync(target, "bye\n");
    const patch = `*** Begin Patch\n*** Update File: ${target}\n@@\n-hello\n+bye\n*** End Patch`;
    const r = spawnSync(process.execPath, [SCRIPT, "post", "codex"], {
      cwd: fx.projectRoot, env: fx.env, encoding: "utf8",
      input: JSON.stringify({ session_id: "cx-1", tool_name: "apply_patch", tool_input: { command: patch }, tool_response: "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess." }),
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const ev = eventsIn(projectLog).find(e => e.event === "artifact_touched") as Record<string, unknown> | undefined;
    expect(ev).toBeTruthy();
    expect(ev!.file_path).toBe(target);
    expect(ev!.action).toBe("edit");
    expect(ev!.success).toBe(true);
    expect(ev!.size_bytes).toBe(4);
    expect(ev!.host).toBe("codex-hook");
  }, spawnBudgetMs(1));

  test("Bash with a string tool_response: a non-zero exit code is a failed bash_completed", () => {
    const fx = fixture();
    const today = new Date().toISOString().slice(0, 10);
    const projectLog = path.join(fx.projectRoot, ".nirvana", "logs", "harness", today, "audit.jsonl");
    const r = spawnSync(process.execPath, [SCRIPT, "post", "codex"], {
      cwd: fx.projectRoot, env: fx.env, encoding: "utf8",
      input: JSON.stringify({ session_id: "cx-2", tool_name: "Bash", tool_input: { command: "false" }, tool_response: "Exit code: 1\nWall time: 0 seconds\nOutput:\n" }),
    });
    expect(r.status).toBe(0);
    const ev = eventsIn(projectLog).find(e => e.event === "bash_completed") as Record<string, unknown> | undefined;
    expect(ev!.success).toBe(false);
  }, spawnBudgetMs(1));

  test("a project found by its .nirvana/ marker is in scope with no prefix hint at all", () => {
    const fx = fixture();
    fs.mkdirSync(path.join(fx.projectRoot, ".nirvana"), { recursive: true });
    const env = { ...fx.env }; delete env.NIRVANA_AUDIT_PREFIXES;
    const today = new Date().toISOString().slice(0, 10);
    const projectLog = path.join(fx.projectRoot, ".nirvana", "logs", "harness", today, "audit.jsonl");
    const r = spawnSync(process.execPath, [SCRIPT, "post", "claude-code"], {
      cwd: fx.projectRoot, env, encoding: "utf8",
      input: JSON.stringify({ session_id: "cc-3", tool_name: "Bash", tool_input: { command: "echo hi" }, tool_response: { success: true } }),
    });
    expect(r.status).toBe(0);
    expect(eventsIn(projectLog).some(e => e.event === "bash_completed")).toBe(true);
  }, spawnBudgetMs(1));
});
