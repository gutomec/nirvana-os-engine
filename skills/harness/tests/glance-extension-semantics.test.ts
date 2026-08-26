import { expect, test } from "bun:test";
import {
  digestPayload,
  digestSnapshot,
  digestSource,
} from "../lib/glance/extensions/canonicalize.ts";
import {
  validateEnvelopeSemantics,
  validateManifestSemantics,
  type EnvelopeSemanticContext,
} from "../lib/glance/extensions/semantic-validator.ts";
import type {
  GlanceExtensionDatasetEnvelopeV1,
  GlanceExtensionManifestV1,
} from "../lib/glance/extensions/types.ts";

export const SEMANTIC_CASES = {
  manifest: ["EXT-COMPAT-RANGE", "EXT-ENTRYPOINT", "EXT-MANIFEST-DATASET-LIMIT", "EXT-DATASET-ID-DUP", "EXT-FILE-PATH-DUP", "EXT-RESERVED-ID", "EXT-INVENTORY-BYTES-LIMIT", "EXT-URL-MANIFEST-HOST"],
  envelope: ["EXT-PAYLOAD-DIGEST", "EXT-PAYLOAD-SCHEMA-DIGEST", "EXT-SOURCE-DIGEST", "EXT-SNAPSHOT-DIGEST", "EXT-PROJECT-DIGEST", "EXT-SCOPE-MISMATCH", "EXT-TIMEZONE-GENERATED", "EXT-TIMEZONE-OBSERVED", "EXT-TIMESTAMP-ORDER", "EXT-EVIDENCE-LIMIT", "EXT-ARTIFACT-DUP", "EXT-ARTIFACT-ORDER", "EXT-FRESHNESS-RECALCULATED", "EXT-EXPIRED-PASS", "EXT-UNKNOWN-PASS"],
  jcs: ["scalar", "escaping", "nested-sorting", "utf16-key-order", "exponent-threshold", "negative-zero"],
} as const;

const ZERO = `sha256:${"0".repeat(64)}` as const;
const PROJECT = `sha256:${"1".repeat(64)}` as const;
const OTHER_PROJECT = `sha256:${"2".repeat(64)}` as const;
const NOW = new Date("2026-08-22T12:30:00Z");

function manifest(): GlanceExtensionManifestV1 {
  return {
    schema_version: "1.0.0", id: "fixture-ext", version: "1.0.0",
    display: { title: "Fixture", description: "Fixture extension", icon: "activity", order: 200 },
    compatibility: { minimum: "1.0.0", maximum_tested: "1.0.0" },
    ui: { entrypoint: "ui/index.html", sandbox: "allow-scripts", theme_contract: "glance.ui.tokens.v1" },
    datasets: [{
      id: "snapshot", path: "data/snapshot.snapshot.json",
      envelope_schema: "https://schemas.nirvana-os.dev/glance/dataset-envelope/1.0.0",
      payload_schema: { id: "fixture.payload", version: "1.0.0", digest: ZERO },
      max_bytes: 4096, refresh: "on-request",
    }],
    files: [{ path: "ui/index.html", mime: "text/html; charset=utf-8", bytes: 69, sha256: "a".repeat(64) }],
    capabilities: ["read_snapshot"],
    provenance: { publisher_id: "fixture", build_id: "build-1", built_at: "2026-08-22T12:00:00Z", source_ref: "fixture" },
    external_navigation: { mode: "host-mediated", allowed_hosts: ["github.com"] },
  } as GlanceExtensionManifestV1;
}

function envelope(): GlanceExtensionDatasetEnvelopeV1 {
  const value = {
    schema_version: "1.0.0", extension_id: "fixture-ext", dataset_id: "snapshot",
    generated_at: "2026-08-22T12:05:00Z", status: "pass", scope: { kind: "global" },
    subject: { type: "repository", id: "fixture", digest: ZERO },
    source: {
      kind: "local_file", label: "fixture", digest: ZERO,
      artifacts: [{ id: "audit", digest: ZERO }, { id: "registry", digest: ZERO }],
    },
    freshness: { observed_at: "2026-08-22T12:00:00Z", max_age_seconds: 3600, state: "fresh" },
    payload_schema: { id: "fixture.payload", version: "1.0.0", digest: ZERO },
    evidence_refs: [{ id: "spec", kind: "file", ref: "spec.md", digest: ZERO }],
    integrity: { algorithm: "sha256", payload_digest: ZERO }, payload: { records: [] },
  } as unknown as GlanceExtensionDatasetEnvelopeV1;
  value.source.digest = digestSource(value.source);
  value.integrity.payload_digest = digestPayload(value.payload);
  value.snapshot_id = digestSnapshot(value as unknown as Record<string, unknown>);
  return value;
}

