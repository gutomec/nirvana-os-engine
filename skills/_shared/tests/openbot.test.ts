// openbot.test.ts — what the engine does on its own for the agents of OpenBot
// (Nightly Labs): its section in each agent's instruction file, the owner's
// way to turn it off, and recognising an agent's workspace. Pure filesystem,
// plus a SQLite file shaped like the app's for the names; OpenBot is not called.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  OPENBOT_BLOCK_BEGIN, OPENBOT_BLOCK_END, listOpenBotAgents, openBotAgentAt, openBotAgentLabels, openBotAutoSetup,
  openBotBlockText, openBotDatabasePath, openBotInstructionFile, openBotRoot, openBotUsesNirvana,
} from "../lib/openbot.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-openbot-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** A home with OpenBot agent workspaces; each value is that agent's AGENTS.md, or null for none. */
function makeHome(name: string, agents: Record<string, string | null>, servers: Record<string, string[]> = {}): string {
  const home = path.join(root, name);
  for (const [id, text] of Object.entries(agents)) {
    const dir = path.join(home, "OpenBot", "Agents", id);
    fs.mkdirSync(dir, { recursive: true });
    if (text !== null) fs.writeFileSync(path.join(dir, "AGENTS.md"), text);
  }
  for (const [server, ids] of Object.entries(servers)) {
    for (const id of ids) fs.mkdirSync(path.join(home, "OpenBot", "Servers", server, "Agents", id), { recursive: true });
  }
  return home;
}
const agentFile = (home: string, id: string, name = "AGENTS.md") => path.join(home, "OpenBot", "Agents", id, name);
const read = (file: string) => fs.readFileSync(file, "utf8");
const outcomes = (home: string) => openBotAutoSetup(home).agents.map((a) => [a.agent.id, a.outcome]);

describe("the agents on a machine", () => {
  test("no OpenBot at all: nothing listed, nothing written, no error", () => {
    const home = path.join(root, "none");
    fs.mkdirSync(home);
    expect(listOpenBotAgents(home)).toEqual([]);
    expect(openBotAutoSetup(home).agents).toEqual([]);
    expect(fs.existsSync(path.join(home, "OpenBot"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".nirvana"))).toBe(false);
  });

  test("this computer's agents first, then each local server's; a stray name is not an agent", () => {
    const home = makeHome("list", { "agent-b": null, "agent-a": null }, { "srv-1": ["agent-c"] });
    fs.writeFileSync(path.join(home, "OpenBot", "Agents", "notes.txt"), "x");
    fs.mkdirSync(path.join(home, "OpenBot", "Agents", "bad name"));
    expect(listOpenBotAgents(home).map((a) => [a.id, a.server])).toEqual([
      ["agent-a", null], ["agent-b", null], ["agent-c", "srv-1"],
    ]);
  });

  test("the root moves with NIRVANA_OPENBOT_DIR only when no home is named", () => {
    const before = process.env.NIRVANA_OPENBOT_DIR;
    process.env.NIRVANA_OPENBOT_DIR = "/somewhere/else";
    try {
      expect(openBotRoot()).toBe("/somewhere/else");
      expect(openBotRoot("/h")).toBe(path.join("/h", "OpenBot"));
    } finally { process.env.NIRVANA_OPENBOT_DIR = before; }
  });
});

