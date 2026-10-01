#!/usr/bin/env bun
// brief.ts — `nrv brief`: the six-section brief the orchestrator writes for one
// business (lib/work-brief.ts). The engine writes none of its content; it
// prints the skeleton, checks the sections and appends a mid-run decision.
//
//   nrv brief template                     print the skeleton
//   nrv brief check <file> [--json]        exit 0 complete · 1 sections missing or empty
//   nrv brief decide <file> "<decision>"   append a decision the user made while the work runs

import * as fs from "node:fs";
import { appendDecision, briefProblems, briefTemplate, doneWhenCriteria, parseWorkBrief } from "../lib/work-brief.ts";

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
    const problems = briefProblems(parseWorkBrief(text));
    const criteria = doneWhenCriteria(text);
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
