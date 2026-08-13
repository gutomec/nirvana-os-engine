// openclaw-support.test.ts — Nirvana must be usable from OpenClaw.
//
// Researched 2026-08-13 against docs.openclaw.ai and openclaw/openclaw. Three
// facts drive everything here:
//
//   1. OpenClaw discovers skills under ~/.agents/skills (personal), matching on
//      the frontmatter `name`, not the folder. If the engine does not link
//      there, an OpenClaw session never sees the harness at all.
//   2. It has NO in-process subagent. Delegation is `bash background:true` to a
//      child CLI, tracked with `process poll`, and the child announces its own
//      completion. So the scripted path (`nrv dispatch --exec`) is the dispatch
//      on that runtime, not a fallback.
//   3. It reads NO project instruction file — no CLAUDE.md/AGENTS.md
//      equivalent. Activation rests entirely on the skill's own description.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RUNTIME_SKILL_DIRS } from "../../_shared/lib/runtime-dirs.ts";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const SKILLS = ["skills/harness/SKILL.md", "skills/squads/SKILL.md", "skills/businesses/SKILL.md"];
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const frontmatter = (rel: string) => read(rel).split("---")[1];

describe("OpenClaw can find the skills", () => {
  test("~/.agents/skills is a wired runtime dir", () => {
    expect(RUNTIME_SKILL_DIRS).toContain(path.join(os.homedir(), ".agents/skills"));
  });

  test("every skill declares a name — OpenClaw matches on it, not the folder", () => {
    for (const rel of SKILLS) expect(frontmatter(rel)).toMatch(/^name:\s*\S+/m);
  });
});

describe("OpenClaw gating", () => {
  test("each skill requires bun, because every script is Bun-native", () => {
    // Without the gate the skill shows up on a machine with no bun, gets
    // invoked, and fails at the first command.
    for (const rel of SKILLS) {
      const fm = frontmatter(rel);
      expect(fm).toMatch(/openclaw:/);
      expect(fm).toMatch(/bins:\s*\["bun"\]/);
    }
  });

  test("model invocation stays enabled", () => {
    // The harness must be able to activate from a plain production brief, not
    // only from an explicit /harness. `disable-model-invocation` would kill that.
    for (const rel of SKILLS) expect(frontmatter(rel)).not.toMatch(/disable-model-invocation:\s*true/);
  });
});

describe("the dispatch path OpenClaw can actually run", () => {
  test("the protocol names the scripted path for runtimes with no subagent", () => {
    const h = read("skills/harness/SKILL.md");
    expect(h).toMatch(/no in-process subagent/i);
    expect(h).toMatch(/bash background:true/);
    expect(h).toMatch(/process poll/);
  });

  test("the stale compatibility claim is gone", () => {
    // It used to say a fire-and-forget runtime "cannot run the cascade". Untrue
    // since dispatch became notification-collected, and untrue for OpenClaw,
    // which offers a pollable handle instead.
    expect(read("skills/harness/SKILL.md")).not.toMatch(/cannot run the cascade/);
  });

  test("the adapter documents the mechanism, not just the name", () => {
    const a = read("skills/_shared/adapters/openclaw.md");
    expect(a).toMatch(/openclaw message send/);      // how completion is announced
    expect(a).toMatch(/process poll/);               // how it is tracked
    expect(a).toMatch(/nrv dispatch .*--exec/);      // what Nirvana runs
    expect(a).toMatch(/run-ledger|supervisor/i);     // what covers a worker that dies silent
  });

  test("the adapter is honest that no project contract file exists there", () => {
    expect(read("skills/_shared/adapters/openclaw.md")).toMatch(/não existe.*equivalente a `CLAUDE\.md`|reads NO project|não lê nenhum/i);
  });
});

describe("only the skills a runtime can use are offered to it", () => {
  // Found by installing OpenClaw and running `openclaw skills list`: it scans
  // six levels deep, reached the Hermes bridge under _shared/, and listed it as
  // ready — offering a Hermes-only skill to a runtime that cannot use it. The
  // bridge's own description asks every other runtime to ignore it; prose does
  // not enforce anything, a binary gate does.
  const hermesBridge = "skills/_shared/adapters/hermes/skills/nirvana/nirvana-os-hermes/SKILL.md";

  test("the Hermes bridge is gated on the hermes binary", () => {
    const fm = frontmatter(hermesBridge);
    expect(fm).toMatch(/openclaw:/);
    expect(fm).toMatch(/bins:\s*\["hermes"\]/);
  });

  test("its description still says it out loud, as defence in depth", () => {
    // The gate cannot express "which runtime am I" — OpenClaw offers binary,
    // config and OS gates only. On a machine with hermes installed AND OpenClaw
    // running, both variants appear, and the description is what remains.
    expect(read(hermesBridge)).toMatch(/Hermes runtime ONLY/);
  });

  test("every Nirvana skill an OpenClaw user can see requires bun", () => {
    // nirvana-os shipped without a gate and showed up on the list with no emoji
    // — visible on a machine that cannot run one line of it.
    for (const rel of [...SKILLS, "skills/nirvana-os/SKILL.md"]) {
      expect(frontmatter(rel)).toMatch(/bins:\s*\["bun"\]/);
    }
  });
});

describe("the shared skills dir is treated with care", () => {
  test("the runtime-dirs comment warns against symlinking the whole directory", () => {
    // ~/.agents/skills is shared with other tooling. Symlinking the directory
    // to another runtime's tree makes every skill reachable twice and produces
    // "Skill conflict detected" — that exact defect was found and removed on
    // this machine on 2026-08-13.
    const rd = read("skills/_shared/lib/runtime-dirs.ts");
    expect(rd).toMatch(/Skill conflict detected/);
    expect(rd).toMatch(/OpenClaw/);
  });
});
