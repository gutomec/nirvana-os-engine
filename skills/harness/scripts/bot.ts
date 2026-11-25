#!/usr/bin/env bun
// bot.ts — `nrv bot`: hand a part of the work to an agent the person keeps in
// OpenBot (Nightly Labs). Written for an agent to run: every answer says what
// happened and what to do next.
//
//   nrv bot list                                  who can be called, and what each one is for
//   nrv bot ask "<agent>" "<task>" [--out <dir>]  send the task, wait, copy the files it made
//   nrv bot status <deliveryId> [--out <dir>]     pick up a call that waited for its person
//
// Only an agent with Local scripts on in OpenBot answers. The person turns
// that on, per agent; the engine never does.
//
// Exit: 0 done · 1 failed, timed out or unreachable · 2 the agent waits for its
// person · 4 wrong arguments.
import * as path from "node:path";
import { EXIT, parseArgs } from "../../_shared/lib/bun-helpers.ts";
import { emitAudit } from "../../_shared/lib/audit-emit.ts";
import {
  askOpenBot, openBotReachable, openBotSpecialists, parseDuration, resumeOpenBot, type OpenBotCallResult,
} from "../../_shared/lib/openbot-call.ts";

const USAGE = [
  "usage: nrv bot <command>",
  "  list                                    the OpenBot agents that can be called, with what each is for",
  '  ask "<agent>" "<task>" [--out <dir>]    send the task, wait for the answer, copy the files it made',
  "  status <deliveryId> [--out <dir>]       pick up a call that waited for its person or ran out of time",
  "  --timeout <90s|10m|2h>                  how long to wait (default 30m)   --json  machine-readable",
].join("\n");

const HOW_TO_OPEN = "The person opens an agent in OpenBot: Agent settings → Rules → Permissions → Local scripts. No command does it.";

const { positional, flags } = parseArgs();
const [cmd, ...rest] = positional;
const json = flags.json === true;
const say = (line = "") => { if (!json) console.log(line); };
const fail = (line: string, code: number = EXIT.FAILURES): never => { console.error(line); process.exit(code); };

function timeoutMs(): number {
  if (flags.timeout === undefined) return 30 * 60_000;
  const ms = typeof flags.timeout === "string" ? parseDuration(flags.timeout) : null;
  if (!ms) fail("bot: --timeout is a duration such as 90s, 10m or 2h", EXIT.INVALID_ARGS);
  return ms!;
}

const slug = (name: string): string => name.normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "agent";

function report(result: OpenBotCallResult): never {
  emitAudit({
    event: "x_bot_called", host: "openbot", agent_id: result.agent?.id ?? null, agent: result.agent?.name ?? null,
    state: result.state, delivery_id: result.deliveryId, files: result.files.length, seconds: result.seconds,
  });
  const code = result.state === "done" ? EXIT.OK : result.state === "needs-person" ? EXIT.CONFIRMATION_REQUIRED : EXIT.FAILURES;
  if (json) { console.log(JSON.stringify({ ok: result.state === "done", ...result })); process.exit(code); }
  const who = result.agent?.name ?? "The agent";
  if (result.state === "done") {
    say(`${who} finished in ${result.seconds} s.`);
    if (result.files.length) {
      say(`Files it made, copied here (${result.files.length}):`);
      for (const f of result.files) say(`  ${f}`);
    } else {
      say("It made no file in its workspace. Its answer is all there is.");
    }
    say("");
    say("Its answer:");
    say(result.answer?.trim() || "(empty)");
  } else if (result.state === "needs-person") {
    say(`${who} waits for its person and the work is not done.`);
    for (const q of result.waitingFor) say(`  It asks: ${q}`);
    say("The person answers in OpenBot. Then: nrv bot status " + result.deliveryId);
    say("Until then, go on without it and say so in your delivery.");
  } else if (result.state === "timed-out") {
    say(`${who} was still working after ${result.seconds} s. It keeps going in OpenBot.`);
    say("Pick the result up later: nrv bot status " + result.deliveryId);
  } else {
    console.error(`bot: ${result.reason ?? "the call failed"}`);
    if (result.answer) console.error(result.answer.trim());
  }
  process.exit(code);
}

if (cmd === "list") {
  const agents = openBotSpecialists();
  const running = openBotReachable();
  if (json) { console.log(JSON.stringify({ ok: true, reachable: running, agents })); process.exit(EXIT.OK); }
  if (!agents.length) {
    say("No OpenBot agent can be called from this computer.");
    say(HOW_TO_OPEN);
    process.exit(EXIT.OK);
  }
  say(`OpenBot agents that can be called (${agents.length})${running ? "" : " — OpenBot is closed now, so a call will not go through until it opens"}:`);
  for (const a of agents) say(`  "${a.name}"${a.provider ? ` (${a.provider})` : ""}: ${a.description || "no description"}`);
  say("");
  say('Hand one a part of the work: nrv bot ask "<name>" "<what you need>" --out <folder>');
  process.exit(EXIT.OK);
}

if (cmd === "ask") {
  const [reference, task] = rest;
  if (!reference || !task?.trim() || rest.length > 2) fail(USAGE, EXIT.INVALID_ARGS);
  const outDir = path.resolve(typeof flags.out === "string" ? flags.out : path.join("from-openbot", slug(reference)));
  report(await askOpenBot(reference, task, { outDir, timeoutMs: timeoutMs() }));
}

if (cmd === "status") {
  const [deliveryId] = rest;
  if (!deliveryId || rest.length > 1) fail(USAGE, EXIT.INVALID_ARGS);
  report(await resumeOpenBot(deliveryId, { outDir: typeof flags.out === "string" ? path.resolve(flags.out) : undefined, timeoutMs: timeoutMs() }));
}

fail(USAGE, cmd ? EXIT.INVALID_ARGS : EXIT.OK);
