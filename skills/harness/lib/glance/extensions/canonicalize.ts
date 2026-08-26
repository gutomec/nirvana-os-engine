import { createHash } from "node:crypto";
import type { Digest } from "./types.ts";

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) throw new TypeError("LONE_SURROGATE");
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("LONE_SURROGATE");
    }
  }
}

const unsupported = (): never => { throw new TypeError("JCS_UNSUPPORTED_TYPE"); };

function assertDataProperty(target: object, key: PropertyKey): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) unsupported();
  return descriptor;
}

function canonicalize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("NONFINITE");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || seen.has(value)) unsupported();
    seen.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)))) unsupported();
    if (keys.length !== value.length + 1) unsupported();
    const items: string[] = [];
    for (let index = 0; index < value.length; index++) {
      const key = String(index);
      const descriptor = assertDataProperty(value, key);
      items.push(canonicalize(descriptor.value, seen));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if ((prototype !== Object.prototype && prototype !== null) || seen.has(value)) unsupported();
    seen.add(value);
    const record = value as Record<string, unknown>;
    const ownKeys = Reflect.ownKeys(record);
    if (ownKeys.some((key) => typeof key !== "string")) unsupported();
    const keys = ownKeys as string[];
    for (const key of keys) assertDataProperty(record, key);
    keys.sort();
    return `{${keys.map((key) => {
      assertUnicodeScalarString(key);
      return `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`;
    }).join(",")}}`;
  }
  unsupported();
}

export function canonicalizeJson(value: unknown): string {
  return canonicalize(value, new WeakSet<object>());
}

export function digestRawBytes(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function digestCanonicalJson(value: unknown): Digest {
  return digestRawBytes(new TextEncoder().encode(canonicalizeJson(value)));
}

export const digestManifest = digestCanonicalJson;
export const digestPayload = digestCanonicalJson;
export const digestPayloadSchema = digestCanonicalJson;

export function digestSource(source: {
  kind: unknown;
  label: unknown;
  artifacts: unknown;
}): Digest {
  return digestCanonicalJson({ kind: source.kind, label: source.label, artifacts: source.artifacts });
}

export function digestSnapshot(envelope: Record<string, unknown>): Digest {
  const projection = { ...envelope };
  delete projection.snapshot_id;
  return digestCanonicalJson(projection);
}

export function digestNormalizedRealpath(path: string): Digest {
  const normalized = process.platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path;
  return digestRawBytes(new TextEncoder().encode(normalized));
}
