import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../lib/glance/service/lock.ts";
import { publishNoReplace } from "../lib/glance/service/no-replace.ts";
import {
  createNativeNoReplace,
  LinuxNativeNoReplace,
  MacOsNativeNoReplace,
  WindowsNativeNoReplace,
  type NativeLibraryLoader,
} from "../lib/glance/service/no-replace-native.ts";
import { makeLockIo, validLockOwner, type LockFailure } from "./helpers/glance-service-lock-fixture.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function decodePosix(bytes: Uint8Array): string {
  expect(bytes.at(-1)).toBe(0);
  return new TextDecoder().decode(bytes.subarray(0, -1));
}

function decodeWindows(bytes: Uint8Array): string {
  expect(bytes.length % 2).toBe(0);
  expect([...bytes.subarray(-2)]).toEqual([0, 0]);
  return Buffer.from(bytes.subarray(0, -2)).toString("utf16le");
}

describe("native no-replace adapters", () => {
  test("SVC-ADAPTER-LINUX preserves immediate errno, UTF-8 encoding, and buffer lifetime", () => {
    const events: string[] = [];
    let observed: readonly Uint8Array[] = [];
    let result = -1;
    let error = 13;
    const adapter = new LinuxNativeNoReplace({
      renameat2(oldPath, newPath) {
        events.push("renameat2");
        observed = [oldPath, newPath];
        return result;
      },
      readErrno() {
        events.push("errno");
        expect(decodePosix(observed[0])).toBe("café/candidate");
        expect(decodePosix(observed[1])).toBe("目标/destination");
        return error;
      },
    });

    expect(adapter.publish("café/candidate", "目标/destination")).toEqual({ ok: false, code: 13, name: "EACCES" });
    error = 17;
    expect(adapter.publish("café/candidate", "目标/destination")).toEqual({ ok: false, code: 17, name: "EEXIST" });
    result = 0;
    expect(adapter.publish("café/candidate", "目标/destination")).toEqual({ ok: true });
    expect(events).toEqual(["renameat2", "errno", "renameat2", "errno", "renameat2"]);
  });

  test("SVC-ADAPTER-MACOS preserves success, collision, and immediate error identity", () => {
    let result = 0;
    let error = 17;
    const events: string[] = [];
    const adapter = new MacOsNativeNoReplace({
      renamexNp(oldPath, newPath) {
        events.push("renamex_np");
        expect(decodePosix(oldPath)).toBe("old path");
        expect(decodePosix(newPath)).toBe("new path");
        return result;
      },
      readErrno() {
        events.push("__error");
        return error;
      },
    });

    expect(adapter.publish("old path", "new path")).toEqual({ ok: true });
    result = -1;
    expect(adapter.publish("old path", "new path")).toEqual({ ok: false, code: 17, name: "EEXIST" });
    error = 1;
    expect(adapter.publish("old path", "new path")).toEqual({ ok: false, code: 1, name: "EPERM" });
    expect(events).toEqual(["renamex_np", "renamex_np", "__error", "renamex_np", "__error"]);
  });

  test("SVC-ADAPTER-WINDOWS preserves UTF-16LE, success, collision, and noncollision codes", () => {
    let result = 1;
    let error = 183;
    const events: string[] = [];
    const adapter = new WindowsNativeNoReplace({
      moveFileExW(oldPath, newPath) {
        events.push("MoveFileExW");
        expect(decodeWindows(oldPath)).toBe("C:\\área antiga");
        expect(decodeWindows(newPath)).toBe("C:\\目标 novo");
        return result;
      },
      getLastError() {
        events.push("GetLastError");
        return error;
      },
    });

    expect(adapter.publish("C:\\área antiga", "C:\\目标 novo")).toEqual({ ok: true });
    result = 0;
    expect(adapter.publish("C:\\área antiga", "C:\\目标 novo")).toEqual({ ok: false, code: 183, name: "ERROR_ALREADY_EXISTS" });
    error = 5;
    expect(adapter.publish("C:\\área antiga", "C:\\目标 novo")).toEqual({ ok: false, code: 5, name: "ERROR_ACCESS_DENIED" });
    expect(events).toEqual(["MoveFileExW", "MoveFileExW", "GetLastError", "MoveFileExW", "GetLastError"]);
  });

  test("SVC-NOREPLACE-MISSING-SYMBOL fails closed for missing libraries and symbols", () => {
    const missingLibrary: NativeLibraryLoader = () => { throw new Error("library missing"); };
    const missingSymbol: NativeLibraryLoader = () => ({ symbols: Object.freeze({}), close() {} });
    expect(() => createNativeNoReplace(process.platform, missingLibrary)).toThrow("SERVICE_UNSUPPORTED");
    expect(() => createNativeNoReplace(process.platform, missingSymbol)).toThrow("SERVICE_UNSUPPORTED");
  });
});

test("SVC-NOREPLACE-EXISTS uses the current platform collision code and preserves a noncollision error", () => {
  const collision = process.platform === "win32" ? { code: 183, name: "ERROR_ALREADY_EXISTS" } : { code: 17, name: "EEXIST" };
  expect(() => publishNoReplace({ publish: () => ({ ok: false, ...collision }) }, "candidate", "destination")).toThrow("LOCK_EXISTS");
  expect(() => publishNoReplace({ publish: () => ({ ok: false, code: 13, name: "EACCES" }) }, "candidate", "destination")).toThrow("SERVICE_IO:NATIVE_NO_REPLACE:EACCES:13");
});

