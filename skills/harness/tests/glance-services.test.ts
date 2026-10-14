// glance-services.test.ts — the services row: declared by a manifest, honest by rule.
//
// A service the operator runs beside the engine declares itself in
// `.nirvana/glance/services/<slug>/service.yaml` and writes its own status
// file. The properties pinned here are the ones a registry of third parties
// usually gets wrong:
//
//   · nothing is `up` unless the service itself wrote a valid, recent status;
//   · a manifest can only point inside its own directory (no `..`, no absolute
//     path, no symlink leading out);
//   · bounds hold: file sizes, text lengths, services per scope;
//   · the engine row (/api/subsystems) is untouched by any of it.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { LIMITS, SERVICE_SCHEMA, STATUS_SCHEMA, readServices, servicesDir } from "../lib/glance/services.ts";
import { readSubsystems } from "../lib/glance/subsystems.ts";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";

const root = makeTempRoot("nrv-glance-services-");
const home = path.join(root, "home");
const projectA = path.join(root, "project-a");
const projectB = path.join(root, "project-b");
const previous = { home: process.env.NIRVANA_HOME, project: process.env.NIRVANA_PROJECT_ROOT, ledger: process.env.NIRVANA_RUN_LEDGER_DB };

const NOW = Date.parse("2026-10-05T12:00:00Z");
const iso = (offsetSeconds: number) => new Date(NOW + offsetSeconds * 1000).toISOString();

function writeService(scope: "project" | "global", projectRoot: string, slug: string, manifest: string | null, status?: string | object) {
  const dir = path.join(servicesDir(scope, projectRoot), slug);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== null) fs.writeFileSync(path.join(dir, "service.yaml"), manifest);
  if (status !== undefined) fs.writeFileSync(path.join(dir, "status.json"), typeof status === "string" ? status : JSON.stringify(status));
  return dir;
}

const manifest = (slug: string, extra = "") => `schema: ${SERVICE_SCHEMA}\nslug: ${slug}\nlabel: ${slug.toUpperCase()}\nstatus:\n  file: status.json\n${extra}`;
const status = (state: string, detail = "ok", offsetSeconds = -5) => ({ schema: STATUS_SCHEMA, status: state, detail, updated_at: iso(offsetSeconds) });
// The HTTP route reads the real clock, so the status it sees must be written now.
const liveStatus = (state: string, detail = "ok") => ({ ...status(state, detail), updated_at: new Date().toISOString() });

let instance: any;
let base = "";

beforeAll(async () => {
  fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });
  fs.mkdirSync(path.join(projectA, ".nirvana"), { recursive: true });
  fs.mkdirSync(path.join(projectB, ".nirvana"), { recursive: true });
  process.env.NIRVANA_HOME = home;
  process.env.NIRVANA_PROJECT_ROOT = projectA;
  process.env.NIRVANA_RUN_LEDGER_DB = path.join(home, ".nirvana", "run-ledger.sqlite");
});

