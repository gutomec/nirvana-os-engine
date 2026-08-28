// glance-sse-semantic-names.test.ts — the cockpit's SSE events say what they carry.
//
// Measured before this cut, the server emitted `event: event`, `event: snapshot`,
// `event: done` and `event: status_change`. `event: event` names nothing: a client
// reading the wire learns only that something happened. Two names replaced it:
//
//   timeline  a new event on a run's or the activity feed's timeline
//   pulse     the periodic aggregate of /api/agents/live, as opposed to the
//             opening `snapshot` (same payload, different promise to the reader)
//
// Renaming a wire event is a contract change, so the emitters and every consumer
// in views/*.js move in the same commit. The browser handlers cannot run here;
// the static guard at the end is what proves none was left on the old name.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { pinLogDirs } from "./helpers/engine-log-dirs.ts";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";
import { KERNEL_BUDGET_MS } from "./helpers/test-budgets.ts";

const VIEWS = path.join(import.meta.dir, "..", "lib", "glance", "views");
const SERVER = path.join(import.meta.dir, "..", "lib", "glance", "server.ts");

const root = makeTempRoot("nrv-glance-sse-");
const harness = path.join(root, "harness");
const today = new Date().toISOString().slice(0, 10);
const auditFile = path.join(harness, today, "audit.jsonl");
const previousProjectRoot = process.env.NIRVANA_PROJECT_ROOT;
// `tailJsonlEvents` reads the frozen paths snapshot, so the variable alone would
// leave the trace stream tailing whatever the first test file in the process
// pinned. See helpers/engine-log-dirs.ts.
const logDirs = pinLogDirs();

let instance: any;
let base = "";

const auditLine = (id: number) => JSON.stringify({
  ts: new Date(Date.UTC(2026, 7, 28, 12, 0, id)).toISOString(),
  trace_id: "trace-sse", event: id === 1 ? "brief_received" : "dispatch_squad", project_id: "p",
}) + "\n";

/** Read an SSE body until `stop` is satisfied or the deadline passes. */
async function readStream(url: string, stop: (text: string) => boolean, budgetMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  let text = "";
  try {
    const response = await fetch(url, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    while (!stop(text)) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch { /* the abort is the deadline, and the text read so far is the evidence */ }
  finally { clearTimeout(timer); controller.abort(); }
  return text;
}

const names = (sse: string) => sse.split("\n").filter(l => l.startsWith("event: ")).map(l => l.slice("event: ".length).trim());

beforeAll(async () => {
  process.env.NIRVANA_PROJECT_ROOT = root;
  logDirs.use({ HARNESS_LOGS_DIR: harness });
  fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
  fs.mkdirSync(path.dirname(auditFile), { recursive: true });
  fs.writeFileSync(auditFile, auditLine(1), "utf8");
  const { startServer } = await import("../lib/glance/server.ts");
  instance = await startServer({ port: 0, open: false, idleMin: 60, allowActions: false, theme: "apple" });
  base = `http://127.0.0.1:${instance.port}`;
});

afterAll(() => {
  try { instance?.close(); } catch {}
  if (previousProjectRoot === undefined) delete process.env.NIRVANA_PROJECT_ROOT;
  else process.env.NIRVANA_PROJECT_ROOT = previousProjectRoot;
  logDirs.restore();
  removeDir(root);
});

describe("the cockpit's SSE events are named for what they carry", () => {
  test("/api/agents/live opens with a snapshot and then beats with a pulse", async () => {
    const sse = await readStream(`${base}/api/agents/live`, t => t.includes("event: pulse"), 8_000);
    const emitted = names(sse);
    expect(emitted[0]).toBe("snapshot");
    expect(emitted).toContain("pulse");
    expect(emitted).not.toContain("event");
  }, KERNEL_BUDGET_MS);

  test("a trace stream opens with a snapshot and calls a fresh audit row a timeline event", async () => {
    // The tick re-reads the log every 2 s, so the row appended after the stream
    // opened is the one that has to arrive under the new name.
    const pending = readStream(`${base}/api/runs/trace-sse/stream`, t => t.includes("event: timeline"), 12_000);
    await Bun.sleep(300);
    fs.appendFileSync(auditFile, auditLine(2), "utf8");
    const emitted = names(await pending);
    expect(emitted[0]).toBe("snapshot");
    expect(emitted).toContain("timeline");
    expect(emitted).not.toContain("event");
  }, KERNEL_BUDGET_MS);

  test("no emitter is left on a name that names nothing, and no view listens for one", () => {
    const server = fs.readFileSync(SERVER, "utf8");
    const emitted = [...server.matchAll(/`event: ([a-z_-]+)\\n/g)].map(m => m[1]);
    expect(emitted.length).toBeGreaterThan(0);
    // `event` and `u` were the two that carried no meaning; `u` never existed in
    // this repository, which the report states rather than claiming a fix for it.
    expect(new Set(emitted)).toEqual(new Set(["snapshot", "pulse", "timeline", "done", "status_change"]));

    for (const file of fs.readdirSync(VIEWS).filter(f => f.endsWith(".js"))) {
      const source = fs.readFileSync(path.join(VIEWS, file), "utf8");
      expect(source, `${file} still listens for the old name`).not.toInclude("addEventListener('event'");
      expect(source, `${file} still listens for the old name`).not.toInclude('addEventListener("event"');
    }
    // Every name the server emits has a listener in the views, so the rename moved
    // both ends. `done` closes the stream; `status_change` is a debug listener.
    const glance = fs.readFileSync(path.join(VIEWS, "glance.js"), "utf8");
    for (const name of ["snapshot", "pulse", "timeline", "done", "status_change"]) {
      expect(glance, `no view listens for '${name}'`).toInclude(`addEventListener('${name}'`);
    }
  });
});
