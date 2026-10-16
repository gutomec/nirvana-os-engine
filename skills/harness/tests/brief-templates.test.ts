// brief-templates.test.ts — the brief templates: slim, standard, detailed and
// karpathy from the engine, overridden or added by name in the project or the
// global home; the commands that print, list and copy them; both brief formats
// read into the same criteria; the user's words by path; the record a run keeps.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  engineTemplate, findTemplate, listTemplates, recordBriefTemplate, recordRequest, resolveActiveTemplate, sha256,
} from "../lib/brief-templates.ts";
import { briefAltitude } from "../lib/brief-altitude.ts";
import {
  appendDecision, briefProblems, briefSession, briefWithRequest, doneWhenCriteria, parseWorkBrief, requestFile, requestWords,
} from "../lib/work-brief.ts";
import { buildSoloPrompt, type BusinessSoloArgs } from "../lib/business-solo.ts";
import { buildSoloReviewPrompt } from "../lib/solo-review.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const BRIEF_CLI = path.join(REPO, "skills", "harness", "scripts", "brief.ts");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-brief-templates-")));
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

let n = 0;
/** A fresh home and a declared project inside it. */
function sandbox(): { home: string; project: string } {
  const home = path.join(TMP, `h${++n}`);
  const project = path.join(home, "work", "proj");
  fs.mkdirSync(path.join(project, ".nirvana"), { recursive: true });
  fs.writeFileSync(path.join(project, ".nirvana", "project.yaml"), "name: proj\n");
  return { home, project };
}

function envFor(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const e: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, NIRVANA_HOME: home, ...extra };
  for (const k of ["NIRVANA_BRIEF_TEMPLATE", "NIRVANA_BRIEF_ALTITUDE", "NIRVANA_PROJECT_ROOT"]) if (!(k in extra)) delete e[k];
  return e as Record<string, string>;
}

function cli(args: string[], cwd: string, home: string, extra: Record<string, string> = {}, input?: string) {
  return spawnSync(process.execPath, [BRIEF_CLI, ...args], { cwd, encoding: "utf8", env: envFor(home, extra), input });
}

function writeTemplate(dir: string, name: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, body);
  return file;
}

const CUSTOM = (marker: string) => `---\nname: x\nformat: labels\nrequired: [Request, Done when]\n---\n\n# ${marker}\n\n## The brief\n\n\`\`\`\nGoal: ${marker}\nRequest: <path>\nDone when:\n- <check>\n\`\`\`\n`;

describe("the engine templates", () => {
  test("slim, standard, detailed and karpathy ship, each with Request and Done when required", () => {
    const names = listTemplates({ projectRoot: null, env: { NIRVANA_HOME: path.join(TMP, "none") } }).map((t) => t.name);
    for (const name of ["slim", "standard", "detailed", "karpathy"]) {
      expect(names).toContain(name);
      const t = engineTemplate(name);
      expect(t.required).toContain(t.format === "labels" ? "Request" : "Request (verbatim)");
      expect(t.required).toContain("Done when");
      // Its own skeleton carries every label it requires.
      expect(briefProblems(parseWorkBrief(t.skeleton), t.required)).toEqual([]);
    }
  });

  test("slim is short: at most about 150 words in the skeleton", () => {
    expect(engineTemplate("slim").skeleton.split(/\s+/).filter(Boolean).length).toBeLessThan(150);
  });

  test("karpathy states its cost and keeps its explain-back checks non-blocking", () => {
    const t = engineTemplate("karpathy");
    expect(t.text).toContain("costs more tokens per delivery");
    expect(t.text).toContain("https://x.com/karpathy/status/2105819303471976479");
    expect(parseWorkBrief(t.skeleton).sections["Explain back"]).toContain("80% of the way to ASD-STE100");
    const extra = doneWhenCriteria(t.skeleton).slice(1);
    expect(extra.length).toBe(2);
    for (const c of extra) { expect(c.blocking).toBe(false); expect(c.description).not.toContain("non-blocking"); }
  });
});

