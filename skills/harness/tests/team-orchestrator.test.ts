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

describe("runTeam — the director narrated instead of answering", () => {
  // meridian-advisory, 2026-09-18, 16 seats: the director decided well and then
  // reported the decision in prose, twice, in auto and under --team. Its own
  // second answer claimed it had "returned the chain as a single JSON object".
  // An agent with tools treats the final message as a report of work done, so
  // this is a live failure mode and not a prompt typo — and the whole run
  // collapsed to one seat because of a missing envelope around a good plan.
  const PROSE = [
    "Cadeia de 5 empregados definida para o diagnóstico",
    "Atuei como diretor de orquestração e devolvi a cadeia como um único objeto JSON,",
    "sem arquivos criados: researcher (pesquisa), writer (redação), synth (consolidação).",
  ].join("\n");

  /** Prose first, then whatever the re-ask gets. */
  function narrator(secondAnswer: string) {
    const prompts: string[] = [];
    const impl = ((opts: any) => {
      prompts.push(String(opts.prompt ?? ""));
      return {
        ok: true, runtime: opts.runtime, sessionId: null,
        result: prompts.length === 1 ? PROSE : secondAnswer,
        costUsd: 0, exitCode: 0, stderr: "", durationMs: 1,
      };
    }) as any;
    return { impl, prompts };
  }

  test("one re-ask recovers the plan, and the chain is the one it had decided", () => {
    business("acme", ["researcher", "writer", "synth"]);
    const seen: any[] = [];
    const n = narrator(JSON.stringify({ reason: "three seats", chain: [
      { employee: "researcher", task: "pesquise" }, { employee: "writer", task: "escreva" }, { employee: "synth", task: "consolide" },
    ] }));
    const a = args("acme", { runHeadlessImpl: n.impl, runWithCascadeImpl: cascade(seen) });
    const r = runTeam(a);
    expect(r.ok).toBe(true);
    expect(r.chain.map(s => s.employee)).toEqual(["researcher", "writer", "synth"]);
    expect(n.prompts.length).toBe(2);
  });

  test("the re-ask asks for transcription, never for a new decision, and carries the answer back", () => {
    business("acme", ["researcher", "writer", "synth"]);
    const n = narrator(JSON.stringify({ chain: [{ employee: "synth", task: "faça" }] }));
    runTeam(args("acme", { runHeadlessImpl: n.impl, runWithCascadeImpl: cascade([]) }));
    const reask = n.prompts[1];
    expect(reask).toContain("Transcribe the decision you ALREADY made");
    expect(reask).toContain("Do not decide again");
    expect(reask).toContain("devolvi a cadeia como um único objeto JSON");
    for (const seat of ["researcher", "writer", "synth"]) expect(reask).toContain(`- ${seat}`);
    // No tools and no directories: there is nothing for it to report on.
    expect(reask.length).toBeLessThan(n.prompts[0].length);
  });

  test("the re-ask is recorded, so a narrating seat is visible instead of silently costing a turn", () => {
    business("acme", ["researcher", "writer", "synth"]);
    const n = narrator(JSON.stringify({ chain: [{ employee: "synth", task: "faça" }] }));
    const a = args("acme", { runHeadlessImpl: n.impl, runWithCascadeImpl: cascade([]) });
    runTeam(a);
    const ev = readAudit(a.projectId).find(e => e.event === "x_director_reask");
    expect(ev).toBeDefined();
    expect(ev.business_slug).toBe("acme");
    expect(ev.reason).toBe("no_json_object_in_answer");
  });

  test("prose twice still fails, and says both attempts were spent", () => {
    business("acme", ["researcher", "writer", "synth"]);
    const n = narrator(PROSE);
    const a = args("acme", { runHeadlessImpl: n.impl, runWithCascadeImpl: cascade([]) });
    const r = runTeam(a);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("none after one re-ask");
    expect(n.prompts.length).toBe(2);
    expect(readAudit(a.projectId).some(e => e.event === "team_director_failed")).toBe(true);
  });

  test("a director that answers with JSON the first time is never re-asked", () => {
    business("acme", ["researcher", "writer", "synth"]);
    let calls = 0;
    const impl = ((opts: any) => {
      calls++;
      return { ok: true, runtime: opts.runtime, sessionId: null, result: JSON.stringify({ chain: [{ employee: "synth", task: "faça" }] }), costUsd: 0, exitCode: 0, stderr: "", durationMs: 1 };
    }) as any;
    const a = args("acme", { runHeadlessImpl: impl, runWithCascadeImpl: cascade([]) });
    runTeam(a);
    expect(calls).toBe(1);
    expect(readAudit(a.projectId).some(e => e.event === "x_director_reask")).toBe(false);
  });

  // The re-ask transcribes a decision. A call that failed or answered nothing
  // made none, and asking again only spent another two minutes on the way to
  // the same failure.
  test.each([
    ["a call that failed", { ok: false, result: "", error: "timed out after 300000ms", exitCode: 124 }, "timed out"],
    ["an empty answer", { ok: true, result: "   ", exitCode: 0 }, "empty answer"],
  ])("%s is not re-asked, and the real reason travels", (_label, answer, reason) => {
    business("acme", ["researcher", "writer", "synth"]);
    let calls = 0;
    const impl = ((opts: any) => {
      calls++;
      return { runtime: opts.runtime, sessionId: null, costUsd: 0, stderr: "", durationMs: 1, ...answer };
    }) as any;
    const a = args("acme", { runHeadlessImpl: impl, runWithCascadeImpl: cascade([]) });
    const r = runTeam(a);
    expect(calls).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.steps).toHaveLength(0);
    expect(String(r.error)).toStartWith("director:");
    expect(String(r.error)).toContain(reason);
    expect(readAudit(a.projectId).some(e => e.event === "x_director_reask")).toBe(false);
    expect(readAudit(a.projectId).some(e => e.event === "team_director_failed")).toBe(true);
  });

  test("the re-ask is stamped as a planner, like the first call", () => {
    business("acme", ["researcher", "writer", "synth"]);
    const roles: unknown[] = [];
    let n = 0;
    const impl = ((opts: any) => {
      roles.push(opts.dispatchRole);
      n++;
      return {
        ok: true, runtime: opts.runtime, sessionId: null, costUsd: 0, exitCode: 0, stderr: "", durationMs: 1,
        result: n === 1 ? PROSE : JSON.stringify({ chain: [{ employee: "synth", task: "faça" }] }),
      };
    }) as any;
    runTeam(args("acme", { runHeadlessImpl: impl, runWithCascadeImpl: cascade([]) }));
    expect(roles).toEqual(["planner", "planner"]);
  });
});

