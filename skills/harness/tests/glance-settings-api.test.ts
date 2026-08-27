// glance-settings-api.test.ts — the Glance settings API over the settings core:
// GET /api/v1/settings (schema, effective value, origin, lock), PUT and DELETE
// /api/v1/settings/<key> with the same authorization as every /api/v1 write, the
// refusals with their status codes, the round trip set → get → unset in the
// project and in the global file, the audit event of every write with
// `actor: "glance"`, idempotent replays, and the effect on the next child: a
// change through the API reaches the environment of the next fake dispatch the
// Glance queue spawns, without a restart. Hermetic: a temp NIRVANA_HOME, a temp
// project, a temp harness log and state db; every schema variable scrubbed from
// the inherited environment. No LLM, no network. Runs with: bun test skills/harness/tests
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SETTINGS_SCHEMA } from "../../_shared/lib/settings.ts";
import { createDispatchExecutionRunner } from "../lib/control-plane/execution-runner.ts";
import { ProjectService } from "../lib/control-plane/project-service.ts";
import { childState, shimRuntimeOnPath, writeFakeGlanceChild } from "./helpers/fake-glance-child.ts";
import { removeDir } from "./helpers/temp-dirs.ts";
import { KERNEL_BUDGET_MS } from "./helpers/test-budgets.ts";

const SCHEMA_VARIABLES = SETTINGS_SCHEMA.flatMap((spec) => [spec.env, ...(spec.envAliases ?? [])]).filter((name): name is string => !!name);
const SCRUBBED = [...SCHEMA_VARIABLES, "NIRVANA_PROJECT_ROOT", "NIRVANA_HOME", "HARNESS_LOGS_DIR", "NIRVANA_STATE_DB"];
const saved = new Map<string, string | undefined>();
beforeAll(() => { for (const name of SCRUBBED) { saved.set(name, process.env[name]); delete process.env[name]; } });
afterAll(() => { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });

const roots: string[] = [];
const servers: any[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  while (servers.length) { try { servers.pop().close(); } catch {} }
  while (restores.length) restores.pop()!();
  for (const name of ["NIRVANA_PROJECT_ROOT", "NIRVANA_HOME", "HARNESS_LOGS_DIR", "NIRVANA_STATE_DB", "NIRVANA_ROUTING_MODE"]) delete process.env[name];
  while (roots.length) removeDir(roots.pop()!);
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-glance-settings-")));
  roots.push(root);
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const logs = path.join(root, "logs");
  fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
  fs.mkdirSync(path.join(project, ".nirvana"), { recursive: true });
  process.env.NIRVANA_HOME = home;
  process.env.NIRVANA_PROJECT_ROOT = project;
  process.env.HARNESS_LOGS_DIR = logs;
  process.env.NIRVANA_STATE_DB = path.join(root, "state.db");
  return { root, home, project, logs, globalFile: path.join(home, ".nirvana", "config.yaml"), projectFile: path.join(project, ".nirvana", "config.yaml") };
}
type Fixture = ReturnType<typeof fixture>;

