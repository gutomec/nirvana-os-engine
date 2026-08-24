import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalizeJcs } from "./canonicalize.ts";
import { ServicePathError, resolveServiceRef } from "./paths.ts";
import { validateStopRequest } from "./schema-validator.ts";
import { parseStrictJson } from "./strict-json.ts";
import type { ServiceStopRequestV1 } from "./types.ts";

export interface StopRequestV1 { schema_version: "1.0.0"; request_id: string; instance_id: string; action: "stop"; created_at: string; expires_at: string; nonce_ref: `control/nonces/${string}.nonce`; nonce_digest: `sha256:${string}`; auth_algorithm: "hmac-sha256"; auth_tag: string }
export function stopMacInput(request: Omit<StopRequestV1, "auth_tag">): Uint8Array { return new TextEncoder().encode(canonicalizeJcs(request)); }
export function verifyStopRequest(request: StopRequestV1, secret: Uint8Array): boolean {
  const { auth_tag, ...unsignedFields } = request;
  const expected = createHmac("sha256", secret).update(stopMacInput(unsignedFields)).digest();
  let provided: Buffer;
  try { provided = Buffer.from(auth_tag, "hex"); } catch { return false; }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export class StopRequestError extends Error {
  constructor(readonly code: string, cause?: unknown) { super(`STOP_REQUEST:${code}`, cause ? { cause } : undefined); }
}
export interface StopControlIo {
  readBytes(path: string): Uint8Array;
  now(): number;
  claim(pendingPath: string, processingPath: string): boolean;
  remove(path: string): void;
}
export type StopRequestRecord = ServiceStopRequestV1;

const sha256Digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function parseStopRequestBytes(bytes: Uint8Array): ServiceStopRequestV1 {
  let parsed: unknown;
  try { parsed = parseStrictJson(bytes); } catch (cause) { throw new StopRequestError("INVALID_REQUEST", cause); }
  try { return validateStopRequest(parsed); } catch (cause) { throw new StopRequestError("INVALID_REQUEST", cause); }
}

export function resolveControlSecret(serviceRoot: string, instance: { control_secret_ref: string }, read: (path: string) => Uint8Array = readFileSync): Uint8Array {
  return read(resolveServiceRef(serviceRoot, instance.control_secret_ref, true));
}

export function consumeStopRequest(input: {
  serviceRoot: string;
  pendingRef: string;
  processingRef: string;
  instance: { instance_id: string };
  secret: Uint8Array;
  io: StopControlIo;
}): void {
  const { serviceRoot, pendingRef, processingRef, instance, secret, io } = input;
  const pendingPath = resolveServiceRef(serviceRoot, pendingRef, true);
  const processingPath = resolveServiceRef(serviceRoot, processingRef, false);
  if (!io.claim(pendingPath, processingPath)) throw new StopRequestError("CLAIM_LOST");
  const claimedPath = resolveServiceRef(serviceRoot, processingRef, true);
  const bytes = io.readBytes(claimedPath);
  const request = parseStopRequestBytes(bytes);
  const observedMs = io.now();
  if (observedMs >= Date.parse(request.expires_at)) throw new StopRequestError("WINDOW_EXPIRED");
  if (observedMs < Date.parse(request.created_at)) throw new StopRequestError("WINDOW_FUTURE");
  if (request.instance_id !== instance.instance_id) throw new StopRequestError("INSTANCE_MISMATCH");
  let nonce: Uint8Array;
  let noncePath: string;
  try {
    noncePath = resolveServiceRef(serviceRoot, request.nonce_ref, true);
    nonce = io.readBytes(noncePath);
  } catch (error) {
    if (error instanceof Error && error.message.includes("MISSING_SERVICE_REF")) throw new StopRequestError("NONCE_MISSING", error);
    if (error instanceof ServicePathError || error instanceof StopRequestError) throw error;
    throw new StopRequestError("NONCE_REF_REJECTED", error);
  }
  if (sha256Digest(nonce) !== request.nonce_digest) throw new StopRequestError("NONCE_DIGEST");
  if (!verifyStopRequest(request, secret)) throw new StopRequestError("AUTH_TAG");
  if (!Buffer.from(io.readBytes(claimedPath)).equals(Buffer.from(bytes))) throw new StopRequestError("PROCESSING_SUBSTITUTED");
  let observedNonce: Uint8Array;
  try { observedNonce = io.readBytes(noncePath); } catch (cause) { throw new StopRequestError("REPLAY", cause); }
  if (!Buffer.from(observedNonce).equals(Buffer.from(nonce))) throw new StopRequestError("NONCE_SUBSTITUTED");
  io.remove(noncePath);
  io.remove(claimedPath);
}
