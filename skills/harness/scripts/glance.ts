#!/usr/bin/env bun
/**
 * glance.ts — Nirvana Glance entrypoint.
 *
 * Usage:
 *   bun glance.ts                          # auto-port, opens browser, Apple theme
 *   bun glance.ts --port 4242              # fixed port
 *   bun glance.ts --no-open                # don't auto-open browser
 *   bun glance.ts --idle-min 60            # 60min idle timeout (default 30)
 *   bun glance.ts --theme awwwards         # awwwards-style hero
 *   bun glance.ts --allow-actions          # enables write endpoints (Phase 5)
 */

import { parseArgs } from "../../_shared/lib/bun-helpers.ts";
import { describeSettingSource, resolveSetting } from "../../_shared/lib/settings.ts";
import { createDispatchExecutionRunner, detectExecutionRuntime } from "../lib/control-plane/execution-runner.ts";
import { startServer } from "../lib/glance/server.ts";

const { flags } = parseArgs();

if (flags.help || flags.h) {
  console.log(`glance — Nirvana cockpit (web UI)

USAGE
  glance                              full cockpit on 127.0.0.1 (actions ON), opens browser
  glance --read-only                  browse only; disable all write endpoints
  glance --port 4242                  fixed port instead of auto
  glance --no-open                    don't auto-open the browser
  glance --idle-min 60                idle timeout in minutes (default 30)
  glance --theme apple|apple-dark|awwwards    visual theme (default apple)
  glance -h | --help                  this message

WRITE ACTIONS (ON by default)
  The cockpit operates the system out of the box — chat, setup (copy squads/
  businesses/mind-clones into a project), save .env changes (live-reload), and
  the actions menu (index, audit-batch, run-smoke, …). The server binds to
  127.0.0.1 only, so it stays private to this machine.
  Use --read-only for a safe, look-but-don't-touch session.

EXECUTION
  A Message in an adopted project runs in a child dispatch process (the server
  never blocks). NIRVANA_GLANCE_EXECUTION=0 (or nrv config set glance.execution false)
  keeps the cockpit up without spawning anything; --read-only disables execution as well.

EXAMPLES
  glance                              # full cockpit (most common usage)
  glance --read-only                  # browse without any write capability
  glance --theme apple-dark           # dark cockpit

The cockpit auto-detects the project root from \$cwd (walks up looking for
.env / .nirvana / .git). To target a different project: cd into it first.
`);
  process.exit(0);
}

const port = flags.port ? Number(flags.port) : "auto";
const open = !flags["no-open"];
const idleMin = flags["idle-min"] ? Number(flags["idle-min"]) : 30;
// Glance is the Nirvana-OS control cockpit: write actions (setup, saving .env,
// chat, running actions) come ENABLED by default. The server binds only to
// 127.0.0.1, so it stays restricted to this machine. --read-only returns to
// read-only mode; --allow-actions is still accepted (no-op, compatibility).
const allowActions = !flags["read-only"];
const themeFlag = (flags.theme as string) || "apple";
const theme = (["apple", "apple-dark", "awwwards"].includes(themeFlag) ? themeFlag : "apple") as "apple" | "apple-dark" | "awwwards";

// Real execution of adopted-project Messages, by child dispatch process. --read-only
// disables it; the `glance.execution` setting at false (NIRVANA_GLANCE_EXECUTION=0, or
// the project / global config) keeps the cockpit up without spawning anything (a
// Message then ends in rolled_back / capability_unavailable).
const execution = resolveSetting("glance.execution");
const executionEnabled = allowActions && execution.value;
const executionRunner = executionEnabled ? createDispatchExecutionRunner() : undefined;
if (executionEnabled) {
  const probe = detectExecutionRuntime();
  console.error(`[glance] execution ON — runtime ${probe.runtime} (${probe.from}${probe.available ? "" : "; not on PATH, Messages will end in capability_unavailable"})`);
} else {
  console.error(`[glance] execution OFF (${allowActions ? `glance.execution=false via ${describeSettingSource(execution)}` : "--read-only"})`);
}

await startServer({ port, open, idleMin, allowActions, theme, executionRunner });
