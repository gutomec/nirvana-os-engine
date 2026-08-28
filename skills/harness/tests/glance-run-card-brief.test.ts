// glance-run-card-brief.test.ts — the run card has to be able to say what the run is.
//
// The owner, looking at his own cockpit on 2026-08-28: "não temos nem brief sendo
// coletado pelo glance". Measured the same day, over the two audit roots this machine
// writes to (`~/.harness-logs/2026-08-28`, 5250 events; `<project>/.nirvana/logs/harness/
// 2026-08-28`, 1940 events), `brief_received` came out of three emitters in three shapes:
//
//   ['brief','command','event','ts']                              49×  router.js CLI
//   ['brief_chars','event','project_id','squad_name','ts']         18×  brief-squad.ts
//   ['brief_chars','event','project_id','target','trace_id','ts']   8×  dispatch.ts
//
// Exactly one of the three carries the brief text, and it is the only one with no
// `trace_id`. buildRuns groups by `ev.trace_id || "no-trace"` and reads the brief from
// `ev.brief`, so the text always landed in the bucket no run reads, and every card that
// belonged to a real trace rendered "(no brief captured)" while the brief sat in the log.
//
// What these cases pin:
//   1. the excerpt is bounded — the log is appended thousands of times a day;
//   2. every emitter carries BOTH the trace and the excerpt, so the two halves meet;
//   3. a run built from a real-shaped log shows its brief, its target, and counts
//      orchestration apart from hook noise (2450 tool_invoked + 2252 bash_completed
//      out of 5250 events made a one-step run and a fifty-step run look equally busy).
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";
import { BRIEF_EXCERPT_MAX, briefExcerpt } from "../../_shared/lib/brief-excerpt.ts";

const SKILLS = path.resolve(import.meta.dir, "..", "..");
const TMP = makeTempRoot("nrv-run-card-brief-");
const previousLogsDir = process.env.HARNESS_LOGS_DIR;

afterAll(() => {
  if (previousLogsDir === undefined) delete process.env.HARNESS_LOGS_DIR;
  else process.env.HARNESS_LOGS_DIR = previousLogsDir;
  removeDir(TMP);
});

