// glance-project-switcher.test.ts — POST /api/actions/switch-project
// live-rebinds a running, LOOPBACK Glance instance to a different Nirvana
// project without a restart.
//
// Regression target: before this cut, `const projectRoot = ...` in
// startServer() was captured by closure at boot (server.ts, above
// `async fetch(req) {...}`) and read directly by a handful of request-handler
// call sites instead of a live source. `getScope()`/`resolveScope()` were
// already fresh on every call (no cache of their own) — the bug was only in
// those closure reads. This file boots one real server, switches project,
// and hits both a live-by-construction endpoint (`/api/scope`) and two of
// the PREVIOUSLY-FROZEN call sites (`/api/subsystems`, and
// `/api/v1/projects/plan`, which resolves a target path off the frozen
// const) to confirm both now reflect the new root — a test that only checks
// `getScope()` would not have caught the frozen-const bug at all.
//
// Hermetic: two temp project roots, a temp NIRVANA_HOME. No LLM, no network
// beyond loopback. Runs with: bun test skills/harness/tests
import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SETTINGS_SCHEMA } from "../../_shared/lib/settings.ts";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";
import { decodeClaudeProjectDirName, discoverKnownProjects, validateProjectPath } from "../lib/glance/project-discovery.ts";

const SCHEMA_VARIABLES = SETTINGS_SCHEMA.flatMap((spec) => [spec.env, ...(spec.envAliases ?? [])]).filter((name): name is string => !!name);
const SCRUBBED = [...SCHEMA_VARIABLES, "NIRVANA_PROJECT_ROOT", "NIRVANA_HOME", "HARNESS_LOGS_DIR", "MAESTRO_LOGS_DIR"];
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
  const root = makeTempRoot("nrv-glance-switcher-");
  roots.push(root);
  const home = path.join(root, "home");
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
  fs.mkdirSync(path.join(projectA, ".nirvana"), { recursive: true });
  fs.mkdirSync(path.join(projectB, ".nirvana"), { recursive: true });
  process.env.NIRVANA_HOME = home;
  process.env.NIRVANA_PROJECT_ROOT = projectA;
  return { root, home, projectA, projectB };
}

// Explicit, incrementing ports rather than `port: 0` (which routes through
// startServer's own findFreePort()): that helper probes with a plain
// Bun.serve() bind-then-stop, which on this OS can report a port "free" via
// SO_REUSEPORT even while another process already holds it (observed live
// against a real `nrv glance` on 3737 while writing this test) — the probe
// binds "successfully" and the REAL bind two lines later throws EADDRINUSE.
// Pre-existing, unrelated to this cut; sidestepped here rather than fixed.
let nextPort = 58201;
async function start(opts: { host?: string; allowActions?: boolean } = {}) {
  const { startServer } = await import("../lib/glance/server.ts");
  const server = await startServer({ port: nextPort++, open: false, idleMin: 60, allowActions: opts.allowActions ?? true, theme: "apple", host: opts.host });
  servers.push(server);
  return server;
}

