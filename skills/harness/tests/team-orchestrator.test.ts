// team-orchestrator.test.ts — the business chain: director, loop, handoff.
//
// This file did not exist. `runTeam` — chain selection, step sequencing, session
// threading, mandatory squads, `TeamResult` accumulation — had no coverage at
// all; only `buildStepBrief` was pinned, by scope-guard-travels.test.ts. Every
// behaviour of the loop itself was unprotected, which is why it is written
// before the loop is changed.
//
// Zero-token by construction: `runHeadlessImpl` cans the director and
// `runWithCascadeImpl` cans every step, the same seams squad-exec.test.ts uses.
// Runs with: bun test skills/harness/tests
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import { parseAuditLine } from "../../_shared/lib/cloudevents.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTeam, type TeamRunArgs } from "../lib/team-orchestrator.ts";

// Nothing here writes `process.env`. `bun test` shares one process across
// files, so an env write at module scope is a write into every other file's
// run: `BUSINESSES_DIR` here redirected the library out from under the pack
// tests, and `paths` memoizes on first access, so which file won depended on
// file order. Two arguments replace both writes — `businessesRoot` for the
// library, and a `.nirvana` marker in the fixture so `harnessLogsDir` resolves
// the audit into the fixture instead of the machine's real log directory.
let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-team-"));
  fs.mkdirSync(path.join(tmp, ".nirvana"), { recursive: true });
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** A business with N seats; the last one is the intake/synthesizer. */
function business(slug: string, seats: string[]): string {
  const dir = path.join(tmp, "businesses", slug);
  fs.mkdirSync(path.join(dir, "employees"), { recursive: true });
  fs.writeFileSync(path.join(dir, "business.yaml"), `name: ${slug}\ndescription: a business\n`, "utf8");
  seats.forEach((name, i) => {
    const intake = i === seats.length - 1 ? "is_brief_intake: true\n" : "";
    fs.writeFileSync(
      path.join(dir, "employees", `${name}.md`),
      `---\nname: ${name}\nrole: ${name} role\ndescription: The ${name} seat.\n${intake}---\n\n# ${name}\n\nMethod.\n`,
      "utf8",
    );
  });
  return dir;
}

/** A canned director that returns exactly this chain. */
function director(chain: Array<{ employee: string; task: string }>, reason?: string) {
  return ((opts: any) => ({
    ok: true, runtime: opts.runtime, sessionId: null,
    result: JSON.stringify(reason ? { reason, chain } : { chain }),
    costUsd: 0, exitCode: 0, stderr: "", durationMs: 1,
  })) as any;
}

/** A canned cascade. `failFor` names the employees whose step fails. */
function cascade(seen: any[], failFor: Set<string> = new Set()) {
  return ((opts: any) => {
    seen.push(opts);
    const who = String(opts.taskHint ?? "");
    const fails = [...failFor].some(f => who.includes(f));
    return {
      ok: !fails, runtime: opts.runtime, sessionId: "s1", result: fails ? "" : "did the work",
      costUsd: 0.01, exitCode: fails ? 1 : 0, stderr: "", durationMs: 5,
      handoffs: [], finalRuntime: opts.runtime, error: fails ? "boom" : undefined,
    };
  }) as any;
}

/** The run's own events.
 *
 *  Resolved through `harnessLogsDir`, never by rebuilding the path: the helper's
 *  order puts `$HARNESS_LOGS_DIR` ahead of the project, another file in this
 *  shared process sets it, and a hand-built path then reads an empty directory
 *  while the events are written somewhere else. Filtering by `project_id` is the
 *  other half — when that env does point everyone at one file, the events of
 *  every test land in it together. */
