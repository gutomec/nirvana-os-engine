import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";

export interface StableReadHooks {
  beforeOpen?(): void;
  beforeRead?(): void;
  afterRead?(): void;
}

export interface InventoriedFileExpectation {
  path: string;
  mime: "application/json; charset=utf-8" | "text/html; charset=utf-8";
  bytes: number;
  sha256: string;
}

const ALLOWED_MIME = new Set<InventoriedFileExpectation["mime"]>([
  "application/json; charset=utf-8",
  "text/html; charset=utf-8",
]);

const MAX_BYTES_BY_MIME: Readonly<Record<InventoriedFileExpectation["mime"], number>> = {
  "application/json; charset=utf-8": 5 * 1024 * 1024,
  "text/html; charset=utf-8": 2 * 1024 * 1024,
};

const SAFE_ERRORS = new Set(["PATH_UNSAFE", "FILE_CHANGED", "FILE_INTEGRITY"]);

function fail(code: "PATH_UNSAFE" | "FILE_CHANGED" | "FILE_INTEGRITY"): never {
  throw new Error(code);
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs;
}

function sameSnapshot(left: readonly Stats[], right: readonly Stats[]): boolean {
  return left.length === right.length && left.every((item, index) => sameIdentity(item, right[index]!));
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function validateRelativePath(relativePath: string): string[] {
  if (
    relativePath.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(relativePath) ||
    posix.isAbsolute(relativePath) ||
    win32.isAbsolute(relativePath) ||
    relativePath.includes("\\")
  ) fail("PATH_UNSAFE");
  const segments = relativePath.split("/");
  if (segments.some((part) => part === "" || part === "." || part === ".." || part.includes(":"))) {
    fail("PATH_UNSAFE");
  }
  return segments;
}

function inspectSegments(canonicalRoot: string, segments: readonly string[]): Stats[] {
  const rootStats = lstatSync(canonicalRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) fail("PATH_UNSAFE");
  const currentRoot = realpathSync.native(canonicalRoot);
  if (!sameCanonicalPath(currentRoot, canonicalRoot)) fail("PATH_UNSAFE");

  const snapshot = [rootStats];
  let cursor = canonicalRoot;
  for (const [index, segment] of segments.entries()) {
    if (!readdirSync(cursor).includes(segment)) fail("PATH_UNSAFE");
    cursor = resolve(cursor, segment);
    if (!inside(canonicalRoot, cursor)) fail("PATH_UNSAFE");
    const stats = lstatSync(cursor);
    if (stats.isSymbolicLink()) fail("PATH_UNSAFE");
    if (index < segments.length - 1 && !stats.isDirectory()) fail("PATH_UNSAFE");
    const canonicalSegment = realpathSync.native(cursor);
    if (!inside(canonicalRoot, canonicalSegment)) fail("PATH_UNSAFE");
    snapshot.push(stats);
  }
  return snapshot;
}

function rethrowSafe(error: unknown): never {
  if (error instanceof Error && SAFE_ERRORS.has(error.message)) throw error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (["EACCES", "EISDIR", "ELOOP", "ENOENT", "ENOTDIR", "EPERM"].includes(code ?? "")) {
    fail("PATH_UNSAFE");
  }
  throw error;
}

export function readStableInventoriedFile(
  root: string,
  relativePath: string,
  expected: InventoriedFileExpectation,
  hooks: StableReadHooks = {},
): Uint8Array {
  let fd: number | undefined;
  try {
    const segments = validateRelativePath(relativePath);
    if (!expected || expected.path !== relativePath) fail("PATH_UNSAFE");
    if (
      !ALLOWED_MIME.has(expected.mime) ||
      !Number.isSafeInteger(expected.bytes) ||
      expected.bytes < 0 ||
      expected.bytes > MAX_BYTES_BY_MIME[expected.mime] ||
      !/^[a-f0-9]{64}$/.test(expected.sha256)
    ) fail("FILE_INTEGRITY");

    const suppliedRoot = lstatSync(root);
    if (suppliedRoot.isSymbolicLink() || !suppliedRoot.isDirectory()) fail("PATH_UNSAFE");
    const canonicalRoot = realpathSync.native(root);
    const target = resolve(canonicalRoot, ...segments);
    if (!inside(canonicalRoot, target)) fail("PATH_UNSAFE");

    const initialSnapshot = inspectSegments(canonicalRoot, segments);
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    hooks.beforeOpen?.();
    fd = openSync(target, constants.O_RDONLY | noFollow);

    const openedBefore = fstatSync(fd);
    if (!openedBefore.isFile()) fail("PATH_UNSAFE");
    if (openedBefore.size !== expected.bytes) fail("FILE_CHANGED");
    const canonicalTarget = realpathSync.native(target);
    if (!inside(canonicalRoot, canonicalTarget)) fail("PATH_UNSAFE");
    const openedSnapshot = inspectSegments(canonicalRoot, segments);
    const namedBefore = statSync(target);
    if (!sameIdentity(openedBefore, namedBefore) || !sameSnapshot(initialSnapshot, openedSnapshot)) {
      fail("FILE_CHANGED");
    }

    hooks.beforeRead?.();
    const readyTarget = realpathSync.native(target);
    if (!inside(canonicalRoot, readyTarget)) fail("PATH_UNSAFE");
    const readySnapshot = inspectSegments(canonicalRoot, segments);
    const namedReady = statSync(target);
    if (!sameIdentity(openedBefore, namedReady) || !sameSnapshot(openedSnapshot, readySnapshot)) {
      fail("FILE_CHANGED");
    }

    const bytes = readFileSync(fd);
    hooks.afterRead?.();
    const openedAfter = fstatSync(fd);
    const finalTarget = realpathSync.native(target);
    if (!inside(canonicalRoot, finalTarget)) fail("PATH_UNSAFE");
    const finalSnapshot = inspectSegments(canonicalRoot, segments);
    const namedAfter = statSync(target);
    if (
      !sameIdentity(openedBefore, openedAfter) ||
      !sameIdentity(openedAfter, namedAfter) ||
      !sameSnapshot(readySnapshot, finalSnapshot) ||
      bytes.byteLength !== expected.bytes
    ) fail("FILE_CHANGED");
    if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) fail("FILE_INTEGRITY");
    return bytes;
  } catch (error) {
    rethrowSafe(error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
