// audit-emit.ts — the one function that appends to an audit log.
//
// There were eighteen private copies of this, each four lines long and each
// slightly its own. They were harmless while an audit line was just a line. They
// stopped being harmless the moment events started carrying a provenance stamp:
// stamping two of the eighteen produced a signal that was WORSE than no signal,
// because three legitimate engine events read as unsigned within minutes of
// shipping and a reader following the label would have concluded the maestro was
// fabricating them. I did conclude that, twice, about my own engine.
//
// So the copies are the defect, not the missing stamps. One owner, every caller
// through it, and a gate that fails when a new copy appears.

import * as fs from "node:fs";
import * as path from "node:path";
import { harnessLogsDir } from "./log-paths.ts";
import { stamp } from "./audit-provenance.ts";

export interface EmitOptions {
  /** Where the project root is, for resolving which log to write. */
  cwd?: string;
  /** Write here instead of the resolved log — the per-target logs under an
   *  outputs tree, which belong to one dispatch rather than to the project. */
  file?: string;
}

/**
 * Append one event, stamped, to the audit.
 *
 * Never throws: an engine that cannot write its log must still finish its work.
 * A caller that needs to know whether the write landed gets the boolean.
 */
export function emitAudit(payload: Record<string, any>, opts: EmitOptions = {}): boolean {
  try {
    const target = opts.file ?? path.join(
      harnessLogsDir({ cwd: opts.cwd }),
      new Date().toISOString().slice(0, 10),
      "audit.jsonl",
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, JSON.stringify(stamp({ ts: new Date().toISOString(), ...payload })) + "\n");
    return true;
  } catch { return false; }
}
