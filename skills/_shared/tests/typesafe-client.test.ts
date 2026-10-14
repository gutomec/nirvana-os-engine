// typesafe-client.test.ts — the Jev client: off without a key, never throws,
// never shows the key. No network: a local Bun.serve stands in for TypeSafe,
// and the key is a fixture string.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  JEV_MODEL, jevCall, jevCallSync, jevDoctorLine, jevEnabled, jevState, typesafeKey,
} from "../lib/typesafe-client.ts";
import { answering, choice, startFakeTypesafe, type FakeTypesafe } from "../../harness/tests/helpers/fake-typesafe.ts";

const KEY = "ts-fixture-key-0123456789abcdef";
const roots: string[] = [];
const tmp = (prefix: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); roots.push(d); return d; };
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** A home with no .env and a folder that is no project: nothing to find but what the test puts there. */
function bare() {
  const home = tmp("nrv-ts-home-");
  const cwd = tmp("nrv-ts-cwd-");
  return { home, cwd };
}
const failingFetch = (() => { throw new Error("fetch must not be called without a key"); }) as unknown as typeof fetch;
const q = { business: { type: "choice" as const, instructions: "which?", criteria: { a: "A", none: "none" } } };

describe("without a key nothing is sent", () => {
  test("jevEnabled is false and jevCall never fetches", async () => {
    const { home, cwd } = bare();
    const env = { NIRVANA_ROUTING_JEV: "auto" };
    expect(typesafeKey({ env, home, cwd })).toBeNull();
    expect(jevEnabled({ env, home, cwd })).toBe(false);
    expect(jevState({ env, home, cwd })).toBe("no-key");
    expect(jevDoctorLine({ env, home, cwd })).toBe("jev: off (no key)");
    let called = 0;
    const r = await jevCall("a request", q, { env, home, cwd, fetchImpl: ((...a: unknown[]) => { called++; return (failingFetch as any)(...a); }) as any });
    expect(called).toBe(0);
    expect(r).toMatchObject({ ok: false, attempts: 0 });
    expect(jevCallSync("a request", q, { env, home, cwd }).ok).toBe(false);
  });

  test("routing.jev: off is the same, with the key present", async () => {
    const { home, cwd } = bare();
    const env = { TYPESAFE_API_KEY: KEY, NIRVANA_ROUTING_JEV: "off" };
    expect(jevEnabled({ env, home, cwd })).toBe(false);
    expect(jevState({ env, home, cwd })).toBe("setting-off");
    expect(jevDoctorLine({ env, home, cwd })).toBe("jev: off (routing.jev)");
    expect(jevEnabled({ env: { TYPESAFE_API_KEY: KEY, NIRVANA_ROUTING_JEV: "auto" }, home, cwd })).toBe(true);
    expect(jevDoctorLine({ env: { TYPESAFE_API_KEY: KEY, NIRVANA_ROUTING_JEV: "auto" }, home, cwd })).toBe("jev: on (key found)");
  });
});

describe("where the key is found", () => {
  test("the environment, then the project .env, then ~/.env", () => {
    const { home } = bare();
    const project = tmp("nrv-ts-project-");
    fs.mkdirSync(path.join(project, ".nirvana"), { recursive: true });
    fs.writeFileSync(path.join(project, ".nirvana", "project.yaml"), "schema_version: nirvana.project/v1alpha1\n");
    fs.writeFileSync(path.join(home, ".env"), "OTHER=1\nexport TYPESAFE_API_KEY='from-home'\n");
    const env = { NIRVANA_PROJECT_ROOT: project };
    expect(typesafeKey({ env, home, cwd: project })).toBe("from-home");
    fs.writeFileSync(path.join(project, ".env"), 'TYPESAFE_API_KEY="from-project"\n');
    expect(typesafeKey({ env, home, cwd: project })).toBe("from-project");
    expect(typesafeKey({ env: { ...env, TYPESAFE_API_KEY: "from-env" }, home, cwd: project })).toBe("from-env");
  });
});

