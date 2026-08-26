import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const USAGE = "Usage: bun scripts/extract-glance-spec-schemas.ts <spec.md> <output-directory>";

export class SchemaExtractionError extends Error {}

const TARGETS = [
  {
    id: "https://schemas.nirvana-os.dev/glance/extension-manifest/1.0.0",
    name: "glance-extension-manifest.schema.json",
    digest: "5ff61725bb126623bdddffe206b4782a25d02c07688f3d53af62edfc6a25b8e3",
  },
  {
    id: "https://schemas.nirvana-os.dev/glance/dataset-envelope/1.0.0",
    name: "glance-extension-dataset-envelope.schema.json",
    digest: "15c13bc0fa4e1731741f5a4f1c0b94db09962b752217f9653d4e5e8d97c1f874",
  },
  {
    id: "https://schemas.nirvana-os.dev/glance/extension-catalog/1.0.0",
    name: "glance-extension-catalog.schema.json",
    digest: "0d9c28396929df94f3fe67d30ad602a15ebdee3697ecfb7e09e85db351bf626c",
  },
  {
    id: "https://schemas.nirvana-os.dev/glance/public-error/1.0.0",
    name: "glance-extension-public-error.schema.json",
    digest: "4a4a6b25d2519fbf852d7d5da63b5f0a0c28cc1e040f42cc5fa089839bed6146",
  },
  {
    id: "https://schemas.nirvana-os.dev/glance/message/1.0.0",
    name: "glance-extension-message.schema.json",
    digest: "421a1da6e81643e61886d2cde7ea4bfa8f125486a7ce28bb50b9b81c71c9fb02",
  },
] as const;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function extractSchemas(specPath: string, outputDirectory: string): void {
  const bytes = readFileSync(specPath);
  let spec: string;
  try {
    spec = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SchemaExtractionError("SPEC_UTF8");
  }
  if (spec.charCodeAt(0) === 0xfeff) throw new SchemaExtractionError("SPEC_BOM");
  if (spec.includes("\r")) throw new SchemaExtractionError("SPEC_LF_ONLY");

  const documents = new Map<string, string[]>();
  for (const match of spec.matchAll(/```json\n([\s\S]*?)```/g)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const id = (parsed as Record<string, unknown>).$id;
    if (typeof id !== "string") continue;
    const matches = documents.get(id) ?? [];
    matches.push(match[1]);
    documents.set(id, matches);
  }

  const selected = TARGETS.map((target) => {
    const matches = documents.get(target.id) ?? [];
    if (matches.length !== 1) throw new SchemaExtractionError(`SCHEMA_FENCE:${target.id}`);
    const text = matches[0];
    if (sha256(text) !== target.digest) throw new SchemaExtractionError(`SCHEMA_HASH:${target.id}`);
    return { ...target, text };
  });

  if (existsSync(outputDirectory)) {
    const allowed = new Set(TARGETS.map((target) => target.name));
    for (const entry of readdirSync(outputDirectory)) {
      if (!allowed.has(entry as (typeof TARGETS)[number]["name"])) {
        throw new SchemaExtractionError(`OUTPUT_CONFLICT:${entry}`);
      }
    }
    for (const target of selected) {
      const destination = join(outputDirectory, target.name);
      if (existsSync(destination) && sha256(readFileSync(destination)) !== target.digest) {
        throw new SchemaExtractionError(`OUTPUT_CONFLICT:${target.name}`);
      }
    }
    if (selected.every((target) => existsSync(join(outputDirectory, target.name)))) return;
  }

  const parent = dirname(outputDirectory);
  mkdirSync(parent, { recursive: true });
  const staging = join(parent, `.glance-schema-stage-${randomUUID()}`);
  const backup = join(parent, `.glance-schema-backup-${randomUUID()}`);
  mkdirSync(staging);
  try {
    for (const target of selected) writeFileSync(join(staging, target.name), target.text, { encoding: "utf8", flag: "wx" });
    if (existsSync(outputDirectory)) renameSync(outputDirectory, backup);
    try {
      renameSync(staging, outputDirectory);
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, outputDirectory);
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [, , specPath, outputDirectory, ...rest] = process.argv;
  if (!specPath || !outputDirectory || rest.length > 0) {
    console.error(USAGE);
    process.exit(2);
  }

  try {
    extractSchemas(specPath, outputDirectory);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(error instanceof SchemaExtractionError ? 3 : 6);
  }
}