const context = (overrides: Partial<EnvelopeSemanticContext> = {}): EnvelopeSemanticContext => ({
  manifest: manifest(), scope: "global", now: NOW, ...overrides,
});

function resnapshot(value: GlanceExtensionDatasetEnvelopeV1): void {
  value.snapshot_id = digestSnapshot(value as unknown as Record<string, unknown>);
}

const MANIFEST_MUTATIONS: Record<(typeof SEMANTIC_CASES.manifest)[number], (value: GlanceExtensionManifestV1) => void> = {
  "EXT-COMPAT-RANGE": (value) => { value.compatibility.minimum = "2.0.0"; },
  "EXT-ENTRYPOINT": (value) => { (value.ui as { entrypoint: string }).entrypoint = "ui/other.html"; },
  "EXT-MANIFEST-DATASET-LIMIT": (value) => { value.datasets = []; },
  "EXT-DATASET-ID-DUP": (value) => { value.datasets.push({ ...structuredClone(value.datasets[0]), id: "SNAPSHOT" }); },
  "EXT-FILE-PATH-DUP": (value) => { (value.files as unknown as Array<GlanceExtensionManifestV1["files"][0]>).push(structuredClone(value.files[0])); },
  "EXT-RESERVED-ID": (value) => { value.id = "agents"; },
  "EXT-INVENTORY-BYTES-LIMIT": (value) => { value.files[0].bytes = 16_777_217; },
  "EXT-URL-MANIFEST-HOST": (value) => { value.external_navigation.allowed_hosts = ["evil.example"]; },
};

test("EXT-SEMANTIC-MANIFEST-VALID", () => {
  expect(validateManifestSemantics(manifest(), "1.0.0")).toBe(true);
});

test.each(SEMANTIC_CASES.manifest)("%s", (code) => {
  const value = manifest();
  MANIFEST_MUTATIONS[code](value);
  expect(() => validateManifestSemantics(value, "1.0.0")).toThrow(code);
});

test("EXT-DATASET-PATH binds each dataset id to its v1 snapshot path", () => {
  const value = manifest();
  value.datasets[0].path = "data/other.snapshot.json";
  expect(() => validateManifestSemantics(value, "1.0.0")).toThrow("EXT-DATASET-PATH");
});

test("EXT-SEMVER-RANGE applies prerelease precedence", () => {
  const value = manifest();
  value.compatibility.minimum = "1.0.0-alpha";
  value.compatibility.maximum_tested = "1.0.0";
  expect(validateManifestSemantics(value, "1.0.0-beta")).toBe(true);
  expect(() => validateManifestSemantics(value, "1.0.1-alpha")).toThrow("EXT-COMPAT-RANGE");
});

test("EXT-SEMANTIC-ENVELOPE-VALID", () => {
  expect(validateEnvelopeSemantics(envelope(), context())).toBe(true);
});

test("EXT-PAYLOAD-DIGEST", () => {
  const value = envelope(); value.integrity.payload_digest = ZERO;
  expect(() => validateEnvelopeSemantics(value, context())).toThrow("EXT-PAYLOAD-DIGEST");
});

test("EXT-PAYLOAD-SCHEMA-DIGEST", () => {
  const value = envelope(); value.payload_schema.digest = `sha256:${"f".repeat(64)}`;
  expect(() => validateEnvelopeSemantics(value, context())).toThrow("EXT-PAYLOAD-SCHEMA-DIGEST");
});

test("EXT-SOURCE-DIGEST", () => {
  const value = envelope(); value.source.digest = ZERO;
  expect(() => validateEnvelopeSemantics(value, context())).toThrow("EXT-SOURCE-DIGEST");
});

test("EXT-SNAPSHOT-DIGEST", () => {
  const value = envelope(); value.snapshot_id = ZERO;
  expect(() => validateEnvelopeSemantics(value, context())).toThrow("EXT-SNAPSHOT-DIGEST");
});

test("EXT-PROJECT-DIGEST", () => {
  const value = envelope(); value.scope = { kind: "project", project_root_digest: OTHER_PROJECT }; resnapshot(value);
  expect(() => validateEnvelopeSemantics(value, context({ scope: "project", projectRootDigest: PROJECT }))).toThrow("EXT-PROJECT-DIGEST");
});

test("EXT-SCOPE-MISMATCH", () => {
  expect(() => validateEnvelopeSemantics(envelope(), context({ scope: "project", projectRootDigest: PROJECT }))).toThrow("EXT-SCOPE-MISMATCH");
});

test("EXT-TIMEZONE-GENERATED", () => {
  const value = envelope(); value.generated_at = "2026-08-22T12:05:00";
  expect(() => validateEnvelopeSemantics(value, context())).toThrow("EXT-TIMEZONE-GENERATED");
});

