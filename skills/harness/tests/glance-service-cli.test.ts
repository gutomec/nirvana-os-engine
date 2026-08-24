import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";import { tmpdir } from "node:os";
import { parseGlanceArgs, renderGlanceHelp, resolveServiceRequest, runGlance } from "../scripts/glance.ts";
import { parseServiceCommand, SERVICE_EXIT_TABLE, serviceExitCode } from "../lib/glance/service/command-registry.ts";
import { digestCanonicalPath } from "../lib/glance/service/paths.ts";
import { writeDurableJson } from "../lib/glance/service/state.ts";

const HELP_EXIT_CASES = [
  { id: "SVC-CLI-RUN-TOP-HELP", argv: ["--help"], exit: 0 },
  { id: "SVC-CLI-RUN-SERVICE-HELP", argv: ["service", "--help"], exit: 0 },
  { id: "SVC-CLI-RUN-VERB-HELP", argv: ["service", "start", "--help"], exit: 0 },
  { id: "SVC-CLI-RUN-MISSING-USAGE", argv: ["service"], exit: 2 },
  { id: "SVC-CLI-RUN-UNKNOWN-USAGE", argv: ["service", "unknown"], exit: 2 },
] as const;

test.each(HELP_EXIT_CASES)("$id through runGlance", async ({ argv, exit }) => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.join(" ")); };
  try {
    expect(await runGlance(argv, { serviceManager: { run: async () => { throw new Error("service manager must not run for help or usage"); } } })).toBe(exit);
    expect(lines.join("\n")).toContain("service");
  } finally { console.log = original; }
});

test("SVC-CLI-MISSING-COMMAND", () => {
  const parsed = parseGlanceArgs(["service"]);
  expect(parsed).toMatchObject({ kind: "help", level: "service", exitCode: 2 });
});

test("SVC-CLI-UNKNOWN-COMMAND", () => {
  const parsed = parseGlanceArgs(["service", "autostart"]);
  expect(parsed).toMatchObject({ kind: "help", level: "service", exitCode: 2 });
});

test("SVC-CLI-PARSE-START", () => {
  expect(parseServiceCommand(["start"], { port: "4000", json: true })).toMatchObject({ kind: "service", command: "start", options: { port: 4000, json: true } });
  expect(parseServiceCommand(["start"], { scope: "global" })).toMatchObject({ kind: "service", command: "start", options: { scope: "global" } });
});

test("SVC-CLI-PARSE-STOP", () => {
  expect(parseServiceCommand(["stop"], { json: true })).toMatchObject({ kind: "service", command: "stop", options: { json: true } });
  expect(parseServiceCommand(["stop"], {})).toMatchObject({ kind: "service", command: "stop", options: {} });
});

test("SVC-CLI-PARSE-STATUS", () => {
  expect(parseServiceCommand(["status"], { json: true })).toMatchObject({ kind: "service", command: "status", options: { json: true } });
});

test("SVC-CLI-PARSE-RESTART", () => {
  expect(parseServiceCommand(["restart"], { port: "5000" })).toMatchObject({ kind: "service", command: "restart", options: { port: 5000 } });
});

test("SVC-CLI-PROJECT-ROOT-WITHOUT-PORT-IS-LEGAL", () => {
  expect(parseServiceCommand(["start"], { scope: "project", "project-root": "C:/tmp/proj" })).toMatchObject({ kind: "service", command: "start" });
  expect(parseServiceCommand(["restart"], { scope: "project", "project-root": "C:/tmp/proj" })).toMatchObject({ kind: "service", command: "restart" });
});

test("SVC-CLI-SCOPE-PROJECT-PARSE-DOES-NOT-REQUIRE-ROOT", () => {
  expect(parseServiceCommand(["start"], { scope: "project" })).toMatchObject({ kind: "service", command: "start" });
});

for (const forbidden of ["host", "allow-actions", "idle-min", "no-open", "autostart"]) {
  test(`SVC-CLI-REJECT-${forbidden.toUpperCase()}-ON-START`, () => {
    const value: Record<string, unknown> = forbidden === "no-open" || forbidden === "allow-actions" ? true : "x";
    expect(() => parseServiceCommand(["start"], { [forbidden]: value })).toThrow(/SERVICE_USAGE/);
    expect(() => parseServiceCommand(["restart"], { [forbidden]: "x" })).toThrow(/SERVICE_USAGE/);
  });
}

test("SVC-CLI-PROHIBITED-PORT-ON-STOP", async () => {
  let ran = 0;
  const code = await runGlance(["service", "stop", "--port", "4000"], { serviceManager: { run: async () => { ran += 1; return 0; } } });
  expect(code).toBe(2);
  expect(ran).toBe(0);
});

