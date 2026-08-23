import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSchemas, sha256 } from "../../../scripts/extract-glance-spec-schemas.ts";
import {
  createSchemaRegistry,
  validateSchema,
  type JsonSchema,
} from "../lib/glance/extensions/schema-validator.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const SCRIPT = join(REPO, "scripts", "extract-glance-spec-schemas.ts");
const APPROVED_SPEC = process.env.GLANCE_APPROVED_SPEC;
const APPROVED_SPEC_SHA256 = "d168be91f4df700336f811df3fee479e8b7bd276e5fe4ba22a6802c014480e74";
const APPROVED_SPEC_BYTES = 119_512;
const GOLDEN_SPEC = join(import.meta.dir, "fixtures", "glance-extension", "approved-schema-fences.md");
const GOLDEN_SPEC_SHA256 = "d1a137bd5b49b9ead138a0bd027503e4581af5f0983696ca82a7bdc2976c2f6b";
const GOLDEN_SPEC_BYTES = 17_955;
const SCHEMA_DIRECTORY = join(REPO, "skills", "harness", "lib", "glance", "extensions", "schemas");
const EXPECTED = {
  "glance-extension-manifest.schema.json": "5ff61725bb126623bdddffe206b4782a25d02c07688f3d53af62edfc6a25b8e3",
  "glance-extension-dataset-envelope.schema.json": "15c13bc0fa4e1731741f5a4f1c0b94db09962b752217f9653d4e5e8d97c1f874",
  "glance-extension-catalog.schema.json": "0d9c28396929df94f3fe67d30ad602a15ebdee3697ecfb7e09e85db351bf626c",
  "glance-extension-public-error.schema.json": "4a4a6b25d2519fbf852d7d5da63b5f0a0c28cc1e040f42cc5fa089839bed6146",
  "glance-extension-message.schema.json": "421a1da6e81643e61886d2cde7ea4bfa8f125486a7ce28bb50b9b81c71c9fb02",
} as const;

function sourceSpec(root: string): string {
  mkdirSync(root, { recursive: true });
  const copy = join(root, "approved-spec-copy.md");
  copyFileSync(APPROVED_SPEC ?? GOLDEN_SPEC, copy);
  return copy;
}

function assertSourcesUnchanged(): void {
  expect(statSync(GOLDEN_SPEC).size).toBe(GOLDEN_SPEC_BYTES);
  expect(sha256(readFileSync(GOLDEN_SPEC))).toBe(GOLDEN_SPEC_SHA256);
  if (!APPROVED_SPEC) return;
  expect(statSync(APPROVED_SPEC).size).toBe(APPROVED_SPEC_BYTES);
  expect(sha256(readFileSync(APPROVED_SPEC))).toBe(APPROVED_SPEC_SHA256);
}

beforeAll(assertSourcesUnchanged);
afterAll(assertSourcesUnchanged);

