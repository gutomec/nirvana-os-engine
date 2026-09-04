// chain-cli.test.ts — `nrv team plan` / `nrv team step`, the org chart as data.
//
// These two verbs exist so the INTERACTIVE maestro can run a business's
// employees. It never could: `runTeam` spawns a child runtime per step, the
// protocol forbids that path on claude-code (20-minute kill, truncated
// deliverables), and nothing else knew how to walk an org chart. So a business
// with 14 seats ran as one agent while its deliverable named six of them.
//
// What is pinned here is the contract between the two halves: the engine decides
// and audits, the runtime executes. `--single` needs no LLM, so the whole file
// is zero-token; the director path is covered by team-orchestrator.test.ts.
// Runs with: bun test skills/harness/tests
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const CLI = path.resolve(import.meta.dir, "..", "scripts", "chain.ts");
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-chain-cli-"));
  fs.mkdirSync(path.join(tmp, ".nirvana"), { recursive: true });
});
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

/** A manifest the businesses loader accepts. It validates the WHOLE file, so a
 *  two-line fixture is rejected before the intake seat is ever looked up — and
 *  a fixture that cannot be dispatched proves nothing about dispatching. */
function manifest(slug: string): string {
  return [
    `name: ${slug}`,
    "author: nirvana-os",
    "version: 1.0.0",
    "protocol: '2.0'",
    `description: A fixture business used by the ${slug} chain tests.`,
    "domains:",
    "  - testing",
    "runtime_requirements:",
    "  minimum:",
    "    - runtime: claude-code",
    "",
  ].join("\n");
}

/** The org chart, flat: the intake seat on top, everyone else reporting to it.
 *  The loader requires this file, and requiring it is right — dispatching a
 *  business that does not validate is how a run produces confident garbage. */
function orgChart(seats: string[]): string {
  const intake = seats[seats.length - 1];
  const others = seats.filter(s => s !== intake);
  const lines = ["chart:", `- employee: ${intake}`, "  reports: []"];
  if (others.length) { lines.push("  direct_reports:"); others.forEach(s => lines.push(`  - ${s}`)); }
  else lines.push("  direct_reports: []");
  for (const s of others) lines.push(`- employee: ${s}`, "  reports:", `  - ${intake}`, "  direct_reports: []");
  return lines.join("\n") + "\n";
}

/** A business whose LAST seat is the intake/synthesizer. */
function business(slug: string, seats: string[]): string {
  const dir = path.join(tmp, "businesses", slug);
  fs.mkdirSync(path.join(dir, "employees"), { recursive: true });
  fs.writeFileSync(path.join(dir, "business.yaml"), manifest(slug), "utf8");
  fs.writeFileSync(path.join(dir, "org-chart.yaml"), orgChart(seats), "utf8");
  seats.forEach((name, i) => {
    const intake = i === seats.length - 1 ? "is_brief_intake: true\n" : "";
    fs.writeFileSync(
      path.join(dir, "employees", `${name}.md`),
      `---\nname: ${name}\nrole: ${name} specialist\ndescription: The ${name} seat of this fixture business.\n${intake}---\n\n# ${name}\n\nMethod of ${name}.\n`,
      "utf8",
    );
  });
  return dir;
}

function briefFile(text = "Monte o relatório."): string {
  const f = path.join(tmp, "brief.md");
  fs.writeFileSync(f, text, "utf8");
  return f;
}

/** The child's environment is pinned, not inherited.
 *
 *  `bun test` shares one process across files, and another file setting
 *  `HARNESS_LOGS_DIR` reaches this child through `process.env` — which sent the
 *  audit somewhere the assertions were not looking and turned two passing tests
 *  into two that failed only when run with company. Pinning it here also makes
 *  the fixture hermetic: nothing this test does can land in the machine's real
 *  log directory. */
