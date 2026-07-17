#!/usr/bin/env bun
/**
 * businesses skill · loader (Bun/TypeScript)
 *
 * Loads a whole business (manifest + employees + org-chart + routing) and runs
 * cross-validation. Reuses the centralized validators in
 * ~/.nirvana/skills/_shared/validators/validators.ts.
 *
 * This is the Bun replacement for loader.py — Nirvana-OS runs on Bun alone, so
 * no Python is required on the host.
 *
 * Use:
 *   import { loadBusiness, ValidationError } from "./loader.ts";
 *   const biz = loadBusiness("~/businesses/my-startup");
 *
 * or via CLI (parity with the old loader.py output):
 *   bun loader.ts ~/businesses/my-startup
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import { z } from "zod";

// Match python's yaml.safe_load leniency: duplicate keys don't throw (last
// wins). The default `yaml` parser is stricter and would reject manifests the
// canonical loader accepted.
const YAML_OPTS = { uniqueKeys: false } as const;
function parseYaml(text: string): unknown {
  return YAML.parse(text, YAML_OPTS);
}
import {
  BusinessManifestSchema,
  EmployeeFrontmatterSchema,
  OrgChartSchema,
  RoutingSchema,
  validateBusinessIntegrity,
  type BusinessLoadContext,
} from "../../_shared/validators/validators.ts";

export type BusinessManifest = z.infer<typeof BusinessManifestSchema>;
export type EmployeeFrontmatter = z.infer<typeof EmployeeFrontmatterSchema>;
export type OrgChart = z.infer<typeof OrgChartSchema>;
export type Routing = z.infer<typeof RoutingSchema>;

export class ValidationError extends Error {
  errors: string[];
  constructor(message: string, errors: string[] = []) {
    super(message);
    this.name = "ValidationError";
    this.errors = errors;
  }
}

export interface LoadedBusiness {
  path: string;
  manifest: BusinessManifest;
  employees: EmployeeFrontmatter[];
  org_chart: OrgChart;
  routing: Routing | null;
  permanent_memory_path: string | null;
}

function expand(p: string): string {
  let out = p;
  if (out.startsWith("~")) out = path.join(os.homedir(), out.slice(1));
  out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, n) => process.env[n] ?? "");
  return path.resolve(out);
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

function readFrontmatterMd(file: string): { fm: Record<string, unknown>; body: string } {
  const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) throw new ValidationError(`Frontmatter ausente ou malformado em ${file}`);
  const fm = parseYaml(m[1]);
  if (fm === null || typeof fm !== "object" || Array.isArray(fm)) {
    throw new ValidationError(`Frontmatter de ${file} deve ser mapping`);
  }
  return { fm: fm as Record<string, unknown>, body: m[2] };
}

export function loadBusiness(inputPath: string, opts: { strict?: boolean } = {}): LoadedBusiness {
  const strict = opts.strict ?? true;
  const bizPath = expand(inputPath);
  if (!fs.existsSync(bizPath) || !fs.statSync(bizPath).isDirectory()) {
    throw new ValidationError(`Diretório não encontrado: ${bizPath}`);
  }

  const errors: string[] = [];

  // 1. Manifest (required)
  const manifestPath = path.join(bizPath, "business.yaml");
  if (!fs.existsSync(manifestPath)) throw new ValidationError(`business.yaml ausente em ${bizPath}`);
  const manifestParsed = BusinessManifestSchema.safeParse(parseYaml(fs.readFileSync(manifestPath, "utf8")));
  if (!manifestParsed.success) throw new ValidationError(`business.yaml inválido: ${formatZodError(manifestParsed.error)}`);
  const manifest = manifestParsed.data;

  // 2. Org chart (required)
  const chartPath = path.join(bizPath, "org-chart.yaml");
  if (!fs.existsSync(chartPath)) throw new ValidationError(`org-chart.yaml ausente em ${bizPath}`);
  const chartParsed = OrgChartSchema.safeParse(parseYaml(fs.readFileSync(chartPath, "utf8")));
  if (!chartParsed.success) throw new ValidationError(`org-chart.yaml inválido: ${formatZodError(chartParsed.error)}`);
  const orgChart = chartParsed.data;

  // 3. Employees (required, >= 1)
  const employeesDir = path.join(bizPath, "employees");
  if (!fs.existsSync(employeesDir) || !fs.statSync(employeesDir).isDirectory()) {
    throw new ValidationError(`employees/ ausente em ${bizPath}`);
  }
  const employees: EmployeeFrontmatter[] = [];
  const empFiles = fs.readdirSync(employeesDir).filter((f) => f.endsWith(".md")).sort();
  for (const empFile of empFiles) {
    try {
      const { fm } = readFrontmatterMd(path.join(employeesDir, empFile));
      const parsed = EmployeeFrontmatterSchema.safeParse(fm);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
      employees.push(parsed.data);
    } catch (exc) {
      const err = `employee ${empFile}: ${(exc as Error).message}`;
      if (strict) throw new ValidationError(err);
      errors.push(err);
    }
  }
  if (employees.length === 0 && strict) throw new ValidationError(`employees/ vazio em ${bizPath}`);

  // 4. Routing (optional, documentation — tolerant parse, never invalidates)
  let routing: Routing | null = null;
  const routingPath = path.join(bizPath, "routing.yaml");
  if (fs.existsSync(routingPath)) {
    const parsed = RoutingSchema.safeParse(parseYaml(fs.readFileSync(routingPath, "utf8")));
    routing = parsed.success ? parsed.data : null;
  }

  // 5. Permanent memory path (optional)
  let permanentMemoryPath: string | null = null;
  const permanentMd = path.join(bizPath, "memory", "permanent.md");
  if (fs.existsSync(permanentMd)) permanentMemoryPath = permanentMd;

  // 6. Cross-protocol integrity check (BP7, single intake, no cycles, etc.)
  const ctx: BusinessLoadContext = { manifest, employees, org_chart: orgChart };
  const result = validateBusinessIntegrity(ctx);
  if (!result.valid) {
    if (strict) throw new ValidationError(`Integrity check falhou em ${bizPath}`, result.errors);
    errors.push(...result.errors);
  }

  if (errors.length > 0 && strict) throw new ValidationError(`Business ${manifest.name} tem erros`, errors);

  return {
    path: bizPath,
    manifest,
    employees,
    org_chart: orgChart,
    routing,
    permanent_memory_path: permanentMemoryPath,
  };
}

function main(argv: string[]): number {
  // Optional `--field <intake_employee|name|employees|all>` for programmatic use
  // (replaces the old loader-cli.py).
  const fieldIdx = argv.indexOf("--field");
  const field = fieldIdx !== -1 ? argv[fieldIdx + 1] : null;
  const pathArg = argv.find((a) => !a.startsWith("--") && a !== field);
  if (!pathArg) {
    process.stderr.write("Usage: bun loader.ts <business-path> [--field intake_employee|name|employees|all]\n");
    return 2;
  }
  let biz: LoadedBusiness;
  try {
    biz = loadBusiness(pathArg);
  } catch (exc) {
    if (exc instanceof ValidationError) {
      if (field) {
        process.stderr.write(`load_business failed: ${exc.message}\n`);
        return 1;
      }
      process.stderr.write(`INVALID: ${exc.message}\n`);
      for (const err of exc.errors) process.stderr.write(`  - ${err}\n`);
      return 1;
    }
    throw exc;
  }

  if (field) {
    const emps = biz.employees.map((e) => ({ name: e.name, is_brief_intake: !!e.is_brief_intake }));
    if (field === "intake_employee") {
      const i = biz.employees.find((e) => e.is_brief_intake);
      console.log(i ? i.name : "");
    } else if (field === "name") {
      console.log(biz.manifest.name);
    } else if (field === "employees") {
      console.log(JSON.stringify(emps));
    } else {
      console.log(JSON.stringify({ name: biz.manifest.name, employees: emps }, null, 2));
    }
    return 0;
  }

  const intake = biz.employees.find((e) => e.is_brief_intake);
  const antagonists = biz.employees.filter((e) => e.is_antagonist).map((e) => e.name);
  const orgChartNodes = biz.org_chart?.chart ? biz.org_chart.chart.length : 0;
  console.log(`OK: ${biz.manifest.name} v${biz.manifest.version}`);
  console.log(`  protocol: ${biz.manifest.protocol}`);
  console.log(`  domains: ${JSON.stringify(biz.manifest.domains)}`);
  console.log(`  employees: ${biz.employees.length}`);
  console.log(`  brief_intake: ${intake ? intake.name : "<NONE>"}`);
  console.log(`  antagonists: ${antagonists.length ? JSON.stringify(antagonists) : "<none>"}`);
  console.log(`  org_chart nodes: ${orgChartNodes}`);
  console.log(`  routing: ${biz.routing ? "present" : "absent"}`);
  console.log(`  permanent_memory: ${biz.permanent_memory_path || "<none>"}`);
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
