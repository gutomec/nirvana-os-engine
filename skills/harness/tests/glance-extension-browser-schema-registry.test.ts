import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeJson } from "../lib/glance/extensions/canonicalize.ts";
import {
  BROWSER_SCHEMA_DOCUMENTS,
  createBrowserSchemaRegistry,
} from "../lib/glance/views/extension-message-schema-registry.js";

const SCHEMA_NAMES = [
  "glance-extension-manifest.schema.json",
  "glance-extension-dataset-envelope.schema.json",
  "glance-extension-catalog.schema.json",
  "glance-extension-public-error.schema.json",
  "glance-extension-message.schema.json",
] as const;

const digest = (value: unknown) => createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");

test("EXT-SCHEMA-BROWSER-FIVE-DOCUMENTS preserves every server JCS digest", () => {
  expect(BROWSER_SCHEMA_DOCUMENTS).toHaveLength(5);
  const browserById = new Map(BROWSER_SCHEMA_DOCUMENTS.map((document: any) => [document.$id, document]));
  for (const name of SCHEMA_NAMES) {
    const server = JSON.parse(readFileSync(join(import.meta.dir, "../lib/glance/extensions/schemas", name), "utf8"));
    const browser = browserById.get(server.$id);
    expect(browser, name).toBeDefined();
    expect(digest(browser), name).toBe(digest(server));
  }
});

test("EXT-SCHEMA-BROWSER-DRAFT-2020 evaluates nested refs, conditionals, closures, bounds and formats", () => {
  const registry = createBrowserSchemaRegistry();
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://schemas.nirvana-os.dev/test/browser-evaluator/1.0.0",
    type: "object",
    additionalProperties: false,
    required: ["kind", "items", "when", "id"],
    properties: {
      kind: { enum: ["one", "two"] },
      items: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 3 } },
      when: { type: "string", format: "date-time" },
      id: { type: "string", format: "uuid" },
    },
    allOf: [{ if: { properties: { kind: { const: "two" } } }, then: { properties: { items: { minItems: 2 } } } }],
  };
  registry.add(schema);
  expect(registry.validate(schema.$id, {
    kind: "two",
    items: [1, 2],
    when: "2026-08-22T12:00:00Z",
    id: "11111111-1111-4111-8111-111111111111",
  })).toBe(true);
  expect(registry.validate(schema.$id, {
    kind: "two",
    items: [1],
    when: "2026-02-30T12:00:00Z",
    id: "not-a-uuid",
    extra: true,
  })).toBe(false);
});

test("EXT-SCHEMA-BROWSER-KEYWORD-MATRIX covers every Draft 2020-12 keyword used by the normative registry", () => {
  const registry = createBrowserSchemaRegistry([]);
  const id = "https://schemas.nirvana-os.dev/test/browser-keywords/1.0.0";
  registry.add({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    type: "object",
    additionalProperties: false,
    required: ["nil", "flag", "count", "ratio", "name", "items", "choice", "when", "uri", "uuid"],
    properties: {
      nil: { type: "null" },
      flag: { type: "boolean", const: true },
      count: { type: "integer", minimum: 1, maximum: 3 },
      ratio: { type: "number" },
      name: { $ref: "#/$defs/name", minLength: 2 },
      items: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: ["a", "b"] } },
      choice: { oneOf: [{ const: "one" }, { const: "two" }] },
      when: { type: "string", format: "date-time" },
      uri: { type: "string", format: "uri", maxLength: 100 },
      uuid: { type: "string", format: "uuid" },
    },
    allOf: [{ if: { properties: { count: { const: 3 } } }, then: { properties: { choice: { const: "two" } } } }],
    $defs: { name: { type: "string", minLength: 1, maxLength: 4, pattern: "^[a-z]+$" } },
  });
  const valid = {
    nil: null, flag: true, count: 2, ratio: 1.5, name: "ab", items: ["a", "b"], choice: "one",
    when: "2026-08-22T12:00:00Z", uri: "https://github.com/a", uuid: "11111111-1111-4111-8111-111111111111",
  };
  expect(registry.validate(id, valid)).toBe(true);
  for (const mutate of [
    (value: any) => { value.extra = true; },
    (value: any) => { delete value.nil; },
    (value: any) => { value.nil = false; },
    (value: any) => { value.flag = false; },
    (value: any) => { value.count = 1.5; },
    (value: any) => { value.count = 0; },
    (value: any) => { value.count = 4; },
    (value: any) => { value.ratio = "1.5"; },
    (value: any) => { value.name = "A"; },
    (value: any) => { value.name = "abcde"; },
    (value: any) => { value.items = []; },
    (value: any) => { value.items = ["a", "a"]; },
    (value: any) => { value.items = ["a", "b", "a"]; },
    (value: any) => { value.items = ["c"]; },
    (value: any) => { value.choice = "three"; },
    (value: any) => { value.when = "2026-02-30T12:00:00Z"; },
    (value: any) => { value.uri = "/relative"; },
    (value: any) => { value.uuid = "not-a-uuid"; },
    (value: any) => { value.count = 3; value.choice = "one"; },
  ]) {
    const invalid: any = structuredClone(valid);
    mutate(invalid);
    expect(registry.validate(id, invalid)).toBe(false);
  }
  const noMatch = structuredClone(valid);
  noMatch.count = 1;
  expect(registry.validate(id, noMatch)).toBe(true);
});

test("EXT-SCHEMA-BROWSER-REF-POLICY rejects remote, unknown and unused unsupported branches", () => {
  expect(() => createBrowserSchemaRegistry([]).add({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://schemas.nirvana-os.dev/test/remote-ref/1.0.0",
    $ref: "https://example.test/schema.json",
  })).toThrow("REMOTE_REF_FORBIDDEN");
  expect(() => createBrowserSchemaRegistry([]).add({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://schemas.nirvana-os.dev/test/unknown-ref/1.0.0",
    $ref: "#/$defs/missing",
  })).toThrow("UNKNOWN_LOCAL_REF");
  expect(() => createBrowserSchemaRegistry([]).add({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://schemas.nirvana-os.dev/test/unknown-keyword/1.0.0",
    $defs: { unused: { unsupported: true } },
  })).toThrow("UNSUPPORTED_KEYWORD:unsupported");
});

test("EXT-SCHEMA-BROWSER-ONEOF requires exactly one matching branch", () => {
  const registry = createBrowserSchemaRegistry([]);
  const id = "https://schemas.nirvana-os.dev/test/browser-oneof/1.0.0";
  registry.add({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    oneOf: [{ type: "number" }, { type: "integer" }],
  });
  expect(registry.validate(id, 1.5)).toBe(true);
  expect(registry.validate(id, 1)).toBe(false);
  expect(registry.validate(id, "1")).toBe(false);
});

test("EXT-SCHEMA-BROWSER-GENERATOR is deterministic and idempotent", () => {
  const output = join(import.meta.dir, "../lib/glance/views/extension-message-schema-registry.js");
  const before = readFileSync(output);
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../../scripts/generate-glance-browser-schemas.ts")], {
    cwd: join(import.meta.dir, "../../.."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(readFileSync(output)).toEqual(before);
});
