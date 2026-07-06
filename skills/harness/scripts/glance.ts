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
import { startServer } from "../lib/glance/server.ts";

const { flags } = parseArgs();

if (flags.help || flags.h) {
  console.log(`glance — Nirvana cockpit (web UI)

USAGE
  glance                              auto-port, opens browser, Apple theme (read-only)
  glance --allow-actions              enable write endpoints (setup, save .env, run actions)
  glance --port 4242                  fixed port instead of auto
  glance --no-open                    don't auto-open the browser
  glance --idle-min 60                idle timeout in minutes (default 30)
  glance --theme apple|apple-dark|awwwards    visual theme (default apple)
  glance -h | --help                  this message

WHEN TO USE --allow-actions
  Required for any write operation in the cockpit:
    • Setup mode: copy squads / businesses / mind-clones into a project
    • Settings: save .env changes (live-reload)
    • Actions menu: index, audit-batch, run-smoke, etc.
  Read-only browsing (lists, details, scope, logs) works without it.

EXAMPLES
  glance                              # quick browse
  glance --allow-actions              # full cockpit (most common usage)
  glance --port 7777 --allow-actions  # share with teammate on local network
  glance --theme apple-dark --allow-actions

The cockpit auto-detects the project root from \$cwd (walks up looking for
.env / .nirvana / .git). To target a different project: cd into it first.
`);
  process.exit(0);
}

const port = flags.port ? Number(flags.port) : "auto";
const open = !flags["no-open"];
const idleMin = flags["idle-min"] ? Number(flags["idle-min"]) : 30;
const allowActions = !!flags["allow-actions"];
const themeFlag = (flags.theme as string) || "apple";
const theme = (["apple", "apple-dark", "awwwards"].includes(themeFlag) ? themeFlag : "apple") as "apple" | "apple-dark" | "awwwards";

await startServer({ port, open, idleMin, allowActions, theme });
