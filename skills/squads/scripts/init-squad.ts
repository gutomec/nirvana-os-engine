#!/usr/bin/env bun
/**
 * init-squad.ts — Squad Protocol Engine v5 scaffolder (pure Bun port).
 *
 * Replaces init-squad.sh. Scaffolds a fresh v5 squad directory from
 * templates/squad.yaml.tmpl, substituting placeholders with values supplied
 * via flags or environment variables. Idempotent: refuses to overwrite an
 * existing squad.yaml unless --force.
 *
 * Usage:
 *   SQUAD_NAME=my-squad SQUAD_DESCRIPTION="..." \
 *   bun init-squad.ts $SQUADS_DIR/my-squad
 *
 *   bun init-squad.ts $SQUADS_DIR/my-squad \
 *     --name my-squad --description "..." --capability-id media.video.analyze \
 *     --capability-domains "media,content" --workflow-ref full-funnel
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { paths, EXIT } from "../../_shared/lib/bun-helpers.ts";

const argv = process.argv.slice(2);
if (argv.length < 1 || argv[0] === "-h" || argv[0] === "--help") {
  console.error("Usage: init-squad <target-dir> [--name N] [--description D] ...");
  process.exit(argv.length === 0 ? EXIT.INVALID_ARGS : EXIT.OK);
}

const targetDir = argv[0];
const env = process.env;

// Defaults: env vars override empty defaults; CLI flags override env.
const state: Record<string, string> = {
  NAME: env.SQUAD_NAME || "",
  DESCRIPTION: env.SQUAD_DESCRIPTION || "",
  AUTHOR: env.SQUAD_AUTHOR || env.USER || "unknown",
  PREFIX: env.SQUAD_PREFIX || "",
  TAG_1: env.SQUAD_TAG_1 || "domain",
  TAG_2: env.SQUAD_TAG_2 || "keyword",
  CAPABILITY_ID: env.SQUAD_CAPABILITY_ID || "",
  CAPABILITY_DESCRIPTION: env.SQUAD_CAPABILITY_DESCRIPTION || "",
  CAPABILITY_DOMAINS: env.SQUAD_CAPABILITY_DOMAINS || "marketing",
  WORKFLOW_REF: env.SQUAD_WORKFLOW_REF || "main-pipeline",
  EXAMPLE_INTENT_1: env.SQUAD_EXAMPLE_1 || "",
  EXAMPLE_INTENT_2: env.SQUAD_EXAMPLE_2 || "",
  EXAMPLE_INTENT_3: env.SQUAD_EXAMPLE_3 || "",
  ANTI_PATTERN_1: env.SQUAD_ANTI_1 || "",
  OUTPUT_NAME: env.SQUAD_OUTPUT_NAME || "deliverable",
  OUTPUT_DESCRIPTION: env.SQUAD_OUTPUT_DESCRIPTION || "Squad output deliverable",
  AGENT_1: env.SQUAD_AGENT_1 || "orchestrator",
  AGENT_2: env.SQUAD_AGENT_2 || "specialist",
  TASK_1: env.SQUAD_TASK_1 || "plan",
  TASK_2: env.SQUAD_TASK_2 || "execute",
};
let force = false;

const flagToKey: Record<string, string> = {
  "--name": "NAME",
  "--description": "DESCRIPTION",
  "--author": "AUTHOR",
  "--prefix": "PREFIX",
  "--capability-id": "CAPABILITY_ID",
  "--capability-description": "CAPABILITY_DESCRIPTION",
  "--capability-domains": "CAPABILITY_DOMAINS",
  "--workflow-ref": "WORKFLOW_REF",
};

let i = 1;
while (i < argv.length) {
  const a = argv[i];
  if (a === "--force") { force = true; i++; continue; }
  if (a === "--example") {
    const v = argv[i + 1];
    if (!state.EXAMPLE_INTENT_1) state.EXAMPLE_INTENT_1 = v;
    else if (!state.EXAMPLE_INTENT_2) state.EXAMPLE_INTENT_2 = v;
    else if (!state.EXAMPLE_INTENT_3) state.EXAMPLE_INTENT_3 = v;
    i += 2; continue;
  }
  const key = flagToKey[a];
  if (key) { state[key] = argv[i + 1]; i += 2; continue; }
  console.error(`[init-squad] Unknown flag: ${a}`);
  process.exit(EXIT.INVALID_ARGS);
}

// Apply defaults derived from NAME.
if (!state.NAME) state.NAME = path.basename(targetDir);
if (!state.PREFIX) state.PREFIX = state.NAME.replace(/-/g, "").slice(0, 3);
if (!state.DESCRIPTION) state.DESCRIPTION = `Squad ${state.NAME} — describe what this squad delivers (≥20 chars)`;
if (!state.CAPABILITY_ID) {
  const dotted = state.NAME.replace(/-/g, ".");
  state.CAPABILITY_ID = dotted.split(".").length < 3 ? `${dotted}.task.run` : dotted;
}
if (!state.CAPABILITY_DESCRIPTION) state.CAPABILITY_DESCRIPTION = state.DESCRIPTION;
if (!state.EXAMPLE_INTENT_1) state.EXAMPLE_INTENT_1 = `run ${state.NAME}`;
if (!state.EXAMPLE_INTENT_2) state.EXAMPLE_INTENT_2 = `execute ${state.NAME} pipeline`;
if (!state.EXAMPLE_INTENT_3) state.EXAMPLE_INTENT_3 = `kickoff ${state.NAME} for project`;
if (!state.ANTI_PATTERN_1) state.ANTI_PATTERN_1 = "single-step task (use a more focused capability)";

const skillDir = path.join(paths.CLAUDE_SKILLS_DIR, "squads");
const template = path.join(skillDir, "templates", "squad.yaml.tmpl");
if (!fs.existsSync(template)) {
  console.error(`[init-squad] FAIL: template not found at ${template}`);
  process.exit(2);
}

for (const sub of ["agents", "tasks", "workflows", "schemas"]) {
  fs.mkdirSync(path.join(targetDir, sub), { recursive: true });
}

const manifestPath = path.join(targetDir, "squad.yaml");
if (fs.existsSync(manifestPath) && !force) {
  console.error(`[init-squad] squad.yaml already exists at ${manifestPath} (use --force to overwrite)`);
  process.exit(EXIT.FAILURES);
}

let body = fs.readFileSync(template, "utf8");
const subs: Record<string, string> = {
  "{{SQUAD_NAME}}": state.NAME,
  "{{DESCRIPTION}}": state.DESCRIPTION,
  "{{AUTHOR}}": state.AUTHOR,
  "{{PREFIX}}": state.PREFIX,
  "{{TAG_1}}": state.TAG_1,
  "{{TAG_2}}": state.TAG_2,
  "{{CAPABILITY_ID}}": state.CAPABILITY_ID,
  "{{CAPABILITY_DESCRIPTION}}": state.CAPABILITY_DESCRIPTION,
  "{{CAPABILITY_DOMAINS}}": state.CAPABILITY_DOMAINS,
  "{{WORKFLOW_REF}}": state.WORKFLOW_REF,
  "{{EXAMPLE_INTENT_1}}": state.EXAMPLE_INTENT_1,
  "{{EXAMPLE_INTENT_2}}": state.EXAMPLE_INTENT_2,
  "{{EXAMPLE_INTENT_3}}": state.EXAMPLE_INTENT_3,
  "{{ANTI_PATTERN_1}}": state.ANTI_PATTERN_1,
  "{{OUTPUT_NAME}}": state.OUTPUT_NAME,
  "{{OUTPUT_DESCRIPTION}}": state.OUTPUT_DESCRIPTION,
  "{{AGENT_1}}": state.AGENT_1,
  "{{AGENT_2}}": state.AGENT_2,
  "{{TASK_1}}": state.TASK_1,
  "{{TASK_2}}": state.TASK_2,
};
for (const [k, v] of Object.entries(subs)) {
  body = body.split(k).join(v);
}
fs.writeFileSync(manifestPath, body, "utf8");

console.log(`[init-squad] Wrote ${manifestPath}`);
console.log("[init-squad] Created skeleton dirs: agents/ tasks/ workflows/ schemas/");
console.log("");
console.log("Next steps:");
console.log(`  1. Fill in agents/${state.AGENT_1}.md and agents/${state.AGENT_2}.md (use templates/agent.md.tmpl)`);
console.log(`  2. Fill in tasks/${state.TASK_1}.md and tasks/${state.TASK_2}.md`);
console.log(`  3. Fill in workflows/${state.WORKFLOW_REF}.yaml`);
console.log(`  4. Validate: bun ${path.join(skillDir, "scripts", "validate-squad.ts")} ${targetDir}`);
console.log(`  5. Index:    bun ${path.join(skillDir, "scripts", "index-squads.ts")}`);

process.exit(EXIT.OK);