async function start(options: { allowActions?: boolean; runner?: any } = {}) {
  const { startServer } = await import("../lib/glance/server.ts");
  const server = await startServer({ port: 0, open: false, idleMin: 60, allowActions: options.allowActions ?? true, theme: "apple", executionRunner: options.runner });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

const headers = (base: string, key = crypto.randomUUID()) => ({ "content-type": "application/json", origin: base, "idempotency-key": key });
const get = async (base: string, query = "") => fetch(`${base}/api/v1/settings${query}`);
const put = async (base: string, key: string, body: unknown, init: Record<string, string> = headers(base)) =>
  fetch(`${base}/api/v1/settings/${key}`, { method: "PUT", headers: init, body: JSON.stringify(body) });
const del = async (base: string, key: string, scope: string, init: Record<string, string> = headers(base)) =>
  fetch(`${base}/api/v1/settings/${key}?scope=${scope}`, { method: "DELETE", headers: init });

function auditEvents(setup: Fixture): Array<Record<string, unknown>> {
  let days: string[] = [];
  try { days = fs.readdirSync(setup.logs); } catch { return []; }
  return days.flatMap((day) => {
    try { return fs.readFileSync(path.join(setup.logs, day, "audit.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch { return []; }
  }).filter((event) => event.event === "x_settings_changed");
}

describe("Glance settings API", () => {
  test("GET lists the schema with the effective value, origin and lock of every key, and validates project_id", async () => {
    const setup = fixture();
    fs.writeFileSync(setup.globalFile, "routing:\n  mode: fast\n", "utf8");
    const project = new ProjectService().create({ projectRoot: setup.project });
    const base = await start();
    const response = await get(base);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.schema.map((spec: any) => spec.key)).toEqual(SETTINGS_SCHEMA.map((spec) => spec.key));
    expect(body.schema.every((spec: any) => spec.secret === false && typeof spec.description === "string" && typeof spec.expects === "string")).toBe(true);
    expect(Object.keys(body.values)).toEqual(SETTINGS_SCHEMA.map((spec) => spec.key));
    expect(body.values["routing.mode"]).toEqual({ value: "fast", source: "global", path: setup.globalFile, variable: null, raw: null, locked: false });
    expect(body.values["multi_target.enabled"]).toMatchObject({ value: true, source: "default", path: null, locked: false });
    expect(body.values["budget.default_max_cost_usd"]).toMatchObject({ value: 0, source: "engine-default" });
    expect(body.values["budget.default_max_cost_usd"].path.replace(/\\/g, "/")).toEndWith("skills/harness/config.yaml");
    expect(body.files).toMatchObject({ project: { path: setup.projectFile, exists: false }, global: { path: setup.globalFile, exists: true }, engine: { exists: true } });
    expect(body.allow_actions).toBe(true);
    expect((await get(base, `?project_id=${project.project_id}`)).status).toBe(200);
    const foreign = await get(base, "?project_id=prj_other");
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get("content-type")).toBe("application/problem+json");
  });

  test("writes take the authorization of every /api/v1 write: idempotency key, local origin, actions enabled", async () => {
    const setup = fixture();
    const base = await start();
    const noKey = await put(base, "routing.mode", { value: "fast", scope: "project" }, { "content-type": "application/json", origin: base });
    expect(noKey.status).toBe(400);
    expect(((await noKey.json()) as any).detail).toContain("Idempotency-Key");
    expect((await put(base, "routing.mode", { value: "fast", scope: "project" }, { ...headers(base), origin: "https://evil.example" })).status).toBe(403);
    expect((await del(base, "routing.mode", "project", { "content-type": "application/json", origin: base })).status).toBe(400);
    expect(fs.existsSync(setup.projectFile)).toBe(false);
    servers.pop().close();

    const readOnly = await start({ allowActions: false });
    const listed = await get(readOnly);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as any).allow_actions).toBe(false);
    const refused = await put(readOnly, "routing.mode", { value: "fast", scope: "project" }, headers(readOnly));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as any).detail).toBe("Glance actions are disabled");
    expect((await del(readOnly, "routing.mode", "project", headers(readOnly))).status).toBe(403);
    expect(fs.existsSync(setup.projectFile)).toBe(false);
    expect(auditEvents(setup)).toEqual([]);
  });

  test("refusals: unknown key 404, invalid value 400 with the schema message, a scope the key rejects 400, malformed request 400", async () => {
    const setup = fixture();
    const base = await start();
    const unknown = await put(base, "routing.nope", { value: "fast", scope: "project" });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as any).detail).toContain("chave desconhecida: routing.nope");
    expect((await del(base, "routing.nope", "project")).status).toBe(404);
    const invalid = await put(base, "routing.mode", { value: "turbo", scope: "project" });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()) as any).toMatchObject({ title: "Invalid value", detail: 'routing.mode: valor inválido "turbo"; esperado agentic | fast' });
    const number = await put(base, "supervisor.progress_ping_sec", { value: "muitos", scope: "global" });
    expect(number.status).toBe(400);
    expect(((await number.json()) as any).detail).toContain("esperado inteiro >= 0 (segundos)");
    const scope = await put(base, "updates.check", { value: false, scope: "project" });
    expect(scope.status).toBe(400);
    expect(((await scope.json()) as any).detail).toContain("updates.check só aceita escopo global");
    expect((await put(base, "routing.mode", { value: "fast", scope: "machine" })).status).toBe(400);
    expect((await put(base, "routing.mode", { scope: "project" })).status).toBe(400);
    expect((await del(base, "routing.mode", "")).status).toBe(400);
    expect(fs.existsSync(setup.projectFile)).toBe(false);
    expect(fs.existsSync(setup.globalFile)).toBe(false);
    expect(auditEvents(setup)).toEqual([]);
  });

  test("a key pinned by a variable of the server is locked on read and refused on write, naming the variable", async () => {
    const setup = fixture();
    process.env.NIRVANA_ROUTING_MODE = "fast";
    const base = await start();
    const body = await get(base).then((response) => response.json()) as any;
    expect(body.values["routing.mode"]).toEqual({ value: "fast", source: "env", path: null, variable: "NIRVANA_ROUTING_MODE", raw: "fast", locked: true });
    const refused = await put(base, "routing.mode", { value: "agentic", scope: "project" });
    expect(refused.status).toBe(409);
    const problem = await refused.json() as any;
    expect(problem.title).toBe("Setting pinned by the environment");
    expect(problem.detail).toContain("routing.mode está fixado pela variável NIRVANA_ROUTING_MODE=fast");
    expect((await del(base, "routing.mode", "project")).status).toBe(409);
    expect(fs.existsSync(setup.projectFile)).toBe(false);
    expect(auditEvents(setup)).toEqual([]);
  });

  test("round trip: set → get → unset in the project and in the global file; every write that changes a file is audited with actor glance", async () => {
    const setup = fixture();
    const base = await start();
    const set = await put(base, "routing.mode", { value: "fast", scope: "project" });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ key: "routing.mode", scope: "project", path: setup.projectFile, from: null, to: "fast", changed: true,
      effective: { value: "fast", source: "project", path: setup.projectFile, variable: null, raw: null, locked: false } });
    expect(fs.readFileSync(setup.projectFile, "utf8")).toBe('routing:\n  mode: "fast"\n');
    expect(((await get(base).then((response) => response.json())) as any).values["routing.mode"]).toMatchObject({ value: "fast", source: "project" });

    const again = await put(base, "routing.mode", { value: "fast", scope: "project" });
    expect((await again.json()) as any).toMatchObject({ changed: false, from: "fast", to: "fast" });

    const global = await put(base, "quality_gate.max_revisions", { value: "4", scope: "global" });
    expect((await global.json()) as any).toMatchObject({ scope: "global", path: setup.globalFile, from: null, to: 4, changed: true, effective: { value: 4, source: "global" } });
    expect(fs.readFileSync(setup.globalFile, "utf8")).toBe("quality_gate:\n  max_revisions: 4\n");

    const shadowed = await put(base, "routing.mode", { value: "agentic", scope: "global" });
    expect((await shadowed.json()) as any).toMatchObject({ scope: "global", to: "agentic", changed: true, effective: { value: "fast", source: "project" } });

    const toggled = await put(base, "multi_target.enabled", { value: false, scope: "project" });
    expect((await toggled.json()) as any).toMatchObject({ to: false, changed: true, effective: { value: false, source: "project" } });

    const unset = await del(base, "routing.mode", "project");
    expect(unset.status).toBe(200);
    expect((await unset.json()) as any).toMatchObject({ key: "routing.mode", scope: "project", path: setup.projectFile, from: "fast", to: null, changed: true,
      effective: { value: "agentic", source: "global", path: setup.globalFile } });
    expect((await del(base, "routing.mode", "project").then((response) => response.json())) as any).toMatchObject({ changed: false, from: null, to: null });
    const projectFile = fs.readFileSync(setup.projectFile, "utf8");
    expect(projectFile).toContain("multi_target:\n  enabled: false\n");
    expect(projectFile).not.toContain("routing");

    expect(auditEvents(setup)).toEqual([
      expect.objectContaining({ actor: "glance", key: "routing.mode", scope: "project", path: setup.projectFile, from: null, to: "fast" }),
      expect.objectContaining({ actor: "glance", key: "quality_gate.max_revisions", scope: "global", path: setup.globalFile, from: null, to: 4 }),
      expect.objectContaining({ actor: "glance", key: "routing.mode", scope: "global", path: setup.globalFile, from: null, to: "agentic" }),
      expect.objectContaining({ actor: "glance", key: "multi_target.enabled", scope: "project", path: setup.projectFile, from: null, to: false }),
      expect.objectContaining({ actor: "glance", key: "routing.mode", scope: "project", path: setup.projectFile, from: "fast", to: null }),
    ]);
  });

  test("the same Idempotency-Key with the same request replays the result without a second write; another request under it is refused", async () => {
    const setup = fixture();
    const base = await start();
    const first = await put(base, "routing.mode", { value: "fast", scope: "project" }, headers(base, "settings-one"));
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const stat = fs.statSync(setup.projectFile);
    fs.writeFileSync(setup.projectFile, 'routing:\n  mode: "agentic"\n', "utf8");
    const replay = await put(base, "routing.mode", { value: "fast", scope: "project" }, headers(base, "settings-one"));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    // The replay wrote nothing: the file still holds what was written between the two calls.
    expect(fs.readFileSync(setup.projectFile, "utf8")).toBe('routing:\n  mode: "agentic"\n');
    expect(auditEvents(setup)).toHaveLength(1);
    const reused = await put(base, "routing.mode", { value: "agentic", scope: "project" }, headers(base, "settings-one"));
    expect(reused.status).toBe(409);
    expect(((await reused.json()) as any).title).toBe("Idempotency key reused");
    expect((await del(base, "routing.mode", "project", headers(base, "settings-one"))).status).toBe(409);
    // A refusal is never stored: the same key succeeds once its cause is gone.
    const refused = await put(base, "routing.mode", { value: "turbo", scope: "project" }, headers(base, "settings-two"));
    expect(refused.status).toBe(400);
    expect((await put(base, "routing.mode", { value: "fast", scope: "project" }, headers(base, "settings-two"))).status).toBe(200);
    expect(fs.statSync(setup.projectFile).mtimeMs).toBeGreaterThanOrEqual(stat.mtimeMs);
  });

  test("a config file the resolver cannot read is a 409 naming the file, on read and on write, until it is fixed", async () => {
    const setup = fixture();
    fs.writeFileSync(setup.globalFile, "routing: [oops\n", "utf8");
    const base = await start();
    const listed = await get(base);
    expect(listed.status).toBe(409);
    const problem = await listed.json() as any;
    expect(problem.title).toBe("Config file unreadable");
    expect(problem.detail).toContain(`${setup.globalFile}: YAML inválido`);
    expect((await put(base, "routing.mode", { value: "fast", scope: "global" })).status).toBe(409);
    fs.writeFileSync(setup.globalFile, "routing:\n  mode: fast\n", "utf8");
    expect((await get(base)).status).toBe(200);
  });
});

