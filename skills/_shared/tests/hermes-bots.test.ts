// hermes-bots.test.ts — Hermes Agent's Bots as a host for a team and as
// specialists the engine calls. A Hermes home on disk and a stand-in for the
// `hermes` command; the real one is never run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  askHermesBot, hermesBots, hermesProfileDir, hermesRoot, hermesSelf, hermesSoulFile, HERMES_TASK_NOTE, listHermesProfiles, markHermesBot,
} from "../lib/hermes-bots.ts";
import { loadTeam, sharedRules, teamFileOf, type TeamLibrary } from "../lib/team.ts";
import { releaseHermes, syncHermes, teamOfText } from "../lib/team-hosts.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-hermes-bots-")));
const home = path.join(root, "hermes");
const fake = path.join(root, "hermes-standin");
const calls = path.join(root, "calls.jsonl");
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string | undefined> = {
  NIRVANA_HERMES_HOME: home, NIRVANA_HERMES_BIN: fake, HERMES_HOME: undefined, HERMES_SESSION_PROFILE: undefined,
};
const posix = process.platform !== "win32";

// The stand-in: `profile create <id>` makes the folder with a SOUL.md, and
// `-p <id> -z <prompt>` answers, writes a file where it runs and records the call.
const STANDIN = `#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: a, cwd: process.cwd(), home: process.env.HERMES_HOME ?? null }) + "\\n");
if (a[0] === "profile" && a[1] === "create" && a[2] === "--help") {
  console.log(fs.existsSync(${JSON.stringify(path.join(root, "old-hermes"))}) ? "--clone --no-alias" : "--clone --no-alias --no-credentials");
  process.exit(0);
}
if (a[0] === "profile" && a[1] === "create") {
  if (a[2] === "studio-broken") { console.error("Error: no room"); process.exit(1); }
  const dir = path.join(process.env.HERMES_HOME, "profiles", a[2]);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SOUL.md"), "You are Hermes.\\n");
  fs.writeFileSync(path.join(dir, "profile.yaml"), "description: " + JSON.stringify(a[a.indexOf("--description") + 1]) + "\\n");
  process.exit(0);
}
if (a[0] === "-p" && a[2] === "--in" && a[4] === "-z") {
  process.chdir(a[3]);
  if (a[1] === "slow") { await new Promise((r) => setTimeout(r, 5000)); }
  if (a[1] === "broken") { console.error("provider said no"); process.exit(3); }
  fs.writeFileSync("banner.txt", "made by " + a[1]);
  console.log("Done. I wrote banner.txt.");
  process.exit(0);
}
process.exit(2);
`;

function profile(id: string, yaml = "", soul = "You are Hermes.\n"): string {
  const dir = path.join(home, "profiles", id);
  fs.mkdirSync(dir, { recursive: true });
  if (yaml) fs.writeFileSync(path.join(dir, "profile.yaml"), yaml);
  fs.writeFileSync(path.join(dir, "SOUL.md"), soul);
  return dir;
}

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(fake, STANDIN, { mode: 0o755 });
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(root, { recursive: true, force: true });
});

const lib: TeamLibrary = { employeeFile: () => null, cloneDir: () => null };
const TEAM = `
team: studio
display_name: "Studio"
purpose: "Writes and reviews."
output_root: ${JSON.stringify(path.join(root, "out"))}
orchestrator: director
members:
  - id: director
    name: "Director"
    tier: lead
    expert: { role: "Runs the project", delivers: "The delivery", done_when: "Every part exists" }
  - id: writer
    name: "Writer"
    reports_to: director
    expert: { role: "Writes the copy", delivers: "The copy", done_when: "Every line is concrete" }
`;
function team(yaml = TEAM) {
  const dir = fs.mkdtempSync(path.join(root, "team-"));
  const file = teamFileOf(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml);
  const { spec, problems } = loadTeam(file, lib);
  expect(problems).toEqual([]);
  return spec!;
}

