// skills-litter.test.ts — a skill about backups is not a backup.
//
// `nrv doctor` classified any directory whose name contained "backup" as
// disposable and printed "Safe to delete." about it. On a real installation
// that was `~/.claude/skills/backup-verificado`: a loaded skill with valid
// frontmatter, and the one that machine's own contract required before any
// format. Following the advice would have removed exactly the protection the
// user was about to rely on (issue #251, reported against 0.13.6, present
// since 0.9.0).
//
// The cases below hold both sides of the line, because the obvious fix — skip
// anything carrying a SKILL.md — breaks the check instead: a copy of a skill
// carries a SKILL.md too, which is why the runtime loads it twice.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classifySkillsLitter } from "../lib/skills-litter.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

/** A skills directory holding the named entries. `withSkill` gets a SKILL.md. */
function skillsDir(entries: Array<[name: string, withSkill: boolean]>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-litter-")));
  roots.push(root);
  const dir = path.join(root, "skills");
  for (const [name, withSkill] of entries) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    if (withSkill) {
      fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: uma skill de verdade\n---\n\ncorpo\n`);
    }
  }
  return dir;
}

describe("a skill named after backups is a skill", () => {
  test.each([
    ["backup-verificado"],
    ["backup-restore"],
    ["db-backup"],
  ])("%s, with a SKILL.md, is neither litter nor doubtful", (name) => {
    const dir = skillsDir([[name, true]]);
    expect(classifySkillsLitter([dir])).toEqual({ copies: [], unsure: [] });
  });
});

describe("a conventional copy is still caught", () => {
  test.each([
    ["squads.pre-nirvana.bak"],   // the case seen live, under ~/.antigravity/skills
    ["harness.old"],
    ["skills-backup-2026-09-01"],
  ])("%s is a copy, even carrying a SKILL.md of its own", (name) => {
    // This is the point of not filtering on SKILL.md: a copy of a skill has one.
    const dir = skillsDir([[name, true]]);
    const { copies, unsure } = classifySkillsLitter([dir]);
    expect(copies).toEqual([path.join(dir, name)]);
    expect(unsure).toEqual([]);
  });
});

describe("named like a backup, loadable as nothing", () => {
  test("a directory with no SKILL.md is reported, but never called safe to delete", () => {
    const dir = skillsDir([["some-backup", false]]);
    const { copies, unsure } = classifySkillsLitter([dir]);
    expect(copies).toEqual([]);
    expect(unsure).toEqual([path.join(dir, "some-backup")]);
  });

  test("a directory with no SKILL.md and no backup in its name is not this check's business", () => {
    expect(classifySkillsLitter([skillsDir([["notes", false]])])).toEqual({ copies: [], unsure: [] });
  });
});

describe("the whole picture at once", () => {
  test("one skills dir holding all four shapes sorts them correctly", () => {
    const dir = skillsDir([
      ["backup-verificado", true],        // skill
      ["squads.pre-nirvana.bak", true],   // copy
      ["some-backup", false],             // unsure
      ["harness", true],                  // skill
    ]);
    const { copies, unsure } = classifySkillsLitter([dir]);
    expect(copies).toEqual([path.join(dir, "squads.pre-nirvana.bak")]);
    expect(unsure).toEqual([path.join(dir, "some-backup")]);
  });

  test("a directory that does not exist is silence, not a crash", () => {
    expect(classifySkillsLitter(["/nao/existe/em/lugar/nenhum"])).toEqual({ copies: [], unsure: [] });
  });

  test("paths are shortened against the home the caller passes", () => {
    const dir = skillsDir([["x.bak", false]]);
    const home = path.dirname(dir);   // the fixture root that CONTAINS skills/
    expect(classifySkillsLitter([dir], home).copies).toEqual([path.join("~", "skills", "x.bak")]);
  });
});

describe("the wording matches the confidence", () => {
  const doctor = fs.readFileSync(path.join(import.meta.dir, "..", "scripts", "doctor-system.ts"), "utf8").replace(/\r\n/g, "\n");
  const block = doctor.slice(doctor.indexOf("skills: backup litter") - 1500, doctor.indexOf('add("skills: backup litter", "PASS"'));

  test("'Safe to delete' is attached to the copies, not to the doubtful entries", () => {
    const unsureLine = block.split("\n").find((l) => l.includes("no SKILL.md"))!;
    expect(unsureLine).toContain("Check before removing");
    expect(unsureLine).not.toContain("Safe to delete");
  });

  test("the bare substring no longer decides on its own", () => {
    expect(doctor).not.toContain("/\\.bak$|\\.old$|backup/i");
  });
});
