// run-states.ts — the transitions that take a fresh (`prepared`) Run to a given state, per
// lib/run-kernel/lifecycle.ts, so a test can prepare a Run in any state, terminal ones included.
import type { CanonicalRunState } from "../../lib/run-kernel/types.ts";

export function transitionsTo(state: CanonicalRunState): CanonicalRunState[] {
  switch (state) {
    case "prepared": return [];
    case "rolled_back": return ["rolled_back"];
    case "running": return ["running"];
    case "waiting": return ["running", "waiting"];
    case "verifying": return ["running", "verifying"];
    case "revising": return ["running", "verifying", "revising"];
    case "cancelling": return ["running", "cancelling"];
    case "cancelled": return ["running", "cancelling", "cancelled"];
    case "abandoned": return ["running", "abandoned"];
    default: return ["running", "verifying", state];
  }
}
