// business-solo.test.ts — a business run as one agent that opens nothing.
//
// Hermetic: a fixture business and squad on disk, a canned cascade runner in
// place of a runtime. No LLM, no network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  authorizedSquads, briefInputPaths, buildSoloPrompt, businessMemory, creditSoloRun, namedSquadsIn, participationFile, prepareBusinessSolo,
  requestVoices, preferredSquads, readSeats, runBusinessSolo, SOLO_ROLE_LINE, soloDirective, soloSquads, uniquePaths, type BusinessSoloArgs,
} from "../lib/business-solo.ts";
import { AUTONOMOUS_DIRECTIVE } from "../lib/host-agent-driver.ts";
import { roleMayDispatch } from "../../_shared/lib/dispatch-depth.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-business-solo-"));
const BIZ = path.join(TMP, "businesses", "acme-launch");
const PROJECT_ROOT = path.join(TMP, "project");
const PROJECT_DIR = path.join(PROJECT_ROOT, "runs", "p-1");
const OUTPUTS = path.join(PROJECT_DIR, "deliverables");
const SEAT_BODY = "SEAT-BODY-NEVER-PASTED";

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

beforeAll(() => {
  write(path.join(BIZ, "business.yaml"), "name: acme-launch\nversion: 1.0.0\nprotocol: '2.0'\ndescription: A fixture business that launches online courses.\n");
  write(path.join(BIZ, "org-chart.yaml"), "chart:\n  - employee: al-ceo\n    reports: []\n  - employee: al-copy\n    reports: [al-ceo]\n");
  write(path.join(BIZ, "employees", "al-ceo.md"), `---\nname: al-ceo\nrole: Chief executive\nis_brief_intake: true\n---\n${SEAT_BODY}\n`);
  write(path.join(BIZ, "employees", "al-copy.md"), `---\nname: al-copy\nrole: Copy chief\nassigned_mind_clones: [copy-legend]\nsquads_authorized: [email-squad]\n---\n${SEAT_BODY}\n`);
  write(path.join(TMP, "squads", "email-squad", "squad.yaml"), "name: email-squad\ndescription: Writes launch email sequences that sell.\ncapabilities:\n  - id: marketing.email.sequence\n    description: A launch sequence.\n");
  fs.mkdirSync(OUTPUTS, { recursive: true });
});
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const lookup = (slug: string) => slug === "copy-legend"
  ? { dir: path.join(TMP, "clones", "copy-legend"), files: [path.join(TMP, "clones", "copy-legend", "AGENT.md")] }
  : null;
const squadDirOf = (slug: string) => path.join(TMP, "squads", slug);

function baseArgs(extra: Partial<BusinessSoloArgs> = {}): BusinessSoloArgs {
  return {
    slug: "acme-launch", bizDir: BIZ, brief: "## Request (verbatim)\nLaunch a course.\n",
    projectId: "p-1", projectDir: PROJECT_DIR, projectRoot: PROJECT_ROOT, outputsRoot: OUTPUTS, runtime: "claude-code",
    cloneLookup: lookup, squadDirOf, memoryDirs: [],
    cloneNames: () => [], voiceSearch: () => [],
    ...extra,
  };
}

