/**
 * audit-events-content.test.ts — the audit contract as content expresses it.
 *
 * Two halves. The scanner half pins what a file scan can see and, just as
 * importantly, what it must refuse to see: an agro calendar writing
 * `event=veranico`, a WhatsApp library writing `"event": "qr"` and a squad's
 * own `render_audit.jsonl` writing `"event": "render_success"` are all real
 * lines from the installed library and none of them is a harness audit event.
 *
 * The gate half is the case the cut exists for: a fixture squad emitting
 * `phase_completed` with no prefix is caught, and one emitting
 * `x_myslug_phase_completed` with its `squad_name` is not.
 *
 * Runs with: bun test skills/_shared/tests/audit-events-content.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { allowedEvents, scanFileEvents, verdictOf } from "../lib/audit-events.ts";
import { REPO, businessFixture, rmrf, runCli, squadFixture, tempRoot, writeSurfaceFor } from "./helpers/verify-fixture.ts";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) rmrf(r); });
function root(): string { const r = tempRoot(); ROOTS.push(r); return r; }

const allowed = allowedEvents();
/** The scanner over a string, without touching disk twice. */
function scanText(text: string, name = "agents/x.md") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-scan-"));
  ROOTS.push(dir);
  const file = path.join(dir, "f.md");
  fs.writeFileSync(file, text, "utf8");
  return scanFileEvents(file, name);
}
const names = (sites: Array<{ event: string }>) => sites.map((s) => s.event).sort();

// ── the scanner ─────────────────────────────────────────────────────────────

describe("scanEntityEvents finds the five forms a content file names an event in", () => {
  test("the nrv command is self-anchored — no surrounding audit phrase needed", () => {
    const s = scanText("Run `nrv audit emit x_demo_phase_done --squad=demo` when the phase closes.\n");
    expect(names(s)).toEqual(["x_demo_phase_done"]);
    expect(s[0].form).toBe("cmd");
    expect(s[0].attributed).toBe(true);
  });

  test("an audit.emit call in a script the entity ships", () => {
    const s = scanText("```js\naudit.emit('x_demo_built', { squad_name: 'demo' });\n```\n", "scripts/run.js");
    expect(names(s)).toEqual(["x_demo_built"]);
    expect(s[0].form).toBe("code");
  });

  test("an `event=` field, when the window names the harness audit", () => {
    const s = scanText("6. **Log** audit event `event=audiobook_script_emitted` with trace_id.\n");
    expect(names(s)).toContain("audiobook_script_emitted");
  });

  test("a JSON `\"event\"` key inside a block that appends to audit.jsonl", () => {
    const s = scanText('Append to `~/.harness-logs/$(date +%F)/audit.jsonl`:\n\n```json\n{"event": "phase_completed", "squad": "demo"}\n```\n');
    expect(names(s)).toContain("phase_completed");
    expect(s.find((x) => x.event === "phase_completed")!.attributed).toBe(true);
  });

  test("a backticked name on a line that says audit event", () => {
    const s = scanText("If `page_geometry` is missing, default and emit a `default_applied` audit event.\n");
    expect(names(s)).toEqual(["default_applied"]);
  });

  test("a backticked name the word `event` follows directly", () => {
    const s = scanText("Every sub-agent invocation writes a `dispatch_subagent` event. The audit trail must show the fan-out.\n");
    expect(names(s)).toEqual(["dispatch_subagent"]);
  });

  test("a list of names introduced by the emission phrase, all of them", () => {
    const s = scanText("6. **Emita os eventos de auditoria**: `refresh_started`, `claim_demoted`, `version_published`.\n");
    expect(names(s)).toEqual(["claim_demoted", "refresh_started", "version_published"]);
  });
});

describe("the scanner refuses the lines that are not audit events", () => {
  test("a domain calendar is not the audit log", () => {
    expect(scanText("Marcadores sazonais: `event=veranico`, `event=geada`, `event=black_friday`.\n")).toEqual([]);
  });

  test("a library's own protocol events are not the audit log", () => {
    expect(scanText('```json\n{"event":"qr"}\n{"event":"pairing_code"}\n```\n')).toEqual([]);
  });

  test("a squad's own render_audit.jsonl does not anchor itself into the harness contract", () => {
    const s = scanText('Write `render_audit.jsonl`:\n\n```json\n{"event": "render_success", "provider": "eleven"}\n```\n');
    expect(s).toEqual([]);
  });

  test("a field name sharing a line with the words audit event is not an event", () => {
    const s = scanText("Read `target_platforms` from the brief. If empty, emit a `default_applied` audit event with `trace_id`.\n");
    expect(names(s)).toEqual(["default_applied"]);
  });

  test("a quality-gate id on a line about an audit trail is not an event", () => {
    const s = scanText("14. Toda retificação carrega trilha de auditoria. Gate `rectification_grounded` (`after: rectify`).\n");
    expect(s).toEqual([]);
  });
});

