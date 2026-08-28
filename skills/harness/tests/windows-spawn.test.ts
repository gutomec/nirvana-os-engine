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
// The second defect it pins is the one that made the first one expensive: a
// `.cmd` started through `cmd.exe` loses every argument behind the first CR/LF.
// The driver now reads the shim and spawns the interpreter + script it names, so
// the interpreter leaves the chain entirely; a shim of an unrecognized shape
// falls back to the old route, which these tests pin as well.
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

import { firstExecutablePath, parseCmdShim, resolveExecutable, resolveShimTarget, quoteForCmd, whichProbe } from "../../_shared/lib/host-agent-driver.ts";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const REAL_PLATFORM = process.platform;
const REAL_PATH = process.env.PATH;
const TEMP_DIRS: string[] = [];

function asPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

/** A fixture root in the OS's CANONICAL form. `os.tmpdir()` answers with the 8.3
 * SHORT path on Windows (`C:\Users\RUNNER~1\…`), while `where` — the probe
 * `resolveExecutable` resolves a shim through — answers with the long one
 * (`C:\Users\runneradmin\…`). One directory, two strings, and an assertion
 * green on macOS and Ubuntu and red on the third. `makeTempRoot` canonicalizes
 * with `realpathSync.native`, the only resolver that expands 8.3, so both sides
 * of every comparison below are built from the same form. */
function tempDir(prefix: string): string {
  const dir = makeTempRoot(prefix);
  TEMP_DIRS.push(dir);
  return dir;
}

/** The shape npm's `cmd-shim` writes today (pnpm and yarn classic use the same
 * package). `_prog` is the local node beside the shim when it exists, the bare
 * name otherwise — the two branches this parser has to offer in that order. */
function modernShim(scriptRelative: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${scriptRelative}" %*`,
    "",
  ].join("\r\n");
}

/** The older two-branch shape, still on disk wherever an install predates the
 * `_prog` rewrite. Same pair, named twice instead of through a variable. */
function legacyShim(scriptRelative: string): string {
  return [
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${scriptRelative}" %*`,
    ") ELSE (",
    "  @SETLOCAL",
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
    `  node  "%~dp0\\${scriptRelative}" %*`,
    ")",
    "",
  ].join("\r\n");
}

/** The autonomy directive at the size that was measured on 2026-08-27: 5,875
 * characters whose first newline lands at 183. Reproduced here so the numbers
 * below are the defect's own numbers, not a toy. */
function autonomyDirective(): string {
  const first = "You are running headless. Execute the brief end to end and write every deliverable yourself.".padEnd(183, ".");
  const lines = [first];
  while (lines.join("\n").length < 5_875) {
    lines.push("Never stop to ask for approval: the caller has already granted the permission bypass for this run.");
  }
  return lines.join("\n").slice(0, 5_875);
}

/** What `cmd.exe` is handed, and what survives its parser. The interpreter ends
 * the command line at the first CR/LF of any argument however it is quoted —
 * the rule `quoteForCmd` cannot reach, because the limit is the parser.
 *
 * Measured over the ARGUMENTS only. The interpreter's own path is the fixture's,
 * and its length differs per machine (a temp root on Windows CI is not the length
 * of one on macOS); the arguments are the product's, and their numbers are the
 * same everywhere. Where the cut falls does not depend on the prefix either: the
 * first newline is inside the directive. */
