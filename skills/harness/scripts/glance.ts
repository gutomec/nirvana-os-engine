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
// O Glance é o cockpit de controle do Nirvana-OS: as ações de escrita (setup,
// salvar .env, chat, rodar actions) vêm LIGADAS por padrão. O servidor liga só
// em 127.0.0.1, então fica restrito à máquina. --read-only volta ao modo
// somente-leitura; --allow-actions continua aceito (no-op, compatibilidade).
const allowActions = !flags["read-only"];
const themeFlag = (flags.theme as string) || "apple";
const theme = (["apple", "apple-dark", "awwwards"].includes(themeFlag) ? themeFlag : "apple") as "apple" | "apple-dark" | "awwwards";

await startServer({ port, open, idleMin, allowActions, theme });