test("SVC-CLI-PROHIBITED-PORT-ON-STATUS", () => {
  expect(() => parseServiceCommand(["status"], { port: "4000" })).toThrow(/SERVICE_USAGE/);
  expect(() => parseServiceCommand(["stop"], { scope: "project" })).toThrow(/SERVICE_USAGE/);
});

test("SVC-CLI-VERB-HELP-LISTS-ONLY-LEGAL-OPTIONS", () => {
  for (const verb of ["start", "restart"] as const) {
    const help = renderGlanceHelp("verb", verb);
    expect(help).toContain("--port");
    expect(help).toContain("--scope");
    expect(help).toContain("--project-root");
    expect(help).toContain("--json");
    expect(help).not.toContain("--host");
    expect(help).not.toContain("--allow-actions");
    expect(help).not.toContain("--idle-min");
    expect(help).not.toContain("--no-open");
    expect(help).not.toContain("--autostart");
  }
  for (const verb of ["stop", "status"] as const) {
    const help = renderGlanceHelp("verb", verb);
    expect(help).toContain("--json");
    expect(help).not.toContain("--port");
    expect(help).not.toContain("--scope");
    expect(help).not.toContain("--project-root");
    expect(help).not.toContain("--host");
    expect(help).not.toContain("--allow-actions");
    expect(help).not.toContain("--idle-min");
    expect(help).not.toContain("--no-open");
    expect(help).not.toContain("--autostart");
  }
});

test("SVC-CLI-HELP-SERVICE-DOES-NOT-RENDER-TOP", () => {
  const family = renderGlanceHelp("service");
  const top = renderGlanceHelp("top");
  expect(family).not.toBe(top);
  expect(top).toContain("nrv glance [options]");
  expect(top).toContain("nrv glance service <start|stop|status|restart>");
  expect(family).toContain("restart");
  expect(family).toContain("EXITS");
});

for (const verb of ["start", "stop", "status", "restart"] as const) {
  test(`SVC-CLI-HELP-${verb.toUpperCase()}`, () => {
    const help = renderGlanceHelp("verb", verb);
    expect(help.startsWith(`glance service ${verb}`)).toBe(true);
  });
}

test("SVC-CLI-EXIT-TABLE-FROZEN-COMPLETE", () => {
  expect(Object.isFrozen(SERVICE_EXIT_TABLE)).toBe(true);
  const values = [...new Set(Object.values(SERVICE_EXIT_TABLE))].sort((a, b) => a - b);
  expect(values).toEqual([0, 1, 2, 3, 4, 5, 6]);
});

function stubResult(state: string, code: string, ok = false) {
  return { schema_version: "1.0.0", command: "status", ok, state, read_only: true, persistent: true, log_path: "logs/service.log", code, message: code } as const;
}

const EXIT_MATRIX = [
  { id: "SVC-CLI-EXIT-0", result: stubResult("running", "RUNNING", true), exit: 0 },
  { id: "SVC-CLI-EXIT-0-STOPPED-OK", result: stubResult("stopped", "ALREADY_STOPPED", true), exit: 0 },
  { id: "SVC-CLI-EXIT-1", result: stubResult("stopped", "NOT_RUNNING"), exit: 1 },
  { id: "SVC-CLI-UNSUPPORTED-EXIT-2", result: stubResult("error", "SERVICE_UNSUPPORTED:win32"), exit: 2 },
  { id: "SVC-CLI-EXIT-3", result: stubResult("stale", "STATE_PARTIAL"), exit: 3 },
  { id: "SVC-CLI-EXIT-3-STALE", result: stubResult("stale", "STATE_CHANGED"), exit: 3 },
  { id: "SVC-CLI-EXIT-4", result: stubResult("conflict", "CONFIG_CONFLICT"), exit: 4 },
  { id: "SVC-CLI-EXIT-5", result: stubResult("stale", "STOP_TIMEOUT"), exit: 5 },
  { id: "SVC-CLI-EXIT-5-ERROR-TIMEOUT", result: stubResult("error", "LOCK_TIMEOUT"), exit: 5 },
  { id: "SVC-CLI-EXIT-6", result: stubResult("error", "SERVICE_IO:STATE_READ"), exit: 6 },
] as const;

test.each(EXIT_MATRIX)("$id", ({ result, exit }) => {
  expect(serviceExitCode(result)).toBe(exit);
});

