// squad-preflight.ts — what a squad declares of its host, checked before it runs.
//
// dependencies.yaml carries two things the engine cannot install: credentials
// (`env_vars`) and MCP servers (`mcps`). Both belong to the host runtime and
// the operator. Until now the credential check ran only inside `nrv activate`,
// and a missing variable reached the squad as an empty string, so the failure
// looked like a model mistake. This module reads the declaration once and is
// called from the doctor, from the dispatch prep step and from the headless
// runner; it never blocks — it says what is missing and where it was looked for.
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const hostMcp = require("./host-mcp.js") as {
  mcpConfiguredIn: (name: string, opts?: { cwd?: string }) => string[];
  normalizeMcps: (mcps: unknown) => Array<{ name: string; purpose: string | null; required: boolean }>;
};

export type EnvFinding = { name: string; required: boolean; description: string | null; set: boolean };
export type McpFinding = { name: string; purpose: string | null; required: boolean; configured_in: string[] };
export type Preflight = {
  squadDir: string;
  declared: boolean;
  env: EnvFinding[];
  mcps: McpFinding[];
  missingRequired: EnvFinding[];
  missingOptional: EnvFinding[];
  mcpsNotConfigured: McpFinding[];
};

function normalizeEnv(vars: unknown): Array<{ name: string; required: boolean; description: string | null }> {
  const out: Array<{ name: string; required: boolean; description: string | null }> = [];
  const push = (v: unknown, required?: boolean) => {
    if (typeof v === "string" && v.trim()) out.push({ name: v.trim(), required: !!required, description: null });
    else if (v && typeof v === "object" && typeof (v as any).name === "string") {
      const o = v as { name: string; required?: unknown; description?: unknown };
      out.push({ name: o.name.trim(), required: required ?? !!o.required, description: typeof o.description === "string" ? o.description : null });
    }
  };
  if (Array.isArray(vars)) for (const v of vars) push(v);
  else if (vars && typeof vars === "object") {
    for (const v of ((vars as any).required || [])) push(v, true);
    for (const v of ((vars as any).optional || [])) push(v, false);
  }
  return out;
}

export function squadPreflight(squadDir: string, opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Preflight {
  const env = opts.env ?? process.env;
  const file = path.join(squadDir, "dependencies.yaml");
  const empty: Preflight = { squadDir, declared: false, env: [], mcps: [], missingRequired: [], missingOptional: [], mcpsNotConfigured: [] };
  if (!fs.existsSync(file)) return empty;
  let deps: any;
  try { deps = Bun.YAML.parse(fs.readFileSync(file, "utf8")); } catch { return empty; }
  if (!deps || typeof deps !== "object") return empty;
  const envFindings: EnvFinding[] = normalizeEnv(deps.env_vars).map((v) => ({ ...v, set: !!env[v.name] }));
  const mcps: McpFinding[] = hostMcp.normalizeMcps(deps.mcps).map((m) => ({ ...m, configured_in: hostMcp.mcpConfiguredIn(m.name, { cwd: opts.cwd }) }));
  return {
    squadDir, declared: envFindings.length > 0 || mcps.length > 0,
    env: envFindings, mcps,
    missingRequired: envFindings.filter((v) => v.required && !v.set),
    missingOptional: envFindings.filter((v) => !v.required && !v.set),
    mcpsNotConfigured: mcps.filter((m) => m.configured_in.length === 0),
  };
}

/** One line per finding worth a warning, for a terminal or an audit event. */
export function preflightWarnings(p: Preflight, slug: string): string[] {
  const lines: string[] = [];
  if (p.missingRequired.length) {
    lines.push(`credentials: ${slug} declares ${p.missingRequired.map((v) => v.name).join(", ")} as required and ${p.missingRequired.length === 1 ? "it is" : "they are"} not set in this environment${p.missingRequired.some((v) => v.description) ? ` (${p.missingRequired.filter((v) => v.description).map((v) => `${v.name}: ${v.description}`).join("; ")})` : ""}`);
  }
  for (const m of p.mcpsNotConfigured) {
    lines.push(`mcp: ${slug} declares the MCP server '${m.name}'${m.purpose ? ` (${m.purpose})` : ""}${m.required ? ", required," : ""} and no host configuration on this machine names it — the squad does not run MCP servers; configure it in the runtime that will execute the squad`);
  }
  return lines;
}
