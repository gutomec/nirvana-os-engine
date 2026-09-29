// dispatch-director-fallback.e2e.test.ts — a failed director hands the brief to the intake seat.
//
// A business run in team mode asks a director for the chain. When the director
// failed (a dead runtime, a timeout, prose with no plan), no seat ran and
// nothing was on disk, so the whole business run died. It now falls back to the
// intake seat alone, the path `--single` takes, and says so in the terminal and
// in the audit, so the fallback never reads as a normal single-seat run.
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const SKILLS = path.join(REPO, "skills");
const DISPATCH = path.join(SKILLS, "harness", "scripts", "dispatch.ts");

const FAKE_CLAUDE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
const prompt = await Bun.stdin.text();
if (prompt.includes("You are the orchestration director")) { console.error("fake runtime: director failure"); process.exit(1); }
const out = process.env.FAKE_CLAUDE_OUTPUTS_ROOT;
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "report.html"), "<!doctype html><html><head><title>Delivery</title></head><body><main><h1>Final delivery</h1><p>This local fixture contains enough structured content for deterministic validation of the gate.</p><p>The manifest, quality gate and publication stages all run without network access or an external runtime.</p></main></body></html>", "utf8");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "delivered", session_id: "sess-fake", total_cost_usd: 0.01 }));
`;

const roots: string[] = [];
afterEach(() => { while (roots.length) removeDir(roots.pop()!); });

function fixture() {
  const root = makeTempRoot("nrv-director-fallback-"); roots.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const bin = path.join(root, "bin");
  const out = path.join(root, "deliverables");
  fs.mkdirSync(path.join(projectRoot, ".nirvana"), { recursive: true });
  const biz = path.join(home, "businesses", "fixture-biz");
  fs.mkdirSync(path.join(biz, "employees"), { recursive: true });
  fs.writeFileSync(path.join(biz, "business.yaml"), ["name: fixture-biz", "author: nirvana-os", "version: 1.0.0", "protocol: '2.0'",
    "description: A fixture business used by the director fallback test.", "domains:", "  - testing",
    "runtime_requirements:", "  minimum:", "    - runtime: claude-code", ""].join("\n"), "utf8");
  fs.writeFileSync(path.join(biz, "org-chart.yaml"), ["chart:", "- employee: synth", "  reports: []", "  direct_reports:", "  - researcher",
    "- employee: researcher", "  reports:", "  - synth", "  direct_reports: []", ""].join("\n"), "utf8");
  fs.writeFileSync(path.join(biz, "employees", "researcher.md"), "---\nname: researcher\nrole: researcher\ndescription: Researches the topic.\n---\n\n# researcher\n", "utf8");
  fs.writeFileSync(path.join(biz, "employees", "synth.md"), "---\nname: synth\nrole: synthesizer\ndescription: Writes the final deliverable.\nis_brief_intake: true\n---\n\n# synth\n", "utf8");
  writeFakeCli(bin, "claude", FAKE_CLAUDE);
  const brief = path.join(root, "brief.md");
  fs.writeFileSync(brief, "Produza o relatório final em report.html", "utf8");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NIRVANA_|HARNESS_|FAKE_|NRV_|LLM_CASCADE|SQUADS_DIR|BUSINESSES_DIR)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home, NIRVANA_HOME: home, SQUADS_DIR: path.join(home, "squads"), BUSINESSES_DIR: path.join(home, "businesses"),
    NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_PROJECT_ROOT: projectRoot, NIRVANA_HOST_RUNTIME: "claude-code",
    NIRVANA_RUN_LEDGER_DB: path.join(root, "ledger.sqlite"), NIRVANA_STATE_DB: path.join(root, "state.db"),
    HARNESS_LOGS_DIR: path.join(root, "logs"), NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1", NRV_PREFLIGHT: "0",
    FAKE_CLAUDE_OUTPUTS_ROOT: out, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  const audit = () => {
    const dir = path.join(root, "logs");
    if (!fs.existsSync(dir)) return [] as Array<Record<string, any>>;
    return fs.readdirSync(dir).sort().flatMap(day => {
      const file = path.join(dir, day, "audit.jsonl");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => parseAuditLine(line) as Record<string, any>) : [];
    });
  };
  const dispatch = () => spawnSync(process.execPath, [DISPATCH, "fixture-biz", "--brief-file", brief, "--exec", "--team",
    "--project", "proj-df", "--outputs-root", out, "--max-revisions", "0"], { cwd: projectRoot, encoding: "utf8", env });
  return { out, audit, dispatch };
}

describe("a business whose director fails", () => {
  test("delivers through its intake seat, loudly", () => {
    const fx = fixture();
    const r = fx.dispatch();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(path.join(fx.out, "report.html"))).toBe(true);
    expect(r.stderr).toContain("the director failed");
    expect(r.stderr).toContain("the intake seat 'synth' carries the brief alone");

    const events = fx.audit().filter(e => e.project_id === "proj-df" || e.trace_id === "proj-df");
    const fallback = events.find(e => e.event === "x_director_failed_single_fallback");
    expect(fallback).toBeDefined();
    expect(fallback!.employee).toBe("synth");
    expect(String(fallback!.error)).toContain("fake runtime: director failure");
    // The intake seat's run is audited like any single-seat run, and no team
    // failure is claimed on top of a delivery.
    expect(events.some(e => e.event === "agent_executed" && e.employee === "synth")).toBe(true);
    expect(events.some(e => e.event === "agent_exec_failed")).toBe(false);
  }, spawnBudgetMs(6));
});