afterAll(() => {
  try { instance?.close(); } catch {}
  for (const [key, value] of [["NIRVANA_HOME", previous.home], ["NIRVANA_PROJECT_ROOT", previous.project], ["NIRVANA_RUN_LEDGER_DB", previous.ledger]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  removeDir(root);
});

// Each test starts from an empty services tree in both scopes.
beforeEach(() => {
  for (const dir of [servicesDir("project", projectA), servicesDir("project", projectB), servicesDir("global", projectA)]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readServices", () => {
  test("1. a missing services directory is an empty list, and nothing gets created", () => {
    expect(readServices(projectA, NOW)).toEqual([]);
    expect(fs.existsSync(servicesDir("project", projectA))).toBe(false);
    expect(fs.existsSync(servicesDir("global", projectA))).toBe(false);
  });

  test("2. a valid manifest with a valid status answers what the service wrote", () => {
    writeService("project", projectA, "backup", manifest("backup", "description: Mirrors the vault.\nowner: ops@example.com\nurl: https://example.com/backup\ndocs: README.md\n"), status("up", "last mirror 03:00"));
    writeService("project", projectA, "watcher", manifest("watcher"), status("down", "crashed"));
    const [backup, watcher] = readServices(projectA, NOW);
    expect(backup).toMatchObject({ key: "project:backup", scope: "project", label: "BACKUP", status: "up", detail: "last mirror 03:00", description: "Mirrors the vault.", owner: "ops@example.com", url: "https://example.com/backup", docs: "README.md" });
    expect(backup.source).toBe(path.join(servicesDir("project", projectA), "backup", "status.json"));
    expect(watcher).toMatchObject({ key: "project:watcher", status: "down", detail: "crashed", url: null, docs: null });
  });

  test("3. a valid manifest without a status is null, saying so", () => {
    writeService("project", projectA, "quiet", manifest("quiet"));
    const [quiet] = readServices(projectA, NOW);
    expect(quiet.status).toBeNull();
    expect(quiet.detail).toBe("no status written yet");
  });

  test("4. a status older than the TTL is null and says how stale", () => {
    writeService("project", projectA, "late", manifest("late", "  ttl_seconds: 60\n"), status("up", "fine", -600));
    writeService("project", projectA, "fresh", manifest("fresh", "  ttl_seconds: 60\n"), status("up", "fine", -30));
    const [fresh, late] = readServices(projectA, NOW);
    expect(fresh.status).toBe("up");
    expect(late.status).toBeNull();
    expect(late.detail).toBe("stale: last update 10 min ago");
  });

  test("5. status.file with `..` or an absolute path invalidates the manifest", () => {
    writeService("project", projectA, "climb", `schema: ${SERVICE_SCHEMA}\nslug: climb\nlabel: CLIMB\nstatus:\n  file: ../other/status.json\n`);
    writeService("project", projectA, "abs", `schema: ${SERVICE_SCHEMA}\nslug: abs\nlabel: ABS\nstatus:\n  file: ${JSON.stringify(path.join(root, "status.json"))}\n`);
    const [abs, climb] = readServices(projectA, NOW);
    for (const s of [abs, climb]) {
      expect(s.status).toBeNull();
      expect(s.detail).toBe("invalid manifest: status.file must be a relative path inside the service directory");
    }
  });

  test("6. a symlinked status file that leads outside the service directory is not read", () => {
    const outside = path.join(root, "outside-status.json");
    fs.writeFileSync(outside, JSON.stringify(status("up", "from outside")));
    const dir = writeService("project", projectA, "linked", manifest("linked"));
    try {
      fs.symlinkSync(outside, path.join(dir, "status.json"), "file");
    } catch (error: any) {
      // Windows without the symlink privilege: the rule cannot be exercised here.
      if (error?.code === "EPERM") return;
      throw error;
    }
    const [linked] = readServices(projectA, NOW);
    expect(linked.status).toBeNull();
    expect(linked.detail).toBe("invalid status: file resolves outside the service directory");
  });

  test("7. a directory whose name differs from the manifest slug is invalid", () => {
    writeService("project", projectA, "dir-name", manifest("other-name"));
    const [s] = readServices(projectA, NOW);
    expect(s.key).toBe("project:dir-name");
    expect(s.status).toBeNull();
    expect(s.detail).toBe('invalid manifest: slug "other-name" differs from directory "dir-name"');
  });

  test("8. the same slug in both scopes shows once, the project one, and says it overrides", () => {
    writeService("global", projectA, "shared", manifest("shared"), status("down", "global says down"));
    writeService("global", projectA, "only-global", manifest("only-global"), status("up", "global"));
    writeService("project", projectA, "shared", manifest("shared"), status("up", "project says up"));
    const services = readServices(projectA, NOW);
    expect(services.map(s => s.key)).toEqual(["project:shared", "global:only-global"]);
    expect(services[0].status).toBe("up");
    expect(services[0].detail).toBe("project says up · overrides global");
    expect(services[1].scope).toBe("global");
  });

  test("9. a manifest or status past its byte bound is refused without being parsed", () => {
    writeService("project", projectA, "big-manifest", manifest("big-manifest") + "# " + "x".repeat(LIMITS.manifestBytes) + "\n");
    writeService("project", projectA, "big-status", manifest("big-status"), JSON.stringify({ ...status("up"), detail: "y".repeat(LIMITS.statusBytes) }));
    const [bigManifest, bigStatus] = readServices(projectA, NOW);
    expect(bigManifest.status).toBeNull();
    expect(bigManifest.detail).toBe(`invalid manifest: service.yaml larger than ${LIMITS.manifestBytes} bytes`);
    expect(bigStatus.status).toBeNull();
    expect(bigStatus.detail).toBe(`invalid status: larger than ${LIMITS.statusBytes} bytes`);
  });

  test("10. a long detail is truncated to the bound; so are label and description", () => {
    writeService("project", projectA, "wordy", manifest("wordy").replace("label: WORDY", "label: " + "L".repeat(80)) + "description: " + "d".repeat(500) + "\n", status("up", "z".repeat(500)));
    const [wordy] = readServices(projectA, NOW);
    expect(wordy.status).toBe("up");
    expect(wordy.detail!.length).toBe(LIMITS.detail);
    expect(wordy.label.length).toBe(LIMITS.label);
    expect(wordy.description!.length).toBe(LIMITS.description);
  });

  test("11. a url with a scheme other than http(s) is dropped; the manifest stays valid", () => {
    writeService("project", projectA, "odd-url", manifest("odd-url", "url: javascript:alert(1)\n"), status("up"));
    writeService("project", projectA, "file-url", manifest("file-url", "url: file:///etc/passwd\n"), status("up"));
    writeService("project", projectA, "good-url", manifest("good-url", "url: http://127.0.0.1:9999/\n"), status("up"));
    const byKey = Object.fromEntries(readServices(projectA, NOW).map(s => [s.key, s]));
    expect(byKey["project:odd-url"]).toMatchObject({ status: "up", url: null });
    expect(byKey["project:file-url"]).toMatchObject({ status: "up", url: null });
    expect(byKey["project:good-url"]).toMatchObject({ status: "up", url: "http://127.0.0.1:9999/" });
  });

  test("an invalid status schema, state or timestamp is null with the reason, never a guess", () => {
    writeService("project", projectA, "bad-schema", manifest("bad-schema"), { ...status("up"), schema: "something/else" });
    writeService("project", projectA, "bad-state", manifest("bad-state"), { ...status("up"), status: "ok" });
    writeService("project", projectA, "bad-time", manifest("bad-time"), { ...status("up"), updated_at: "yesterday" });
    writeService("project", projectA, "not-json", manifest("not-json"), "{nope");
    const details = Object.fromEntries(readServices(projectA, NOW).map(s => [s.key, [s.status, s.detail]]));
    expect(details["project:bad-schema"]).toEqual([null, `invalid status: schema must be ${STATUS_SCHEMA}`]);
    expect(details["project:bad-state"]).toEqual([null, 'invalid status: status must be "up" or "down"']);
    expect(details["project:bad-time"]).toEqual([null, "invalid status: updated_at must be an ISO 8601 timestamp"]);
    expect(details["project:not-json"]).toEqual([null, "invalid status: not valid JSON"]);
  });

  test("more than the per-scope bound: the first N by slug, the rest ignored", () => {
    for (let i = 0; i < LIMITS.servicesPerScope + 5; i++) {
      const slug = `svc-${String(i).padStart(3, "0")}`;
      writeService("project", projectA, slug, manifest(slug), status("up"));
    }
    const services = readServices(projectA, NOW);
    expect(services.length).toBe(LIMITS.servicesPerScope);
    expect(services[0].key).toBe("project:svc-000");
  });
});

describe("GET /api/services", () => {
  beforeAll(async () => {
    const { startServer } = await import("../lib/glance/server.ts");
    instance = await startServer({ port: 0, open: false, idleMin: 60, allowActions: true, theme: "apple" });
    base = `http://127.0.0.1:${instance.port}`;
  });

  test("12. serves the row and leaves /api/subsystems exactly as it was", async () => {
    const subsystemsBefore = await (await fetch(`${base}/api/subsystems`)).json();
    writeService("project", projectA, "backup", manifest("backup"), liveStatus("up", "fine"));
    const res = await fetch(`${base}/api/services`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.services.map((s: any) => [s.key, s.status, s.detail])).toEqual([["project:backup", "up", "fine"]]);
    const subsystemsAfter = await (await fetch(`${base}/api/subsystems`)).json();
    expect(subsystemsAfter.subsystems.map((s: any) => s.key)).toEqual(subsystemsBefore.subsystems.map((s: any) => s.key));
    expect(subsystemsAfter.subsystems.map((s: any) => s.key)).toEqual(readSubsystems(projectA).map(s => s.key));
    expect(Object.keys(subsystemsAfter)).toEqual(["subsystems"]);
  });

  test("13. a local project switch re-reads the project scope, no restart", async () => {
    writeService("project", projectA, "in-a", manifest("in-a"), liveStatus("up"));
    writeService("project", projectB, "in-b", manifest("in-b"), liveStatus("up"));
    const before = await (await fetch(`${base}/api/services`)).json();
    expect(before.services.map((s: any) => s.key)).toEqual(["project:in-a"]);
    const switched = await fetch(`${base}/api/actions/switch-project`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_root: projectB }),
    });
    expect(switched.status).toBe(200);
    const after = await (await fetch(`${base}/api/services`)).json();
    expect(after.services.map((s: any) => s.key)).toEqual(["project:in-b"]);
  });
});