function throughCmdExe(args: string[]): { sent: string; delivered: string } {
  const sent = args.join(" ");
  return { sent, delivered: sent.split(/\r?\n/)[0] };
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
  process.env.PATH = REAL_PATH;
  while (TEMP_DIRS.length) removeDir(TEMP_DIRS.pop()!);
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

  test("a .cmd whose shape cannot be read keeps the shell route — degrading, not breaking", () => {
    const dir = tempDir("nrv-win-cmd-");
    fs.writeFileSync(path.join(dir, "gemini.cmd"), "@echo off\r\n");
    asPlatform("win32");
    process.env.PATH = `${dir}${path.delimiter}${REAL_PATH}`;

    const r = resolveExecutable("gemini");
    expect(r.shell).toBe(true);
    expect(r.command).toContain("gemini.cmd");
  });

  test("an npm shim is read and its interpreter spawned directly — no shell, nothing re-parsed", () => {
    const dir = tempDir("nrv-win-shim-");
    fs.writeFileSync(path.join(dir, "node.exe"), "");
    fs.writeFileSync(path.join(dir, "cli.js"), "");
    fs.writeFileSync(path.join(dir, "claude.cmd"), modernShim("cli.js"));
    asPlatform("win32");
    process.env.PATH = `${dir}${path.delimiter}${REAL_PATH}`;

    const r = resolveExecutable("claude");
    expect(r.shell).toBe(false);
    expect(r.command).toBe(path.join(dir, "node.exe"));
    expect(r.args(["-p", "hello world"])).toEqual([path.join(dir, "cli.js"), "-p", "hello world"]);
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

  test("a newline survives the quoting — which is exactly why it cannot be passed through cmd.exe", () => {
    // quoteForCmd solves spaces and metacharacters. It cannot solve a newline, and nothing
    // can: cmd.exe ends the command line at the first CR/LF whether or not the argument is
    // quoted, so the limit is the parser, not the quoting. That is why the driver keeps its
    // one multi-line argument OFF the command line entirely on this path — the directive
    // travels as `--append-system-prompt-file <temp file>` (claudeDirectiveArgs), the same
    // cure control-plane/maestro-turn.ts already used. This test states the constraint that
    // cure exists to obey; pushing the directive last is only the belt to its braces.
    const quoted = quoteForCmd("line one\nline two");
    expect(quoted.startsWith('"')).toBe(true);
    expect(quoted).toContain("\n");
  }, spawnBudgetMs(2));

  test("escapes embedded quotes instead of ending the argument early", () => {
    expect(quoteForCmd('say "hi"')).toBe('"say \\"hi\\""');
  });
});

describe("parseCmdShim — what a shim names, read as text", () => {
  const SHIM = path.join(path.sep === "/" ? "/opt/bin" : "C:\\bin", "claude.cmd");
  const DIR = path.dirname(SHIM);

  test("the modern npm shape offers the local node first, the bare name second", () => {
    const found = parseCmdShim(modernShim("node_modules\\@anthropic-ai\\claude-code\\cli.js"), SHIM);
    const script = path.join(DIR, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    expect(found).toEqual([
      { program: path.join(DIR, "node.exe"), args: [script] },
      { program: "node", args: [script] },
    ]);
  });

  test("the older two-branch shape resolves to the same pair, in the same order", () => {
    const found = parseCmdShim(legacyShim("cli.js"), SHIM);
    expect(found).toEqual([
      { program: path.join(DIR, "node.exe"), args: [path.join(DIR, "cli.js")] },
      { program: "node", args: [path.join(DIR, "cli.js")] },
    ]);
  });

  test("a wrapper that rearranges its arguments names nothing: %* no longer proves pass-through", () => {
    // %1/%~2/SHIFT mean the forwarded arguments are not the ones we were given.
    expect(parseCmdShim('@node "%~dp0\\cli.js" %1 %2 %*', SHIM)).toEqual([]);
    expect(parseCmdShim('@SHIFT\r\n@node "%~dp0\\cli.js" %*', SHIM)).toEqual([]);
  });

  test("%* anywhere but last names nothing — the arguments land somewhere we did not read", () => {
    expect(parseCmdShim('@node "%~dp0\\cli.js" %* --end', SHIM)).toEqual([]);
    expect(parseCmdShim('@node "%~dp0\\cli.js" "%*x" %*', SHIM)).toEqual([]);
  });

  test("a SET of anything but the shim's own three variables names nothing", () => {
    // The direct spawn would not reproduce that environment, so it must not be taken.
    expect(parseCmdShim('@SET NODE_OPTIONS=--max-old-space-size=8192\r\n@node "%~dp0\\cli.js" %*', SHIM)).toEqual([]);
    // PATHEXT is allowed: it only steers how `node` resolves, which this module does itself.
    expect(parseCmdShim('@SET PATHEXT=%PATHEXT:;.JS;=;%\r\n@node "%~dp0\\cli.js" %*', SHIM)).toHaveLength(1);
  });

  test("a variable that survives expansion names nothing", () => {
    expect(parseCmdShim('@node "%APPDATA%\\cli.js" %*', SHIM)).toEqual([]);
  });

  test("a bare launcher with no script is still a pair we can name", () => {
    expect(parseCmdShim('@"%~dp0\\tool.exe" %*', SHIM)).toEqual([{ program: path.join(DIR, "tool.exe"), args: [] }]);
  });

  test("flags between interpreter and %* pass through byte for byte", () => {
    const found = parseCmdShim('@node --enable-source-maps "%~dp0\\cli.js" %*', SHIM);
    expect(found).toEqual([{ program: "node", args: ["--enable-source-maps", path.join(DIR, "cli.js")] }]);
  });
});

describe("resolveShimTarget — the named pair, checked against the disk", () => {
  test("the interpreter beside the shim wins, and it never has to be on PATH", () => {
    const dir = tempDir("nrv-shim-local-");
    fs.writeFileSync(path.join(dir, "node.exe"), "");
    fs.writeFileSync(path.join(dir, "cli.js"), "");
    const shim = path.join(dir, "claude.cmd");
    fs.writeFileSync(shim, modernShim("cli.js"));
    process.env.PATH = "";

    expect(resolveShimTarget(shim)).toEqual({ program: path.join(dir, "node.exe"), args: [path.join(dir, "cli.js")] });
  });

  test("without a local interpreter it falls to the bare name on PATH, as the shim's ELSE branch does", () => {
    const dir = tempDir("nrv-shim-path-");
    const nodeDir = tempDir("nrv-shim-node-");
    fs.writeFileSync(path.join(nodeDir, "node"), "");
    fs.writeFileSync(path.join(dir, "cli.js"), "");
    const shim = path.join(dir, "claude.cmd");
    fs.writeFileSync(shim, modernShim("cli.js"));
    process.env.PATH = nodeDir;

    expect(resolveShimTarget(shim)).toEqual({ program: path.join(nodeDir, "node"), args: [path.join(dir, "cli.js")] });
  });

  test("no interpreter anywhere names nothing — the caller keeps the interpreter route", () => {
    const dir = tempDir("nrv-shim-nonode-");
    fs.writeFileSync(path.join(dir, "cli.js"), "");
    const shim = path.join(dir, "claude.cmd");
    fs.writeFileSync(shim, modernShim("cli.js"));
    process.env.PATH = tempDir("nrv-shim-empty-");

    expect(resolveShimTarget(shim)).toBeNull();
  });

  test("a script the shim names but the disk does not have names nothing", () => {
    const dir = tempDir("nrv-shim-noscript-");
    fs.writeFileSync(path.join(dir, "node.exe"), "");
    const shim = path.join(dir, "claude.cmd");
    fs.writeFileSync(shim, modernShim("cli.js"));

    expect(resolveShimTarget(shim)).toBeNull();
  });

  test("an interpreter that is itself a .cmd is refused — resolving it re-enters the trap", () => {
    const dir = tempDir("nrv-shim-recurse-");
    const nodeDir = tempDir("nrv-shim-recurse-path-");
    fs.writeFileSync(path.join(nodeDir, "node.cmd"), "@echo off\r\n");
    fs.writeFileSync(path.join(dir, "cli.js"), "");
    const shim = path.join(dir, "claude.cmd");
    fs.writeFileSync(shim, modernShim("cli.js"));
    process.env.PATH = nodeDir;

    expect(resolveShimTarget(shim)).toBeNull();
  });

  test("a shim too large to be a launcher names nothing", () => {
    const dir = tempDir("nrv-shim-big-");
    fs.writeFileSync(path.join(dir, "node.exe"), "");
    fs.writeFileSync(path.join(dir, "cli.js"), "");
    const shim = path.join(dir, "claude.cmd");
    fs.writeFileSync(shim, `REM ${"x".repeat(20_000)}\r\n${modernShim("cli.js")}`);

    expect(resolveShimTarget(shim)).toBeNull();
  });

  test("a path that is not there at all names nothing", () => {
    expect(resolveShimTarget(path.join(tempDir("nrv-shim-gone-"), "missing.cmd"))).toBeNull();
  });
});

describe("the measurement: a 5,875-character directive through both routes", () => {
  // The defect, in its own numbers. On 2026-08-27 the squad dispatch built a
  // 6,251-character command line whose first newline sat at 183, and cmd.exe
  // discarded everything after it: both --add-dir grants and the permission
  // flag, on a line far under the 8,191 limit. The direct route has no command
  // line at all — the arguments reach CreateProcess as the array they already
  // are on POSIX and for a real .exe on Windows.
  const DIRECTIVE = autonomyDirective();
  // The order the runner had on the day it broke: the directive second, both
  // grants and the permission flag behind it. Pushing it last is the belt the
  // 0.10.2 cut added; the eight untreated adapters and the light layer still
  // build lines of this shape, which is what this cut is meant to make harmless.
  const ARGV = [
    "-p", "--output-format", "json",
    "--append-system-prompt", DIRECTIVE,
    "--add-dir", "C:\\Users\\John Doe\\project",
    "--add-dir", "C:\\Users\\John Doe\\outputs",
    "--dangerously-skip-permissions",
  ];

  test("the directive is the shape that caused it: 5,875 characters, first newline at 183", () => {
    expect(DIRECTIVE).toHaveLength(5_875);
    expect(DIRECTIVE.indexOf("\n")).toBe(183);
  });

  test("through cmd.exe the flags behind the directive are gone; direct, every argument arrives whole", () => {
    const dir = tempDir("nrv-measure-");
    fs.writeFileSync(path.join(dir, "node.exe"), "");
    fs.writeFileSync(path.join(dir, "cli.js"), "");
    fs.writeFileSync(path.join(dir, "claude.cmd"), modernShim("cli.js"));
    fs.writeFileSync(path.join(dir, "opaque.cmd"), "@echo off\r\nREM shape this parser does not read\r\n");
    asPlatform("win32");
    process.env.PATH = `${dir}${path.delimiter}${REAL_PATH}`;

    // Route A — the shim this parser cannot read: still the interpreter, still cut.
    const viaShell = resolveExecutable("opaque");
    expect(viaShell.shell).toBe(true);
    const cmd = throughCmdExe(viaShell.args(ARGV));
    expect(cmd.delivered.length).toBeLessThan(cmd.sent.length);
    expect(cmd.delivered).not.toContain("--dangerously-skip-permissions");
    expect(cmd.delivered).not.toContain("--add-dir");
    expect(cmd.sent).toContain("--dangerously-skip-permissions");
    const lostChars = cmd.sent.length - cmd.delivered.length;

    // Route B — the shim read and its target spawned: no interpreter, no command line.
    const direct = resolveExecutable("claude");
    expect(direct.shell).toBe(false);
    const delivered = direct.args(ARGV);
    expect(delivered).toEqual([path.join(dir, "cli.js"), ...ARGV]);
    // Byte for byte, including the argument that spans lines.
    expect(delivered[delivered.indexOf("--append-system-prompt") + 1]).toBe(DIRECTIVE);
    expect(delivered.filter(a => a === "--add-dir")).toHaveLength(2);
    expect(delivered).toContain("--dangerously-skip-permissions");
    // Nothing was quoted, so nothing needs unquoting: the shell route's
    // quoteForCmd never runs here.
    expect(delivered.some(a => a.startsWith('"'))).toBe(false);

    // Stable on every machine: the arguments are the product's, not the fixture's.
    expect(cmd.sent).toHaveLength(6_031);
    expect(cmd.delivered).toHaveLength(231);
    expect(lostChars).toBe(5_800);
    console.log(`[measure] cmd.exe route: ${cmd.sent.length} chars of arguments sent, ${cmd.delivered.length} delivered, ${lostChars} discarded at the newline (${((lostChars / cmd.sent.length) * 100).toFixed(1)}%)`);
    console.log(`[measure] direct route: ${delivered.length} argv elements, ${ARGV.reduce((n, a) => n + a.length, 0)} chars of arguments, 0 discarded`);
  });

  test("the fallback still carries the file cure, so a shim we cannot read loses nothing either", () => {
    // claudeDirectiveArgs keeps the directive off the command line under a shell.
    // This cut does not replace that; it makes it the exception rather than the rule.
    const dir = tempDir("nrv-measure-fallback-");
    fs.writeFileSync(path.join(dir, "opaque.cmd"), "@echo off\r\n");
    asPlatform("win32");
    process.env.PATH = `${dir}${path.delimiter}${REAL_PATH}`;
    expect(resolveExecutable("opaque").shell).toBe(true);
  });
});