describe("briefExcerpt bounds what travels on an event", () => {
  test("a brief shorter than the cap travels whole, on one line", () => {
    expect(briefExcerpt("Uma landing page\npara uma clínica veterinária"))
      .toBe("Uma landing page para uma clínica veterinária");
  });

  test("a long brief is cut to the cap, ellipsis included — the field never grows past it", () => {
    const long = "a".repeat(BRIEF_EXCERPT_MAX * 4);
    const excerpt = briefExcerpt(long)!;
    expect(excerpt.length).toBe(BRIEF_EXCERPT_MAX);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  test("nothing to excerpt answers null, so a reader can tell absence from an empty string", () => {
    expect(briefExcerpt("")).toBeNull();
    expect(briefExcerpt("   \n  ")).toBeNull();
    expect(briefExcerpt(undefined)).toBeNull();
  });
});

describe("a squad dispatch carries its trace AND its brief", () => {
  const home = path.join(TMP, "squad-home");
  const projectRoot = path.join(TMP, "squad-project");
  const logs = path.join(TMP, "squad-logs");
  const BRIEF = "Auditar a visibilidade em busca de uma clínica veterinária, com plano de 90 dias";
  let events: any[] = [];

  beforeAll(() => {
    const squad = path.join(home, "squads", "fixture-squad");
    fs.mkdirSync(path.join(squad, "agents"), { recursive: true });
    fs.writeFileSync(path.join(squad, "agents", "fixture.md"), "# fixture\n");
    fs.writeFileSync(path.join(squad, "squad.yaml"), [
      "name: fixture-squad",
      "version: 1.0.0",
      'protocol: "5.0"',
      "description: A fixture squad used by the run-card brief tests.",
      "experimental_domains: true",
      "components:",
      "  agents: [fixture.md]",
      "  tasks: []",
      "  workflows: []",
      "capabilities:",
      "  - id: general.fixture.run",
      "    description: Do the fixture thing.",
      "    domains: [fixture]",
      "    produces: [nothing]",
      '    examples: ["rode o fixture"]',
      "    invoke:",
      "      type: agent",
      "      ref: fixture",
      "",
    ].join("\n"));
    fs.mkdirSync(projectRoot, { recursive: true });

    const r = spawnSync(process.execPath, [
      path.join(SKILLS, "squads", "scripts", "brief-squad.ts"),
      "fixture-squad", BRIEF, "--project", "projeto-do-card",
    ], {
      encoding: "utf8", cwd: projectRoot,
      env: {
        ...process.env,
        SQUADS_DIR: path.join(home, "squads"),
        NIRVANA_HOME: home,
        NIRVANA_PROJECT_ROOT: projectRoot,
        NIRVANA_RUN_LEDGER_DB: path.join(TMP, "squad-ledger.sqlite"),
        NIRVANA_SKILLS_DIR: SKILLS,
        HARNESS_LOGS_DIR: logs,
        NIRVANA_DISPATCH_TRACKS_RUN: "1",
      },
    });
    if (r.status !== 0) throw new Error(`brief-squad failed (${r.status}): ${r.stdout}\n${r.stderr}`);
    const today = new Date().toISOString().slice(0, 10);
    events = fs.readFileSync(path.join(logs, today, "audit.jsonl"), "utf8")
      .split("\n").filter(Boolean).map(l => parseAuditLine(l));
  }, spawnBudgetMs(1));

  test("dispatch_squad names the squad and carries the trace", () => {
    const dispatched = events.filter(e => e.event === "dispatch_squad");
    expect(dispatched.length).toBe(1);
    expect(dispatched[0].trace_id).toBe("projeto-do-card");
    expect(dispatched[0].squad_name).toBe("fixture-squad");
  });

  test("brief_received carries the trace, so it reaches the run that asked for it", () => {
    const received = events.filter(e => e.event === "brief_received");
    expect(received.length).toBe(1);
    expect(received[0].trace_id).toBe("projeto-do-card");
  });

  test("both events carry the excerpt AND the true length — the card shows one, the reader can tell it was cut", () => {
    for (const name of ["brief_received", "dispatch_squad"]) {
      const ev = events.find(e => e.event === name);
      expect(ev.brief_excerpt).toBe(BRIEF);
      expect(ev.brief_chars).toBe(BRIEF.length);
    }
  });
});

describe("a run built from a real-shaped log says what it is", () => {
  const logs = path.join(TMP, "reader-logs");
  const TRACE = "e26355f1-74e7-4394-a2e2-9bca5f83984e";
  const BRIEF = "Auditar a visibilidade em busca de uma clínica veterinária";
  let run: any;

  beforeAll(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(logs, today);
    fs.mkdirSync(dir, { recursive: true });
    const at = (n: number) => `${today}T10:${String(n).padStart(2, "0")}:00.000Z`;
    // The shapes the emitters write, plus the hook noise that shares the trace.
    const lines = [
      { ts: at(0), event: "brief_received", trace_id: TRACE, project_id: TRACE, squad_name: "seo-geo-aeo", brief_excerpt: BRIEF, brief_chars: BRIEF.length },
      { ts: at(1), event: "dispatch_squad", trace_id: TRACE, project_id: TRACE, squad_name: "seo-geo-aeo", squad_slug: "seo-geo-aeo", brief_excerpt: BRIEF, brief_chars: BRIEF.length, outputs_dir: "/tmp/out" },
      ...Array.from({ length: 40 }, (_, i) => ({ ts: at(2), event: "tool_invoked", trace_id: TRACE, tool_name: "Bash", action: "run", command: `echo ${i}` })),
      ...Array.from({ length: 40 }, (_, i) => ({ ts: at(3), event: "bash_completed", trace_id: TRACE, command: `echo ${i}`, success: true })),
      ...Array.from({ length: 5 }, () => ({ ts: at(4), event: "x_ledger_lease_renewed", trace_id: TRACE })),
      { ts: at(5), event: "artifact_touched", trace_id: TRACE, file_path: "/tmp/out/relatorio.md" },
      { ts: at(6), event: "gate_passed", trace_id: TRACE, rubric: "wiki-lint", score: 0.94 },
      { ts: at(7), event: "delivered", trace_id: TRACE, artifact_path: "/tmp/out/relatorio.md" },
    ];
    fs.writeFileSync(path.join(dir, "audit.jsonl"), lines.map(l => JSON.stringify(l)).join("\n") + "\n");
    process.env.HARNESS_LOGS_DIR = logs;
    const { buildRuns } = await import("../lib/glance/data-loader.ts");
    run = buildRuns({ days: 7 }).runs!.find((r: any) => r.trace_id === TRACE);
    expect(run).toBeTruthy();
  });

  test("the card shows the brief instead of '(no brief captured)'", () => {
    expect(run.brief).toBe(BRIEF);
  });

  test("the card can name what the run was dispatched to", () => {
    expect(run.squad_name).toBe("seo-geo-aeo");
    expect(run.target).toBe("squad:seo-geo-aeo");
    expect(run.outputs_dir).toBe("/tmp/out");
  });

  test("orchestration is counted apart from hook noise", () => {
    // 90 events: 85 of them are two hook names and a lease heartbeat.
    expect(run.event_count).toBe(90);
    expect(run.noise_event_count).toBe(85);
    expect(run.signal_event_count).toBe(5);
  });

  test("what the log does not carry stays undetermined — no invented field", () => {
    expect(run.business_slug).toBeNull();
  });
});
