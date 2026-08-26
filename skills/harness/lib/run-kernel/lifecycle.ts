import type { CanonicalRunState } from "./types.ts";

export const TERMINAL_RUN_STATES: ReadonlySet<CanonicalRunState> = new Set([
  "rolled_back", "completed", "withheld", "delivered_with_reservations",
  "cancelled", "failed", "abandoned",
]);

const TRANSITIONS: Readonly<Record<CanonicalRunState, readonly CanonicalRunState[]>> = {
  prepared: ["running", "rolled_back"],
  running: ["waiting", "verifying", "cancelling", "failed", "abandoned"],
  waiting: ["running", "cancelling", "failed", "abandoned"],
  verifying: ["revising", "completed", "withheld", "delivered_with_reservations", "failed", "abandoned"],
  revising: ["running", "cancelling", "failed", "abandoned"],
  cancelling: ["cancelled", "failed"],
  rolled_back: [], completed: [], withheld: [], delivered_with_reservations: [],
  cancelled: [], failed: [], abandoned: [],
};

export function canTransition(from: CanonicalRunState, to: CanonicalRunState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}
export function assertTransition(from: CanonicalRunState, to: CanonicalRunState): void {
  if (!canTransition(from, to)) throw new Error(`run-kernel: illegal transition ${from} -> ${to}`);
}
