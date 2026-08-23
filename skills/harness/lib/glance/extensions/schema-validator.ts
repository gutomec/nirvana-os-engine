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

function isDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59) {
    return false;
  }
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  if (second === 60) {
    const offsetSign = zone.startsWith("+") ? 1 : zone.startsWith("-") ? -1 : 0;
    const offsetMinutes = offsetSign * ((offsetHour * 60) + offsetMinute);
    const instant = new Date(0);
    instant.setUTCFullYear(year, month - 1, day);
    instant.setUTCHours(hour, minute, 59, 0);
    instant.setTime(instant.getTime() - (offsetMinutes * 60_000));
    const isLeapBoundary = (instant.getUTCMonth() === 5 && instant.getUTCDate() === 30) ||
      (instant.getUTCMonth() === 11 && instant.getUTCDate() === 31);
    if (!isLeapBoundary || instant.getUTCHours() !== 23 || instant.getUTCMinutes() !== 59) return false;
  }
  return true;
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
    if (schema.format === "date-time" && !isDateTime(value)) throw new Error("FORMAT:date-time");
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