describe("lookup: project > global > engine", () => {
  test("a name resolves to the most specific file, and a new name can live in any layer", () => {
    const { home, project } = sandbox();
    const opts = { cwd: project, env: { NIRVANA_HOME: home, HOME: home } };
    expect(findTemplate("slim", opts)!.origin).toBe("engine");
    writeTemplate(path.join(home, ".nirvana", "brief-templates"), "slim", CUSTOM("global-slim"));
    expect(findTemplate("slim", opts)!.origin).toBe("global");
    writeTemplate(path.join(project, ".nirvana", "brief-templates"), "slim", CUSTOM("project-slim"));
    const t = findTemplate("slim", opts)!;
    expect(t.origin).toBe("project");
    expect(t.skeleton).toContain("Goal: project-slim");
    writeTemplate(path.join(home, ".nirvana", "brief-templates"), "juridico", CUSTOM("juridico"));
    const listed = listTemplates(opts);
    expect(listed.find((l) => l.name === "slim")!.overrides).toEqual(["global", "engine"]);
    expect(listed.find((l) => l.name === "juridico")!.origin).toBe("global");
  });

  test("nrv brief template prints the project's file, its origin and name; --template picks another", () => {
    const { home, project } = sandbox();
    writeTemplate(path.join(project, ".nirvana", "brief-templates"), "slim", CUSTOM("project-slim"));
    const r = cli(["template"], project, home);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Goal: project-slim");
    expect(r.stderr).toContain("brief template: slim (project:");
    const std = cli(["template", "--template", "standard"], project, home);
    expect(std.stdout).toBe(engineTemplate("standard").skeleton);
    expect(std.stderr).toContain("chosen by --template");
  }, 30_000);

  test("briefing.template picks the template; an unknown name is an error that lists the names", () => {
    const { home, project } = sandbox();
    const ok = cli(["template"], project, home, { NIRVANA_BRIEF_TEMPLATE: "karpathy" });
    expect(ok.stdout).toBe(engineTemplate("karpathy").skeleton);
    const bad = cli(["template"], project, home, { NIRVANA_BRIEF_TEMPLATE: "nope" });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('no brief template named "nope"');
    expect(bad.stderr).toContain("slim, standard");
    const brief = path.join(project, "b.md");
    fs.writeFileSync(brief, "Request: x.md\nDone when:\n- y\n");
    expect(cli(["check", brief], project, home, { NIRVANA_BRIEF_TEMPLATE: "nope" }).status).not.toBe(0);
  }, 30_000);

  test("nrv brief templates lists every name with its origin", () => {
    const { home, project } = sandbox();
    writeTemplate(path.join(project, ".nirvana", "brief-templates"), "juridico", CUSTOM("j"));
    const r = cli(["templates"], project, home);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/juridico\s+project/);
    expect(r.stdout).toMatch(/\* slim\s+engine/);
  }, 30_000);
});

describe("briefing.altitude, the legacy alias", () => {
  const active = (env: Record<string, string>) => resolveActiveTemplate({ env, projectRoot: null, globalPath: null, enginePath: null });

  test("unset: slim; a stored altitude maps, with a deprecation note", () => {
    expect(active({}).name).toBe("slim");
    expect(active({}).note).toBeUndefined();
    expect(active({ NIRVANA_BRIEF_ALTITUDE: "outcome" }).name).toBe("standard");
    expect(active({ NIRVANA_BRIEF_ALTITUDE: "guided" }).name).toBe("standard");
    expect(active({ NIRVANA_BRIEF_ALTITUDE: "prescriptive" }).name).toBe("detailed");
    expect(active({ NIRVANA_BRIEF_ALTITUDE: "prescriptive" }).note).toContain("use nrv config set briefing.template detailed");
  });

  test("briefing.template wins, and the altitude is then ignored", () => {
    const a = active({ NIRVANA_BRIEF_TEMPLATE: "slim", NIRVANA_BRIEF_ALTITUDE: "prescriptive" });
    expect(a.name).toBe("slim");
    expect(a.note).toBeUndefined();
    expect(briefAltitude({ env: { NIRVANA_BRIEF_TEMPLATE: "slim", NIRVANA_BRIEF_ALTITUDE: "prescriptive" }, projectRoot: null, globalPath: null, enginePath: null })).toBe("outcome");
    expect(briefAltitude({ env: { NIRVANA_BRIEF_TEMPLATE: "detailed" }, projectRoot: null, globalPath: null, enginePath: null })).toBe("prescriptive");
  });
});