describe("verdictOf applies today's rule, unchanged", () => {
  const site = (event: string, attributed: boolean) => ({ file: "a.md", line: 1, event, form: "prose" as const, attributed, text: "" });
  test("a closed-enum name passes without attribution — the core is the platform's", () => {
    expect(verdictOf(site("gate_passed", false), allowed)).toBe("enum");
  });
  test("an x_ name with its author passes", () => {
    expect(verdictOf(site("x_demo_phase_done", true), allowed)).toBe("extension");
  });
  test("an x_ name with no author is a finding", () => {
    expect(verdictOf(site("x_demo_phase_done", false), allowed)).toBe("unattributed");
  });
  test("a bare invented name is a finding", () => {
    expect(verdictOf(site("phase_completed", true), allowed)).toBe("unprefixed");
  });
});

// ── the gate ────────────────────────────────────────────────────────────────

const ROGUE_TASK = [
  "# Close the phase",
  "",
  "When the phase closes, append the audit event `event=phase_completed` with the phase name.",
  "",
].join("\n");

const CLEAN_TASK = (slug: string) => [
  "# Close the phase",
  "",
  "When the phase closes, record it:",
  "",
  "```bash",
  `nrv audit emit x_${slug.replace(/-/g, "_")}_phase_completed --squad=${slug} --trace="$NIRVANA_TRACE_ID" --phase=build`,
  "```",
  "",
].join("\n");

function findings(r: string, kind: string, slug: string) {
  const out = runCli(r, [kind, slug, "--no-retrieval", "--json"]);
  expect(out.json).not.toBeNull();
  return out.json.findings as Array<{ id: string; severity: string; where?: string; message: string }>;
}
const withId = (f: Array<{ id: string }>, id: string) => f.filter((x) => x.id === id);

describe("nrv validate squad — the event criterion", () => {
  test("a squad emitting phase_completed with no prefix is caught", () => {
    const r = root();
    const dir = squadFixture(r, "rogue-emitter");
    fs.writeFileSync(path.join(dir, "tasks", "close.md"), ROGUE_TASK, "utf8");
    writeSurfaceFor(dir, "squad");
    const f = findings(r, "squad", "rogue-emitter");
    const hit = withId(f, "audit_event_unprefixed");
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe("error");
    expect(hit[0].where).toBe("tasks/close.md:phase_completed");
  });

  test("a squad emitting x_<slug>_phase_completed with its squad_name is not", () => {
    const r = root();
    const dir = squadFixture(r, "clean-emitter");
    fs.writeFileSync(path.join(dir, "tasks", "close.md"), CLEAN_TASK("clean-emitter"), "utf8");
    writeSurfaceFor(dir, "squad");
    const f = findings(r, "squad", "clean-emitter");
    expect(withId(f, "audit_event_unprefixed")).toHaveLength(0);
    expect(withId(f, "audit_event_unattributed")).toHaveLength(0);
  });

  test("an x_ event with no author is caught by the attribution half", () => {
    const r = root();
    const dir = squadFixture(r, "anon-emitter");
    fs.writeFileSync(path.join(dir, "tasks", "close.md"), "# Close\n\nEmit the audit event `event=x_anon_phase_completed`.\n", "utf8");
    writeSurfaceFor(dir, "squad");
    const f = findings(r, "squad", "anon-emitter");
    expect(withId(f, "audit_event_unattributed")).toHaveLength(1);
    expect(withId(f, "audit_event_unprefixed")).toHaveLength(0);
  });

  test("a squad naming a closed-enum event is not asked to attribute it", () => {
    const r = root();
    const dir = squadFixture(r, "core-emitter");
    fs.writeFileSync(path.join(dir, "tasks", "close.md"), "# Close\n\nThe audit event `event=gate_passed` closes the run.\n", "utf8");
    writeSurfaceFor(dir, "squad");
    const f = findings(r, "squad", "core-emitter");
    expect(withId(f, "audit_event_unprefixed")).toHaveLength(0);
    expect(withId(f, "audit_event_unattributed")).toHaveLength(0);
  });

  test("the finding is baselineable, so a recorded library keeps its verdict", () => {
    const r = root();
    const dir = squadFixture(r, "debt-emitter");
    fs.writeFileSync(path.join(dir, "tasks", "close.md"), ROGUE_TASK, "utf8");
    writeSurfaceFor(dir, "squad");
    const baseline = path.join(r, "baseline.json");
    fs.writeFileSync(baseline, JSON.stringify({
      recorded_at: new Date().toISOString(),
      entities: { "squad:debt-emitter": ["audit_event_unprefixed:tasks/close.md:phase_completed"] },
    }), "utf8");
    const out = runCli(r, ["squad", "debt-emitter", "--no-retrieval", "--json", `--baseline=${baseline}`]);
    const hit = (out.json.findings as Array<{ id: string; baselined: boolean }>).filter((x) => x.id === "audit_event_unprefixed");
    expect(hit).toHaveLength(1);
    expect(hit[0].baselined).toBe(true);
    expect(out.json.summary.errors).toBe(0);
  });
});

