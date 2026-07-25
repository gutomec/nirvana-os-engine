#!/usr/bin/env bun
// help.ts — print the nrv help, generated from the single command table.
// Used by both bin/nrv (bash) and nrv.ts (Windows) so help can never drift.
import { renderHelp } from "../lib/commands.ts";
console.log(renderHelp());