function readAudit(projectId: string): any[] {
  const day = new Date().toISOString().slice(0, 10);
  const p = path.join(harnessLogsDir({ cwd: tmp }), day, "audit.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean)
    .map(l => parseAuditLine(l))
    .filter(e => e?.project_id === projectId);
}

let runSeq = 0;
function args(slug: string, over: Partial<TeamRunArgs> = {}): TeamRunArgs {
  return {
    slug, brief: "monte o relatório", projectId: `proj-team-${++runSeq}`,
    projectDir: tmp, projectRoot: tmp, outputsRoot: path.join(tmp, "out"),
    businessesRoot: path.join(tmp, "businesses"),
    runtime: "claude-code", intakeEmployee: "synth",
    autonomousDirective: "D ",
    ...over,
  } as TeamRunArgs;
}

describe("runTeam — the chain the director chose", () => {
  test("runs every step in order and returns one result per step", () => {
    business("acme", ["researcher", "writer", "synth"]);
    const seen: any[] = [];
    const r = runTeam(args("acme", {
      runHeadlessImpl: director([
        { employee: "researcher", task: "pesquise" },
        { employee: "writer", task: "escreva" },
        { employee: "synth", task: "consolide" },
      ]),
      runWithCascadeImpl: cascade(seen),
    }));

    expect(r.ok).toBe(true);
    expect(r.chain.map(s => s.employee)).toEqual(["researcher", "writer", "synth"]);
    expect(r.steps.map(s => s.employee)).toEqual(["researcher", "writer", "synth"]);
    expect(seen).toHaveLength(3);
    // Cost and duration accumulate across the chain, not just the last step.
    expect(r.totalCostUsd).toBeCloseTo(0.03, 5);
    expect(r.totalDurationMs).toBe(15);
  });

  test("the synthesizer is forced last even when the director forgets it", () => {
    business("acme", ["researcher", "synth"]);
    const r = runTeam(args("acme", {
      runHeadlessImpl: director([{ employee: "researcher", task: "pesquise" }]),
      runWithCascadeImpl: cascade([]),
    }));
    expect(r.chain[r.chain.length - 1].employee).toBe("synth");
  });

  test("a seat the business does not have is dropped, not dispatched", () => {
    business("acme", ["researcher", "synth"]);
    const seen: any[] = [];
    runTeam(args("acme", {
      runHeadlessImpl: director([
        { employee: "ghost", task: "não existe" },
        { employee: "researcher", task: "pesquise" },
        { employee: "synth", task: "consolide" },
      ]),
      runWithCascadeImpl: cascade(seen),
    }));
    expect(seen).toHaveLength(2);
    expect(seen.some(o => String(o.taskHint).includes("ghost"))).toBe(false);
  });

  test("a one-seat business skips the director entirely", () => {
    business("solo", ["synth"]);
    const seen: any[] = [];
    const r = runTeam(args("solo", {
      // A director that would throw proves it is never consulted.
      runHeadlessImpl: (() => { throw new Error("director must not run for a one-seat business"); }) as any,
      runWithCascadeImpl: cascade(seen),
    }));
    expect(r.ok).toBe(true);
    expect(r.chain).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });
});

describe("runTeam — the director decides how many seats", () => {
  test("one step is a valid answer, and it runs as one step", () => {
    business("acme", ["researcher", "writer", "synth"]);
    const seen: any[] = [];
    const a = args("acme", {
      runHeadlessImpl: director([{ employee: "synth", task: "faça inteiro" }], "o brief é uma página, não precisa de repasse"),
      runWithCascadeImpl: cascade(seen),
    });
    const r = runTeam(a);

    expect(r.ok).toBe(true);
    expect(r.chain).toHaveLength(1);
    expect(seen).toHaveLength(1);
    // A three-seat company that ran as one because the brief did not need more
    // is a decision. It owes a reason, and the reason is in the log.
    const shape = readAudit(a.projectId).find(e => e.event === "x_chain_shape_decided");
    expect(shape?.steps).toBe(1);
    expect(shape?.reason).toBe("o brief é uma página, não precisa de repasse");
    expect(shape?.forced).toBe("auto");
  });

  test("a one-seat business says so, rather than leaving the cost unexplained", () => {
    business("solo", ["synth"]);
    const a = args("solo", {
      runHeadlessImpl: (() => { throw new Error("director must not run for a one-seat business"); }) as any,
      runWithCascadeImpl: cascade([]),
    });
    runTeam(a);
    const shape = readAudit(a.projectId).find(e => e.event === "x_chain_shape_decided");
    expect(shape?.steps).toBe(1);
    expect(shape?.reason).toMatch(/single seat/);
  });

  test("--team asks for a chain; without it the count is the director's call", () => {
    business("acme", ["researcher", "writer", "synth"]);
    const prompts: string[] = [];
    const spy = ((opts: any) => {
      prompts.push(String(opts.prompt));
      return { ok: true, result: JSON.stringify({ chain: [{ employee: "synth", task: "t" }] }), costUsd: 0, exitCode: 0, stderr: "", durationMs: 1, sessionId: null };
    }) as any;

    runTeam(args("acme", { forceChain: true, runHeadlessImpl: spy, runWithCascadeImpl: cascade([]) }));
    expect(prompts[0]).toContain("Include 3 to 6 employees");

    runTeam(args("acme", { runHeadlessImpl: spy, runWithCascadeImpl: cascade([]) }));
    expect(prompts[1]).not.toContain("Include 3 to 6 employees");
    // The default asks WHOSE JOB it is, not who is capable. The distinction is
    // the whole rule: the same model sits in every chair, so "the synthesizer
    // could do this" is always true and collapsed every chain to one seat.
    expect(prompts[1]).toContain("THE ORG CHART IS THE CONTRACT");
    expect(prompts[1]).toContain("whose JOB it is");
    // And why skipping a seat is not merely a shortcut: it deletes the persona.
    expect(prompts[1]).toContain("personas are ranked against the SEAT'S task");
  });
});

describe("runTeam — what each step is told", () => {
  test("a later step is handed where the earlier ones wrote", () => {
    business("acme", ["researcher", "synth"]);
    const seen: any[] = [];
    runTeam(args("acme", {
      runHeadlessImpl: director([
        { employee: "researcher", task: "pesquise" },
        { employee: "synth", task: "consolide" },
      ]),
      runWithCascadeImpl: cascade(seen),
    }));
    const synthPrompt = String(seen[1].prompt);
    expect(synthPrompt).toContain("researcher");
    expect(synthPrompt).toContain(path.join("_team", "researcher"));
  });

  test("each step writes under _team, and the last writes to the outputs root", () => {
    business("acme", ["researcher", "synth"]);
    const seen: any[] = [];
    runTeam(args("acme", {
      runHeadlessImpl: director([
        { employee: "researcher", task: "pesquise" },
        { employee: "synth", task: "consolide" },
      ]),
      runWithCascadeImpl: cascade(seen),
    }));
    expect(seen[0].outputsRoot).toBe(path.join(tmp, "out", "_team", "researcher"));
    expect(seen[1].outputsRoot).toBe(path.join(tmp, "out"));
  });
});

describe("runTeam — the audit chain", () => {
  test("the director's choice and every step are recorded", () => {
    business("acme", ["researcher", "synth"]);
    const a = args("acme", {
      runHeadlessImpl: director([
        { employee: "researcher", task: "pesquise" },
        { employee: "synth", task: "consolide" },
      ]),
      runWithCascadeImpl: cascade([]),
    });
    runTeam(a);
    const ev = readAudit(a.projectId);
    expect(ev.find(e => e.event === "team_director_called")).toBeTruthy();

    const chosen = ev.find(e => e.event === "team_chain_selected");
    expect(chosen?.chain?.map((c: any) => c.employee)).toEqual(["researcher", "synth"]);

    // One dispatch_business per step, numbered, so a reader can tell position.
    const dispatched = ev.filter(e => e.event === "dispatch_business" && e.mode === "team-step");
    expect(dispatched.map(e => e.step)).toEqual([1, 2]);
    expect(dispatched.every(e => e.total === 2)).toBe(true);

    expect(ev.filter(e => e.event === "agent_executed")).toHaveLength(2);
    expect(ev.find(e => e.event === "team_completed")?.steps).toBe(2);
  });

  test("a director that returns nothing usable fails the run loudly", () => {
    business("acme", ["researcher", "synth"]);
    const a = args("acme", {
      runHeadlessImpl: (() => ({ ok: true, result: "sorry, no JSON here", costUsd: 0, exitCode: 0, stderr: "", durationMs: 1, sessionId: null })) as any,
      runWithCascadeImpl: cascade([]),
    });
    const r = runTeam(a);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/director/);
    expect(readAudit(a.projectId).find(e => e.event === "team_director_failed")).toBeTruthy();
  });
});

