// entity-memory.test.ts — memory lives in `.nirvana`, never inside the entity.
//
// The rule exists because a business, a squad and a mind-clone are the product:
// a pack update, a migration or a reinstall replaces those directories whole, so
// anything accumulated inside them is written on a surface built to be
// overwritten. These tests pin the two halves of that: where memory is read from,
// and that a shipped seed can populate it once without ever becoming the home.
// Runs with: bun test skills/_shared/tests
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MEMORY_FILES, entityMemoryDir, globalMemoryHome, memoryHomeFor, readEntityMemory, seedFromEntity,
} from "../lib/entity-memory.ts";

let tmp: string;
const savedHome = process.env.NIRVANA_HOME;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-entmem-"));
  // The global home is the real `~/.nirvana`; redirect it so these tests never
  // write into the owner's memory.
  process.env.NIRVANA_HOME = path.join(tmp, "home");
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.NIRVANA_HOME;
  else process.env.NIRVANA_HOME = savedHome;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** A project is a directory with a `.nirvana` in it — the same marker state-db
 *  resolves on, so rows and files never land in different homes. */
function project(): string {
  const root = path.join(tmp, "proj");
  fs.mkdirSync(path.join(root, ".nirvana"), { recursive: true });
  return root;
}

function business(slug: string, memory?: Record<string, string>): string {
  const dir = path.join(tmp, "businesses", slug);
  fs.mkdirSync(dir, { recursive: true });
  if (memory) {
    fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
    for (const [name, text] of Object.entries(memory)) {
      fs.writeFileSync(path.join(dir, "memory", name), text);
    }
  }
  return dir;
}

// The placement is a judgement about the fact, never an inference from the cwd.
// Project scope decides only where ENTITIES come from (~/businesses vs the
// project's own); it does not decide where knowledge about them belongs.
describe("memory placement is chosen, not derived", () => {
  test("global is the machine's .nirvana, whatever directory the call came from", () => {
    const root = project();
    expect(memoryHomeFor("global")).toBe(path.join(process.env.NIRVANA_HOME!, ".nirvana"));
    // Passing a project root does not drag a global fact into it.
    expect(memoryHomeFor("global", root)).toBe(path.join(process.env.NIRVANA_HOME!, ".nirvana"));
    expect(entityMemoryDir("businesses", "acme", "global"))
      .toBe(path.join(globalMemoryHome(), "memory", "businesses", "acme"));
  });

  test("project is the project's .nirvana, and refuses to exist without one", () => {
    const root = project();
    expect(memoryHomeFor("project", root)).toBe(path.join(root, ".nirvana"));
    expect(entityMemoryDir("businesses", "acme", "project", root))
      .toBe(path.join(root, ".nirvana", "memory", "businesses", "acme"));
    // Silently writing a project fact into the machine's memory would leak it
    // into every other project, so this throws instead of falling back.
    expect(() => memoryHomeFor("project")).toThrow(/refusing to fall back/);
  });

  test("neither home ever points inside the entity", () => {
    const root = project();
    for (const dir of [
      entityMemoryDir("businesses", "acme", "global"),
      entityMemoryDir("businesses", "acme", "project", root),
    ]) {
      expect(dir).toContain(path.join(".nirvana", "memory"));
      expect(dir).not.toContain(path.join("businesses", "acme", "memory"));
    }
  });
});