const get = (server: { port: number }, p: string) => fetch(`http://127.0.0.1:${server.port}${p}`);
// Idempotency-Key on every POST: `/api/v1/*` writes require it (writeAuthorized());
// `/api/actions/*` ignores it. One header works for both call sites this file exercises.
const post = (server: { port: number }, p: string, body: unknown) =>
  fetch(`http://127.0.0.1:${server.port}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(body ?? {}),
  });

describe("POST /api/actions/switch-project", () => {
  test("rejects when Glance actions are disabled", async () => {
    const setup = fixture();
    const server = await start({ allowActions: false });
    const res = await post(server, "/api/actions/switch-project", { project_root: setup.projectB });
    expect(res.status).toBe(403);
  });

  test("rejects a target with no .nirvana/ marker", async () => {
    const setup = fixture();
    const server = await start();
    const bareDir = path.join(setup.root, "not-a-project");
    fs.mkdirSync(bareDir, { recursive: true });
    const res = await post(server, "/api/actions/switch-project", { project_root: bareDir });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(String(body.error)).toContain(".nirvana");
  });

  test("rejects a target that does not exist on disk", async () => {
    const setup = fixture();
    const server = await start();
    const res = await post(server, "/api/actions/switch-project", { project_root: path.join(setup.root, "nowhere") });
    expect(res.status).toBe(400);
  });

  test("rebinds /api/scope, /api/subsystems, and a previously-frozen endpoint to the new project — no restart", async () => {
    const setup = fixture();
    const server = await start();

    // Baseline: everything still answers for project A.
    const scopeBefore = await (await get(server, "/api/scope")).json() as any;
    expect(scopeBefore.projectRoot).toBe(setup.projectA);

    const subsystemsBefore = await (await get(server, "/api/subsystems")).json() as any;
    const kernelBefore = subsystemsBefore.subsystems.find((s: any) => s.key === "run-kernel");
    expect(kernelBefore.source).toBe(path.join(setup.projectA, ".nirvana", "run-kernel.sqlite"));

    // `/api/v1/projects/plan` resolves its target off the const that used to be captured by
    // closure at boot (server.ts, `path.resolve(projectRoot, body.relative_root || ".")`) —
    // exactly the frozen-projectRoot bug this test exists to catch.
    const planBefore = await (await post(server, "/api/v1/projects/plan", {})).json() as any;
    expect(planBefore.project_root).toBe(setup.projectA);

    // Switch, no restart.
    const switchRes = await post(server, "/api/actions/switch-project", { project_root: setup.projectB });
    expect(switchRes.status).toBe(200);
    const switchBody = await switchRes.json() as any;
    expect(switchBody.ok).toBe(true);
    expect(switchBody.from).toBe(setup.projectA);
    expect(switchBody.to).toBe(setup.projectB);
    expect(switchBody.scope.projectRoot).toBe(setup.projectB);

    // process.env + paths.js both moved, live, in this same process.
    expect(process.env.NIRVANA_PROJECT_ROOT).toBe(setup.projectB);
    expect(process.env.HARNESS_LOGS_DIR).toBe(path.join(setup.projectB, ".nirvana", "logs", "harness"));

    // The audit event landed under the NEW project's own harness logs, not the old one
    // (audit.js: <HARNESS_LOGS_DIR>/<YYYY-MM-DD, UTC>/audit.jsonl).
    const todayUtc = new Date().toISOString().slice(0, 10);
    const auditFile = path.join(setup.projectB, ".nirvana", "logs", "harness", todayUtc, "audit.jsonl");
    expect(fs.existsSync(auditFile)).toBe(true);
    const auditLines = fs.readFileSync(auditFile, "utf8").trim().split("\n");
    expect(auditLines.some(l => l.includes("x_glance_project_switched"))).toBe(true);

    // Already-fresh endpoint (getScope() has no cache of its own).
    const scopeAfter = await (await get(server, "/api/scope")).json() as any;
    expect(scopeAfter.projectRoot).toBe(setup.projectB);

    // Previously-frozen endpoint #1 — the regression this file exists to catch.
    const subsystemsAfter = await (await get(server, "/api/subsystems")).json() as any;
    const kernelAfter = subsystemsAfter.subsystems.find((s: any) => s.key === "run-kernel");
    expect(kernelAfter.source).toBe(path.join(setup.projectB, ".nirvana", "run-kernel.sqlite"));

    // Previously-frozen endpoint #2.
    const planAfter = await (await post(server, "/api/v1/projects/plan", {})).json() as any;
    expect(planAfter.project_root).toBe(setup.projectB);
  });

  // Brief's explicit out-of-scope note, verified rather than assumed: squads/businesses/
  // mind-clones stay global libraries by design — the switch must not special-case them —
  // but a project's OWN local overrides (`.nirvana/squads` etc., NIRVANA_SCOPE=merge in that
  // project's own `.env`) already pick up on a switch for free, because they run through the
  // exact same resolveScope() call `getScope().projectRoot` does. No new code for this; this
  // test only confirms the existing mechanism actually reaches the new root.
  test("a project's own local scope override (.nirvana/squads, NIRVANA_SCOPE=merge) takes effect on switch — confirmed, not assumed", async () => {
    const setup = fixture();
    // Project A stays global (no .env, no local squads dir).
    // Project B declares merge scope and a local squad — nothing project-switcher-specific;
    // this is the pre-existing scope.ts mechanism.
    fs.writeFileSync(path.join(setup.projectB, ".env"), "NIRVANA_SCOPE=merge\n", "utf8");
    fs.mkdirSync(path.join(setup.projectB, ".nirvana", "squads", "test-squad-b"), { recursive: true });

    const server = await start();
    const scopeBefore = await (await get(server, "/api/scope")).json() as any;
    expect(scopeBefore.mode).toBe("global");
    expect(scopeBefore.squadDirs).not.toContain(path.join(setup.projectB, ".nirvana", "squads"));

    await post(server, "/api/actions/switch-project", { project_root: setup.projectB });

    const scopeAfter = await (await get(server, "/api/scope")).json() as any;
    expect(scopeAfter.mode).toBe("merge");
    expect(scopeAfter.squadDirs).toContain(path.join(setup.projectB, ".nirvana", "squads"));
  });
});

describe("GET /api/known-projects", () => {
  test("is available without --allow-actions (read-only discovery)", async () => {
    fixture();
    const server = await start({ allowActions: false });
    const res = await get(server, "/api/known-projects");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.projects)).toBe(true);
  });
});

describe("decodeClaudeProjectDirName", () => {
  test("recovers a hyphenated leaf directory name (the case a blind replace(/-/g,'/') gets wrong)", () => {
    const root = makeTempRoot("nrv-decode-");
    roots.push(root);
    fs.mkdirSync(path.join(root, "Users", "guto", "nirvana-os"), { recursive: true });
    // Claude Code encoding of "<root>/Users/guto/nirvana-os": every "/" -> "-".
    const encoded = "-Users-guto-nirvana-os";
    expect(decodeClaudeProjectDirName(encoded, root)).toBe(path.join(root, "Users", "guto", "nirvana-os"));
  });

  test("prefers the longest real match, so a hyphenated name beats the wrong shorter split even when both exist", () => {
    const root = makeTempRoot("nrv-decode-");
    roots.push(root);
    // Both "a/b-c" and "a/b" exist; the encoded name should resolve to the
    // longer, correct one rather than stopping at the first match.
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    fs.mkdirSync(path.join(root, "a", "b-c"), { recursive: true });
    expect(decodeClaudeProjectDirName("-a-b-c", root)).toBe(path.join(root, "a", "b-c"));
  });

  test("degrades gracefully (returns null, not a throw) when no real path can be recovered", () => {
    const root = makeTempRoot("nrv-decode-");
    roots.push(root);
    expect(decodeClaudeProjectDirName("-nothing-here-at-all", root)).toBeNull();
  });
});

describe("discoverKnownProjects / validateProjectPath", () => {
  test("lists only decoded entries that exist AND carry a .nirvana/ marker", () => {
    const root = makeTempRoot("nrv-discover-");
    roots.push(root);
    const claudeProjects = path.join(root, "claude-projects");
    fs.mkdirSync(claudeProjects, { recursive: true });

    // A real Nirvana project — should be listed.
    fs.mkdirSync(path.join(root, "Users", "guto", "nirvana-os", ".nirvana"), { recursive: true });
    fs.mkdirSync(path.join(claudeProjects, "-Users-guto-nirvana-os"), { recursive: true });

    // A real directory, but no .nirvana/ marker — must NOT be listed.
    fs.mkdirSync(path.join(root, "Users", "guto", "not-a-project"), { recursive: true });
    fs.mkdirSync(path.join(claudeProjects, "-Users-guto-not-a-project"), { recursive: true });

    // An encoded name that doesn't decode to anything real — dropped, not an error.
    fs.mkdirSync(path.join(claudeProjects, "-nothing-here-at-all"), { recursive: true });

    const found = discoverKnownProjects(claudeProjects, root);
    expect(found).toEqual([{ path: path.join(root, "Users", "guto", "nirvana-os"), name: "nirvana-os" }]);
  });

  test("validateProjectPath accepts a real .nirvana/-marked directory and rejects everything else", () => {
    const root = makeTempRoot("nrv-validate-");
    roots.push(root);
    const good = path.join(root, "project");
    fs.mkdirSync(path.join(good, ".nirvana"), { recursive: true });

    expect(validateProjectPath(good)).toEqual({ ok: true, path: good });
    expect(validateProjectPath(path.join(root, "missing"))).toEqual({ ok: false, error: expect.stringContaining("does not exist") } as any);
    expect(validateProjectPath("")).toEqual({ ok: false, error: expect.stringContaining("required") } as any);

    const noMarker = path.join(root, "bare");
    fs.mkdirSync(noMarker, { recursive: true });
    expect(validateProjectPath(noMarker)).toEqual({ ok: false, error: expect.stringContaining(".nirvana") } as any);
  });
});
