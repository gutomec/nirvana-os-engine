#!/usr/bin/env bun
// audit-emit.ts — CLI para gravar um evento de audit pelo caminho canônico
// (lib/audit.js:emit), com schema validado e dual-write SQLite+JSONL.
//
// Existe para dar ao maestro agêntico um único jeito CORRETO de gravar o audit
// trail, no lugar do `echo '{...}'` cru do SKILL.md — que gravava `business`/
// `squad` (bare) enquanto os leitores esperam `business_slug`/`squad_name` (E3).
//
// Uso:
//   nrv audit emit <event> [--business=<slug>] [--squad=<slug>] [--trace=<id>]
//                          [--project=<id>] [--agent=<name>] [--session=<id>]
//                          [--json='{"k":"v"}'] [--<key>=<value> ...]
//
// Exemplos:
//   nrv audit emit dispatch_business --business=lance-certo --trace=$UUID --brief_excerpt="..."
//   nrv audit emit dispatch_squad --squad=brandcraft --trace=$UUID
//   nrv audit emit gate_passed --business=lance-certo --trace=$UUID --score=0.92
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const audit = require("../lib/audit.js");

function usage(code: number): never {
  console.error(
    "usage: nrv audit emit <event> [--business=<slug>] [--squad=<slug>] [--trace=<id>]\n" +
    "                              [--project=<id>] [--agent=<name>] [--session=<id>]\n" +
    "                              [--json='{...}'] [--<key>=<value> ...]\n\n" +
    `allowed events: ${[...audit.ALLOWED_EVENTS].join(", ")}`,
  );
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") usage(argv.length === 0 ? 2 : 0);

const event = argv[0];
const ctx: Record<string, unknown> = {};
const payload: Record<string, unknown> = {};

// Mapeia flags de contexto (as que emit() promove para o topo do evento) e
// coleta o resto como payload livre. Aceita `--k=v` e `--k v`.
const CTX_KEYS: Record<string, string> = {
  business: "business_slug", "business-slug": "business_slug", business_slug: "business_slug",
  squad: "squad_name", "squad-name": "squad_name", squad_name: "squad_name",
  trace: "trace_id", "trace-id": "trace_id", trace_id: "trace_id",
  project: "project_id", "project-id": "project_id", project_id: "project_id",
  agent: "agent_or_employee", employee: "agent_or_employee", agent_or_employee: "agent_or_employee",
  session: "session_id", "session-id": "session_id", session_id: "session_id",
};

for (let i = 1; i < argv.length; i++) {
  let a = argv[i];
  if (!a.startsWith("--")) { console.error(`audit emit: argumento inesperado '${a}'`); usage(2); }
  a = a.slice(2);
  let key: string, val: string;
  const eq = a.indexOf("=");
  if (eq >= 0) { key = a.slice(0, eq); val = a.slice(eq + 1); }
  else { key = a; const next = argv[i + 1]; if (next !== undefined && !next.startsWith("--")) { val = next; i++; } else { val = "true"; } }

  if (key === "json") {
    try { Object.assign(payload, JSON.parse(val)); }
    catch (e) { console.error(`audit emit: --json inválido: ${(e as Error).message}`); process.exit(2); }
    continue;
  }
  const ctxKey = CTX_KEYS[key];
  if (ctxKey) ctx[ctxKey] = val;
  else payload[key] = val;
}

try {
  const { path } = audit.emit(event, payload, ctx);
  const tag = ctx.business_slug ? ` business=${ctx.business_slug}` : ctx.squad_name ? ` squad=${ctx.squad_name}` : "";
  console.log(`audit: ${event}${tag} → ${path}`);
  process.exit(0);
} catch (e) {
  console.error(`audit emit: ${(e as Error).message}`);
  process.exit(1);
}
