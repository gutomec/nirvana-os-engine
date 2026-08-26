export type TargetRef =
  | { kind: "business"; slug: string }
  | { kind: "squad"; slug: string; capabilityId: string }
  // The engine's own personas share one kind: `agent-x` produces, `judge-x` judges. The slug
  // is the identity `targetsAreIndependent` compares, so the judge is independent of the
  // producer without a kind of its own (validators, Glance and the kernel only read `kind`).
  | { kind: "agent-x"; slug: "agent-x" | "judge-x" };

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

/** How the target of a Run was decided: named by the user (`explicit`), chosen by the router
 * (`router`) or the cascade bottom, agent-x, when nothing else applied (`fallback`). */
export interface RunRoute {
  source: "explicit" | "router" | "fallback";
  rationale: string;
}

export interface RunProjection {
  schemaVersion: "nirvana.run/v1alpha1";
  projectId: string;
  conversationId?: string;
  runId: string;
  traceId: string;
  parentRunId?: string;
  planId: string;
  target: TargetRef;
  route?: RunRoute;
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
