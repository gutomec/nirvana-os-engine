// hooks.ts — closed vocabulary for prompt-assembly hook points + agent roles.
//
// The system is LLM-orchestrated by design: "hooks" here are NAMED SPLICE ANCHORS
// resolved at prompt-assembly time, not a runtime engine. A capability or a
// mind-clone may register a `contribution` (a prompt fragment) into a (role, hook)
// pair; the assembly site renders the ordered fragments. Closed sets on purpose —
// an unknown hook/role fails validation, which is the desired tightness.

export const HOOKS = ["plan:pre", "execute:pre", "execute:post", "verify:pre"] as const;
export type Hook = (typeof HOOKS)[number];

export const ROLES = ["employee", "squad", "mind_clone", "synthesizer"] as const;
export type Role = (typeof ROLES)[number];

export function isHook(s: string): s is Hook {
  return (HOOKS as readonly string[]).includes(s);
}
export function isRole(s: string): s is Role {
  return (ROLES as readonly string[]).includes(s);
}

// Map a HANDOFF/workflow phase to the hook that gates prompt assembly for it.
export function hookForPhase(phase?: string): Hook {
  switch ((phase || "").toLowerCase()) {
    case "plan": case "planning": case "discuss": case "discussing": return "plan:pre";
    case "verify": case "verifying": case "verification": return "verify:pre";
    default: return "execute:pre"; // execute/implementation/unknown
  }
}
