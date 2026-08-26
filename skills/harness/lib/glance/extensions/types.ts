export type Digest = `sha256:${string}`;

export type ExtensionErrorCode =
  | "COLLISION"
  | "DATASET_INVALID"
  | "EXTENSION_INCOMPATIBLE"
  | "EXTENSION_NOT_FOUND"
  | "FILE_INTEGRITY"
  | "MANIFEST_INVALID"
  | "METHOD_NOT_ALLOWED"
  | "PATH_UNSAFE"
  | "SCOPE_MISMATCH"
  | "UI_HANDSHAKE"
  | "URL_REJECTED";

export type GlanceExtensionScopeV1 =
  | { kind: "global" }
  | { kind: "project"; project_root_digest: Digest };

export interface ManifestDatasetV1 {
  id: string;
  path: string;
  envelope_schema: "https://schemas.nirvana-os.dev/glance/dataset-envelope/1.0.0";
  payload_schema: { id: string; version: string; digest: Digest };
  max_bytes: number;
  refresh: "on-request";
}

export interface GlanceExtensionManifestV1 {
  schema_version: "1.0.0";
  id: string;
  version: string;
  display: { title: string; description: string; icon: string; order: number };
  compatibility: { minimum: string; maximum_tested: string };
  ui: { entrypoint: "ui/index.html"; sandbox: "allow-scripts"; theme_contract: "glance.ui.tokens.v1" };
  datasets: ManifestDatasetV1[];
  files: [{ path: "ui/index.html"; mime: "text/html; charset=utf-8"; bytes: number; sha256: string }];
  capabilities: ["read_snapshot"];
  provenance: Record<string, unknown>;
  external_navigation: { allowed_hosts: string[] };
}

export interface GlanceExtensionDatasetEnvelopeV1 {
  schema_version: "1.0.0";
  extension_id: string;
  dataset_id: string;
  snapshot_id: Digest;
  generated_at: string;
  status: "pass" | "partial" | "indeterminate" | "fail";
  scope: GlanceExtensionScopeV1;
  subject: { type: string; id: string; digest: Digest };
  source: {
    kind: "local_file" | "local_command" | "remote_api" | "composite";
    label: string;
    digest: Digest;
    artifacts: Array<{ id: string; digest: Digest }>;
  };
  freshness: { observed_at: string; max_age_seconds: number; state: "fresh" | "stale" | "expired" | "unknown" };
  payload_schema: { id: string; version: string; digest: Digest };
  evidence_refs: Array<{ id: string; kind: "file" | "url" | "audit_event" | "digest"; ref: string; digest?: Digest }>;
  integrity: { algorithm: "sha256"; payload_digest: Digest };
  payload: unknown;
}

export interface LoadedGlanceExtension {
  manifest: GlanceExtensionManifestV1;
  manifest_digest: Digest;
  absoluteRoot: string;
}

export interface GlanceExtensionPublicErrorV1 {
  schema_version: "1.0.0";
  error: {
    code: ExtensionErrorCode;
    message: string;
    retryable: boolean;
    correlation_id: string;
    extension_id?: string;
    dataset_id?: string;
  };
}

export interface GlanceExtensionCatalogV1 {
  schema_version: "1.0.0";
  extension_api_version: "1.0.0";
  scope: { kind: "global" | "project"; root_digest: Digest };
  extensions: Array<{
    id: string;
    version: string;
    title: string;
    description: string;
    icon: string;
    order: number;
    status: "accepted" | "incompatible" | "rejected";
    trust: { level: "local_owner"; basis: ["filesystem_owner"] };
    manifest_digest: Digest;
    datasets: string[];
  }>;
  diagnostics: GlanceExtensionPublicErrorV1[];
}
