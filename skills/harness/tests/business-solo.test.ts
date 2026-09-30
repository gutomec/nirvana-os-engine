// business-solo.test.ts — a business run as one agent that opens nothing.
//
// Hermetic: a fixture business and squad on disk, a canned cascade runner in
// place of a runtime. No LLM, no network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildSoloPrompt, isBusinessSolo, runBusinessSolo, SOLO_INTAKE_LINE, SOLO_LIFETIME_LINE, SOLO_SPECIALIST_CLAUSE,
  soloDirective, soloSquads, type BusinessSoloArgs,
} from "../lib/business-solo.ts";
import { ALLOWED_SQUADS_ENV, readSeats } from "../lib/business-session.ts";
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
    ...extra,
  };
}

describe("when solo applies", () => {
  test("only the setting turns it on, and any explicit shape turns it off", () => {
    const base = { forceTeam: false, forceSingle: false, requestedMode: "standard", businessMode: "solo" };
    expect(isBusinessSolo(base)).toBe(true);
    expect(isBusinessSolo({ ...base, businessMode: "chain" })).toBe(false);
    expect(isBusinessSolo({ ...base, forceTeam: true })).toBe(false);
    expect(isBusinessSolo({ ...base, forceSingle: true })).toBe(false);
    expect(isBusinessSolo({ ...base, requestedMode: "gauntlet" })).toBe(false);
  });

  test("the solo role may dispatch nothing", () => {
    for (const target of ["business", "employee", "squad", "agent-x", "planner", "exec", "solo"] as const) {
      expect(roleMayDispatch(target, { NIRVANA_DISPATCH_ROLE: "solo" })).toBe(false);
    }
  });
});

describe("the prompt", () => {
  const seats = () => readSeats(BIZ, lookup);

  test("the squads: router picks, named ones and the seats' closed sets, deduplicated", () => {
    expect(soloSquads({ mandatorySquads: ["a"], optionalSquads: ["b", "a"], briefSquads: ["c"] }, seats())).toEqual(["a", "b", "c", "email-squad"]);
  });

  test("a map of paths: the brief file, seats, voices, squad cards; never a seat body", () => {
    const prompt = buildSoloPrompt({ ...baseArgs(), briefFile: "/b/brief.md" }, seats(), ["/mem"], { "email-squad": "/cards/squad-email-squad.md" });
    expect(prompt).toContain("`/b/brief.md`. Read it first, and again at the start of every phase");
    expect(prompt).toContain("- `al-copy` (Copy chief): `" + path.join(BIZ, "employees", "al-copy.md") + "` · voices: `copy-legend` (`");
    expect(prompt).toContain("- `email-squad`: card `/cards/squad-email-squad.md`");
    expect(prompt).toContain("You never dispatch it.");
    expect(prompt).toContain(path.join(OUTPUTS, "_work", "PROGRESS.md"));
    expect(prompt).toContain(path.join(OUTPUTS, "_SUMMARY.md"));
    expect(prompt).toContain(path.join(OUTPUTS, "_CLAIMS.json"));
    expect(prompt).not.toContain(SEAT_BODY);
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
  test("the intake, premise and lifetime lines are replaced; nothing else changes", () => {
    const d = soloDirective(" RULES");
    expect(d).toContain(SOLO_INTAKE_LINE);
    expect(d).toContain(SOLO_SPECIALIST_CLAUSE);
    expect(d).toContain(SOLO_LIFETIME_LINE);
    expect(d).not.toContain("nrv dispatch --squad");
    expect(d).not.toContain("Delegate in the foreground");
    expect(d.endsWith(" RULES")).toBe(true);
    expect(d.split("\n").length).toBe(AUTONOMOUS_DIRECTIVE.split("\n").length);
  });
});

describe("runBusinessSolo", () => {
  test("one run, role solo, no subagents, squads refused by the environment, cards written", () => {
    let seen: any = null;
    let allowedDuring: string | undefined;
    const before = process.env[ALLOWED_SQUADS_ENV];
    const res = runBusinessSolo(baseArgs({
      runWithCascadeImpl: ((opts: any) => {
        seen = opts;
        allowedDuring = process.env[ALLOWED_SQUADS_ENV];
        return { ok: true, runtime: "claude-code", sessionId: "s-1", result: "", costUsd: null, durationMs: 5, finalRuntime: "claude-code", handoffs: [] };
      }) as any,
    }));
    expect(res.ok).toBe(true);
    expect(res.sessionId).toBe("s-1");
    expect(seen.dispatchRole).toBe("solo");
    expect(seen.allowSubagents).toBeUndefined();
    expect(allowedDuring).toBe("");
    expect(process.env[ALLOWED_SQUADS_ENV]).toBe(before);
    expect(seen.addDirs).toContain(path.join(TMP, "squads", "email-squad"));
    expect(fs.existsSync(path.join(PROJECT_DIR, "cards", "squad-email-squad.md"))).toBe(true);
    expect(fs.readFileSync(res.briefFile, "utf8")).toContain("Launch a course.");
    expect(res.launch.appendSystemPrompt).toContain(SOLO_INTAKE_LINE);
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