describe("a call", () => {
  let fake: FakeTypesafe;
  let mode: "ok" | "500" | "slow" | "429" | "529-twice" | "echo" | "garbage" = "ok";
  beforeAll(() => {
    fake = startFakeTypesafe((body, n) => {
      if (mode === "500") return { status: 500, text: "boom" };
      if (mode === "slow") return { delayMs: 1_500, json: { answers: {} } };
      if (mode === "429") return n % 2 === 1 ? { status: 429, text: "slow down" } : answering({ business: choice("a", 0.9) })(body);
      if (mode === "529-twice") return { status: 529, text: "overloaded" };
      if (mode === "echo") return { status: 401, text: `bad key: Bearer ${KEY}` };
      if (mode === "garbage") return { text: "not json" };
      return answering({ business: choice("a", 0.93, { none: 0.07 }) }, 2_000)(body);
    });
  });
  afterAll(() => fake.stop());
  afterEach(() => { fake.requests.length = 0; mode = "ok"; });
  const opts = () => ({ ...bare(), env: { TYPESAFE_API_KEY: KEY, TYPESAFE_ENDPOINT: fake.url } });

  test("sends state, model and questions with the key as a bearer token, and reads the answers", async () => {
    const r = await jevCall("the request", q, opts());
    expect(r.ok).toBe(true);
    expect(r.answers.business.choice).toBe("a");
    expect(r.input_tokens).toBe(2_000);
    expect(r.cost_usd).toBeCloseTo(2_000 * 0.042 / 1_000_000, 12);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].authorization).toBe(`Bearer ${KEY}`);
    expect(fake.requests[0].body).toEqual({ state: "the request", model: JEV_MODEL, questions: q });
  });

  test("an error status, a timeout and a body that is not JSON come back as ok: false, never thrown", async () => {
    mode = "500";
    expect(await jevCall("x", q, opts())).toMatchObject({ ok: false, status: 500, attempts: 1 });
    mode = "garbage";
    expect(await jevCall("x", q, opts())).toMatchObject({ ok: false, error: "the response is not JSON" });
    mode = "slow";
    const t = await jevCall("x", q, { ...opts(), timeoutMs: 300 });
    expect(t.ok).toBe(false);
    expect(t.error).toContain("timed out");
    expect(t.latency_ms).toBeLessThan(1_400);
    const thrown = await jevCall("x", q, { ...opts(), fetchImpl: (() => { throw new Error("socket hang up"); }) as any });
    expect(thrown).toMatchObject({ ok: false, error: "socket hang up" });
  });

  test("one retry, only on 429/529", async () => {
    mode = "429";
    const r = await jevCall("x", q, opts());
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    mode = "529-twice";
    fake.requests.length = 0;
    expect(await jevCall("x", q, opts())).toMatchObject({ ok: false, status: 529, attempts: 2 });
    expect(fake.requests).toHaveLength(2);
    mode = "500";
    fake.requests.length = 0;
    await jevCall("x", q, opts());
    expect(fake.requests).toHaveLength(1);
  });

  test("the key never reaches a log line or an error", async () => {
    const logs: string[] = [];
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }));
    try {
      mode = "echo";
      const r = await jevCall("x", q, opts());
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(KEY);
      expect(r.error).toContain("[redacted]");
      mode = "ok";
      expect(JSON.stringify(await jevCall("x", q, opts()))).not.toContain(KEY);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(logs.join("\n")).not.toContain(KEY);
  });

});

describe("jevCallSync", () => {
  test("makes the same call from a child process, with the key off argv", async () => {
    // The call blocks this process, so the fake answers from its own.
    const dir = tmp("nrv-ts-sync-");
    const logFile = path.join(dir, "requests.jsonl");
    const server = Bun.spawn([process.execPath, path.join(import.meta.dir, "..", "..", "harness", "tests", "helpers", "fake-typesafe-server.ts")], {
      env: { ...process.env, FAKE_TS_ANSWERS: JSON.stringify({ business: choice("a", 0.9) }), FAKE_TS_LOG: logFile },
      stdout: "pipe", stderr: "inherit",
    });
    try {
      const reader = server.stdout.getReader();
      const { value } = await reader.read();
      const url = new TextDecoder().decode(value).trim().split("\n")[0];
      const r = jevCallSync("sync request", q, { ...bare(), env: { TYPESAFE_API_KEY: KEY, TYPESAFE_ENDPOINT: url } });
      expect(r.ok, r.error).toBe(true);
      expect(r.answers.business.choice).toBe("a");
      expect(JSON.parse(fs.readFileSync(logFile, "utf8").trim()).state).toBe("sync request");
    } finally {
      server.kill();
    }
  }, 20_000);
});
