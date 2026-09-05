// runtime-install.test.ts — a skill copied into a runtime directory carries no
// node_modules, resolves its imports through the deps link BESIDE the skills
// root, and a scanner that follows symlinks (Codex's does) never reaches the
// dependency store from inside the root.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { depsLinkFor, ensureDepsLink, materializeRuntimeSkillCopy, pruneDepsLinkInside } from "../../_shared/lib/runtime-install.ts";
import { COPY_MARKER } from "../../_shared/lib/runtime-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-rt-install-")); roots.push(home);
  // The shared store, with one package and a lot of entries around it.
  const store = path.join(home, ".nirvana", "node_modules");
  fs.mkdirSync(path.join(store, "fakedep"), { recursive: true });
  fs.writeFileSync(path.join(store, "fakedep", "package.json"), JSON.stringify({ name: "fakedep", main: "index.js" }));
  fs.writeFileSync(path.join(store, "fakedep", "index.js"), "module.exports = 42;\n");
  for (let i = 0; i < 300; i++) fs.mkdirSync(path.join(store, `pkg-${i}`, "lib"), { recursive: true });
  // The canonical skill: a script that needs the dependency.
  const skill = path.join(home, ".nirvana", "skills", "harness");
  fs.mkdirSync(path.join(skill, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: harness\ndescription: probe\n---\n");
  fs.writeFileSync(path.join(skill, "scripts", "probe.ts"), 'import v from "fakedep"; console.log(String(v));\n');
  // What the old installer left behind: a link inside the skill.
  fs.symlinkSync(store, path.join(skill, "node_modules"));
  const skillsDir = path.join(home, ".codex", "skills");
  return { home, store, skill, skillsDir };
}

/** Count entries a symlink-following, hidden-pruning scanner would visit under a root. */
function scanEntries(root: string): number {
  let n = 0;
  const seen = new Set<string>();
  const walk = (dir: string) => {
    let real: string; try { real = fs.realpathSync(dir); } catch { return; }
    if (seen.has(real)) return; seen.add(real);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      n++;
      const full = path.join(dir, e.name);
      let st: fs.Stats; try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
    }
  };
  walk(root);
  return n;
}

describe("runtime-install — no node_modules inside a skills root", () => {
  test("the copy has no node_modules, carries the marker, and the deps link sits beside the root", () => {
    const { store, skill, skillsDir } = fixture();
    const copy = path.join(skillsDir, "harness");
    materializeRuntimeSkillCopy(skill, copy);
    expect(fs.existsSync(path.join(copy, COPY_MARKER))).toBe(true);
    expect(fs.existsSync(path.join(copy, "scripts", "probe.ts"))).toBe(true);
    expect(() => fs.lstatSync(path.join(copy, "node_modules"))).toThrow();

    const link = depsLinkFor(skillsDir);
    expect(link).toBe(path.join(path.dirname(skillsDir), "node_modules"));
    expect(ensureDepsLink(link, store)).toBe("linked");
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(store));
    // Re-running replaces the link and stays idempotent.
    expect(ensureDepsLink(link, store)).toBe("linked");
  });

  test("a script inside the copy resolves its dependency through the link above the root", () => {
    const { store, skill, skillsDir } = fixture();
    const copy = path.join(skillsDir, "harness");
    materializeRuntimeSkillCopy(skill, copy);
    ensureDepsLink(depsLinkFor(skillsDir), store);
    const r = spawnSync("bun", [path.join(copy, "scripts", "probe.ts")], { encoding: "utf8", cwd: os.tmpdir() });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("42");
  }, spawnBudgetMs(1));

  test("a symlinked skill still resolves once the per-skill link is pruned, through the link beside the canonical tree", () => {
    const { home, store, skill } = fixture();
    expect(pruneDepsLinkInside(skill)).toBe(true);
    expect(pruneDepsLinkInside(skill)).toBe(false); // nothing left to prune
    ensureDepsLink(path.join(home, ".nirvana", "skills", "node_modules"), store);
    const agents = path.join(home, ".agents", "skills");
    fs.mkdirSync(agents, { recursive: true });
    fs.symlinkSync(skill, path.join(agents, "harness"));
    const r = spawnSync("bun", [path.join(agents, "harness", "scripts", "probe.ts")], { encoding: "utf8", cwd: os.tmpdir() });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("42");
  }, spawnBudgetMs(1));

  test("a scanner that follows symlinks never reaches the store from inside either root", () => {
    const { home, store, skill, skillsDir } = fixture();
    const before = scanEntries(path.dirname(skill)); // the old layout: the link is inside the skill
    expect(before).toBeGreaterThan(300);
    pruneDepsLinkInside(skill);
    materializeRuntimeSkillCopy(skill, path.join(skillsDir, "harness"));
    ensureDepsLink(depsLinkFor(skillsDir), store);
    ensureDepsLink(path.join(home, ".nirvana", "skills", "node_modules"), store);
    expect(scanEntries(skillsDir)).toBeLessThan(10);
    const agents = path.join(home, ".agents", "skills");
    fs.mkdirSync(agents, { recursive: true });
    fs.symlinkSync(skill, path.join(agents, "harness"));
    expect(scanEntries(agents)).toBeLessThan(10);
  });

  test("a real node_modules directory is never deleted", () => {
    const { store, skillsDir } = fixture();
    const link = depsLinkFor(skillsDir);
    fs.mkdirSync(path.join(link, "somebody-elses"), { recursive: true });
    expect(ensureDepsLink(link, store)).toBe("kept-real-dir");
    expect(fs.existsSync(path.join(link, "somebody-elses"))).toBe(true);
    expect(pruneDepsLinkInside(path.dirname(link))).toBe(false);
  });
});