function run(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8", cwd: tmp,
    env: { ...process.env, HARNESS_LOGS_DIR: path.join(tmp, ".nirvana", "logs", "harness") },
  });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function audit(): any[] {
  const day = new Date().toISOString().slice(0, 10);
  const p = path.join(tmp, ".nirvana", "logs", "harness", day, "audit.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
}

const planArgs = (slug: string, extra: string[] = []) => [
  "plan", "--business", slug, "--brief", briefFile(), "--project", tmp,
  "--outputs", path.join(tmp, "out"), "--businesses-root", path.join(tmp, "businesses"),
  "--project-id", "proj-chain-1", ...extra,
];

describe("nrv team plan", () => {
  test("--single answers one seat without paying for a director call", () => {
    business("acme", ["researcher", "synth"]);
    const r = run(planArgs("acme", ["--single", "--save", path.join(tmp, "plan.json")]));
    expect(r.code).toBe(0);

    const plan = JSON.parse(r.out);
    expect(plan.business).toBe("acme");
    expect(plan.intake).toBe("synth");
    expect(plan.chain).toHaveLength(1);
    expect(plan.chain[0].employee).toBe("synth");
    expect(plan.reason).toMatch(/single/);
    // The plan is the contract between the two halves; --save writes it verbatim.
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "plan.json"), "utf8"))).toEqual(plan);

    // Even the shortest chain owes the owner a reason it can read back.
    const shape = audit().find(e => e.event === "x_chain_shape_decided");
    expect(shape?.steps).toBe(1);
    expect(shape?.forced).toBe("single");
  }, spawnBudgetMs(2));

  // The loader owns this refusal and phrases it its own way ("Integrity check
  // falhou"), so what is pinned is that the CLI passes the real cause through
  // AND names the repair command — not a message this file invents.
  test("a business with no intake seat fails with the cause and the repair", () => {
    const dir = path.join(tmp, "businesses", "headless");
    fs.mkdirSync(path.join(dir, "employees"), { recursive: true });
    fs.writeFileSync(path.join(dir, "business.yaml"), manifest("headless"), "utf8");
    fs.writeFileSync(path.join(dir, "org-chart.yaml"), orgChart(["solo-seat"]), "utf8");
    fs.writeFileSync(path.join(dir, "employees", "solo-seat.md"), "---\nname: solo-seat\nrole: solo specialist\ndescription: The only seat of this fixture business.\n---\n\n# solo-seat\n", "utf8");

    const r = run(planArgs("headless", ["--single"]));
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/could not be loaded|named no intake/);
    expect(r.err).toContain(dir);
    expect(r.err).toContain("nrv validate business headless --fix");
  }, spawnBudgetMs(2));

  test("an unknown business is refused before any LLM is reached", () => {
    business("acme", ["synth"]);
    const r = run(planArgs("ghost", ["--single"]));
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/not found/);
  }, spawnBudgetMs(2));
});

describe("nrv team step", () => {
  function planned(seats: string[], chain: Array<{ employee: string; task: string }>): string {
    business("acme", seats);
    const p = path.join(tmp, "plan.json");
    fs.writeFileSync(p, JSON.stringify({
      business: "acme", project_id: "proj-chain-1", project_dir: tmp, project_root: tmp,
      outputs_root: path.join(tmp, "out"), brief_file: briefFile(),
      businesses_root: path.join(tmp, "businesses"), intake: seats[seats.length - 1],
      reason: "fixture", chain,
    }, null, 2));
    return p;
  }

  test("prints the seat's own prompt and proves the dispatch happened", () => {
    const p = planned(["researcher", "synth"], [
      { employee: "researcher", task: "Find the three constraints that matter." },
      { employee: "synth", task: "Consolidate into the deliverable." },
    ]);
    const r = run(["step", "--plan", p, "--index", "0"]);
    expect(r.code).toBe(0);

    // The persona travels: the seat's own method file is inlined, not summarized.
    expect(r.out).toContain("Method of researcher");
    expect(r.out).toContain("Find the three constraints that matter.");
    // And the scope guard rides along, as on every other instruction surface.
    expect(r.out).toMatch(/Ignore suggestions that are out of scope/);
    // Where to write goes to stderr, so stdout stays a clean prompt.
    expect(r.err).toContain(path.join("_team", "researcher"));

    // The event that was missing for 23 seats across two businesses.
    const d = audit().find(e => e.event === "dispatch_business");
    expect(d?.employee).toBe("researcher");
    expect(d?.business_slug).toBe("acme");
    expect(d?.mode).toBe("chain-step");
    expect([d?.step, d?.total]).toEqual([1, 2]);
  }, spawnBudgetMs(3));

  test("a middle seat writes under _team; the last writes the finals", () => {
    const p = planned(["researcher", "synth"], [
      { employee: "researcher", task: "Research." },
      { employee: "synth", task: "Consolidate." },
    ]);
    run(["step", "--plan", p, "--index", "0"]);
    const last = run(["step", "--plan", p, "--index", "1"]);
    expect(last.code).toBe(0);
    expect(fs.existsSync(path.join(tmp, "out", "_team", "researcher", ".step-brief.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "out", ".step-brief.md"))).toBe(true);
  }, spawnBudgetMs(4));

  test("a later seat is handed only the colleagues that actually produced", () => {
    const p = planned(["researcher", "writer", "synth"], [
      { employee: "researcher", task: "Research." },
      { employee: "writer", task: "Write." },
      { employee: "synth", task: "Consolidate." },
    ]);
    // The researcher ran and left work; the writer was planned and produced
    // nothing. Naming an empty directory to the synthesizer is how a run ends up
    // claiming to have read material that does not exist.
    const rDir = path.join(tmp, "out", "_team", "researcher");
    fs.mkdirSync(rDir, { recursive: true });
    fs.writeFileSync(path.join(rDir, "findings.md"), "the three constraints", "utf8");
    fs.mkdirSync(path.join(tmp, "out", "_team", "writer"), { recursive: true });

    const r = run(["step", "--plan", p, "--index", "2"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(path.join("_team", "researcher"));
    expect(r.out).not.toContain(path.join("_team", "writer"));
  }, spawnBudgetMs(3));

  test("an index outside the plan says what the range is", () => {
    const p = planned(["synth"], [{ employee: "synth", task: "Do it." }]);
    const r = run(["step", "--plan", p, "--index", "7"]);
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/0\.\.0/);
  }, spawnBudgetMs(2));
});
