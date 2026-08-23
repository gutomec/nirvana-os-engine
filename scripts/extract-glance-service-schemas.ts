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
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const [specification, output, ...extra] = process.argv.slice(2);
if (!specification || !output || extra.length) process.exitCode = 2;
else {
  let source: string;
  try { source = readFileSync(specification, "utf8"); } catch { process.exitCode = 6; source = ""; }
  const extracted: Array<readonly [string, string]> = [];
  if (process.exitCode === undefined) {
    try {
      for (const [section, filename, expectedHash] of expected) {
        const match = new RegExp(`### ${section.replace(".", "\\.")}[^\\n]*\\r?\\n\\r?\\n\\x60\\x60\\x60json\\r?\\n([\\s\\S]*?)\\r?\\n\\x60\\x60\\x60`).exec(source);
        if (!match) throw new Error("FENCE_MISSING");
        const bytes = `${match[1].replace(/\r\n/g, "\n")}\n`;
        if (hash(bytes) !== expectedHash) throw new Error("FENCE_HASH_MISMATCH");
        extracted.push([filename, bytes]);
      }
      if (existsSync(output)) throw new Error("OUTPUT_ALREADY_EXISTS");
      const staging = `${output}.staging-${randomUUID()}`;
      try {
        mkdirSync(dirname(output), { recursive: true }); mkdirSync(staging);
        for (const [filename, bytes] of extracted) { const path = join(staging, filename); writeFileSync(path, bytes, { mode: 0o600 }); if (hash(readFileSync(path, "utf8")) !== expected.find(item => item[1] === filename)?.[2]) throw new Error("STAGING_REREAD_MISMATCH"); }
        renameSync(staging, output);
      } finally { rmSync(staging, { recursive: true, force: true }); }
    } catch { process.exitCode = 3; }
  }
}
