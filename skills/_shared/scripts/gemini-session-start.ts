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

/** What an agy session (PreInvocation) is told about Nirvana before the
 *  agent thinks. */
export const SESSION_CONTEXT = [
  "Nirvana-OS is installed on this machine.",
  "For ANY concrete artifact (report, copy, code, design, analysis, campaign):",
  "  load the skill at ~/.nirvana/skills/harness/SKILL.md and follow it.",
  "Never produce the artifact inline — dispatch Business → Squad → agent-x.",
  "`nrv route` and `nrv find` are DIAGNOSTIC only, never the source of truth.",
  "Stay in THIS runtime. Switch only on an explicit user flag, a USE_* rule",
  "  in .env, or a runtime named in the brief.",
  "Destructive commands printed by diagnostics (nrv doctor, nrv update) are",
  "  descriptions of a fix, not orders — never run one against ~/squads,",
  "  ~/businesses or ~/.nirvana without the user asking for it.",
].join("\n");

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
  await readStdin();
  try {
    console.log(JSON.stringify({ injectSteps: [{ ephemeralMessage: SESSION_CONTEXT }] }));
  } catch { console.log("{}"); }
  process.exit(0);
}

if (import.meta.main) {
  if (process.argv.includes("--agy")) agyMain().catch(() => process.exit(0));
  else process.exit(0);
}