describe("the section in the instruction file", () => {
  test("appended after the owner's text, which stays as it was; owner-only file", () => {
    const own = "# Ada\n\nYou review pull requests.\n";
    const home = makeHome("append", { "agent-1": own });
    expect(outcomes(home)).toEqual([["agent-1", "written"]]);
    const text = read(agentFile(home, "agent-1"));
    expect(text.startsWith("# Ada\n\nYou review pull requests.\n\n" + OPENBOT_BLOCK_BEGIN)).toBe(true);
    expect(text.endsWith(OPENBOT_BLOCK_END + "\n")).toBe(true);
    expect(text).toContain("nrv dispatch --auto --exec");
    expect(text).toContain("attach_files_to_response");
  });

  test("an agent with no instruction file gets AGENTS.md, mode 0600", () => {
    const home = makeHome("empty", { "agent-1": null });
    expect(outcomes(home)).toEqual([["agent-1", "written"]]);
    expect(read(agentFile(home, "agent-1"))).toBe(openBotBlockText());
    if (process.platform !== "win32") expect(fs.statSync(agentFile(home, "agent-1")).mode & 0o777).toBe(0o600);
  });

  test("CLAUDE.md is used when it is the only file, as OpenBot does", () => {
    const home = makeHome("claude", { "agent-1": null });
    fs.writeFileSync(agentFile(home, "agent-1", "CLAUDE.md"), "Rules.\n");
    expect(openBotInstructionFile(path.dirname(agentFile(home, "agent-1")))).toBe(agentFile(home, "agent-1", "CLAUDE.md"));
    openBotAutoSetup(home);
    expect(read(agentFile(home, "agent-1", "CLAUDE.md"))).toContain(OPENBOT_BLOCK_BEGIN);
    expect(fs.existsSync(agentFile(home, "agent-1"))).toBe(false);
  });

  test("a second run changes nothing; an older text under the marker is refreshed in place", () => {
    const home = makeHome("refresh", { "agent-1": "Top.\n" });
    openBotAutoSetup(home);
    const once = read(agentFile(home, "agent-1"));
    expect(outcomes(home)).toEqual([["agent-1", "current"]]);
    expect(read(agentFile(home, "agent-1"))).toBe(once);
    const old = once.replace(OPENBOT_BLOCK_BEGIN, "<!-- nirvana-os:openbot:v0 -->").replace("Show the delivery", "Old line") + "Owner added this later.\n";
    fs.writeFileSync(agentFile(home, "agent-1"), old);
    expect(outcomes(home)).toEqual([["agent-1", "refreshed"]]);
    const after = read(agentFile(home, "agent-1"));
    expect(after).toBe(once + "Owner added this later.\n");
    expect(after.match(/nirvana-os:openbot:v/g)?.length).toBe(1);
  });

  test("an owner who deletes the section has turned it off: it is not put back", () => {
    const home = makeHome("off", { "agent-1": "Mine.\n" });
    openBotAutoSetup(home);
    fs.writeFileSync(agentFile(home, "agent-1"), "Mine.\n");
    expect(outcomes(home)).toEqual([["agent-1", "turned-off"]]);
    expect(read(agentFile(home, "agent-1"))).toBe("Mine.\n");
    expect(openBotUsesNirvana(listOpenBotAgents(home)[0])).toBe(false);
  });

  test("Windows line endings are kept", () => {
    const home = makeHome("crlf", { "agent-1": "A\r\nB\r\n" });
    openBotAutoSetup(home);
    const text = read(agentFile(home, "agent-1"));
    expect(text.startsWith("A\r\nB\r\n\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });

  test("a file that cannot be written is skipped, and the others are still prepared", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const home = makeHome("ro", { "agent-1": null, "agent-2": null });
    const locked = path.dirname(agentFile(home, "agent-1"));
    fs.chmodSync(locked, 0o500);
    try {
      expect(outcomes(home)).toEqual([["agent-1", "skipped"], ["agent-2", "written"]]);
    } finally { fs.chmodSync(locked, 0o700); }
  });
});

describe("recognising an agent's workspace", () => {
  test("the workspace and anything under it; not the root, not elsewhere", () => {
    const home = makeHome("at", { "agent-1": null });
    const ws = path.dirname(agentFile(home, "agent-1"));
    fs.mkdirSync(path.join(ws, "reports"));
    expect(openBotAgentAt(ws, home)?.id).toBe("agent-1");
    expect(openBotAgentAt(path.join(ws, "reports"), home)?.id).toBe("agent-1");
    expect(openBotAgentAt(path.join(home, "OpenBot", "Agents"), home)).toBeNull();
    expect(openBotAgentAt(root, home)).toBeNull();
  });
});

describe("names from the app's database", () => {
  test("read only from projection_agents; a missing file or another schema gives none", () => {
    const home = path.join(root, "db");
    const file = openBotDatabasePath(home);
    expect(openBotAgentLabels(home).size).toBe(0);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.run("CREATE TABLE projection_agents (agent_id TEXT PRIMARY KEY, agent_json TEXT NOT NULL)");
    db.run("INSERT INTO projection_agents VALUES (?, ?)", ["agent-1", JSON.stringify({ name: "Ada", provider: "claude" })]);
    db.run("INSERT INTO projection_agents VALUES (?, ?)", ["agent-2", "{}"]);
    db.close();
    const labels = openBotAgentLabels(home);
    expect(labels.get("agent-1")).toEqual({ name: "Ada", provider: "claude" });
    expect(labels.get("agent-2")).toEqual({ name: null, provider: null });
    fs.writeFileSync(file, "not a database");
    expect(openBotAgentLabels(home).size).toBe(0);
  });
});
