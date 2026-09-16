// fake-python.ts — a Python and a uv that exist only to be probed.
//
// The activator's Python branch has to be tested against machines we do not
// have: a broken `python` shim ahead of a working `python3`, a Python too old
// to prove anything, a pip that predates `--dry-run`, a machine with uv and
// one without. Each fake here is a POSIX shell script that answers the exact
// calls the activator makes and writes down every call, TAB-separated, so a
// test reads what was actually run instead of trusting a return value.
//
// POSIX only, like the injection fakes beside it: Windows cannot start a shell
// script by name, and the Windows-specific decision (candidate order) is a pure
// function tested without a process.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakePythonOptions {
  /** What `sys.version_info[:2]` reports. */
  version: string;
  /** A flag file: when it exists, `pip install --dry-run` answers "all satisfied". */
  satisfiedFlag: string;
  /** A flag file: when it exists, pip rejects `--dry-run` the way pip < 22.2 does. */
  oldPipFlag?: string;
  /** The interpreter exits 1 with a "not found" message, like a dead shim. */
  broken?: boolean;
}

/** The shell body of a fake interpreter. Used directly and copied into venvs. */
export function fakePythonBody(log: string, o: FakePythonOptions): string {
  const q = (s: string) => JSON.stringify(s);
  return [
    "#!/bin/sh",
    `LOG=${q(log)}`,
    // Absolute self path: the probe prints it as sys.executable, and `-m venv`
    // copies it, so the venv's python is this same script with a new $0.
    'SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"',
    'printf "CALL" >> "$LOG"; for a in "$@"; do printf "\\t%s" "$a" >> "$LOG"; done; printf "\\n" >> "$LOG"',
    ...(o.broken ? ['echo "python: error: Failed to locate \'python\'." >&2', "exit 1"] : []),
    'if [ "$1" = "--version" ]; then echo "Python ' + o.version + '"; exit 0; fi',
    'if [ "$1" = "-c" ]; then echo "' + o.version + ' $SELF"; exit 0; fi',
    'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then',
    '  D="$3"; mkdir -p "$D/bin"; echo "home = fake" > "$D/pyvenv.cfg"; cp "$SELF" "$D/bin/python"; chmod 755 "$D/bin/python"; exit 0',
    "fi",
    'if [ "$1" = "-m" ] && [ "$2" = "pip" ] && [ "$3" = "install" ]; then',
    '  case " $* " in *" --dry-run "*)',
    ...(o.oldPipFlag ? [`    if [ -f ${q(o.oldPipFlag)} ]; then echo "no such option: --dry-run" >&2; exit 2; fi`] : []),
    `    if [ -f ${q(o.satisfiedFlag)} ]; then echo '{"version":"1","pip_version":"fake","install":[]}'; exit 0; fi`,
    '    echo "ERROR: No matching distribution found" >&2; exit 1 ;;',
    "  esac",
    "  exit 0",
    "fi",
    "exit 0",
    "",
  ].join("\n");
}

/** Write a fake interpreter as `<binDir>/<name>`. */
export function fakePython(binDir: string, name: string, log: string, o: FakePythonOptions): string {
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, name);
  writeFileSync(bin, fakePythonBody(log, o), { mode: 0o755 });
  return bin;
}

/**
 * A fake uv: answers `--version`, creates a venv on `venv … <dir>` by copying
 * `pythonSrc` into it (so the venv's python is probe-able), and logs
 * `pip install --python <p> …` without installing anything.
 */
export function fakeUv(binDir: string, log: string, pythonSrc: string): string {
  const q = (s: string) => JSON.stringify(s);
  const bin = join(binDir, "uv");
  writeFileSync(bin, [
    "#!/bin/sh",
    `LOG=${q(log)}`,
    'printf "CALL" >> "$LOG"; for a in "$@"; do printf "\\t%s" "$a" >> "$LOG"; done; printf "\\n" >> "$LOG"',
    'if [ "$1" = "--version" ]; then echo "uv 0.0.0-fake"; exit 0; fi',
    'if [ "$1" = "venv" ]; then',
    '  for a in "$@"; do D="$a"; done',   // the last argument is the directory
    `  mkdir -p "$D/bin"; echo "home = fake-uv" > "$D/pyvenv.cfg"; cp ${q(pythonSrc)} "$D/bin/python"; chmod 755 "$D/bin/python"; exit 0`,
    "fi",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  return bin;
}

/**
 * Dead shims for every name the activator might probe, so nothing the RUNNER
 * happens to have can answer through `/usr/bin`. A test then overwrites the
 * ones it wants alive. Measured on ubuntu-latest: with `/usr/bin` on the
 * fixture's PATH and only `python3` faked, the runner's real `python` was
 * found, created a real venv and installed for real — the "no usable Python"
 * case reported `installed`.
 */
export const PROBED_NAMES = ["python", "python3", "py", "uv", "pip", "pip3"];
export function deadShims(binDir: string, names: string[] = PROBED_NAMES): void {
  mkdirSync(binDir, { recursive: true });
  for (const name of names) {
    writeFileSync(join(binDir, name), '#!/bin/sh\necho "' + name + ': not on this machine" >&2\nexit 1\n', { mode: 0o755 });
  }
}

/** Every recorded call of one fake, as argv arrays (the program name is not logged). */
export function callsOf(log: string): string[][] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("CALL")).map((l) => l.split("\t").slice(1));
}

/** Create a venv the way the fake interpreter does, without going through the activator. */
export function seedFakeVenv(venvDir: string, pythonSrc: string): void {
  mkdirSync(join(venvDir, "bin"), { recursive: true });
  writeFileSync(join(venvDir, "pyvenv.cfg"), "home = fake\n");
  writeFileSync(join(venvDir, "bin", "python"), readFileSync(pythonSrc), { mode: 0o755 });
}