describe("voices for the request", () => {
  const hit = (slug: string, below_gate: boolean) =>
    ({ slug, display_name: slug.toUpperCase(), score: 1, normalized: 1, coverage: { matched: 9, total: 30 }, below_gate }) as any;
  const library = (slug: string) => ({ dir: path.join(TMP, "clones", slug), files: [] });
  const seats = [{ slug: "al-copy", role: "", file: "x", voices: [{ slug: "copy-legend", dir: null, files: [] }], squads: null }];

  test("the library's search fills a business whose seats carry no voice, above the gate only", () => {
    const { voices: v } = requestVoices("## Request (verbatim)\nWrite a sales page\n", [], library, [], () => [hit("halbert", false), hit("off-topic", true), hit("sugarman", false)]);
    expect(v.map((x) => x.slug)).toEqual(["halbert", "sugarman"]);
    expect(v[0].why).toBe("matches 9/30 of the request's terms");
  });

  test("a clone the brief asks for wins over the search; a seat's own voice is not repeated", () => {
    const names = [{ slug: "gary-halbert", name: "Gary Halbert" }, { slug: "copy-legend", name: "Copy Legend" }];
    const { voices: v } = requestVoices("Write it like Gary Halbert would, or copy-legend", seats as any, library, names, () => [hit("other", false)]);
    expect(v.map((x) => [x.slug, x.why])).toEqual([["gary-halbert", "asked for in the brief"]]);
  });

  test("clones listed as facts about a product are not a request; `clone <slug>` is", () => {
    const names = [{ slug: "saul-bass", name: "Saul Bass" }, { slug: "paula-scher", name: "Paula Scher" }, { slug: "gary-halbert", name: "Gary Halbert" }];
    const facts = "## Request (verbatim)\nWrite the sales page for the pack\n\n## Decisions\n- The pack ships 10 clones: Saul Bass, Paula Scher\n";
    expect(requestVoices(facts, [], library, names, () => [hit("drew-whitman", false)]).voices.map((x) => x.slug)).toEqual(["drew-whitman"]);
    const marked = facts + "- clone gary-halbert\n";
    expect(requestVoices(marked, [], library, names, () => []).voices.map((x) => x.slug)).toEqual(["gary-halbert"]);
  });

  test("an uninstalled clone from the search is skipped and at most three are offered", () => {
    const search = () => ["a", "b", "ghost", "c", "d"].map((s) => hit(s, false));
    const { voices: v } = requestVoices("x", [], (slug) => slug === "ghost" ? null : library(slug), [], search);
    expect(v.map((x) => x.slug)).toEqual(["a", "b", "c"]);
  });

  test("a clone asked for and not installed is reported, and the search does not stand in for it", () => {
    const names = [{ slug: "gary-halbert", name: "Gary Halbert" }];
    const r = requestVoices("## Request (verbatim)\nIn the voice of Gary Halbert\n", [], () => null, names, () => [hit("other", false)]);
    expect(r.voices).toEqual([]);
    expect(r.missing).toEqual(["gary-halbert"]);
    // A marked slug the library does not know is reported too; a bare "clone the repo" is not a mark.
    expect(requestVoices("## Request (verbatim)\nx\n\n## Decisions\n- clone ghost-expert\n", [], library, [], () => []).missing).toEqual(["ghost-expert"]);
    expect(requestVoices("## Request (verbatim)\nclone the repo\n", [], library, [], () => []).missing).toEqual([]);
  });

  test("a clone named only outside the request section is not asked for", () => {
    const names = [{ slug: "paula-scher", name: "Paula Scher" }];
    const brief = "## Request (verbatim)\nWrite a page\n\n## Decisions\n- Paula Scher did the identity\n";
    expect(requestVoices(brief, [], library, names, () => []).voices).toEqual([]);
  });

  test("the prompt lists each clone once, with its folder, and grants the folder", () => {
    const prep = prepareBusinessSolo(baseArgs({ voiceSearch: () => [hit("bencivenga", false)], cloneLookup: (slug) => slug === "bencivenga" ? library(slug) : lookup(slug) }));
    expect(prep.prompt).toContain("## Voices");
    expect(prep.prompt).toContain(`- \`bencivenga\` (BENCIVENGA): \`${path.join(TMP, "clones", "bencivenga")}\`, AGENT.md and SOUL.md inside`);
    expect(prep.prompt.split("`copy-legend`").length - 1).toBe(2); // the seat line and its one Voices line
    expect(prep.launch.addDirs).toContain(path.join(TMP, "clones", "bencivenga"));
    expect(prep.prompt).not.toContain("AGENT.md`, `");
  });

  test("a clone asked for and not installed gets one line in the prompt", () => {
    const prep = prepareBusinessSolo(baseArgs({
      brief: "## Request (verbatim)\nWrite it as Gary Halbert would\n", cloneNames: () => [{ slug: "gary-halbert", name: "Gary Halbert" }],
      cloneLookup: (slug) => slug === "copy-legend" ? lookup(slug) : null,
    }));
    expect(prep.prompt).toContain("Asked for but not installed: `gary-halbert`");
  });
});

