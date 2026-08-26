#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const schemaRoot = join(root, "skills", "harness", "lib", "glance", "extensions", "schemas");
const output = join(root, "skills", "harness", "lib", "glance", "views", "extension-message-schema-registry.js");
const names = [
  "glance-extension-manifest.schema.json",
  "glance-extension-dataset-envelope.schema.json",
  "glance-extension-catalog.schema.json",
  "glance-extension-public-error.schema.json",
  "glance-extension-message.schema.json",
];
const documents = names.map((name) => JSON.parse(readFileSync(join(schemaRoot, name), "utf8")));
const source = readFileSync(output, "utf8");
const begin = "// BEGIN GENERATED GLANCE SCHEMA DOCUMENTS";
const end = "// END GENERATED GLANCE SCHEMA DOCUMENTS";
const start = source.indexOf(begin);
const finish = source.indexOf(end);
if (start < 0 || finish <= start) throw new Error("GENERATED_MARKERS_MISSING");
const block = `${begin}\nexport const BROWSER_SCHEMA_DOCUMENTS = ${JSON.stringify(documents, null, 2)};\n`;
writeFileSync(output, `${source.slice(0, start)}${block}${source.slice(finish)}`, "utf8");
