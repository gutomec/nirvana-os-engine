// openmausbot.test.ts — what the engine does on its own for OpenMausBot's
// bots: the topic file, the line in MEMORY.md, and recognising a bot's private
// folders. Pure filesystem; OpenMausBot is not called.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  OMB_TOPIC_MARKER, ensureOpenMausBotKnowsNirvana, listOpenMausBots, openMausBotAt, openMausBotAutoSetup,
  openMausBotDataDir, openMausBotTopicText, openMausBotUsesNirvana,
} from "../lib/openmausbot.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-openmausbot-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// The seed OpenMausBot writes for a new bot (server/workspace.ts, English).
const SEED = "# Memory\n\nDurable notes this bot keeps between tasks. The first 200 lines\nload at the start of every session — keep this file short and curated.\nLonger notes belong in memory/<topic>.md files, read on demand.\n";
const LINE = "- Nirvana-OS is installed on this computer. When to use it, and how, is in memory/nirvana-os.md.";

type Rec = { id: unknown; name?: string; memoryEnabled?: boolean; modelSelection?: unknown };

/** A home with a bots.json; `ran` names the bots that already had a first turn. */
function makeHome(name: string, bots: Rec[], ran: Record<string, string> = {}): string {
  const home = path.join(root, name);
  const data = path.join(home, ".openmausbot");
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "bots.json"), JSON.stringify(bots));
  for (const [id, memory] of Object.entries(ran)) {
    fs.mkdirSync(path.join(data, "workspaces", id, "memory"), { recursive: true });
    fs.writeFileSync(path.join(data, "workspaces", id, "MEMORY.md"), memory);
  }
  return home;
}
const ws = (home: string, id: string, ...rest: string[]) => path.join(home, ".openmausbot", "workspaces", id, ...rest);
const read = (file: string) => fs.readFileSync(file, "utf8");

