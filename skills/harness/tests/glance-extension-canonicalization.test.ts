import { expect, test } from "bun:test";
import {
  canonicalizeJson,
  digestCanonicalJson,
  digestManifest,
  digestPayload,
  digestPayloadSchema,
  digestRawBytes,
  digestNormalizedRealpath,
  digestSnapshot,
  digestSource,
} from "../lib/glance/extensions/canonicalize.ts";
import { parseStrictJson } from "../lib/glance/extensions/strict-json.ts";

const encode = (value: string) => new TextEncoder().encode(value);

test("EXT-PARSER-INVALID-UTF8", () => {
  let observed: unknown;
  try {
    parseStrictJson(Uint8Array.of(0xc3, 0x28));
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(SyntaxError);
  expect((observed as Error).message).toBe("UTF-8");
});

const STRICT_CASES = [
  ["EXT-PARSER-BOM", Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d), "BOM"],
  ["EXT-PARSER-CRLF", encode("{\r\n}\n"), "LF_ONLY"],
  ["EXT-PARSER-DUP-ROOT", encode('{"a":1,"a":2}\n'), "DUPLICATE_KEY"],
  ["EXT-PARSER-DUP-NESTED", encode('{"a":{"b":1,"b":2}}\n'), "DUPLICATE_KEY"],
  ["EXT-PARSER-DUP-ESCAPED", encode('{"a":1,"\\u0061":2}\n'), "DUPLICATE_KEY"],
  ["EXT-PARSER-TRAILING", encode("{} x\n"), "TRAILING"],
  ["EXT-PARSER-LEADING-ZERO", encode("01\n"), "LEADING_ZERO"],
  ["EXT-PARSER-NONFINITE", encode("NaN\n"), "NONFINITE"],
  ["EXT-PARSER-NONFINITE-EXPONENT", encode("1e400\n"), "NONFINITE"],
  ["EXT-PARSER-LONE-SURROGATE", encode('"\\ud800"\n'), "LONE_SURROGATE"],
  ["EXT-PARSER-DEPTH-65", encode(`${"[".repeat(65)}0${"]".repeat(65)}\n`), "DEPTH"],
] as const;

test.each(STRICT_CASES)("%s", (_id, bytes, error) => {
  expect(() => parseStrictJson(bytes)).toThrow(error);
});

test("EXT-PARSER-VALID-DEPTH-64", () => {
  const value = parseStrictJson(encode(`${"[".repeat(64)}0${"]".repeat(64)}\n`));
  expect(value).toBeDefined();
});

const JCS_CASES = [
  ["scalar", 42, "42"],
  ["escaping", { text: "€$\u000f\nA'B\"\\/" }, '{"text":"€$\\u000f\\nA\'B\\\"\\\\/"}'],
  ["nested-sorting", { z: [{ y: 1, a: true }], a: null }, '{"a":null,"z":[{"a":true,"y":1}]}'],
  ["utf16-key-order", { "\u20ac": 1, "\r": 2, "\ufb33": 3, "1": 4, "😀": 5, "\u0080": 6, "ö": 7 }, '{"\\r":2,"1":4,"":6,"ö":7,"€":1,"😀":5,"דּ":3}'],
  ["exponent-threshold", [1e-7, 1e-6, 1e20, 1e21], "[1e-7,0.000001,100000000000000000000,1e+21]"],
  ["negative-zero", -0, "0"],
] as const;

test.each(JCS_CASES)("EXT-JCS-%s", (_id, value, expected) => {
  expect(canonicalizeJson(value)).toBe(expected);
});

test("EXT-DIGEST-RAW-AND-CANONICAL", () => {
  expect(digestCanonicalJson({ records: [] })).toBe(
    "sha256:1b8b4c0b6f6ad1d32565952720bc004eeb1f188f62045e4d5525ae2af8c78432",
  );
  expect(digestRawBytes(encode("{}\n"))).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(digestRawBytes(encode("{}\n"))).not.toBe(digestRawBytes(encode("{}")));
  expect(canonicalizeJson(parseStrictJson(encode('{"b":1,"a":2}\n')))).toBe('{"a":2,"b":1}');
  if (process.platform === "win32") {
    expect(digestNormalizedRealpath("C:\\Users\\Architect\\Project")).toBe("sha256:e7806e900346c474a95fc78ac413499cc9eadb3412f9c257f2108f269090033c");
  } else {
    expect(digestNormalizedRealpath("/srv/nirvana/project")).toBe("sha256:17007fc5e15efcaf675b5d284b59c6610a4708d789091d44c2fcfcf72a06dfb7");
  }
});

test("EXT-JCS-REJECTS-NON-JSON-VALUES", () => {
  expect(() => canonicalizeJson(Number.POSITIVE_INFINITY)).toThrow("NONFINITE");
  expect(() => canonicalizeJson(undefined)).toThrow("JCS_UNSUPPORTED_TYPE");
  expect(() => canonicalizeJson("\ud800")).toThrow("LONE_SURROGATE");
});

