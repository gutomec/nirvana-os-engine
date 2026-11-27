#!/usr/bin/env bun
// evidence.ts — `nrv evidence`: what is proven about an entity, one kind of
// proof at a time. Read-only: nothing is written and no audit event is emitted.
//
//   nrv evidence <squad|business|clone> <slug> [--json]
//   nrv evidence --all [--kind <squad|business|clone>] [--json]
//
// Exit 0 for every read, whatever the answers; 4 on wrong arguments.
import { EXIT, parseArgs } from "../../_shared/lib/bun-helpers.ts";
import { KINDS, kindFromAlias } from "../../_shared/lib/verify/index.ts";
import { entityEvidence, libraryEvidence, renderEntity, renderTable } from "../lib/evidence.ts";

const USAGE = [
  "usage: nrv evidence <squad|business|clone> <slug> [--json]",
  "       nrv evidence --all [--kind <squad|business|clone>] [--json]",
  "",
  "What is proven about an entity, each kind of proof on its own:",
  "  structure      the admission gate admits it as it is on disk now",
  "  delivered      a run of it ended delivered with the gate passing",
  "  changed since  its files did not change after that delivery",
  "  dependencies   this machine has what it declares it needs",
  "  on a host      it is written into a bot host",
  "Each answers verified, failed, stale, not measured or does not apply.",
  "Not measured is not a pass. Reading never changes anything.",
].join("\n");

const { positional, flags } = parseArgs();
// parseArgs gives a bare flag the word after it: `--json squad x` is still a squad.
if (typeof flags.json === "string") positional.unshift(flags.json);
const usageError = (line: string): never => { console.error(`evidence: ${line}`); console.error(USAGE); process.exit(EXIT.INVALID_ARGS); };

if (flags.help || flags.h) { console.log(USAGE); process.exit(EXIT.OK); }

if (flags.all) {
  // parseArgs reads `--all squad` as all=squad; accept it as the kind.
  const named = typeof flags.kind === "string" ? flags.kind : typeof flags.all === "string" ? flags.all : positional[0];
  const kind = named ? kindFromAlias(named) : null;
  if (named && !kind) usageError(`"${named}" is not a kind (squad, business or clone).`);
  const rows = await libraryEvidence(kind ? [kind] : KINDS);
  console.log(flags.json ? JSON.stringify({ schema: "nirvana.evidence-table/v1", entities: rows }, null, 2) : renderTable(rows));
  process.exit(EXIT.OK);
}

const [kindArg, slug, extra] = positional;
if (!kindArg || !slug) usageError("name a kind and a slug, or pass --all.");
const kind = kindFromAlias(kindArg);
if (!kind) usageError(`"${kindArg}" is not a kind (squad, business or clone).`);
if (extra) usageError(`unexpected argument: ${extra}`);

const result = await entityEvidence(kind!, slug);
console.log(flags.json ? JSON.stringify(result, null, 2) : renderEntity(result));
process.exit(EXIT.OK);
