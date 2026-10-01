// run-session.test.ts — the session file a squad or agent-x run leaves beside
// its scaffold, and the finder `nrv revise`, `nrv clean` and Glance share.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findRunSessions, writeWorkerSession } from "../lib/run-session.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
function runFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-run-session-"));
  dirs.push(dir);
  return dir;
}

describe("writeWorkerSession", () => {
  test("writes the business path's fields plus the target, in the worker's scaffold dir", () => {
    const run = runFolder();
    const projectDir = path.join(run, "squads", "copy-squad");
    const { file, data } = writeWorkerSession({
      projectId: "p1", kind: "squad", slug: "copy-squad", runtime: "codex", sessionId: "sess-1",
      projectDir, projectRoot: "/project", outputsRoot: path.join(run, "deliverables"), workspace: run,
    });
    expect(file).toBe(path.join(projectDir, "session.json"));
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk).toEqual(data);
    expect(onDisk).toMatchObject({
      project_id: "p1", target_kind: "squad", target_slug: "copy-squad", runtime: "codex", session_id: "sess-1",
      project_dir: projectDir, project_root: "/project", outputs_root: path.join(run, "deliverables"), workspace: run, manifest: null,
    });
    expect(Number.isFinite(Date.parse(onDisk.created_at))).toBe(true);
  });

  test("a runtime that returned no session id is recorded as null, never invented", () => {
    const run = runFolder();
    const { data } = writeWorkerSession({
      projectId: "p2", kind: "agent-x", slug: "agent-x", runtime: "gemini-cli", sessionId: null,
      projectDir: path.join(run, "agent-x"), projectRoot: run, outputsRoot: path.join(run, "deliverables"), workspace: null,
    });
    expect(data.session_id).toBeNull();
  });
});

describe("findRunSessions", () => {
  test("finds every worker's session of a run folder: businesses, then squads by name, then agent-x", () => {
    const run = runFolder();
    for (const dir of [["squads", "zeta"], ["squads", "alpha"], ["businesses", "biz"], ["agent-x"]]) {
      fs.mkdirSync(path.join(run, ...dir), { recursive: true });
      fs.writeFileSync(path.join(run, ...dir, "session.json"), "{}");
    }
    // A squad scaffold without a session (it never ran) is not a session.
    fs.mkdirSync(path.join(run, "squads", "never-ran"), { recursive: true });
    expect(findRunSessions(run).map(s => [s.kind, s.slug, path.relative(run, s.file).split(path.sep).join("/")])).toEqual([
      ["business", "biz", "businesses/biz/session.json"],
      ["squad", "alpha", "squads/alpha/session.json"],
      ["squad", "zeta", "squads/zeta/session.json"],
      ["agent-x", "agent-x", "agent-x/session.json"],
    ]);
  });

  test("a folder that is not a run, or does not exist, has none", () => {
    expect(findRunSessions(runFolder())).toEqual([]);
    expect(findRunSessions(path.join(os.tmpdir(), "nrv-run-session-missing-folder"))).toEqual([]);
  });
});