describe("runTeam — mandatory squads go to the seat they serve", () => {
  // The router's mandatory squads used to run as a separate track the director
  // never saw, on the whole brief, right before the synthesizer, while the seat
  // whose job covered the same part did it too. The part was done twice and
  // merged at the end. A slug no library carries: the pre-synthesizer pass then
  // fails fast on "squad dir not found" and still records its step, which is
  // exactly what these tests read.
  const SQUAD = "zz-fixture-mandatory-squad";

  function directorWith(chain: any[]) {
    const prompts: string[] = [];
    const impl = ((opts: any) => {
      prompts.push(String(opts.prompt ?? ""));
      return { ok: true, runtime: opts.runtime, sessionId: null, costUsd: 0, exitCode: 0, stderr: "", durationMs: 1, result: JSON.stringify({ chain }) };
    }) as any;
    return { impl, prompts };
  }
  const promptOf = (seen: any[], employee: string) => String(seen.find(o => String(o.taskHint).includes(`(${employee})`))?.prompt ?? "");

  test("the director is told the mandatory squads and how to assign them", () => {
    business("acme", ["researcher", "synth"]);
    const d = directorWith([{ employee: "synth", task: "faça" }]);
    runTeam(args("acme", { runHeadlessImpl: d.impl, runWithCascadeImpl: cascade([]), mandatorySquads: [SQUAD] }));
    expect(d.prompts[0]).toContain("MANDATORY SQUADS");
    expect(d.prompts[0]).toContain(`"${SQUAD}"`);
    expect(d.prompts[0]).toContain('"squad":');
  });

  test("without mandatory squads the director's prompt and the seats' prompts are as before", () => {
    business("acme", ["researcher", "synth"]);
    const seen: any[] = [];
    const d = directorWith([{ employee: "researcher", task: "pesquise" }, { employee: "synth", task: "consolide" }]);
    runTeam(args("acme", { runHeadlessImpl: d.impl, runWithCascadeImpl: cascade(seen) }));
    expect(d.prompts[0]).not.toContain("MANDATORY SQUADS");
    expect(d.prompts[0]).not.toContain('"squad":');
    expect(promptOf(seen, "researcher")).not.toContain("YOUR ASSIGNMENT");
  });

  /** A cascade whose `researcher` step leaves the evidence a real nested squad
   *  dispatch leaves: squad-exec's `agent_executed` with `squad_slug`, written to
   *  the same harness log runTeam reads, under the nested run's own project id. */
  function cascadeWhereSeatRanSquad(seen: any[], squad: string) {
    const inner = cascade(seen);
    return ((opts: any) => {
      if (String(opts.taskHint ?? "").includes("(researcher)")) {
        const dir = path.join(harnessLogsDir({ cwd: tmp }), new Date().toISOString().slice(0, 10));
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify({
          ts: new Date().toISOString(), event: "agent_executed", project_id: "proj-nested-squad",
          squad_slug: squad, employee: `squad:${squad}`, mode: "squad-only",
        }) + "\n");
      }
      return inner(opts);
    }) as any;
  }

  test("the seat given the squad carries it and keeps choosing its own voice", () => {
    business("acme", ["researcher", "synth"]);
    const seen: any[] = [];
    const d = directorWith([{ employee: "researcher", task: "pesquise", squad: SQUAD }, { employee: "synth", task: "consolide" }]);
    const r = runTeam(args("acme", { runHeadlessImpl: d.impl, runWithCascadeImpl: cascade(seen), mandatorySquads: [SQUAD] }));
    expect(r.chain[0].squad).toBe(SQUAD);
    const seat = promptOf(seen, "researcher");
    expect(seat).toContain(`YOUR ASSIGNMENT — write the instruction for \`${SQUAD}\``);
    // Only the squad was mapped: the clone half stays self-service.
    expect(seat).toContain("MIND-CLONES YOU EMBODY — decision:");
    expect(seat).not.toContain("MIND-CLONE YOU EMBODY — assigned:");
  });

  test("a seat that ends well WITHOUT running its squad does not count: the squad still runs before the synthesizer", () => {
    // The assignment lets a seat stop and say the squad is the wrong tool, and
    // that step is ok. Its success is not evidence the squad ran.
    business("acme", ["researcher", "synth"]);
    const d = directorWith([{ employee: "researcher", task: "pesquise", squad: SQUAD }, { employee: "synth", task: "consolide" }]);
    const a = args("acme", { runHeadlessImpl: d.impl, runWithCascadeImpl: cascade([]), mandatorySquads: [SQUAD] });
    const r = runTeam(a);
    expect(r.steps.map(s => s.employee)).toEqual(["researcher", `squad:${SQUAD}`, "synth"]);
    expect(readAudit(a.projectId).some(e => e.event === "x_carried_squad_unconfirmed" && e.squad_slug === SQUAD)).toBe(true);
  });

  test("a seat whose squad the audit shows ran during its step is not followed by a second run", () => {
    const RAN = `${SQUAD}-ran`;
    business("acme", ["researcher", "synth"]);
    const d = directorWith([{ employee: "researcher", task: "pesquise", squad: RAN }, { employee: "synth", task: "consolide" }]);
    const a = args("acme", { runHeadlessImpl: d.impl, runWithCascadeImpl: cascadeWhereSeatRanSquad([], RAN), mandatorySquads: [RAN] });
    const r = runTeam(a);
    expect(r.ok).toBe(true);
    expect(r.steps.map(s => s.employee)).toEqual(["researcher", "synth"]);
    expect(readAudit(a.projectId).some(e => e.event === "x_carried_squad_unconfirmed")).toBe(false);
  });

  test("evidence from before the seat's step does not count", () => {
    const OLD = `${SQUAD}-old`;
    business("acme", ["researcher", "synth"]);
    const dir = path.join(harnessLogsDir({ cwd: tmp }), new Date().toISOString().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify({
      ts: new Date(Date.now() - 60_000).toISOString(), event: "agent_executed", project_id: "proj-earlier", squad_slug: OLD,
    }) + "\n");
    const d = directorWith([{ employee: "researcher", task: "pesquise", squad: OLD }, { employee: "synth", task: "consolide" }]);
    const r = runTeam(args("acme", { runHeadlessImpl: d.impl, runWithCascadeImpl: cascade([]), mandatorySquads: [OLD] }));
    expect(r.steps.map(s => s.employee)).toEqual(["researcher", `squad:${OLD}`, "synth"]);
  });

  test("a squad no seat took still runs, before the synthesizer", () => {
    business("acme", ["researcher", "synth"]);
    const d = directorWith([{ employee: "researcher", task: "pesquise" }, { employee: "synth", task: "consolide" }]);
    const r = runTeam(args("acme", { runHeadlessImpl: d.impl, runWithCascadeImpl: cascade([]), mandatorySquads: [SQUAD] }));
    expect(r.steps.map(s => s.employee)).toEqual(["researcher", `squad:${SQUAD}`, "synth"]);
  });

  test("a seat that carried the squad and did not deliver leaves it to the pre-synthesizer pass", () => {
    business("acme", ["researcher", "synth"]);
    const d = directorWith([{ employee: "researcher", task: "pesquise", squad: SQUAD }, { employee: "synth", task: "consolide" }]);
    const r = runTeam(args("acme", { runHeadlessImpl: d.impl, runWithCascadeImpl: cascade([], new Set(["researcher"])), mandatorySquads: [SQUAD] }));
    expect(r.steps.map(s => s.employee)).toEqual(["researcher", `squad:${SQUAD}`, "synth"]);
  });

  test("an assignment the director should not make is dropped, never the squad", () => {
    business("acme", ["researcher", "writer", "synth"]);
    const d = directorWith([
      { employee: "researcher", task: "pesquise", squad: "not-a-mandatory-squad" },
      { employee: "writer", task: "escreva", squad: SQUAD },
      { employee: "synth", task: "consolide", squad: SQUAD },
    ]);
    const r = runTeam(args("acme", { runHeadlessImpl: d.impl, runWithCascadeImpl: cascade([]), mandatorySquads: [SQUAD] }));
    expect(r.chain.map(s => s.squad ?? null)).toEqual([null, SQUAD, null]);
    // The writer kept the assignment, but nothing shows the squad ran in its
    // step, so it still runs on its own before the synthesizer.
    expect(r.steps.map(s => s.employee)).toEqual(["researcher", "writer", `squad:${SQUAD}`, "synth"]);
  });
});
