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

/** Env var carrying WHAT the caller is. Absent means the operator's own session. */
export const ROLE_ENV = "NIRVANA_DISPATCH_ROLE";

/**
 * What a running agent is, which decides what it may dispatch.
 *
 * Owner's rule (2026-09-18), verbatim in substance: "a business employee may
 * use a squad, but may not go dispatching like mad. And squads may NEVER
 * dispatch. Only employees, who may use squads to build their deliverable."
 *
 * So this is a role question, not only a depth question. A depth ceiling alone
 * would let a squad dispatched straight from the maestro open another squad,
 * because it sits at depth 1 with room underneath.
 */
export type DispatchRole = "business" | "employee" | "squad" | "agent-x" | "planner" | "exec";

/** What each role is allowed to dispatch. `[]` means: nothing, ever. */
const ALLOWED: Record<DispatchRole, readonly DispatchRole[]> = {
  // A business opens its own org chart, and a seat of it can carry a squad.
  business: ["employee", "squad"],
  // An employee builds its deliverable, and a squad is a tool it may use.
  // Not a business: a seat that convenes another company is the runaway.
  employee: ["squad"],
  // A squad EXECUTES. This is the rule with no exception.
  squad: [],
  // The generalist fallback is a worker too.
  "agent-x": [],
  // A decision step: the business director, a judge, a router. It answers with
  // a verdict and opens nothing. It exists as a role because these run with
  // tools and full trust, so "it would not dispatch" is a hope, not a rule.
  planner: [],
  // `nrv exec`: a raw runtime call with no persona, no gate and no outputs
  // root. It is an OPERATOR tool, and the empty allowance is how that is
  // enforced rather than documented — every dispatched role refuses to open
  // one, so a seat cannot shell out to it and get an unsupervised agent.
  exec: [],
};

/** The role of the process that is about to spawn; null = the operator. */
export function currentRole(env: NodeJS.ProcessEnv = process.env): DispatchRole | null {
  const raw = (env[ROLE_ENV] ?? "").trim();
  return raw in ALLOWED ? (raw as DispatchRole) : null;
}

/**
 * May this process dispatch `target`?
 *
 * The operator's own session may dispatch anything. A role with an empty
 * allowlist may dispatch nothing, whether or not the target is known — which
 * is what makes "squads never dispatch" enforceable without the caller having
 * to declare what it is dispatching. When the target IS unknown and the role
 * has some allowance, the call passes and the depth ceiling bounds it.
 */
export function roleMayDispatch(target: DispatchRole | null, env: NodeJS.ProcessEnv = process.env): boolean {
  const role = currentRole(env);
  if (!role) return true;
  const allowed = ALLOWED[role];
  if (allowed.length === 0) return false;
  return target === null ? true : allowed.includes(target);
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

/** Why a role-based refusal happened, in words that name the rule. */
export function roleRefusalMessage(target: DispatchRole | null, env: NodeJS.ProcessEnv = process.env): string {
  const role = currentRole(env);
  const what = target ? `a ${target}` : "anything";
  if (role && ALLOWED[role].length === 0) {
    return `dispatch refused: ${article(role)} ${role} executes, it never dispatches.`
      + ` Produce the deliverable yourself with the tools you have.`;
  }
  return `dispatch refused: ${article(role as string)} ${role} may dispatch only ${(ALLOWED[role as DispatchRole] ?? []).join(" or ")}, not ${what}.`;
}

/** Ceiling used when the setting cannot be read.
 *
 *  It has to clear the deepest chain the engine walks on purpose, and there are
 *  two topologies, not one:
 *
 *    terminal   the user's own session (0) -> business (1) -> a seat of it (2)
 *               -> a squad the seat uses (3)
 *    Glance     the maestro is itself a spawned child (1) -> business (2)
 *               -> a seat (3) -> a squad the seat uses (4)
 *
 *  The Glance chat maestro runs through the driver like anything else
 *  (control-plane/maestro-turn.ts, child mode), so everything under it sits one
 *  level deeper than the same work started from a terminal. A ceiling of 3
 *  would have refused a legitimate squad in that path only — the worst kind of
 *  limit, the one that fires for half the users.
 *
 *  4 still stops a runaway hard: the incident was exponential fan-out at shallow
 *  depth, and the role matrix, not this number, is what forbids a squad from
 *  dispatching at all. */
export const DEFAULT_MAX_DEPTH = 4;

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
