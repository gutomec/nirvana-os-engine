// catalog-is-stable.test.ts — the survey is a file, and the same library
// produces the same bytes.
//
// Phase 3 Pass 1 reads every business and squad so nothing the machine owns can
// be invisible to the decision. On a maintainer-sized library that is ~45k
// tokens, and the only thing that makes it affordable to read EVERY run is a
// provider's prompt cache — which holds a stable file and does not hold command
// output whose ordering and scaffolding drift.
//
// So "sorted and deterministic" is not tidiness here, it is the mechanism. The
// first version of this generator wrote to stdout and then called
// process.exit(0), which truncated the write at the pipe buffer: 128 KiB, every
// squad cut off, and two consecutive runs producing different bytes. It looked
// exactly like non-determinism and it was a missing drain.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT = path.join(import.meta.dir, "..", "scripts", "build-catalog.ts");

/** A fixture library, so this runs on a clean runner with no real entities. */
function fixture(): { root: string; env: Record<string, string> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-catalog-"));
  const mk = (kind: "businesses" | "squads", slug: string, description: string) => {
    const dir = path.join(root, kind, slug);
    fs.mkdirSync(dir, { recursive: true });
    const file = kind === "businesses" ? "business.yaml" : "squad.yaml";
    fs.writeFileSync(path.join(dir, file), `name: ${slug}\ndescription: >-\n  ${description}\n`);
  };
  // Deliberately out of alphabetical order on disk.
  mk("businesses", "zulu-co", "Builds production software end to end, from discovery to a deployed service with observability.");
  mk("businesses", "alpha-co", "Writes and publishes long-form non-fiction in the voice of a named expert.");
  mk("squads", "zebra-squad", "Generates photoreal imagery under art direction, with a named visual canon.");
  mk("squads", "aardvark-squad", "Audits an Obsidian vault for broken wikilinks and inconsistent frontmatter.");
  return {
    root,
    env: { ...process.env, BUSINESSES_DIR: path.join(root, "businesses"), SQUADS_DIR: path.join(root, "squads"), NIRVANA_HOME: root },
  };
}

const run = (env: Record<string, string>) =>
  spawnSync("bun", [SCRIPT, "--stdout"], { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });

describe("the same library produces the same bytes", () => {
  const { root, env } = fixture();
  const a = run(env), b = run(env);

  test("two runs are byte-identical", () => {
    expect(a.status, a.stderr).toBe(0);
    expect(b.stdout).toBe(a.stdout);
  });

  test("entries are sorted, not in directory order", () => {
    expect(a.stdout.indexOf("alpha-co")).toBeLessThan(a.stdout.indexOf("zulu-co"));
    expect(a.stdout.indexOf("aardvark-squad")).toBeLessThan(a.stdout.indexOf("zebra-squad"));
  });

  test("the write is not truncated — the whole library is there", () => {
    for (const slug of ["alpha-co", "zulu-co", "aardvark-squad", "zebra-squad"]) {
      expect(a.stdout).toContain(slug);
    }
  });

  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* the OS reclaims tmp */ }
});

describe("what a line carries", () => {
  const { root, env } = fixture();
  const out = run(env).stdout;

  test("the full description, folded scalar and all", () => {
    // `description: >-` is a folded scalar: a grep returns its first physical
    // line, which is why this is parsed.
    expect(out).toContain("Builds production software end to end, from discovery to a deployed service with observability.");
  });

  test("and nothing that only matters once a finalist is open", () => {
    for (const noise of ["produces:", "domains:", "protocol ", "caps="]) expect(out).not.toContain(noise);
  });

  test("both pillars are sectioned and counted", () => {
    expect(out).toMatch(/## businesses \(2\)/);
    expect(out).toMatch(/## squads \(2\)/);
  });

  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* the OS reclaims tmp */ }
});
