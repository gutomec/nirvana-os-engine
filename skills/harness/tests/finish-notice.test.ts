// finish-notice.test.ts — the command each platform runs for the end-of-run
// notice, and when the notice stays off. Nothing here spawns it.
import { describe, expect, test } from "bun:test";
import { finishNoticeCommand, finishNoticeEnabled } from "../lib/finish-notice.ts";

const TITLE = 'Nirvana-OS: 20261113-site"; rm -rf $HOME delivered';
const BODY = "C:\\Users\\Ana Souza\\outputs\\20261113-site\\deliverables";

describe("finishNoticeCommand", () => {
  test("macOS: osascript reads the title and the body from argv, never from the script", () => {
    const command = finishNoticeCommand("darwin", TITLE, BODY)!;
    expect(command.cmd).toBe("osascript");
    expect(command.args.slice(-2)).toEqual([TITLE, BODY]);
    const script = command.args.slice(0, -2);
    expect(script.filter((arg) => arg === "-e").length).toBe(3);
    expect(script.join(" ")).not.toContain("rm -rf");
    expect(script).toContain("display notification (item 2 of argv) with title (item 1 of argv)");
  });

  test("Windows: PowerShell reads both from the environment, never from the command", () => {
    const command = finishNoticeCommand("win32", TITLE, BODY)!;
    expect(command.cmd).toBe("powershell.exe");
    expect(command.env).toEqual({ NIRVANA_NOTICE_TITLE: TITLE, NIRVANA_NOTICE_BODY: BODY });
    expect(command.args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command"]);
    const script = command.args[5];
    expect(script).toContain("System.Windows.Forms.NotifyIcon");
    expect(script).toContain("$env:NIRVANA_NOTICE_TITLE");
    expect(script).not.toContain("rm -rf");
    expect(script).not.toContain("Ana Souza");
  });

  test("Linux: notify-send takes both as arguments after --", () => {
    expect(finishNoticeCommand("linux", TITLE, BODY)).toEqual({ cmd: "notify-send", args: ["--", TITLE, BODY] });
  });

  test("a platform with no notifier gets no command", () => {
    expect(finishNoticeCommand("freebsd", TITLE, BODY)).toBeNull();
  });

  test("control characters and length are bounded", () => {
    const command = finishNoticeCommand("linux", "a\nb\u0007c", "x".repeat(500))!;
    expect(command.args[1]).toBe("a b c");
    expect(command.args[2].length).toBe(240);
  });
});

describe("finishNoticeEnabled", () => {
  const layers = { NIRVANA_HOME: "/nonexistent-nirvana-home", NIRVANA_PROJECT_ROOT: "/nonexistent-nirvana-project" };
  test("on by default", () => {
    expect(finishNoticeEnabled({ ...layers })).toBe(true);
  });
  test("off when notify.on_finish is off", () => {
    expect(finishNoticeEnabled({ ...layers, NIRVANA_NOTIFY_ON_FINISH: "off" })).toBe(false);
  });
  test("off for a nested dispatch", () => {
    expect(finishNoticeEnabled({ ...layers, NIRVANA_DISPATCH_DEPTH: "1" })).toBe(false);
  });
  test("off under a test run, whose spawned dispatches may carry no NIRVANA_ variable", () => {
    expect(finishNoticeEnabled({ ...layers, NODE_ENV: "test" })).toBe(false);
  });
  test("the test preload switches it off for the suite", () => {
    expect(process.env.NIRVANA_NOTIFY_ON_FINISH).toBe("off");
    expect(finishNoticeEnabled()).toBe(false);
  });
});