describe("nrv validate business — the same criterion", () => {
  test("a business emitting phase_completed with no prefix is caught", () => {
    const r = root();
    const dir = businessFixture(r, "rogue-house");
    fs.writeFileSync(path.join(dir, "PHASES.md"), ROGUE_TASK, "utf8");
    writeSurfaceFor(dir, "business");
    const f = findings(r, "business", "rogue-house");
    const hit = withId(f, "audit_event_unprefixed");
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe("error");
    expect(hit[0].where).toBe("PHASES.md:phase_completed");
  });

  test("a business emitting x_<slug>_phase_completed with its business_slug is not", () => {
    const r = root();
    const dir = businessFixture(r, "clean-house");
    fs.writeFileSync(path.join(dir, "PHASES.md"), [
      "# Close the phase", "", "Record it:", "", "```bash",
      "nrv audit emit x_clean_house_phase_completed --business=clean-house --phase=build",
      "```", "",
    ].join("\n"), "utf8");
    writeSurfaceFor(dir, "business");
    const f = findings(r, "business", "clean-house");
    expect(withId(f, "audit_event_unprefixed")).toHaveLength(0);
    expect(withId(f, "audit_event_unattributed")).toHaveLength(0);
  });
});

// ── the repo gate ───────────────────────────────────────────────────────────

describe("check-audit-parity sees content, and gates only what the repo owns", () => {
  const GATE = path.join(REPO, "scripts", "check-audit-parity.ts");

  function runGate(extra: NodeJS.ProcessEnv) {
    const r = spawnSync(process.execPath, [GATE, "--strict"], {
      cwd: REPO,
      env: { ...process.env, NIRVANA_PACKS_DIR: path.join(os.tmpdir(), "nrv-no-packs-here"), ...extra },
      encoding: "utf8",
      timeout: spawnBudgetMs(2),
    });
    return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  test("a rogue event in the installed library is reported and does NOT fail the gate", () => {
    const r = root();
    const dir = squadFixture(r, "loud-emitter");
    fs.writeFileSync(path.join(dir, "tasks", "close.md"), ROGUE_TASK, "utf8");
    const g = runGate({ SQUADS_DIR: path.join(r, "squads"), BUSINESSES_DIR: path.join(r, "businesses") });
    expect(g.out).toContain("loud-emitter");
    expect(g.out).toContain("phase_completed");
    expect(g.code).toBe(0);
  });

  test("the templates the repo ships name no event outside the rule", () => {
    const g = runGate({ SQUADS_DIR: path.join(os.tmpdir(), "nrv-absent-squads"), BUSINESSES_DIR: path.join(os.tmpdir(), "nrv-absent-biz") });
    expect(g.out).toContain("CONTENT the REPO owns");
    expect(g.out).toContain("(0 site(s) in 0 place(s))");
    expect(g.code).toBe(0);
  });

  test("an absent root is named as absent, never silently skipped", () => {
    const g = runGate({ SQUADS_DIR: path.join(os.tmpdir(), "nrv-absent-squads"), BUSINESSES_DIR: path.join(os.tmpdir(), "nrv-absent-biz") });
    expect(g.out).toContain("ABSENT — not scanned");
  });
});
