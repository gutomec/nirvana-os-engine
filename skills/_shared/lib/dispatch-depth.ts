// dispatch-depth.ts — how deep a chain of agents dispatching agents may go.
//
// Reported from a live run: the owner dispatched two agents and fifteen ran.
// The two he started opened their own subagents, those opened more, and one
// produced a fork that looped against the orchestration rule of the project's
// own contract. Nothing in the engine bounded any of it. The only recursion
// guards that existed were `NRV_IN_SWEEP` for the supervisor's sweep and the
// ledger's process-identity check — neither of which is about dispatch.
//
// Three separate things made it possible, and this file answers one of them:
//
//   1. no ceiling — an engine dispatch could dispatch, forever;
//   2. a dispatched worker was granted its runtime's OWN subagent tool, which
//      the engine cannot see or count (answered in host-agent-driver.ts);
//   3. the project contract tells whoever reads it to delegate rather than
//      produce, and a dispatched child reads it too (answered in AGENTS.md).
//
// The ceiling is the backstop, not the fix: it bounds the damage when the other
// two fail. It is deliberately a FINITE number rather than a heuristic, because
// the failure mode is exponential and the cost of being wrong in the permissive
// direction is unbounded.
//
// The depth travels in `NIRVANA_DISPATCH_DEPTH`, which reaches every child for
// free: the `NIRVANA_` prefix is kept by the child-env allowlist even in
// `declared` mode, so the counter cannot be lost by a filtered spawn.

/** Env var carrying the caller's own depth. Absent means depth 0, the operator. */
export const DEPTH_ENV = "NIRVANA_DISPATCH_DEPTH";

/** Ceiling used when the setting cannot be read. Chosen to clear every nesting
 *  the engine legitimately performs: a business at 1, one of its seats at 2, and
 *  a mandatory squad or a judge dispatched from that seat at 3. */
export const DEFAULT_MAX_DEPTH = 3;

/** The depth of the process that is about to spawn. 0 = the operator's own session. */
export function currentDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[DEPTH_ENV] ?? "").trim();
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The value stamped on the child this process is spawning. */
export function childDepth(env: NodeJS.ProcessEnv = process.env): number {
  return currentDepth(env) + 1;
}

/**
 * Whether this process may spawn an agent at all.
 *
 * A ceiling of 0 or less means unlimited, matching how every other cap in this
 * engine spells "no limit" (`budget.default_max_cost_usd`, `max_handoffs`).
 */
export function mayDispatch(max: number, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!Number.isFinite(max) || max <= 0) return true;
  return childDepth(env) <= max;
}

/** The message a refusal carries. Names the numbers, never a vague "too deep". */
export function refusalMessage(max: number, env: NodeJS.ProcessEnv = process.env): string {
  return `dispatch refused: this agent is at depth ${currentDepth(env)} and the chain ceiling is ${max}`
    + ` (execution.max_dispatch_depth). An agent this deep must DO the work, not delegate it.`
    + ` Raise the ceiling only if the nesting is intended.`;
}
