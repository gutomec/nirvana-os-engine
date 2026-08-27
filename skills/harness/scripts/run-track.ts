#!/usr/bin/env bun
// run-track.ts — `nrv run-track`: the ledger door for the AGENTIC path.
//
// The never-stall guarantee — "a brief that entered the system either reaches a
// terminal state or is picked up again, never forgotten" — was only ever true for
// scripted dispatch. `nrv dispatch --exec` opens a ledger run, heartbeats it, and
// the supervisor sweeps expired leases and notifies. An agent orchestrating the
// same brief in-session emitted audit events and opened NOTHING, so the supervisor
// had nothing to find: the run could die mid-flight and no one would ever learn.
//
// That is exactly what happened on 2026-08-10 in teste-novo-brandcraft: 11
// brief_received, 5 dispatch_squad, 8 gate_passed in the audit — and zero rows in
// the ledger. The owner was never told the work had finished, because nothing was
// watching it.
//
// This is the missing door. It is deliberately tiny: an agent should not need to
// understand the state machine to be covered by it.
//
//   nrv run-track open  --target <slug> --kind <business|squad|agent-x|clone> --outputs <dir> [--project <id>]
//   nrv run-track beat  <run-id>                    # still working (renews the lease)
//   nrv run-track close <run-id> --state <delivered|withheld|failed> [--error "<why>"]
//   nrv run-track list                              # what is open right now, IN THIS PROJECT
//
// Every subcommand is scoped to the project this process is serving
// (NIRVANA_PROJECT_ROOT, else the first marker-bearing ancestor of cwd). A run
// of another project is neither listed nor closable here — see refuseForeignRun.
// `nrv supervisor status --all-projects` is the one machine-wide view left.
//
// `open` prints the run id on stdout, alone, so a caller can capture it.
// Every subcommand is fail-soft: a broken ledger must never take down real work.
// It degrades loudly (stderr) and exits 0, because losing the tracking of a run is
// bad, and losing the RUN because tracking broke is worse.

import * as path from "node:path";
import { resolveScope } from "../../_shared/lib/scope.ts";
import {
  openLedger, openAgenticRun, markState, renewLease, findNonTerminal, getRun,
  resolveProjectRoot, sameProjectRoot,
  AGENTIC_LEASE_SEC, type RunState, type RunRow,
} from "../lib/run-ledger.ts";
import { notifyDesktop } from "../lib/os-notify.ts";

const argv = process.argv.slice(2);
const sub = argv[0];

function flag(name: string): string | undefined {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = argv[i];
  return a.includes("=") ? a.split("=").slice(1).join("=") : argv[i + 1];
}

function warn(msg: string): void {
  process.stderr.write(`[run-track] ${msg}\n`);
}

/**
 * A project id that survives a round trip. The agentic path used to derive it from
 * the working directory and turned every hyphen into a slash — a run in
 * `teste-novo-brandcraft` was filed under `teste/novo/brandcraft`, which no lookup
 * would ever match. The directory NAME is the identity; separators are not.
 */
function defaultProjectId(): string {
  const root = resolveScope().projectRoot || process.cwd();
  return path.basename(path.resolve(root));
}

/**
 * A run of ANOTHER project is not this session's to touch.
 *
 * On 2026-08-27 a session working in ~/nirvana-os ran `list`, saw rows of
 * ~/venda-mundial-pro and consultorio-dr-paulo — the ledger showed the whole
 * machine — and closed one of them. `list` no longer shows them; this refuses
 * the operation even when the id arrives some other way (a log, a paste, a
 * script). A LEGACY row (no project_root, nothing to derive it from) is let
 * through: ownership cannot be proven, and refusing would strand it forever.
 *
 * Exit 4, like a bad argument: the ledger is healthy and the run is intact, so
 * the fail-soft exit 0 of the other paths would be a lie about what happened.
 */
function refuseForeignRun(row: RunRow, action: string): void {
  const mine = resolveProjectRoot();
  if (!row.project_root || sameProjectRoot(row.project_root, mine)) return;
  process.stderr.write(
    `[run-track] recusado: o run '${row.run_id}' pertence ao projeto ${row.project_root}` +
    `${row.project_id ? ` (${row.project_id})` : ""}, e esta sessão atende ${mine ?? "nenhum projeto"}.\n` +
    `  Nada foi ${action}. Rode o comando de dentro do projeto dono, ou use\n` +
    `  \`nrv supervisor status --all-projects\` para a visão da máquina inteira.\n`,
  );
  process.exit(4);
}

