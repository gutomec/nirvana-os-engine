// dispatch-cards-route.e2e.test.ts — `nrv dispatch --auto --mode=cards` end to
// end: the REAL scripts/dispatch.ts with a fake `claude` on PATH (no LLM, no
// network), the technique of dispatch-completion-signal.e2e.test.ts.
//
// The fake answers the routing call (the one started with `--tools ""`) with
// `solo` and three done states, and records the prompt of every other call.
// The claim under test: the done states the cards router returns reach the
// brief the executor reads, as a "Done when" section.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { IS_WINDOWS, writeFakeCli } from "./helpers/fake-cli.ts";
import { makeTempRoot } from "./helpers/temp-dirs.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const SKILLS = path.join(REPO, "skills");
const DISPATCH = path.join(SKILLS, "harness", "scripts", "dispatch.ts");

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

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

describe.skipIf(IS_WINDOWS)("dispatch --auto --mode=cards", () => {
  test("the router's done states reach the executor's brief as a Done when section", () => {
    const root = makeTempRoot("nrv-cards-dispatch-"); roots.push(root);
    const home = path.join(root, "home");
    const projectRoot = path.join(root, "project");
    const nirvana = path.join(projectRoot, ".nirvana");
    const bin = path.join(root, "bin");
    const capture = path.join(root, "capture");
    const outputs = path.join(root, "outputs");
    fs.mkdirSync(nirvana, { recursive: true });
    fs.mkdirSync(capture, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(nirvana, ".businesses-registry.json"), JSON.stringify({ businesses: { "acme-web": { description: "Builds landing pages.", produces: ["landing-page"] } } }));
    fs.writeFileSync(path.join(nirvana, ".squads-registry.json"), JSON.stringify({ squads: {}, capabilities: {} }));
    fs.writeFileSync(path.join(nirvana, ".mind-clones-registry.json"), JSON.stringify({ mind_clones: {} }));
    writeFakeCli(bin, "claude", FAKE_CLAUDE);
    const briefFile = path.join(root, "brief.md");
    fs.writeFileSync(briefFile, "Write the final report in report.html", "utf8");

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
      FAKE_CAPTURE_DIR: capture, FAKE_CLAUDE_OUTPUTS_ROOT: outputs,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    const r = spawnSync(process.execPath, [
      DISPATCH, "--auto", "--mode=cards", "--brief-file", briefFile, "--exec",
      "--project", "cards-route", "--outputs-root", outputs, "--max-revisions", "0",
    ], { cwd: projectRoot, env, encoding: "utf8", timeout: 90_000 });
    const log = `${r.stdout}\n${r.stderr}`;

    expect(fs.existsSync(path.join(capture, "router-argv.json")), log).toBe(true);
    expect(log).toContain("Auto-route — cards");
    expect(log).toContain("done when: 3 state(s) added to the brief");
    const prompts = fs.readFileSync(path.join(capture, "worker-prompts.txt"), "utf8");
    expect(prompts, log).toContain("## Done when");
    for (const state of DONE) expect(prompts).toContain(`- ${state}`);
  }, 90_000);
});
