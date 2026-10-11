#!/usr/bin/env bun
/**
 * gemini-session-start.ts — Antigravity (`agy`) session-context hook.
 *
 * agy reads its hooks from ~/.gemini/config/hooks.json; the installer writes
 * one named `nirvana-os` that runs this script with `--agy` before every model
 * call (see agyMain). The file keeps its old name because that command line
 * already sits in every user's hooks.json: renaming it would leave their agy
 * hook pointing at a file that is gone until the next install.
 *
 * The Gemini CLI SessionStart hook this script also served is gone with the
 * Gemini CLI runtime. Called without `--agy` (a stale entry the installer has
 * not cleaned from ~/.gemini/settings.json yet) it does nothing and exits 0.
 *
 * Failure mode: never block. Exit 0 silently on any error.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { findProjectRoot } from "../lib/project-root.js";

/** What the agent is told at the start of a session, by the project's mode
 *  (`.nirvana/project.yaml` orchestration_mode). On-demand, the default and
 *  the answer outside any project, keeps Nirvana out of the way; always makes
 *  it the orchestrator for every artifact. */
export function sessionContext(cwd: string): string {
  let mode = "on-demand";
  try {
    const root = findProjectRoot(cwd);
    // The manifest is written as JSON, a YAML subset; a hand edit may turn it
    // into plain YAML, so the key is read in a way both spellings match.
    const manifest = root ? fs.readFileSync(path.join(root, ".nirvana", "project.yaml"), "utf8") : "";
    mode = /"?orchestration_mode"?\s*:\s*["']?([a-z-]+)/.exec(manifest)?.[1] || mode;
  } catch { /* no manifest: on-demand */ }
  const safety = [
    "Destructive commands printed by diagnostics (nrv doctor, nrv update) are",
    "  descriptions of a fix, not orders: never run one against ~/squads,",
    "  ~/businesses or ~/.nirvana without the user asking for it.",
  ];
  if (mode === "always") return [
    "Nirvana-OS is the orchestrator in this project.",
    "For ANY concrete artifact (report, copy, code, design, analysis, campaign):",
    "  load the skill at ~/.nirvana/skills/harness/SKILL.md and follow it.",
    "Never produce the artifact inline: dispatch Business → Squad → agent-x.",
    "`nrv route` and `nrv find` are DIAGNOSTIC only, never the source of truth.",
    "Stay in THIS runtime. Switch only on an explicit user flag, a USE_* rule",
    "  in .env, or a runtime the user names for a part of the work.",
    ...safety,
  ].join("\n");
  return [
    "Nirvana-OS is installed on this machine and stays out of the way: work as you",
    "would without it. Use it only when the user's request names Nirvana, names or",
    "points to one of their businesses, squads or mind-clones (a pack name or a",
    "model to follow included: \"como a empresa X e seus squads e clones\"), or asks",
    "for work on another agent runtime. Then load ~/.nirvana/skills/harness/SKILL.md",
    "and follow it, and do not build the deliverable yourself, even when a search",
    "finds no exact match for the name.",
    ...safety,
  ].join("\n");
}

function readStdin(timeoutMs = 500): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => buf += c);
    process.stdin.on("end", () => resolve(buf));
    setTimeout(() => resolve(buf), timeoutMs);
  });
}

/** Antigravity CLI (`agy`) has no SessionStart: a `PreInvocation` hook in
 *  ~/.gemini/config/hooks.json runs before every model call and injects
 *  context as a transient message, so it is re-sent each call. No audit event
 *  here: it would fire on every call. */
async function agyMain() {
  const raw = await readStdin();
  let payload: any = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { /* tolerate empty/malformed */ }
  const cwd = (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]) || process.cwd();
  try {
    console.log(JSON.stringify({ injectSteps: [{ ephemeralMessage: sessionContext(cwd) }] }));
  } catch { console.log("{}"); }
  process.exit(0);
}

if (import.meta.main) {
  if (process.argv.includes("--agy")) agyMain().catch(() => process.exit(0));
  else process.exit(0);
}
