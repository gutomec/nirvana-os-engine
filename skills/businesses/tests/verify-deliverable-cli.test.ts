// verify-deliverable-cli.test.ts — the flags mean what they say.
//
// Four ways the CLI answered FAIL over intact work, or PASS over the wrong
// files, without a word: `--outputs-root=/x` was dropped (exact-match flag
// lookup) and the argument vanished from the positionals too; a relative
// `--outputs-root` resolved against the shell's cwd, so the same command gave
// opposite verdicts from a directory and its subdirectory; the whole
// business's promises charged every step of a chain, with no way to name the
// seat; and a `deliverables.json` switched the declared `min_bytes` off while
// the report still printed the default as if it were in force.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBudgetMs } from "../../harness/tests/helpers/test-budgets.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "verify-deliverable.ts");

function run(W: string, args: string[], cwd = W) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, HARNESS_LOGS_DIR: join(W, ".nirvana", "logs", "harness"), BUSINESSES_DIR: join(W, "businesses") },
  });
  const text = `${r.stdout}`.trim();
  const report = text.startsWith("{") ? JSON.parse(text) : null;
  return { code: r.status, stderr: `${r.stderr}`, report };
}

/** A project root with a run, and a business whose two seats each promise one file. */
function scaffold(): { W: string; run: string } {
  const W = mkdtempSync(join(tmpdir(), "verify-cli-"));
  mkdirSync(join(W, ".nirvana"), { recursive: true });
  const run = join(W, "outputs", "proj");
  mkdirSync(join(run, "businesses", "acme"), { recursive: true });
  writeFileSync(join(run, "brief.md"), "# Brief\n\nDeliver both reports.\n", "utf8");
  const biz = join(W, "businesses", "acme");
  mkdirSync(join(biz, "employees"), { recursive: true });
  writeFileSync(join(biz, "business.yaml"), "name: acme\ndescription: fixture\n", "utf8");
  const seat = (name: string, file: string, minBytes: number) => writeFileSync(join(biz, "employees", `${name}.md`), [
    "---", `name: ${name}`, "acceptance:",
    `  - id: ${name}_delivers`, `    description: ${name} delivers its report`, `    path: ${file}`, `    min_bytes: ${minBytes}`,
    "---", `# ${name}`, "",
  ].join("\n"), "utf8");
  seat("seat-a", "seat-a.md", 200);
  seat("seat-b", "seat-b.md", 4000);
  return { W, run };
}
const content = (bytes: number) => "x".repeat(bytes) + "\n";

describe("verify-deliverable CLI", () => {
  const roots: string[] = [];
  afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

  test("--flag=value is the same flag, and an unknown flag is a usage error", () => {
    const { W, run: R } = scaffold(); roots.push(W);
    mkdirSync(join(R, "art"), { recursive: true });
    writeFileSync(join(R, "art", "seat-a.md"), content(300), "utf8");
    writeFileSync(join(R, "art", "seat-b.md"), content(5000), "utf8");
    const spaced = run(W, ["proj", "acme", "--outputs-root", join(R, "art")]);
    const equals = run(W, ["proj", "acme", `--outputs-root=${join(R, "art")}`]);
    expect(spaced.report.status).toBe("PASS");
    expect(equals.report.status).toBe("PASS");
    expect(equals.report.found).toBe(spaced.report.found);
    const unknown = run(W, ["proj", "acme", "--outputs-dir", join(R, "art")]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Unknown flag: --outputs-dir");
  }, spawnBudgetMs(3));

  test("a relative --outputs-root is relative to the run, not to the shell", () => {
    const { W, run: R } = scaffold(); roots.push(W);
    mkdirSync(join(R, "art"), { recursive: true });
    writeFileSync(join(R, "art", "seat-a.md"), content(300), "utf8");
    writeFileSync(join(R, "art", "seat-b.md"), content(5000), "utf8");
    const out = run(W, ["proj", "acme", "--outputs-root", "art"]);
    expect(out.report.status).toBe("PASS");
    expect(out.report.found).toBe(2);
  }, spawnBudgetMs(1));

  test("--employee scopes the promises to one seat", () => {
    const { W, run: R } = scaffold(); roots.push(W);
    writeFileSync(join(R, "seat-a.md"), content(300), "utf8");
    const whole = run(W, ["proj", "acme"]);
    expect(whole.report.status).toBe("FAIL");
    expect(whole.report.expected).toBe(2);
    expect(whole.report.found).toBe(1);
    const seat = run(W, ["proj", "acme", "--employee", "seat-a"]);
    expect(seat.report.status).toBe("PASS");
    expect(seat.report.expected).toBe(1);
    expect(seat.report.employee).toBe("seat-a");
  }, spawnBudgetMs(2));

  test("a declared min_bytes holds with a manifest too, and the report says which floor applied", () => {
    const { W, run: R } = scaffold(); roots.push(W);
    const b = join(R, "seat-b.md");
    writeFileSync(b, content(1404), "utf8");
    writeFileSync(join(R, "businesses", "acme", "deliverables.json"), JSON.stringify([b]), "utf8");
    const out = run(W, ["proj", "acme"]);
    expect(out.report.manifest_source).toMatch(/^manifest:/);
    expect(out.report.status).toBe("FAIL");
    expect(out.report.empty_or_stub).toHaveLength(1);
    expect(out.report.min_bytes_threshold).toBe(200);
    // Keys are canonical paths: a symlinked tmpdir (macOS) or an 8.3 short name (Windows) spells the same file two ways.
    expect(out.report.min_bytes_by_path[realpathSync.native(b)]).toBe(4000);
  }, spawnBudgetMs(1));
});