function usage(code: number): never {
  process.stderr.write(
    "uso:\n" +
    "  nrv run-track open  --target <slug> --kind <business|squad|agent-x|clone> --outputs <dir> [--project <id>] [--runtime <r>]\n" +
    "  nrv run-track beat  <run-id>\n" +
    "  nrv run-track close <run-id> --state <delivered|withheld|failed> [--error \"<why>\"]\n" +
    "  nrv run-track list                              # só os runs deste projeto\n",
  );
  process.exit(code);
}

let handle;
try {
  handle = openLedger();
} catch (e) {
  warn(`ledger unavailable (${(e as Error).message}) — this run will NOT be tracked`);
  process.exit(0);
}
try {
  if (sub === "open") {
    const target = flag("target");
    const kind = flag("kind");
    if (!target || !kind) usage(4);
    const outputs = flag("outputs") || null;
    if (!outputs) warn("no --outputs given: the supervisor cannot read file activity, so a long run may be reported as stalled");
    const opened = openAgenticRun({
      projectId: flag("project") || defaultProjectId(),
      traceId: flag("trace") || null,
      targetSlug: target,
      targetKind: kind,
      outputsRoot: outputs,
      projectDir: outputs,
      runtime: flag("runtime") || null,
      meta: { opened_by: "run-track", cwd: process.cwd() },
    });
    if (!opened) process.exit(0);   // openAgenticRun already warned
    process.stdout.write(opened.runId + "\n");
    process.exit(0);
  }

  if (sub === "beat") {
    const runId = argv[1];
    if (!runId) usage(4);
    const beating = getRun(handle, runId);
    if (beating) refuseForeignRun(beating, "renovado");
    const ok = renewLease(handle, runId, Number(flag("seconds") || AGENTIC_LEASE_SEC));
    if (!ok) warn(`run '${runId}' is not renewable (unknown or already terminal)`);
    process.exit(0);
  }

  if (sub === "close") {
    const runId = argv[1];
    const state = flag("state") as RunState | undefined;
    if (!runId || !state) usage(4);
    if (!["delivered", "withheld", "failed"].includes(state)) {
      warn(`state must be delivered | withheld | failed (got '${state}')`);
      process.exit(4);
    }
    const before = getRun(handle, runId);
    if (!before) { warn(`run '${runId}' not found — nothing closed`); process.exit(0); }
    refuseForeignRun(before, "fechado");
    // Walk the state machine rather than jumping: a run that is still `running`
    // cannot go straight to `delivered`, and refusing here would leave it open
    // forever — the very thing this command exists to prevent.
    for (const step of ["verifying", "gated"] as RunState[]) {
      try { markState(handle, runId, step); } catch { /* already past it */ }
    }
    markState(handle, runId, state, { error: flag("error") || undefined });
    // The whole point of the ledger, from the owner's side: they are not
    // watching this terminal, so the END of the work has to travel to them.
    const label = { delivered: "entregue", withheld: "RETIDO pelo gate", failed: "FALHOU" }[state] ?? state;
    const why = flag("error") ? ` — ${flag("error")}` : "";
    notifyDesktop("Nirvana-OS", `${before.target_kind ?? "run"}/${before.target_slug ?? runId}: ${label}${why}`);
    process.stdout.write(`${runId} → ${state}\n`);
    process.exit(0);
  }

  if (sub === "list") {
    // This project's open runs, never the machine's. `nrv supervisor status
    // --all-projects` is the one place that still shows everything.
    const rows = findNonTerminal(handle);
    if (!rows.length) {
      const root = resolveProjectRoot();
      process.stdout.write(`no open runs${root ? ` em ${root}` : ""}\n`);
      process.exit(0);
    }
    // The `run_id` column is the point of the listing: `beat` and `close` take
    // that id and nothing else. It used to print `project_id` alone — a
    // directory basename — so the one command that discovers open runs handed
    // over an identifier the two commands that act on them answer `not found`
    // to, and the id had to be read out of the SQLite file by hand. Both are
    // here now, labelled, because they are different things and neither
    // substitutes for the other.
    process.stdout.write(
      `${"state".padEnd(10)} ${"run_id".padEnd(24)} ${"project".padEnd(24)} target  lease→\n`,
    );
    for (const r of rows) {
      process.stdout.write(
        `${r.state.padEnd(10)} ${r.run_id.padEnd(24)} ${String(r.project_id ?? "?").padEnd(24)} ${String(r.target_kind ?? "?")}/${String(r.target_slug ?? "?")}  lease→${String(r.lease_expires_at ?? "").slice(11, 19)}\n`,
      );
    }
    process.exit(0);
  }

  usage(sub ? 4 : 0);
} catch (e) {
  warn(`failed: ${(e as Error).message} — the run continues untracked`);
  process.exit(0);
}
