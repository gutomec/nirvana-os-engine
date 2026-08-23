#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const expected = [
  ["43.1", "glance-service-config.schema.json", "e021b6adeca2961a58858e1861aa2f543d8e85b3b3d0efe9b3c631afefa4859f"],
  ["43.2", "glance-service-instance.schema.json", "fd064b5d502529fc59f48a1e8bbabc7db4681e22f5aa5a114aa17f748f940fa1"],
  ["43.3", "glance-service-lock-owner.schema.json", "e2fe66b4050988746325085c19598cda4b1a1e6daab03324003aa0cb7e25de8f"],
  ["43.4", "glance-service-stop-request.schema.json", "e4b437fb21be9a2266bee175f97579c606e707861eb0b821e4b8f793ba1eb4d3"],
] as const;

export interface SchemaExtractionIo {
  read(path: string): string;
  exists(path: string): boolean;
  mkdir(path: string): void;
  write(path: string, content: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

const nativeIo: SchemaExtractionIo = {
  read: path => readFileSync(path, "utf8"),
  exists: existsSync,
  mkdir: path => mkdirSync(path, { recursive: true }),
  write: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
  rename: renameSync,
  remove: path => rmSync(path, { recursive: true, force: true }),
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function extract(source: string): Array<readonly [string, string]> {
  return expected.map(([section, filename, expectedHash]) => {
    const match = new RegExp(`### ${section.replace(".", "\\.")}[^\\n]*\\r?\\n\\r?\\n\\x60\\x60\\x60json\\r?\\n([\\s\\S]*?)\\r?\\n\\x60\\x60\\x60`).exec(source);
    if (!match) throw new Error("FENCE_MISSING");
    const content = `${match[1].replace(/\r\n/g, "\n")}\n`;
    if (hash(content) !== expectedHash) throw new Error("FENCE_HASH_MISMATCH");
    return [filename, content] as const;
  });
}

export function extractGlanceServiceSchemas(specification: string, output: string, io: SchemaExtractionIo = nativeIo): 0 | 3 | 6 {
  let source: string;
  try { source = io.read(specification); } catch { return 6; }
  let schemas: Array<readonly [string, string]>;
  try { schemas = extract(source); } catch { return 3; }
  const staging = `${output}.staging-${randomUUID()}`;
  let failure = false;
  try {
    if (io.exists(output)) throw new Error("OUTPUT_ALREADY_EXISTS");
    io.mkdir(dirname(output));
    io.mkdir(staging);
    for (const [filename, content] of schemas) {
      const path = join(staging, filename);
      io.write(path, content);
      if (hash(io.read(path)) !== expected.find(item => item[1] === filename)?.[2]) throw new Error("STAGING_REREAD_MISMATCH");
    }
    io.rename(staging, output);
    return 0;
  } catch { failure = true; }
  try { io.remove(staging); } catch { failure = true; }
  return failure ? 6 : 0;
}

if (import.meta.main) {
  const [specification, output, ...extra] = process.argv.slice(2);
  process.exitCode = !specification || !output || extra.length ? 2 : extractGlanceServiceSchemas(specification, output);
}
