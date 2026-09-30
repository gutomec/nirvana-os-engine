// run-workspace.test.ts — a worker starts in its own run folder, and the run
// folders beside it are fenced off.
//
// Measured before this existed: a worker started in the project root (or HOME
// outside a project), a finished run of the same brief sat one `ls ../` away,
// and a headless claude asked to summarize "the notes a previous run left"
// read that run's deliverable and quoted it. With the deny rules below the
// same read comes back in `permission_denials`.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  claudeAbsolutePattern, confineToWorkspace, contractPointer, fenceSettings, projectDenyRules, runFolderOf, siblingRunFolders, workspaceDirective,
} from "../lib/run-workspace.ts";
import { outputsBaseDir } from "../lib/project-root.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-run-workspace-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** A declared project with two runs in its outputs. */
function project(name: string): { root: string; mine: string; other: string } {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
  fs.writeFileSync(path.join(root, ".nirvana", "project.yaml"), "name: fixture\n");
  const mine = path.join(root, "outputs", "run-mine");
  const other = path.join(root, "outputs", "run-other");
  fs.mkdirSync(path.join(mine, "agent-x"), { recursive: true });
  fs.mkdirSync(path.join(other, "deliverables"), { recursive: true });
  fs.writeFileSync(path.join(root, "outputs", "stray-file.txt"), "not a run");
  return { root, mine, other };
}

describe("runFolderOf", () => {
  test("a path inside a project run resolves to that run's folder", () => {
    const p = project("rf-project");
    expect(runFolderOf(path.join(p.mine, "agent-x"), p.root)).toBe(p.mine);
    expect(runFolderOf(p.mine, p.root)).toBe(p.mine);
  });

  test("a path inside a run of the engine's store resolves there", () => {
    const base = outputsBaseDir(null);
    expect(runFolderOf(path.join(base, "proj-1", "businesses", "acme"), null)).toBe(path.join(base, "proj-1"));
  });

  test("a path outside every outputs base is not a run", () => {
    const p = project("rf-outside");
    expect(runFolderOf(path.join(p.root, "src"), p.root)).toBeNull();
    expect(runFolderOf(path.join(p.root, "outputs"), p.root)).toBeNull();
    expect(runFolderOf(undefined, p.root)).toBeNull();
  });
});

describe("siblingRunFolders", () => {
  test("lists the other run folders, never this one and never plain files", () => {
    const p = project("sib");
    expect(siblingRunFolders(p.mine)).toEqual([p.other]);
  });
});

describe("claudeAbsolutePattern", () => {
  test("POSIX paths anchor at the filesystem root with //", () => {
    expect(claudeAbsolutePattern("/srv/proj/outputs/run-1", "linux")).toBe("//srv/proj/outputs/run-1");
  });

  test("Windows paths are matched in POSIX form, drive letter first", () => {
    expect(claudeAbsolutePattern("C:\\Users\\a\\proj\\outputs\\run-1", "win32")).toBe("//c/Users/a/proj/outputs/run-1");
    expect(claudeAbsolutePattern("\\\\server\\share\\run", "win32")).toBeNull();
  });

  test("gitignore metacharacters in a folder name are escaped, not wildcards", () => {
    expect(claudeAbsolutePattern("/srv/[2026] notes*/run?", "linux")).toBe("//srv/\\[2026\\] notes\\*/run\\?");
  });
});

describe("projectDenyRules", () => {
  test("the project's relative Read/Edit denies are re-anchored at its root", () => {
    const p = project("deny");
    fs.mkdirSync(path.join(p.root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(p.root, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: [
      "Read(./.env)", "Read(./**/.env.*)", "Read(secrets/**)", "Edit(/config/prod.json)",
      "Read(//etc/hosts)", "Read(~/notes/**)", "Bash(rm *)",
    ] } }));
    const root = claudeAbsolutePattern(p.root)!;
    expect(projectDenyRules(p.root)).toEqual([
      `Read(${root}/.env)`, `Read(${root}/**/.env.*)`, `Read(${root}/**/secrets/**)`, `Edit(${root}/config/prod.json)`,
    ]);
  });

  test("a project with no settings file has nothing to carry", () => {
    expect(projectDenyRules(project("deny-none").root)).toEqual([]);
  });
});

