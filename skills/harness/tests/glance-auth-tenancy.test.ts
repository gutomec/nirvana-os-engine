// glance-auth-tenancy.test.ts — cut 6 of the event-contract plan
// (.nirvana/plans/event-contract.md): authentication, tenancy and retention
// for a served Glance cockpit (`nrv glance --host`).
//
// What this defends: the loopback default stays exactly as unauthenticated as
// before this cut (the local case must never become hostile); a served
// instance (any non-loopback --host) refuses every request without a Bearer
// credential minted with `nrv serve keygen --glance`, and a plain job-API key
// (minted without --glance) does not silently unlock the cockpit; a served
// instance reads and writes its own project's logs, not the machine-global
// default, so two tenants' processes on the same host never see each other's
// runs; that pin is undone on close so a test process starting several
// servers never leaks one instance's tenant into the next; and retention
// (`audit.project_retention_days`, configurable, default 365) is enforced
// only for the served case — the local case is never auto-rotated by this cut.
//
// Hermetic: a temp NIRVANA_HOME, a temp project, a temp serve keys directory.
// No LLM, no network beyond loopback. Runs with: bun test skills/harness/tests
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SETTINGS_SCHEMA } from "../../_shared/lib/settings.ts";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";

const SCHEMA_VARIABLES = SETTINGS_SCHEMA.flatMap((spec) => [spec.env, ...(spec.envAliases ?? [])]).filter((name): name is string => !!name);
const SCRUBBED = [...SCHEMA_VARIABLES, "NIRVANA_PROJECT_ROOT", "NIRVANA_HOME", "HARNESS_LOGS_DIR", "MAESTRO_LOGS_DIR", "NIRVANA_SERVE_DIR"];
const saved = new Map<string, string | undefined>();
beforeAll(() => { for (const name of SCRUBBED) { saved.set(name, process.env[name]); delete process.env[name]; } });
afterAll(() => { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });

const roots: string[] = [];
const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  while (servers.length) { try { servers.pop()!.close(); } catch {} }
  for (const name of SCRUBBED) delete process.env[name];
  while (roots.length) removeDir(roots.pop()!);
});

function fixture() {
  const root = makeTempRoot("nrv-glance-auth-");
  roots.push(root);
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
  fs.mkdirSync(path.join(project, ".nirvana"), { recursive: true });
  process.env.NIRVANA_HOME = home;
  process.env.NIRVANA_PROJECT_ROOT = project;
  process.env.NIRVANA_SERVE_DIR = path.join(root, "serve");
  return { root, home, project };
}
type Fixture = ReturnType<typeof fixture>;

async function start(host?: string) {
  const { startServer } = await import("../lib/glance/server.ts");
  const server = await startServer({ port: 0, open: false, idleMin: 60, allowActions: true, theme: "apple", host });
  servers.push(server);
  return server;
}

async function mintKey(opts: { label: string; glance?: boolean }) {
  const { keygen } = await import("../lib/serve/auth.ts");
  return keygen(opts).token;
}

const get = (server: { port: number }, p: string, token?: string) =>
  fetch(`http://127.0.0.1:${server.port}${p}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

describe("Glance authentication boundary", () => {
  test("loopback (the default) stays unauthenticated — the local case never becomes hostile", async () => {
    fixture();
    const server = await start();
    const res = await get(server, "/api/v1/projects");
    expect(res.status).toBe(200);
  });

  test("a served instance refuses a request carrying no credential", async () => {
    fixture();
    const server = await start("0.0.0.0");
    const res = await get(server, "/api/v1/projects");
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(String(body.detail)).toContain("Bearer");
  });

  test("a served instance refuses a valid key that was not minted with --glance", async () => {
    fixture();
    const token = await mintKey({ label: "job-only" });
    const server = await start("0.0.0.0");
    const res = await get(server, "/api/v1/projects", token);
    expect(res.status).toBe(401);
  });

  test("a served instance serves a request carrying a --glance key", async () => {
    fixture();
    const token = await mintKey({ label: "cockpit", glance: true });
    const server = await start("0.0.0.0");
    const res = await get(server, "/api/v1/projects", token);
    expect(res.status).toBe(200);
  });
});

describe("Glance tenancy", () => {
  test("a served instance pins its logs to its own project, not the machine-global default", async () => {
    const setup: Fixture = fixture();
    const token = await mintKey({ label: "cockpit", glance: true });
    const server = await start("0.0.0.0");
    const res = await get(server, "/api/logs?type=harness", token);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.source as string).toContain(path.join(setup.project, ".nirvana", "logs", "harness"));
  });

  test("the local case never touches HARNESS_LOGS_DIR — no pinning side effect outside served mode", async () => {
    fixture();
    expect(process.env.HARNESS_LOGS_DIR).toBeUndefined();
    await start();
    // paths.js already resolves project-scoped logs on its own when NIRVANA_PROJECT_ROOT is
    // set (pre-existing behavior, unrelated to this cut); what this cut must NOT do for the
    // local case is reach for the env var override at all.
    expect(process.env.HARNESS_LOGS_DIR).toBeUndefined();
  });

  test("closing a served instance restores HARNESS_LOGS_DIR so the next server in the same process is not pinned", async () => {
    const setup: Fixture = fixture();
    const token = await mintKey({ label: "cockpit", glance: true });
    const served = await start("0.0.0.0");
    expect(process.env.HARNESS_LOGS_DIR).toBe(path.join(setup.project, ".nirvana", "logs", "harness"));
    const pinned = await get(served, "/api/logs?type=harness", token);
    expect((await pinned.json() as any).source as string).toContain(path.join(setup.project, ".nirvana", "logs", "harness"));
    served.close();
    expect(process.env.HARNESS_LOGS_DIR).toBeUndefined();

    await start();
    expect(process.env.HARNESS_LOGS_DIR).toBeUndefined();
  });
});

describe("Glance retention", () => {
  test("a served instance rotates its own project log past the configured retention, on boot", async () => {
    const setup: Fixture = fixture();
    const staleDir = path.join(setup.project, ".nirvana", "logs", "harness", "2000-01-01");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, "audit.jsonl"), "");
    fs.writeFileSync(path.join(setup.project, ".nirvana", "config.yaml"), "audit:\n  project_retention_days: 1\n", "utf8");

    // Rotation runs at boot, before the first request — no fetch needed here.
    await start("0.0.0.0");
    expect(fs.existsSync(staleDir)).toBe(false);
  });

  test("the local case is not auto-rotated by this cut", async () => {
    const setup: Fixture = fixture();
    const staleDir = path.join(setup.home, ".harness-logs", "2000-01-01");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, "audit.jsonl"), "");
    await start();
    expect(fs.existsSync(staleDir)).toBe(true);
  });
});
