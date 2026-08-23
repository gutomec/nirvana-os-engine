import { dlopen, FFIType, ptr, read } from "bun:ffi";
import type { NativeNoReplace, NativeNoReplaceResult } from "./no-replace.ts";

export interface LinuxNoReplaceBinding { renameat2(oldPath: Uint8Array, newPath: Uint8Array): number; readErrno(): number; }
export interface MacOsNoReplaceBinding { renamexNp(oldPath: Uint8Array, newPath: Uint8Array): number; readErrno(): number; }
export interface WindowsNoReplaceBinding { moveFileExW(oldPath: Uint8Array, newPath: Uint8Array): number; getLastError(): number; }
export interface NativeLibrary { symbols: Readonly<Record<string, unknown>>; close(): void; }
export type NativeLibraryLoader = (library: string, symbols: Readonly<Record<string, unknown>>) => NativeLibrary;

const AT_FDCWD = -100;
const RENAME_NOREPLACE = 1;
const RENAME_EXCL = 0x00000004;

const POSIX_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: "EPERM",
  2: "ENOENT",
  13: "EACCES",
  17: "EEXIST",
  18: "EXDEV",
  22: "EINVAL",
  38: "ENOSYS",
});
const WINDOWS_NAMES: Readonly<Record<number, string>> = Object.freeze({
  2: "ERROR_FILE_NOT_FOUND",
  3: "ERROR_PATH_NOT_FOUND",
  5: "ERROR_ACCESS_DENIED",
  80: "ERROR_FILE_EXISTS",
  87: "ERROR_INVALID_PARAMETER",
  183: "ERROR_ALREADY_EXISTS",
});

function posixName(code: number): string { return POSIX_NAMES[code] ?? `ERRNO_${code}`; }
function windowsName(code: number): string { return WINDOWS_NAMES[code] ?? `WIN32_ERROR_${code}`; }
function utf8Path(path: string): Uint8Array { return new TextEncoder().encode(`${path}\0`); }
function utf16Path(path: string): Uint8Array { return Buffer.from(`${path}\0`, "utf16le"); }

export class LinuxNativeNoReplace implements NativeNoReplace {
  constructor(private readonly binding: LinuxNoReplaceBinding) {}
  publish(candidate: string, destination: string): NativeNoReplaceResult {
    const oldPath = utf8Path(candidate);
    const newPath = utf8Path(destination);
    const result = this.binding.renameat2(oldPath, newPath);
    if (result === 0) return { ok: true };
    const code = this.binding.readErrno();
    return { ok: false, code, name: posixName(code) };
  }
}

export class MacOsNativeNoReplace implements NativeNoReplace {
  constructor(private readonly binding: MacOsNoReplaceBinding) {}
  publish(candidate: string, destination: string): NativeNoReplaceResult {
    const oldPath = utf8Path(candidate);
    const newPath = utf8Path(destination);
    const result = this.binding.renamexNp(oldPath, newPath);
    if (result === 0) return { ok: true };
    const code = this.binding.readErrno();
    return { ok: false, code, name: posixName(code) };
  }
}

export class WindowsNativeNoReplace implements NativeNoReplace {
  constructor(private readonly binding: WindowsNoReplaceBinding) {}
  publish(candidate: string, destination: string): NativeNoReplaceResult {
    const oldPath = utf16Path(candidate);
    const newPath = utf16Path(destination);
    const result = this.binding.moveFileExW(oldPath, newPath);
    if (result !== 0) return { ok: true };
    const code = this.binding.getLastError();
    return { ok: false, code, name: windowsName(code) };
  }
}

const defaultLoader: NativeLibraryLoader = (library, symbols) =>
  dlopen(library, symbols as Parameters<typeof dlopen>[1]) as unknown as NativeLibrary;

function unsupported(cause?: unknown): Error { return new Error("SERVICE_UNSUPPORTED", { cause }); }
function symbol<T extends (...args: never[]) => unknown>(library: NativeLibrary, name: string): T {
  const value = library.symbols[name];
  if (typeof value !== "function") throw unsupported(new Error(`MISSING_SYMBOL:${name}`));
  return value as T;
}

function linuxAdapter(loader: NativeLibraryLoader): NativeNoReplace {
  const library = loader("libc.so.6", {
    renameat2: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  });
  try {
    const renameat2 = symbol<(oldDirectory: number, oldPath: number, newDirectory: number, newPath: number, flags: number) => number>(library, "renameat2");
    const errnoLocation = symbol<() => number>(library, "__errno_location");
    return new LinuxNativeNoReplace({
      renameat2: (oldPath, newPath) => renameat2(AT_FDCWD, ptr(oldPath), AT_FDCWD, ptr(newPath), RENAME_NOREPLACE),
      readErrno: () => read.i32(errnoLocation()),
    });
  } catch (error) { library.close(); throw error; }
}

function macOsAdapter(loader: NativeLibraryLoader): NativeNoReplace {
  const library = loader("/usr/lib/libSystem.B.dylib", {
    renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
  });
  try {
    const renamexNp = symbol<(oldPath: number, newPath: number, flags: number) => number>(library, "renamex_np");
    const errorLocation = symbol<() => number>(library, "__error");
    return new MacOsNativeNoReplace({
      renamexNp: (oldPath, newPath) => renamexNp(ptr(oldPath), ptr(newPath), RENAME_EXCL),
      readErrno: () => read.i32(errorLocation()),
    });
  } catch (error) { library.close(); throw error; }
}

function windowsAdapter(loader: NativeLibraryLoader): NativeNoReplace {
  const library = loader("kernel32.dll", {
    MoveFileExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  try {
    const moveFileExW = symbol<(oldPath: number, newPath: number, flags: number) => number>(library, "MoveFileExW");
    const getLastError = symbol<() => number>(library, "GetLastError");
    return new WindowsNativeNoReplace({
      moveFileExW: (oldPath, newPath) => Number(moveFileExW(ptr(oldPath), ptr(newPath), 0)),
      getLastError: () => Number(getLastError()),
    });
  } catch (error) { library.close(); throw error; }
}

export function createNativeNoReplace(platform = process.platform, loader: NativeLibraryLoader = defaultLoader): NativeNoReplace {
  if (platform !== process.platform) throw unsupported(new Error(`NON_CURRENT_PLATFORM:${platform}`));
  try {
    if (platform === "linux") return linuxAdapter(loader);
    if (platform === "darwin") return macOsAdapter(loader);
    if (platform === "win32") return windowsAdapter(loader);
    throw unsupported(new Error(`UNSUPPORTED_PLATFORM:${platform}`));
  } catch (error) {
    if (error instanceof Error && error.message === "SERVICE_UNSUPPORTED") throw error;
    throw unsupported(error);
  }
}
