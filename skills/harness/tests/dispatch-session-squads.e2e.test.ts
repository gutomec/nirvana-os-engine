// dispatch-session-squads.e2e.test.ts — inside a business session, a squad runs
// only when the router named it (or the request did).
//
// A business session stamps the squads it was given on its environment
// (NIRVANA_ALLOWED_SQUADS); the session and every seat subagent share it, and a
// `nrv dispatch --squad` they start is refused for any squad outside the list.
// Outside a session the variable is absent and nothing changes (the other
// dispatch e2e suites strip every NIRVANA_ variable and cover that path).
//
// Hermetic: a fake `claude` on PATH, a squad fixture under a temporary HOME, no
// LLM and no network.
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
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

const FAKE_CLAUDE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
await Bun.stdin.text();
fs.writeFileSync(path.join(process.env.FAKE_CAPTURE_DIR, "ran"), "1", "utf8");
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
    "name: fixture-squad", "version: 1.0.0", 'protocol: "5.0"', "description: A fixture squad for the session-squads proof.",
    "experimental_domains: true", "components:", "  agents: [fixture.md]", "  tasks: []", "  workflows: []", "capabilities:",
    "  - id: general.fixture.run", "    description: Do the fixture thing.", "    domains: [fixture]", "    produces: [report]",
    '    examples: ["rode o fixture"]', "    invoke:", "      type: agent", "      ref: fixture", "",
  ].join("\n"), "utf8");
}

function auditEvents(dir: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "audit.jsonl") {
        for (const line of fs.readFileSync(full, "utf8").split("\n").filter(Boolean)) {
          try { out.push(parseAuditLine(line) as Record<string, unknown>); } catch { /* not an audit line */ }
        }
      }
    }
  };
  walk(dir);
  return out;
}

function fixture(allowed: string) {
  const root = makeTempRoot("nrv-session-squads-"); roots.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const bin = path.join(root, "bin");
  const capture = path.join(root, "capture");
  fs.mkdirSync(path.join(projectRoot, ".nirvana"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".nirvana", "project.yaml"), "name: fixture\n", "utf8");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(capture, { recursive: true });
  writeFakeCli(bin, "claude", FAKE_CLAUDE);
  writeSquad(path.join(home, "squads", "fixture-squad"));
  const briefFile = path.join(root, "brief.md");
  fs.writeFileSync(briefFile, "Produza o relatório final em report.html", "utf8");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NIRVANA_|HARNESS_|FAKE_|NRV_|LLM_CASCADE|SQUADS_DIR|BUSINESSES_DIR)/.test(key)) continue;
    env[key] = value;
  }
  const pid = "proj-session-squad";
  Object.assign(env, {
    HOME: home, USERPROFILE: home, NIRVANA_HOME: home, SQUADS_DIR: path.join(home, "squads"), NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_PROJECT_ROOT: projectRoot,
    NIRVANA_HOST_RUNTIME: "claude-code", NIRVANA_RUN_LEDGER_DB: path.join(root, "ledger.sqlite"), NIRVANA_STATE_DB: path.join(root, "state.db"),
    NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1", NRV_PREFLIGHT: "0",
    NIRVANA_ALLOWED_SQUADS: allowed,
    FAKE_CAPTURE_DIR: capture, FAKE_CLAUDE_OUTPUTS_ROOT: path.join(projectRoot, "outputs", pid, "deliverables"),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  const result = spawnSync(process.execPath, [DISPATCH, "--squad", "fixture-squad", "--brief-file", briefFile, "--exec",
    "--project", pid, "--max-revisions", "0"], { cwd: projectRoot, encoding: "utf8", env });
  return { root, projectRoot, pid, capture, result };
}

describe("a squad dispatch inside a business session", () => {
  test("a squad the session was not given is refused before anything runs", () => {
    const fx = fixture("other-squad");
    expect(fx.result.status, fx.result.stdout + fx.result.stderr).toBe(1);
    expect(fx.result.stderr).toContain("fixture-squad is not a squad this business session was given");
    expect(fx.result.stderr).toContain("deliver that part yourself");
    expect(fs.existsSync(path.join(fx.capture, "ran"))).toBe(false);
    expect(fs.existsSync(path.join(fx.projectRoot, "outputs", fx.pid))).toBe(false);
    const refused = auditEvents(fx.root).find(e => e.event === "x_session_squad_refused");
    expect(refused?.squads).toEqual(["fixture-squad"]);
    expect(refused?.allowed).toEqual(["other-squad"]);
  }, 120000);

  test("an empty list refuses every squad", () => {
    const fx = fixture("");
    expect(fx.result.status, fx.result.stdout + fx.result.stderr).toBe(1);
    expect(fx.result.stderr).toContain("(none)");
    expect(fs.existsSync(path.join(fx.capture, "ran"))).toBe(false);
  }, 120000);

  test("a squad the session was given runs and delivers", () => {
    const fx = fixture("fixture-squad");
    expect(fx.result.status, fx.result.stdout + fx.result.stderr).toBe(0);
    expect(fs.existsSync(path.join(fx.capture, "ran"))).toBe(true);
    expect(auditEvents(fx.root).some(e => e.event === "x_session_squad_refused")).toBe(false);
  }, 120000);
});