describe("the Hermes home", () => {
  test("a profile's own home resolves to the root, and names the caller", () => {
    expect(hermesRoot()).toBe(home);
    process.env.NIRVANA_HERMES_HOME = path.join(home, "profiles", "coder");
    expect(hermesRoot()).toBe(home);
    process.env.NIRVANA_HERMES_HOME = home;
    process.env.HERMES_HOME = path.join(home, "profiles", "coder");
    expect(hermesSelf()).toBe("coder");
    delete process.env.HERMES_HOME;
    expect(hermesSelf()).toBeNull();
  });

  test("only a profile in the roster is a Bot, and the caller is never offered itself", () => {
    profile("plain", "description: A plain profile\n");
    profile("artist", 'description: Makes images\nui_meta:\n  hermes-bots:\n    title: "Image Studio"\n');
    profile("marked", "ui_meta:\n  hermes-bots: {}\n");
    profile("Not_A_Profile");
    expect(listHermesProfiles().map((p) => p.id)).toEqual(["artist", "marked", "plain"]);
    expect(hermesBots().map((b) => [b.id, b.name, b.description])).toEqual([["artist", "Image Studio", "Makes images"], ["marked", "marked", ""]]);
    process.env.HERMES_SESSION_PROFILE = "artist";
    expect(hermesBots().map((b) => b.id)).toEqual(["marked"]);
    delete process.env.HERMES_SESSION_PROFILE;
  });

  test("marking a Bot keeps what the person set in profile.yaml", () => {
    const dir = profile("kept", 'display_name: Mine\nui_meta:\n  hermes-bots:\n    color: "#ff0000"\n    created: 5\n  other-plugin:\n    a: 1\n');
    markHermesBot(dir, { title: "Kept", description: "Does\n  one thing" });
    const doc = parseYaml(fs.readFileSync(path.join(dir, "profile.yaml"), "utf8"));
    expect(doc.display_name).toBe("Mine");
    expect(doc.description).toBe("Does one thing");
    expect(doc.ui_meta["hermes-bots"]).toEqual({ color: "#ff0000", created: 5, title: "Kept", description: "Does one thing" });
    expect(doc.ui_meta["other-plugin"]).toEqual({ a: 1 });
    const before = fs.readFileSync(path.join(dir, "profile.yaml"), "utf8");
    markHermesBot(dir, { title: "Kept", description: "Does one thing" });
    expect(fs.readFileSync(path.join(dir, "profile.yaml"), "utf8")).toBe(before);
  });
});

describe("a team as Hermes Bots", () => {
  test("without --create a missing profile is reported and nothing is made", () => {
    const r = syncHermes(team(), lib);
    expect(r.missing.map((m) => m.id)).toEqual(["studio-director", "studio-writer"]);
    expect(r.written).toEqual([]);
    expect(fs.existsSync(hermesProfileDir("studio-director"))).toBe(false);
  });

  test("an existing profile gets the member's section in SOUL.md and its place in the roster", () => {
    const dir = profile("studio-writer", "", "My own soul.\n");
    const r = syncHermes(team(), lib);
    expect(r.written.map((w) => [w.id, w.created])).toEqual([["studio-writer", false]]);
    const soul = fs.readFileSync(hermesSoulFile(dir), "utf8");
    expect(soul.startsWith("My own soul.")).toBe(true);
    expect(teamOfText(soul)).toBe("studio");
    expect(soul).toContain("You answer to **Director** (`@studio-director`)");
    expect(soul).toContain("message_agent");
    const doc = parseYaml(fs.readFileSync(path.join(dir, "profile.yaml"), "utf8"));
    expect(doc.ui_meta["hermes-bots"].title).toBe("Writer");
    expect(doc.description).toBe("Writes the copy");
    // A second run changes nothing.
    syncHermes(team(), lib);
    expect(fs.readFileSync(hermesSoulFile(dir), "utf8")).toBe(soul);
  });

  test.skipIf(!posix)("--create makes the missing profiles through the hermes command", () => {
    const r = syncHermes(team(), lib, { create: true });
    expect(r.failed).toEqual([]);
    expect(r.written.map((w) => [w.id, w.created])).toEqual([["studio-director", true], ["studio-writer", false]]);
    const made = fs.readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c.argv[1] === "create" && c.argv[2] !== "--help");
    expect(made).toHaveLength(1);
    expect(made[0].argv).toEqual(["profile", "create", "studio-director", "--no-alias", "--description", "Director: Runs the project"]);
    expect(made[0].home).toBe(home);
    expect(teamOfText(fs.readFileSync(hermesSoulFile(hermesProfileDir("studio-director")), "utf8"))).toBe("studio");
  });

  test.skipIf(!posix)("on a Hermes whose fresh profile has no model, the profile is cloned and its copied SOUL.md emptied", () => {
    fs.writeFileSync(path.join(root, "old-hermes"), "");
    const r = syncHermes(team(TEAM.replace("team: studio", "team: old")), lib, { create: true });
    fs.rmSync(path.join(root, "old-hermes"));
    expect(r.failed).toEqual([]);
    const made = fs.readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c.argv[2] === "old-writer");
    expect(made[0].argv.slice(0, 5)).toEqual(["profile", "create", "old-writer", "--clone", "--no-alias"]);
    const soul = fs.readFileSync(hermesSoulFile(hermesProfileDir("old-writer")), "utf8");
    expect(soul.startsWith("<!-- nirvana-os:team:v1 old -->")).toBe(true);
    expect(soul).not.toContain("You are Hermes.");
  });

  test.skipIf(!posix)("a profile the command refuses to create is reported with its reason", () => {
    const r = syncHermes(team(TEAM.replace("id: writer", "id: broken")), lib, { create: true });
    expect(r.failed.map((f) => [f.id, f.reason])).toEqual([["studio-broken", "Error: no room"]]);
  });

  test("a profile of another team is left alone, and a too-long id is refused", () => {
    profile("studio-writer2", "", "<!-- nirvana-os:team:v1 other -->\nx\n<!-- /nirvana-os:team -->\n");
    const long = "m".repeat(41);
    const spec = team(TEAM.replace("team: studio", `team: ${"t".repeat(40)}`).replace("id: writer", `id: ${long}`));
    const r = syncHermes(spec, lib);
    expect(r.failed.map((f) => f.reason)).toEqual(["the team slug and the member id together are longer than a Hermes profile id (64 characters)"]);
    const taken = syncHermes(team(TEAM.replace("id: writer", "id: writer2")), lib);
    expect(taken.failed.map((f) => f.reason)).toEqual(['the profile carries the team "other"']);
  });

  test("a member taken out of the team, and a removed team, lose the section and keep the profile", () => {
    profile("studio-writer");
    syncHermes(team(), lib);
    const r = syncHermes(team(TEAM.replace(/  - id: writer[\s\S]*$/, "")), lib);
    expect(r.released).toContain("studio-writer");
    expect(teamOfText(fs.readFileSync(hermesSoulFile(hermesProfileDir("studio-writer")), "utf8"))).toBeNull();
    profile("studio-director");
    syncHermes(team(), lib);
    expect(releaseHermes("studio").sort()).toEqual(["studio-director", "studio-writer"]);
    expect(fs.existsSync(hermesProfileDir("studio-director"))).toBe(true);
  });

  test("the rules name Hermes's own messaging", () => {
    const rules = sharedRules(team(), "hermes").join("\n");
    expect(rules).toContain("`message_agent`");
    expect(rules).toContain("hermes -p");
    expect(rules).not.toContain("send_message");
  });
});