const PAYLOAD = {
  records: [{ number: 59, state: "open" }, { number: 60, state: "open" }],
  status: "ready",
};
const PAYLOAD_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.nirvana-os.dev/glance/fixtures/pr-governance-payload/1.0.0",
  type: "object", additionalProperties: false, required: ["records"],
  properties: {
    records: { type: "array", items: { type: "object", additionalProperties: false, required: ["number", "state"], properties: { number: { type: "integer", minimum: 1 }, state: { enum: ["open", "closed", "merged"] } } } },
    status: { const: "ready" },
  },
};
const SOURCE = {
  kind: "local_file", label: "fixture-source",
  artifacts: [
    { id: "audit", digest: `sha256:${"a".repeat(64)}` },
    { id: "registry", digest: `sha256:${"b".repeat(64)}` },
  ],
};
const ENVELOPE_WITHOUT_SNAPSHOT = {
  schema_version: "1.0.0", extension_id: "fixture-complete", dataset_id: "pr-governance",
  generated_at: "2026-08-22T12:00:00Z", status: "pass", scope: { kind: "global" },
  subject: { type: "repository", id: "gutomec/nirvana-os-engine", digest: `sha256:${"c".repeat(64)}` },
  source: { ...SOURCE, digest: "sha256:7d468aa674db16f73e0b27137b739efdcdbf4a48213dc1f5d0bc44fad31b15f2" },
  freshness: { observed_at: "2026-08-22T12:00:00Z", max_age_seconds: 3600, state: "fresh" },
  payload_schema: { id: PAYLOAD_SCHEMA.$id, version: "1.0.0", digest: "sha256:72389dbaa4072b0b6dcb43d5ad80c00c3d7c1fac0e294e5aca2c0e59bf685bac" },
  evidence_refs: [{ id: "spec", kind: "file", ref: "especificacao-glance-extension-api-servico-e-dashboard-governanca.md", digest: `sha256:${"e".repeat(64)}` }],
  integrity: { algorithm: "sha256", payload_digest: "sha256:ca19a1bad8553e14f5c98258e7055259ee1a59c92f08df8128239a6afb8e45f7" },
  payload: PAYLOAD,
};
const MANIFEST = {
  schema_version: "1.0.0", id: "fixture-complete", version: "1.0.0",
  display: { title: "Governança de PRs", description: "Fixture completa e válida do painel de governança.", icon: "git-pull-request", order: 200 },
  compatibility: { minimum: "0.7.2", maximum_tested: "0.7.2" },
  ui: { entrypoint: "ui/index.html", sandbox: "allow-scripts", theme_contract: "glance.ui.tokens.v1" },
  datasets: [{ id: "pr-governance", path: "data/pr-governance.snapshot.json", envelope_schema: "https://schemas.nirvana-os.dev/glance/dataset-envelope/1.0.0", payload_schema: { id: PAYLOAD_SCHEMA.$id, version: "1.0.0", digest: "sha256:72389dbaa4072b0b6dcb43d5ad80c00c3d7c1fac0e294e5aca2c0e59bf685bac" }, max_bytes: 4096, refresh: "on-request" }],
  files: [{ path: "ui/index.html", mime: "text/html; charset=utf-8", bytes: 69, sha256: "b8e07b641f6b11a4e7d88fd1187b0ad7a59c8d4e7bfaa0669bf891470cb137d4" }],
  capabilities: ["read_snapshot"],
  provenance: { publisher_id: "spec-fixture", build_id: "complete-1", built_at: "2026-08-22T12:00:00Z", source_ref: "fixtures/complete-valid" },
  external_navigation: { mode: "host-mediated", allowed_hosts: ["github.com"] },
};

test("EXT-DIGEST-NORMATIVE-VECTORS", () => {
  expect(digestPayload(PAYLOAD)).toBe("sha256:ca19a1bad8553e14f5c98258e7055259ee1a59c92f08df8128239a6afb8e45f7");
  expect(digestPayloadSchema(PAYLOAD_SCHEMA)).toBe("sha256:72389dbaa4072b0b6dcb43d5ad80c00c3d7c1fac0e294e5aca2c0e59bf685bac");
  expect(digestSource(SOURCE)).toBe("sha256:7d468aa674db16f73e0b27137b739efdcdbf4a48213dc1f5d0bc44fad31b15f2");
  expect(digestSnapshot(ENVELOPE_WITHOUT_SNAPSHOT)).toBe("sha256:a01db189c033abf342fb23a5d90f826a0d33e0de102c8726b9d7b039ec586244");
  expect(digestManifest(MANIFEST)).toBe("sha256:d30610177d3bc67d6ceac2c635fad078e06d0eb29044e447b031364b3803dbb7");
});
