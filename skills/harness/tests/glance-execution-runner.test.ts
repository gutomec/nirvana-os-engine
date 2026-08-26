// glance-execution-runner.test.ts — the child-process runner behind the Glance chat
// and the dispatch flags it relies on: `--run-id` (adopt a prepared Run) and the
// explicit target parsed from a Message. Runs with: bun test skills/harness/tests
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDispatchExecutionRunner, detectExecutionRuntime, glanceRunDir, parseMessageTarget } from "../lib/control-plane/index.ts";
import { canonicalRuntimeName, resolveDefaultRuntime } from "../lib/runtime-rules.ts";
import { canonicalRunIdFor } from "../scripts/dispatch.ts";
import { writeFakeDispatch } from "./helpers/fake-dispatch.ts";
import { shimRuntimeOnPath } from "./helpers/fake-glance-child.ts";
import { removeDir } from "./helpers/temp-dirs.ts";

const DISPATCH = path.join(import.meta.dir, "..", "scripts", "dispatch.ts");
const roots: string[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
  delete process.env.NIRVANA_DISPATCH_SCRIPT;
  while (roots.length) removeDir(roots.pop()!);
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-glance-runner-")); roots.push(root);
  const briefFile = path.join(root, "brief.md");
  fs.writeFileSync(briefFile, "Produza o relatório", "utf8");
  return { root, briefFile, fake: writeFakeDispatch(path.join(root, "helpers")) };
}

const capture = (root: string, runId: string) =>
  JSON.parse(fs.readFileSync(path.join(glanceRunDir(root, runId), "outputs", "dispatch-capture.json"), "utf8")) as { argv: string[]; cwd: string; env: Record<string, string>; brief: string };

describe("parseMessageTarget", () => {
  test("`use business <slug>:` and `use squad <slug>:` prepare typed targets, case-insensitive on the keyword", () => {
    expect(parseMessageTarget("use squad brandcraft: produza o manifesto")).toEqual({ kind: "squad", slug: "brandcraft", capabilityId: "squad.execute" });
    expect(parseMessageTarget("  Use Business web-studio:\nlanding page")).toEqual({ kind: "business", slug: "web-studio" });
    expect(parseMessageTarget("USE SQUAD Doc-Factory: relatório")).toEqual({ kind: "squad", slug: "doc-factory", capabilityId: "squad.execute" });
  });

  test("anything else names no target: agent-x here, and the queue asks the router before preparing the Run (glance-message-route.test.ts)", () => {
    for (const content of ["Produza o artifact", "use squad brandcraft produza", "use the squad brandcraft: x", "use squad brand_craft: x", "squad brandcraft: x"]) {
      expect(parseMessageTarget(content)).toEqual({ kind: "agent-x", slug: "agent-x" });
    }
  });
});