describe("the bots on a machine", () => {
  test("no OpenMausBot at all: nothing listed, nothing written, no error", () => {
    const home = path.join(root, "none");
    fs.mkdirSync(home);
    expect(listOpenMausBots(home)).toEqual([]);
    expect(openMausBotAutoSetup(home).bots).toEqual([]);
    expect(fs.existsSync(path.join(home, ".openmausbot"))).toBe(false);
  });

  test("bots.json is read for id, name, engine and the memory switch; a bad record is not a bot", () => {
    const home = makeHome("list", [
      { id: "b2", name: "Scout", modelSelection: { instanceId: "claude", model: "x" }, memoryEnabled: false },
      { id: "b1", name: "Atlas", modelSelection: { instanceId: "codex" } },
      { id: "../escape", name: "Bad" },
      { id: 7 },
      "not a record" as unknown as Rec,
    ]);
    expect(listOpenMausBots(home).map((b) => [b.id, b.name, b.engine, b.memoryEnabled])).toEqual([
      ["b1", "Atlas", "codex", true],
      ["b2", "Scout", "claude", false],
    ]);
  });

  test("an unreadable or non-array bots.json lists nothing", () => {
    const home = makeHome("broken", []);
    fs.writeFileSync(path.join(home, ".openmausbot", "bots.json"), "{ not json");
    expect(listOpenMausBots(home)).toEqual([]);
    fs.writeFileSync(path.join(home, ".openmausbot", "bots.json"), '{"bots":[]}');
    expect(listOpenMausBots(home)).toEqual([]);
  });

  test("the data folder follows OMB_DATA_DIR, and the engine's own variable before it", () => {
    const saved = { n: process.env.NIRVANA_OPENMAUSBOT_DIR, o: process.env.OMB_DATA_DIR };
    try {
      delete process.env.NIRVANA_OPENMAUSBOT_DIR;
      process.env.OMB_DATA_DIR = path.join(root, "moved");
      expect(openMausBotDataDir()).toBe(path.join(root, "moved"));
      process.env.NIRVANA_OPENMAUSBOT_DIR = path.join(root, "test-home");
      expect(openMausBotDataDir()).toBe(path.join(root, "test-home"));
      expect(openMausBotDataDir("/h")).toBe(path.join("/h", ".openmausbot"));
    } finally {
      for (const [k, v] of [["NIRVANA_OPENMAUSBOT_DIR", saved.n], ["OMB_DATA_DIR", saved.o]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

describe("the note", () => {
  test("a bot that already ran gets the topic file and one undated line after the seed", () => {
    const home = makeHome("ran", [{ id: "b1", name: "Atlas" }], { b1: SEED });
    expect(openMausBotAutoSetup(home).bots.map((b) => b.outcome)).toEqual(["written"]);
    expect(read(ws(home, "b1", "memory", "nirvana-os.md"))).toBe(openMausBotTopicText());
    expect(read(ws(home, "b1", "MEMORY.md"))).toBe(`${SEED}\n${LINE}\n`);
    expect(openMausBotUsesNirvana(listOpenMausBots(home)[0])).toBe(true);
  });

  test("the line goes before the first existing entry and carries no date", () => {
    const memory = `${SEED}\n- 2026-09-25 · from chat "Plans" (noticed) · The person is vegetarian\n`;
    const home = makeHome("entries", [{ id: "b1" }], { b1: memory });
    openMausBotAutoSetup(home);
    const lines = read(ws(home, "b1", "MEMORY.md")).split("\n");
    const at = lines.indexOf(LINE);
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toStartWith("- 2026-09-25");
    // OpenMausBot's upkeep moves only dated entries (`- YYYY-MM-DD · ...`).
    expect(/^- \d{4}-\d{2}-\d{2} · /.test(LINE)).toBe(false);
  });

  test("a bot that never ran gets its folder, with a MEMORY.md holding the line", () => {
    const home = makeHome("new", [{ id: "fresh", name: "New" }]);
    expect(openMausBotAutoSetup(home).bots.map((b) => b.outcome)).toEqual(["written"]);
    expect(read(ws(home, "fresh", "MEMORY.md"))).toBe(`# Memory\n\n${LINE}\n`);
    expect(fs.existsSync(ws(home, "fresh", "memory", "nirvana-os.md"))).toBe(true);
  });

  test.skipIf(process.platform === "win32")("the files are owner-only, like the ones OpenMausBot writes", () => {
    const home = makeHome("modes", [{ id: "m1" }]);
    openMausBotAutoSetup(home);
    expect(fs.statSync(ws(home, "m1", "memory", "nirvana-os.md")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(ws(home, "m1", "MEMORY.md")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(ws(home, "m1", "memory")).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(ws(home, "m1")).some((n) => n.includes("nrv-tmp"))).toBe(false);
  });

  test("the topic file opens with the frontmatter OpenMausBot lists, the marker after it", () => {
    const text = openMausBotTopicText();
    expect(text).toStartWith("---\ntitle: Nirvana-OS on this computer\ndescription: ");
    const header = /^---\n([\s\S]*?)\n---\n/.exec(text)![1];
    const description = /^description: (.*)$/m.exec(header)![1];
    expect(description.length).toBeLessThanOrEqual(160); // the host cuts a longer one
    expect(text.indexOf(OMB_TOPIC_MARKER)).toBeGreaterThan(text.indexOf("\n---\n"));
    expect(text).toContain("nrv dispatch --auto --exec");
    expect(text).toContain("in the words and the language it came in");
    expect(text).toContain("attach_file");
  });

  test("a second run changes nothing", () => {
    const home = makeHome("twice", [{ id: "b1" }], { b1: SEED });
    openMausBotAutoSetup(home);
    const before = read(ws(home, "b1", "MEMORY.md"));
    expect(openMausBotAutoSetup(home).bots.map((b) => b.outcome)).toEqual(["current"]);
    expect(read(ws(home, "b1", "MEMORY.md"))).toBe(before);
  });

  test("an owner who removes the line turned the note off, and it stays off", () => {
    const home = makeHome("off", [{ id: "b1" }], { b1: SEED });
    openMausBotAutoSetup(home);
    fs.writeFileSync(ws(home, "b1", "MEMORY.md"), SEED);
    expect(openMausBotAutoSetup(home).bots.map((b) => b.outcome)).toEqual(["current"]);
    expect(read(ws(home, "b1", "MEMORY.md"))).toBe(SEED);
    expect(openMausBotUsesNirvana(listOpenMausBots(home)[0])).toBe(false);
  });

  test("an older text under the engine's marker is refreshed; the line is not added again", () => {
    const home = makeHome("old", [{ id: "b1" }], { b1: SEED });
    fs.writeFileSync(ws(home, "b1", "memory", "nirvana-os.md"), "---\ntitle: old\n---\n<!-- nirvana-os:openmausbot:v0 -->\nold text\n");
    expect(openMausBotAutoSetup(home).bots.map((b) => b.outcome)).toEqual(["refreshed"]);
    expect(read(ws(home, "b1", "memory", "nirvana-os.md"))).toBe(openMausBotTopicText());
    expect(read(ws(home, "b1", "MEMORY.md"))).toBe(SEED);
  });

  test("a nirvana-os.md that is not the engine's is somebody else's note: left as it is", () => {
    const home = makeHome("theirs", [{ id: "b1" }], { b1: SEED });
    fs.writeFileSync(ws(home, "b1", "memory", "nirvana-os.md"), "my own notes about nirvana\n");
    expect(openMausBotAutoSetup(home).bots.map((b) => b.outcome)).toEqual(["skipped"]);
    expect(read(ws(home, "b1", "memory", "nirvana-os.md"))).toBe("my own notes about nirvana\n");
    expect(read(ws(home, "b1", "MEMORY.md"))).toBe(SEED);
  });

  test("a bot with memory switched off is not touched", () => {
    const home = makeHome("nomem", [{ id: "b1", memoryEnabled: false }], { b1: SEED });
    expect(ensureOpenMausBotKnowsNirvana(listOpenMausBots(home)[0])).toBe("memory-off");
    expect(fs.existsSync(ws(home, "b1", "memory", "nirvana-os.md"))).toBe(false);
    expect(read(ws(home, "b1", "MEMORY.md"))).toBe(SEED);
  });

  test("a CRLF MEMORY.md keeps its line endings", () => {
    const home = makeHome("crlf", [{ id: "b1" }], { b1: "# Memory\r\n\r\n- a fact\r\n" });
    openMausBotAutoSetup(home);
    expect(read(ws(home, "b1", "MEMORY.md"))).toBe(`# Memory\r\n\r\n${LINE}\r\n- a fact\r\n`);
  });
});

describe("a bot's private folders", () => {
  const home = makeHome("where", [{ id: "b1", name: "Atlas" }, { id: "b10", name: "Other" }], { b1: SEED });
  const data = path.join(home, ".openmausbot");
  fs.mkdirSync(path.join(data, "task-workspaces", "b1", "thread-9", "deep"), { recursive: true });
  fs.mkdirSync(path.join(data, "task-workspaces", "ghost", "t"), { recursive: true });

  test("its own folder and a conversation's folder are the bot's", () => {
    expect(openMausBotAt(ws(home, "b1"), home)?.name).toBe("Atlas");
    expect(openMausBotAt(ws(home, "b1", "memory"), home)?.id).toBe("b1");
    expect(openMausBotAt(path.join(data, "task-workspaces", "b1", "thread-9", "deep"), home)?.id).toBe("b1");
  });

  test("the data folder itself, a folder of no listed bot and anywhere else are nobody's", () => {
    expect(openMausBotAt(data, home)).toBeNull();
    expect(openMausBotAt(path.join(data, "workspaces"), home)).toBeNull();
    expect(openMausBotAt(path.join(data, "task-workspaces", "ghost", "t"), home)).toBeNull();
    expect(openMausBotAt(root, home)).toBeNull();
    expect(openMausBotAt(path.join(home, "project"), home)).toBeNull();
  });
});
