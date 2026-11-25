// bot-note.test.ts — when a host's bot uses Nirvana-OS: on demand by default,
// always for a bot made for it or when the owner's setting says so.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { botUse, nirvanaBotRules, nirvanaBotWhen, nirvanaMemorySentence, withCurrentMemorySentence } from "../lib/bot-note.ts";
import { ensureOpenMausBotKnowsNirvana, openMausBotTopicText } from "../lib/openmausbot.ts";
import { openBotAutoSetup } from "../lib/openbot.ts";
import { Database } from "bun:sqlite";

afterEach(() => { delete process.env.NIRVANA_BOTS_USE; });

describe("how a bot uses Nirvana-OS", () => {
  test("on demand unless the bot was made for it", () => {
    expect(botUse("Ada")).toBe("on-demand");
    expect(botUse("Image Studio", "Makes images for web projects.")).toBe("on-demand");
    expect(botUse("Nirvana Prime")).toBe("always");
    expect(botUse("Ada", "Delivers finished work through nirvana-os.")).toBe("always");
    expect(botUse(null, null)).toBe("on-demand");
  });

  test("the owner's setting makes every bot use it always", () => {
    process.env.NIRVANA_BOTS_USE = "always";
    expect(botUse("Ada")).toBe("always");
  });
});

describe("the rules", () => {
  test("on demand: Nirvana-OS only when the request calls for it, and never brought up otherwise", () => {
    const text = nirvanaBotRules().join("\n");
    expect(text).toContain("Use Nirvana-OS only when the request calls for it");
    expect(text).toContain("businesses, squads or mind-clones");
    expect(text).toContain("do not bring Nirvana-OS up");
    expect(text).not.toContain("A concrete deliverable goes to Nirvana-OS");
    expect(nirvanaBotRules("on-demand")).toEqual(nirvanaBotRules());
  });

  test("always: every concrete deliverable goes through it", () => {
    const text = nirvanaBotRules("always").join("\n");
    expect(text).toContain("A concrete deliverable goes to Nirvana-OS");
    expect(text).not.toContain("only when the request calls for it");
  });

  test("the one-line description fits what a host lists", () => {
    for (const use of ["on-demand", "always"] as const) expect(`description: ${nirvanaBotWhen(use)}`.length).toBeLessThanOrEqual(160);
  });
});

describe("the pointer line a bot already had", () => {
  const pointer = "memory/nirvana-os.md";
  const old = `Nirvana-OS is installed on this computer. A request for a concrete deliverable goes through it; how is in ${pointer}.`;

  test("the old sentence is brought to the current one where it stands, date kept", () => {
    const memory = `# Memory\n\n- 2026-11-20: ${old}\n- the owner likes short answers\n`;
    expect(withCurrentMemorySentence(memory, pointer)).toBe(`# Memory\n\n- 2026-11-20: ${nirvanaMemorySentence(pointer)}\n- the owner likes short answers\n`);
    expect(withCurrentMemorySentence("# Memory\n- something else\n", pointer)).toBe("# Memory\n- something else\n");
  });

  test("an OpenMausBot bot prepared by an older engine is brought on demand, line and note", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-bot-note-"));
    try {
      fs.mkdirSync(path.join(dir, "memory"));
      fs.writeFileSync(path.join(dir, "memory", "nirvana-os.md"), openMausBotTopicText("always"));
      fs.writeFileSync(path.join(dir, "MEMORY.md"), `# Memory\n- ${old}\n`);
      const bot = { id: "b1", dir, name: "Ada", engine: "claude", memoryEnabled: true };
      expect(ensureOpenMausBotKnowsNirvana(bot)).toBe("refreshed");
      expect(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8")).toBe(`# Memory\n- ${nirvanaMemorySentence(pointer)}\n`);
      expect(fs.readFileSync(path.join(dir, "memory", "nirvana-os.md"), "utf8")).toBe(openMausBotTopicText("on-demand"));
      expect(ensureOpenMausBotKnowsNirvana(bot)).toBe("current");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

test("OpenBot: an agent made for Nirvana-OS gets the always section, any other the on-demand one", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-bot-note-ob-"));
  const saved = process.env.NIRVANA_OPENBOT_DB;
  try {
    for (const id of ["agent-prime", "agent-ada"]) fs.mkdirSync(path.join(home, "OpenBot", "Agents", id), { recursive: true });
    // With a home named, the app's database is looked for under that home.
    const dbDir = process.platform === "darwin" ? path.join(home, "Library", "Application Support", "OpenBot")
      : process.platform === "win32" ? path.join(home, "AppData", "Roaming", "OpenBot") : path.join(home, ".config", "OpenBot");
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, "openbot.db"));
    db.run("CREATE TABLE projection_agents (agent_id TEXT PRIMARY KEY, agent_json TEXT NOT NULL)");
    db.run("INSERT INTO projection_agents VALUES (?, ?)", ["agent-prime", JSON.stringify({ name: "Nirvana Prime", provider: "claude" })]);
    db.run("INSERT INTO projection_agents VALUES (?, ?)", ["agent-ada", JSON.stringify({ name: "Ada", description: "Writes code.", provider: "claude" })]);
    db.close();
    openBotAutoSetup(home);
    const read = (id: string) => fs.readFileSync(path.join(home, "OpenBot", "Agents", id, "AGENTS.md"), "utf8");
    expect(read("agent-prime")).toContain("A concrete deliverable goes to Nirvana-OS");
    expect(read("agent-ada")).toContain("Use Nirvana-OS only when the request calls for it");
    expect(read("agent-ada")).not.toContain("a whole project across several areas");
  } finally {
    if (saved === undefined) delete process.env.NIRVANA_OPENBOT_DB; else process.env.NIRVANA_OPENBOT_DB = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
