// list-clones-project-scope.test.ts — a project's own clones are listed.
//
// list-clones read only the global DNA library, so a clone that lives in
// `<project>/.nirvana/mind-clones` was invisible to it while index-clones and
// dispatch resolved it fine.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT = path.join(import.meta.dir, "..", "scripts", "list-clones.ts");
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

describe("list-clones", () => {
  test("lists the clones of the project it runs in", () => {
    const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-list-clones-")));
    roots.push(project);
    fs.mkdirSync(path.join(project, ".nirvana", "mind-clones", "jane-doe"), { recursive: true });
    fs.writeFileSync(path.join(project, ".nirvana", "project.yaml"), "schema_version: nirvana.project/v1alpha1\n");
    fs.writeFileSync(path.join(project, ".nirvana", "mind-clones", "jane-doe", "MANIFEST.yaml"),
      'manifest:\n  name: jane-doe\n  display_name: "Jane Doe"\n  version: 1.0.0\n  category: design\n');
    const r = Bun.spawnSync([process.execPath, SCRIPT], {
      cwd: project,
      env: { ...process.env, NIRVANA_SCOPE: "project", NIRVANA_PROJECT_ROOT: project },
    });
    expect(r.stdout.toString()).toContain("jane-doe");
  });
});
