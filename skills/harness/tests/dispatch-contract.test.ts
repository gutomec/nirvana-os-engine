// dispatch-contract.test.ts — the protocol must dispatch subagents synchronously.
//
// The defect this pins, measured on a real 13-target run
// (galinha-dos-ovos-de-ouro, 2026-08-12): every dispatch example in the protocol
// omitted `run_in_background: false`, the subagent tool defaults to background,
// and all 13 dispatches returned "Async agent launched successfully" — a launch
// receipt, not work. Nothing ever reported completion, so the orchestrator spent
// the run scanning the filesystem to guess what had finished, gating whatever
// files it noticed, and closing ledger runs on a directory listing.
//
// Everything downstream of a dispatch assumes a real result: the harness waits
// for the return (Phase 5), a business reads the handoff artifact to choose the
// next employee (businesses step 6), a workflow phase consumes the previous
// phase's output. A launch receipt satisfies none of them.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const GATE = path.join(ROOT, "scripts", "check-dispatch-contract.ts");

const PROTOCOL = [
  "skills/harness/SKILL.md",
  "skills/harness/references/04-multi-target.md",
  "skills/businesses/SKILL.md",
  "skills/squads/SKILL.md",
  "skills/_shared/adapters/claude-code.md",
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function runGate(cwd = ROOT) {
  return spawnSync(process.execPath, [GATE], { encoding: "utf8", cwd });
}

describe("the shipped protocol dispatches synchronously", () => {
  test("every Agent({...}) example carries run_in_background: false", () => {
    const offenders: string[] = [];
    for (const rel of PROTOCOL) {
      const text = read(rel);
      for (const m of text.matchAll(/Agent\(\{[\s\S]{0,600}?\}\)/g)) {
        if (/run_in_background:\s*(false|true)/.test(m[0])) continue;
        offenders.push(`${rel}:${text.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the three pillars each state the synchronous rule where their chain depends on it", () => {
    // harness: the maestro's own dispatch table.
    expect(read("skills/harness/SKILL.md")).toContain("Dispatch is SYNCHRONOUS");
    // businesses: step 6 reads the handoff artifact returned by step 5.
    expect(read("skills/businesses/SKILL.md")).toMatch(/run_in_background: false/);
    // squads: workflow phases consume each other's output.
    expect(read("skills/squads/SKILL.md")).toMatch(/run_in_background: false/);
  });

  test("parallelism is defined as one message with several calls", () => {
    const harness = read("skills/harness/SKILL.md");
    const multi = read("skills/harness/references/04-multi-target.md");
    expect(harness).toMatch(/one message with several calls|single message/i);
    expect(multi).toMatch(/A wave is one message/);
  });

  test("filesystem polling is named and forbidden, since that is what the gap produced", () => {
    const harness = read("skills/harness/SKILL.md");
    expect(harness).toMatch(/Never poll the filesystem/i);
    expect(harness).toMatch(/find`, `ls` or `stat`|find\/ls/i);
  });
});

describe("check-dispatch-contract — the gate itself", () => {
  test("passes on the shipped tree", () => {
    const r = runGate();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("clean");
  });

  test("fails when a dispatch example loses the flag", () => {
    // A copy of the tree, so the test never mutates the repo it is checking.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-dispatch-gate-"));
    try {
      fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
      fs.copyFileSync(GATE, path.join(tmp, "scripts", "check-dispatch-contract.ts"));
      for (const rel of PROTOCOL) {
        fs.mkdirSync(path.join(tmp, path.dirname(rel)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
      }
      const target = path.join(tmp, "skills/harness/SKILL.md");
      fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("run_in_background: false, prompt: buildEmployeePrompt", "prompt: buildEmployeePrompt"));

      const r = spawnSync(process.execPath, [path.join(tmp, "scripts", "check-dispatch-contract.ts")], { encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("missing run_in_background: false");
      expect(r.stderr).toContain("skills/harness/SKILL.md");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a deliberate background example is allowed — the exception must stay writable", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-dispatch-gate-bg-"));
    try {
      fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
      fs.copyFileSync(GATE, path.join(tmp, "scripts", "check-dispatch-contract.ts"));
      for (const rel of PROTOCOL) {
        fs.mkdirSync(path.join(tmp, path.dirname(rel)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
      }
      const target = path.join(tmp, "skills/harness/SKILL.md");
      fs.appendFileSync(target, '\n\nLong unrelated work: `Agent({subagent_type: "general-purpose", run_in_background: true, prompt: "..."})`\n');
      expect(spawnSync(process.execPath, [path.join(tmp, "scripts", "check-dispatch-contract.ts")], { encoding: "utf8" }).status).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("proximity to the word 'background' does not exempt anything", () => {
    // The first version of this gate exempted any example whose neighbouring
    // lines mentioned "background" — which exempted every example sitting under
    // the paragraph that explains why background is wrong. The exemption
    // swallowed precisely what it existed to catch.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-dispatch-gate-prox-"));
    try {
      fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
      fs.copyFileSync(GATE, path.join(tmp, "scripts", "check-dispatch-contract.ts"));
      for (const rel of PROTOCOL) {
        fs.mkdirSync(path.join(tmp, path.dirname(rel)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
      }
      const target = path.join(tmp, "skills/squads/SKILL.md");
      fs.appendFileSync(target, '\n\nBackground dispatch and notifications are discussed above.\n\n`Agent({subagent_type: "general-purpose", prompt: "..."})`\n');
      const r = spawnSync(process.execPath, [path.join(tmp, "scripts", "check-dispatch-contract.ts")], { encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("skills/squads/SKILL.md");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a renamed protocol file fails loudly instead of silently checking nothing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-dispatch-gate-missing-"));
    try {
      fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
      fs.copyFileSync(GATE, path.join(tmp, "scripts", "check-dispatch-contract.ts"));
      // Copy nothing else: every protocol file is "missing".
      const r = spawnSync(process.execPath, [path.join(tmp, "scripts", "check-dispatch-contract.ts")], { encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("not found");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
