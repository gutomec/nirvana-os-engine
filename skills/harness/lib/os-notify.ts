// os-notify.ts — best-effort desktop notification.
//
// The owner is not staring at the terminal that dispatched the work. A run that
// finishes, is withheld by the gate, or dies has to reach them where they are;
// the audit log and the ledger are evidence, not notice.
//
// Every call is fire-and-forget: detached, unref'd, output discarded, wrapped in
// try/catch. A notifier that can block or throw would turn "we told you" into
// "we hung on telling you", which is worse than silence.

import { spawn } from "node:child_process";

/** Opt out for tests, CI, and anyone who does not want the popups. */
function suppressed(): boolean {
  return Boolean(process.env.NIRVANA_NO_DESKTOP_NOTIFY || process.env.CI);
}

function fire(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => { /* notifier absent — never fatal */ });
    child.unref();
  } catch { /* best-effort */ }
}

/**
 * Show `message` under `title` on the user's desktop, when the platform offers a
 * way. macOS uses osascript; Linux uses notify-send when installed; Windows uses
 * a PowerShell balloon (no external module, works on a default install).
 *
 * Returns nothing on purpose: no caller should branch on whether a popup
 * appeared, and none should wait for it.
 */
export function notifyDesktop(title: string, message: string): void {
  if (suppressed()) return;
  const text = message.replace(/\s+/g, " ").trim().slice(0, 240);
  if (!text) return;

  if (process.platform === "darwin") {
    fire("osascript", ["-e", `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`]);
    return;
  }
  if (process.platform === "linux") {
    fire("notify-send", [title, text]);
    return;
  }
  if (process.platform === "win32") {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$n = New-Object System.Windows.Forms.NotifyIcon;",
      "$n.Icon = [System.Drawing.SystemIcons]::Information;",
      "$n.Visible = $true;",
      `$n.ShowBalloonTip(10000, ${psQuote(title)}, ${psQuote(text)}, [System.Windows.Forms.ToolTipIcon]::Info);`,
      "Start-Sleep -Seconds 10; $n.Dispose()",
    ].join(" ");
    fire("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps]);
  }
}

/** PowerShell single-quoted literal: the only escape inside one is '' for '. */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
