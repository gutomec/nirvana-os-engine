// dispatch-project-root.e2e.test.ts — one answer to "which project is this?".
//
// Reproduces the real squad dispatch of 2026-08-27 (trace ce1bd81c): the outputs
// root lived OUTSIDE the project tree, dispatch.ts derived the project by path
// arithmetic (`resolve(projDir, "..", "..")`) instead of asking the canonical
// resolver, and the audit chain of ONE trace was split across two files —
// 28 events under the project, the 9 `gate_passed` under `~/.harness-logs`.
// `nrv validate-chain` reads one place, so that chain was unauditable.
//
// Two invariants are pinned here, both the owner's decision:
//   1. every event of a trace lands in ONE audit log — the project's;
//   2. the dispatched runtime runs INSIDE the project (cwd = project root),
//      with the outputs root reachable as an additional directory.
//
// Hermetic: a fake `claude` on PATH, a squad fixture under a temporary HOME, no
// LLM and no network. HARNESS_LOGS_DIR is deliberately NOT set — pinning it
// would force one root and hide the very defect this suite exists to catch.
// Runs with: bun test skills/harness/tests
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { makeTempRoot } from "./helpers/temp-dirs.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const SKILLS = path.join(REPO, "skills");
const DISPATCH = path.join(SKILLS, "harness", "scripts", "dispatch.ts");

// Passes the offline quality gate (same fixture the other dispatch e2e suites use).
const PASSING_HTML = [
  "<!doctype html><html><head><title>Delivery</title></head><body><main>",
  "<h1>Final delivery</h1><p>This local fixture contains enough structured content for deterministic validation.</p>",
  "<p>The manifest, quality gate and publication stages all run without network access or an external runtime.</p>",
  "</main></body></html>",
].join("");

// Records the working directory and the argv it was launched with, then delivers.
const FAKE_CLAUDE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
const capture = process.env.FAKE_CAPTURE_DIR;
const argv = Bun.argv.slice(2);
await Bun.stdin.text();
fs.writeFileSync(path.join(capture, "child.json"), JSON.stringify({ cwd: process.cwd(), argv }), "utf8");
const outputsRoot = process.env.FAKE_CLAUDE_OUTPUTS_ROOT;
fs.mkdirSync(outputsRoot, { recursive: true });
fs.writeFileSync(path.join(outputsRoot, "report.html"), ${JSON.stringify(PASSING_HTML)}, "utf8");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "delivered", session_id: "sess-fake", total_cost_usd: 0.01 }));
`;

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function writeSquad(dir: string): void {
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "fixture.md"), "# fixture agent\n", "utf8");
  fs.writeFileSync(path.join(dir, "squad.yaml"), [
    "name: fixture-squad", "version: 1.0.0", 'protocol: "5.0"', "description: A fixture squad for the project-root proof.",
    "experimental_domains: true", "components:", "  agents: [fixture.md]", "  tasks: []", "  workflows: []", "capabilities:",
    "  - id: general.fixture.run", "    description: Do the fixture thing.", "    domains: [fixture]", "    produces: [report]",
    '    examples: ["rode o fixture"]', "    invoke:", "      type: agent", "      ref: fixture", "",
  ].join("\n"), "utf8");
}

/** Every harness audit log under `dir`: the daily files, wherever they were anchored.
 *  The per-scaffold `audit.jsonl` the prep scripts write is a different artifact
 *  and is excluded — this is about the DAILY chain validate-chain reads. */
function harnessAuditFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "audit.jsonl" && (full.includes(path.join("logs", "harness")) || full.includes(".harness-logs"))) found.push(full);
    }
  };
  walk(dir);
  return found.sort();
}

function readEvents(file: string): Array<Record<string, unknown>> {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

function fixture() {
  const root = makeTempRoot("nrv-projroot-"); roots.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const bin = path.join(root, "bin");
  const capture = path.join(root, "capture");
  // The outputs root of the real run: a sibling of the project, under no project at all.
  const outputs = path.join(root, "audits", "trace-outside");
  fs.mkdirSync(path.join(projectRoot, ".nirvana"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(capture, { recursive: true });
  fs.mkdirSync(outputs, { recursive: true });
  writeFakeCli(bin, "claude", FAKE_CLAUDE);
  writeSquad(path.join(home, "squads", "fixture-squad"));
  const briefFile = path.join(root, "brief.md");
  fs.writeFileSync(briefFile, "Produza o relatório final em report.html", "utf8");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NIRVANA_|HARNESS_|FAKE_|NRV_|LLM_CASCADE|SQUADS_DIR|BUSINESSES_DIR)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    // USERPROFILE too: os.homedir() follows it on Windows, not HOME. Without it the
    // `~/.harness-logs` fallback resolves to the REAL home, outside the tree this test
    // scans — so a trace leaking there would go unseen and the test would pass for the
    // wrong reason on exactly the system the split is hardest to spot.
    HOME: home, USERPROFILE: home, NIRVANA_HOME: home, SQUADS_DIR: path.join(home, "squads"), NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_PROJECT_ROOT: projectRoot,
    NIRVANA_HOST_RUNTIME: "claude-code", NIRVANA_RUN_LEDGER_DB: path.join(root, "ledger.sqlite"), NIRVANA_STATE_DB: path.join(root, "state.db"),
    NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1", NRV_PREFLIGHT: "0",
    FAKE_CAPTURE_DIR: capture, FAKE_CLAUDE_OUTPUTS_ROOT: outputs, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  const dispatch = (args: string[]) =>
    spawnSync(process.execPath, [DISPATCH, ...args], { cwd: projectRoot, encoding: "utf8", env });
  const child = () => JSON.parse(fs.readFileSync(path.join(capture, "child.json"), "utf8")) as { cwd: string; argv: string[] };
  return { root, home, projectRoot, outputs, briefFile, capture, env, dispatch, child };
}

describe("a dispatch whose outputs root is outside the project", () => {
  test("squad --exec: one audit log for the whole trace, the child runs in the project, the outputs root stays writable", () => {
    const fx = fixture();
    const pid = "proj-outside";
    const result = fx.dispatch(["--squad", "fixture-squad", "--brief-file", fx.briefFile, "--exec", "--project", pid,
      "--outputs-root", fx.outputs, "--max-revisions", "0"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);

    // No write regression: the child still delivered into the outputs root, and it was
    // handed to the runtime as an additional directory (the cwd no longer contains it).
    expect(fs.existsSync(path.join(fx.outputs, "report.html"))).toBe(true);
    const child = fx.child();
    const addDirs = child.argv.filter((_, index) => child.argv[index - 1] === "--add-dir");
    expect(addDirs).toContain(fx.outputs);

    // Decision 1 — the dispatched runtime runs INSIDE the project.
    expect(child.cwd).toBe(fx.projectRoot);

    // Decision 2 — one trace, one audit log: the project's.
    const projectLog = path.join(fx.projectRoot, ".nirvana", "logs", "harness", new Date().toISOString().slice(0, 10), "audit.jsonl");
    const logs = harnessAuditFiles(fx.root);
    const withTrace = logs.filter(file => readEvents(file).some(event => event.trace_id === pid));
    expect(withTrace).toEqual([projectLog]);

    // And it is the COMPLETE chain: the gate verdict is in the same file as the dispatch.
    const events = readEvents(projectLog).filter(event => event.trace_id === pid).map(event => event.event);
    for (const name of ["dispatch_squad", "verify_passed", "gate_passed", "delivered"]) {
      expect(events, name).toContain(name);
    }
  }, 120000);
});
