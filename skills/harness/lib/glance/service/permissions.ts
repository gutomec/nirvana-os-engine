import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export class ServicePermissionError extends Error {}

export interface WindowsAce { sid: string; type: "allow" | "deny"; rights: string; }

export function assertPrivateMode(path: string, expected: number): void {
  if (process.platform !== "win32" && (statSync(path).mode & 0o777) !== expected) throw new ServicePermissionError("POSIX_PRIVATE_MODE");
}

export function assertWindowsAclPrivate(principals: readonly string[], currentUser: string): void {
  const allowed = new Set([currentUser.trim().toUpperCase(), "SYSTEM", "NT AUTHORITY\\SYSTEM", "NT\\SISTEMA"]);
  if (!principals.length || principals.some(principal => !allowed.has(principal.trim().toUpperCase()))) throw new ServicePermissionError("WINDOWS_FOREIGN_PRINCIPAL");
}

export function assertWindowsAclSids(aces: readonly WindowsAce[], currentUserSid: string, logonSid: string | undefined): void {
  const fullControlSids = new Set([currentUserSid, "S-1-5-18"]);
  const validLogon = (ace: WindowsAce) => logonSid !== undefined && ace.sid === logonSid && ace.rights === "0x1200a9";
  const valid = (ace: WindowsAce) => ace.type === "allow" && ((fullControlSids.has(ace.sid) && ace.rights === "FA") || validLogon(ace));
  if (!aces.length || aces.some(ace => !valid(ace))) throw new ServicePermissionError("WINDOWS_ACL_NOT_PRIVATE");
}

function currentUserSid(): string {
  const result = Bun.spawnSync(["whoami", "/user", "/fo", "csv", "/nh"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new ServicePermissionError("WINDOWS_IDENTITY_READ");
  const sid = new TextDecoder().decode(result.stdout).match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new ServicePermissionError("WINDOWS_CURRENT_SID_MISSING");
  return sid;
}

function parseWindowsSddl(sddl: string): WindowsAce[] {
  const descriptor = sddl.match(/D:([^\r\n]+)/)?.[1];
  if (!descriptor) throw new ServicePermissionError("WINDOWS_ACL_SDDL_MISSING");
  const aces: WindowsAce[] = [];
  for (const match of descriptor.matchAll(/\(([^;]*);[^;]*;([^;]*);[^;]*;[^;]*;([^)]+)\)/g)) {
    const type = match[1] === "A" ? "allow" : match[1] === "D" ? "deny" : undefined;
    if (!type) throw new ServicePermissionError("WINDOWS_ACL_TYPE");
    aces.push({ sid: match[3] === "SY" ? "S-1-5-18" : match[3], type, rights: match[2] });
  }
  return aces;
}

function inspectWindowsAces(path: string): WindowsAce[] {
  const staging = join(dirname(path), `.${basename(path)}.${randomUUID()}.acl`);
  try {
    mkdirSync(staging, { mode: 0o700 });
    const saved = Bun.spawnSync(["icacls", path, "/save", "acl.txt"], { cwd: staging, stdout: "pipe", stderr: "pipe" });
    if (saved.exitCode !== 0) throw new ServicePermissionError("WINDOWS_ACL_SAVE");
    const bytes = readFileSync(join(staging, "acl.txt"));
    const encoding = (bytes[0] === 0xff && bytes[1] === 0xfe) || bytes[1] === 0 ? "utf-16le" : "utf-8";
    return parseWindowsSddl(new TextDecoder(encoding).decode(bytes));
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

function restrictWindows(path: string, capturedLogonSid?: string): void {
  const currentUser = process.env.USERNAME;
  if (!currentUser) throw new ServicePermissionError("WINDOWS_CURRENT_USER_UNAVAILABLE");
  const result = Bun.spawnSync(["icacls", path, "/inheritance:r", "/grant:r", `${currentUser}:(F)`], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new ServicePermissionError("WINDOWS_ACL_SET");
  const userSid = currentUserSid();
  assertWindowsAclSids(inspectWindowsAces(path), userSid, capturedLogonSid);
}

export function restrictDirectory(path: string): void { if (process.platform === "win32") restrictWindows(path); else { chmodSync(path, 0o700); assertPrivateMode(path, 0o700); } }
export function restrictFile(path: string): void { if (process.platform === "win32") restrictWindows(path); else { chmodSync(path, 0o600); assertPrivateMode(path, 0o600); } }

function assertFreshFileIdentity(path: string, descriptor: number): void {
  const opened = fstatSync(descriptor), named = lstatSync(path);
  if (opened.dev !== named.dev || opened.ino !== named.ino) throw new ServicePermissionError("FRESH_FILE_IDENTITY");
}

export function restrictFreshFile(path: string, descriptor: number): void {
  assertFreshFileIdentity(path, descriptor);
  if (process.platform === "win32") {
    const candidates = [...new Set(inspectWindowsAces(path).filter(ace => ace.type === "allow" && ace.rights === "0x1200a9").map(ace => ace.sid))];
    if (candidates.length > 1) throw new ServicePermissionError("WINDOWS_FRESH_LOGON_AMBIGUOUS");
    restrictWindows(path, candidates[0]);
  } else { chmodSync(path, 0o600); assertPrivateMode(path, 0o600); }
  assertFreshFileIdentity(path, descriptor);
}

export function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try { descriptor = openSync(path, "r"); try { fsyncSync(descriptor); } catch (cause) { const code = (cause as NodeJS.ErrnoException).code; if (process.platform !== "win32" || !["EPERM", "EINVAL", "EBADF"].includes(code ?? "")) throw cause; } }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
