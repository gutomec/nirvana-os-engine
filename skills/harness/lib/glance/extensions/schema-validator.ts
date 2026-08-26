import { isRfc3339DateTime } from "./rfc3339.ts";

export interface JsonSchema {
  $schema?: "https://json-schema.org/draft/2020-12/schema";
  $id?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  const?: unknown;
  enum?: unknown[];
  allOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  if?: JsonSchema;
  then?: JsonSchema;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: "uuid" | "date-time" | "uri";
  minimum?: number;
  maximum?: number;
}

const KEYS = new Set([
  "$schema", "$id", "$ref", "$defs", "type", "const", "enum", "allOf", "oneOf", "if", "then",
  "required", "properties", "additionalProperties", "items", "minItems", "maxItems", "uniqueItems",
  "minLength", "maxLength", "pattern", "format", "minimum", "maximum",
]);

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((item, index) => equal(item, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
      key === rightKeys[index] && equal(leftRecord[key], rightRecord[key]));
  }
  return false;
}

export function validateSchema(
  schema: JsonSchema | boolean,
  value: unknown,
  registry: ReadonlyMap<string, JsonSchema>,
  root: JsonSchema | boolean = schema,
): true {
  if (schema === true) return true;
  if (schema === false) throw new Error("FALSE_SCHEMA");
  if (root === false) throw new Error("FALSE_SCHEMA");
  if (root === true) root = schema;

  for (const key of Object.keys(schema)) {
    if (!KEYS.has(key)) throw new Error(`UNSUPPORTED_KEYWORD:${key}`);
  }
  if (schema.$schema && schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    throw new Error("UNSUPPORTED_DIALECT");
  }
  if (schema.$ref) {
    if (schema.$ref.startsWith("#/$defs/")) {
      const target = root.$defs?.[schema.$ref.slice(8)];
      if (!target) throw new Error("UNKNOWN_LOCAL_REF");
      validateSchema(target, value, registry, root);
    } else {
      if (!schema.$ref.startsWith("https://schemas.nirvana-os.dev/")) throw new Error("REMOTE_REF_FORBIDDEN");
      const target = registry.get(schema.$ref);
      if (!target) throw new Error("UNKNOWN_REF");
      validateSchema(target, value, registry, target);
    }
  }

  if (schema.const !== undefined && !equal(schema.const, value)) throw new Error("CONST");
  if (schema.enum && !schema.enum.some((item) => equal(item, value))) throw new Error("ENUM");
  for (const candidate of schema.allOf ?? []) validateSchema(candidate, value, registry, root);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => {
      try { validateSchema(candidate, value, registry, root); return true; } catch { return false; }
    }).length;
    if (matches !== 1) throw new Error("ONE_OF");
  }
  if (schema.if) {
    let matches = false;
    try { validateSchema(schema.if, value, registry, root); matches = true; } catch {}
    if (matches && schema.then) validateSchema(schema.then, value, registry, root);
  }

  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (schema.type && !(schema.type === "integer" ? Number.isInteger(value) : actual === schema.type)) {
    throw new Error(`TYPE:${schema.type}`);
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) throw new Error("MIN_LENGTH");
    if (schema.maxLength !== undefined && length > schema.maxLength) throw new Error("MAX_LENGTH");
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error("PATTERN");
    if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error("FORMAT:uuid");
    if (schema.format === "date-time" && !isRfc3339DateTime(value)) throw new Error("FORMAT:date-time");
    if (schema.format === "uri") {
      try { if (!new URL(value).protocol) throw new Error(); } catch { throw new Error("FORMAT:uri"); }
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error("MINIMUM");
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error("MAXIMUM");
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error("MIN_ITEMS");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error("MAX_ITEMS");
    if (schema.uniqueItems && value.some((item, index) => value.slice(0, index).some((prior) => equal(item, prior)))) {
      throw new Error("UNIQUE_ITEMS");
    }
    if (schema.items) for (const item of value) validateSchema(schema.items, item, registry, root);
  }
  if (value && actual === "object") {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) throw new Error(`REQUIRED:${key}`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) if (!schema.properties?.[key]) throw new Error(`ADDITIONAL_PROPERTY:${key}`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in object) validateSchema(child, object[key], registry, root);
    }
  }
  return true;
}

export function createSchemaRegistry(documents: readonly JsonSchema[]): ReadonlyMap<string, JsonSchema> {
  const registry = new Map<string, JsonSchema>();
  const walk = (schema: JsonSchema | boolean, root: JsonSchema, validateRefs: boolean): void => {
    if (typeof schema === "boolean") return;
    for (const key of Object.keys(schema)) if (!KEYS.has(key)) throw new Error(`UNSUPPORTED_KEYWORD:${key}`);
    if (schema.$schema && schema.$schema !== "https://json-schema.org/draft/2020-12/schema") throw new Error("UNSUPPORTED_DIALECT");
    if (validateRefs && schema.$ref) {
      if (schema.$ref.startsWith("#/$defs/")) {
        if (!root.$defs?.[schema.$ref.slice(8)]) throw new Error("UNKNOWN_LOCAL_REF");
      } else {
        if (!schema.$ref.startsWith("https://schemas.nirvana-os.dev/")) throw new Error("REMOTE_REF_FORBIDDEN");
        if (!registry.has(schema.$ref)) throw new Error("UNKNOWN_REF");
      }
    }
    for (const child of Object.values(schema.$defs ?? {})) walk(child, root, validateRefs);
    for (const child of Object.values(schema.properties ?? {})) walk(child, root, validateRefs);
    for (const child of schema.allOf ?? []) walk(child, root, validateRefs);
    for (const child of schema.oneOf ?? []) walk(child, root, validateRefs);
    if (schema.if) walk(schema.if, root, validateRefs);
    if (schema.then) walk(schema.then, root, validateRefs);
    if (schema.items) walk(schema.items, root, validateRefs);
  };
  for (const document of documents) {
    if (!document.$id || !document.$id.startsWith("https://schemas.nirvana-os.dev/") || registry.has(document.$id)) {
      throw new Error("SCHEMA_ID");
    }
    walk(document, document, false);
    registry.set(document.$id, document);
  }
  for (const document of documents) walk(document, document, true);
  return registry;
}