describe("squads a request names", () => {
  const SLUGS = ["testing", "design", "instagram-intelligence-nirvana"];
  test.each([
    ["A primary headline with 5 alternatives for testing", []],
    ["Use the squad testing for the QA pass", ["testing"]],
    ["the testing squad checks it", ["testing"]],
    ["run `design` on the cover", ["design"]],
    ["nrv dispatch --squad design", ["design"]],
    ["o squad testing revisa", ["testing"]],
    ["pull the data with instagram-intelligence-nirvana", ["instagram-intelligence-nirvana"]],
    ["good design matters", []],
  ])("%p → %p", (text, expected) => {
    expect(namedSquadsIn(text as string, SLUGS)).toEqual(expected as string[]);
  });
});

describe("the solo role", () => {
  test("may dispatch nothing", () => {
    for (const target of ["business", "employee", "squad", "agent-x", "planner", "exec", "solo"] as const) {
      expect(roleMayDispatch(target, { NIRVANA_DISPATCH_ROLE: "solo" })).toBe(false);
    }
  });
});

describe("the prompt", () => {
  const seats = () => readSeats(BIZ, lookup);

  test("cards: router picks, named ones and the business's preferred, deduplicated; the seats' closed sets are named only", () => {
    expect(soloSquads({ mandatorySquads: ["a"], optionalSquads: ["b", "a"], briefSquads: ["c"] }, ["d", "a"])).toEqual(["a", "b", "c", "d"]);
    expect(authorizedSquads(seats(), ["a"])).toEqual(["email-squad"]);
    expect(authorizedSquads(seats(), ["email-squad"])).toEqual([]);
  });

  test("a business with many authorized squads gets cards for none of them, and their names in the prompt", () => {
    const many = Array.from({ length: 17 }, (_, i) => `sq-${i}`);
    const biz = path.join(TMP, "businesses", "many-squads");
    write(path.join(biz, "business.yaml"), "name: many-squads\n");
    write(path.join(biz, "employees", "boss.md"), `---\nname: boss\nsquads_authorized: [${many.join(", ")}]\n---\n`);
    for (const q of many) write(path.join(TMP, "squads", q, "squad.yaml"), `name: ${q}\ndescription: x\n`);
    const prep = prepareBusinessSolo(baseArgs({ slug: "many-squads", bizDir: biz }));
    expect(Object.keys(prep.squadCards)).toEqual([]);
    expect(prep.prompt).toContain("Also authorized for the seats, with no card written: `sq-0`");
    expect(prep.launch.addDirs).toContain(path.join(TMP, "squads", "sq-16"));
  });

  test("the business's preferred squads come from business.yaml", () => {
    expect(preferredSquads(BIZ)).toEqual([]);
    expect(preferredSquads(null)).toEqual([]);
  });

  test("a map of paths: the brief file, seats, voices, squad cards; never a seat body", () => {
    const prompt = buildSoloPrompt({ ...baseArgs(), briefFile: "/b/brief.md" }, seats(), ["/mem"], { "email-squad": "/cards/squad-email-squad.md" });
    expect(prompt).toContain("`/b/brief.md`. Read it first, and again at the start of every phase");
    expect(prompt).toContain("- `al-copy` (Copy chief): `" + path.join(BIZ, "employees", "al-copy.md") + "` · voices: `copy-legend`\n");
    expect(prompt).toContain("- `copy-legend`: `" + path.join(TMP, "clones", "copy-legend") + "`, AGENT.md and SOUL.md inside · seat voice");
    expect(prompt).toContain("- `email-squad`: card `/cards/squad-email-squad.md`");
    expect(prompt).toContain("You never dispatch it.");
    expect(prompt).toContain(path.join(OUTPUTS, "_work", "PROGRESS.md"));
    expect(prompt).toContain(path.join(OUTPUTS, "_SUMMARY.md"));
    expect(prompt).toContain(path.join(OUTPUTS, "_CLAIMS.json"));
    expect(prompt).not.toContain(SEAT_BODY);
  });

  test("participation.json is the one named exception to the output folder, and a lesson has its command", () => {
    const prompt = buildSoloPrompt({ ...baseArgs(), briefFile: "/b/brief.md" }, seats(), [], {});
    expect(prompt).toContain("Write nothing anywhere else, even where the brief names another folder; the one exception is participation.json");
    expect(prompt).toContain(`nrv memory add acme-launch "<fact>" --scope global|project`);
  });

  test("small: the prompt stays well under the ~10k-token seat prompts it replaces", () => {
    const prompt = buildSoloPrompt({ ...baseArgs(), briefFile: "/b/brief.md" }, seats(), [], {});
    expect(prompt.length).toBeLessThan(4000);
  });

  test("no squad picked: the prompt says how to find one without dispatching", () => {
    const prompt = buildSoloPrompt({ ...baseArgs(), briefFile: "/b/brief.md" }, seats(), [], {});
    expect(prompt).toContain("`nrv cards squad <slug>`");
  });
});

