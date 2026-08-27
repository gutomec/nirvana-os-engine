// windows-spawn.test.ts — starting an agent CLI on Windows.
//
// The defect this pins: Windows CreateProcess only auto-appends `.exe`, never
// `.cmd` — and every agent CLI installed through npm IS a `.cmd`. The driver
// spawned the bare name, so the invocation died with ENOENT while `where`
// happily reported the runtime as available. Probe said yes, execution said no,
// and a Windows buyer could not dispatch at all. The installer had learned this
// rule long ago ("CreateProcess only auto-appends .exe, never .cmd"); the agent
// driver never received it.
//
// The win32 branch is exercised by faking `process.platform`, so the rule is
// verified on every machine that runs the suite rather than only on a Windows
// runner — which is the whole reason it went unnoticed. The fake has a limit
// worth stating: `path.delimiter` is decided by the REAL platform and stays ":"
// here, so these tests prove the resolution LOGIC, not Windows itself. Only a
// Windows runner proves that.
import { describe, expect, test, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { firstExecutablePath, resolveExecutable, quoteForCmd, whichProbe } from "../../_shared/lib/host-agent-driver.ts";

const REAL_PLATFORM = process.platform;
const REAL_PATH = process.env.PATH;

function asPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
  process.env.PATH = REAL_PATH;
});

describe("whichProbe", () => {
  test("on Windows the probe is `where <cli>`: Windows options take a slash, so a `-v` is a SECOND pattern", () => {
    expect(whichProbe("claude", "win32")).toEqual({ command: "where", args: ["claude"] });
  });

  test("on POSIX it stays the `command -v` builtin the PATH scan falls back from", () => {
    expect(whichProbe("claude", "linux")).toEqual({ command: "command", args: ["-v", "claude"] });
    expect(whichProbe("gemini", "darwin")).toEqual({ command: "command", args: ["-v", "gemini"] });
  });
});

describe("firstExecutablePath", () => {
  test("`where` prints CRLF, one line per match: the chosen path keeps no trailing carriage return", () => {
    const stdout = "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd\r\nC:\\Program Files\\claude\\claude.exe\r\n";
    const found = firstExecutablePath(stdout)!;
    expect(found).toBe("C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd");
    // The defect this pins: with the "\r" still attached, the extension test below fails and
    // resolveExecutable spawns a .cmd with no shell — probe says yes, invocation dies.
    expect(/\.(cmd|bat)$/i.test(found)).toBe(true);
  });

  test("blank lines are skipped and no output is null", () => {
    expect(firstExecutablePath("\r\n\r\nC:\\bin\\claude.cmd\r\n")).toBe("C:\\bin\\claude.cmd");
    expect(firstExecutablePath("   \r\n")).toBeNull();
    expect(firstExecutablePath("")).toBeNull();
  });
});

describe("resolveExecutable", () => {
  test("on POSIX it is the identity — same command, same args, no shell", () => {
    asPlatform("linux");
    const r = resolveExecutable("gemini");
    expect(r.command).toBe("gemini");
    expect(r.shell).toBe(false);
    expect(r.args(["-p", "hello world"])).toEqual(["-p", "hello world"]);
  });

  test("on Windows a .cmd is routed through a shell, which is the only way to start one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-win-cmd-"));
    fs.writeFileSync(path.join(dir, "gemini.cmd"), "@echo off\r\n");
    asPlatform("win32");
    process.env.PATH = `${dir}${path.delimiter}${REAL_PATH}`;

    const r = resolveExecutable("gemini");
    expect(r.shell).toBe(true);
    expect(r.command).toContain("gemini.cmd");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("on Windows a real .exe is spawned directly — no shell, nothing re-parsed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-win-exe-"));
    fs.writeFileSync(path.join(dir, "codex.exe"), "");
    asPlatform("win32");
    process.env.PATH = `${dir}${path.delimiter}${REAL_PATH}`;

    const r = resolveExecutable("codex");
    expect(r.shell).toBe(false);
    expect(r.command).toContain("codex.exe");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("an unknown CLI keeps its name, so the spawn reports an honest ENOENT", () => {
    asPlatform("win32");
    process.env.PATH = "";
    const r = resolveExecutable("definitely-not-installed");
    expect(r.command).toBe("definitely-not-installed");
    expect(r.shell).toBe(false);
  });
});

describe("quoteForCmd", () => {
  test("leaves ordinary arguments untouched", () => {
    expect(quoteForCmd("--model")).toBe("--model");
    expect(quoteForCmd("gemini-3-pro")).toBe("gemini-3-pro");
  });

  test("quotes a path with spaces — the normal shape of a Windows profile", () => {
    // Unquoted, `C:\Users\John Doe\...` becomes two arguments and the CLI fails
    // for a reason nobody can guess from the message.
    expect(quoteForCmd("C:\\Users\\John Doe\\prompt.md")).toBe('"C:\\Users\\John Doe\\prompt.md"');
  });

  test("quotes shell metacharacters, which a shell would otherwise interpret", () => {
    for (const arg of ["a&b", "a|b", "a>b", "a<b", "a^b", "(a)"]) {
      expect(quoteForCmd(arg).startsWith('"')).toBe(true);
    }
  });

  test("an empty argument survives as an empty argument", () => {
    // gemini's adapter passes `-p ""`; losing it changes the command's meaning.
    expect(quoteForCmd("")).toBe('""');
  });

  test("escapes embedded quotes instead of ending the argument early", () => {
    expect(quoteForCmd('say "hi"')).toBe('"say \\"hi\\""');
  });
});
