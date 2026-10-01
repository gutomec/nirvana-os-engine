// dispatch-solo.e2e.test.ts — `nrv dispatch <business> --exec`, end to end: ONE runtime call is the whole business (no director, no seat
// subagents), it runs as the `solo` role under the context ceiling of the
// profile, the review is decided by a rule, and the normal delivery pipeline
// delivers what it wrote.
//
// Hermetic: a fake `claude` on PATH, a fixture business under a temporary HOME,
// no LLM and no network.
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";

const SKILLS = path.resolve(import.meta.dir, "..", "..");
const DISPATCH = path.join(SKILLS, "harness", "scripts", "dispatch.ts");

// Each call appends one line to calls.jsonl: what the child was, and what it saw.
const FAKE_CLAUDE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
const prompt = await Bun.stdin.text();
const cap = process.env.FAKE_CAPTURE_DIR;
fs.appendFileSync(path.join(cap, "calls.jsonl"), JSON.stringify({
  role: process.env.NIRVANA_DISPATCH_ROLE ?? null,
  window: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? null,
  director: prompt.includes("You are the orchestration director"),
  review: prompt.startsWith("# Review of the"),
  resume: process.argv.includes("--resume"),
}) + "\n");
if (prompt.startsWith("# Review of the")) {
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "rev",
    result: JSON.stringify({ confirmed: [{ id: "d1", evidence: "report.html:1, the final delivery heading" }] }) }));
  process.exit(0);
}
const out = process.env.FAKE_CLAUDE_OUTPUTS_ROOT;
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "report.html"), "<!doctype html><html><head><title>Delivery</title></head><body><main><h1>Final delivery</h1><p>This local fixture contains enough structured content for deterministic validation of the gate.</p><p>The manifest, quality gate and publication stages all run without network access or an external runtime.</p></main></body></html>", "utf8");
fs.writeFileSync(path.join(out, "_SUMMARY.md"), "Delivered report.html.", "utf8");
fs.writeFileSync(path.join(out, "_CLAIMS.json"), JSON.stringify([{ id: "d1", evidence: "report.html:1, the final delivery heading" }]), "utf8");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "delivered", session_id: "sess-solo", total_cost_usd: 0.01 }));
`;

const BRIEF = [
  "## Request (verbatim)", "Produza o relatório final em report.html", "",
  "## Decisions", "None.", "",
  "## Your part", "The whole report.", "",
  "## Inputs", "None.", "",
  "## Done when", "- report.html exists with a heading (blocking)", "",
  "## Output", "the outputs root", "",
].join("\n");

const roots: string[] = [];
afterEach(() => { while (roots.length) removeDir(roots.pop()!); });

function fixture(extraEnv: Record<string, string>, extraArgs: string[] = []) {
  const root = makeTempRoot("nrv-dispatch-solo-"); roots.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const bin = path.join(root, "bin");
  const out = path.join(root, "deliverables");
  const capture = path.join(root, "capture");
  fs.mkdirSync(path.join(projectRoot, ".nirvana"), { recursive: true });
  fs.mkdirSync(capture, { recursive: true });
  const biz = path.join(home, "businesses", "fixture-biz");
  fs.mkdirSync(path.join(biz, "employees"), { recursive: true });
  fs.writeFileSync(path.join(biz, "business.yaml"), ["name: fixture-biz", "author: nirvana-os", "version: 1.0.0", "protocol: '2.0'",
    "description: A fixture business used by the solo dispatch test.", "domains:", "  - testing",
    "runtime_requirements:", "  minimum:", "    - runtime: claude-code", ""].join("\n"), "utf8");
  fs.writeFileSync(path.join(biz, "org-chart.yaml"), ["chart:", "- employee: synth", "  reports: []", "  direct_reports:", "  - researcher",
    "- employee: researcher", "  reports:", "  - synth", "  direct_reports: []", ""].join("\n"), "utf8");
  fs.writeFileSync(path.join(biz, "employees", "researcher.md"), "---\nname: researcher\nrole: researcher\ndescription: Researches the topic.\n---\n\n# researcher\n", "utf8");
  fs.writeFileSync(path.join(biz, "employees", "synth.md"), "---\nname: synth\nrole: synthesizer\ndescription: Writes the final deliverable.\nis_brief_intake: true\n---\n\n# synth\n", "utf8");
  writeFakeCli(bin, "claude", FAKE_CLAUDE);
  const brief = path.join(root, "brief.md");
  fs.writeFileSync(brief, BRIEF, "utf8");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NIRVANA_|HARNESS_|FAKE_|NRV_|LLM_CASCADE|SQUADS_DIR|BUSINESSES_DIR|CLAUDE_CODE_AUTO_COMPACT_WINDOW)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home, NIRVANA_HOME: home, SQUADS_DIR: path.join(home, "squads"), BUSINESSES_DIR: path.join(home, "businesses"),
    NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_PROJECT_ROOT: projectRoot, NIRVANA_HOST_RUNTIME: "claude-code",
    NIRVANA_RUN_LEDGER_DB: path.join(root, "ledger.sqlite"), NIRVANA_STATE_DB: path.join(root, "state.db"),
    HARNESS_LOGS_DIR: path.join(root, "logs"), NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1", NRV_PREFLIGHT: "0",
    FAKE_CLAUDE_OUTPUTS_ROOT: out, FAKE_CAPTURE_DIR: capture, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    ...extraEnv,
  });
  // --no-judge: these cases count the worker and reviewer calls; the gate's LLM
  // judge (it reads .html reports by default) is the delivery pipeline's own test.
  const result = spawnSync(process.execPath, [DISPATCH, "fixture-biz", "--brief-file", brief, "--exec",
    "--project", "proj-solo", "--outputs-root", out, "--max-revisions", "0", "--no-judge", ...extraArgs], { cwd: projectRoot, encoding: "utf8", env });
  const calls = () => {
    const f = path.join(capture, "calls.jsonl");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const audit = () => {
    const dir = path.join(root, "logs");
    if (!fs.existsSync(dir)) return [] as Array<Record<string, any>>;
    return fs.readdirSync(dir).sort().flatMap((day) => {
      const file = path.join(dir, day, "audit.jsonl");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => parseAuditLine(line) as Record<string, any>) : [];
    });
  };
  return { out, result, calls, audit };
}

describe("a business dispatch", () => {
  test("the economy profile: one call as the solo role, under a 200k ceiling, no review, delivered", () => {
    const fx = fixture({ NIRVANA_PROFILE: "economy" });
    expect(fx.result.status, fx.result.stdout + fx.result.stderr).toBe(0);
    const calls = fx.calls();
    expect(calls).toEqual([{ role: "solo", window: "200000", director: false, review: false, resume: false }]);
    expect(fs.existsSync(path.join(fx.out, "report.html"))).toBe(true);
    expect(fx.result.stdout).toContain("review: no (review only on request)");
    const events = fx.audit();
    expect(events.some((e) => e.event === "x_business_solo_started")).toBe(true);
    expect(events.find((e) => e.event === "dispatch_business")?.business_mode).toBe("solo");
  }, 120000);

  test("--review asks for one reviewer; approved, nothing is sent back", () => {
    const fx = fixture({ NIRVANA_PROFILE: "economy" }, ["--review"]);
    expect(fx.result.status, fx.result.stdout + fx.result.stderr).toBe(0);
    const calls = fx.calls();
    expect(calls.map((c: any) => [c.role, c.review])).toEqual([["solo", false], ["planner", true]]);
    expect(fx.audit().some((e) => e.event === "x_review_approved")).toBe(true);
    expect(fs.existsSync(path.join(fx.out, "_QA-RESERVATIONS.md"))).toBe(false);
  }, 120000);

  test("without a profile a business still runs as one agent, with no ceiling", () => {
    const fx = fixture({});
    expect(fx.result.status, fx.result.stdout + fx.result.stderr).toBe(0);
    expect(fx.calls().map((c: any) => [c.role, c.window, c.director])).toEqual([["solo", null, false]]);
  }, 120000);
});