describe("the directive", () => {
  test("the base directive plus one business-specific line, then the rules", () => {
    const d = soloDirective(" RULES");
    expect(d.startsWith(AUTONOMOUS_DIRECTIVE)).toBe(true);
    expect(d).toContain(SOLO_ROLE_LINE);
    expect(d.endsWith(" RULES")).toBe(true);
    expect(d.split("\n").length).toBe(AUTONOMOUS_DIRECTIVE.split("\n").length + 1);
  });

  test("the base directive is true for every worker: no dispatch, no team mode", () => {
    for (const gone of ["nrv dispatch --squad", "Delegate in the foreground", "team mode", "You ARE the intake", "real generated images"]) {
      expect(AUTONOMOUS_DIRECTIVE).not.toContain(gone);
    }
    expect(AUTONOMOUS_DIRECTIVE).toContain("never a dispatcher");
    expect(AUTONOMOUS_DIRECTIVE).toContain("marked 'to confirm'");
    expect(AUTONOMOUS_DIRECTIVE).toContain("Images only when the deliverable asks for them");
  });
});

describe("memory", () => {
  const home = path.join(TMP, "nirvana-home");
  let saved: string | undefined;
  beforeAll(() => { saved = process.env.NIRVANA_HOME; process.env.NIRVANA_HOME = home; });
  afterAll(() => { if (saved === undefined) delete process.env.NIRVANA_HOME; else process.env.NIRVANA_HOME = saved; });

  const shipped = (biz: string, text: string) => write(path.join(biz, "memory", "permanent.md"), text);

  test("the first use seeds the home from the shipped memory; a stub shipped alone is no memory", () => {
    const biz = path.join(TMP, "businesses", "has-memory");
    shipped(biz, "# Permanent memory\n\n- Conversion benchmarks were never validated.\n");
    const m = businessMemory("has-memory", biz, PROJECT_ROOT);
    expect(m.dirs).toEqual([path.join(home, ".nirvana", "memory", "businesses", "has-memory")]);
    expect(fs.existsSync(path.join(m.dirs[0], "permanent.md"))).toBe(true);
    expect(m.newer).toBeNull();
    const stub = path.join(TMP, "businesses", "stub-memory");
    shipped(stub, "# Permanent memory\n");
    expect(businessMemory("stub-memory", stub, PROJECT_ROOT).dirs).toEqual([]);
  });

  test("a shipped memory that moved on after the seed is named beside the home", () => {
    const biz = path.join(TMP, "businesses", "drifted");
    shipped(biz, "# Permanent memory\n\n- v1 fact.\n");
    businessMemory("drifted", biz, PROJECT_ROOT);
    shipped(biz, "# Permanent memory\n\n- v1 fact.\n- v2 fact, newer.\n");
    const m = businessMemory("drifted", biz, PROJECT_ROOT);
    expect(m.newer).toEqual({ dir: path.join(biz, "memory"), files: ["permanent.md"] });
    const prompt = buildSoloPrompt({ ...baseArgs(), briefFile: "/b/brief.md" }, [], m.dirs, {}, [], { memoryNewer: m.newer });
    expect(prompt).toContain(`The business's own \`${path.join(biz, "memory")}\` is newer than, or different from, that memory (permanent.md)`);
  });
});

