// finish-notice.ts — a desktop notification when a dispatch or a revision ends.
//
// The orchestrating agent learns of the end through its runtime, and a runtime
// can sit on that notice (a blocking dialog held one for eleven hours). This
// one goes to the user through the operating system, outside the agent.
// Best effort: it never throws, never blocks the exit and never fails the run.

import { spawn } from "node:child_process";
import { DEPTH_ENV } from "../../_shared/lib/dispatch-depth.ts";
import { resolveSetting } from "../../_shared/lib/settings.ts";

export interface NoticeCommand { cmd: string; args: string[]; env?: Record<string, string> }

// The title and the body never enter a script as text: AppleScript reads them
// from argv, PowerShell from the environment, notify-send takes them as argv.
const OSASCRIPT = ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv)", "end run"];
const POWERSHELL_BALLOON = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$n = New-Object System.Windows.Forms.NotifyIcon",
  "$n.Icon = [System.Drawing.SystemIcons]::Information",
  "$n.Visible = $true",
  "$n.ShowBalloonTip(10000, $env:NIRVANA_NOTICE_TITLE, $env:NIRVANA_NOTICE_BODY, [System.Windows.Forms.ToolTipIcon]::Info)",
  "Start-Sleep -Seconds 10",
  "$n.Dispose()",
].join("; ");

/** Control characters out, one line, bounded: what an OS notification shows. */
function oneLine(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

/** The command that shows the notice on `platform`; null where there is none. */
export function finishNoticeCommand(platform: NodeJS.Platform, title: string, body: string): NoticeCommand | null {
  const t = oneLine(title, 120);
  const b = oneLine(body, 240);
  if (platform === "darwin") return { cmd: "osascript", args: [...OSASCRIPT.flatMap((line) => ["-e", line]), t, b] };
  if (platform === "win32") {
    return {
      cmd: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", POWERSHELL_BALLOON],
      env: { NIRVANA_NOTICE_TITLE: t, NIRVANA_NOTICE_BODY: b },
    };
  }
  if (platform === "linux") return { cmd: "notify-send", args: ["--", t, b] };
  return null;
}

/** Off for a nested dispatch (it is not the user's), under a test run, and when
 *  `notify.on_finish` is false. `bun test` sets NODE_ENV=test, and that reaches
 *  the dispatches a test spawns even when the test strips every NIRVANA_ variable. */
export function finishNoticeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env[DEPTH_ENV] ?? "").trim() || env.NODE_ENV === "test") return false;
  try { return resolveSetting("notify.on_finish", { env }).value; } catch { return false; }
}

/** Tells the user, outside the agent, that `project` ended in `state`. */
export function notifyFinish(project: string, state: string, folder: string): void {
  try {
    if (!finishNoticeEnabled()) return;
    const command = finishNoticeCommand(process.platform, `Nirvana-OS: ${project} ${state}`, folder);
    if (!command) return;
    const child = spawn(command.cmd, command.args, {
      detached: true, stdio: "ignore", windowsHide: true,
      env: command.env ? { ...process.env, ...command.env } : process.env,
    });
    child.on("error", () => { /* no notifier on this machine */ });
    child.unref();
  } catch { /* a notice is never worth a failed run */ }
}