describe("fenceSettings", () => {
  test("every sibling run is denied to Read and Edit, the folder and what is under it", () => {
    const p = project("fence");
    const other = claudeAbsolutePattern(p.other)!;
    expect(fenceSettings(p.mine, p.root)!.permissions.deny).toEqual([
      `Read(${other})`, `Read(${other}/**)`, `Edit(${other})`, `Edit(${other}/**)`,
    ]);
  });

  test("a sibling the instruction names by path stays readable; a bare id does not count", () => {
    const p = project("fence-named");
    expect(fenceSettings(p.mine, null, process.platform, `Build on the analysis in outputs/run-other/deliverables.`)).toBeNull();
    expect(fenceSettings(p.mine, null, process.platform, `See ${p.other}/deliverables/report.md.`)).toBeNull();
    expect(fenceSettings(p.mine, null, process.platform, "the run-other folder")!.permissions.deny.length).toBe(4);
  });

  test("a run alone in its base with no project rules has nothing to fence", () => {
    const lone = path.join(TMP, "lone", "outputs", "only-run");
    fs.mkdirSync(lone, { recursive: true });
    expect(fenceSettings(lone, null)).toBeNull();
  });
});

describe("confineToWorkspace", () => {
  test("without a workspace the options come back untouched", () => {
    const opts = { runtime: "claude-code", cwd: TMP, prompt: "x" };
    expect(confineToWorkspace(opts).opts).toBe(opts);
  });

  test("claude-code: cwd moves to the run, the project stays granted, the fence travels in --settings", () => {
    const p = project("confine-claude");
    const { opts, cleanup } = confineToWorkspace({
      runtime: "claude-code", cwd: p.root, workspace: p.mine, addDirs: [path.join(p.mine, "agent-x")], appendSystemPrompt: "DIRECTIVE",
    });
    try {
      expect(opts.cwd).toBe(p.mine);
      expect(opts.hostCwd).toBe(p.root);
      expect(opts.addDirs).toEqual([path.join(p.mine, "agent-x"), p.root]);
      expect(opts.appendSystemPrompt).toBe(`DIRECTIVE\n\n${workspaceDirective(p.mine)}`);
      const settings = JSON.parse(fs.readFileSync(opts.claudeSettings!, "utf8"));
      expect(settings.permissions.deny).toContain(`Read(${claudeAbsolutePattern(p.other)}/**)`);
    } finally { cleanup(); }
    expect(fs.existsSync(opts.claudeSettings!)).toBe(false);
  });

  test("other runtimes get the cwd and the directive line, and no settings file", () => {
    const p = project("confine-codex");
    const { opts } = confineToWorkspace({ runtime: "codex", cwd: p.root, workspace: p.mine, appendSystemPrompt: "DIRECTIVE" });
    expect(opts.cwd).toBe(p.mine);
    expect(opts.claudeSettings).toBeUndefined();
    expect(opts.appendSystemPrompt).toBe(`DIRECTIVE\n\n${workspaceDirective(p.mine)}`);
  });

  test("codex outside a git repository is pointed at the project's AGENTS.md; claude-code is not", () => {
    const p = project("confine-contract");
    fs.writeFileSync(path.join(p.root, "AGENTS.md"), "# contract\n");
    // The fixture lives under the OS temp dir, which is in no repository.
    const codex = confineToWorkspace({ runtime: "codex", cwd: p.root, workspace: p.mine, appendSystemPrompt: "D" }).opts;
    expect(codex.appendSystemPrompt).toContain(path.join(p.root, "AGENTS.md"));
    expect(contractPointer("claude-code", p.mine, p.root)).toBe("");
    fs.mkdirSync(path.join(p.root, ".git"));
    expect(contractPointer("codex", p.mine, p.root)).toBe("");
  });

  test("a decision step with no directive stays lean: the cwd moves, no line is added", () => {
    const p = project("confine-judge");
    const { opts, cleanup } = confineToWorkspace({ runtime: "claude-code", cwd: p.root, workspace: p.mine });
    try {
      expect(opts.cwd).toBe(p.mine);
      expect(opts.appendSystemPrompt).toBeUndefined();
      expect(opts.claudeSettings).toBeDefined();
    } finally { cleanup(); }
  });

  test("outside a project nothing but the run folder is added", () => {
    const store = path.join(TMP, "store-like", "outputs");
    const run = path.join(store, "proj-9");
    fs.mkdirSync(run, { recursive: true });
    const { opts } = confineToWorkspace({ runtime: "gemini-cli", cwd: os.homedir(), workspace: run, addDirs: [] });
    expect(opts.cwd).toBe(run);
    expect(opts.addDirs).toEqual([]);
  });
});
