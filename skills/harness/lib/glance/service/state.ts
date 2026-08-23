import { closeSync, fsyncSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { restrictDirectory, openPrivateFreshFile, fsyncDirectory } from "./permissions.ts";
import { parseStrictJson } from "./strict-json.ts";

export class ServiceIoError extends Error { constructor(operation: string, cause?: unknown) { super(`SERVICE_IO:${operation}`, { cause }); } }
export class IncompatibleStateError extends Error {}
export interface ServiceIo { read(path: string): Uint8Array; archive(path: string): void; }
interface PrivateWriteRuntime {
  fsyncFile(descriptor: number): void;
  close(descriptor: number): void;
  rename(from: string, to: string): void;
  fsyncDirectory(path: string): void;
  reread(path: string): Uint8Array;
  remove(path: string): void;
}

const nativePrivateWriteRuntime: Readonly<PrivateWriteRuntime> = Object.freeze({
  fsyncFile: fsyncSync,
  close: closeSync,
  rename: renameSync,
  fsyncDirectory,
  reread: readFileSync,
  remove: path => rmSync(path, { force: true }),
});

export type PrivateWriteOperation = "file-fsync" | "close" | "rename" | "directory-fsync" | "reread" | "remove";
export type PrivateWriteTestHook = (operation: PrivateWriteOperation, perform: () => void) => void;

function writePrivateBytesWithRuntime(path: string, bytes: Uint8Array, io: PrivateWriteRuntime): void {
  const parent = dirname(path);
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let primary: unknown;
  let cleanup: unknown;
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    restrictDirectory(parent);
    descriptor = openPrivateFreshFile(temporary);
    writeFileSync(descriptor, bytes);
    io.fsyncFile(descriptor);
    io.close(descriptor);
    descriptor = undefined;
    io.rename(temporary, path);
    io.fsyncDirectory(parent);
    if (!Buffer.from(io.reread(path)).equals(Buffer.from(bytes))) throw new Error("REREAD_MISMATCH");
  } catch (cause) { primary = cause; }
  if (descriptor !== undefined) { try { io.close(descriptor); } catch (cause) { cleanup ??= cause; } }
  try { io.remove(temporary); } catch (cause) { cleanup ??= cause; }
  if (primary) { const error = new ServiceIoError("PRIVATE_WRITE", primary); Object.assign(error, { cleanup }); throw error; }
  if (cleanup) throw new ServiceIoError("PRIVATE_WRITE_CLEANUP", cleanup);
}

export function writePrivateBytes(path: string, bytes: Uint8Array): void { writePrivateBytesWithRuntime(path, bytes, nativePrivateWriteRuntime); }

export function createPrivateWriteTestHarness(hook: PrivateWriteTestHook = (_operation, perform) => perform()): Readonly<{ write(path: string, bytes: Uint8Array): void }> {
  const runtime: Readonly<PrivateWriteRuntime> = Object.freeze({
    fsyncFile: descriptor => hook("file-fsync", () => nativePrivateWriteRuntime.fsyncFile(descriptor)),
    close: descriptor => hook("close", () => nativePrivateWriteRuntime.close(descriptor)),
    rename: (from, to) => hook("rename", () => nativePrivateWriteRuntime.rename(from, to)),
    fsyncDirectory: path => hook("directory-fsync", () => nativePrivateWriteRuntime.fsyncDirectory(path)),
    reread: path => { let bytes: Uint8Array | undefined; hook("reread", () => { bytes = nativePrivateWriteRuntime.reread(path); }); return bytes!; },
    remove: path => hook("remove", () => nativePrivateWriteRuntime.remove(path)),
  });
  return Object.freeze({ write: (path, bytes) => writePrivateBytesWithRuntime(path, bytes, runtime) });
}

export function writeDurableJson(path: string, value: unknown): void { writePrivateBytes(path, new TextEncoder().encode(`${JSON.stringify(value)}\n`)); }
export function readStateFileStrict<T>(path: string, validate: (value: unknown) => T, io: ServiceIo): T { let bytes: Uint8Array; try { bytes = io.read(path); } catch (cause) { throw new ServiceIoError("STATE_READ", cause); } try { return validate(parseStrictJson(bytes)); } catch (cause) { throw new IncompatibleStateError(`STATE_INCOMPATIBLE:${path}`, { cause }); } }
export function readStateFileOrArchive<T>(path: string, validate: (value: unknown) => T, io: ServiceIo): T | null { try { return readStateFileStrict(path, validate, io); } catch (error) { if (!(error instanceof IncompatibleStateError)) throw error; try { io.archive(path); } catch (cause) { throw new ServiceIoError("STATE_ARCHIVE", cause); } return null; } }
