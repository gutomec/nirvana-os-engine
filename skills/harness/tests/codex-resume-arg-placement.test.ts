// codex-resume-arg-placement.test.ts — where a flag sits decides whether a
// resumed Codex run happens at all.
//
// `codex exec` and `codex exec resume` do not accept the same flags. Four that
// the driver relies on live ONLY on the `exec` parent (audited against
// codex-cli 0.155.1, 2026-09-20):
//
//   -C/--cd            the working root
//   --add-dir          the extra writable grants
//   --approve-for-me   the reviewed-approval path
//   -s/--sandbox       what --approve-for-me falls back to on an older CLI
//
// The adapter used to append all of them AFTER the subcommand, so a resumed run
// got `codex exec resume <id> ... -C <cwd>` and clap answered
// `error: unexpected argument '-C' found` with exit 2, before reaching the
// model. That is not a degraded run: `-C` is absent from the adapter's
// `droppable` set, so the unknown-flag retry cannot rescue it and the resume
// fails outright. Every `nrv revise` on Codex died there.
//
// Hermetic: a fake `codex` on a temp PATH records its argv. No model, no
// network, no credits. The last test additionally probes the REAL CLI when one
// is installed, so a future Codex that moves a flag is caught by this file
// rather than by a dead revise in production.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { runHeadless } from "../../_shared/lib/host-agent-driver.ts";
import { CAPTURE_PRELUDE, readCapturedArgs, writeFakeCli } from "./helpers/fake-cli.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-codex-resume-"));
const BIN = path.join(TMP, "bin");
const CAP = path.join(TMP, "capture");
for (const dir of [BIN, CAP]) fs.mkdirSync(dir, { recursive: true });

/** The four flags `codex exec resume` does not accept. */
const PARENT_ONLY = ["-C", "--add-dir", "--approve-for-me", "-s"];

const SAVED: Record<string, string | undefined> = {};
const MANAGED = ["PATH", "FAKE_CAPTURE_DIR", "NIRVANA_MODEL", "ANTHROPIC_MODEL"];

/** A fake codex that succeeds. `REJECT_FLAG` makes it answer like clap does for
 *  a flag this version does not know, which is what drives the retry path. */
const BODY = `
await stdinLen();
const reject = process.env.REJECT_FLAG;
if (reject && argv.includes(reject)) {
  process.stderr.write("error: unexpected argument '" + reject + "' found\\n");
  process.exit(2);
}
const oi = argv.indexOf("-o");
if (oi >= 0) fs.writeFileSync(argv[oi + 1], "ok");
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
`;

beforeAll(() => {
  for (const key of MANAGED) SAVED[key] = process.env[key];
  delete process.env.NIRVANA_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  process.env.PATH = `${BIN}${path.delimiter}${SAVED.PATH ?? ""}`;
  process.env.FAKE_CAPTURE_DIR = CAP;
  writeFakeCli(BIN, "codex", CAPTURE_PRELUDE + BODY);
});

afterAll(() => {
  for (const key of MANAGED) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key]!;
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Runs the adapter and hands back the argv the CLI actually received. */
function argv(extra: Record<string, unknown> = {}): string[] {
  const r = runHeadless({
    runtime: "codex", prompt: "do the task", cwd: TMP, timeoutMs: 30_000,
    addDirs: ["/tmp/grant-a", "/tmp/grant-b"], ...extra,
  } as Parameters<typeof runHeadless>[0]);
  expect(r.ok, r.error ?? r.stderr).toBe(true);
  return readCapturedArgs(CAP, "codex");
}

/** Index of the subcommand, or the end of argv when this is a fresh session. */
const resumeAt = (a: string[]) => (a.includes("resume") ? a.indexOf("resume") : a.length);

describe("parent-only flags never cross the resume subcommand", () => {
  test("a resumed run puts cwd, grants and approval before `resume`", () => {
    const a = argv({ sessionId: "11111111-2222-3333-4444-555555555555", yolo: false });
    expect(a.indexOf("resume")).toBeGreaterThan(0);
    expect(a[a.indexOf("resume") + 1]).toBe("11111111-2222-3333-4444-555555555555");
    for (const flag of ["-C", "--add-dir", "--approve-for-me"]) {
      expect(a, `${flag} must be present`).toContain(flag);
      expect(a.indexOf(flag), `${flag} must precede resume`).toBeLessThan(a.indexOf("resume"));
    }
    // Both grants survive, and both stay on the parent.
    expect(a.filter((x) => x === "--add-dir")).toHaveLength(2);
    expect(a.lastIndexOf("--add-dir")).toBeLessThan(a.indexOf("resume"));
  });

  test("a fresh run carries the same flags and no subcommand", () => {
    const a = argv({ yolo: false });
    expect(a).not.toContain("resume");
    expect(a[0]).toBe("exec");
    for (const flag of ["-C", "--add-dir", "--approve-for-me"]) expect(a).toContain(flag);
  });

  test("the sandbox fallback lands on the parent too, not after `resume`", () => {
    // An older CLI that does not know --approve-for-me: the adapter drops it and
    // retries with -s workspace-write, which is ALSO parent-only.
    process.env.REJECT_FLAG = "--approve-for-me";
    try {
      const a = argv({ sessionId: "11111111-2222-3333-4444-555555555555", yolo: false });
      expect(a).not.toContain("--approve-for-me");
      expect(a.indexOf("-s")).toBeGreaterThan(-1);
      expect(a[a.indexOf("-s") + 1]).toBe("workspace-write");
      expect(a.indexOf("-s")).toBeLessThan(a.indexOf("resume"));
    } finally {
      delete process.env.REJECT_FLAG;
    }
  });

  test("nothing parent-only is left after the subcommand", () => {
    const a = argv({ sessionId: "11111111-2222-3333-4444-555555555555", yolo: false });
    const after = a.slice(resumeAt(a));
    for (const flag of PARENT_ONLY) expect(after, `${flag} after resume`).not.toContain(flag);
  });
});

describe("the contract against the installed Codex", () => {
  /** Flags `codex exec resume --help` documents, or null when codex is absent.
   *  Probed with the PATH this suite saved: the fake shadows `codex` on the
   *  live one, and interrogating the fake would assert nothing. */
  function resumeFlags(): Set<string> | null {
    const probe = spawnSync("codex", ["exec", "resume", "--help"], {
      encoding: "utf8", env: { ...process.env, PATH: SAVED.PATH ?? "" },
    });
    if (probe.status !== 0 || !probe.stdout) return null;
    const found = new Set<string>();
    for (const m of probe.stdout.matchAll(/(?:^|\s)(--?[a-zA-Z][\w-]*)/g)) found.add(m[1]);
    return found;
  }

  test("every flag the adapter leaves after `resume` is one resume accepts", () => {
    const accepted = resumeFlags();
    if (!accepted) {
      console.log("[codex-resume] SKIPPED — no codex on PATH to probe");
      return;
    }
    // Probe the real CLI, then read the adapter's own argv from the fake.
    const a = argv({ sessionId: "11111111-2222-3333-4444-555555555555", yolo: false });
    const after = a.slice(resumeAt(a) + 2).filter((x) => x.startsWith("-"));
    expect(after.length).toBeGreaterThan(0);
    for (const flag of after) {
      expect(accepted.has(flag), `codex exec resume does not accept ${flag}`).toBe(true);
    }
  });
});
