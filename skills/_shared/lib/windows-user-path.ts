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
import * as fs from "node:fs";
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

/** The long form of a Windows path whose components may be 8.3 short names
 *  (C:\Users\RUNNER~1\...): TEMP is often set that way, while the registry holds
 *  what the installer expanded at the time. Only for paths that exist. */
function longForm(p: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  try { return fs.realpathSync.native(p); } catch { return undefined; }
}

/** The temporary roots a persisted PATH entry must never live under: the
 *  process tmpdir plus whatever %TEMP%, %TMP% and %LOCALAPPDATA%\Temp name, each
 *  in its short and long spelling. The affected entries were written under one
 *  shell's TEMP and may be inspected from another, so every candidate counts. */
export function tempRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [os.tmpdir(), env.TEMP, env.TMP, env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Temp") : undefined];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const c of candidates) {
    if (!c) continue;
    for (const form of [c, longForm(c)]) {
      if (!form) continue;
      const key = normalizeEntry(form);
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      roots.push(form);
    }
  }
  return roots;
}

export function isUnderTempRoot(entry: string, roots: string[] = tempRoots()): boolean {
  return roots.some((r) => isUnderRoot(entry, r));
}

/** PATH entries as stored, verbatim — empty entries included, so joining the
 *  survivors reproduces the original string minus what was removed. */
export function splitPath(value: string): string[] {
  return value.split(";");
}

export function joinPath(entries: string[]): string {
  return entries.join(";");
}

/** Expand %NAME% references the way a REG_EXPAND_SZ value is expanded, from the
 *  given env (names are case-insensitive). Unknown names stay as written. */
export function expandEnv(entry: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!entry.includes("%")) return entry;
  const byLowerName = new Map<string, string>();
  for (const [name, value] of Object.entries(env)) if (value !== undefined) byLowerName.set(name.toLowerCase(), value);
  return entry.replace(/%([^%]+)%/g, (whole, name: string) => byLowerName.get(name.toLowerCase()) ?? whole);
}

/** An entry the installer wrote from a temporary HOME: under one of the temp
 *  roots, with a directory segment carrying `nrv-` below that root
 *  (%TEMP%\nrv-buyer-abc\home\.local\bin). Anything else on the PATH is someone
 *  else's and is never touched. */
export function isTempNrvEntry(entry: string, roots: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  const expanded = expandEnv(entry, env);
  const root = roots.find((r) => isUnderRoot(expanded, r));
  if (!root) return false;
  const below = normalizeEntry(expanded).slice(normalizeEntry(root).length);
  return below.split("\\").some((segment) => segment.includes("nrv-"));
}

export function findTempNrvEntries(value: string, roots: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  return splitPath(value).filter((e) => isTempNrvEntry(e, roots, env));
}

export interface PathRepair { before: string[]; after: string[]; removed: string[] }

/** Drop exactly the temporary nrv entries. Every other entry keeps its text and
 *  its position; nothing is trimmed, expanded or de-duplicated on the way. */
export function removeTempNrvEntries(value: string, roots: string[], env: NodeJS.ProcessEnv = process.env): PathRepair {
  const before = splitPath(value);
  const removed: string[] = [];
  const after: string[] = [];
  for (const entry of before) (isTempNrvEntry(entry, roots, env) ? removed : after).push(entry);
  return { before, after, removed };
}

/** Drop exactly the entries that resolve (after %NAME% expansion) under `root`.
 *  Every other entry keeps its text and its position. This is the uninstall
 *  side of `wireLocalBinOnPath`'s persist step: that step writes the already
 *  expanded %USERPROFILE%\.local\bin, so removal has to match on the resolved
 *  form too, not the literal string. */
export function removeEntriesUnderRoot(value: string, root: string, env: NodeJS.ProcessEnv = process.env): PathRepair {
  const before = splitPath(value);
  const removed: string[] = [];
  const after: string[] = [];
  for (const entry of before) (isUnderRoot(expandEnv(entry, env), root) ? removed : after).push(entry);
  return { before, after, removed };
}

// ─── Registry access (Windows only) ───────────────────────────────────

export type UserPathKind = "String" | "ExpandString";
export interface UserPathValue { value: string; kind: UserPathKind }

function powershell(script: string, env?: NodeJS.ProcessEnv) {
  return spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", timeout: 15000, env });
}

/** HKCU\Environment\Path as stored — unexpanded, with its value kind — or null
 *  when there is no such value, no registry to ask, or a kind this module will
 *  not rewrite. Through PowerShell rather than `reg query` so the value arrives
 *  as UTF-8 whatever the console code page: an entry mangled on the way in
 *  would be written back mangled. */
export function readUserPath(): UserPathValue | null {
  if (process.platform !== "win32") return null;
  const script =
    "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}; " +
    "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); if ($null -eq $k) { exit 3 }; " +
    "$v=$k.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); if ($null -eq $v) { exit 3 }; " +
    "Write-Output ([string]$k.GetValueKind('Path')); Write-Output ([string]$v)";
  const r = powershell(script);
  if (r.status !== 0) return null;
  const lines = (r.stdout ?? "").split(/\r?\n/);
  const kind = lines[0]?.trim();
  if (kind !== "String" && kind !== "ExpandString") return null;
  return { value: lines[1] ?? "", kind };
}

/** Write HKCU\Environment\Path back with the kind it had. The value travels in
 *  an environment variable, not on the command line, so quoting and code pages
 *  cannot alter it. False when the write did not happen. */
export function writeUserPath(next: UserPathValue): boolean {
  if (process.platform !== "win32") return false;
  const script =
    "$v=[string]$env:NRV_USER_PATH; " +
    "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true); if ($null -eq $k) { exit 3 }; " +
    `$k.SetValue('Path',$v,[Microsoft.Win32.RegistryValueKind]::${next.kind}); Write-Output 'written'`;
  const r = powershell(script, { ...process.env, NRV_USER_PATH: next.value });
  return r.status === 0 && /written/.test(r.stdout ?? "");
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
