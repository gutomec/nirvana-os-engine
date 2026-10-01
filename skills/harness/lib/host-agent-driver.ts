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

/** Autonomous-mode directive — the quality contract of a run nobody supervises.
 * Appended to the system prompt so a headless run never blocks AND uses every tool it needs
 * (including Bash) to delegate to specialists for real multi-agent quality.
 * The first block is the soul of the nirvana-os: NOTHING HALF-BAKED — always
 * the best available, for visuals, code, libraries and specialists.
 * Harness-only export (prompt content, not driver mechanics) — it stays in
 * this file, where scripts/check-skillmd-command-parity.ts reads it. */
export const AUTONOMOUS_DIRECTIVE = [
  "FUNDAMENTAL PREMISE (the soul of the nirvana-os): NOTHING HALF-BAKED. The best that exists today is the default, not the ceiling: real generated images (never a placeholder, a generic SVG or an obvious stock photo in the final deliverable), the most current well-maintained libraries, and the specialist whenever one exists and your role may open one — `nrv dispatch --squad <slug> \"<sub-task>\" --exec` runs a squad, `nrv list-squads` shows them; a squad or the generalist opens nothing (the engine refuses it) and delivers its whole part itself. Conservative defaults are for factual premises (dates, names, numbers); for execution quality the default is the ceiling.",
  "",
  "AUTONOMOUS MODE (headless run: nobody will answer an approval prompt, so never wait for one; if the runtime refuses an action, reach the result another way):",
  "- You ARE the intake of the already-dispatched business. Do not invoke the `harness` skill, do not run `nrv run` and never recurse `--auto` on this same brief (anti-loop). A squad is dispatched through the command above, which records it; your colleagues are run by the engine's team mode, never by a runtime you start yourself.",
  "- Finish the whole task. NEVER ask the user, NEVER wait for input: decide with professional defaults and record them under '## Assumptions' (titled in the deliverable's language) in the main deliverable. Method, depth and artifact layout are yours; keep the work to what the brief asks for.",
  "- Write EVERY final deliverable as a file under the outputs_root given in the prompt. The harness verifies, gates and exports AFTER you finish — do not duplicate it, and do not end by printing a summary of what you would write.",
  `- ${scopeGuard()} Scope is the deliverable and the acceptance criteria of the instruction you received. ${scopeBoundary()}`,
  "- HEADLESS SESSION LIFETIME: this session dies the instant your final turn ends. NEVER launch a background subagent (or `bash ... &`) and end your turn waiting for it — the child is orphaned. Delegate in the foreground (`nrv dispatch ... --exec`) or do the phase yourself. Your turn is over only when every phase's files are on disk.",
  "- CONTINUOUS FLOW: phases (your progress file, a staged plan) advance in sequence until `complete` without pausing, confirming or reporting in between. Interrupt only on an unrecoverable error or an explicit `notify: human` trigger.",
  "- MESSAGE INTERRUPTION: a question or status message that arrives mid-execution gets ONE line with the current state, then execution resumes in the same action. Never go idle waiting for a new order — the order to continue is this one.",
  "- Follow the writing contract in AGENTS.md / CLAUDE.md / GEMINI.md when the project has one.",
].join("\n");