describe("nrv brief init", () => {
  test("copies the engine's template, refuses to overwrite, --force overwrites, --from starts a new name", () => {
    const { home, project } = sandbox();
    const first = cli(["init", "slim", "--project"], project, home);
    expect(first.status).toBe(0);
    const dest = path.join(project, ".nirvana", "brief-templates", "slim.md");
    expect(fs.readFileSync(dest, "utf8")).toBe(engineTemplate("slim").text);
    fs.writeFileSync(dest, "edited");
    const again = cli(["init", "slim", "--project"], project, home);
    expect(again.status).not.toBe(0);
    expect(fs.readFileSync(dest, "utf8")).toBe("edited");
    expect(cli(["init", "slim", "--project", "--force"], project, home).status).toBe(0);
    expect(fs.readFileSync(dest, "utf8")).toBe(engineTemplate("slim").text);

    const custom = cli(["init", "juridico", "--from", "detailed", "--global"], project, home);
    expect(custom.status).toBe(0);
    const g = fs.readFileSync(path.join(home, ".nirvana", "brief-templates", "juridico.md"), "utf8");
    expect(g).toMatch(/^name: juridico$/m);
    expect(cli(["init", "juridico", "--global"], project, home).status).not.toBe(0); // no engine template of that name
    expect(cli(["init", "slim"], project, home).status).not.toBe(0); // neither --project nor --global
  }, 60_000);
});

// The same decisions and checks, written in each format.
const OLD = [
  "## Request (verbatim)", "Quero um relatório de vendas.", "",
  "## Decisions", "- squad data-squad", "",
  "## Your part", "O relatório.", "",
  "## Inputs", "None.", "",
  "## Done when", "- The report lists every region (blocking)", "- Must cite the source", "- A chart per quarter", "",
  "## Output", "report.md", "",
].join("\n");

