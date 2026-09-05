// openclaw.test.ts — reading OpenClaw's roster and answering "which agents have
// a Nirvana project as their workspace". Pure: a config file and directories in
// a temp dir, no OpenClaw binary.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isNirvanaProject, openclawAgentFor, openclawAgentsOnProjects, openclawBindCommand, readOpenClawAgents } from "../../_shared/lib/openclaw.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

// Directories first, then the config that names them.
function fixture(config: (p: { project: string; plain: string }) => unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-openclaw-")); roots.push(root);
  const project = path.join(root, "my-project");
  fs.mkdirSync(path.join(project, ".nirvana"), { recursive: true });
  const plain = path.join(root, "plain-dir");
  fs.mkdirSync(plain, { recursive: true });
  const cfg = path.join(root, "openclaw.json");
  fs.writeFileSync(cfg, JSON.stringify(config({ project, plain })));
  return { root, project, plain, cfg };
}

describe("OpenClaw roster → projects", () => {
  test("entries shape: the agent whose workspace is a project is found; the others are not", () => {
    const { project, plain, cfg } = fixture((p) => ({ agents: { defaults: { workspace: "/tmp/ws" }, entries: {
      main: {}, docs: { workspace: p.plain }, proj: { workspace: p.project, cwd: "/elsewhere" },
    } } }));
    const all = readOpenClawAgents(cfg);
    expect(all.map((a) => a.id).sort()).toEqual(["docs", "main", "proj"]);
    expect(all.find((a) => a.id === "main")!.workspace).toBe("/tmp/ws");            // main uses the default itself
    expect(all.find((a) => a.id === "proj")!.cwd).toBe("/elsewhere");
    expect(openclawAgentsOnProjects(cfg).map((a) => a.id)).toEqual(["proj"]);
    expect(openclawAgentFor(project, cfg)!.id).toBe("proj");
    expect(openclawAgentFor(plain, cfg)!.id).toBe("docs");           // bound, just not to a project
    expect(openclawAgentFor(path.join(plain, "..", "unbound"), cfg)).toBeNull();
  });

  test("list shape (older configs) is read the same way; unset workspaces fall back to <default>/<id>", () => {
    const { cfg } = fixture((p) => ({ agents: { defaults: { workspace: "~/ws" }, list: [
      { id: "main" }, { id: "side" }, { id: "proj", workspace: p.project },
    ] } }));
    const all = readOpenClawAgents(cfg);
    expect(all.find((a) => a.id === "side")!.workspace).toBe(path.join(os.homedir(), "ws", "side"));
    expect(openclawAgentsOnProjects(cfg).map((a) => a.id)).toEqual(["proj"]);
  });

  test("a missing or unreadable config is an empty roster, never a throw", () => {
    const { root } = fixture(() => ({}));
    expect(readOpenClawAgents(path.join(root, "nope.json"))).toEqual([]);
    const bad = path.join(root, "bad.json"); fs.writeFileSync(bad, "{ not json");
    expect(readOpenClawAgents(bad)).toEqual([]);
  });

  test("isNirvanaProject needs the .nirvana directory, and the bind command is safe to paste", () => {
    const { project, plain } = fixture(() => ({}));
    expect(isNirvanaProject(project)).toBe(true);
    expect(isNirvanaProject(plain)).toBe(false);
    expect(openclawBindCommand("/x/y/my project", "my project!")).toBe("openclaw agents add my-project --workspace /x/y/my project --non-interactive");
  });
});
