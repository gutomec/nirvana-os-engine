// Hygiene of the shipped skills tree, for runtimes that discover recursively.
//
// `_shared/` is linked into every runtime's skills directory, so a loader that
// walks for SKILL.md (pi / prime-agent / Hermes do; Claude Code does not) sees
// EVERY SKILL.md under it. Two of them once declared `name: nirvana-os` — the
// real skill and a stale Hermes bridge variant — and the winner depended on
// filesystem order, so a user could silently get the stale one.
//
// Second rule: the first-class skills must point at the canonical tree
// (~/.nirvana/skills), never at ~/.claude/skills. Claude Code is not a
// prerequisite; those paths only resolved because the installer used to force
// a ~/.claude link on every machine.

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function findFiles(dir: string, name: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findFiles(abs, name));
    else if (e.name === name) out.push(abs);
  }
  return out;
}

function frontmatterName(file: string): string | null {
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  const block = end === -1 ? raw : raw.slice(0, end);
  const m = block.match(/^name:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

test("no two SKILL.md in the shipped tree declare the same name", () => {
  const byName = new Map<string, string[]>();
  for (const f of findFiles(SKILLS_ROOT, "SKILL.md")) {
    const name = frontmatterName(f);
    if (!name) continue;
    byName.set(name, [...(byName.get(name) ?? []), path.relative(SKILLS_ROOT, f)]);
  }
  const collisions = [...byName.entries()].filter(([, files]) => files.length > 1);
  expect(collisions).toEqual([]);
  // Sanity: the walk really found the first-class skills.
  expect([...byName.keys()].sort()).toEqual(
    expect.arrayContaining(["businesses", "harness", "nirvana-os", "squads"]),
  );
});

test("first-class skills and their references point at the canonical ~/.nirvana tree", () => {
  const files = [
    ...["harness", "businesses", "squads", "nirvana-os"].map((s) => path.join(SKILLS_ROOT, s, "SKILL.md")),
    ...["harness", "businesses", "squads"]
      .map((s) => path.join(SKILLS_ROOT, s, "references"))
      .filter((d) => fs.existsSync(d))
      .flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith(".md")).map((f) => path.join(d, f))),
  ];
  const offenders = files.filter((f) => fs.readFileSync(f, "utf8").includes("~/.claude/skills"));
  expect(offenders.map((f) => path.relative(SKILLS_ROOT, f))).toEqual([]);
});
