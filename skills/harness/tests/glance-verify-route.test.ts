// glance-verify-route.test.ts — the admission gate in the cockpit.
//
// Two properties, and the second is the one that matters: the read must never
// be able to freeze the server. Glance answers every panel from one event
// loop, and a verify is tens of milliseconds of synchronous filesystem work
// per entity — so the route runs a CHILD with a wall-clock cap and answers 504
// when the cap is hit, instead of holding the loop while a slow entity walks.
//
// The repair half is deliberately NOT this route: it is a mutating action,
// declared as such, so the panel confirms before it is ever sent.
//
// Runs with: bun test skills/harness/tests
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeDir } from "./helpers/temp-dirs.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-glance-verify-"));
let instance: any;
let base = "";

/** A squad complete except for the one file the engine owns. */
function squad(slug: string): string {
  const dir = path.join(root, "squads", slug);
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "squad.yaml"), [
    `name: ${slug}`, "version: 1.0.0", 'protocol: "5.0"',
    "description: A squad the cockpit can ask the gate about", "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(dir, "agents", "solo.md"), "---\nname: solo\nmaxTurns: 8\ntools: [Read]\n---\n\n# solo\n", "utf8");
  return dir;
}

// The server reads its roots from the environment, so this file has to set
// them — and then put every one of them back. `bun test` runs a directory in
// ONE process: a variable left behind here is a variable every later file
// inherits, and `NIRVANA_SCOPE=global` in particular changes how the engine
// resolves a business for the rest of the run. That is exactly how this file
// broke `check-scope-guard --strict` on Linux (the gate's fixture business
// resolved to `~/businesses` instead of its own project scope) while macOS hid
// it, because Bun there hands a spawned child the environment captured at
// process start rather than the mutated one.
const ENV_KEYS = [
  "NIRVANA_PROJECT_ROOT", "NIRVANA_SKILLS_DIR", "SQUADS_DIR",
  "NIRVANA_STATE_DIR", "HARNESS_LOGS_DIR", "NIRVANA_SCOPE",
  "NIRVANA_GLANCE_VERIFY_TIMEOUT_MS",
] as const;
const SAVED: Record<string, string | undefined> = {};

beforeAll(async () => {
  fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
  squad("cockpit-squad");
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
  process.env.NIRVANA_PROJECT_ROOT = root;
  process.env.NIRVANA_SKILLS_DIR = path.join(REPO, "skills");
  process.env.SQUADS_DIR = path.join(root, "squads");
  process.env.NIRVANA_STATE_DIR = path.join(root, "state");
  process.env.HARNESS_LOGS_DIR = path.join(root, "logs");
  process.env.NIRVANA_SCOPE = "global";
  const { startServer } = await import("../lib/glance/server.ts");
  instance = await startServer({ port: 0, open: false, idleMin: 60, allowActions: true, theme: "apple" });
  base = `http://127.0.0.1:${instance.port}`;
});

afterAll(() => {
  try { instance?.close(); } catch { /* already closed */ }
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  removeDir(root);
});

describe("GET /api/v1/verify/<kind>/<slug>", () => {
  test("answers a full verify report and stays a read", async () => {
    const r = await fetch(`${base}/api/v1/verify/squad/cockpit-squad`);
    expect(r.status).toBe(200);
    const report = await r.json() as any;
    expect(report.schema).toBe("nirvana.verify-report/v1");
    expect(report.slug).toBe("cockpit-squad");
    expect(report.verdict).toBe("REJECTED");
    expect(report.findings.map((f: any) => f.id)).toContain("surface_missing");
    // A read never repairs: the file the fixer would write is still absent.
    expect(fs.existsSync(path.join(root, "squads", "cockpit-squad", ".nirvana-surface.json"))).toBe(false);
  }, 30_000);

  test("an unknown entity is 404 and an unknown kind is not a route at all", async () => {
    expect((await fetch(`${base}/api/v1/verify/squad/nobody-here`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/verify/dragon/cockpit-squad`)).status).toBe(404);
  }, 30_000);

  test("a write to the read route is refused", async () => {
    const r = await fetch(`${base}/api/v1/verify/squad/cockpit-squad`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID(), origin: base }, body: "{}",
    });
    expect(r.status).toBe(405);
  }, 30_000);

  test("the timeout answers 504 and the server keeps serving", async () => {
    process.env.NIRVANA_GLANCE_VERIFY_TIMEOUT_MS = "1";
    const r = await fetch(`${base}/api/v1/verify/squad/cockpit-squad`);
    expect(r.status).toBe(504);
    const body = await r.json() as any;
    expect(body.title).toBe("Verify timed out");
    delete process.env.NIRVANA_GLANCE_VERIFY_TIMEOUT_MS;
    // The point of the child: the loop that timed out is still answering.
    expect((await fetch(`${base}/api/v1/capabilities`)).status).toBe(200);
  }, 30_000);
});

describe("POST /api/actions/verify-fix", () => {
  test("it is declared mutating, and the panel confirms before sending it", () => {
    const server = fs.readFileSync(path.join(REPO, "skills", "harness", "lib", "glance", "server.ts"), "utf8");
    const block = server.slice(server.indexOf('"verify-fix": {'), server.indexOf('"index-squads": {'));
    expect(block).toContain("mutating: true");
    expect(block).toContain("--fix");
    const html = fs.readFileSync(path.join(REPO, "skills", "harness", "lib", "glance", "views", "index.html"), "utf8");
    expect(html.match(/confirmAction\('verify-fix'/g)?.length).toBe(3);
  });

  test("it refuses a kind or slug it does not recognise", async () => {
    for (const body of [{ kind: "dragon", slug: "x" }, { kind: "squad", slug: "../etc" }, { kind: "squad" }]) {
      const r = await fetch(`${base}/api/actions/verify-fix`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect(r.status).toBe(400);
    }
  }, 30_000);
});