describe.skipIf(!posix)("calling a Hermes Bot", () => {
  test("the Bot gets the task with the note, works in the out folder and its files are listed", async () => {
    profile("artist", 'description: Makes images\nui_meta:\n  hermes-bots:\n    title: "Image Studio"\n');
    const out = path.join(root, "out-artist");
    const r = await askHermesBot("Image Studio", "A banner for the page.", { outDir: out, timeoutMs: 20_000 });
    expect(r.state).toBe("done");
    expect(r.bot).toEqual({ id: "artist", name: "Image Studio" });
    expect(r.answer).toBe("Done. I wrote banner.txt.");
    expect(r.files).toEqual([path.join(out, "banner.txt")]);
    const call = fs.readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c.argv[0] === "-p").pop();
    expect(call.argv.slice(0, 5)).toEqual(["-p", "artist", "--in", out, "-z"]);
    expect(call.argv[5]).toBe(`${HERMES_TASK_NOTE}\nFolder for your files: ${out}\n\nA banner for the page.`);
  });

  test("an unknown name, a failing Bot and a slow one each say what happened", async () => {
    profile("broken", "ui_meta:\n  hermes-bots: {}\n");
    profile("slow", "ui_meta:\n  hermes-bots: {}\n");
    const opts = { outDir: path.join(root, "out-x"), timeoutMs: 20_000 };
    const none = await askHermesBot("nobody", "x", opts);
    expect(none.state).toBe("failed");
    expect(none.reason).toContain('no Hermes Bot is called "nobody"');
    const plain = await askHermesBot("plain", "x", opts);
    expect(plain.state).toBe("failed");
    const failed = await askHermesBot("@broken", "x", opts);
    expect([failed.state, failed.reason]).toEqual(["failed", "provider said no"]);
    const slow = await askHermesBot("slow", "x", { ...opts, timeoutMs: 400 });
    expect(slow.state).toBe("timed-out");
  });

  test("with no hermes command the call is unreachable", async () => {
    process.env.NIRVANA_HERMES_BIN = path.join(root, "nowhere");
    const r = await askHermesBot("artist", "x", { outDir: path.join(root, "out-y"), timeoutMs: 1000 });
    process.env.NIRVANA_HERMES_BIN = fake;
    expect(r.state).toBe("unreachable");
  });
});
