// glance-log-tail-bounded.test.ts: the log tail is bounded by the day root, not by `date`.
//
// Measured on 2026-11-17 against this commit: `/api/logs?date=../../` answered
// `source: <temp>` and listed every `*.jsonl` in that directory, and the same
// route with `limit=5` still parsed the whole day before slicing (60 files of
// 4 MiB took 8.4 s, `total_in_day: 3595080`). The date is a day name from a
// query string; it decides WHICH day under the log root, never where the root
// is, and the limit decides how much is parsed.
//
// Hermetic: a temp log root holding one real day, a sibling directory with a
// jsonl the route must never reach, and a second day big enough that parsing
// it whole is visible in the answer.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { pinLogDirs } from "./helpers/engine-log-dirs.ts";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";
import { KERNEL_BUDGET_MS } from "./helpers/test-budgets.ts";

const root = makeTempRoot("nrv-glance-logtail-");
const harness = path.join(root, "harness");
const outside = path.join(root, "outside");
const maestro = path.join(root, "maestro");
const previousProjectRoot = process.env.NIRVANA_PROJECT_ROOT;

let instance: any;
let base = "";

const logDirs = pinLogDirs();

beforeAll(async () => {
  process.env.NIRVANA_PROJECT_ROOT = root;
  fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
  logDirs.use({ HARNESS_LOGS_DIR: harness, MAESTRO_LOGS_DIR: maestro });
  const { startServer } = await import("../lib/glance/server.ts");
  instance = await startServer({ port: 0, open: false, idleMin: 60, allowActions: false, theme: "apple" });
  base = `http://127.0.0.1:${instance.port}`;
});

afterEach(() => logDirs.use({ HARNESS_LOGS_DIR: harness, MAESTRO_LOGS_DIR: maestro }));

afterAll(() => {
  try { instance?.close(); } catch {}
  if (previousProjectRoot === undefined) delete process.env.NIRVANA_PROJECT_ROOT;
  else process.env.NIRVANA_PROJECT_ROOT = previousProjectRoot;
  logDirs.restore();
  removeDir(root);
});

function event(seq: number): string {
  return JSON.stringify({ ts: "2026-01-02T00:00:00.000Z", event: "x_probe", seq }) + "\n";
}

describe("the log tail stays inside the log root", () => {
  test("a date that is a path does not reach outside the log root", async () => {
    // A jsonl OUTSIDE the harness root, exactly what `date=../outside`
    // resolved to before the fix.
    const secret = "x_never-a-day";
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "elsewhere.jsonl"), JSON.stringify({ ts: "2026-11-17T00:00:00.000Z", event: secret }) + "\n", "utf8");

    const answer = await fetch(`${base}/api/logs?type=harness&date=../outside`).then(r => r.json()) as any;
    // A malformed date is not a day: no events, and nothing outside the root
    // is named in the answer.
    expect(JSON.stringify(answer)).not.toContain("x_never-a-day");
    expect(answer.total_in_day ?? 0).toBe(0);
  }, KERNEL_BUDGET_MS);

  test("an absolute date is refused the same way", async () => {
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "elsewhere.jsonl"), JSON.stringify({ ts: "2026-11-17T00:00:00.000Z", event: "x_never-a-day" }) + "\n", "utf8");

    const answer = await fetch(`${base}/api/logs?type=harness&date=${encodeURIComponent(outside)}`).then(r => r.json()) as any;
    expect(JSON.stringify(answer)).not.toContain("x_never-a-day");
    expect(answer.total_in_day ?? 0).toBe(0);
  }, KERNEL_BUDGET_MS);

  test("the limit bounds what is parsed in the day, not only what is returned", async () => {
    const day = path.join(harness, "2026-01-02");
    fs.mkdirSync(day, { recursive: true });
    // Newest last inside each file, files read newest-name-first, like the
    // audit writer's day directory.
    const big = Array.from({ length: 2000 }, (_, i) => event(i + 1000)).join("");
    for (const name of ["a.jsonl", "b.jsonl"]) fs.writeFileSync(path.join(day, name), big, "utf8");

    const answer = await fetch(`${base}/api/logs?type=harness&date=2026-01-02&limit=5`).then(r => r.json()) as any;
    expect(answer.events).toHaveLength(5);
    // The budget: the older file is never touched, so the day total is the
    // newest file's tail (a handful of events from 2000), never both files.
    // Before the fix this answered 4000 after parsing both whole.
    expect(answer.total_in_day).toBeLessThanOrEqual(10);
    expect(answer.events.at(-1).seq).toBe(2999);
  }, KERNEL_BUDGET_MS);
});