// types.ts — the admission gate's vocabulary (`nrv validate <kind> <slug>`).
//
// One catalog per kind (kinds/*.ts) declares its criteria; the runner turns
// them into findings, applies the debt baseline, runs the mechanical fixers
// with backup and rollback, and renders one report shape for every kind. The
// JSON shape is `nirvana.verify-report/v1`, described in
// docs/architecture/validate-gate.md.

export type Kind = "squad" | "business" | "mind-clone";
export const KINDS: readonly Kind[] = ["squad", "business", "mind-clone"] as const;

/**
 * `info` never counts, toward the verdict or toward `passed`. Two things wear
 * it: a check that could not run (a clone outside the registry), and a fact
 * about a correct entity that the report would be poorer without (a workflow
 * written as an event router, whose graph is empty on purpose).
 */
export type Severity = "error" | "warning" | "info";
export type Autofix = "mechanical" | "agentic" | "none";

export interface Criterion {
  id: string;
  severity: Severity;
  autofix: Autofix;
  /** Recorded debt may only shrink; a baselined finding does not block. */
  baselineable: boolean;
  title: string;
  /** Name of the mechanical fixer in `KindModule.fixers`, when one exists. */
  fixer?: string;
}

export interface Finding {
  id: string;
  severity: Severity;
  autofix: Autofix;
  message: string;
  evidence: string;
  /** Sub-key for criteria that fire per file or per item (`artifact_missing:<path>`). */
  where?: string;
  baselined: boolean;
  fixer?: string;
}

export interface FixResult {
  fixer: string;
  finding: string;
  applied: boolean;
  changed_files: string[];
  note?: string;
  error?: string;
}

export interface Counts { errors: number; warnings: number; }

export interface FixOutcome {
  mode: "mechanical" | "agentic" | "none";
  backup: string | null;
  rolled_back: boolean;
  rollback_reason?: string;
  before: Counts;
  after: Counts;
}

export interface VerifyReport {
  schema: "nirvana.verify-report/v1";
  kind: Kind;
  slug: string;
  dir: string;
  verdict: "ADMITTED" | "REJECTED";
  summary: { errors: number; warnings: number; debt: number; passed: number };
  findings: Finding[];
  fixes: FixResult[];
  fix_outcome: FixOutcome | null;
  baseline: { present: boolean; debt: number };
  exit_code: number;
  strict: boolean;
  checked_at: string;
}

export interface CheckContext {
  kind: Kind;
  slug: string;
  dir: string;
  /** false skips the self-retrieval axis entirely (`--no-retrieval`). */
  retrieval: boolean;
  /** Injected registries (tests); when absent the machine's are loaded. */
  registries?: unknown;
  cloneRegistry?: Record<string, unknown>;
}

export interface FixContext { kind: Kind; slug: string; dir: string; finding: Finding; }
export type Fixer = (ctx: FixContext) => FixResult;

export interface EntityRef { slug: string; dir: string; }

export interface KindModule {
  kind: Kind;
  manifestFile: string;
  /** Slug or path → entity directory; null when nothing matches. */
  resolveDir(target: string): string | null;
  /** Every entity under the given roots (or the installed roots). */
  listAll(roots?: string[]): EntityRef[];
  criteria: Criterion[];
  check(ctx: CheckContext): Promise<Finding[]>;
  fixers: Record<string, Fixer>;
  /** Fixed application order; `surface_regen` is always last. */
  fixOrder: string[];
}

/**
 * Exit codes of `nrv validate`. `EXIT.INVALID_ARGS` is 4 elsewhere in the
 * engine and `2` is "confirmation required"; the gate reserves `2` for
 * warnings under `--strict`, so usage errors take EX_USAGE (64).
 */
export const VERIFY_EXIT = {
  ADMITTED: 0,
  REJECTED: 1,
  STRICT_WARNINGS: 2,
  USAGE: 64,
} as const;

/** `id` or `id:where` — the key a baseline records. */
export function findingKey(f: Pick<Finding, "id" | "where">): string {
  return f.where ? `${f.id}:${f.where}` : f.id;
}

export function entityKey(kind: Kind, slug: string): string {
  return `${kind}:${slug}`;
}
