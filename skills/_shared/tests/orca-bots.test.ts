// orca-bots.test.ts — what the engine does on its own for Orca's bots and
// projects: the bot's memory note, the project's setup script and the one-time
// workspace registration. Pure filesystem; no Orca is called.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BOT_TOPIC_MARKER, botTopicText, botUsesNirvana, ensureBotKnowsNirvana, ensureOrcaSetupScript, ensureOrcaWorkspace,
  listOrcaBots, orcaAutoSetup, orcaBotAt, orcaBotsRoot, orcaWorktreeRootFor, orcaYamlText,
} from "../lib/orca-bots.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-orca-bots-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const MEMORY_HEADER = "# Memory\n\nOne line per fact, newest first. Longer notes go in memory/<topic>.md.\n";

function makeBot(home: string, slug: string, opts: { memory?: string | null; agent?: string } = {}): string {
  const dir = path.join(home, ".orca", "bots", slug);
  fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bot.json"), JSON.stringify({ id: slug, name: slug.toUpperCase(), agent: opts.agent ?? "claude" }));
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "Orca writes this file, CLAUDE.md and bot.json; edits to them are replaced.\n");
  if (opts.memory !== null) fs.writeFileSync(path.join(dir, "MEMORY.md"), opts.memory ?? MEMORY_HEADER);
  return dir;
}

