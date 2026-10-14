// dispatch-auto-parts.e2e.test.ts — `nrv dispatch --auto` with a request the
// router splits into parts: the REAL scripts/dispatch.ts with a fake `claude`
// on PATH (no LLM, no network), the technique of dispatch-cards-route.e2e.test.ts.
//
// The claim under test: every part reaches a plan the multi-target engine runs,
// one node per target in the order the parts depend on each other. Before, the
// primary target ran alone and the other parts were never delivered.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { IS_WINDOWS, writeFakeCli } from "./helpers/fake-cli.ts";
import { makeTempRoot } from "./helpers/temp-dirs.ts";
import { validatePlanFile } from "../scripts/multi-target.ts";
import { writeFakeDispatch } from "./helpers/fake-dispatch.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const SKILLS = path.join(REPO, "skills");
const DISPATCH = path.join(SKILLS, "harness", "scripts", "dispatch.ts");

const ANSWER = {
  target: "business:token-house",
  parts: [
    { target: "business:token-house", part: "The token and its tokenomics." },
    { target: "business:game-launch", part: "The Steam launch.", after: ["business:token-house"] },
  ],
  voices: [], squads: [], done: ["Both parts are delivered"], reason: "Two deliverables, two businesses.",
};

const FAKE_CLAUDE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
await Bun.stdin.text();
const argv = Bun.argv.slice(2);
const capture = process.env.FAKE_CAPTURE_DIR;
if (argv.includes("--tools")) {
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: ${JSON.stringify(JSON.stringify(ANSWER))}, session_id: "route", total_cost_usd: 0.001 }));
  process.exit(0);
}
fs.writeFileSync(path.join(capture, "worker-ran"), "a worker ran");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "x", session_id: "w", total_cost_usd: 0.01 }));
`;

// A fake `codex`: the cards router reaches it with the system part FOLDED into
// the prompt (codex has no system-prompt flag), so it checks that both halves
// arrived in order before writing the answer to the `-o` file, the way codex
// hands back its last message.
const FAKE_CODEX = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
const stdin = await Bun.stdin.text();
const argv = Bun.argv.slice(2);
const capture = process.env.FAKE_CAPTURE_DIR;
fs.writeFileSync(path.join(capture, "codex-stdin.txt"), stdin);
fs.writeFileSync(path.join(capture, "codex-args.json"), JSON.stringify(argv));
const system = stdin.indexOf("You choose who executes a request.");
const fold = stdin.indexOf("\n\n---\n\n# Mind-clone candidates");
const request = stdin.indexOf("# Request");
const answer = system === 0 && fold > system && request > fold ? ${JSON.stringify(JSON.stringify(ANSWER))} : "the prompt was not folded";
const out = argv.indexOf("-o");
if (out >= 0) fs.writeFileSync(argv[out + 1], answer);
console.log(JSON.stringify({ type: "thread.started", thread_id: "route" }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
`;

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

const REQUEST = "Launch my game on Steam and design its rewards token";

/** A project with two businesses, a fake runtime on PATH and an isolated env. */
function setup(runtime: "claude" | "codex", extraEnv: Record<string, string> = {}) {
  const root = makeTempRoot("nrv-auto-parts-"); roots.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const nirvana = path.join(projectRoot, ".nirvana");
  const bin = path.join(root, "bin");
  const capture = path.join(root, "capture");
  fs.mkdirSync(nirvana, { recursive: true });
  fs.mkdirSync(capture, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(nirvana, ".businesses-registry.json"), JSON.stringify({ businesses: {
    "token-house": { description: "Designs tokens.", produces: ["tokenomics-paper"] },
    "game-launch": { description: "Launches games.", produces: ["steam-store-page-kit"] },
  } }));
  fs.writeFileSync(path.join(nirvana, ".squads-registry.json"), JSON.stringify({ squads: {}, capabilities: {} }));
  fs.writeFileSync(path.join(nirvana, ".mind-clones-registry.json"), JSON.stringify({ mind_clones: {} }));
  writeFakeCli(bin, runtime, runtime === "claude" ? FAKE_CLAUDE : FAKE_CODEX);
  const briefFile = path.join(root, "brief.md");
  fs.writeFileSync(briefFile, REQUEST, "utf8");

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NIRVANA_|HARNESS_|FAKE_|NRV_|LLM_CASCADE|SQUADS_DIR|BUSINESSES_DIR)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home, NIRVANA_HOME: home, NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_PROJECT_ROOT: projectRoot,
    NIRVANA_HOST_RUNTIME: "claude-code", NIRVANA_RUN_LEDGER_DB: path.join(root, "ledger.sqlite"),
    NIRVANA_STATE_DB: path.join(root, "state.db"), HARNESS_LOGS_DIR: path.join(root, "logs"),
    NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1", NRV_PREFLIGHT: "0", NIRVANA_NO_DESKTOP_NOTIFY: "1",
    FAKE_CAPTURE_DIR: capture,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    ...extraEnv,
  });
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, [DISPATCH, "--auto", "--mode=cards", "--brief-file", briefFile, ...args],
      { cwd: projectRoot, env, encoding: "utf8", timeout: 90_000 });
    return { status: r.status, log: `${r.stdout}\n${r.stderr}` };
  };
  return { projectRoot, capture, run };
}

