import {
  digestCanonicalJson,
  digestPayload,
  digestPayloadSchema,
  digestSnapshot,
  digestSource,
} from "./canonicalize.ts";
import type {
  Digest,
  GlanceExtensionDatasetEnvelopeV1,
  GlanceExtensionManifestV1,
} from "./types.ts";
import { compareRfc3339Instants, parseRfc3339Instant } from "./rfc3339.ts";

export type FreshnessState = "fresh" | "stale" | "expired" | "unknown";

export interface EnvelopeSemanticContext {
  manifest: GlanceExtensionManifestV1;
  scope: "global" | "project";
  projectRootDigest?: Digest;
  now: Date;
  staleGraceSeconds?: number;
  payloadSchemaDocument?: unknown;
}

export class SemanticValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SemanticValidationError";
  }
}

const RESERVED_IDS = new Set([
  "agents", "runs", "squads", "businesses", "projects", "mind-clones", "memory", "graph", "cost",
]);
const MAX_INVENTORY_BYTES = 16 * 1024 * 1024;
const MAX_DATASETS = 16;
const MAX_EVIDENCE_REFS = 128;
const TIMEZONE = /(?:[Zz]|[+-]\d{2}:\d{2})$/;

const fail = (code: string): never => { throw new SemanticValidationError(code); };
const asciiKey = (value: string): string => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

interface Semver {
  core: [bigint, bigint, bigint];
  prerelease: string[] | null;
}

function parseSemver(value: string): Semver | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return undefined;
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4]?.split(".") ?? null,
  };
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) fail("EXT-COMPAT-RANGE");
  for (let index = 0; index < 3; index++) {
    if (a.core[index] < b.core[index]) return -1;
    if (a.core[index] > b.core[index]) return 1;
  }
  if (a.prerelease === null || b.prerelease === null) {
    if (a.prerelease === b.prerelease) return 0;
    return a.prerelease === null ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values.map(asciiKey)).size !== values.length;
}

function sameJson(left: unknown, right: unknown): boolean {
  return digestCanonicalJson(left) === digestCanonicalJson(right);
}

export function validateManifestSemantics(
  manifest: GlanceExtensionManifestV1,
  hostApiVersion = "1.0.0",
): true {
  const { minimum, maximum_tested: maximum } = manifest.compatibility;
  if (compareSemver(minimum, maximum) > 0 || compareSemver(hostApiVersion, minimum) < 0 || compareSemver(hostApiVersion, maximum) > 0) {
    fail("EXT-COMPAT-RANGE");
  }
  if (manifest.ui.entrypoint !== "ui/index.html") fail("EXT-ENTRYPOINT");
  if (manifest.datasets.length < 1 || manifest.datasets.length > MAX_DATASETS) fail("EXT-MANIFEST-DATASET-LIMIT");
  if (hasDuplicates(manifest.datasets.map((dataset) => dataset.id))) fail("EXT-DATASET-ID-DUP");
  for (const dataset of manifest.datasets) {
    if (dataset.path !== `data/${dataset.id}.snapshot.json`) fail("EXT-DATASET-PATH");
  }
  if (hasDuplicates(manifest.files.map((file) => file.path))) fail("EXT-FILE-PATH-DUP");
  if (RESERVED_IDS.has(asciiKey(manifest.id))) fail("EXT-RESERVED-ID");
  const inventoryBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0) +
    manifest.datasets.reduce((sum, dataset) => sum + dataset.max_bytes, 0);
  if (!Number.isSafeInteger(inventoryBytes) || inventoryBytes > MAX_INVENTORY_BYTES) fail("EXT-INVENTORY-BYTES-LIMIT");
  const navigation = manifest.external_navigation as { mode?: string; allowed_hosts: string[] };
  if (navigation.mode !== "host-mediated" || navigation.allowed_hosts.some((host) => host !== "github.com") || hasDuplicates(navigation.allowed_hosts)) {
    fail("EXT-URL-MANIFEST-HOST");
  }
  return true;
}

