// dispatch-contract.test.ts — a dispatch must come home without blocking anyone.
//
// A spawn returns "Async agent launched successfully" — a launch receipt. The
// work arrives later, in a `<task-notification>` carrying `<result>`. Two
// things, two moments; every failure here is a confusion between them.
//
// Both mistakes are pinned, because the second one was mine:
//   1. A real 13-target run took the receipts as results, never waited for a
//      notification, and spent nine hours scanning find/ls to guess.
//   2. I then mandated `run_in_background: false` everywhere. That does return
//      the work — by blocking the session for the entire run. A 45-minute
//      deploy stack left the owner unable to say a word; their messages queued
//      unread behind work they were not about.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const GATE = path.join(ROOT, "scripts", "check-dispatch-contract.ts");

const PROTOCOL = [
  "skills/harness/SKILL.md",
  "skills/harness/references/04-multi-target.md",
  "skills/businesses/SKILL.md",
  "skills/squads/SKILL.md",
  "skills/_shared/adapters/claude-code.md",
];

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("dispatches do not block the session", () => {
  test("no example forces run_in_background: false", () => {
    const offenders: string[] = [];
    for (const rel of PROTOCOL) {
      const text = read(rel);
      for (const m of text.matchAll(/Agent\(\{[\s\S]{0,600}?\}\)/g)) {
        if (/run_in_background:\s*false/.test(m[0])) {
          offenders.push(`${rel}:${text.slice(0, m.index).split("\n").length}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the protocol says not to block, and why", () => {
    const h = read("skills/harness/SKILL.md");
    expect(h).toMatch(/[Dd]o not block the session/);
    expect(h).toMatch(/queue|queued/i);        // what blocking costs the user
  });
});

describe("the result is collected from the notification", () => {
  test("the harness distinguishes receipt from result", () => {
    const h = read("skills/harness/SKILL.md");
    expect(h).toMatch(/launch receipt/i);
    expect(h).toMatch(/task-notification/);
    expect(h).toMatch(/<result>/);
  });

  test("each pillar says where its own return comes from", () => {
    // businesses: the handoff artifact drives the employee chain.
    expect(read("skills/businesses/SKILL.md")).toMatch(/task-notification/);
    // squads: a phase consumes the previous phase's report.
    expect(read("skills/squads/SKILL.md")).toMatch(/task-notification/);
  });

  test("acting on the notification is required, not optional", () => {
    // A notification noticed and ignored leaves the run finished with nobody
    // knowing — the same end state as mistaking the receipt for the result.
    expect(read("skills/harness/SKILL.md")).toMatch(/notification you noticed and did not act on/i);
  });
});

describe("what a notification actually means", () => {
  const h = () => read("skills/harness/SKILL.md");

  test("one dispatch can notify more than once", () => {
    // A live test dispatch notified with a garbled result and no file on disk,
    // then notified again minutes later, clean and complete. Reading the first
    // as final would have declared a delivery in flight a failure.
    expect(h()).toMatch(/not always the last one/i);
    expect(h()).toMatch(/notify more than once/i);
  });

  test("a garbled or contradicted result means 'not finished', not 'failed'", () => {
    expect(h()).toMatch(/truncated, garbled or contradicts the disk/i);
    expect(h()).toMatch(/not finished yet/i);
  });

  test("delivery is proven on disk, not by the report", () => {
    expect(h()).toMatch(/is a report, not proof/i);
    expect(h()).toMatch(/verify-deliverable/);
  });

  test("an honestly reported blocker is recorded, not retried blindly", () => {
    expect(h()).toMatch(/honest failure is the system working/i);
    expect(h()).toMatch(/Do not re-dispatch the same brief/i);
  });
});

describe("the bans that survive from the first version", () => {
  test("filesystem polling is still forbidden", () => {
    expect(read("skills/harness/SKILL.md")).toMatch(/[Nn]ever poll the filesystem/);
  });

  test("a dispatch gets no timeout", () => {
    // Killing a target at an arbitrary deadline throws away real work.
    expect(read("skills/harness/SKILL.md")).toMatch(/never set a timeout on a dispatch/i);
  });

  test("a wave is still one message", () => {
    expect(read("skills/harness/references/04-multi-target.md")).toMatch(/A wave is one message/);
  });
});

describe("check-dispatch-contract — the gate itself", () => {
  function sandbox(mutate: (dir: string) => void): number {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-dispatch-gate-"));
    try {
      fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
      fs.copyFileSync(GATE, path.join(tmp, "scripts", "check-dispatch-contract.ts"));
      for (const rel of PROTOCOL) {
        fs.mkdirSync(path.join(tmp, path.dirname(rel)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
      }
      mutate(tmp);
      return spawnSync(process.execPath, [path.join(tmp, "scripts", "check-dispatch-contract.ts")], { encoding: "utf8" }).status ?? -1;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  test("passes on the shipped tree", () => {
    const r = spawnSync(process.execPath, [GATE], { encoding: "utf8", cwd: ROOT });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("clean");
  }, spawnBudgetMs(2));

  test("fails when an example goes back to blocking", () => {
    expect(sandbox((dir) => {
      const f = path.join(dir, "skills/harness/SKILL.md");
      fs.appendFileSync(f, '\n\n`Agent({subagent_type: "general-purpose", run_in_background: false, prompt: "x"})`\n');
    })).toBe(1);
  });

  test("fails when a rule is dropped from the protocol", () => {
    expect(sandbox((dir) => {
      const f = path.join(dir, "skills/harness/SKILL.md");
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/[Nn]ever poll the filesystem/g, "sometimes poll"));
    })).toBe(1);
  });

  test("fails loudly when a protocol file is renamed away", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-dispatch-gate-missing-"));
    try {
      fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
      fs.copyFileSync(GATE, path.join(tmp, "scripts", "check-dispatch-contract.ts"));
      const r = spawnSync(process.execPath, [path.join(tmp, "scripts", "check-dispatch-contract.ts")], { encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("not found");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, spawnBudgetMs(2));
});
