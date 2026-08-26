import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtifactRef } from "./types.ts";

export function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
export function verifyArtifactRef(ref: ArtifactRef, workspaceRoot: string): void {
  if (!/^([a-f0-9]{64})$/.test(ref.sha256)) throw new Error("artifact-ref: sha256 must be 64 lowercase hexadecimal characters");
  if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new Error("artifact-ref: bytes must be a non-negative safe integer");
  if (!Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new Error("artifact-ref: revision must be a positive safe integer");
  if (!ref.mediaType.includes("/")) throw new Error("artifact-ref: invalid media type");

  const filePath = fileURLToPath(ref.publishedUri);
  const root = fs.realpathSync(workspaceRoot);
  const resolved = fs.realpathSync(filePath);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("artifact-ref: published file escapes the authorized workspace");
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error("artifact-ref: published URI is not a file");
  if (stat.size !== ref.bytes) throw new Error("artifact-ref: byte count mismatch");
  if (sha256File(resolved) !== ref.sha256) throw new Error("artifact-ref: digest mismatch");
}