test("EXT-SCHEMA-EXTRACT-ARGS exits 2 without input arguments", () => {
  const result = Bun.spawnSync([process.execPath, SCRIPT], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("Usage:");
});

test("EXT-SCHEMA-FIVE-DOCUMENTS extracts the approved bytes and hashes", () => {
  const root = mkdtempSync(join(tmpdir(), "glance-schema-extract-"));
  const output = join(root, "schemas");
  try {
    extractSchemas(APPROVED_SPEC ?? GOLDEN_SPEC, output);
    for (const [name, digest] of Object.entries(EXPECTED)) {
      expect(sha256(readFileSync(join(output, name)))).toBe(digest);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EXT-SCHEMA-EXTRACT-CLI publishes all schemas with exit 0", () => {
  const root = mkdtempSync(join(tmpdir(), "glance-schema-cli-"));
  const output = join(root, "schemas");
  try {
    const result = Bun.spawnSync([process.execPath, SCRIPT, sourceSpec(root), output], {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    for (const [name, digest] of Object.entries(EXPECTED)) {
      expect(sha256(readFileSync(join(output, name)))).toBe(digest);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EXT-SCHEMA-CHANGED-SPEC rejects changed normative bytes without publishing", () => {
  const root = mkdtempSync(join(tmpdir(), "glance-schema-changed-"));
  const source = sourceSpec(root);
  const output = join(root, "schemas");
  try {
    writeFileSync(source, readFileSync(source, "utf8").replace('"maxLength": 60', '"maxLength": 61'), "utf8");
    expect(() => extractSchemas(source, output)).toThrow("SCHEMA_HASH");
    expect(existsSync(output)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EXT-SCHEMA-MISSING-FENCE rejects an incomplete source without publishing", () => {
  const root = mkdtempSync(join(tmpdir(), "glance-schema-missing-"));
  const source = sourceSpec(root);
  const output = join(root, "schemas");
  try {
    const text = readFileSync(source, "utf8");
    const marker = text.lastIndexOf("glance-extension-message.schema.json");
    const start = text.lastIndexOf("###", marker);
    expect(start).toBeGreaterThan(0);
    writeFileSync(source, text.slice(0, start), "utf8");
    expect(() => extractSchemas(source, output)).toThrow("SCHEMA_FENCE");
    expect(existsSync(output)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EXT-SCHEMA-OUTPUT-CONFLICT preserves existing bytes and publishes nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "glance-schema-conflict-"));
  const source = sourceSpec(root);
  const output = join(root, "schemas");
  const conflict = join(output, "glance-extension-manifest.schema.json");
  try {
    mkdirSync(output);
    writeFileSync(conflict, "conflict\n");
    expect(() => extractSchemas(source, output)).toThrow("OUTPUT_CONFLICT");
    expect(readFileSync(conflict, "utf8")).toBe("conflict\n");
    expect(Object.keys(EXPECTED).filter((name) => existsSync(join(output, name)))).toEqual([
      "glance-extension-manifest.schema.json",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const schemaDocuments = () => Object.keys(EXPECTED).map((name) =>
  JSON.parse(readFileSync(join(SCHEMA_DIRECTORY, name), "utf8")) as JsonSchema,
);

const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;
const SESSION = "1".repeat(64);
const TOKENS = {
  "surface-0": "#fff", "surface-1": "#eee", "surface-2": "#ddd",
  "text-primary": "#111", "text-secondary": "#555",
  "border-default": "#ccc", "border-focus": "#06f", accent: "#06f",
  "success-fg": "#080", "warn-fg": "#a60", "danger-fg": "#c00", "space-2": "8px",
};
const ENVELOPE = {
  schema_version: "1.0.0", extension_id: "fixture-ext", dataset_id: "snapshot",
  snapshot_id: ZERO_DIGEST, generated_at: "2026-08-22T12:00:00Z", status: "pass",
  scope: { kind: "global" }, subject: { type: "repository", id: "fixture", digest: ZERO_DIGEST },
  source: { kind: "local_file", label: "fixture", digest: ZERO_DIGEST, artifacts: [{ id: "fixture", digest: ZERO_DIGEST }] },
  freshness: { observed_at: "2026-08-22T12:00:00Z", max_age_seconds: 60, state: "fresh" },
  payload_schema: { id: "fixture.schema", version: "1.0.0", digest: ZERO_DIGEST }, evidence_refs: [],
  integrity: { algorithm: "sha256", payload_digest: ZERO_DIGEST }, payload: { value: 1 },
};
const PUBLIC_ERROR = { schema_version: "1.0.0", error: { code: "DATASET_INVALID", message: "invalid", retryable: false, correlation_id: "11111111-1111-4111-8111-111111111111" } };
const message = (type: string, payload: unknown) => ({ schema_version: "1.0.0", protocol: "glance.extension.messages", session_id: SESSION, sequence: 0, type, payload });

test("EXT-SCHEMA-REGISTRY-FIVE-NORMATIVE loads all exact Draft 2020-12 documents offline", () => {
  const registry = createSchemaRegistry(schemaDocuments());
  expect(registry.size).toBe(5);
  expect([...registry.keys()].sort()).toEqual([
    "https://schemas.nirvana-os.dev/glance/dataset-envelope/1.0.0",
    "https://schemas.nirvana-os.dev/glance/extension-catalog/1.0.0",
    "https://schemas.nirvana-os.dev/glance/extension-manifest/1.0.0",
    "https://schemas.nirvana-os.dev/glance/message/1.0.0",
    "https://schemas.nirvana-os.dev/glance/public-error/1.0.0",
  ]);
});

test("EXT-SCHEMA-ALLOF selects and validates all eight normative message payloads", () => {
  const documents = schemaDocuments();
  const registry = createSchemaRegistry(documents);
  const messageSchema = registry.get("https://schemas.nirvana-os.dev/glance/message/1.0.0")!;
  const valid = [
    message("extension.ready", { ui_version: "1.0.0", accepted_envelope_versions: ["1.0.0"] }),
    message("host.init", { extension_id: "fixture-ext", api_version: "1.0.0", locale: "pt-BR", theme: "apple", tokens: TOKENS }),
    message("host.dataset", { dataset_id: "snapshot", envelope: ENVELOPE }),
    message("host.refreshing", { dataset_id: "snapshot" }),
    message("host.error", PUBLIC_ERROR),
    message("extension.rendered", { snapshot_id: ZERO_DIGEST }),
    message("extension.error", { code: "RENDER_FAILED", message: "failed" }),
    message("extension.open_external_url", { request_id: "11111111-1111-4111-8111-111111111111", url: "https://github.com/gutomec/nirvana-os-engine", display_label: "GitHub" }),
  ];
  for (const packet of valid) expect(validateSchema(messageSchema, packet, registry)).toBe(true);
  expect(() => validateSchema(messageSchema, message("host.init", { extension_id: "fixture-ext" }), registry)).toThrow("REQUIRED");
});

test("EXT-SCHEMA-DRAFT-2020-12 rejects other dialects and unknown keywords in unused branches", () => {
  expect(() => createSchemaRegistry([{ $id: "https://schemas.nirvana-os.dev/fixture-dialect", $schema: "https://example.test/draft" } as JsonSchema])).toThrow("UNSUPPORTED_DIALECT");
  expect(() => createSchemaRegistry([{ $id: "https://schemas.nirvana-os.dev/fixture-keyword", $defs: { unused: { unsupported: true } as JsonSchema } }])).toThrow("UNSUPPORTED_KEYWORD");
});

test("EXT-SCHEMA-ONEOF-EXACTLY-ONE enforces zero, one and multiple matches", () => {
  const registry = new Map<string, JsonSchema>();
  const schema = { oneOf: [{ type: "string", minLength: 2 }, { type: "number", minimum: 2 }] } as JsonSchema;
  expect(validateSchema(schema, "ok", registry)).toBe(true);
  expect(() => validateSchema(schema, false, registry)).toThrow("ONE_OF");
  expect(() => validateSchema({ oneOf: [{ type: "number" }, { minimum: 0 }] }, 2, registry)).toThrow("ONE_OF");
});

test("EXT-SCHEMA-IF-THEN applies then only when if matches", () => {
  const registry = new Map<string, JsonSchema>();
  const schema = { if: { const: "match" }, then: { minLength: 6 } } as JsonSchema;
  expect(validateSchema(schema, "other", registry)).toBe(true);
  expect(() => validateSchema(schema, "match", registry)).toThrow("MIN_LENGTH");
});

test("EXT-SCHEMA-KEYWORD-MATRIX validates supported types, bounds and formats", () => {
  const registry = new Map<string, JsonSchema>();
  const passing: Array<[JsonSchema, unknown]> = [
    [{ type: "array", minItems: 1, maxItems: 1, uniqueItems: true, items: { type: "string" } }, ["x"]],
    [{ type: "boolean" }, true], [{ type: "integer", minimum: 1, maximum: 2 }, 2], [{ type: "null" }, null],
    [{ type: "number" }, 1.5], [{ type: "object", required: ["x"], properties: { x: { const: 1 } }, additionalProperties: false }, { x: 1 }],
    [{ type: "string", minLength: 2, maxLength: 3, pattern: "^[a-z]+$" }, "abc"],
    [{ type: "string", format: "uuid" }, "11111111-1111-4111-8111-111111111111"],
    [{ type: "string", format: "date-time" }, "2026-08-22T12:00:00Z"],
    [{ type: "string", format: "uri" }, "https://example.test/path"],
    [{ enum: ["x"] }, "x"],
  ];
  for (const [schema, value] of passing) expect(validateSchema(schema, value, registry)).toBe(true);
  const failing: Array<[JsonSchema, unknown, string]> = [
    [{ type: "array", minItems: 2 }, [1], "MIN_ITEMS"], [{ type: "array", maxItems: 1 }, [1, 2], "MAX_ITEMS"],
    [{ type: "array", uniqueItems: true }, [1, 1], "UNIQUE_ITEMS"], [{ type: "boolean" }, 1, "TYPE:boolean"],
    [{ type: "integer" }, 1.5, "TYPE:integer"], [{ type: "null" }, false, "TYPE:null"], [{ type: "number" }, "1", "TYPE:number"],
    [{ type: "object" }, [], "TYPE:object"], [{ type: "string" }, 1, "TYPE:string"], [{ type: "number", minimum: 2 }, 1, "MINIMUM"],
    [{ type: "number", maximum: 1 }, 2, "MAXIMUM"], [{ type: "string", minLength: 2 }, "x", "MIN_LENGTH"],
    [{ type: "string", maxLength: 1 }, "xx", "MAX_LENGTH"], [{ type: "string", pattern: "^x$" }, "y", "PATTERN"],
    [{ type: "string", format: "uuid" }, "bad", "FORMAT:uuid"], [{ type: "string", format: "date-time" }, "bad", "FORMAT:date-time"],
    [{ type: "string", format: "uri" }, "not a uri", "FORMAT:uri"], [{ const: "x" }, "y", "CONST"], [{ enum: ["x"] }, "y", "ENUM"],
    [{ type: "object", required: ["x"] }, {}, "REQUIRED:x"], [{ type: "object", properties: {}, additionalProperties: false }, { x: 1 }, "ADDITIONAL_PROPERTY:x"],
  ];
  for (const [schema, value, error] of failing) expect(() => validateSchema(schema, value, registry)).toThrow(error);
});

test("EXT-SCHEMA-REF-POLICY resolves local and registered refs but forbids network-shaped refs", () => {
  const document = { $id: "https://schemas.nirvana-os.dev/fixture", $defs: { value: { const: "ok" } }, $ref: "#/$defs/value" } as JsonSchema;
  const registry = createSchemaRegistry([document]);
  expect(validateSchema(document, "ok", registry)).toBe(true);
  expect(() => validateSchema({ $ref: "https://example.test/schema" }, {}, registry)).toThrow("REMOTE_REF_FORBIDDEN");
  expect(() => validateSchema({ $ref: "https://schemas.nirvana-os.dev/missing" }, {}, registry)).toThrow("UNKNOWN_REF");
});

test("EXT-SCHEMA-CODEPOINT-LENGTH counts Unicode scalar values", () => {
  const registry = new Map<string, JsonSchema>();
  expect(validateSchema({ type: "string", maxLength: 1 }, "😀", registry)).toBe(true);
  expect(() => validateSchema({ type: "string", maxLength: 1 }, "😀x", registry)).toThrow("MAX_LENGTH");
});

test("EXT-SCHEMA-UNIQUE-SEMANTIC rejects objects that differ only by key order", () => {
  const registry = new Map<string, JsonSchema>();
  expect(() => validateSchema(
    { type: "array", uniqueItems: true },
    [{ a: 1, b: 2 }, { b: 2, a: 1 }],
    registry,
  )).toThrow("UNIQUE_ITEMS");
  expect(() => validateSchema({ type: "array", uniqueItems: true }, [0, -0], registry)).toThrow("UNIQUE_ITEMS");
  expect(validateSchema({ const: 0 }, -0, registry)).toBe(true);
});

test("EXT-SCHEMA-FORMAT-DATETIME rejects invalid calendar values and missing timezone", () => {
  const registry = new Map<string, JsonSchema>();
  const schema = { type: "string", format: "date-time" } as const;
  expect(validateSchema(schema, "2024-02-29T12:00:00Z", registry)).toBe(true);
  expect(validateSchema(schema, "2024-02-29t12:00:00z", registry)).toBe(true);
  expect(validateSchema(schema, "2016-12-31T23:59:60Z", registry)).toBe(true);
  expect(() => validateSchema(schema, "2026-02-30T12:00:00Z", registry)).toThrow("FORMAT:date-time");
  expect(() => validateSchema(schema, "2026-08-22T12:00:00", registry)).toThrow("FORMAT:date-time");
});

test("EXT-SCHEMA-REF-SIBLING evaluates Draft 2020-12 sibling keywords", () => {
  const root = {
    $id: "https://schemas.nirvana-os.dev/ref-sibling",
    $defs: { value: { type: "string" } },
    $ref: "#/$defs/value",
    minLength: 2,
  } as JsonSchema;
  const registry = createSchemaRegistry([root]);
  expect(() => validateSchema(root, "x", registry)).toThrow("MIN_LENGTH");
  expect(validateSchema(root, "ok", registry)).toBe(true);
});

test("EXT-SCHEMA-REGISTRY-REFS rejects unused remote and unknown references offline", () => {
  expect(() => createSchemaRegistry([{
    $id: "https://schemas.nirvana-os.dev/unused-remote",
    $defs: { unused: { $ref: "https://example.test/schema" } },
  }])).toThrow("REMOTE_REF_FORBIDDEN");
  expect(() => createSchemaRegistry([{
    $id: "https://schemas.nirvana-os.dev/unused-unknown",
    $defs: { unused: { $ref: "https://schemas.nirvana-os.dev/missing" } },
  }])).toThrow("UNKNOWN_REF");
  expect(() => createSchemaRegistry([{ $id: "relative-id" }])).toThrow("SCHEMA_ID");
});

test("EXT-SCHEMA-EXTRACT-EXIT-CODES distinguish source rejection from I/O failure", () => {
  const root = mkdtempSync(join(tmpdir(), "glance-schema-exits-"));
  try {
    const source = sourceSpec(root);
    writeFileSync(source, readFileSync(source, "utf8").replace('"maxLength": 60', '"maxLength": 61'), "utf8");
    const rejected = Bun.spawnSync([process.execPath, SCRIPT, source, join(root, "rejected")], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
    expect(rejected.exitCode).toBe(3);
    expect(rejected.stderr.toString()).toContain("SCHEMA_HASH");

    const valid = sourceSpec(join(root, "valid-source"));
    const blocker = join(root, "not-a-directory");
    writeFileSync(blocker, "blocker\n", "utf8");
    const io = Bun.spawnSync([process.execPath, SCRIPT, valid, join(blocker, "schemas")], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
    expect(io.exitCode).toBe(6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
