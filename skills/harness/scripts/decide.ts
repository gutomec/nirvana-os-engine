#!/usr/bin/env bun
// nrv decide: ask a decision model (System One) closed questions.
//
//   nrv decide status [--json]
//       Which providers are configured (never prints a key), which one auto
//       picks, and whether this machine could host JEV-27B.
//   nrv decide --state "<text>" | --state-file <path>
//              --questions '<json>' | --questions-file <path>
//              [--provider auto|local|typesafe|gemini|openai|subscription] [--api-only]
//       Prints the normalized answers as JSON.
//
// Questions JSON: { "<name>": { "type": "yes_no" | "choice" | "score",
//   "instructions": "...", "options": { "<id>": "<description>" }   (choice)
//                          "levels": ["lowest", ..., "highest"] } } (score)
//
// Exit codes: 0 answered · 1 every provider failed · 2 usage · 3 no provider configured.

import * as fs from "node:fs";
import {
  availableProviders, decide, decisionEnv, isDecisionError, localCapacity, settingText, validateRequest,
  DECISION_MODELS, type DecisionProvider, type DecisionRequest,
} from "../../_shared/lib/decision-model.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : undefined;
};
const json = args.includes("--json");

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error('Usage: nrv decide status [--json]\n       nrv decide --state "<text>"|--state-file <path> --questions \'<json>\'|--questions-file <path> [--provider <p>] [--api-only]');
  process.exit(2);
}

if (args[0] === "status") {
  const env = decisionEnv();
  const providers = availableProviders({ env });
  const setting = settingText("decision.provider") || "auto";
  const active = setting === "off" ? null : setting === "auto" ? providers[0] ?? null : providers.includes(setting as DecisionProvider) ? setting : null;
  const capacity = localCapacity();
  const report = {
    setting, active,
    configured: providers.map((p) => ({ provider: p, model: p === "subscription" ? "runtime-cli (uncalibrated)" : DECISION_MODELS[p] })),
    local_url: settingText("decision.local_url") || null,
    min_confidence: Number(settingText("decision.min_confidence") || 0.7),
    jev27b: capacity,
  };
  if (json) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
  console.log(`decision.provider = ${setting} → ${active ?? "none"}`);
  for (const c of report.configured) console.log(`  ✓ ${c.provider.padEnd(12)} ${c.model}`);
  for (const p of ["typesafe", "gemini", "openai"] as const) {
    if (!providers.includes(p)) console.log(`  · ${p.padEnd(12)} no key (${p === "typesafe" ? "TYPESAFE_API_KEY" : p === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY"})`);
  }
  if (!report.local_url) console.log(`  · ${"local".padEnd(12)} decision.local_url not set`);
  console.log(`JEV-27B on this machine: ${capacity.fits} (${capacity.total_ram_gb} GB RAM${capacity.gpus.length ? ", " + capacity.gpus.map((g) => `${g.name} ${g.vram_gb} GB`).join(", ") : ""})`);
  console.log(`  ${capacity.advice}`);
  process.exit(0);
}

const stateArg = flag("--state");
const stateFile = flag("--state-file");
const qArg = flag("--questions");
const qFile = flag("--questions-file");
if (!(stateArg ?? stateFile) || !(qArg ?? qFile)) usage();

let req: DecisionRequest;
try {
  const state = stateArg ?? fs.readFileSync(stateFile!, "utf8");
  const questions = JSON.parse(qArg ?? fs.readFileSync(qFile!, "utf8"));
  req = { state, questions };
  validateRequest(req);
} catch (e) {
  usage(`decide: ${(e as Error).message}`);
}

const provider = flag("--provider") as DecisionProvider | "auto" | undefined;
const result = await decide(req, { provider, apiOnly: args.includes("--api-only") });
console.log(JSON.stringify(result, null, 2));
if (isDecisionError(result)) process.exit(result.tried.length ? 1 : 3);
