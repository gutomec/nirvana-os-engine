export type AuthorityDomain = "filesystem" | "process" | "network" | "secrets" | "host";
export type AuthorityDecision = "allow" | "deny";
export type AuthorityPolicy = Readonly<Record<AuthorityDomain, AuthorityDecision>>;
export type Disposer = () => void | Promise<void>;

const DOMAINS: readonly AuthorityDomain[] = ["filesystem", "process", "network", "secrets", "host"];

export function restrictAuthority(parent: AuthorityPolicy, requested: AuthorityPolicy): AuthorityPolicy {
  return Object.fromEntries(DOMAINS.map(domain => [domain,
    parent[domain] === "allow" && requested[domain] === "allow" ? "allow" : "deny",
  ])) as unknown as AuthorityPolicy;
}
export class ExecutionScope {
  readonly policy: AuthorityPolicy;
  private readonly disposers: Disposer[] = [];
  private disposed = false;

  constructor(readonly id: string, policy: AuthorityPolicy, readonly parent?: ExecutionScope) {
    this.policy = parent ? restrictAuthority(parent.policy, policy) : Object.freeze({ ...policy });
  }

  child(id: string, requested: AuthorityPolicy): ExecutionScope {
    if (this.disposed) throw new Error(`run-kernel: scope '${this.id}' is disposed`);
    return new ExecutionScope(id, requested, this);
  }

  owns(disposer: Disposer): void {
    if (this.disposed) throw new Error(`run-kernel: scope '${this.id}' is disposed`);
    this.disposers.push(disposer);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const failures: unknown[] = [];
    while (this.disposers.length) {
      try { await this.disposers.pop()!(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, `run-kernel: scope '${this.id}' disposal failed`);
  }
}
