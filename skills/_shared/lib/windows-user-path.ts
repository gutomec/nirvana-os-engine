// windows-user-path.ts — the user PATH Windows keeps in the registry, and what
// the engine may put there.
//
// On Windows the user PATH is a registry value (HKCU\Environment\Path), and the
// installer persists %USERPROFILE%\.local\bin into it so `nrv` resolves in new
// terminals. The `User` target is the account running the process, whatever
// USERPROFILE says: a test that ran the installer with a fake HOME under %TEMP%
// wrote that fake path into the real hive, and nothing removed it after the
// directory was deleted (issue #87: 22 entries on one machine, most pointing
// nowhere). This module holds the guard the installer applies before
// persisting, the detection `nrv doctor` runs, the removal
// `nrv install --repair-path` performs, and the registry access they share.
//
// The string logic is pure and uses Windows PATH semantics whatever the host
// (case-insensitive, `;` between entries, either separator), so it is tested on
// every platform; only the registry access is Windows-only.
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

/** Set to "1" to keep the installer from persisting ~/.local/bin anywhere (the
 *  Windows registry, a POSIX shell startup file). The current process still gets
 *  the entry on its own PATH. Every test that runs an installer in a fake HOME
 *  sets it — see skills/harness/tests/helpers/fake-home.ts. */
export const SKIP_PATH_PERSIST_ENV = "NIRVANA_SKIP_PATH_PERSIST";

export function skipPathPersist(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SKIP_PATH_PERSIST_ENV] === "1";
}

/** Normalize an entry for comparison only: trimmed, backslashes, no trailing
 *  separator, lower case. Never written back — entries are kept verbatim. */
function normalizeEntry(entry: string): string {
  return entry.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/** `entry` is `root` itself or lies below it. */
export function isUnderRoot(entry: string, root: string): boolean {
  const e = normalizeEntry(entry);
  const r = normalizeEntry(root);
  return r !== "" && (e === r || e.startsWith(r + "\\"));
}

/** The temporary roots a persisted PATH entry must never live under: the
 *  process tmpdir plus whatever %TEMP%, %TMP% and %LOCALAPPDATA%\Temp name. The
 *  affected entries were written under one shell's TEMP and may be inspected
 *  from another, so every candidate counts. */
export function tempRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [os.tmpdir(), env.TEMP, env.TMP, env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Temp") : undefined];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const c of candidates) {
    if (!c) continue;
    const key = normalizeEntry(c);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    roots.push(c);
  }
  return roots;
}

export function isUnderTempRoot(entry: string, roots: string[] = tempRoots()): boolean {
  return roots.some((r) => isUnderRoot(entry, r));
}

/** Best-effort WM_SETTINGCHANGE (0x1A) to HWND_BROADCAST, so an already-running
 *  Explorer reloads its environment block and terminals opened afterwards
 *  inherit the new user PATH without a logoff. Runs in its own process and its
 *  own try: a failure here can never undo a registry write that already
 *  happened. */
export function broadcastEnvironmentChange(): void {
  const ps =
    "$s='[DllImport(\"user32.dll\")] public static extern int SendMessageTimeout(IntPtr h,int m,IntPtr w,string l,int f,int t,out IntPtr r);'; " +
    "Add-Type -MemberDefinition $s -Name W -Namespace N | Out-Null; " +
    "$r=[IntPtr]::Zero; [void][N.W]::SendMessageTimeout([IntPtr]0xffff,0x1A,[IntPtr]::Zero,'Environment',2,5000,[ref]$r)";
  try { spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { encoding: "utf8", timeout: 8000 }); } catch { /* best-effort */ }
}
