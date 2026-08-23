import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { restrictDirectory, restrictFile, fsyncDirectory } from "./permissions.ts";
import { parseStrictJson } from "./strict-json.ts";

export class ServiceIoError extends Error { constructor(operation: string, cause?: unknown) { super(`SERVICE_IO:${operation}`, { cause }); } }
export class IncompatibleStateError extends Error {}
export interface ServiceIo { read(path: string): Uint8Array; archive(path: string): void; }

export function writePrivateBytes(path: string, bytes: Uint8Array): void {
  const parent = dirname(path);
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let primary: unknown;
  let cleanup: unknown;
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    restrictDirectory(parent);
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    restrictFile(temporary);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    restrictFile(path);
    fsyncDirectory(parent);
    if (!Buffer.from(readFileSync(path)).equals(Buffer.from(bytes))) throw new Error("REREAD_MISMATCH");
  } catch (cause) { primary = cause; }
  if (descriptor !== undefined) { try { closeSync(descriptor); } catch (cause) { cleanup ??= cause; } }
  try { rmSync(temporary, { force: true }); } catch (cause) { cleanup ??= cause; }
  if (primary) { const error = new ServiceIoError("PRIVATE_WRITE", primary); Object.assign(error, { cleanup }); throw error; }
  if (cleanup) throw new ServiceIoError("PRIVATE_WRITE_CLEANUP", cleanup);
}

export function writeDurableJson(path: string, value: unknown): void { writePrivateBytes(path, new TextEncoder().encode(`${JSON.stringify(value)}\n`)); }
export function readStateFileStrict<T>(path: string, validate: (value: unknown) => T, io: ServiceIo): T { let bytes: Uint8Array; try { bytes = io.read(path); } catch (cause) { throw new ServiceIoError("STATE_READ", cause); } try { return validate(parseStrictJson(bytes)); } catch (cause) { throw new IncompatibleStateError(`STATE_INCOMPATIBLE:${path}`, { cause }); } }
export function readStateFileOrArchive<T>(path: string, validate: (value: unknown) => T, io: ServiceIo): T | null { try { return readStateFileStrict(path, validate, io); } catch (error) { if (!(error instanceof IncompatibleStateError)) throw error; try { io.archive(path); } catch (cause) { throw new ServiceIoError("STATE_ARCHIVE", cause); } return null; } }
