/**
 * When Bun is missing, every entry point has to name the command.
 *
 * Bun is the whole runtime, and three places can be the first to notice it is
 * gone. The bootstrap on POSIX (setup.sh) already answered well: exact command,
 * chained with the next step, plus the warning against `npm install -g bun`.
 * The other two did not. setup.ps1 sent the buyer to a website while holding the
 * command it had just tried three lines above, and the `nrv` launchers — the
 * ones that fail LATER, on a machine whose ~/.bun was wiped — printed "bun not
 * found" and stopped.
 *
 * The POSIX launcher is EXECUTED here, with a PATH that has no bun and a HOME
 * with no ~/.bun: a test that only covers the happy path proves nothing about a
 * message that exists solely for the unhappy one. `uname` is faked per case, so
 * the Git Bash branch is exercised for real from macOS or Linux.
 *
 * The two that cannot run here — setup.ps1 and the nrv.cmd that scripts/install.ts
 * generates — are asserted at the source, including the cmd.exe escaping that
 * decides whether the message prints at all or ends its own `if` block early.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const IS_WINDOWS = process.platform === "win32";
const read = (...p: string[]) => fs.readFileSync(path.join(REPO, ...p), "utf8");

let root: string;

beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-nobun-")); });
afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

/**
 * Run `bin/nrv` in a world with no Bun at all: PATH holds only a directory we
 * built, and HOME is a fresh temp dir, so neither `command -v bun` nor the
 * `$HOME/.bun/bin/bun` fallback can succeed. `unameOutput: null` leaves the
 * directory empty, which is also how the script behaves where `uname` itself is
 * unavailable — under `set -euo pipefail` that path must still guide, not abort.
 */
function runWithoutBun(caseName: string, unameOutput: string | null): { code: number; err: string } {
  const dir = path.join(root, caseName);
  const home = path.join(dir, "home");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  if (unameOutput !== null) {
    const fake = path.join(bin, "uname");
    fs.writeFileSync(fake, `#!/bin/sh\necho ${unameOutput}\n`);
    fs.chmodSync(fake, 0o755);
  }
  const r = spawnSync("/bin/bash", [path.join(REPO, "bin", "nrv"), "route", "brief"], {
    encoding: "utf8",
    env: { PATH: bin, HOME: home },
  });
  return { code: r.status ?? -1, err: `${r.stderr ?? ""}` };
}

describe("bin/nrv, with no bun on PATH and none in HOME", () => {
  test.skipIf(IS_WINDOWS)("names the curl installer on a Unix kernel", () => {
    for (const kernel of ["Darwin", "Linux"]) {
      const { code, err } = runWithoutBun(`unix-${kernel}`, kernel);
      expect(code).toBe(1);
      expect(err).toContain("bun not found");
      expect(err).toContain("curl -fsSL https://bun.sh/install | bash");
      // The trap setup.sh already warns about, on the launcher that fails later.
      expect(err).toContain("npm install -g bun");
      // One system, one command: a reader who has to choose can choose wrong.
      expect(err).not.toContain("winget");
    }
  });

  test.skipIf(IS_WINDOWS)("names the PowerShell installer and winget under Git Bash", () => {
    for (const kernel of ["MINGW64_NT-10.0-22631", "MSYS_NT-10.0", "CYGWIN_NT-10.0"]) {
      const { code, err } = runWithoutBun(`win-${kernel.slice(0, 6)}`, kernel);
      expect(code).toBe(1);
      expect(err).toContain('powershell -c "irm bun.sh/install.ps1 | iex"');
      // The way out when the execution policy blocks the one-liner, which is the
      // likeliest reason it failed on a managed Windows machine.
      expect(err).toContain("winget install Oven-sh.Bun");
      expect(err).not.toContain("curl -fsSL");
    }
  });

  test.skipIf(IS_WINDOWS)("still guides when uname itself is unavailable", () => {
    const { code, err } = runWithoutBun("no-uname", null);
    expect(code).toBe(1);
    expect(err).toContain("curl -fsSL https://bun.sh/install | bash");
  });

  test.skipIf(IS_WINDOWS)("tells someone who already installed it what to do next", () => {
    const { err } = runWithoutBun("already", "Darwin");
    expect(err).toMatch(/new terminal/i);
    expect(err).toContain(".bun/bin");
  });
});