describe("readEntityMemory", () => {
  test("reads BOTH curated files — learned.md had a reader in the docs and none in the code", () => {
    const root = project();
    const dir = entityMemoryDir("businesses", "acme", "project", root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "permanent.md"), "- O cliente aprova por WhatsApp. PERM-MARKER");
    fs.writeFileSync(path.join(dir, "learned.md"), "- Nunca prometer prazo em dezembro. LEARN-MARKER");

    const mem = readEntityMemory("businesses", "acme", { projectRoot: root });
    const proj = mem.scopes.find((x) => x.scope === "project")!;
    expect(proj.files).toEqual([...MEMORY_FILES]);
    expect(mem.block).toContain("PERM-MARKER");
    expect(mem.block).toContain("LEARN-MARKER");
    // The block names where the memory lives, so a reader can go to the source,
    // and labels the scope so the agent can tell a project fact from a global one.
    expect(mem.block).toContain(dir);
    expect(mem.block).toContain("DESTE PROJETO");
    // And it tells the agent the choice is theirs to make when recording.
    expect(mem.block).toContain("você decide o escopo");
  });

  test("nothing curated yields no block at all", () => {
    const root = project();
    expect(readEntityMemory("businesses", "ghost", { projectRoot: root }).block).toBe("");
  });

  test("a seeded stub is not curated knowledge and never occupies the prompt", () => {
    const root = project();
    const dir = entityMemoryDir("businesses", "acme", "project", root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "permanent.md"), "# Permanent memory");
    fs.writeFileSync(path.join(dir, "learned.md"), "# Learned memory\n\n_(vazio)_");
    expect(readEntityMemory("businesses", "acme", { projectRoot: root }).block).toBe("");
  });

  // The defect this replaces: an 8,000-char clamp with a four-word marker that
  // named neither the size nor the path, so a business past the ceiling honored
  // a fraction of its own record and nothing said which fraction.
  test("a large memory arrives WHOLE, and says so instead of being cut", () => {
    const root = project();
    const dir = entityMemoryDir("businesses", "big", "project", root);
    fs.mkdirSync(dir, { recursive: true });
    const body = "- decisão registrada em execução anterior.\n".repeat(600);
    fs.writeFileSync(path.join(dir, "permanent.md"), body + "TAIL-MARKER");

    const mem = readEntityMemory("businesses", "big", { projectRoot: root, noticeBytes: 8_000 });
    expect(mem.bytes).toBeGreaterThan(8_000);
    // The last line survives: nothing was sliced off the end.
    expect(mem.block).toContain("TAIL-MARKER");
    expect(mem.block).not.toContain("memory truncated");
    expect(mem.block).toContain("chega **inteira**");
    expect(mem.block).toContain(`acima do ponto de atenção de 8000`);
  });
});

describe("seedFromEntity — a shipped memory populates the home once, then stops mattering", () => {
  test("the seed fills an empty home and the read comes from the home", () => {
    const root = project();
    const bizDir = business("acme", { "permanent.md": "- fato sazonal. SEED-MARKER" });

    const mem = readEntityMemory("businesses", "acme", { projectRoot: root, entityDir: bizDir });
    expect(mem.seeded).toEqual(["permanent.md"]);
    expect(mem.block).toContain("SEED-MARKER");
    // It landed in `.nirvana`, not in the business.
    const home = path.join(entityMemoryDir("businesses", "acme", "global"), "permanent.md");
    expect(fs.existsSync(home)).toBe(true);
  });

  test("seeding is idempotent and never overwrites what the owner accumulated", () => {
    const root = project();
    const bizDir = business("acme", { "permanent.md": "- SEED-MARKER" });
    readEntityMemory("businesses", "acme", { projectRoot: root, entityDir: bizDir });

    // The owner edits their memory; then a pack update rewrites the seed.
    const home = path.join(entityMemoryDir("businesses", "acme", "global"), "permanent.md");
    fs.writeFileSync(home, "- OWNER-MARKER, escrito depois da instalação");
    fs.writeFileSync(path.join(bizDir, "memory", "permanent.md"), "- SEED-V2-MARKER");

    const after = readEntityMemory("businesses", "acme", { projectRoot: root, entityDir: bizDir });
    expect(after.seeded).toEqual([]);
    expect(after.block).toContain("OWNER-MARKER");
    // This is the whole point: the update did not overwrite the owner's memory.
    expect(after.block).not.toContain("SEED-V2-MARKER");
  });

  test("seeding never writes back into the entity", () => {
    const root = project();
    const bizDir = business("acme", { "permanent.md": "- SEED-MARKER" });
    readEntityMemory("businesses", "acme", { projectRoot: root, entityDir: bizDir });
    // The entity keeps exactly what the pack put there, and gains nothing.
    expect(fs.readdirSync(path.join(bizDir, "memory")).sort()).toEqual(["permanent.md"]);
    expect(fs.readFileSync(path.join(bizDir, "memory", "permanent.md"), "utf8")).toBe("- SEED-MARKER");
  });

  test("a stub seed is not worth carrying and leaves the home empty", () => {
    const root = project();
    const bizDir = business("acme", { "permanent.md": "# Permanent memory\n" });
    expect(seedFromEntity("businesses", "acme", bizDir)).toEqual([]);
    expect(fs.existsSync(entityMemoryDir("businesses", "acme", "global"))).toBe(false);
  });
});
