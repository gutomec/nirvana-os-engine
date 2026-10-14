#!/usr/bin/env bun
// jev-call.ts — one TypeSafe Jev call for synchronous callers (typesafe-client.ts
// jevCallSync). Reads {state, questions, timeoutMs, cwd, home} as JSON on stdin,
// prints the JevResult as one JSON line. The key is found here as the parent
// finds it (environment, project .env, ~/.env); it never travels on argv.
import { jevCall } from "../lib/typesafe-client.ts";

let input: any = {};
try { input = JSON.parse(await Bun.stdin.text()); } catch { input = {}; }
const r = await jevCall(input.state ?? "", input.questions ?? {}, {
  ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
  ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
  ...(typeof input.home === "string" ? { home: input.home } : {}),
});
process.stdout.write(JSON.stringify(r) + "\n");
