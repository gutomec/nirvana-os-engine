#!/usr/bin/env bun
/**
 * resume-project.ts — read HANDOFF.json + emit resumption prompt.
 *
 * Usage:
 *   bun resume-project.ts <project_id> [--print | --dispatch]
 *
 *   --print     (default) prints the resumption prompt to stdout.
 *   --dispatch  hands the prompt to the host agent runtime via
 *               host-agent-driver.callHostAgentAsync. The runtime resumes
 *               with the prompt as user message — same intelligence,
 *               new clean context window.
 *
 * Searches for the project in (in order):
 *   1. <cwd>/.nirvana/logs/maestro/<project_id>/HANDOFF.json   (project scope)
 *   2. ~/.maestro-logs/<project_id>/HANDOFF.json               (global scope)
 *   3. <project_id> as absolute path
 *
 * Emits a `resume` audit event via harness/lib/audit.js.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { paths, parseArgs, EXIT } from "../lib/bun-helpers.ts";

const handoff = require(path.join(paths.CLAUDE_SKILLS_DIR, "_shared", "lib", "handoff.js"));

const { positional, flags } = parseArgs();
const projectIdArg = positional[0];
const dispatch = !!flags.dispatch;

if (!projectIdArg) {
  console.error("usage: resume-project <project_id> [--print | --dispatch]");
  process.exit(EXIT.INVALID_ARGS);
}

function dirHasHandoff(d: string): boolean {
  return fs.existsSync(path.join(d, "HANDOFF.json"));
}

function findHandoffUnder(root: string): string | null {
  if (!fs.existsSync(root)) return null;
  if (dirHasHandoff(root)) return root;
  // First, try direct businesses/* layout (brief-business.ts default).
  const businesses = path.join(root, "businesses");
  if (fs.existsSync(businesses)) {
    try {
      const subs = fs.readdirSync(businesses);
      for (const s of subs) {
        const p = path.join(businesses, s);
        if (dirHasHandoff(p)) return p;
      }
    } catch { /* fall through */ }
  }
  // Otherwise, shallow sub-search (one level only — avoid runaway).
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(root, e.name);
      if (dirHasHandoff(p)) return p;
    }
  } catch { /* fall through */ }
  return null;
}

function findProjectDir(arg: string): string | null {
  // Absolute path first
  if (arg.startsWith("/") && fs.existsSync(arg)) {
    if (fs.statSync(arg).isDirectory()) {
      const r = findHandoffUnder(arg);
      if (r) return r;
    }
  }
  const candidates = [
    // Project-scope maestro logs
    path.join(process.cwd(), ".nirvana", "logs", "maestro", arg),
    // Global-scope maestro logs
    path.join(os.homedir(), ".maestro-logs", arg),
    // brief-business layout (cwd-relative)
    path.join(process.cwd(), ".projects-outputs", arg),
    // brief-business layout (HOME global)
    path.join(os.homedir(), ".projects-outputs", arg),
  ];
  for (const c of candidates) {
    const r = findHandoffUnder(c);
    if (r) return r;
  }
  return null;
}

const projectDir = findProjectDir(projectIdArg);
if (!projectDir) {
  console.error(`[resume-project] project not found for id: ${projectIdArg}`);
  console.error(`  searched: cwd/.nirvana/logs/maestro/${projectIdArg}, ~/.maestro-logs/${projectIdArg}, cwd/.projects-outputs/${projectIdArg}`);
  process.exit(EXIT.FAILURES);
}

const data = handoff.readHandoff(projectDir);
if (!data) {
  console.error(`[resume-project] HANDOFF.json missing in ${projectDir}`);
  console.error(`  Run brief-business.ts to create one, or write manually.`);
  process.exit(EXIT.FAILURES);
}

const prompt = handoff.buildResumePrompt(data);

// Emit audit `resume` event
try {
  const audit = require(path.join(paths.CLAUDE_SKILLS_DIR, "harness", "lib", "audit.js"));
  audit.emit("resume", {
    project_id: data.project_id,
    business_slug: data.business_slug,
    phase: data.phase,
    fingerprint: handoff.fingerprint(data),
    dispatch,
  });
} catch { /* non-fatal */ }

if (!dispatch) {
  process.stdout.write(prompt);
  process.stdout.write("\n");
  process.exit(EXIT.OK);
}

// --dispatch: hand the prompt to the host runtime
(async () => {
  let driver: any = null;
  try { driver = require(path.join(paths.CLAUDE_SKILLS_DIR, "_shared", "lib", "host-agent-driver.js")); }
  catch { /* try .ts */ }
  if (!driver) {
    try { driver = require(path.join(paths.CLAUDE_SKILLS_DIR, "_shared", "lib", "host-agent-driver.ts")); } catch {}
  }
  if (!driver || !driver.callHostAgentAsync) {
    console.error(`[resume-project] --dispatch requested but host-agent-driver not loadable.`);
    process.exit(EXIT.FAILURES);
  }
  const host = driver.detectHost?.();
  if (!host) {
    console.error(`[resume-project] --dispatch requested but no host runtime detected on PATH.`);
    process.exit(EXIT.FAILURES);
  }
  const persona = `You are resuming an in-progress autonomous project. Read the resumption brief below and continue the workflow from where it left off. Mirror the user's language. Use the Nirvana harness to route any new work.`;
  const r = await driver.callHostAgentAsync(persona, prompt, { timeoutMs: 240_000 });
  if ("error" in r) {
    console.error(`[resume-project] dispatch failed: ${r.error}`);
    process.exit(EXIT.FAILURES);
  }
  process.stdout.write(r.text + "\n");
  process.exit(EXIT.OK);
})();
