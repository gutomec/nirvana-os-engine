import type { EvaluatorDescriptor, TargetRef } from "./types.ts";

function sameTarget(left: TargetRef, right: TargetRef): boolean {
  return left.kind === right.kind && left.slug === right.slug &&
    (left.kind !== "squad" || right.kind !== "squad" || left.capabilityId === right.capabilityId);
}

export class EvaluatorRegistry {
  private readonly entries = new Map<string, EvaluatorDescriptor>();

  register(descriptor: EvaluatorDescriptor): void {
    if (!descriptor.capabilities.length) throw new Error("gauntlet: evaluator must declare capabilities");
    const existing = this.entries.get(descriptor.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(descriptor)) throw new Error(`gauntlet: evaluator '${descriptor.id}' already registered`);
    this.entries.set(descriptor.id, descriptor);
  }

  select(capability: string, producer: TargetRef): EvaluatorDescriptor {
    const candidate = [...this.entries.values()]
      .filter(entry => entry.capabilities.includes(capability) && !sameTarget(entry.target, producer))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id))[0];
    if (!candidate) throw new Error(`gauntlet: no independent evaluator for capability '${capability}'`);
    return candidate;
  }
}

export function targetsAreIndependent(producer: TargetRef, evaluator: TargetRef): boolean {
  return !sameTarget(producer, evaluator);
}