test("SVC-CLI-RUNGLANCE-PASSES-PARSED-OPTIONS-AND-RETURNS-CODE", async () => {
  const seen: Array<{ command: string; options: unknown }> = [];
  const code = await runGlance(["service", "status", "--json"], { serviceManager: { run: async (command, options) => { seen.push({ command, options }); return 1; } } });
  expect(code).toBe(1);
  expect(seen).toEqual([{ command: "status", options: { json: true } }]);
});

test("SVC-CLI-HELP-FAMILY-ROUTING", () => {
  expect(parseGlanceArgs(["service", "--help"])).toMatchObject({ kind: "help", level: "service", exitCode: 0 });
});

test("SVC-CLI-HELP-VERB-ROUTING", () => {
  expect(parseGlanceArgs(["service", "stop", "--help"])).toMatchObject({ kind: "help", level: "verb", command: "stop", exitCode: 0 });
});

test("SVC-CLI-HELP-TOP", () => {
  expect(parseGlanceArgs(["--help"])).toMatchObject({ kind: "help", level: "top", exitCode: 0 });
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "glance-req-"));
  try { await run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

test("SVC-CLI-RESTART-NO-OVERRIDE-REUSES-CURRENT", async () => {
  await withTempHome(async home => {
    expect(await resolveServiceRequest(home, "restart", {})).toBeUndefined();
  });
});

test("SVC-CLI-RESTART-PORT-OVERRIDE-MERGES-CURRENT", async () => {
  await withTempHome(async home => {
    const project = mkdtempSync(join(tmpdir(), "glance-req-proj-"));
    const current = { schema_version: "1.0.0", scope: "project", host: "127.0.0.1", port: 4100, read_only: true, lifetime: "persistent", no_open: true, project_root: project, project_root_digest: digestCanonicalPath(project) };
    writeDurableJson(join(home, ".nirvana", "glance", "service", "config.json"), current);
    const request = await resolveServiceRequest(home, "restart", { port: 4200 });
    expect(request).toMatchObject({ scope: "project", port: 4200, project_root: project });
    expect(request?.scope === "project" ? request.project_root_digest : undefined).toBe(digestCanonicalPath(project));
    rmSync(project, { recursive: true, force: true });
  });
});

test("SVC-CLI-RESTART-GLOBAL-OVERRIDE-KEEPS-GLOBAL", async () => {
  await withTempHome(async home => {
    const current = { schema_version: "1.0.0", scope: "global", host: "127.0.0.1", port: 4300, read_only: true, lifetime: "persistent", no_open: true };
    writeDurableJson(join(home, ".nirvana", "glance", "service", "config.json"), current);
    const request = await resolveServiceRequest(home, "restart", { port: 4400 });
    expect(request).toMatchObject({ scope: "global", port: 4400 });
  });
});

test("SVC-CLI-START-DEFAULTS-GLOBAL-3737", async () => {
  await withTempHome(async home => {
    const request = await resolveServiceRequest(home, "start", {});
    expect(request).toMatchObject({ scope: "global", port: 3737 });
  });
});

test("SVC-CLI-START-PROJECT-ROOT-DEFAULTS-PORT-3737", async () => {
  await withTempHome(async home => {
    const project = mkdtempSync(join(tmpdir(), "glance-req-proj2-"));
    const request = await resolveServiceRequest(home, "start", { scope: "project", projectRoot: project });
    expect(request).toMatchObject({ scope: "project", port: 3737, project_root: project });
    rmSync(project, { recursive: true, force: true });
  });
});

test("SVC-CLI-START-PROJECT-RESOLVES-CURRENT-PROJECT", async () => {
  await withTempHome(async home => {
    const projectDir = mkdtempSync(join(tmpdir(), "glance-cwd-proj-"));
    writeFileSync(join(projectDir, ".git"), new Uint8Array());
    const cwd = process.cwd();
    process.chdir(projectDir);
    try {
      const request = await resolveServiceRequest(home, "start", { scope: "project" });
      expect(request).toMatchObject({ scope: "project", port: 3737, project_root: projectDir });
    } finally {
      process.chdir(cwd);
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

const REAL_CLI_CASES = [
  { id: "SVC-CLI-PROCESS-EXPLICIT-HELP-ZERO", argv: ["service", "--help"], exit: 0 },
  { id: "SVC-CLI-PROCESS-MISSING-TWO", argv: ["service"], exit: 2 },
  { id: "SVC-CLI-PROCESS-UNKNOWN-TWO", argv: ["service", "unknown"], exit: 2 },
] as const;

test.each(REAL_CLI_CASES)("$id through the real process", async ({ argv, exit }) => {
  const script = join(import.meta.dir, "..", "scripts", "glance.ts");
  const child = Bun.spawn([process.execPath, script, ...argv], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const [stdout, stderr, observed] = await Promise.all([new Response(child.stdout!).text(), new Response(child.stderr!).text(), child.exited]);
  expect(observed).toBe(exit);
  expect(`${stdout}\n${stderr}`).toContain("service");
}, 20_000);

test("SVC-CLI-TOP-HELP-THROUGH-REAL-PROCESS", async () => {
  const script = join(import.meta.dir, "..", "scripts", "glance.ts");
  const child = Bun.spawn([process.execPath, script, "--help"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const [stdout, observed] = await Promise.all([new Response(child.stdout!).text(), child.exited]);
  expect(observed).toBe(0);
  expect(stdout).toContain("service");
}, 20_000);

for (const verb of ["start", "stop", "status", "restart"] as const) {
  test(`SVC-CLI-PROCESS-VERB-HELP-${verb.toUpperCase()}`, async () => {
    const script = join(import.meta.dir, "..", "scripts", "glance.ts");
    const child = Bun.spawn([process.execPath, script, "service", verb, "--help"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    const [stdout, observed] = await Promise.all([new Response(child.stdout!).text(), child.exited]);
    expect(observed).toBe(0);
    expect(stdout).toContain(`glance service ${verb}`);
  }, 20_000);
}

test("SVC-CLI-STOP-PORT", async () => {
  const script = join(import.meta.dir, "..", "scripts", "glance.ts");
  const child = Bun.spawn([process.execPath, script, "service", "stop", "--port", "4000"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const observed = await child.exited;
  expect(observed).toBe(2);
}, 20_000);

test("SVC-CLI-REAL-LIFECYCLE", async () => {
  const script = join(import.meta.dir, "..", "scripts", "glance.ts");
  const home = mkdtempSync(join(tmpdir(), "glance-cli-home-"));
  const env = { ...process.env, NIRVANA_HOME: home };
  const allocate = (): number => { const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") }); const p = probe.port; probe.stop(true); return p; };
  const run = async (...argv: string[]): Promise<{ code: number; out: string }> => {
    const child = Bun.spawn([process.execPath, script, ...argv], { stdout: "pipe", stderr: "pipe", env });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout!).text(), new Response(child.stderr!).text()]);
    return { code: await child.exited, out: `${stdout}\n${stderr}` };
  };
  try {
    const port = allocate();
    const started = await run("service", "start", "--port", String(port), "--json");
    expect(started.code).toBe(0);
    expect(started.out).toContain('"state":"running"');
    const secretScan = `${started.out}`;
    expect(secretScan).not.toMatch(/control_secret|auth_tag|nonce_digest/);
    const statusRunning = await run("service", "status", "--json");
    expect(statusRunning.code).toBe(0);
    expect(statusRunning.out).toContain('"running"');
    const conflict = await run("service", "start", "--port", String(allocate()), "--json");
    expect(conflict.code).toBe(4);
    expect(readFileSync(join(home, ".nirvana", "glance", "service", "config.json")).byteLength).toBeGreaterThan(0);
    const stopped = await run("service", "stop", "--json");
    expect(stopped.code).toBe(0);
    const statusStopped = await run("service", "status", "--json");
    expect(statusStopped.code).toBe(1);
    const stoppedAgain = await run("service", "stop", "--json");
    expect(stoppedAgain.code).toBe(0);
    const prohibited = await run("service", "stop", "--port", String(port));
    expect(prohibited.code).toBe(2);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 240_000);

export const CLI_CASES = ["SVC-CLI-EXIT-0", "SVC-CLI-EXIT-1", "SVC-CLI-EXIT-2", "SVC-CLI-EXIT-3", "SVC-CLI-EXIT-3-STALE", "SVC-CLI-UNSUPPORTED-EXIT-2", "SVC-CLI-EXIT-4", "SVC-CLI-EXIT-5", "SVC-CLI-EXIT-6", "SVC-CLI-HELP-FAMILY-ROUTING", "SVC-CLI-HELP-VERB-ROUTING", "SVC-CLI-HELP-RESTART", "SVC-CLI-HELP-SERVICE", "SVC-CLI-HELP-START", "SVC-CLI-HELP-STATUS", "SVC-CLI-HELP-STOP", "SVC-CLI-HELP-TOP", "SVC-CLI-MISSING-COMMAND", "SVC-CLI-PARSE-RESTART", "SVC-CLI-PARSE-START", "SVC-CLI-PARSE-STATUS", "SVC-CLI-PARSE-STOP", "SVC-CLI-PROHIBITED-PORT-ON-STOP", "SVC-CLI-REAL-LIFECYCLE", "SVC-CLI-STOP-PORT", "SVC-CLI-UNKNOWN-COMMAND"] as const;
