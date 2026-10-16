#!/usr/bin/env bun
// brief.ts — `nrv brief`: the brief the orchestrator writes for one business
// (lib/work-brief.ts), written with a brief template (lib/brief-templates.ts).
// The engine writes none of its content; it prints the template, keeps the
// user's words in a file, checks the labels and appends a mid-run decision.
//
//   nrv brief template [--template <name>] [--for <name>] [--full]
//                                          the active template's skeleton on stdout; its name,
//                                          origin and path on stderr (--full prints the whole file)
//   nrv brief templates [--json]           every template name, and where it comes from
//   nrv brief request <name> [--text "<words>"]   write the user's words (stdin without --text) to
//                                          .nirvana/briefs/<name>.request.md; prints its path
//   nrv brief check <file> [--template <name>] [--json]
//                                          exit 0 complete · 1 labels missing or empty
//   nrv brief decide <file> "<decision>"   append a decision the user made while the work runs
//   nrv brief init <name> [--from <name>] (--project|--global) [--force]
//                                          copy a template where you can edit it

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendDecision, briefProblems, briefSession, doneWhenCriteria, parseWorkBrief, requestFile,
  requestLooksLikePath, skeletonWithRequest, type Criterion,
} from "../lib/work-brief.ts";
import { resolveSetting } from "../../_shared/lib/settings.ts";
import {
  activeSkeleton, engineTemplate, findTemplate, listTemplates, resolveActiveTemplate, templateDirs,
  templateProblems, templatesProjectRoot, TEMPLATE_NAME, unknownTemplateMessage, type BriefTemplate,
} from "../lib/brief-templates.ts";

/** Evidence only a visual self-check produces: screenshots, a visual review, a
 *  GUI walked through. Matched in English and Portuguese, the two languages
 *  briefs are written in here. */
const VISUAL_EVIDENCE = /screenshots?|screen ?captures?|capturas? de tela|revis[aã]o visual|visual review|evid[eê]ncias? (de )?(revis[aã]o )?visua|visual evidence|lighthouse/i;

/** What the brief asks that the run's settings forbid. A run with
 *  execution.visual_checks off takes no screenshots and drives no GUI, so a
 *  criterion that needs them can never pass the gate: a test run failed it in
 *  five correction rounds. And a brief cannot switch a setting on by saying so:
 *  a worker read "visual_checks enabled" in one and drove the user's app on
 *  their screen while the setting was off. */
function settingProblems(text: string, criteria: Criterion[]): string[] {
  if (resolveSetting("execution.visual_checks").value) return [];
  const out = criteria
    .filter((c) => VISUAL_EVIDENCE.test(c.description))
    .map((c) => `"Done when" ${c.id} asks for visual evidence, but execution.visual_checks is off: workers take no screenshots and drive no GUI, so the gate cannot pass it. Drop it, or turn the setting on (nrv config set execution.visual_checks true --project) if the user asked for visual review.`);
  if (/visual_checks/.test(text)) out.push("The brief mentions execution.visual_checks: a brief does not change settings. Remove the mention; if the user asked, change the setting with nrv config set.");
  return out;
}

const EXIT_USAGE = 64;
const argv = process.argv.slice(2);
const sub = argv[0];
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !["--template", "--for", "--text", "--from"].includes(all[i - 1] ?? ""));
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
};
const has = (name: string) => argv.includes(name);

function usage(): never {
  console.error([
    "usage: nrv brief template [--template <name>] [--for <name>] [--full]",
    "       nrv brief templates [--json]",
    "       nrv brief request <name> [--text \"<the user's words>\"]   (stdin without --text)",
    "       nrv brief check <file> [--template <name>] [--json]",
    "       nrv brief decide <file> \"<decision>\"",
    "       nrv brief init <name> [--from <name>] (--project|--global) [--force]",
  ].join("\n"));
  process.exit(EXIT_USAGE);
}

function die(message: string, code = EXIT_USAGE): never {
  console.error(message);
  process.exit(code);
}

function readOrDie(f: string | undefined): string {
  if (!f) usage();
  if (!fs.existsSync(f)) die(`brief not found: ${f}`);
  return fs.readFileSync(f, "utf8");
}

/** Where `nrv brief request <name>` keeps the user's words: beside the briefs. */
function requestPathFor(name: string): string {
  return path.resolve(process.cwd(), ".nirvana", "briefs", `${name}.request.md`);
}

function checkName(name: string | undefined, what: string): string {
  if (!name) usage();
  if (!TEMPLATE_NAME.test(name)) die(`${what} must be a plain name (letters, digits, '.', '_', '-'): '${name}'`);
  return name;
}