describe("createDispatchExecutionRunner", () => {
  test("spawns dispatch with an explicit target, --run-id, the Glance outputs root and the light Gauntlet for agent-x", async () => {
    const { root, briefFile, fake } = fixture();
    const runner = createDispatchExecutionRunner({ dispatchScriptPath: fake });
    const child = runner.start({ projectRoot: root, projectId: "prj_one", runId: "run_one", briefFile, target: { kind: "agent-x", slug: "agent-x" }, intensity: "light" });
    expect(child.pid).toBeGreaterThan(0);
    expect(child.argv.slice(0, 2)).toEqual(["bun", fake]);
    expect(await child.done).toEqual({ exitCode: 0 });
    const seen = capture(root, "run_one");
    expect(seen.argv).toEqual(["--agent-x", "--brief-file", briefFile, "--exec", "--project", "prj_one", "--run-id", "run_one",
      "--outputs-root", path.join(glanceRunDir(root, "run_one"), "outputs"), "--execution-mode=gauntlet", "--gauntlet-intensity=light"]);
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(root));
    expect(seen.env.NIRVANA_PROJECT_ROOT).toBe(root);
    expect(seen.brief).toBe("Produza o relatório");
    expect(fs.existsSync(path.join(glanceRunDir(root, "run_one"), "child.log"))).toBe(true);
  });

  test("business and squad targets pass --business / --squad and inherit the mode from the env; --runtime is forwarded", async () => {
    const { root, briefFile, fake } = fixture();
    const runner = createDispatchExecutionRunner({ dispatchScriptPath: fake, runtime: "codex", env: { NIRVANA_EXECUTION_MODE: "gauntlet" } });
    const business = runner.start({ projectRoot: root, projectId: "prj_two", runId: "run_business", briefFile, target: { kind: "business", slug: "web-studio" }, intensity: "light" });
    const squad = runner.start({ projectRoot: root, projectId: "prj_two", runId: "run_squad", briefFile, target: { kind: "squad", slug: "brandcraft", capabilityId: "squad.execute" }, intensity: "light" });
    await Promise.all([business.done, squad.done]);
    const seenBusiness = capture(root, "run_business");
    expect(seenBusiness.argv.slice(0, 2)).toEqual(["--business", "web-studio"]);
    expect(seenBusiness.argv).toContain("--runtime");
    expect(seenBusiness.argv[seenBusiness.argv.indexOf("--runtime") + 1]).toBe("codex");
    expect(seenBusiness.argv.some(part => part.startsWith("--execution-mode"))).toBe(false);
    expect(seenBusiness.env.NIRVANA_EXECUTION_MODE).toBe("gauntlet");
    expect(capture(root, "run_squad").argv.slice(0, 2)).toEqual(["--squad", "brandcraft"]);
  });

  test("the child audits where the cockpit reads: HARNESS_LOGS_DIR is pinned to the project's harness log unless the caller set it", async () => {
    const { root, briefFile, fake } = fixture();
    const previous = process.env.HARNESS_LOGS_DIR;
    delete process.env.HARNESS_LOGS_DIR;
    restores.push(() => { if (previous !== undefined) process.env.HARNESS_LOGS_DIR = previous; });
    // The fake writes its cost event where dispatch.ts does: under HARNESS_LOGS_DIR when set, else under the
    // scaffold it creates (outputs/<pid>/.nirvana/logs/harness), which nothing on the server side reads.
    const pinned = createDispatchExecutionRunner({ dispatchScriptPath: fake, env: { FAKE_DISPATCH_COST_USD: "0.3" } });
    await pinned.start({ projectRoot: root, projectId: "prj_logs", runId: "run_pinned", briefFile, target: { kind: "agent-x", slug: "agent-x" }, intensity: "light" }).done;
    const projectLogs = path.join(root, ".nirvana", "logs", "harness");
    expect(capture(root, "run_pinned").env.HARNESS_LOGS_DIR).toBe(projectLogs);
    expect(fs.readdirSync(projectLogs)).toHaveLength(1);
    expect(fs.existsSync(path.join(root, "outputs"))).toBe(false);
    const explicit = createDispatchExecutionRunner({ dispatchScriptPath: fake, env: { HARNESS_LOGS_DIR: path.join(root, "elsewhere") } });
    await explicit.start({ projectRoot: root, projectId: "prj_logs", runId: "run_explicit", briefFile, target: { kind: "agent-x", slug: "agent-x" }, intensity: "light" }).done;
    expect(capture(root, "run_explicit").env.HARNESS_LOGS_DIR).toBe(path.join(root, "elsewhere"));
  });

  test("child.log captures stdout and stderr; done reports the exit code; kill ends a running child", async () => {
    const { root, briefFile, fake } = fixture();
    const failing = createDispatchExecutionRunner({ dispatchScriptPath: fake, env: { FAKE_DISPATCH_EXIT_CODE: "2" } });
    const failed = failing.start({ projectRoot: root, projectId: "prj_three", runId: "run_exit", briefFile, target: { kind: "agent-x", slug: "agent-x" }, intensity: "light" });
    expect(await failed.done).toEqual({ exitCode: 2 });
    expect(fs.readFileSync(path.join(glanceRunDir(root, "run_exit"), "child.log"), "utf8")).toContain("fake dispatch stopped with exit 2");
    const sleeping = createDispatchExecutionRunner({ dispatchScriptPath: fake, env: { FAKE_DISPATCH_SLEEP_MS: "10000" } });
    const held = sleeping.start({ projectRoot: root, projectId: "prj_three", runId: "run_kill", briefFile, target: { kind: "agent-x", slug: "agent-x" }, intensity: "light" });
    await Bun.sleep(150);
    // The child leads its own process group, so kill() reaches the runtime it spawns as well.
    if (process.platform !== "win32") expect(() => process.kill(-held.pid, 0)).not.toThrow();
    held.kill();
    const { exitCode } = await held.done;
    // A signal leaves no exit code. Windows has no signals: taskkill /F ends the tree with a
    // non-zero status, and either way the child never reached its own exit 0.
    if (process.platform === "win32") expect(exitCode).not.toBe(0); else expect(exitCode).toBeNull();
  });

  test("NIRVANA_DISPATCH_SCRIPT overrides the default script; an explicit option wins over both", () => {
    const { root, briefFile, fake } = fixture();
    process.env.NIRVANA_DISPATCH_SCRIPT = fake;
    const fromEnv = createDispatchExecutionRunner().start({ projectRoot: root, projectId: "prj_four", runId: "run_env", briefFile, target: { kind: "agent-x", slug: "agent-x" }, intensity: "light" });
    expect(fromEnv.argv[1]).toBe(fake);
    fromEnv.kill();
    const other = writeFakeDispatch(path.join(root, "other"));
    const explicit = createDispatchExecutionRunner({ dispatchScriptPath: other }).start({ projectRoot: root, projectId: "prj_four", runId: "run_opt", briefFile, target: { kind: "agent-x", slug: "agent-x" }, intensity: "light" });
    expect(explicit.argv[1]).toBe(other);
    explicit.kill();
  });

  test("available() follows dispatch.ts's default-runtime rule and probes PATH", () => {
    const { root, fake } = fixture();
    restores.push(shimRuntimeOnPath(root, "claude"));
    expect(createDispatchExecutionRunner({ dispatchScriptPath: fake, env: { NIRVANA_HOST_RUNTIME: "claude-code" } }).available()).toBe(true);
    expect(createDispatchExecutionRunner({ dispatchScriptPath: fake, runtime: "claude-code" }).available()).toBe(true);
    const previous = process.env.PATH;
    process.env.PATH = [path.join(root, "bin"), "/usr/bin", "/bin"].join(path.delimiter);
    restores.push(() => { process.env.PATH = previous; });
    expect(createDispatchExecutionRunner({ dispatchScriptPath: fake, runtime: "kimi-cli" }).available()).toBe(false);
  });
});

