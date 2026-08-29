// dispatch-completion-signal.e2e.test.ts — the real proof, not only the
// hermetic one in run-completion-signal.test.ts.
//
// The owner's complaint: finished jobs never tell the runtime that dispatched
// them that they are done. A dispatch launched detached — `( nohup nrv
// dispatch … & )`, exactly how the orchestrator does it — used to leave its
// caller with nothing to wait on but the process table, a file-mtime count,
// or a blind timer.
//
// This spawns the REAL scripts/dispatch.ts (a fake `claude` CLI on PATH, no
// LLM, no network — same technique as dispatch-standard-kernel.e2e.test.ts)
// as an actual detached OS process: a shell backgrounds it with `nohup … &`
// inside a subshell and returns before the dispatch itself can possibly be
// done. A SEPARATE process — a fresh `nrv run-track wait <project-id>`, which
// shares no state with either the launcher or the dispatch beyond the ledger
// file on disk — then learns the outcome. Proved for both a delivered run and
// a failed one.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { IS_WINDOWS, writeFakeCli } from "./helpers/fake-cli.ts";
import { makeTempRoot } from "./helpers/temp-dirs.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const SKILLS = path.join(REPO, "skills");
const DISPATCH = path.join(SKILLS, "harness", "scripts", "dispatch.ts");
const RUN_TRACK = path.join(SKILLS, "harness", "scripts", "run-track.ts");

const PASSING_HTML = [
  "<!doctype html><html><head><title>Delivery</title></head><body><main>",
  "<h1>Final delivery</h1><p>This local fixture contains enough structured content for deterministic validation.</p>",
  "<p>The manifest, quality gate and publication stages all run without network access or an external runtime.</p>",
  "</main></body></html>",
].join("");

// The fake runtime: reads the prompt from STDIN like the real driver delivers
// it, then either writes a passing deliverable or fails outright, per
// FAKE_CLAUDE_MODE — the same shape dispatch-standard-kernel.e2e.test.ts uses.
const FAKE_CLAUDE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
await Bun.stdin.text();
const mode = process.env.FAKE_CLAUDE_MODE ?? "deliver";
if (mode === "fail") { console.error("fake runtime: provider failure"); process.exit(1); }
const outputsRoot = process.env.FAKE_CLAUDE_OUTPUTS_ROOT;
fs.mkdirSync(outputsRoot, { recursive: true });
fs.writeFileSync(path.join(outputsRoot, "report.html"), ${JSON.stringify(PASSING_HTML)}, "utf8");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "delivered", session_id: "sess-fake", total_cost_usd: 0.01 }));
`;

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function quote(s: string): string {
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

function fixture(caseName: string) {
  const root = makeTempRoot(`nrv-detached-dispatch-${caseName}-`); roots.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const bin = path.join(root, "bin");
  const capture = path.join(root, "capture");
  fs.mkdirSync(path.join(projectRoot, ".nirvana"), { recursive: true });
  fs.mkdirSync(capture, { recursive: true });
  writeFakeCli(bin, "claude", FAKE_CLAUDE);
  const briefFile = path.join(root, "brief.md");
  fs.writeFileSync(briefFile, "Produza o relatório final em report.html", "utf8");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NIRVANA_|HARNESS_|FAKE_|NRV_|LLM_CASCADE|SQUADS_DIR|BUSINESSES_DIR)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home, NIRVANA_HOME: home, NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_PROJECT_ROOT: projectRoot,
    NIRVANA_HOST_RUNTIME: "claude-code", NIRVANA_RUN_LEDGER_DB: path.join(root, "ledger.sqlite"),
    NIRVANA_STATE_DB: path.join(root, "state.db"), HARNESS_LOGS_DIR: path.join(root, "logs"),
    NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1", NRV_PREFLIGHT: "0", NIRVANA_NO_DESKTOP_NOTIFY: "1",
    FAKE_CAPTURE_DIR: capture, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  const outputs = path.join(root, "outputs");
  const dispatchLog = path.join(root, "dispatch.log");
  return { root, projectRoot, briefFile, env, outputs, dispatchLog };
}

/** Launch dispatch.ts detached, exactly the way the orchestrator does it, and
 *  return as soon as the SHELL has backgrounded it — never waiting for
 *  dispatch itself. `nohup` inside a `( … & )` subshell orphans the grandchild
 *  the instant this call returns, matching `( nohup nrv dispatch … & )`. */
function launchDetached(fx: ReturnType<typeof fixture>, projectId: string, mode: "deliver" | "fail"): number {
  const args = [
    process.execPath, DISPATCH, "--agent-x", "--brief-file", fx.briefFile, "--exec",
    "--project", projectId, "--outputs-root", fx.outputs, "--max-revisions", "0",
  ].map(quote).join(" ");
  const cmd = `( nohup ${args} > ${quote(fx.dispatchLog)} 2>&1 & )`;
  const started = Date.now();
  const launch = spawnSync("/bin/sh", ["-c", cmd], {
    cwd: fx.projectRoot,
    env: { ...fx.env, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_OUTPUTS_ROOT: fx.outputs },
    encoding: "utf8",
  });
  expect(launch.status, launch.stdout + launch.stderr).toBe(0);
  return Date.now() - started;
}

describe.skipIf(IS_WINDOWS)("a detached dispatch signals its own completion", () => {
  test("delivered: the launching shell returns immediately; a separate `run-track wait` learns the outcome, never pgrep, never a file count, never a timer", () => {
    const fx = fixture("ok");
    const projectId = "detached-ok";

    const launcherMs = launchDetached(fx, projectId, "deliver");
    // Backgrounding is near-instant regardless of how long dispatch itself
    // takes — this is the "parent shell exits" half of the claim.
    expect(launcherMs).toBeLessThan(3_000);

    const waited = spawnSync(process.execPath, [RUN_TRACK, "wait", projectId, "--timeout", "60"], {
      cwd: fx.projectRoot, env: fx.env, encoding: "utf8",
    });
    expect(waited.status, waited.stdout + waited.stderr + "\n--- dispatch.log ---\n" + safeRead(fx.dispatchLog)).toBe(0);
    expect(waited.stdout).toContain("delivered");
    expect(fs.existsSync(path.join(fx.outputs, "report.html"))).toBe(true);

    // The answer survives being asked again, from yet another fresh process —
    // the reconnect case, not only the live wait.
    const askedAgain = spawnSync(process.execPath, [RUN_TRACK, "status", projectId], { cwd: fx.projectRoot, env: fx.env, encoding: "utf8" });
    expect(askedAgain.status).toBe(0);
    expect(askedAgain.stdout).toContain("delivered");
  }, 60_000);

  test("failed: the same detached shape, and the waiter is woken with the failure — a signal that only fires on success is not this fix", () => {
    const fx = fixture("fail");
    const projectId = "detached-fail";

    launchDetached(fx, projectId, "fail");

    const waited = spawnSync(process.execPath, [RUN_TRACK, "wait", projectId, "--timeout", "60"], {
      cwd: fx.projectRoot, env: fx.env, encoding: "utf8",
    });
    expect(waited.status, waited.stdout + waited.stderr + "\n--- dispatch.log ---\n" + safeRead(fx.dispatchLog)).toBe(1);
    expect(waited.stdout).toContain("failed");
  }, 60_000);
});

function safeRead(p: string): string {
  try { return fs.readFileSync(p, "utf8"); } catch { return "(no log)"; }
}
