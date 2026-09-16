// What `npx skills add gutomec/nirvana-os-engine` sees in this repository.
//
// Reimplements the discovery rule of the skills CLI (vercel-labs/skills
// 1.5.26, src/skills.ts): the repository root at depth 1; `skills/`,
// `skills/.curated|.experimental|.system` and the agent project dirs walked up
// to three levels; a directory holding SKILL.md is a skill and the walk stops
// below it (so a skill's own sub-directories never surface); a skill whose
// frontmatter has `metadata.internal: true` is hidden unless asked for by
// name. No network on purpose: `npx skills add . --list` fetches the package.
//
// Before the `nirvana` skill existed this repository advertised four skills
// through that CLI, and every one of them was broken on arrival: `_shared` has
// no SKILL.md and was never installed, and the other three reach it through
// paths fixed at ~/.nirvana/skills.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const CONTAINERS = ["skills", "skills/.curated", "skills/.experimental", "skills/.system", ".claude/skills", ".agents/skills"];
const SKIP = new Set(["node_modules", ".git", "dist"]);

interface Found { dir: string; fm: Record<string, unknown>; }

function parseSkill(dir: string): Found | null {
  const file = path.join(dir, "SKILL.md");
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.startsWith("---")) return { dir, fm: {} };
  const end = raw.indexOf("\n---", 3);
  return { dir, fm: (parse(raw.slice(4, end)) as Record<string, unknown>) ?? {} };
}

function walk(dir: string, maxDepth: number, out: Found[], depth = 1): Found[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP.has(e.name)) continue;
    const child = path.join(dir, e.name);
    const found = parseSkill(child);
    if (found) { out.push(found); continue; }        // a found skill stops the descent
    if (depth < maxDepth) walk(child, maxDepth, out, depth + 1);
  }
  return out;
}

function discover(): Found[] {
  const all: Found[] = [];
  const atRoot = parseSkill(REPO);
  if (atRoot) all.push(atRoot);
  for (const c of CONTAINERS) walk(path.join(REPO, c), 3, all);
  return all;
}

const isInternal = (f: Found) => (f.fm.metadata as Record<string, unknown> | undefined)?.internal === true;
const nameOf = (f: Found) => String(f.fm.name ?? "");

test("exactly one skill is visible to the skills CLI, and it is `nirvana`", () => {
  const visible = discover().filter((f) => !isInternal(f)).map(nameOf).sort();
  expect(visible).toEqual(["nirvana"]);
});

test("the engine skills are shipped but hidden, and say so in their body", () => {
  const byName = new Map(discover().map((f) => [nameOf(f), f]));
  for (const s of ["harness", "squads", "businesses"]) {
    const f = byName.get(s);
    expect(f, s).toBeDefined();
    expect(isInternal(f!), `${s} metadata.internal`).toBe(true);
    expect(fs.readFileSync(path.join(f!.dir, "SKILL.md"), "utf8")).toMatch(/use the `nirvana` skill/);
  }
  expect(fs.existsSync(path.join(REPO, "skills", "_shared", "SKILL.md"))).toBe(false);
});

test("every discovered skill is named after its directory (Agent Skills rule)", () => {
  for (const f of discover()) expect(nameOf(f), f.dir).toBe(path.basename(f.dir));
});

test("the entry skill is one skill: no SKILL.md below it, and its frontmatter fits the limits", () => {
  const dir = path.join(REPO, "skills", "nirvana");
  const nested: string[] = [];
  const scan = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) scan(p);
      else if (e.name === "SKILL.md" && d !== dir) nested.push(path.relative(dir, p));
    }
  };
  scan(dir);
  expect(nested).toEqual([]);

  const fm = parseSkill(dir)!.fm;
  expect(fm.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  expect(String(fm.name).length).toBeLessThanOrEqual(64);
  expect(String(fm.description).length).toBeLessThanOrEqual(1024);
  expect(String(fm.compatibility).length).toBeLessThanOrEqual(500);
  expect(isInternal({ dir, fm })).toBe(false);
  for (const f of ["scripts/bootstrap.sh", "scripts/bootstrap.ps1", "agents/openai.yaml"]) {
    expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
  }
});
