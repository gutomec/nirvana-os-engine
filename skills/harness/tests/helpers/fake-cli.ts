// fake-cli.ts — a fake agent CLI that exists on every OS the engine supports.
//
// The tests that matter most for the driver have to spawn a REAL process: the
// 300KB argv-limit checks, the STDIN delivery contract, the stall watchdog and
// the cascade failover are all about what happens between two processes, and a
// mocked function call would prove none of it.
//
// Those fakes used to be `#!/bin/bash` scripts. Windows resolves neither an
// extensionless file nor a bash shebang, so the whole driver surface failed
// there — 38 red tests that said nothing about the product, only about the
// harness. The engine is Bun/TypeScript precisely so it does not depend on
// shell; the fakes had quietly opted out of that.
//
// So the BODY is one TypeScript file, shared by both platforms, and the only
// per-OS part is a one-line launcher — unavoidable, because how a process is
// started is the operating system's decision:
//
//   POSIX    <name>      #!/bin/sh exec'ing bun on <name>.ts   (chmod 755)
//   Windows  <name>.cmd  @echo off + bun on <name>.ts          (found via PATHEXT)
//
// A Windows `.cmd` is exactly what npm installs for a real agent CLI, so these
// fakes now fail the same way real ones would — which is how the driver's own
// `.cmd` handling gets tested instead of assumed.
import * as fs from "node:fs";
import * as path from "node:path";

export const IS_WINDOWS = process.platform === "win32";

/**
 * Write a fake CLI callable as `<name>` on PATH.
 *
 * `body` is TypeScript run by Bun. It receives the usual globals; arguments are
 * in `Bun.argv.slice(2)` and STDIN, when the adapter uses it, is readable with
 * `await Bun.stdin.text()`.
 */
export function writeFakeCli(binDir: string, name: string, body: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, `${name}.ts`);
  fs.writeFileSync(scriptPath, body, "utf8");

  if (IS_WINDOWS) {
    // `%~dp0` keeps the launcher relocatable; the quotes survive a temp path
    // with spaces, which is the normal shape of a Windows user profile.
    fs.writeFileSync(
      path.join(binDir, `${name}.cmd`),
      `@echo off\r\nbun "%~dp0${name}.ts" %*\r\n`,
      { encoding: "ascii" },
    );
    return;
  }
  const launcher = path.join(binDir, name);
  fs.writeFileSync(launcher, `#!/bin/sh\nexec bun "$(dirname "$0")/${name}.ts" "$@"\n`, "utf8");
  fs.chmodSync(launcher, 0o755);
}

/** Read every argument the fake CLI was called with, as the test recorded them. */
export function readCapturedArgs(captureDir: string, name: string): string[] {
  const f = path.join(captureDir, `${name}-args.json`);
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return []; }
}

/**
 * Body prelude every fake shares: capture argv for the ARG_MAX assertions and
 * resolve how many bytes of prompt actually arrived, whichever channel the
 * adapter chose (STDIN, a `--prompt-file`, a bootstrap temp file, or argv).
 */
export const CAPTURE_PRELUDE = `
import * as fs from "node:fs";
import * as path from "node:path";

const argv = Bun.argv.slice(2);
const name = path.basename(import.meta.path).replace(/\\.ts$/, "");
const captureDir = process.env.FAKE_CAPTURE_DIR;
if (captureDir) {
  try { fs.writeFileSync(path.join(captureDir, name + "-args.json"), JSON.stringify(argv)); } catch {}
}

/** Bytes delivered through STDIN (0 when the adapter does not use it). */
async function stdinLen(): Promise<number> {
  try { return (await Bun.stdin.text()).length; } catch { return 0; }
}

/**
 * Bytes in the prompt file this run was given, whichever way it arrived:
 * as the value of \`--prompt-file\`, or embedded INSIDE a bootstrap instruction
 * ("read your prompt from /tmp/nrv-prompt-x.md and ..."), which is why the path
 * is searched for within an argument rather than matched against a whole one.
 */
function promptFileLen(): number {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prompt-file" && argv[i + 1]) {
      try { return fs.statSync(argv[i + 1]).size; } catch { /* keep looking */ }
    }
    const m = argv[i].match(/\\S*nrv-prompt-\\S*\\.md/);
    if (m) {
      try { return fs.statSync(m[0]).size; } catch { /* keep looking */ }
    }
  }
  return 0;
}
`;
