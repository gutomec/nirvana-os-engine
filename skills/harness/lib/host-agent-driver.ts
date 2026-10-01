#!/usr/bin/env bun
// host-agent-driver.ts — harness entry point for the exec bridge.
//
// UNIFIED (routing-360 Phase 4.4): the driver itself — adapters, runners,
// runHeadless, the dispatch-ledger heartbeat sidecar, capture files and the
// driverSpawnSync choke point — lives in the CANONICAL module at
// skills/_shared/lib/host-agent-driver.ts (all 9 runtimes: claude-code,
// codex, gemini-cli, antigravity-cli, kimi-cli, grok-cli, pi, qwen-code,
// opencode). This file re-exports that surface unchanged for the harness
// callers (dispatch.ts, cascade-runner.ts, revise.ts,
// chat-concierge.ts, brief-proxy.ts, agentic-router.ts, supervisor.ts, tests)
// and keeps only the harness-specific extras below. Do not add adapters here
// — the pre-unification split (two divergent drivers) is exactly what the
// canonical module closes.

export {
  runHeadless,
  runtimeAvailable,
  resolveLedgerTimeoutMs,
  LEDGER_DEFAULT_TIMEOUT_MS,
  DEFAULT_ALLOWED_TOOLS,
  MAX_ARGV_PROMPT_BYTES,
  reapOrphanedPromptFiles,
} from "../../_shared/lib/host-agent-driver.ts";
export type {
  Runtime,
  RunHeadlessOpts,
  RunHeadlessResult,
  LedgerHeartbeatOpts,
} from "../../_shared/lib/host-agent-driver.ts";
import { scopeBoundary, scopeGuard } from "../../_shared/lib/scope-guard.ts";
import { resolveSetting } from "../../_shared/lib/settings.ts";

/** The line that keeps a worker from rendering its own output to check it,
 *  unless `execution.visual_checks` is on (the max profile). A squad's verify
 *  step had a worker take 110+ screenshots per viewport profile and read them
 *  all: minutes and a large share of the run's tokens, for a review the user
 *  makes in seconds. Empty when the checks are on. */
export function visualChecksLine(): string {
  if (resolveSetting("execution.visual_checks").value) return "";
  return "- NO VISUAL SELF-CHECKS: no screenshots, capture passes or Lighthouse runs of your output, even when a squad step asks for them. The user reviews.";
}

/** Autonomous-mode directive: the quality contract of a run nobody supervises,
 * true for every dispatched worker (a business, a squad, the generalist).
 * Appended to the system prompt so a headless run never blocks. The worker is
 * the executor of its brief and opens nothing; the specialist reaches it
 * through the prompt (a card, persona files), never through a dispatch.
 * The first block is the soul of the nirvana-os: NOTHING HALF-BAKED.
 * Harness-only export (prompt content, not driver mechanics) — it stays in
 * this file, where scripts/check-skillmd-command-parity.ts reads it. */
export const AUTONOMOUS_DIRECTIVE = [
  "FUNDAMENTAL PREMISE (the soul of the nirvana-os): NOTHING HALF-BAKED. The best that exists today is the default, not the ceiling: the most current well-maintained libraries, and the specialist your prompt hands you (a squad's card, a clone's persona files, a seat's file), used for real. Conservative defaults are for factual premises (dates, names, numbers); for execution quality the default is the ceiling. Images only when the deliverable asks for them, and then really generated ones, never a placeholder or a generic SVG.",
  "",
  "AUTONOMOUS MODE (headless run: nobody will answer an approval prompt, so never wait for one; if the runtime refuses an action, reach the result another way):",
  "- You are the executor of this brief, never a dispatcher. Do not invoke the `harness` skill, do not run `nrv run` or `nrv dispatch`, never start another runtime or a subagent: the engine refuses every dispatch from you. Use a specialist through what the prompt gives you: read its card or files and work as it.",
  "- Finish the whole task. NEVER ask the user, NEVER wait for input: decide with professional defaults and record them under '## Assumptions' (titled in the deliverable's language) in the main deliverable. Method, depth and artifact layout are yours; keep the work to what the brief asks for.",
  "- Never invent what the user must stand behind (a guarantee, price, testimonial, legal term): write a marked placeholder and list it in the assumptions. A number, price, statistic or claim of fact that is not in the brief or in a source you opened is marked 'to confirm' and listed there too, never stated as measured.",
  "- Write EVERY final deliverable as a file under the outputs_root given in the prompt. The harness verifies, gates and exports AFTER you finish: do not duplicate it, and do not print a summary to the terminal in place of files.",
  `- ${scopeGuard()} Scope is the deliverable and the acceptance criteria of the instruction you received. ${scopeBoundary()}`,
  "- HEADLESS SESSION LIFETIME: this session dies the instant your final turn ends. Never launch background work (`bash ... &`) and end your turn waiting for it. Your turn is over only when every phase's files are on disk.",
  "- CONTINUOUS FLOW: phases (your progress file, a staged plan) advance in sequence until `complete` without pausing, confirming or reporting in between. Interrupt only on an unrecoverable error or an explicit `notify: human` trigger.",
  "- MESSAGE INTERRUPTION: a question or status message that arrives mid-execution gets ONE line with the current state, then execution resumes in the same action. Never go idle waiting for a new order: the order to continue is this one.",
  "- Follow the writing contract in AGENTS.md / CLAUDE.md / GEMINI.md when the project has one.",
  ...[visualChecksLine()].filter(Boolean),
].join("\n");