describe("inputs outside the run folder", () => {
  const brief = (inputs: string) => `## Request (verbatim)\nx\n\n## Inputs\n${inputs}\n\n## Done when\n- y\n`;

  test("absolute, ~ and project-relative paths that exist are resolved; the rest are dropped", () => {
    const root = path.join(TMP, "inputs-project");
    write(path.join(root, "docs", "brief.pdf"), "x");
    write(path.join(TMP, "home", "notes.md"), "x");
    write(path.join(TMP, "elsewhere", "data.csv"), "x");
    const text = brief(`- docs/brief.pdf: the attachment\n- ~/notes.md\n- \`${path.join(TMP, "elsewhere", "data.csv")}\` , the export\n- /no/such/file.txt\n- plain prose, nothing here`);
    expect(briefInputPaths(text, root, { home: path.join(TMP, "home") })).toEqual([
      path.join(root, "docs", "brief.pdf"), path.join(TMP, "home", "notes.md"), path.join(TMP, "elsewhere", "data.csv"),
    ]);
    expect(briefInputPaths("## Request (verbatim)\nx\n", root)).toEqual([]);
  });

  test("Windows shapes: drive letters, both separators, ~, case-insensitive dedupe", () => {
    const present = new Set(["C:\\proj\\docs\\a.pdf", "C:\\Users\\me\\notes.md", "D:\\data\\x.csv"].map((p) => p.toLowerCase()));
    const exists = (p: string) => present.has(p.toLowerCase());
    const text = brief("- docs\\a.pdf\n- docs/a.pdf\n- ~\\notes.md\n- `D:\\data\\x.csv`\n- d:/data/x.csv");
    expect(briefInputPaths(text, "C:\\proj", { home: "C:\\Users\\me", exists, api: path.win32 })).toEqual([
      "C:\\proj\\docs\\a.pdf", "C:\\Users\\me\\notes.md", "D:\\data\\x.csv",
    ]);
    expect(uniquePaths(["C:\\Proj", "c:\\proj\\"], "win32")).toHaveLength(1);
    expect(uniquePaths(["/a/Proj", "/a/proj"], "linux")).toHaveLength(2);
  });

  test("the prompt names them resolved and the launch grants their folders", () => {
    const root = path.join(TMP, "inputs-project2");
    write(path.join(root, "docs", "brief.pdf"), "x");
    const prep = prepareBusinessSolo(baseArgs({ projectRoot: root, brief: brief("- docs/brief.pdf") }));
    expect(prep.prompt).toContain(`Inputs it names, resolved: \`${path.join(root, "docs", "brief.pdf")}\`.`);
    expect(prep.launch.addDirs).toContain(path.join(root, "docs"));
  });
});

