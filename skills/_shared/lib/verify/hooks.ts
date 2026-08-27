// hooks.ts — the four moments an entity enters the system.
//
// Creation (init-squad / init-business), installation (installer.ts and
// install-content.ts), activation (`nrv activate`) and the pack build all ask
// the same question — is this entity admissible — and all four used to answer
// it with something else: a spawned loader, a light manifest read, or nothing
// at all. This module is the single door, and the reason it is a module and
// not four call sites is the buyer: a gate wired straight into an install path
// turns "my pack no longer installs" into the first thing a new customer sees.
//
// Three rules keep that from happening:
//
//   1. **Flagged off by default.** `verify.mode` ships `report`, and
//      `verify.enforce_on_install` / `verify.enforce_on_activate` ship false.
//      With the defaults, a hook prints its verdict and returns `blocked:
//      false` no matter what it found.
//   2. **Grandfathering.** `mode: "hook"` in the runner records a debt
//      baseline the first time it meets an entity on a machine that has none,
//      instead of rejecting a library that was installed before the gate
//      existed. Only `baselineable` criteria — facts the pipeline produces —
//      ever become debt; a HARD error never does.
//   3. **A documented escape.** `--skip-validate` (install) and
//      `--skip-verify` (activate, creation) return `ran: false` without
//      touching disk, so a buyer is never stuck behind a gate.
//
// A hook NEVER throws: an internal failure is reported as `ran: false` with a
// reason, and the caller proceeds. Losing the check is bad; losing the install
// because the check broke is worse.

import { resolveSetting } from "../settings.ts";
import { verifyEntity, type Emitter, type VerifyOptions } from "./runner.ts";
import type { Finding, Kind, VerifyReport } from "./types.ts";

export type HookGate = "create" | "install" | "activate" | "pack";

export interface HookOptions {
  kind: Kind;
  /** Slug or directory; the kind module resolves it. */
  target: string;
  gate: HookGate;
  /** The caller's documented escape (`--skip-validate` / `--skip-verify`). */
  skip?: boolean;
  /** Creation repairs its own scaffold before judging it. */
  fix?: false | "mechanical";
  emit?: Emitter | null;
  baselinePath?: string | null;
  stateDir?: string | null;
  retrieval?: boolean;
  /** Injected resolution (tests); default reads the settings table. */
  settings?: Partial<HookSettings>;
}

export interface HookSettings {
  mode: "report" | "warn" | "block";
  enforceOnInstall: boolean;
  enforceOnActivate: boolean;
}

export interface HookOutcome {
  ran: boolean;
  /** The caller must refuse. Only ever true when the gate enforces. */
  blocked: boolean;
  /** Whether this gate was enforcing at all (the flag's answer). */
  enforcing: boolean;
  report: VerifyReport | null;
  errors: Finding[];
  warnings: Finding[];
  /** Ready-to-print lines, in the caller's own voice-neutral form. */
  lines: string[];
  reason?: string;
}

const DEFAULTS: HookSettings = { mode: "report", enforceOnInstall: false, enforceOnActivate: false };

/** Reads the three rollout flags; an unreadable config never blocks a hook. */
export function hookSettings(injected?: Partial<HookSettings>): HookSettings {
  if (injected && injected.mode && injected.enforceOnInstall !== undefined && injected.enforceOnActivate !== undefined) {
    return injected as HookSettings;
  }
  let resolved = { ...DEFAULTS };
  try {
    resolved = {
      mode: resolveSetting("verify.mode").value as HookSettings["mode"],
      enforceOnInstall: resolveSetting("verify.enforce_on_install").value as boolean,
      enforceOnActivate: resolveSetting("verify.enforce_on_activate").value as boolean,
    };
  } catch { /* a broken config file is `nrv config`'s problem, never the gate's */ }
  return { ...resolved, ...(injected ?? {}) };
}

/**
 * Does this gate refuse an entity that carries an error the baseline does not
 * cover? Creation always does — it judges a scaffold the engine itself just
 * wrote, and deleting it is what `init-business` already did with the loader.
 * The other three answer to their flag, or to `verify.mode: block`.
 */
export function enforcesAt(gate: HookGate, s: HookSettings): boolean {
  if (gate === "create") return true;
  if (s.mode === "block") return true;
  if (gate === "install" || gate === "pack") return s.enforceOnInstall;
  return s.enforceOnActivate;
}

const ESCAPE: Record<HookGate, string> = {
  create: "--skip-verify",
  install: "--skip-validate",
  activate: "--skip-verify",
  pack: "--skip-validate",
};

/** Runs the gate for one entity and says what the caller should do about it. */
export async function verifyHook(opts: HookOptions): Promise<HookOutcome> {
  const settings = hookSettings(opts.settings);
  const enforcing = enforcesAt(opts.gate, settings);
  const base: HookOutcome = { ran: false, blocked: false, enforcing, report: null, errors: [], warnings: [], lines: [] };

  if (opts.skip) {
    return { ...base, reason: "skipped", lines: [`verify: skipped by ${ESCAPE[opts.gate]} — ${opts.kind} ${opts.target} was not checked`] };
  }

  let report: VerifyReport;
  try {
    const runOpts: VerifyOptions = {
      mode: "hook",
      fix: opts.fix ?? false,
      retrieval: opts.retrieval ?? false,
      emit: opts.emit,
      ...(opts.baselinePath !== undefined ? { baselinePath: opts.baselinePath } : {}),
      ...(opts.stateDir !== undefined ? { stateDir: opts.stateDir } : {}),
    };
    report = await verifyEntity(opts.kind, opts.target, runOpts);
  } catch (e: unknown) {
    const reason = (e as Error)?.message ?? String(e);
    return { ...base, reason, lines: [`verify: could not check ${opts.kind} ${opts.target} (${reason}) — proceeding`] };
  }

  const errors = report.findings.filter((f) => f.severity === "error" && !f.baselined);
  const warnings = report.findings.filter((f) => f.severity === "warning" && !f.baselined);
  const blocked = enforcing && errors.length > 0;
  const lines = renderHookLines(opts, settings, report, errors, warnings, blocked);
  return { ran: true, blocked, enforcing, report, errors, warnings, lines };
}

function renderHookLines(
  opts: HookOptions, settings: HookSettings, report: VerifyReport,
  errors: Finding[], warnings: Finding[], blocked: boolean,
): string[] {
  const label = `${opts.kind} ${report.slug}`;
  if (errors.length === 0 && warnings.length === 0) {
    return settings.mode === "report" ? [] : [`verify: ${label} ADMITTED`];
  }
  const head = `verify: ${label} — ${errors.length} error(s), ${warnings.length} warning(s)${report.summary.debt ? `, ${report.summary.debt} baselined` : ""}`;
  const lines = [head];
  const shown = [...errors, ...warnings].slice(0, settings.mode === "report" ? 3 : 8);
  for (const f of shown) lines.push(`  ${f.severity === "error" ? "✗" : "⚠"} ${f.id}${f.where ? `:${f.where}` : ""} — ${f.message}`);
  if (blocked) {
    lines.push(`  refused: run \`nrv validate ${opts.kind} ${report.slug} --fix\`, or repeat with ${ESCAPE[opts.gate]}`);
  } else if (errors.length) {
    lines.push(`  proceeding anyway (verify.mode=${settings.mode}${opts.gate === "install" || opts.gate === "pack" ? ", verify.enforce_on_install=false" : opts.gate === "activate" ? ", verify.enforce_on_activate=false" : ""}) — \`nrv validate ${opts.kind} ${report.slug}\` for the detail`);
  }
  return lines;
}
