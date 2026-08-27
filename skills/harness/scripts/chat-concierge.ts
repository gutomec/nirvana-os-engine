#!/usr/bin/env bun
// chat-concierge.ts — the legacy chat action (`chat-agent`, the non-canonical chat) as a thin
// wrapper over the maestro turn (lib/control-plane/maestro-turn.ts), the same module the
// canonical chat runs. One turn from the current directory, its events on stdout as NDJSON for
// the job stream ({t:"tok"|"tool"|"done"}), the session id in `done` for `--resume`.
//
//   bun chat-concierge.ts "<message>" [--resume <sessionId>] [--runtime <rt>] [--fast]
import { runMaestroTurnToStdout } from "../lib/control-plane/maestro-turn.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
await runMaestroTurnToStdout({
  prompt: args.find((arg, index) => !arg.startsWith("--") && !["--resume", "--runtime"].includes(args[index - 1] ?? "")) ?? "",
  cwd: process.cwd(), sessionId: flag("--resume") ?? null, runtime: flag("--runtime"), fast: args.includes("--fast"),
});
process.exit(0);