describe.skipIf(IS_WINDOWS)("dispatch --auto with a request in several parts", () => {
  test("every part becomes a node of a valid multi-target plan, in dependency order, and nothing runs under --scaffold-only", () => {
    const { projectRoot, capture, run } = setup("claude");
    const { status, log } = run(["--scaffold-only", "--project", "auto-parts"]);

    expect(status, log).toBe(3);
    expect(log).toContain("2 parts, one target each");
    expect(log).toContain("nrv multi-target run");
    const planFile = path.join(projectRoot, ".nirvana", "plans", "auto-parts.json");
    const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
    expect(validatePlanFile(plan).issues).toEqual([]);
    expect(plan.graph.nodes.filter((n: any) => n.type === "company").map((n: any) => n.id)).toEqual(["token-house", "game-launch"]);
    expect(plan.graph.edges).toContainEqual({ id: "game-launch-after-token-house", source: "game-launch", target: "token-house", type: "depends_on" });
    expect(plan.briefs["game-launch"]).toContain(REQUEST);
    expect(plan.runtime).toBeUndefined();
    expect(fs.existsSync(path.join(capture, "worker-ran")), log).toBe(false);
  }, 90_000);

  test("--runtime codex: the router answers through the folded prompt, and every child dispatch runs on codex", () => {
    const fake = path.join(makeTempRoot("nrv-auto-parts-fake-"), "fake");
    roots.push(path.dirname(fake));
    const { projectRoot, capture, run } = setup("codex", { NIRVANA_DISPATCH_SCRIPT: writeFakeDispatch(fake) });
    const { status, log } = run(["--runtime", "codex", "--exec", "--project", "auto-parts-codex"]);

    // The router ran on codex, tool-less, with the cards as a preamble of the one prompt.
    const args: string[] = JSON.parse(fs.readFileSync(path.join(capture, "codex-args.json"), "utf8"));
    expect(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2)).toEqual(["-s", "read-only"]);
    expect(args).not.toContain("--model");
    const stdin = fs.readFileSync(path.join(capture, "codex-stdin.txt"), "utf8");
    expect(stdin).toStartWith("You choose who executes a request.");
    expect(stdin).toContain(`# Request\n\n${REQUEST}`);
    // ...and its answer parsed: both parts reached the plan, with the runtime.
    expect(log).toContain("2 parts, one target each");
    const plan = JSON.parse(fs.readFileSync(path.join(projectRoot, ".nirvana", "plans", "auto-parts-codex.json"), "utf8"));
    expect(validatePlanFile(plan).issues).toEqual([]);
    expect(plan.runtime).toBe("codex");

    // The multi-target engine ran both nodes, and each child dispatch got --runtime codex.
    const workspace = path.join(projectRoot, ".nirvana", "outputs", "auto-parts-codex", "businesses");
    for (const slug of ["token-house", "game-launch"]) {
      const captured = JSON.parse(fs.readFileSync(path.join(workspace, slug, "outputs", "dispatch-capture.json"), "utf8"));
      const at = captured.argv.indexOf("--runtime");
      expect(at, `${slug}\n${log}`).toBeGreaterThan(-1);
      expect(captured.argv[at + 1]).toBe("codex");
      expect(captured.argv).toContain("--business");
    }
    expect(status, log).toBe(0);
  }, 120_000);
});
