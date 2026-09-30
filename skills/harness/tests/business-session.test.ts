// business-session.test.ts — a business run as one session, its seats as subagents.
//
// Hermetic: a fixture business on disk, a canned cascade runner in place of a
// runtime, the real hook script fed a canned payload, and a fake `claude` on a
// temp PATH for the one driver flag. No LLM, no network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildSessionBrief, creditSessionSeats, doneCriteriaFrom, isBusinessSession, participationFile, readSeats,
  runBusinessSession, sessionDirective, sessionGrants, type BusinessSessionArgs,
} from "../lib/business-session.ts";
import { attributeSeat } from "../../_shared/lib/seat-attribution.ts";
import { stamp } from "../../_shared/lib/audit-provenance.ts";
import { resolveSetting } from "../../_shared/lib/settings.ts";
import { runHeadless } from "../../_shared/lib/host-agent-driver.ts";
import { CAPTURE_PRELUDE, readCapturedArgs, writeFakeCli } from "./helpers/fake-cli.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-business-session-"));
const BIZ = path.join(TMP, "businesses", "acme-launch");
const PROJECT_ROOT = path.join(TMP, "project");
const PROJECT_DIR = path.join(PROJECT_ROOT, "runs", "p-1");
const OUTPUTS = path.join(PROJECT_DIR, "deliverables");
const HOOK = path.join(import.meta.dir, "..", "..", "_shared", "scripts", "audit-emit-from-hook.ts");
const SEAT_BODY_SENTINEL = "SEAT-BODY-NEVER-PASTED";

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function seatFile(name: string, fm: string): void {
  write(path.join(BIZ, "employees", `${name}.md`), `---\nname: ${name}\n${fm}\n---\n\n# ${name}\n\n${SEAT_BODY_SENTINEL}\n`);
}

beforeAll(() => {
  write(path.join(BIZ, "business.yaml"), "name: acme-launch\nversion: 1.0.0\nprotocol: '2.0'\ndescription: A fixture business that launches online courses.\ndomains: [launch]\n");
  write(path.join(BIZ, "org-chart.yaml"), "chart:\n  - employee: al-ceo\n    reports: []\n    direct_reports: [al-copy, al-qa]\n  - employee: al-copy\n    reports: [al-ceo]\n    direct_reports: []\n  - employee: al-qa\n    reports: [al-ceo]\n    direct_reports: []\n");
  seatFile("al-ceo", "role: Chief executive\nis_brief_intake: true\npinned_mind_clones: [founder-voice]\ndescription: Takes the request in and signs the launch.");
  seatFile("al-copy", "role: Copy chief\nreports_to: al-ceo\nassigned_mind_clones: [21-copy/copy-legend]\nsquads_authorized: [email-squad]\ndescription: Writes every word of the launch.");
  // No reports_to in the frontmatter: the org chart supplies it.
  seatFile("al-qa", "role: Quality\nsquads_authorized: []\ndescription: Checks the launch before it ships.");
  fs.mkdirSync(OUTPUTS, { recursive: true });
});

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

const lookup = (slug: string) => slug === "copy-legend"
  ? { dir: path.join(TMP, "clones", "copy-legend"), files: [path.join(TMP, "clones", "copy-legend", "agent", "AGENT.md")] }
  : null;
const squadDirOf = (slug: string) => path.join(TMP, "squads", slug);

function baseArgs(extra: Partial<BusinessSessionArgs> = {}): BusinessSessionArgs {
  return {
    slug: "acme-launch", bizDir: BIZ, brief: "Launch a phone photography course under R$ 497: course design, offer, four emails and the sales video script.",
    projectId: "p-1", projectDir: PROJECT_DIR, projectRoot: PROJECT_ROOT, outputsRoot: OUTPUTS, runtime: "claude-code",
    cloneLookup: lookup, squadDirOf, memoryDirs: [path.join(TMP, "memory", "acme-launch")],
    ...extra,
  };
}

