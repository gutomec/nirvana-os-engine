#!/usr/bin/env bun
// brief.ts — `nrv brief`: the six-section brief the orchestrator writes for one
// business (lib/work-brief.ts). The engine writes none of its content; it
// prints the skeleton, checks the sections and appends a mid-run decision.
//
//   nrv brief template                     print the skeleton
//   nrv brief check <file> [--json]        exit 0 complete · 1 sections missing or empty
//   nrv brief decide <file> "<decision>"   append a decision the user made while the work runs

import * as fs from "node:fs";
import { appendDecision, briefProblems, briefTemplate, doneWhenCriteria, parseWorkBrief, type Criterion } from "../lib/work-brief.ts";
import { resolveSetting } from "../../_shared/lib/settings.ts";

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
const [sub, file, ...rest] = process.argv.slice(2);

function usage(): never {
  console.error("usage: nrv brief template | check <file> [--json] | decide <file> \"<decision>\"");
  process.exit(EXIT_USAGE);
}

function readOrDie(f: string | undefined): string {
  if (!f) usage();
  if (!fs.existsSync(f)) { console.error(`brief not found: ${f}`); process.exit(EXIT_USAGE); }
  return fs.readFileSync(f, "utf8");
}

switch (sub) {
  case "template":
    process.stdout.write(briefTemplate());
    break;
  case "check": {
    const text = readOrDie(file);
    const criteria = doneWhenCriteria(text);
    const problems = [...briefProblems(parseWorkBrief(text)), ...settingProblems(text, criteria)];
    if (rest.includes("--json")) console.log(JSON.stringify({ ok: problems.length === 0, problems, criteria }, null, 2));
    else if (problems.length) for (const p of problems) console.error(p);
    else console.log(`brief ok: ${criteria.length} "Done when" criteria (${criteria.filter((c) => c.blocking).length} blocking)`);
    process.exit(problems.length ? 1 : 0);
  }
  case "decide": {
    readOrDie(file);
    const decision = rest.join(" ").trim();
    if (!decision) usage();
    appendDecision(file!, decision);
    console.log(`decision added to ${file}`);
    break;
  }
  default:
    usage();
}