test("SVC-NOREPLACE-NATIVE-SMOKE publishes once and reports the original native collision", () => {
  const root = mkdtempSync(join(tmpdir(), "glance-native-no-replace-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const destination = join(root, "manager.lock");
  const first = join(root, "first.candidate");
  const second = join(root, "second.candidate");
  mkdirSync(first);
  writeFileSync(join(first, "owner"), "first");
  const adapter = createNativeNoReplace(process.platform);

  publishNoReplace(adapter, first, destination);
  expect(existsSync(first)).toBe(false);
  expect(readFileSync(join(destination, "owner"), "utf8")).toBe("first");

  mkdirSync(second);
  writeFileSync(join(second, "owner"), "second");
  expect(() => publishNoReplace(adapter, second, destination)).toThrow("LOCK_EXISTS");
  expect(readFileSync(join(second, "owner"), "utf8")).toBe("second");
  expect(readFileSync(join(destination, "owner"), "utf8")).toBe("first");
});

for (const failure of ["token-write", "owner-write", "file-fsync", "close", "directory-fsync", "reread", "validation", "native-noncollision"] satisfies LockFailure[]) {
  test(`SVC-LOCK-CLEANUP-${failure} removes owned candidate and token before fixture teardown`, () => {
    const io = makeLockIo(failure);
    cleanups.push(io.cleanup);
    expect(() => acquireLock(io, "start", new Uint8Array([1]), validLockOwner())).toThrow();
    const expectedBoundary = failure === "native-noncollision" ? "native-publish" : failure === "validation" ? "reread-and-validate" : failure;
    expect(io.events).toContain("mkdir");
    expect(io.events).toContain("identity");
    expect(io.events).toContain(expectedBoundary);
    expect(io.candidatePaths()).toEqual([]);
    expect(io.tokenPaths()).toEqual([]);
  });
}

test("SVC-NOREPLACE-NATIVE-IO remains native I/O when the destination exists", () => {
  const io = makeLockIo("native-eacces-with-existing-destination");
  cleanups.push(io.cleanup);
  expect(() => acquireLock(io, "start", new Uint8Array([1]), validLockOwner())).toThrow("SERVICE_IO:NATIVE_NO_REPLACE:EACCES:13");
  expect(io.destinationForeignMarker()).toBe("foreign-destination");
});

test("SVC-LOCK-CANDIDATE-SUBSTITUTION preserves a foreign replacement", () => {
  const io = makeLockIo("substitute-candidate");
  cleanups.push(io.cleanup);
  expect(() => acquireLock(io, "start", new Uint8Array([1]), validLockOwner())).toThrow("INJECTED:candidate-substitution");
  expect(io.foreignCandidateIntact()).toBe(true);
});

test("SVC-LOCK-TOKEN-MISMATCH preserves a substituted token", () => {
  const io = makeLockIo("substitute-token");
  cleanups.push(io.cleanup);
  expect(() => acquireLock(io, "start", new Uint8Array([1]), validLockOwner())).toThrow("INJECTED:token-substitution");
  expect(io.foreignTokenIntact()).toBe(true);
});

test("SVC-LOCK-CLEANUP-PRIMARY attempts both cleanups without masking the primary", () => {
  const io = makeLockIo("cleanup-both");
  cleanups.push(io.cleanup);
  let error: unknown;
  try { acquireLock(io, "start", new Uint8Array([1]), validLockOwner()); }
  catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("INJECTED:validation");
  expect(io.cleanupAttempts).toEqual(["candidate", "token"]);
  expect((error as Error & { cleanup?: unknown[] }).cleanup).toHaveLength(2);
});

test("SVC-LOCK-CANDIDATE-FSYNC publishes only the strict reread-valid owned destination", () => {
  const io = makeLockIo("none");
  cleanups.push(io.cleanup);
  const token = new Uint8Array([1]);
  expect(acquireLock(io, "start", token, validLockOwner())).toBe(io.destination);
  expect(io.candidatePaths()).toEqual([]);
  expect(io.destinationEntries()).toEqual([".owner-token", "owner.json"]);
  expect(io.destinationToken()).toEqual(Buffer.from(token));
  expect(io.destinationOwner()).toMatchObject({ schema_version: "1.0.0", operation: "start" });
  expect(io.events).toEqual(["mkdir", "identity", "token-write", "owner-write", "secure-and-sync", "reread-and-validate", "native-publish"]);
});

export const LOCK_CASES = [
  "SVC-ADAPTER-LINUX", "SVC-ADAPTER-MACOS", "SVC-ADAPTER-WINDOWS", "SVC-NOREPLACE-EXISTS", "SVC-NOREPLACE-MISSING-SYMBOL", "SVC-LOCK-ACTIVE", "SVC-LOCK-ARCHIVE-CLEANUP", "SVC-LOCK-CANDIDATE-CLEANUP", "SVC-LOCK-CANDIDATE-FSYNC", "SVC-LOCK-CONCURRENCY", "SVC-LOCK-EXISTING-EMPTY", "SVC-LOCK-EXISTING-VALID", "SVC-LOCK-EXPIRED-ABSENT", "SVC-LOCK-EXPIRED-LIVE", "SVC-LOCK-OWNER-MISSING", "SVC-LOCK-OWNER-TRUNCATED", "SVC-LOCK-PREPARE-PUBLISH-RACE", "SVC-LOCK-RELEASE-SUBSTITUTION", "SVC-LOCK-RENAME-FAIL", "SVC-LOCK-TARGET-MISMATCH", "SVC-LOCK-TOKEN-MISMATCH",
] as const;