describe("setup.ps1 answers as well as setup.sh does", () => {
  const PS1 = read("packaging", "pack", "setup.ps1");
  const failure = PS1.slice(PS1.indexOf("Nao consegui instalar o Bun"));

  test("it prints the command it just tried, instead of a website", () => {
    expect(failure).toContain('powershell -c "irm bun.sh/install.ps1 | iex"');
    expect(PS1).not.toContain("Instale manualmente: https://bun.sh");
  });

  test("it chains the next step, the way setup.sh does", () => {
    expect(failure).toContain("powershell -ExecutionPolicy Bypass -File setup.ps1");
  });

  test("it offers winget for the execution-policy case", () => {
    expect(failure).toContain("winget install Oven-sh.Bun");
  });

  test("it names the new-terminal gotcha", () => {
    expect(failure).toMatch(/terminal novo/i);
  });

  // Split on BOTH terminators. .gitattributes now pins .ps1 to CRLF, and this has
  // to hold on a tree cloned before that pin or with core.autocrlf off. The `\r`
  // is dropped as a LINE ENDING, never admitted to the pattern: a stray CR inside
  // a string is still a failure, which is the whole point of matching printable
  // ASCII and nothing else. Widening the character class instead would have let
  // the next control character through in silence.
  const writeHostLines = (src: string) =>
    src.split(/\r?\n/).filter(l => l.trim().startsWith("Write-Host"));

  // PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so an accented console string
  // reaches the buyer as mojibake. Comments keep their accents; output does not.
  test("everything Write-Host prints stays ASCII", () => {
    const lines = writeHostLines(PS1);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^[\x20-\x7E]*$/);
  });

  // The assertion has to answer the same way however the file arrived. Reading
  // it under one convention and asserting under the other is what turned the
  // Windows smoke job red while macOS and Ubuntu stayed green.
  test("it holds under either checkout convention", () => {
    for (const src of [PS1.replace(/\r?\n/g, "\r\n"), PS1.replace(/\r\n/g, "\n")]) {
      const lines = writeHostLines(src);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).toMatch(/^[\x20-\x7E]*$/);
    }
  });
});

describe("the generated nrv.cmd answers the same way", () => {
  const INSTALL = read("scripts", "install.ts");
  const LAUNCHER = INSTALL.slice(
    INSTALL.indexOf("function windowsLauncherNrv("),
    INSTALL.indexOf("function copyBinaries("),
  );

  /** The lines the launcher will really emit, unwrapped from their TS quotes. */
  const echoes = LAUNCHER.split("\n")
    .map(l => l.trim())
    .filter(l => /^["'].*\becho\b/.test(l))
    .map(l => l.replace(/^["']/, "").replace(/["'],?$/, ""));

  test("it prints the commands rather than a bare bun.sh link", () => {
    const text = echoes.join("\n");
    expect(text).toContain('powershell -c "irm bun.sh/install.ps1 ^| iex"');
    expect(text).toContain("winget install Oven-sh.Bun");
    expect(LAUNCHER).not.toContain("echo nrv requires Bun. Install: https://bun.sh");
  });

  // A raw `|` redirects and a raw `)` closes the enclosing `if (` block, so an
  // unescaped one does not merely print wrong — it truncates the message and
  // leaves cmd.exe parsing the rest as commands.
  test("every echo is escaped for cmd.exe", () => {
    expect(echoes.length).toBeGreaterThan(0);
    for (const line of echoes) expect(line).not.toMatch(/(?<!\^)[|()]/);
  });
});