describe("the team, read from the seats' own files", () => {
  test("every seat, with its file, role, superior, voices and squads", () => {
    const seats = readSeats(BIZ, lookup);
    expect(seats.map((s) => s.slug)).toEqual(["al-ceo", "al-copy", "al-qa"]);
    const [ceo, copy, qa] = seats;
    expect(ceo.file).toBe(path.join(BIZ, "employees", "al-ceo.md"));
    expect(ceo.intake).toBeTrue();
    expect(ceo.reportsTo).toBeNull();
    expect(ceo.voices).toEqual([{ slug: "founder-voice", dir: null, files: [] }]);
    expect(copy.role).toBe("Copy chief");
    expect(copy.reportsTo).toBe("al-ceo");
    expect(copy.voices[0].slug).toBe("copy-legend");
    expect(copy.squads).toEqual(["email-squad"]);
    expect(qa.reportsTo).toBe("al-ceo");
    // Business Protocol v2 §6.10: an empty list means every squad.
    expect(qa.squads).toBeNull();
  });
});

describe("the brief points, it does not paste", () => {
  const seats = () => readSeats(BIZ, lookup);

  test("the request verbatim, the business folder, the memory and every seat by its file", () => {
    const args = baseArgs();
    const brief = buildSessionBrief(args, seats(), args.memoryDirs!, squadDirOf);
    expect(brief).toContain(args.brief);
    expect(brief).toContain(BIZ);
    expect(brief).toContain(args.memoryDirs![0]);
    for (const s of seats()) expect(brief).toContain(s.file);
    expect(brief).toContain("reports to `al-ceo`");
    expect(brief).toContain(path.join(TMP, "clones", "copy-legend", "agent", "AGENT.md"));
    expect(brief).toContain("`founder-voice` (not installed)");
    expect(brief).toContain("squads: `email-squad`");
    // The seat is a path; what it says is read by the session when it needs it.
    expect(brief).not.toContain(SEAT_BODY_SENTINEL);
  });

  test("the rules of the job are result-level and all present", () => {
    const args = baseArgs();
    const brief = buildSessionBrief(args, seats(), [], squadDirOf);
    expect(brief).toContain("the whole request and nothing outside it");
    expect(brief).toContain("never widen what was asked");
    expect(brief).toContain("only the seats this request needs");
    expect(brief).toContain("as a subagent of your runtime");
    expect(brief).toContain("Start its prompt with its seat file path");
    expect(brief).toContain("Wait until every subagent has finished");
    expect(brief).toContain(OUTPUTS);
    expect(brief).toContain(participationFile(PROJECT_DIR));
    expect(brief).toContain("summary naming the same seats, squads and clones");
    expect(brief).toContain("language of the request");
  });

  test("support squads come with the division of labour, and none are invented", () => {
    const withSquads = buildSessionBrief(baseArgs({ mandatorySquads: ["course-architect"], optionalSquads: ["vsl-squad"] }), seats(), [], squadDirOf);
    expect(withSquads).toContain("`course-architect` (`" + squadDirOf("course-architect") + "`)");
    expect(withSquads).toContain("a seat uses it");
    expect(withSquads).toContain("`vsl-squad`");
    expect(withSquads).toContain("Nobody redoes the squad's work, and the squad does not redo the seats'");
    const without = buildSessionBrief(baseArgs(), seats(), [], squadDirOf);
    expect(without).not.toContain("Squads for this request");
  });

  test("done criteria: the router's when it gave them, the seats' acceptance otherwise", () => {
    const routed = buildSessionBrief(baseArgs({ doneCriteria: ["Four emails, one per launch day"] }), seats(), [], squadDirOf);
    expect(routed).toContain("- Four emails, one per launch day");
    expect(routed).not.toContain("`acceptance` items");
    const unrouted = buildSessionBrief(baseArgs(), seats(), [], squadDirOf);
    expect(unrouted).toContain("`acceptance` items in its own file");
  });

  test("the router's done criteria are read when present and never required", () => {
    expect(doneCriteriaFrom({ done: ["a", " ", "b"] })).toEqual(["a", "b"]);
    expect(doneCriteriaFrom({ done: "one line" })).toEqual(["one line"]);
    expect(doneCriteriaFrom({ primary_business: "x" })).toEqual([]);
    expect(doneCriteriaFrom(null)).toEqual([]);
  });

  test("the directive keeps the premises and drops the pipe-a-colleague delegation", () => {
    const d = sessionDirective("\nRULE: X");
    expect(d).not.toContain("employee-prompt.ts");
    expect(d).toContain("NOTHING HALF-BAKED");
    expect(d).toContain("HEADLESS SESSION LIFETIME");
    expect(d.endsWith("RULE: X")).toBeTrue();
  });
});

