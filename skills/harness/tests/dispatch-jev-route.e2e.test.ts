// dispatch-jev-route.e2e.test.ts — `nrv dispatch --auto` with TypeSafe's Jev in
// front of the cards router, end to end: the REAL scripts/dispatch.ts, a fake
// `claude` on PATH and a local Bun.serve standing in for TypeSafe
// (TYPESAFE_ENDPOINT). No LLM, no network, a fixture key.
//
// With a key and an answer above the gate, the Jev decides (here: nothing in
// the library fits, so the generalist runs) and the router `claude` is never
// started. Without a key, nothing goes to TypeSafe and the
// cards router runs exactly as before.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { IS_WINDOWS, writeFakeCli } from "./helpers/fake-cli.ts";
import { makeTempRoot } from "./helpers/temp-dirs.ts";
import { answering, choice, startFakeTypesafe, type FakeTypesafe } from "./helpers/fake-typesafe.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const SKILLS = path.join(REPO, "skills");
const DISPATCH = path.join(SKILLS, "harness", "scripts", "dispatch.ts");
const KEY = "ts-fixture-key-e2e-0123456789";
const BRIEF = "Write the final report in report.html for the acme landing page";

const PASSING_HTML = [
  "<!doctype html><html><head><title>Delivery</title></head><body><main>",
  "<h1>Final delivery</h1><p>This local fixture contains enough structured content for deterministic validation.</p>",
  "<p>The manifest, quality gate and publication stages all run without network access or an external runtime.</p>",
  "</main></body></html>",
].join("");

const DONE = ["report.html exists in the outputs root", "The report names the delivery", "No placeholder text remains"];