describe("runTeam — a step that fails does not take the chain with it", () => {
  const threeStep = () => director([
    { employee: "researcher", task: "pesquise" },
    { employee: "writer", task: "escreva" },
    { employee: "synth", task: "consolide" },
  ]);

  test("it is retried once, then the chain goes on and the synthesizer still runs", () => {
    business("acme", ["researcher", "writer", "synth"]);
    const seen: any[] = [];
    const a = args("acme", { runHeadlessImpl: threeStep(), runWithCascadeImpl: cascade(seen, new Set(["writer"])) });
    const r = runTeam(a);

    // Four dispatches: researcher, writer twice, synthesizer. The chain used to
    // stop at the second, stranding the researcher's work with nothing to
    // consolidate it.
    expect(seen).toHaveLength(4);
    expect(seen.filter(o => String(o.taskHint).includes("writer"))).toHaveLength(2);
    expect(seen.some(o => String(o.taskHint).includes("synth"))).toBe(true);

    expect(r.ok).toBe(true);
    expect(r.steps.find(s => s.employee === "writer")?.attempts).toBe(2);
    expect(r.steps.find(s => s.employee === "writer")?.failed).toMatch(/2 attempts/);
    expect(r.gaps.map(g => g.employee)).toEqual(["writer"]);

    const ev = readAudit(a.projectId);
    expect(ev.find(e => e.event === "x_chain_step_retried")?.employee).toBe("writer");
    expect(ev.find(e => e.event === "x_chain_gap")?.attempts).toBe(2);
    expect(ev.find(e => e.event === "team_completed")?.gaps).toEqual(["writer"]);
  });

  test("the synthesizer is told what never arrived, and told to record it", () => {
    business("acme", ["researcher", "writer", "synth"]);
    const seen: any[] = [];
    runTeam(args("acme", { runHeadlessImpl: threeStep(), runWithCascadeImpl: cascade(seen, new Set(["writer"])) }));

    const synthPrompt = String(seen[seen.length - 1].prompt);
    expect(synthPrompt).toContain("## What never arrived");
    expect(synthPrompt).toContain("writer");
    expect(synthPrompt).toContain("escreva");
    // Naming the gap is half of it; the delivery has to carry it too, or the
    // person reading the outputs never learns a seat went missing.
    expect(synthPrompt).toContain("_QA-RESERVATIONS.md");
    // And the colleague that DID deliver is still handed over as before.
    expect(synthPrompt).toContain(path.join("_team", "researcher"));
  });

  test("nothing downstream can cover for the synthesizer, so its failure is the run's", () => {
    business("acme", ["researcher", "synth"]);
    const seen: any[] = [];
    const r = runTeam(args("acme", {
      runHeadlessImpl: director([
        { employee: "researcher", task: "pesquise" },
        { employee: "synth", task: "consolide" },
      ]),
      runWithCascadeImpl: cascade(seen, new Set(["synth"])),
    }));

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/step 2/);
    expect(seen.filter(o => String(o.taskHint).includes("synth"))).toHaveLength(2);
  });
});