describe("both formats, one reading", () => {
  test("old six-section and slim briefs give the same criteria d1..dn", () => {
    const dir = path.join(TMP, "fmt");
    fs.mkdirSync(dir, { recursive: true });
    const req = path.join(dir, "acme.request.md");
    fs.writeFileSync(req, "Quero um relatório de vendas.\n");
    const slim = [
      "Goal: O relatório.", `Request: ${req}`, "Decisions:", "- squad data-squad", "Inputs: None.", "Deliver: report.md",
      "Done when:", "- The report lists every region (blocking)", "- Must cite the source", "- A chart per quarter", "Session: new", "",
    ].join("\n");
    expect(parseWorkBrief(OLD).format).toBe("sections");
    expect(parseWorkBrief(slim).format).toBe("labels");
    expect(doneWhenCriteria(slim)).toEqual(doneWhenCriteria(OLD));
    expect(doneWhenCriteria(slim).map((c) => c.id)).toEqual(["d1", "d2", "d3"]);
    expect(parseWorkBrief(slim).sections.Goal).toBe(parseWorkBrief(OLD).sections.Goal);
    expect(parseWorkBrief(slim).sections.Deliver).toBe(parseWorkBrief(OLD).sections.Deliver);
    expect(requestWords(slim)).toBe(requestWords(OLD));
    expect(briefProblems(parseWorkBrief(slim))).toEqual([]);
  });

  test("a heading appended to a slim brief (router, --continue-from) still reads", () => {
    const text = "Request: /x/r.md\nDone when:\n- a\n\n## Continues\nThis brief continues p1.\n\n## Done when\n- b\n";
    expect(doneWhenCriteria(text).map((c) => c.description)).toEqual(["a", "b"]);
  });

  test("the Session line: new, continue <project>, or a problem", () => {
    expect(briefSession("Request: a.md\nSession: new\n")).toEqual({ kind: "new" });
    expect(briefSession("Request: a.md\nSession: continue 20261001-copy\n")).toEqual({ kind: "continue", project: "20261001-copy" });
    expect(briefSession("Request: a.md\nSession: review x\n")!.kind).toBe("invalid");
    expect(briefSession(OLD)).toBeNull();
  });

  test("nrv brief decide appends under Decisions in a slim brief, replacing None.", () => {
    const file = path.join(TMP, "decide.md");
    fs.writeFileSync(file, "Goal: g\nRequest: r.md\nDecisions: None.\nDone when:\n- a\n");
    appendDecision(file, "Use the blue palette");
    appendDecision(file, "Ship on Friday");
    const parsed = parseWorkBrief(fs.readFileSync(file, "utf8"));
    expect(parsed.sections.Decisions).toBe("- Use the blue palette\n- Ship on Friday");
    expect(doneWhenCriteria(fs.readFileSync(file, "utf8")).length).toBe(1);
  });
});

describe("nrv brief check: the labels the template needs", () => {
  test("a slim brief without Done when, or with the request pasted, is refused; a good one passes", () => {
    const { home, project } = sandbox();
    const req = cli(["request", "acme", "--text", "Quero um site."], project, home);
    expect(req.status).toBe(0);
    const reqPath = req.stdout.trim();
    expect(reqPath).toBe(path.join(project, ".nirvana", "briefs", "acme.request.md"));
    expect(fs.readFileSync(reqPath, "utf8")).toBe("Quero um site.\n");

    const file = path.join(project, ".nirvana", "briefs", "acme.md");
    fs.writeFileSync(file, `Goal: um site\nRequest: ${reqPath}\n`);
    const missing = cli(["check", file], project, home);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("missing label: Done when:");

    fs.writeFileSync(file, "Goal: um site\nRequest: Quero um site.\nDone when:\n- a home page (blocking)\n");
    expect(cli(["check", file], project, home).stderr).toContain("Request holds text, not a path");

    fs.writeFileSync(file, `Goal: um site\nRequest: .nirvana/briefs/acme.request.md\nDone when:\n- a home page (blocking)\nSession: new\n`);
    const ok = cli(["check", file], project, home);
    expect(ok.stderr).toBe("");
    expect(ok.stdout).toContain("brief ok (slim): 1");
  }, 60_000);

  test("an old six-section brief is checked against the standard template's sections", () => {
    const { home, project } = sandbox();
    const file = path.join(project, "old.md");
    fs.writeFileSync(file, OLD.replace("## Output\nreport.md\n", ""));
    const r = cli(["check", file], project, home);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("missing section: ## Output");
    fs.writeFileSync(file, OLD);
    expect(cli(["check", file], project, home).status).toBe(0);
  }, 30_000);

  test("template --for puts the request path on the Request line", () => {
    const { home, project } = sandbox();
    const r = cli(["template", "--for", "acme"], project, home);
    expect(r.stdout).toContain(`Request: ${path.join(project, ".nirvana", "briefs", "acme.request.md")}`);
  }, 30_000);
});

