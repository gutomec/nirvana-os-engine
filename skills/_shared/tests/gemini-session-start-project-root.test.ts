// gemini-session-start-project-root.test.ts — the Gemini-CLI SessionStart
// hook's log-directory resolver, isolated from every other writer.
//
// Same defect as audit-emit-from-hook.ts, found by searching every path that
// opens an audit log for the cloudevents-envelope cut: gemini-session-start.ts
// computed its own log root by hand (HARNESS_LOGS_DIR or straight to
// ~/.harness-logs) instead of calling log-paths.ts::harnessLogsDir() — even
// though it already carries the session's `cwd` in the hook payload for
// finding the chat transcript. A Gemini-CLI dispatch inside a real project
// wrote `session_started` / `brief_received` past the project every time.
//
// Hermetic: no HARNESS_LOGS_DIR or NIRVANA_PROJECT_ROOT set — the fallback
// must find the project by walking up from the payload's cwd.
// Runs with: bun test skills/_shared/tests
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempRoot } from "../../harness/tests/helpers/temp-dirs.ts";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

const SCRIPT = path.resolve(import.meta.dir, "..", "scripts", "gemini-session-start.ts");

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = makeTempRoot("nrv-gemini-projroot-"); roots.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NIRVANA_|HARNESS_|GEMINI_)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, { HOME: home, USERPROFILE: home });

  const run = (payload: Record<string, unknown>) =>
    spawnSync(process.execPath, [SCRIPT], { cwd: projectRoot, env, encoding: "utf8", input: JSON.stringify(payload) });

  return { root, home, projectRoot, env, run };
}

function eventsIn(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
}

describe("gemini-session-start.ts — where the SessionStart hook's events land", () => {
  test("a session inside a project writes to the project's log, not ~/.harness-logs", () => {
    const fx = fixture();
    const today = new Date().toISOString().slice(0, 10);
    const projectLog = path.join(fx.projectRoot, ".nirvana", "logs", "harness", today, "audit.jsonl");
    const homeLog = path.join(fx.home, ".harness-logs", today, "audit.jsonl");

    const result = fx.run({ session_id: "sess-fixture", cwd: fx.projectRoot });
    expect(result.status, result.stdout + result.stderr).toBe(0);

    expect(fs.existsSync(homeLog), "session_started must not fall through to the home root").toBe(false);
    const events = eventsIn(projectLog);
    expect(events.some(e => e.event === "session_started")).toBe(true);
  }, spawnBudgetMs(1));

  test("a session with no project in reach still logs somewhere sane (~/.harness-logs)", () => {
    const fx = fixture();
    const today = new Date().toISOString().slice(0, 10);
    const standalone = path.join(fx.root, "standalone");
    fs.mkdirSync(standalone, { recursive: true });
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: standalone, env: fx.env, encoding: "utf8",
      input: JSON.stringify({ session_id: "sess-standalone", cwd: standalone }),
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);

    const homeLog = path.join(fx.home, ".harness-logs", today, "audit.jsonl");
    const events = eventsIn(homeLog);
    expect(events.some(e => e.event === "session_started")).toBe(true);
  }, spawnBudgetMs(1));
});
