#!/usr/bin/env bun
// protocol.ts — `nrv protocol`: the orchestrator's operating instructions for
// the configured mode. In solo mode (every performance profile) that is the
// lean protocol (harness/LEAN.md, ~5 KB); otherwise it points at the full
// harness SKILL.md, which the chain and session modes are written against.
//
//   nrv protocol            the instructions for the effective business mode
//   nrv protocol --lean     the lean protocol, whatever the mode
//   nrv protocol --full     the pointer to the full protocol, whatever the mode

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSetting } from "../../_shared/lib/settings.ts";

const argv = process.argv.slice(2);
const lean = path.join(import.meta.dir, "..", "LEAN.md");
const full = path.join(import.meta.dir, "..", "SKILL.md");

const mode = String(resolveSetting("execution.business_mode").value);
const wantLean = argv.includes("--lean") || (!argv.includes("--full") && mode === "solo");

if (wantLean) {
  process.stdout.write(fs.readFileSync(lean, "utf8"));
} else {
  console.log(`Business mode: ${mode}. Read ${full} and follow it as your operating instructions for this brief.`);
  console.log(`Its ../_shared/... references resolve against ${path.dirname(full)}.`);
}