describe("default runtime detection shared with dispatch.ts", () => {
  test("resolveDefaultRuntime: host, then NIRVANA_DEFAULT_RUNTIME, then PATH scan, then claude-code", () => {
    const normalize = canonicalRuntimeName;
    expect(resolveDefaultRuntime({ detectedHost: "codex", envDefault: "gemini", normalize, firstAvailable: () => "pi" })).toEqual({ runtime: "codex", from: "host" });
    expect(resolveDefaultRuntime({ detectedHost: null, envDefault: "agy", normalize, firstAvailable: () => "pi" })).toEqual({ runtime: "antigravity-cli", from: "env" });
    expect(resolveDefaultRuntime({ detectedHost: null, envDefault: "", normalize, firstAvailable: () => "pi" })).toEqual({ runtime: "pi", from: "path-scan" });
    expect(resolveDefaultRuntime({ detectedHost: null, envDefault: "", normalize, firstAvailable: () => null })).toEqual({ runtime: "claude-code", from: "fallback" });
  });

  test("canonicalRuntimeName maps the user's aliases and passes unknown names through", () => {
    expect(canonicalRuntimeName("claude")).toBe("claude-code");
    expect(canonicalRuntimeName("Gemini-CLI")).toBe("gemini-cli");
    expect(canonicalRuntimeName("pi-dev")).toBe("pi");
    expect(canonicalRuntimeName("kimi")).toBe("kimi-cli");
    expect(canonicalRuntimeName("hermes")).toBe("hermes");
    expect(canonicalRuntimeName("something-else")).toBe("something-else");
  });

  test("detectExecutionRuntime reads the host marker and the env default from the env it is given", () => {
    expect(detectExecutionRuntime({ NIRVANA_HOST_RUNTIME: "codex" })).toMatchObject({ runtime: "codex", from: "host" });
    expect(detectExecutionRuntime({ NIRVANA_DEFAULT_RUNTIME: "gemini" })).toMatchObject({ runtime: "gemini-cli", from: "env" });
    expect(["path-scan", "fallback"]).toContain(detectExecutionRuntime({}).from);
  });
});

describe("--run-id in dispatch.ts", () => {
  test("canonicalRunIdFor keeps run_<project> without the flag and adopts the flag verbatim", () => {
    expect(canonicalRunIdFor("prj_ab.c")).toBe("run_prj-ab-c");
    expect(canonicalRunIdFor("prj_x", undefined)).toBe("run_prj-x");
    expect(canonicalRunIdFor("prj_x", "run_from_glance")).toBe("run_from_glance");
  });

  test("the flag is a value flag: its value never leaks into the brief, in both forms", () => {
    for (const args of [["--agent-x", "--run-id", "run_x"], ["--agent-x", "--run-id=run_x"]]) {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-run-id-")); roots.push(cwd);
      const r = spawnSync(process.execPath, [DISPATCH, ...args], { cwd, encoding: "utf8", env: { ...process.env, NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1" } });
      expect(r.status).toBe(4);
      expect(r.stderr).toContain("pass an inline brief or --brief-file");
    }
  });

  test("the usage text documents the flag", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-run-id-help-")); roots.push(cwd);
    const r = spawnSync(process.execPath, [DISPATCH], { cwd, encoding: "utf8", env: { ...process.env, NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1" } });
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("--run-id=<runId>");
  });
});
