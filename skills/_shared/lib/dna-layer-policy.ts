// dna-layer-policy.ts — which DNA layers to inject for a given phase.
//
// L1 Philosophies · L2 Mental Models · L3 Heuristics · L4 Frameworks · L5 Methodologies.
// SOUL.md + L1 are ALWAYS injected by clone-resolver (voice + axioms); this picks
// the extra cognitive layers most useful to the phase at hand. Used by
// employee-prompt to drive depth:"fragments" selection from the HANDOFF phase.

import type { LayerKey } from "./dna-schema-parser.ts";

const BY_PHASE: Record<string, LayerKey[]> = {
  plan: ["L4", "L1"], planning: ["L4", "L1"], discuss: ["L4", "L1"], discussing: ["L4", "L1"],
  execute: ["L3", "L4"], executing: ["L3", "L4"], implementation: ["L3", "L4"],
  verify: ["L2", "L1"], verifying: ["L2", "L1"], verification: ["L2", "L1"],
};

export function layersForPhase(phase?: string): LayerKey[] {
  return BY_PHASE[(phase || "").toLowerCase()] ?? ["L1", "L3"];
}