switch (sub) {
  case "template": {
    // stdout is the skeleton (it is redirected into the brief file); the
    // template's name, origin and path go to stderr, for the orchestrator.
    const override = flag("--template");
    if (override !== undefined) checkName(override, "--template");
    const active = resolveActiveTemplate({ override });
    if (!active.template) die(`✗ ${active.note ?? unknownTemplateMessage(active.name)}`);
    const t = active.template;
    console.error(`brief template: ${t.name} (${t.origin}: ${t.path}; chosen by ${active.source}). Read it and follow it: ${t.description || "it says how to write the brief."}`);
    if (active.note) console.error(`note: ${active.note}`);
    for (const p of templateProblems(t)) console.error(`warning: ${p}`);
    if (has("--full")) { process.stdout.write(t.text); break; }
    let skeleton = activeSkeleton(active);
    const forName = flag("--for");
    if (forName !== undefined) {
      checkName(forName, "--for");
      const req = requestPathFor(forName);
      skeleton = skeletonWithRequest(skeleton, req);
      if (!fs.existsSync(req)) console.error(`request: ${req} does not exist yet; write the user's words there with nrv brief request ${forName}`);
    }
    process.stdout.write(skeleton);
    break;
  }
  case "templates": {
    const list = listTemplates();
    const active = resolveActiveTemplate();
    if (has("--json")) { console.log(JSON.stringify({ active: active.name, templates: list }, null, 2)); break; }
    for (const t of list) {
      const mark = t.name === active.name ? "*" : " ";
      const over = t.overrides.length ? ` (overrides ${t.overrides.join(", ")})` : "";
      console.log(`${mark} ${t.name.padEnd(12)} ${t.origin.padEnd(7)} ${t.description}${over}`);
    }
    console.log(`\nactive: ${active.name} (${active.source})${active.template ? "" : " — not found"}`);
    console.log(`search order: ${templateDirs().map((d) => `${d.origin} ${d.dir}`).join(" > ")}`);
    break;
  }
  case "request": {
    const name = checkName(positional[0], "the brief name");
    const text = flag("--text") ?? (process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8"));
    if (!text.trim()) die("nrv brief request: no words given (pass --text \"...\" or pipe them on stdin)");
    const file = requestPathFor(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${text.replace(/^﻿/, "").replace(/\r\n/g, "\n").trim()}\n`, "utf8");
    console.log(file);
    break;
  }
  case "check": {
    const file = positional[0];
    const text = readOrDie(file);
    const override = flag("--template");
    if (override !== undefined) checkName(override, "--template");
    const active = resolveActiveTemplate({ override });
    if (!active.template) die(`✗ ${active.note ?? unknownTemplateMessage(active.name)}`, 1);
    const parsed = parseWorkBrief(text);
    // The labels of the template the brief was written with; a brief in the
    // other format is read as the engine's template of that format.
    const against: BriefTemplate = parsed.format === "none" || parsed.format === active.template.format
      ? active.template
      : engineTemplate(parsed.format === "labels" ? "slim" : "standard");
    const problems = [...briefProblems(parsed, against.required)];
    if (parsed.format === "labels" && parsed.sections.Request !== undefined && !requestFile(text, { briefFile: file })) {
      const v = parsed.sections.Request.trim();
      problems.push(requestLooksLikePath(v)
        ? `Request: ${v} is not a file. Write the user's words with nrv brief request <name> and put the path it prints here.`
        : "Request holds text, not a path: the user's words go in a file (nrv brief request <name>) and Request names that path.");
    }
    const session = briefSession(text);
    if (session?.kind === "invalid") problems.push(`Session: "${session.raw}" is not "new" or "continue <project>".`);
    const criteria = doneWhenCriteria(text);
    problems.push(...settingProblems(text, criteria));
    if (has("--json")) console.log(JSON.stringify({ ok: problems.length === 0, template: against.name, format: parsed.format, problems, criteria }, null, 2));
    else if (problems.length) for (const p of problems) console.error(p);
    else console.log(`brief ok (${against.name}): ${criteria.length} "Done when" criteria (${criteria.filter((c) => c.blocking).length} blocking)`);
    process.exit(problems.length ? 1 : 0);
  }
  case "decide": {
    const file = positional[0];
    readOrDie(file);
    const decision = positional.slice(1).join(" ").trim();
    if (!decision) usage();
    appendDecision(file!, decision);
    console.log(`decision added to ${file}`);
    break;
  }
  case "init": {
    const name = checkName(positional[0], "the template name");
    const project = has("--project");
    const global = has("--global");
    if (project === global) die("nrv brief init: pass exactly one of --project or --global");
    const from = flag("--from");
    if (from !== undefined) checkName(from, "--from");
    const source = from ? findTemplate(from) : (() => { try { return engineTemplate(name); } catch { return null; } })();
    if (!source) die(from ? `✗ ${unknownTemplateMessage(from)}` : `✗ the engine has no template named "${name}"; start it from one: nrv brief init ${name} --from slim ${project ? "--project" : "--global"}`);
    let dir: string;
    if (project) {
      const root = templatesProjectRoot() ?? process.cwd();
      const home = path.resolve(process.env.NIRVANA_HOME || os.homedir());
      if (path.resolve(root) === home || path.resolve(root) === path.resolve(os.homedir())) die("nrv brief init --project: run it inside a project (nrv init declares one), not in your home");
      dir = path.join(root, ".nirvana", "brief-templates");
    } else {
      dir = templateDirs().find((d) => d.origin === "global")!.dir;
    }
    const dest = path.join(dir, `${name}.md`);
    if (fs.existsSync(dest) && !has("--force")) die(`✗ ${dest} exists; pass --force to overwrite it`);
    let text = source.text;
    if (name !== source.name) text = text.replace(/^(---\n[\s\S]*?^name:\s*).*$/m, `$1${name}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dest, text, "utf8");
    console.log(`${dest} (from ${source.origin} ${source.name}). Edit it; keep the labels its "required" list names. Select it with: nrv config set briefing.template ${name} ${project ? "--project" : "--global"}`);
    break;
  }
  default:
    usage();
}
