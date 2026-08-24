#!/usr/bin/env bun
/**
 * serve.ts — `nrv serve`: the HTTP API for Nirvana-OS.
 *
 * Local by default. Exposing the server to a network is an explicit act
 * (`--host`), documented to sit behind a TLS reverse proxy — the engine
 * ships no TLS of its own and no open CORS.
 *
 * Usage:
 *   nrv serve [start] [--port 7777] [--host 127.0.0.1] [--max-concurrent 2]
 *             [--cors https://app.example.com]
 *   nrv serve keygen [--label name] [--budget-usd 5] [--daily-runs 50]
 *   nrv serve keys [list|revoke <key_id>]
 */
import { startServer } from "../lib/serve/server.ts";
import { keygen, listKeys, revokeKey, serveDir } from "../lib/serve/auth.ts";

const argv = process.argv.slice(2);
const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : "start";
const flag = (name: string, dflt?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] ?? dflt : dflt;
};

if (sub === "keygen") {
  const { token, record } = keygen({
    label: flag("label", "default"),
    budgetUsd: flag("budget-usd") ? parseFloat(flag("budget-usd")!) : undefined,
    dailyRuns: flag("daily-runs") ? parseInt(flag("daily-runs")!, 10) : undefined,
  });
  console.log(`\n  key id:  ${record.id}`);
  console.log(`  label:   ${record.label}`);
  if (record.budget_usd) console.log(`  budget:  US$ ${record.budget_usd} per run`);
  if (record.daily_runs) console.log(`  quota:   ${record.daily_runs} runs/day`);
  console.log(`\n  TOKEN (shown once — store it now):\n\n    ${token}\n`);
  console.log(`  Use it as: Authorization: Bearer ${token.slice(0, 12)}…\n`);
  process.exit(0);
}

if (sub === "keys") {
  const action = argv[1];
  if (action === "revoke") {
    const id = argv[2];
    if (!id) { console.error("usage: nrv serve keys revoke <key_id>"); process.exit(4); }
    console.log(revokeKey(id) ? `revoked ${id}` : `key not found: ${id}`);
    process.exit(revokeKey(id) ? 0 : 1);
  }
  const keys = listKeys();
  if (!keys.length) console.log("no keys yet — create one with: nrv serve keygen");
  for (const k of keys) {
    console.log(`  ${k.id}  ${k.label}${k.revoked ? "  (revoked)" : ""}${k.budget_usd ? `  budget $${k.budget_usd}` : ""}${k.daily_runs ? `  ${k.daily_runs}/day` : ""}`);
  }
  process.exit(0);
}

if (sub !== "start") {
  console.error(`unknown subcommand: ${sub}\nusage: nrv serve [start|keygen|keys] [flags]`);
  process.exit(4);
}

// Running the API as root would give every dispatched agent root on the
// host — the two-role rule (root installs, a normal user owns the work).
if (typeof process.getuid === "function" && process.getuid() === 0 && process.env.NIRVANA_SERVE_ALLOW_ROOT !== "1") {
  console.error("nrv serve refuses to run as root: a dispatched agent would inherit it.");
  console.error("Run it as a normal user, or set NIRVANA_SERVE_ALLOW_ROOT=1 if you truly mean it.");
  process.exit(4);
}

const host = flag("host", "127.0.0.1")!;
const port = parseInt(flag("port", "7777")!, 10);
const maxConcurrent = parseInt(flag("max-concurrent", "2")!, 10);
const corsOrigins = (flag("cors") || "").split(",").map((s) => s.trim()).filter(Boolean);

const server = startServer({ port, host, maxConcurrent, corsOrigins });

console.log(`\n  Nirvana-OS API — http://${host}:${port}`);
console.log(`  keys:     ${serveDir()}/keys.json`);
console.log(`  parallel: ${maxConcurrent} run(s) · 1 per session`);
if (host !== "127.0.0.1" && host !== "localhost") {
  console.log(`\n  ⚠ bound to ${host} — put a TLS reverse proxy in front; this server speaks plain HTTP.`);
}
console.log(`\n  health:   curl http://${host}:${port}/v1/health`);
console.log(`  new key:  nrv serve keygen --budget-usd 5\n`);

process.on("SIGINT", () => { server.stop(); process.exit(0); });
process.on("SIGTERM", () => { server.stop(); process.exit(0); });