test("EXT-TIMEZONE-OBSERVED", () => {
  const value = envelope(); value.freshness.observed_at = "2026-08-22T12:00:00";
  expect(() => validateEnvelopeSemantics(value, context())).toThrow("EXT-TIMEZONE-OBSERVED");
});

test("EXT-TIMESTAMP-ORDER", () => {
  const value = envelope(); value.generated_at = "2026-08-22T11:59:59Z";
  expect(() => validateEnvelopeSemantics(value, context())).toThrow("EXT-TIMESTAMP-ORDER");
});

test("EXT-TIMESTAMP-LEAP-SECOND orders a valid generated leap second after its observation", () => {
  const value = envelope();
  value.freshness.observed_at = "2016-12-31T23:59:59Z";
  value.generated_at = "2016-12-31T23:59:60Z";
  value.freshness.max_age_seconds = 1;
  value.freshness.state = "fresh";
  resnapshot(value);
  expect(validateEnvelopeSemantics(value, context({ now: new Date("2017-01-01T00:00:00Z") }))).toBe(true);
});

test("EXT-FRESHNESS-LEAP-SECOND recalculates freshness from a valid observed leap second", () => {
  const value = envelope();
  value.freshness.observed_at = "2016-12-31T23:59:60Z";
  value.generated_at = "2017-01-01T00:00:00Z";
  value.freshness.max_age_seconds = 0;
  value.freshness.state = "fresh";
  resnapshot(value);
  expect(validateEnvelopeSemantics(value, context({ now: new Date("2017-01-01T00:00:00Z") }))).toBe(true);
});

test("EXT-TIMESTAMP-LEAP-OFFSET treats equivalent leap-second offsets as the same instant", () => {
  const value = envelope();
  value.freshness.observed_at = "2016-12-31T23:59:60Z";
  value.generated_at = "2017-01-01T00:59:60+01:00";
  value.freshness.max_age_seconds = 0;
  value.freshness.state = "fresh";
  resnapshot(value);
  expect(validateEnvelopeSemantics(value, context({ now: new Date("2017-01-01T00:00:00Z") }))).toBe(true);
});

test("EXT-EVIDENCE-LIMIT", () => {
  const value = envelope();
  value.evidence_refs = Array.from({ length: 129 }, (_, id) => ({ id: `evidence-${id}`, kind: "file", ref: `${id}.txt`, digest: ZERO }));
  expect(() => validateEnvelopeSemantics(value, context())).toThrow("EXT-EVIDENCE-LIMIT");
});

test("EXT-EVIDENCE-LIMIT rejects duplicate evidence ids case-insensitively", () => {
  const value = envelope();
  value.evidence_refs.push({ id: "SPEC", kind: "file", ref: "other.md", digest: ZERO });
  expect(() => validateEnvelopeSemantics(value, context())).toThrow("EXT-EVIDENCE-LIMIT");
});

test("EXT-ARTIFACT-DUP", () => {
  const value = envelope(); value.source.artifacts[1].id = "audit";
  expect(() => validateEnvelopeSemantics(value, context())).toThrow("EXT-ARTIFACT-DUP");
});

test("EXT-ARTIFACT-ORDER", () => {
  const value = envelope(); value.source.artifacts.reverse();
  expect(() => validateEnvelopeSemantics(value, context())).toThrow("EXT-ARTIFACT-ORDER");
});

test("EXT-FRESHNESS-RECALCULATED", () => {
  const value = envelope(); value.freshness.state = "stale";
  expect(() => validateEnvelopeSemantics(value, context())).toThrow("EXT-FRESHNESS-RECALCULATED");
});

test("EXT-EXPIRED-PASS", () => {
  const value = envelope(); value.freshness.observed_at = "2026-08-22T10:00:00Z"; value.freshness.state = "expired"; resnapshot(value);
  expect(() => validateEnvelopeSemantics(value, context())).toThrow("EXT-EXPIRED-PASS");
});

test("EXT-UNKNOWN-PASS", () => {
  const value = envelope(); value.freshness.observed_at = "2026-08-22T13:00:00Z"; value.generated_at = "2026-08-22T13:00:00Z"; value.freshness.state = "unknown"; resnapshot(value);
  expect(() => validateEnvelopeSemantics(value, context())).toThrow("EXT-UNKNOWN-PASS");
});

test("EXT-FRESHNESS-STALE-POLICY permits pass only within an explicit grace window", () => {
  const value = envelope();
  value.freshness.observed_at = "2026-08-22T11:00:00Z";
  value.generated_at = "2026-08-22T11:05:00Z";
  value.freshness.state = "stale";
  resnapshot(value);
  expect(validateEnvelopeSemantics(value, context({ staleGraceSeconds: 3600 }))).toBe(true);
  expect(() => validateEnvelopeSemantics(value, context())).toThrow("EXT-FRESHNESS-RECALCULATED");
});