const FAKE_CLAUDE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
const prompt = await Bun.stdin.text();
const argv = Bun.argv.slice(2);
const capture = process.env.FAKE_CAPTURE_DIR;
if (argv.includes("--tools")) {
  fs.writeFileSync(path.join(capture, "router-argv.json"), JSON.stringify(argv));
  const answer = { target: "solo", voices: [], squads: [], done: ${JSON.stringify(DONE)}, reason: "Nothing installed produces this." };
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(answer), session_id: "route", total_cost_usd: 0.001 }));
  process.exit(0);
}
fs.appendFileSync(path.join(capture, "worker-prompts.txt"), prompt + "\n<<<END>>>\n");
const outputsRoot = process.env.FAKE_CLAUDE_OUTPUTS_ROOT;
fs.mkdirSync(outputsRoot, { recursive: true });
fs.writeFileSync(path.join(outputsRoot, "report.html"), ${JSON.stringify(PASSING_HTML)}, "utf8");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "delivered", session_id: "sess-fake", total_cost_usd: 0.01 }));
`;

let fake: FakeTypesafe;
// Nothing in the fixture library writes reports: the Jev sends it to the generalist, sure of it.
const SURE = { business: choice("none", 0.95, { "acme-web": 0.05 }), shape: choice("nothing", 0.95) };
let table: Record<string, unknown> = SURE;
beforeAll(() => {
  fake = startFakeTypesafe((body) => answering(table)(body));
});
afterAll(() => fake.stop());
const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); fake.requests.length = 0; table = SURE; });

/** Every file under `dir` whose text holds `needle`. */
function filesWith(dir: string, needle: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.statSync(p).size < 4_000_000) { try { if (fs.readFileSync(p, "utf8").includes(needle)) out.push(p); } catch { /* binary */ } }
    }
  };
  walk(dir);
  return out;
}

async function run(withKey: boolean) {
  const root = makeTempRoot("nrv-jev-dispatch-"); roots.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const nirvana = path.join(projectRoot, ".nirvana");
  const bin = path.join(root, "bin");
  const capture = path.join(root, "capture");
  const outputs = path.join(root, "outputs");
  for (const d of [nirvana, capture, home]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(nirvana, ".businesses-registry.json"), JSON.stringify({ businesses: { "acme-web": { description: "Builds landing pages and their final reports.", produces: ["landing-page", "report"] } } }));
  fs.writeFileSync(path.join(nirvana, ".squads-registry.json"), JSON.stringify({ squads: {}, capabilities: {} }));
  fs.writeFileSync(path.join(nirvana, ".mind-clones-registry.json"), JSON.stringify({ mind_clones: {} }));
  writeFakeCli(bin, "claude", FAKE_CLAUDE);
  const briefFile = path.join(root, "brief.md");
  fs.writeFileSync(briefFile, BRIEF, "utf8");

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NIRVANA_|HARNESS_|FAKE_|NRV_|LLM_CASCADE|SQUADS_DIR|BUSINESSES_DIR|TYPESAFE_)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, NIRVANA_HOME: home, NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_PROJECT_ROOT: projectRoot,
    NIRVANA_HOST_RUNTIME: "claude-code", NIRVANA_RUN_LEDGER_DB: path.join(root, "ledger.sqlite"),
    NIRVANA_STATE_DB: path.join(root, "state.db"), HARNESS_LOGS_DIR: path.join(root, "logs"),
    NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1", NRV_PREFLIGHT: "0", NIRVANA_NO_DESKTOP_NOTIFY: "1",
    FAKE_CAPTURE_DIR: capture, FAKE_CLAUDE_OUTPUTS_ROOT: outputs,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    TYPESAFE_ENDPOINT: fake.url,
    ...(withKey ? { TYPESAFE_API_KEY: KEY } : {}),
  });
  // Async: the fake TypeSafe answers from this process, so it must not block.
  const child = Bun.spawn([process.execPath,
    DISPATCH, "--auto", "--mode=cards", "--brief-file", briefFile, "--exec",
    "--project", "route-e2e", "--outputs-root", outputs, "--max-revisions", "0",
  ], { cwd: projectRoot, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 90_000);
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  clearTimeout(timer);
  return { root, capture, log: `${stdout}\n${stderr}` };
}

describe.skipIf(IS_WINDOWS)("dispatch --auto with the Jev", () => {
  test("with a key and an answer above the gate, the Jev decides and the router claude never starts", async () => {
    const { root, capture, log } = await run(true);
    expect(fake.requests.length, log).toBeGreaterThanOrEqual(1);
    expect(fake.requests[0].authorization).toBe(`Bearer ${KEY}`);
    expect(log).toContain("jev decided");
    expect(fs.existsSync(path.join(capture, "router-argv.json")), log).toBe(false);
    expect(log).toContain("agent-x route");
    // The generalist ran: the worker got its prompt.
    expect(fs.existsSync(path.join(capture, "worker-prompts.txt")), log).toBe(true);
    // The audit carries the decision, never the request text or the key.
    const audited = filesWith(root, "x_jev_route_decided").filter((f) => f.endsWith(".jsonl"));
    expect(audited.length, log).toBeGreaterThan(0);
    for (const f of audited) {
      for (const line of fs.readFileSync(f, "utf8").split("\n").filter((l) => l.includes("x_jev_route_decided"))) {
        expect(line).not.toContain(KEY);
        expect(line).not.toContain(BRIEF);
        expect(line).toContain('"kind":"no_match"');
      }
    }
    expect(filesWith(root, KEY)).toEqual([]);
  }, 120_000);

  test("below the gate it escalates: the cards router decides, and the audit says why", async () => {
    table = { business: choice("acme-web", 0.55), shape: choice("one_business", 0.6) };
    const { root, capture, log } = await run(true);
    expect(fake.requests.length, log).toBeGreaterThanOrEqual(1);
    expect(log).toContain("below 0.8; the cards router decides");
    expect(fs.existsSync(path.join(capture, "router-argv.json")), log).toBe(true);
    expect(filesWith(root, "x_jev_route_escalated").filter((f) => f.endsWith(".jsonl")).length, log).toBeGreaterThan(0);
  }, 120_000);

  test("without a key nothing goes to TypeSafe and the cards router decides as before", async () => {
    const { capture, log } = await run(false);
    expect(fake.requests).toHaveLength(0);
    expect(log).not.toContain("jev decided");
    expect(log).not.toContain("jev:");
    expect(fs.existsSync(path.join(capture, "router-argv.json")), log).toBe(true);
  }, 120_000);
});