describe("the user's words travel by path", () => {
  const dir = path.join(TMP, "req");
  fs.mkdirSync(path.join(dir, ".nirvana", "briefs"), { recursive: true });
  const req = path.join(dir, ".nirvana", "briefs", "acme.request.md");
  fs.writeFileSync(req, "Escreva o post no estilo do Gary Halbert.\n");
  const briefFile = path.join(dir, ".nirvana", "briefs", "acme.md");
  const brief = "Goal: o post\nRequest: .nirvana/briefs/acme.request.md\nDone when:\n- o post existe\n";

  test("a relative path resolves from the project above .nirvana/briefs", () => {
    expect(requestFile(brief, { briefFile })).toBe(req);
    expect(requestWords(brief, { briefFile })).toBe("Escreva o post no estilo do Gary Halbert.");
  });

  test("the gate and pasted prompts get the words appended", () => {
    const t = briefWithRequest(brief, { briefFile });
    expect(t).toContain("## The user's words (verbatim, from");
    expect(t).toContain("Gary Halbert");
    expect(doneWhenCriteria(t)).toEqual(doneWhenCriteria(brief));
    expect(briefWithRequest(OLD)).toBe(OLD);
  });

  test("the worker and the reviewer are pointed at the file", () => {
    const args = { slug: "acme", bizDir: "/biz", brief, projectId: "p", projectDir: "/p/run", projectRoot: dir, outputsRoot: "/p/out", runtime: "claude-code", briefFile } as unknown as BusinessSoloArgs & { briefFile: string };
    expect(buildSoloPrompt(args, [], [], {}, [], { requestFile: req })).toContain(`The user's words, verbatim: \`${req}\``);
    expect(buildSoloReviewPrompt({ business: "acme", briefFile, outputsRoot: "/p/out", criteria: [], claims: null, requestFile: req })).toContain(`The user's words, verbatim: \`${req}\``);
  });
});

describe("the run keeps what it was briefed with", () => {
  test("the template and the request are copied into the run folder with their sha256", () => {
    const { home, project } = sandbox();
    const run = path.join(project, "outputs", "run-1");
    const active = resolveActiveTemplate({ cwd: project, env: { NIRVANA_HOME: home, HOME: home } });
    const rec = recordBriefTemplate(run, active);
    expect(rec.template).toBe("slim");
    expect(rec.origin).toBe("engine");
    expect(fs.readFileSync(rec.copy!, "utf8")).toBe(engineTemplate("slim").text);
    expect(rec.sha256).toBe(sha256(engineTemplate("slim").text));
    const req = path.join(project, "r.request.md");
    fs.writeFileSync(req, "As palavras.\n");
    const r = recordRequest(run, `Request: ${req}\nDone when:\n- x\n`);
    expect(r.file).toBe(req);
    expect(fs.readFileSync(r.copy!, "utf8")).toBe("As palavras.\n");
    expect(r.sha256).toBe(sha256("As palavras.\n"));
  });

  test("every dispatch route records x_brief_template; the Session line continues a project", () => {
    const src = fs.readFileSync(path.join(REPO, "skills", "harness", "scripts", "dispatch.ts"), "utf8");
    expect(src).toContain('emit("x_brief_template"');
    expect(src.match(/recordBriefRun\(scaffoldRoot, pid,/g)?.length).toBe(3);
    expect(src).toContain('briefSessionLine?.kind === "continue" ? briefSessionLine.project');
  });
});

describe("the orchestrator's protocol", () => {
  test("SKILL.md section 3 points at the template instead of spelling the format", () => {
    const skill = fs.readFileSync(path.join(REPO, "skills", "harness", "SKILL.md"), "utf8");
    const s3 = skill.slice(skill.indexOf("## 3. Write one brief per business"), skill.indexOf("## 4. Dispatch"));
    expect(s3).toContain("nrv brief request <business>");
    expect(s3).toContain("nrv brief template --for <business>");
    expect(s3).toContain("nrv brief check");
    expect(s3).toContain("Read that file and follow it");
    expect(s3).not.toContain("Six sections");
    expect(s3.split("\n").length).toBeLessThan(35);
  });
});