describe("runBusinessSolo", () => {
  test("one run, role solo, no subagents, cards written, the seats it declares credited", () => {
    let seen: any = null;
    const res = runBusinessSolo(baseArgs({
      mandatorySquads: ["email-squad"],
      runWithCascadeImpl: ((opts: any) => {
        seen = opts;
        fs.writeFileSync(participationFile(PROJECT_DIR), JSON.stringify({ seats: [{ seat: "al-copy" }, { seat: "not-a-seat" }] }));
        return { ok: true, runtime: "claude-code", sessionId: "s-1", result: "", costUsd: null, durationMs: 5, finalRuntime: "claude-code", handoffs: [] };
      }) as any,
    }));
    expect(res.ok).toBe(true);
    expect(res.sessionId).toBe("s-1");
    expect(res.seatsPlayed).toEqual(["al-copy"]);
    expect(seen.dispatchRole).toBe("solo");
    expect(seen.allowSubagents).toBeUndefined();
    expect(seen.addDirs).toContain(path.join(TMP, "squads", "email-squad"));
    expect(fs.existsSync(path.join(PROJECT_DIR, "cards", "squad-email-squad.md"))).toBe(true);
    expect(fs.readFileSync(res.briefFile, "utf8")).toContain("Launch a course.");
    expect(res.launch.appendSystemPrompt).toContain(SOLO_ROLE_LINE);
  });

  test("each clone the worker declares is credited with where it came from", () => {
    const events: any[] = [];
    const hit = { slug: "bencivenga", display_name: "Gary Bencivenga", score: 1, normalized: 1, coverage: { matched: 9, total: 30 }, below_gate: false } as any;
    runBusinessSolo(baseArgs({
      emit: (event, payload) => events.push({ event, ...payload }),
      voiceSearch: () => [hit],
      cloneLookup: (slug) => slug === "bencivenga" ? { dir: path.join(TMP, "clones", slug), files: [] } : lookup(slug),
      runWithCascadeImpl: ((_: any) => {
        fs.writeFileSync(participationFile(PROJECT_DIR), JSON.stringify({ seats: [{ seat: "al-copy" }], clones: ["copy-legend", "bencivenga", "found-it-myself"] }));
        return { ok: true, runtime: "claude-code", sessionId: null, result: "", costUsd: null, durationMs: 1, finalRuntime: "claude-code", handoffs: [] };
      }) as any,
    }));
    expect(events.find((e) => e.event === "x_business_solo_started").voices).toEqual(["bencivenga"]);
    expect(events.filter((e) => e.event === "x_clone_credited").map((e) => [e.clone, e.source])).toEqual([
      ["copy-legend", "seat"], ["bencivenga", "request"], ["found-it-myself", "own-choice"],
    ]);
  });

  test("a stale participation.json never credits the next run, and the credit is one shared function", () => {
    fs.writeFileSync(participationFile(PROJECT_DIR), JSON.stringify({ seats: [{ seat: "al-copy" }], clones: ["copy-legend"] }));
    const prep = prepareBusinessSolo(baseArgs());
    expect(fs.existsSync(participationFile(PROJECT_DIR))).toBe(false);
    const events: any[] = [];
    fs.writeFileSync(participationFile(PROJECT_DIR), JSON.stringify({ seats: [{ seat: "al-copy" }], clones: ["copy-legend"] }));
    const played = creditSoloRun({ emit: (e, p) => events.push({ e, ...p }), projectId: "p-1", projectDir: PROJECT_DIR, slug: "acme-launch", runtime: "claude-code", seats: prep.seats, voices: prep.voices });
    expect(played).toEqual(["al-copy"]);
    expect(events.map((x) => x.e)).toEqual(["x_seat_credited", "x_clone_credited"]);
    fs.rmSync(participationFile(PROJECT_DIR), { force: true });
  });

  test("a brief file from the orchestrator is pointed at, not copied", () => {
    const briefFile = path.join(TMP, "orchestrator-brief.md");
    write(briefFile, "## Request (verbatim)\nx\n");
    let prompt = "";
    const res = runBusinessSolo(baseArgs({
      briefFile,
      runWithCascadeImpl: ((opts: any) => { prompt = opts.prompt; return { ok: true, runtime: "claude-code", sessionId: null, result: "", costUsd: null, durationMs: 1, finalRuntime: "claude-code", handoffs: [] }; }) as any,
    }));
    expect(res.briefFile).toBe(briefFile);
    expect(prompt).toContain(`\`${briefFile}\``);
  });
});