function freshHome(name: string): string {
  const home = path.join(root, name);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

describe("the bots on a machine", () => {
  test("no Orca folder at all: nothing listed, nothing written, no error", () => {
    const home = freshHome("none");
    expect(listOrcaBots(home)).toEqual([]);
    expect(orcaAutoSetup(home).bots).toEqual([]);
    expect(fs.existsSync(path.join(home, ".orca"))).toBe(false);
  });

  test("a folder without a bot.json is not a bot", () => {
    const home = freshHome("stray");
    fs.mkdirSync(path.join(home, ".orca", "bots", "leftover"), { recursive: true });
    makeBot(home, "real");
    expect(listOrcaBots(home).map((b) => b.slug)).toEqual(["real"]);
  });

  test("a bot is recognised by the folder a run happens in, at any depth", () => {
    const home = freshHome("where");
    const dir = makeBot(home, "helper");
    expect(orcaBotAt(dir, home)?.slug).toBe("helper");
    expect(orcaBotAt(path.join(dir, "memory"), home)?.slug).toBe("helper");
    expect(orcaBotAt(path.join(home, ".orca", "bots"), home)).toBeNull();
    expect(orcaBotAt(home, home)).toBeNull();
    expect(orcaBotAt(path.join(home, ".orca", "bots", "helper-two"), home)).toBeNull();
  });
});

describe("the bot's Nirvana note", () => {
  const now = new Date(2026, 10, 20, 23, 30);

  test("first time: the topic file and one dated line, and the files Orca owns are not touched", () => {
    const home = freshHome("first");
    const dir = makeBot(home, "helper");
    const agentsBefore = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    const [bot] = listOrcaBots(home);
    expect(ensureBotKnowsNirvana(bot, now)).toBe("written");
    expect(fs.readFileSync(path.join(dir, "memory", "nirvana-os.md"), "utf8")).toBe(botTopicText());
    const memory = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
    expect(memory.startsWith(MEMORY_HEADER)).toBe(true);
    expect(memory).toContain("- 2026-11-20: Nirvana-OS is installed on this computer.");
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe(agentsBefore);
    expect(fs.readdirSync(dir).sort()).toEqual(["AGENTS.md", "MEMORY.md", "bot.json", "memory"]);
    expect(botUsesNirvana(bot)).toBe(true);
  });

  test("the note tells the bot to dispatch, to write the brief in English and to report paths", () => {
    const text = botTopicText();
    expect(text.startsWith(BOT_TOPIC_MARKER)).toBe(true);
    expect(text).toContain('nrv dispatch --auto --exec "<brief>"');
    expect(text).toContain("Write the brief in English");
    expect(text).toContain("nrv revise <project>");
    expect(text).toContain("full path of each delivered file");
  });

  test("a second run changes nothing", () => {
    const home = freshHome("again");
    const dir = makeBot(home, "helper");
    const [bot] = listOrcaBots(home);
    ensureBotKnowsNirvana(bot, now);
    const memory = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
    expect(ensureBotKnowsNirvana(bot, new Date("2027-01-01T00:00:00Z"))).toBe("current");
    expect(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8")).toBe(memory);
  });

  test("the line goes above the facts already there: newest first", () => {
    const home = freshHome("order");
    const dir = makeBot(home, "helper", { memory: MEMORY_HEADER + "\n- 2026-10-01: prefers tables.\n- 2026-09-01: works in UTC.\n" });
    ensureBotKnowsNirvana(listOrcaBots(home)[0], now);
    const lines = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8").split("\n").filter((l) => l.startsWith("- "));
    expect(lines.map((l) => l.slice(2, 12))).toEqual(["2026-11-20", "2026-10-01", "2026-09-01"]);
  });

  test("an owner who removes the line has turned the note off: it is never put back", () => {
    const home = freshHome("off");
    const dir = makeBot(home, "helper");
    const [bot] = listOrcaBots(home);
    ensureBotKnowsNirvana(bot, now);
    fs.writeFileSync(path.join(dir, "MEMORY.md"), MEMORY_HEADER);
    expect(ensureBotKnowsNirvana(bot, now)).toBe("current");
    expect(orcaAutoSetup(home, now).bots[0].outcome).toBe("current");
    expect(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8")).toBe(MEMORY_HEADER);
    expect(botUsesNirvana(bot)).toBe(false);
  });

  test("a note from an older engine is rewritten, and the memory line is not duplicated", () => {
    const home = freshHome("older");
    const dir = makeBot(home, "helper");
    const [bot] = listOrcaBots(home);
    ensureBotKnowsNirvana(bot, now);
    fs.writeFileSync(path.join(dir, "memory", "nirvana-os.md"), "<!-- nirvana-os:orca-bot:v0 -->\nold text\n");
    expect(ensureBotKnowsNirvana(bot, now)).toBe("refreshed");
    expect(fs.readFileSync(path.join(dir, "memory", "nirvana-os.md"), "utf8")).toBe(botTopicText());
    expect(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8").split("memory/nirvana-os.md").length).toBe(2);
  });

  test("a memory/nirvana-os.md the engine did not write is somebody's own note: left alone", () => {
    const home = freshHome("foreign");
    const dir = makeBot(home, "helper");
    fs.writeFileSync(path.join(dir, "memory", "nirvana-os.md"), "my own notes about nirvana\n");
    expect(ensureBotKnowsNirvana(listOrcaBots(home)[0], now)).toBe("skipped");
    expect(fs.readFileSync(path.join(dir, "memory", "nirvana-os.md"), "utf8")).toBe("my own notes about nirvana\n");
    expect(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8")).toBe(MEMORY_HEADER);
  });

  test("a bot folder without MEMORY.md is skipped, and nothing is created in it", () => {
    const home = freshHome("nomem");
    const dir = makeBot(home, "helper", { memory: null });
    expect(ensureBotKnowsNirvana(listOrcaBots(home)[0], now)).toBe("skipped");
    expect(fs.existsSync(path.join(dir, "memory", "nirvana-os.md"))).toBe(false);
  });

  test("CRLF memory files keep their line endings", () => {
    const home = freshHome("crlf");
    const dir = makeBot(home, "helper", { memory: "# Memory\r\n\r\n- 2026-10-01: prefers tables.\r\n" });
    ensureBotKnowsNirvana(listOrcaBots(home)[0], now);
    const memory = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
    expect(memory.replace(/\r\n/g, "")).not.toContain("\n");
  });
});

describe("where the bots are looked for", () => {
  test("the test preload points the default away from the owner's home; an explicit home wins", () => {
    expect(process.env.NIRVANA_ORCA_BOTS_DIR).toBeTruthy();
    expect(orcaBotsRoot()).toBe(process.env.NIRVANA_ORCA_BOTS_DIR!);
    expect(orcaBotsRoot()).not.toBe(path.join(os.homedir(), ".orca", "bots"));
    expect(orcaBotsRoot("/somewhere")).toBe(path.join("/somewhere", ".orca", "bots"));
  });
});

describe("the project's setup script", () => {
  test("written once, the same text on every platform, and never over a file that is already there", () => {
    const dir = path.join(root, "proj-yaml");
    fs.mkdirSync(dir, { recursive: true });
    expect(ensureOrcaSetupScript(dir)).toBe("written");
    expect(fs.readFileSync(path.join(dir, "orca.yaml"), "utf8")).toBe(orcaYamlText());
    expect(orcaYamlText()).toContain("scripts:\n  setup: |\n    nrv init . --adopt\n");
    fs.writeFileSync(path.join(dir, "orca.yaml"), "scripts:\n  setup: |\n    make bootstrap\n");
    expect(ensureOrcaSetupScript(dir)).toBe("present");
    expect(fs.readFileSync(path.join(dir, "orca.yaml"), "utf8")).toContain("make bootstrap");
  });
});

describe("the enclosing Orca worktree", () => {
  test("named only when the run is at or below the worktree's folder", () => {
    const tree = path.join(root, "tree");
    fs.mkdirSync(path.join(tree, "src"), { recursive: true });
    const env = { ORCA_WORKTREE_ID: `repo-1::${tree}` };
    expect(orcaWorktreeRootFor(tree, env)).toBe(tree);
    expect(orcaWorktreeRootFor(path.join(tree, "src"), env)).toBe(tree);
    expect(orcaWorktreeRootFor(root, env)).toBeNull();
    expect(orcaWorktreeRootFor(tree, {})).toBeNull();
    expect(orcaWorktreeRootFor(tree, { ORCA_WORKTREE_ID: "repo-1" })).toBeNull();
    expect(orcaWorktreeRootFor(tree, { ORCA_WORKTREE_ID: "repo-1::relative/path" })).toBeNull();
  });
});

describe("registering a project as a workspace", () => {
  test("once per machine: registered with the app open, remembered, and not called again", () => {
    const store = path.join(root, "store-a");
    const project = path.join(root, "proj-reg");
    fs.mkdirSync(project, { recursive: true });
    const registered: string[] = [];
    const deps = { running: () => true, register: (dir: string) => { registered.push(dir); return { ok: true }; }, storeDir: store };
    expect(ensureOrcaWorkspace(project, deps)).toBe("registered");
    expect(ensureOrcaWorkspace(project, deps)).toBe("known");
    expect(registered).toEqual([project]);
  });

  test("with the app closed nothing is called and nothing is remembered, so the next run tries", () => {
    const store = path.join(root, "store-b");
    const project = path.join(root, "proj-closed");
    fs.mkdirSync(project, { recursive: true });
    let calls = 0;
    expect(ensureOrcaWorkspace(project, { running: () => false, register: () => { calls++; return { ok: true }; }, storeDir: store })).toBe("unreachable");
    expect(calls).toBe(0);
    expect(ensureOrcaWorkspace(project, { running: () => true, register: () => { calls++; return { ok: true }; }, storeDir: store })).toBe("registered");
    expect(calls).toBe(1);
  });

  test("a refused registration is not remembered", () => {
    const store = path.join(root, "store-c");
    const project = path.join(root, "proj-refused");
    fs.mkdirSync(project, { recursive: true });
    expect(ensureOrcaWorkspace(project, { running: () => true, register: () => ({ ok: false }), storeDir: store })).toBe("failed");
    expect(ensureOrcaWorkspace(project, { running: () => true, register: () => ({ ok: true }), storeDir: store })).toBe("registered");
  });
});
