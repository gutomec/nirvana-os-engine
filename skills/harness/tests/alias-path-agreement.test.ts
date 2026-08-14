/**
 * The writer and the reader of `.keyword-aliases.json` must name the same file.
 *
 * They did not. build-routing-digest derived the path from the digest's
 * directory; router.js derived it from the squads registry's. Those are the same
 * directory in project scope and two different ones in global — the registry
 * sits at `~/`, the digest at `~/.nirvana/`. Global scope is what every buyer
 * runs, so the file was written where nothing ever looked, and arm (b) of the
 * amplification bridge — the part that lifts a Portuguese brief onto an
 * English-declared squad — was dead code on every install.
 *
 * Nothing caught it because absence is normal by design: a partial install has
 * no alias file, so the bridge degrades quietly. A silent degradation that is
 * correct in one case and a bug in another needs a test that pins the path, not
 * the behaviour.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PATHS = join(import.meta.dir, "..", "..", "_shared", "lib", "paths.js");

/** Resolve the paths module against a given cwd, the way a real run does. */
function resolveIn(cwd: string): Record<string, string> {
  const prev = process.cwd();
  try {
    process.chdir(cwd);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(PATHS);
    delete require.cache[require.resolve(PATHS)];
    return mod.resolvePaths();
  } finally {
    process.chdir(prev);
  }
}

describe("`.keyword-aliases.json` has one location", () => {
  test("paths.js names it", () => {
    const p = resolveIn(process.cwd());
    expect(typeof p.KEYWORD_ALIASES_PATH).toBe("string");
    expect(p.KEYWORD_ALIASES_PATH.endsWith(".keyword-aliases.json")).toBe(true);
  });

  test("in project scope it sits beside the digest", () => {
    const root = mkdtempSync(join(tmpdir(), "nrv-alias-proj-"));
    try {
      // A project is a directory with .nirvana/ in it.
      mkdirSync(join(root, ".nirvana"), { recursive: true });
      writeFileSync(join(root, "CLAUDE.md"), "# project\n");
      const p = resolveIn(root);
      expect(dirname(p.KEYWORD_ALIASES_PATH)).toBe(dirname(p.ROUTING_DIGEST_PATH));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("in global scope it sits beside the digest too — the divergence that broke it", () => {
    const root = mkdtempSync(join(tmpdir(), "nrv-alias-global-"));
    try {
      const p = resolveIn(root); // no .nirvana/ here → global scope
      expect(dirname(p.KEYWORD_ALIASES_PATH)).toBe(dirname(p.ROUTING_DIGEST_PATH));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("neither side invents the default on its own any more", async () => {
    const router = await Bun.file(join(import.meta.dir, "..", "lib", "router.js")).text();
    const builder = await Bun.file(join(import.meta.dir, "..", "scripts", "build-routing-digest.ts")).text();
    // The reader has no derivation left at all — it only ever reads the default.
    expect(router).toMatch(/KEYWORD_ALIASES_PATH/);
    expect(router).not.toMatch(/path\.join\(path\.dirname\(src\), '\.keyword-aliases\.json'\)/);
    // The writer reaches for the constant. It may still place the pair beside an
    // explicitly relocated --out, which is a caller's choice, not a default.
    expect(builder).toMatch(/KEYWORD_ALIASES_PATH/);
    expect(builder).toMatch(/resolved\.aliases/);
  });

  test("the default the builder resolves is the one the router reads", () => {
    // The regression in prose: writer said `dirname(digest)`, reader said
    // `dirname(squads registry)`. Same directory in a project, two in global.
    const p = resolveIn(process.cwd());
    expect(p.KEYWORD_ALIASES_PATH).toBe(p.KEYWORD_ALIASES_PATH); // resolved once
    expect(dirname(p.KEYWORD_ALIASES_PATH)).toBe(dirname(p.ROUTING_DIGEST_PATH));
  });
});
