#!/usr/bin/env bun
/**
 * inspect-business.ts — show business metadata (pure TS, scope-aware).
 *
 * Reads the business directory directly via the scope resolver and prints
 * a compact summary: slug, type, source, dir, employees, capabilities.
 * No Python dependency.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { paths, parseArgs, EXIT } from "../../_shared/lib/bun-helpers.ts";
import { resolveScope, enumerate } from "../../_shared/lib/scope.ts";

const { positional, flags } = parseArgs();
const slug = positional[0];
const fmt = (flags.format as string) || "compact";

if (!slug) {
  console.error("usage: inspect-business <slug> [--format=compact|json]");
  process.exit(EXIT.INVALID_ARGS);
}

// Resolution order: scope enumerate FIRST (so a project-local business is not
// shadowed by a global same-slug copy), then the explicit BUSINESSES_DIR
// override as a direct probe (keeps test sandboxes / forced-global working).
let match: { slug: string; dir: string; source: string } | null = null;
const scope = resolveScope();
const found = enumerate(scope, "businesses").find(e => e.slug === slug && !e.overridden);
if (found) {
  match = { slug: found.slug, dir: found.dir, source: found.source };
}
if (!match && process.env.BUSINESSES_DIR) {
  const direct = path.join(paths.BUSINESSES_DIR, slug);
  if (fs.existsSync(path.join(direct, "business.yaml"))) {
    match = { slug, dir: direct, source: "override" };
  }
}
if (!match) {
  console.error(`ERRO: business '${slug}' não encontrada (scope=${scope.mode})`);
  process.exit(EXIT.FAILURES);
}

const businessYaml = path.join(match!.dir, "business.yaml");
if (!fs.existsSync(businessYaml)) {
  console.error(`ERRO: business.yaml não encontrado em ${match!.dir}`);
  process.exit(EXIT.FAILURES);
}

const raw = fs.readFileSync(businessYaml, "utf8");

// Tiny YAML parser — only what we need for top-level fields and a few lists.
// We don't pull js-yaml: businesses already validate via loader.py at index time.
function parseSimpleYaml(src: string): Record<string, any> {
  const out: Record<string, any> = {};
  const lines = src.split(/\r?\n/);
  let currentList: string | null = null;
  let currentMap: string | null = null;
  for (const ln of lines) {
    const stripped = ln.replace(/#.*$/, "").trimEnd();
    if (!stripped.trim()) continue;
    const indent = ln.length - ln.trimStart().length;
    if (indent === 0) {
      const m = stripped.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (!m) continue;
      const [, key, val] = m;
      if (val === "" || val === "|") {
        currentList = key; currentMap = null;
        out[key] = [];
      } else {
        out[key] = val.replace(/^["']|["']$/g, "");
        currentList = null; currentMap = null;
      }
    } else if (currentList) {
      const it = stripped.trim();
      if (it.startsWith("- ")) {
        const v = it.slice(2).trim().replace(/^["']|["']$/g, "");
        if (v.endsWith(":")) {
          // list of maps; collect under name
          (out[currentList] as any[]).push({ _name: v.slice(0, -1) });
        } else if (v.includes(": ")) {
          const [k, ...rest] = v.split(": ");
          (out[currentList] as any[]).push({ [k]: rest.join(": ").replace(/^["']|["']$/g, "") });
        } else {
          (out[currentList] as any[]).push(v);
        }
      } else if (it.includes(":")) {
        // sub-key on a map item — attach to last list entry
        const arr = out[currentList] as any[];
        const last = arr[arr.length - 1];
        if (last && typeof last === "object") {
          const m2 = it.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
          if (m2) last[m2[1]] = m2[2].replace(/^["']|["']$/g, "");
        }
      }
    }
  }
  return out;
}

const meta = parseSimpleYaml(raw);

// Count files in known subdirs
const employeesDir = path.join(match!.dir, "employees");
const tasksDir = path.join(match!.dir, "tasks");
const workflowsDir = path.join(match!.dir, "workflows");
const employeeFiles = fs.existsSync(employeesDir)
  ? fs.readdirSync(employeesDir).filter(f => /\.md$/i.test(f))
  : [];
const taskFiles = fs.existsSync(tasksDir)
  ? fs.readdirSync(tasksDir).filter(f => /\.md$/i.test(f))
  : [];
const workflowFiles = fs.existsSync(workflowsDir)
  ? fs.readdirSync(workflowsDir).filter(f => /\.ya?ml$/i.test(f))
  : [];

const summary = {
  slug,
  source: match!.source,
  dir: match!.dir,
  type: meta.type ?? "(unknown)",
  description: meta.description ?? "",
  employees: employeeFiles.length,
  tasks: taskFiles.length,
  workflows: workflowFiles.length,
  business_yaml: businessYaml,
};

if (fmt === "json") {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Business: ${slug}`);
  console.log(`  Source:       ${summary.source}`);
  console.log(`  Directory:    ${summary.dir}`);
  console.log(`  Type:         ${summary.type}`);
  if (summary.description) console.log(`  Description:  ${summary.description}`);
  console.log(`  Employees:    ${summary.employees}`);
  console.log(`  Tasks:        ${summary.tasks}`);
  console.log(`  Workflows:    ${summary.workflows}`);
  console.log(`  business.yaml: ${summary.business_yaml}`);
}

process.exit(EXIT.OK);