describe("grants", () => {
  test("the run, the business, the seats' voices, the squads and the memory, once each", () => {
    const args = baseArgs({ mandatorySquads: ["course-architect"], optionalSquads: ["course-architect", "vsl-squad"] });
    const dirs = sessionGrants(args, readSeats(BIZ, lookup), args.memoryDirs!, squadDirOf);
    for (const d of [PROJECT_DIR, OUTPUTS, BIZ, path.join(TMP, "clones", "copy-legend"), squadDirOf("course-architect"), squadDirOf("vsl-squad"), args.memoryDirs![0]]) {
      expect(dirs).toContain(path.resolve(d));
    }
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});

describe("the run", () => {
  function capture(runtime: BusinessSessionArgs["runtime"]) {
    const calls: any[] = [];
    const events: { event: string; payload: Record<string, unknown> }[] = [];
    const r = runBusinessSession(baseArgs({
      runtime,
      emit: (event, payload) => events.push({ event, payload }),
      runWithCascadeImpl: ((a: any) => {
        calls.push(a);
        return { ok: true, runtime, sessionId: "s-1", result: "done", costUsd: 0.5, exitCode: 0, stderr: "", durationMs: 10, handoffs: [], finalRuntime: runtime };
      }) as any,
    }));
    return { r, call: calls[0], calls, events };
  }

  test("one dispatch, as the business, and the only one that keeps its subagents", () => {
    const { call, calls } = capture("claude-code");
    expect(calls.length).toBe(1);
    expect(call.dispatchRole).toBe("business");
    expect(call.allowSubagents).toBeTrue();
    expect(call.cwd).toBe(PROJECT_ROOT);
    expect(call.addDirs).toContain(path.resolve(BIZ));
    expect(call.appendSystemPrompt).not.toContain("employee-prompt.ts");
    expect(call.prompt).toContain("# Business session: acme-launch");
    expect(fs.readFileSync(path.join(PROJECT_DIR, "session-brief.md"), "utf8")).toBe(call.prompt);
  });

  test("on claude-code the seat hook is registered for this run only", () => {
    const { call } = capture("claude-code");
    expect(typeof call.settingsFile).toBe("string");
    const settings = JSON.parse(fs.readFileSync(call.settingsFile, "utf8"));
    const entry = settings.hooks.PostToolUse[0];
    expect(entry.matcher).toBe("Agent|Task");
    expect(entry.hooks[0].command).toContain("audit-emit-from-hook.ts");
    expect(entry.hooks[0].command).toContain("--seats");
    const seatsFile = JSON.parse(entry.hooks[0].command.match(/--seats (".*")$/)![1]);
    const spec = JSON.parse(fs.readFileSync(seatsFile, "utf8"));
    expect(spec.trace_id).toBe("p-1");
    expect(spec.seats.map((s: any) => s.slug)).toEqual(["al-ceo", "al-copy", "al-qa"]);
  });

  test("a runtime without the hook gets no settings and credits by declaration", () => {
    const { call, events } = capture("codex");
    expect(call.settingsFile).toBeUndefined();
    const started = events.find((e) => e.event === "x_business_session_started")!;
    expect(started.payload.seat_evidence).toBe("declared");
  });

  test("the run is audited: started, the receipt, and agent_executed in session mode", () => {
    const { events } = capture("claude-code");
    const names = events.map((e) => e.event);
    expect(names).toContain("x_business_session_started");
    expect(names).toContain("x_business_session_receipt");
    const done = events.find((e) => e.event === "agent_executed")!;
    expect(done.payload.mode).toBe("business-session");
    expect(done.payload.employee).toBeUndefined();
  });
});

describe("which seat a subagent worked as", () => {
  const seats = [
    { slug: "al-ceo", file: "/biz/employees/al-ceo.md" },
    { slug: "al-copy", file: "/biz/employees/al-copy.md" },
    { slug: "al-qa", file: "/biz/employees/al-qa.md" },
  ];

  test("by its file, the earliest named when several are", () => {
    expect(attributeSeat({ prompt: "Your seat: /biz/employees/al-copy.md. Build on the CEO in /biz/employees/al-ceo.md." }, seats))
      .toEqual({ seat: "al-copy", by: "file" });
    expect(attributeSeat({ prompt: "Read employees/al-qa.md first." }, seats)).toEqual({ seat: "al-qa", by: "file" });
  });

  test("by subagent type, then by a single slug", () => {
    expect(attributeSeat({ subagent_type: "al-qa", prompt: "check it" }, seats)).toEqual({ seat: "al-qa", by: "type" });
    expect(attributeSeat({ description: "al-copy writes the emails" }, seats)).toEqual({ seat: "al-copy", by: "slug" });
  });

  test("an ambiguous call stays unattributed rather than credited to the wrong seat", () => {
    expect(attributeSeat({ prompt: "al-copy and al-qa together" }, seats)).toEqual({ seat: null, by: null, candidates: ["al-copy", "al-qa"] });
    expect(attributeSeat({ prompt: "write something" }, seats)).toEqual({ seat: null, by: null });
    // A longer slug is not its prefix.
    expect(attributeSeat({ prompt: "al-copy-assistant" }, seats)).toEqual({ seat: null, by: null });
  });

  test("the hook records a subagent call against its seat, on the run's trace", () => {
    const logs = fs.mkdtempSync(path.join(TMP, "hook-logs-"));
    const seatsFile = path.join(TMP, "seats.json");
    write(seatsFile, JSON.stringify({ trace_id: "p-hook", project_root: PROJECT_ROOT, business_slug: "acme-launch", seats }));
    const payload = { session_id: "sess-9", tool_name: "Agent", tool_input: { description: "Copy chief", prompt: "Seat file: /biz/employees/al-copy.md. Write the four emails." }, tool_response: { success: true } };
    const r = spawnSync("bun", [HOOK, "post", "claude-code", "--seats", seatsFile], {
      input: JSON.stringify(payload), encoding: "utf8", cwd: TMP, env: { ...process.env, HARNESS_LOGS_DIR: logs },
    });
    expect(r.status).toBe(0);
    const day = fs.readdirSync(logs).find((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))!;
    const lines = fs.readFileSync(path.join(logs, day, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const ev = lines.find((e) => e.event === "x_seat_subagent");
    expect(ev).toBeDefined();
    expect(ev.seat).toBe("al-copy");
    expect(ev.matched_by).toBe("file");
    expect(ev.trace_id).toBe("p-hook");
    expect(ev.runtime).toBe("claude-code");
    expect(ev.session_id).toBe("sess-9");
  }, spawnBudgetMs(1));

  test("without --seats the hook still ignores subagent calls", () => {
    const logs = fs.mkdtempSync(path.join(TMP, "hook-quiet-"));
    const payload = { session_id: "sess-1", tool_name: "Agent", tool_input: { prompt: "x" } };
    const r = spawnSync("bun", [HOOK, "post", "claude-code"], {
      input: JSON.stringify(payload), encoding: "utf8", cwd: TMP, env: { ...process.env, HARNESS_LOGS_DIR: logs },
    });
    expect(r.status).toBe(0);
    expect(fs.readdirSync(logs).length).toBe(0);
  }, spawnBudgetMs(1));
});

describe("crediting the seats", () => {
  const logsDir = () => process.env.HARNESS_LOGS_DIR!;
  function appendAudit(ev: Record<string, unknown>, signed = true): void {
    const dir = path.join(logsDir(), new Date().toISOString().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    const line = signed ? stamp({ ts: new Date().toISOString(), ...ev }) : { ts: new Date().toISOString(), ...ev };
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify(line) + "\n");
  }

  test("recorded beats declared, declared is marked, and an unsigned line counts for nothing", () => {
    const projectDir = fs.mkdtempSync(path.join(TMP, "credit-"));
    const since = Date.now() - 1000;
    appendAudit({ event: "x_seat_subagent", trace_id: "p-credit", seat: "al-copy" });
    appendAudit({ event: "x_seat_subagent", trace_id: "p-credit", seat: "al-copy" });
    appendAudit({ event: "x_seat_subagent", trace_id: "p-credit", seat: null, candidates: ["al-copy", "al-qa"] });
    appendAudit({ event: "x_seat_subagent", trace_id: "p-credit", seat: "al-qa" }, false);
    appendAudit({ event: "x_seat_subagent", trace_id: "p-other", seat: "al-qa" });
    write(participationFile(projectDir), JSON.stringify({ seats: [
      { seat: "al-ceo", how: "self" }, { seat: "al-copy", how: "subagent" }, { seat: "al-qa", how: "subagent" }, { seat: "ghost-seat", how: "subagent" },
    ] }));
    const r = creditSessionSeats({ projectId: "p-credit", projectRoot: PROJECT_ROOT, projectDir, runtime: "claude-code", seats: readSeats(BIZ, lookup), sinceMs: since });
    expect(r.credited).toEqual([
      { seat: "al-ceo", evidence: "declared", how: "self" },
      { seat: "al-copy", evidence: "recorded", subagents: 2, how: "subagent" },
      { seat: "al-qa", evidence: "declared", how: "subagent" },
    ]);
    expect(r.subagents).toBe(3);
    expect(r.unattributed).toBe(1);
    expect(r.notCounted).toBe(1);
    // On a runtime with the hook, a declared subagent nothing recorded is named.
    expect(r.declaredNotRecorded).toEqual(["al-qa"]);
    expect(r.unknownDeclared).toEqual(["ghost-seat"]);
  });

  test("on a runtime without the hook, a declaration is the evidence and says so", () => {
    const projectDir = fs.mkdtempSync(path.join(TMP, "credit-codex-"));
    write(participationFile(projectDir), JSON.stringify({ seats: ["al-copy", { seat: "al-qa", how: "subagent" }] }));
    const r = creditSessionSeats({ projectId: "p-codex", projectRoot: PROJECT_ROOT, projectDir, runtime: "codex", seats: readSeats(BIZ, lookup), sinceMs: Date.now() });
    expect(r.credited).toEqual([{ seat: "al-copy", evidence: "declared" }, { seat: "al-qa", evidence: "declared", how: "subagent" }]);
    expect(r.declaredNotRecorded).toEqual([]);
  });

  test("no record and no declaration credits nobody", () => {
    const projectDir = fs.mkdtempSync(path.join(TMP, "credit-none-"));
    const r = creditSessionSeats({ projectId: "p-none", projectRoot: PROJECT_ROOT, projectDir, runtime: "claude-code", seats: readSeats(BIZ, lookup), sinceMs: Date.now() });
    expect(r.credited).toEqual([]);
  });

  test("a participation file left by an earlier run is removed before the session starts", () => {
    write(participationFile(PROJECT_DIR), JSON.stringify({ seats: ["al-ceo"] }));
    let seen: boolean | null = null;
    runBusinessSession(baseArgs({
      runtime: "codex",
      runWithCascadeImpl: (() => {
        seen = fs.existsSync(participationFile(PROJECT_DIR));
        return { ok: true, runtime: "codex", sessionId: null, result: "", costUsd: null, exitCode: 0, stderr: "", durationMs: 1, handoffs: [], finalRuntime: "codex" };
      }) as any,
    }));
    expect(seen).toBe(false);
  });
});

describe("the mode is opt-in and the chain is unchanged", () => {
  test("the default is chain", () => {
    const saved = process.env.NIRVANA_BUSINESS_MODE;
    delete process.env.NIRVANA_BUSINESS_MODE;
    try { expect(resolveSetting("execution.business_mode").value).toBe("chain"); }
    finally { if (saved !== undefined) process.env.NIRVANA_BUSINESS_MODE = saved; }
  });

  test("only the setting turns it on, and anything the user said about the shape turns it off", () => {
    const base = { forceTeam: false, forceSingle: false, requestedMode: "standard", businessMode: "session" };
    expect(isBusinessSession(base)).toBeTrue();
    expect(isBusinessSession({ ...base, businessMode: "chain" })).toBeFalse();
    expect(isBusinessSession({ ...base, forceTeam: true })).toBeFalse();
    expect(isBusinessSession({ ...base, forceSingle: true })).toBeFalse();
    expect(isBusinessSession({ ...base, requestedMode: "gauntlet" })).toBeFalse();
  });
});

describe("the driver passes the run's own settings to claude", () => {
  const BIN = path.join(TMP, "bin");
  const CAP = path.join(TMP, "capture");
  const SAVED: Record<string, string | undefined> = {};
  const MANAGED = ["PATH", "FAKE_CAPTURE_DIR", "NIRVANA_MODEL", "ANTHROPIC_MODEL", "CLAUDE_CONFIG_DIR"];
  beforeAll(() => {
    for (const k of MANAGED) SAVED[k] = process.env[k];
    fs.mkdirSync(CAP, { recursive: true });
    delete process.env.NIRVANA_MODEL;
    delete process.env.ANTHROPIC_MODEL;
    process.env.CLAUDE_CONFIG_DIR = path.join(TMP, "claude-config");
    process.env.PATH = `${BIN}${path.delimiter}${SAVED.PATH ?? ""}`;
    process.env.FAKE_CAPTURE_DIR = CAP;
    writeFakeCli(BIN, "claude", CAPTURE_PRELUDE + `fs.writeFileSync(path.join(captureDir!, "role.txt"), process.env.NIRVANA_DISPATCH_ROLE ?? ""); await stdinLen(); process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s1", total_cost_usd: 0 }));`);
  });
  afterAll(() => { for (const k of MANAGED) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });

  test("--settings with the file, no deny when subagents are allowed, and the child is stamped as the business", () => {
    const r = runHeadless({ runtime: "claude-code", prompt: "run", cwd: TMP, timeoutMs: 20_000, allowSubagents: true, settingsFile: "/x/settings.json", dispatchRole: "business" });
    expect(r.ok, r.error ?? r.stderr).toBeTrue();
    const a = readCapturedArgs(CAP, "claude");
    const i = a.indexOf("--settings");
    expect(a[i + 1]).toBe("/x/settings.json");
    expect(a).not.toContain("--disallowedTools");
    expect(fs.readFileSync(path.join(CAP, "role.txt"), "utf8")).toBe("business");
  }, spawnBudgetMs(1));

  test("no settings file, no flag; a worker keeps the deny", () => {
    const r = runHeadless({ runtime: "claude-code", prompt: "run", cwd: TMP, timeoutMs: 20_000 });
    expect(r.ok, r.error ?? r.stderr).toBeTrue();
    const a = readCapturedArgs(CAP, "claude");
    expect(a).not.toContain("--settings");
    expect(a).toContain("--disallowedTools");
  }, spawnBudgetMs(1));
});
