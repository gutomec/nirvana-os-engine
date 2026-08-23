import { mkdirSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { publishNoReplace, type NativeNoReplace } from "./no-replace.ts";
import { restrictDirectory, type WindowsAce } from "./permissions.ts";

export interface LockIdentity { readonly dev: number; readonly ino: number; }
export interface LockIo {
  candidate(operation: string): string;
  destination: string;
  mkdir(path: string): void;
  identity(path: string): LockIdentity;
  writeToken(path: string, token: Uint8Array): void;
  writeOwner(path: string, owner: unknown): void;
  secureAndSync(path: string): void;
  rereadAndValidate(path: string): void;
  removeIfIdentity(path: string, identity: LockIdentity): void;
  removeTokenIfOwned(path: string, token: Uint8Array): void;
  native: NativeNoReplace;
}

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function sameIdentity(left: LockIdentity, right: LockIdentity): boolean { return left.dev === right.dev && left.ino === right.ino; }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { return Buffer.from(left).equals(Buffer.from(right)); }

export function captureLockIdentity(path: string): LockIdentity {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("SERVICE_IO:LOCK_CANDIDATE_TYPE");
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function parseWindowsSddl(sddl: string): WindowsAce[] {
  const descriptor = sddl.match(/D:([^\r\n]+)/)?.[1];
  if (!descriptor) throw new Error("SERVICE_IO:LOCK_ACL_SDDL_MISSING");
  const aces: WindowsAce[] = [];
  for (const match of descriptor.matchAll(/\(([^;]*);[^;]*;([^;]*);[^;]*;[^;]*;([^)]+)\)/g)) {
    const type = match[1] === "A" ? "allow" : match[1] === "D" ? "deny" : undefined;
    if (!type) throw new Error("SERVICE_IO:LOCK_ACL_TYPE");
    aces.push({ sid: match[3] === "SY" ? "S-1-5-18" : match[3], type, rights: match[2] });
  }
  return aces;
}

function inspectWindowsAces(path: string): WindowsAce[] {
  const staging = mkdtempSync(join(tmpdir(), `glance-lock-acl-${basename(path)}-`));
  try {
    const saved = Bun.spawnSync(["icacls", path, "/save", "acl.txt"], { cwd: staging, stdout: "pipe", stderr: "pipe" });
    if (saved.exitCode !== 0) throw new Error("SERVICE_IO:LOCK_ACL_SAVE");
    const bytes = readFileSync(join(staging, "acl.txt"));
    const encoding = (bytes[0] === 0xff && bytes[1] === 0xfe) || bytes[1] === 0 ? "utf-16le" : "utf-8";
    return parseWindowsSddl(new TextDecoder(encoding).decode(bytes));
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

function restrictFreshLockDirectory(path: string, identity: LockIdentity): void {
  if (process.platform !== "win32") { restrictDirectory(path); return; }
  const logonSids = [...new Set(inspectWindowsAces(path)
    .filter(ace => ace.type === "allow" && ace.rights === "0x1200a9" && /^S-1-5-5-\d+-\d+$/.test(ace.sid))
    .map(ace => ace.sid))];
  if (logonSids.length > 1) throw new Error("SERVICE_IO:LOCK_LOGON_SID_AMBIGUOUS");
  for (const sid of logonSids) {
    const removed = Bun.spawnSync(["icacls", path, "/remove:g", `*${sid}`], { stdout: "pipe", stderr: "pipe" });
    if (removed.exitCode !== 0) throw new Error("SERVICE_IO:LOCK_LOGON_ACE_REMOVE");
  }
  restrictDirectory(path);
  if (!sameIdentity(identity, captureLockIdentity(path))) throw new Error("SERVICE_IO:LOCK_CANDIDATE_SUBSTITUTED");
}

export function createPrivateLockCandidateDirectory(path: string): LockIdentity {
  let identity: LockIdentity | undefined;
  try {
    mkdirSync(path, { mode: 0o700 });
    identity = captureLockIdentity(path);
    restrictFreshLockDirectory(path, identity);
    return identity;
  } catch (error) {
    if (identity) { try { removeLockCandidateIfOwned(path, identity, join(path, ".owner-token"), new Uint8Array()); } catch {} }
    throw error;
  }
}

export function removeLockTokenIfOwned(path: string, token: Uint8Array): void {
  let observed: Uint8Array;
  try { observed = readFileSync(path); }
  catch (error) { if (isMissing(error)) return; throw error; }
  if (!sameBytes(observed, token)) return;
  try { rmSync(path); }
  catch (error) { if (!isMissing(error)) throw error; }
}

export function removeLockCandidateIfOwned(path: string, identity: LockIdentity, tokenPath: string, token: Uint8Array): void {
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); }
  catch (error) { if (isMissing(error)) return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(identity, { dev: stat.dev, ino: stat.ino })) return;
  try {
    const observed = readFileSync(tokenPath);
    if (!sameBytes(observed, token)) return;
  } catch (error) { if (!isMissing(error)) throw error; }
  try { rmSync(path, { recursive: true }); }
  catch (error) { if (!isMissing(error)) throw error; }
}

export function acquireLock(io: LockIo, operation: string, token: Uint8Array, owner: unknown): string {
  const candidate = io.candidate(operation);
  let identity: LockIdentity | undefined;
  let published = false;
  let primary: unknown;
  const cleanup: unknown[] = [];
  try {
    io.mkdir(candidate);
    identity = io.identity(candidate);
    io.writeToken(candidate, token);
    io.writeOwner(candidate, owner);
    io.secureAndSync(candidate);
    io.rereadAndValidate(candidate);
    publishNoReplace(io.native, candidate, io.destination);
    published = true;
  } catch (error) { primary = error; }

  if (!published) {
    if (identity) { try { io.removeIfIdentity(candidate, identity); } catch (error) { cleanup.push(error); } }
    try { io.removeTokenIfOwned(candidate, token); } catch (error) { cleanup.push(error); }
  }

  if (primary !== undefined) {
    if (primary instanceof Error) { if (cleanup.length) Object.assign(primary, { cleanup }); throw primary; }
    const error = new Error("LOCK_ACQUISITION_FAILED", { cause: primary });
    if (cleanup.length) Object.assign(error, { cleanup });
    throw error;
  }
  if (cleanup.length) throw new Error("SERVICE_IO:LOCK_CLEANUP", { cause: cleanup });
  return io.destination;
}