export function calculateFreshness(
  observedAt: string,
  maxAgeSeconds: number,
  now: Date,
  staleGraceSeconds = 0,
): FreshnessState {
  const observed = parseRfc3339Instant(observedAt)?.epochMilliseconds;
  const current = now.getTime();
  if (observed === undefined || !Number.isFinite(current) || observed > current) return "unknown";
  const ageSeconds = (current - observed) / 1000;
  if (ageSeconds <= maxAgeSeconds) return "fresh";
  if (staleGraceSeconds > 0 && ageSeconds <= maxAgeSeconds + staleGraceSeconds) return "stale";
  return "expired";
}

export function validateEnvelopeSemantics(
  envelope: GlanceExtensionDatasetEnvelopeV1,
  context: EnvelopeSemanticContext,
): true {
  const dataset = context.manifest.datasets.find((candidate) => candidate.id === envelope.dataset_id);
  if (!dataset || envelope.extension_id !== context.manifest.id) fail("EXT-PAYLOAD-SCHEMA-DIGEST");

  if (envelope.scope.kind !== context.scope) fail("EXT-SCOPE-MISMATCH");
  if (context.scope === "project") {
    if (!context.projectRootDigest || envelope.scope.kind !== "project" || envelope.scope.project_root_digest !== context.projectRootDigest) {
      fail("EXT-PROJECT-DIGEST");
    }
  }

  if (!TIMEZONE.test(envelope.generated_at)) fail("EXT-TIMEZONE-GENERATED");
  if (!TIMEZONE.test(envelope.freshness.observed_at)) fail("EXT-TIMEZONE-OBSERVED");
  const generated = parseRfc3339Instant(envelope.generated_at);
  const observed = parseRfc3339Instant(envelope.freshness.observed_at);
  if (!generated || !observed || compareRfc3339Instants(generated, observed) < 0) fail("EXT-TIMESTAMP-ORDER");

  const evidenceIds = envelope.evidence_refs.map((evidence) => evidence.id);
  if (envelope.evidence_refs.length > MAX_EVIDENCE_REFS || hasDuplicates(evidenceIds)) fail("EXT-EVIDENCE-LIMIT");
  const artifactIds = envelope.source.artifacts.map((artifact) => artifact.id);
  if (hasDuplicates(artifactIds)) fail("EXT-ARTIFACT-DUP");
  const sortedArtifacts = [...artifactIds].sort();
  if (artifactIds.some((id, index) => id !== sortedArtifacts[index])) fail("EXT-ARTIFACT-ORDER");

  const freshness = calculateFreshness(
    envelope.freshness.observed_at,
    envelope.freshness.max_age_seconds,
    context.now,
    context.staleGraceSeconds,
  );
  if (envelope.freshness.state !== freshness) fail("EXT-FRESHNESS-RECALCULATED");
  if (envelope.status === "pass" && freshness === "expired") fail("EXT-EXPIRED-PASS");
  if (envelope.status === "pass" && freshness === "unknown") fail("EXT-UNKNOWN-PASS");

  if (envelope.integrity.payload_digest !== digestPayload(envelope.payload)) fail("EXT-PAYLOAD-DIGEST");
  if (!sameJson(envelope.payload_schema, dataset.payload_schema)) fail("EXT-PAYLOAD-SCHEMA-DIGEST");
  if (context.payloadSchemaDocument !== undefined && envelope.payload_schema.digest !== digestPayloadSchema(context.payloadSchemaDocument)) {
    fail("EXT-PAYLOAD-SCHEMA-DIGEST");
  }
  if (envelope.source.digest !== digestSource(envelope.source)) fail("EXT-SOURCE-DIGEST");
  if (envelope.snapshot_id !== digestSnapshot(envelope as unknown as Record<string, unknown>)) fail("EXT-SNAPSHOT-DIGEST");
  return true;
}
