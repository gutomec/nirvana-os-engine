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

function canonicalize(value: unknown): string {
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
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => {
      assertUnicodeScalarString(key);
      return `${JSON.stringify(key)}:${canonicalize(record[key])}`;
    }).join(",")}}`;
  }
  throw new TypeError("JCS_UNSUPPORTED_TYPE");
}

export function canonicalizeJson(value: unknown): string {
  return canonicalize(value);
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
