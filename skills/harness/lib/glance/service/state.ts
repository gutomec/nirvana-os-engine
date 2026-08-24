import { closeSync, fsyncSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { canonicalizeJcs } from "./canonicalize.ts";
import { cleanupPrivateFreshFile, fsyncDirectory, openPrivateFreshFile, restrictDirectory, ServicePermissionError, type PrivateCleanupResult, type PrivateFileIdentity, type PrivateFreshFile } from "./permissions.ts";
import { parseStrictJson } from "./strict-json.ts";

export class ServiceIoError extends Error { constructor(operation: string, cause?: unknown) { super(`SERVICE_IO:${operation}`, { cause }); } }
export class IncompatibleStateError extends Error {}
export interface ServiceIo { read(path: string): Uint8Array; archive(path: string): void; }
export function digestJcs(value: unknown): `sha256:${string}` { return `sha256:${createHash("sha256").update(canonicalizeJcs(value)).digest("hex")}`; }
interface PrivateWriteRuntime {
  fsyncFile(descriptor: number): void;
  close(descriptor: number): void;
  rename(from: string, to: string): void;
  fsyncDirectory(path: string): void;
  reread(path: string): Uint8Array;
  cleanup(path: string, identity: PrivateFileIdentity): PrivateCleanupResult;
}

const nativePrivateWriteRuntime: Readonly<PrivateWriteRuntime> = Object.freeze({
  fsyncFile: fsyncSync,
  close: closeSync,
  rename: renameSync,
  fsyncDirectory,
  reread: readFileSync,
  cleanup: cleanupPrivateFreshFile,
});

export type PrivateWriteOperation = "file-fsync" | "close" | "rename" | "directory-fsync" | "reread" | "remove";
export type PrivateWriteTestHook = (operation: PrivateWriteOperation, perform: () => void, path?: string) => void;

function writePrivateBytesWithRuntime(path: string, bytes: Uint8Array, io: PrivateWriteRuntime): void {
  const parent = dirname(path);
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  let fresh: PrivateFreshFile | undefined;
  let descriptor: number | undefined;
  let primary: unknown;
  let cleanup: unknown;
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    restrictDirectory(parent);
    fresh = openPrivateFreshFile(temporary);
    descriptor = fresh.descriptor;
    writeFileSync(descriptor, bytes);
    io.fsyncFile(descriptor);
    io.close(descriptor);
    descriptor = undefined;
    io.rename(temporary, path);
    io.fsyncDirectory(parent);
    if (!Buffer.from(io.reread(path)).equals(Buffer.from(bytes))) throw new Error("REREAD_MISMATCH");
  } catch (cause) { primary = cause; }
  if (descriptor !== undefined) { try { io.close(descriptor); } catch (cause) { cleanup ??= cause; } }
  if (fresh) { try { if (io.cleanup(temporary, fresh.identity) === "preserved") cleanup ??= new ServicePermissionError("PRIVATE_CLEANUP_PRESERVED"); } catch (cause) { cleanup ??= cause; } }
  if (primary) { const error = new ServiceIoError("PRIVATE_WRITE", primary); Object.assign(error, { cleanup }); throw error; }
  if (cleanup) throw new ServiceIoError("PRIVATE_WRITE_CLEANUP", cleanup);
}

export function writePrivateBytes(path: string, bytes: Uint8Array): void { writePrivateBytesWithRuntime(path, bytes, nativePrivateWriteRuntime); }

export function createPrivateWriteTestHarness(hook: PrivateWriteTestHook = (_operation, perform) => perform()): Readonly<{ write(path: string, bytes: Uint8Array): void }> {
  const runtime: Readonly<PrivateWriteRuntime> = Object.freeze({
    fsyncFile: descriptor => hook("file-fsync", () => nativePrivateWriteRuntime.fsyncFile(descriptor)),
    close: descriptor => hook("close", () => nativePrivateWriteRuntime.close(descriptor)),
    rename: (from, to) => hook("rename", () => nativePrivateWriteRuntime.rename(from, to), from),
    fsyncDirectory: path => hook("directory-fsync", () => nativePrivateWriteRuntime.fsyncDirectory(path)),
    reread: path => { let bytes: Uint8Array | undefined; hook("reread", () => { bytes = nativePrivateWriteRuntime.reread(path); }); return bytes!; },
    cleanup: (path, identity) => { let result: PrivateCleanupResult | undefined; hook("remove", () => { result = nativePrivateWriteRuntime.cleanup(path, identity); }, path); return result!; },
  });
  return Object.freeze({ write: (path, bytes) => writePrivateBytesWithRuntime(path, bytes, runtime) });
}

export function writeDurableJson(path: string, value: unknown): void { writePrivateBytes(path, new TextEncoder().encode(`${JSON.stringify(value)}\n`)); }
export function readStateFileStrict<T>(path: string, validate: (value: unknown) => T, io: ServiceIo): T { let bytes: Uint8Array; try { bytes = io.read(path); } catch (cause) { throw new ServiceIoError("STATE_READ", cause); } try { return validate(parseStrictJson(bytes)); } catch (cause) { throw new IncompatibleStateError(`STATE_INCOMPATIBLE:${path}`, { cause }); } }
export function readStateFileOrArchive<T>(path: string, validate: (value: unknown) => T, io: ServiceIo): T | null { try { return readStateFileStrict(path, validate, io); } catch (error) { if (!(error instanceof IncompatibleStateError)) throw error; try { io.archive(path); } catch (cause) { throw new ServiceIoError("STATE_ARCHIVE", cause); } return null; } }
