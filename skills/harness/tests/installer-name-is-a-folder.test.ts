// installer-name-is-a-folder.test.ts: a manifest `name` is a folder name, never a path.
//
// Measured on 2026-11-17 against this commit: a squad whose `squad.yaml` said
// `name: "../../ESCAPED-SQUAD"` installed with `ok: true` and the whole tree
// landed OUTSIDE the squads library, recorded in the install manifest with
// that path. A pack item's `rename_to` reaches the same join, so it carried
// the same hole. `nrv uninstall` then removes whatever path the manifest
// recorded, which is why the refusal has to happen before the copy.
//
// Hermetic: NIRVANA_HOME and the four library roots point at a temp dir, and
// this file never spawns a CLI (a child would ignore the assignment).
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { install, readAssetMeta } from "../../_shared/lib/installer.ts";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";

const ROOTS: string[] = [];
const SAVED = { ...process.env };

function home(): string {
  const root = makeTempRoot("nrv-installer-name-");
  ROOTS.push(root);
  for (const d of ["squads", "businesses", "businesses/_library/dna", "source", "state", "logs"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  Object.assign(process.env, {
    HOME: root, USERPROFILE: root, NIRVANA_HOME: root,
    NIRVANA_STATE_DIR: path.join(root, "state"), HARNESS_LOGS_DIR: path.join(root, "logs"),
    SQUADS_DIR: path.join(root, "squads"), BUSINESSES_DIR: path.join(root, "businesses"),
    DNA_LIBRARY: path.join(root, "businesses", "_library", "dna"),
    NIRVANA_SCOPE: "global", NIRVANA_SCOPE_QUIET: "1", NIRVANA_NO_UPDATE_CHECK: "1",
  });
  return root;
}

function squad(dir: string, name: string): string {
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, "workflows"), { recursive: true });
  fs.writeFileSync(path.join(dir, "squad.yaml"), `name: ${name}\nversion: 1.0.0\nprotocol: "5.0"\ndescription: probe\n`, "utf8");
  fs.writeFileSync(path.join(dir, "agents", "solo.md"), "---\nname: solo\nmaxTurns: 4\ntools: [Read]\n---\n\n# solo\n", "utf8");
  fs.writeFileSync(path.join(dir, "MARKER.txt"), "attacker content\n", "utf8");
  return dir;
}

afterAll(() => {
  for (const r of ROOTS) try { removeDir(r); } catch { /* best effort */ }
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

describe("an install name never leaves the library", () => {
  test("a manifest name that is a path is refused before anything is copied", async () => {
    const root = home();
    const src = squad(path.join(root, "source", "bad"), `"../../ESCAPED-NAME${path.sep}"`);

    const result = await install({ source: src, type: "squad", skipReindex: true, quiet: true, skipValidate: true });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("plain slug");
    expect(fs.existsSync(path.join(root, "ESCAPED-NAME"))).toBe(false);
    expect(fs.readdirSync(path.join(root, "squads"))).toEqual([]);
  }, 60_000);

  test("a pack rename_to that is a path is refused, and the pack lands nowhere", async () => {
    const root = home();
    const packDir = path.join(root, "source", "pack");
    squad(path.join(packDir, "squads", "thing"), "thing");
    fs.writeFileSync(path.join(packDir, "pack.yaml"), [
      "name: probe-pack", "version: 1.0.0", "description: probe",
      "contents:", "  squads:", "    - path: squads/thing", '      rename_to: "../../ESCAPED-RENAME"', "",
    ].join("\n"), "utf8");

    const result = await install({ source: packDir, type: "pack", skipReindex: true, quiet: true, skipValidate: true });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("rename_to must be a plain slug");
    expect(fs.existsSync(path.join(root, "ESCAPED-RENAME"))).toBe(false);
    expect(fs.readdirSync(path.join(root, "squads"))).toEqual([]);
  }, 60_000);

  test("control: a plain slug still installs where the library expects it", async () => {
    const root = home();
    const src = squad(path.join(root, "source", "good"), "handmade");

    expect(readAssetMeta(src, "squad").name).toBe("handmade");
    const result = await install({ source: src, type: "squad", skipReindex: true, quiet: true, skipValidate: true });

    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(root, "squads", "handmade"));
    expect(fs.existsSync(path.join(root, "squads", "handmade", "MARKER.txt"))).toBe(true);
  }, 60_000);
});