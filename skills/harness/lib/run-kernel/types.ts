export type TargetRef =
  | { kind: "business"; slug: string }
  | { kind: "squad"; slug: string; capabilityId: string }
  | { kind: "agent-x"; slug: "agent-x" };

export type CanonicalRunState =
  | "prepared"
  | "running"
  | "waiting"
  | "verifying"
  | "revising"
  | "cancelling"
  | "rolled_back"
  | "completed"
  | "withheld"
  | "delivered_with_reservations"
  | "cancelled"
  | "failed"
  | "abandoned";

export interface RunProjection {
  schemaVersion: "nirvana.run/v1alpha1";
  projectId: string;
  conversationId?: string;
  runId: string;
  traceId: string;
  parentRunId?: string;
  planId: string;
  target: TargetRef;
  state: CanonicalRunState;
  policySnapshotRef: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  lastSequence: number;
}
export interface RunEvent<TPayload = Record<string, unknown>> {
  schemaVersion: "nirvana.event/v1alpha1";
  eventId: string;
  projectId: string;
  runId: string;
  traceId: string;
  sequence: number;
  type: string;
  occurredAt: string;
  recordedAt: string;
  actor: { kind: string; id: string };
  correlationId: string;
  causationId?: string;
  idempotencyKey?: string;
  transcriptMessageId?: string;
  payload: TPayload;
}

export interface ArtifactRef {
  schemaVersion: "nirvana.artifact-ref/v1alpha1";
  projectId: string;
  runId: string;
  artifactId: string;
  revisionId: string;
  revision: number;
  role: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  stagingUri?: string;
  publishedUri: string;
  classification: string;
  producer: {
    targetKind: TargetRef["kind"];
    targetSlug: string;
    capabilityId?: string;
  };
}

export interface TranscriptMessage {
  messageId: string;
  projectId: string;
  runId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
}