describe("Glance settings take effect on the next child dispatch", () => {
  const headersFor = (base: string, key: string) => ({ "content-type": "application/json", origin: base, "idempotency-key": key });
  async function waitFor(base: string, projectId: string, runId: string, state: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await fetch(`${base}/api/v1/runs/${runId}?project_id=${projectId}`).then((response) => response.json()) as any;
      if (run.state === state) return run;
      if (Date.now() > deadline) throw new Error(`run did not reach ${state} within ${timeoutMs} ms`);
      await Bun.sleep(10);
    }
  }

  test("gauntlet.evaluator and multi_target.enabled changed through the API reach the environment of the next child, without a restart", async () => {
    const setup = fixture();
    const stateRoot = path.join(setup.root, "child-state");
    restores.push(shimRuntimeOnPath(stateRoot, "claude"));
    const runner = createDispatchExecutionRunner({ dispatchScriptPath: writeFakeGlanceChild(path.join(stateRoot, "helpers")),
      env: { NIRVANA_HOST_RUNTIME: "claude-code", FAKE_CHILD_STATE_DIR: stateRoot } });
    const project = new ProjectService().create({ projectRoot: setup.project });
    const base = await start({ runner });
    const projectId = project.project_id;
    const conversation = (await fetch(`${base}/api/v1/projects/${projectId}/conversations`, { method: "POST", headers: headersFor(base, "c-settings"), body: "{}" }).then((response) => response.json()) as any).conversation_id as string;
    const dispatch = async (key: string, content: string) => {
      const response = await fetch(`${base}/api/v1/conversations/${conversation}/messages`, { method: "POST", headers: headersFor(base, key), body: JSON.stringify({ project_id: projectId, role: "user", content, mode: "run" }) });
      expect(response.status).toBe(202);
      const runId = ((await response.json()) as any).run.runId as string;
      await waitFor(base, projectId, runId, "completed");
      const child = childState(stateRoot, runId);
      await child.waitFor("completed");
      return child.argv().env;
    };

    const before = await dispatch("m-before", "Produza o relatório");
    expect(before.NIRVANA_GAUNTLET_EVALUATOR).toBeUndefined();
    expect(before.NIRVANA_MULTI_TARGET_KILL_SWITCH).toBe("0");
    expect(before.NIRVANA_PROJECT_ROOT).toBe(setup.project);

    expect((await put(base, "gauntlet.evaluator", { value: "judge-x", scope: "project" })).status).toBe(200);
    expect((await put(base, "multi_target.enabled", { value: false, scope: "global" })).status).toBe(200);
    const after = await dispatch("m-after", "Produza o relatório de novo");
    expect(after.NIRVANA_GAUNTLET_EVALUATOR).toBe("judge-x");
    expect(after.NIRVANA_MULTI_TARGET_KILL_SWITCH).toBe("1");

    expect((await del(base, "gauntlet.evaluator", "project")).status).toBe(200);
    const unset = await dispatch("m-unset", "Produza o relatório uma terceira vez");
    expect(unset.NIRVANA_GAUNTLET_EVALUATOR).toBeUndefined();
    expect(unset.NIRVANA_MULTI_TARGET_KILL_SWITCH).toBe("1");
    expect(auditEvents(setup).map((event) => [event.key, event.to])).toEqual([["gauntlet.evaluator", "judge-x"], ["multi_target.enabled", false], ["gauntlet.evaluator", null]]);
  }, KERNEL_BUDGET_MS * 3);
});
