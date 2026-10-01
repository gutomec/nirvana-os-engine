// dispatch-input-validation.test.ts — `nrv dispatch` refuses what cannot run
// BEFORE it creates anything, and runs only with --exec.
//
// Audit findings this pins (2026-10): a dispatch without --exec left a prepared
// folder behind and exited 3, and an orchestrator that forgot the flag believed
// it had dispatched; an unknown business exited 1 after the scaffold step; a
// --brief-file that was a directory crashed with EISDIR; `--max-budget abc`
// meant no ceiling at all; `--project ../x` wrote outside the outputs root; two
// dispatches of one target in the same second shared a folder; and a business
// run read the --brief-file as given, so --auto-brief's enrichment never
// reached the worker.
//
// Hermetic: a temporary HOME and project, a fake `claude` on PATH where a run
// is needed, no LLM and no network.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { argvWarnings, isSafeId, quoteArg, readBriefFile, rerunWithExec, routerRuntimeAllowed } from "../scripts/dispatch.ts";
import type { RuntimeRule } from "../lib/runtime-rules.ts";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const SKILLS = path.resolve(import.meta.dir, "..", "..");
const DISPATCH = path.join(SKILLS, "harness", "scripts", "dispatch.ts");

const roots: string[] = [];
afterEach(() => { while (roots.length) removeDir(roots.pop()!); });

describe("pure helpers", () => {
  test("isSafeId: a plain name passes; a path of either OS, a drive letter or a device name does not", () => {
    for (const ok of ["proj-20261001T000000-web", "prj_glance", "chat-abc123", "a", "v1.2_x"]) expect(isSafeId(ok)).toBe(true);
    for (const bad of ["", "../x", "..\\x", "a/b", "a\\b", "C:x", "C:\\x", "/abs", "x..y", "x.", "-x", ".hidden", "CON", "nul.txt", "a b"]) {
      expect(`${bad}: ${isSafeId(bad)}`).toBe(`${bad}: false`);
    }
  });

  test("quoteArg: bare when plain, double quotes otherwise, Windows paths keep their backslashes", () => {
    expect(quoteArg("--exec")).toBe("--exec");
    expect(quoteArg("C:\\briefs\\a.md")).toBe("C:\\briefs\\a.md");
    expect(quoteArg("C:\\my briefs\\a.md")).toBe('"C:\\my briefs\\a.md"');
    expect(quoteArg("say \"hi\" now")).toBe('"say \\"hi\\" now"');
    expect(quoteArg("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
    expect(quoteArg("")).toBe('""');
    expect(quoteArg("it's")).toBe('"it\'s"');
  });

  test("rerunWithExec: the same arguments, --scaffold-only dropped, --exec added once", () => {
    expect(rerunWithExec(["web-studio", "a landing page", "--project", "p1"])).toBe('nrv dispatch web-studio "a landing page" --project p1 --exec');
    expect(rerunWithExec(["--agent-x", "x", "--scaffold-only"])).toBe("nrv dispatch --agent-x x --exec");
    expect(rerunWithExec(["--agent-x", "x", "--exec=codex"])).toBe("nrv dispatch --agent-x x --exec=codex");
  });

  test("argvWarnings: unknown flags and extra positionals are named; --mode's value is not a positional", () => {
    expect(argvWarnings(["--auto", "brief", "--mode", "cards", "--exec"], 1)).toEqual([]);
    expect(argvWarnings(["--agent-x", "brief", "--exec", "codex", "--bogus", "--nope=1"], 1)).toEqual([
      "unknown flag(s) ignored: --bogus --nope=1",
      "extra argument(s) ignored: codex",
    ]);
    expect(argvWarnings(["biz", "brief", "--exec=codex", "--auto-brief=proxy", "--scope", "global"], 2)).toEqual([]);
  });

  test("readBriefFile: decided by stat and error code, a BOM stripped, a path with spaces read", () => {
    const root = makeTempRoot("nrv-brief-file-"); roots.push(root);
    expect(readBriefFile(path.join(root, "missing.md"))).toEqual({ error: `--brief-file not found: ${path.join(root, "missing.md")}` });
    expect(readBriefFile(root)).toEqual({ error: `--brief-file is a directory, not a file: ${root}` });
    const empty = path.join(root, "empty.md"); fs.writeFileSync(empty, "  \n");
    expect(readBriefFile(empty)).toEqual({ error: `--brief-file is empty: ${empty}` });
    const spaced = path.join(root, "my briefs", "a brief.md");
    fs.mkdirSync(path.dirname(spaced)); fs.writeFileSync(spaced, "\uFEFF## Request (verbatim)\r\nA report.\r\n");
    expect(readBriefFile(spaced)).toEqual({ text: "## Request (verbatim)\r\nA report.\r\n" });
  });

  test("routerRuntimeAllowed: only a runtime a USE_* rule names, and never one a matching NOT_USE_* vetoes", () => {
    const rule = (runtime: string, text: string, negate = false): RuntimeRule =>
      ({ runtime: runtime as RuntimeRule["runtime"], rule: text, envKey: `${negate ? "NOT_USE_" : "USE_"}${runtime.toUpperCase()}`, sourceFile: null, negate });
    const rules = [rule("codex", "code refactors and test suites"), rule("gemini-cli", "legal contracts and compliance reviews", true)];
    expect(routerRuntimeAllowed(null, "anything", rules)).toEqual({ allowed: false, reason: "no runtime suggested" });
    expect(routerRuntimeAllowed("kimi-cli", "anything", rules)).toEqual({ allowed: false, reason: "no USE_* rule names kimi-cli" });
    expect(routerRuntimeAllowed("codex", "refactor the test suites", rules)).toMatchObject({ allowed: true, rule: { envKey: "USE_CODEX" } });
    const vetoed = [...rules, rule("gemini-cli", "long documents")];
    expect(routerRuntimeAllowed("gemini-cli", "review the legal contracts for compliance", vetoed))
      .toEqual({ allowed: false, reason: "NOT_USE_GEMINI-CLI vetoes gemini-cli for this brief" });
  });
});

/** A temporary HOME with one business, a project, and an env that inherits nothing of the caller's engine. */
function fixture() {
  const root = makeTempRoot("nrv-dispatch-validate-"); roots.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const bin = path.join(root, "bin");
  const emptyBin = path.join(root, "empty-bin");
  fs.mkdirSync(path.join(projectRoot, ".nirvana"), { recursive: true });
  fs.mkdirSync(emptyBin, { recursive: true });
  const biz = path.join(home, "businesses", "fixture-biz");
  fs.mkdirSync(path.join(biz, "employees"), { recursive: true });
  fs.writeFileSync(path.join(biz, "business.yaml"), ["name: fixture-biz", "author: nirvana-os", "version: 1.0.0", "protocol: '2.0'",
    "description: A fixture business used by the dispatch validation test.", "domains:", "  - testing",
    "runtime_requirements:", "  minimum:", "    - runtime: claude-code", ""].join("\n"), "utf8");
  fs.writeFileSync(path.join(biz, "org-chart.yaml"), ["chart:", "- employee: synth", "  reports: []", "  direct_reports: []", ""].join("\n"), "utf8");
  fs.writeFileSync(path.join(biz, "employees", "synth.md"),
    "---\nname: synth\nrole: synthesizer\ndescription: Writes the final deliverable.\nis_brief_intake: true\n---\n\n# synth\n", "utf8");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NIRVANA_|HARNESS_|FAKE_|NRV_|LLM_CASCADE|SQUADS_DIR|BUSINESSES_DIR|USE_|NOT_USE_)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, NIRVANA_HOME: home, SQUADS_DIR: path.join(home, "squads"), BUSINESSES_DIR: path.join(home, "businesses"),
    NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_PROJECT_ROOT: projectRoot, NIRVANA_HOST_RUNTIME: "claude-code", NRV_HOST_ANCESTRY: "0",
    NIRVANA_RUN_LEDGER_DB: path.join(root, "ledger.sqlite"), NIRVANA_STATE_DB: path.join(root, "state.db"),
    HARNESS_LOGS_DIR: path.join(root, "logs"), NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1", NRV_PREFLIGHT: "0", NRV_SUPERVISOR: "0",
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  const dispatch = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [DISPATCH, ...args], { cwd: projectRoot, encoding: "utf8", env: { ...env, ...extra } });
  /** Everything a dispatch could have created: the outputs, the logs, the ledger, the state, the kernel. */
  const created = () => [
    path.join(projectRoot, "outputs"), path.join(home, ".nirvana", "outputs"), path.join(root, "logs"),
    path.join(root, "ledger.sqlite"), path.join(root, "state.db"), path.join(projectRoot, ".nirvana", "run-kernel.sqlite"),
  ].filter((p) => fs.existsSync(p));
  return { root, home, projectRoot, bin, emptyBin, env, dispatch, created };
}

describe("refused before anything exists (exit 4)", () => {
  test("without --exec: nothing is created, and the same command with --exec is printed, quoted for any shell", () => {
    const fx = fixture();
    const r = fx.dispatch(["--agent-x", "write a \"short\" report", "--max-revisions", "0"]);
    expect(r.status, r.stdout + r.stderr).toBe(4);
    expect(r.stderr).toContain("runs the work only with --exec");
    expect(r.stderr).toContain('nrv dispatch --agent-x "write a \\"short\\" report" --max-revisions 0 --exec');
    expect(fx.created()).toEqual([]);
  }, spawnBudgetMs(1));

  const cases: Array<[string, string[], Record<string, string>, RegExp]> = [
    ["--exec with --scaffold-only", ["--agent-x", "x", "--exec", "--scaffold-only"], {}, /mutually exclusive/],
    ["an unknown business", ["ghost-biz", "x", "--exec"], {}, /business 'ghost-biz' is not installed/],
    ["an unknown squad", ["--squad", "ghost-squad", "x", "--exec"], {}, /squad 'ghost-squad' is not installed/],
    ["a slug that is a path", ["--business", "../fixture-biz", "x", "--exec"], {}, /is not a business slug/],
    ["a --brief-file that is a directory", ["--agent-x", "--brief-file", "<root>", "--exec"], {}, /--brief-file is a directory/],
    ["a --brief-file that does not exist", ["--agent-x", "--brief-file", "<root>/nope.md", "--exec"], {}, /--brief-file not found/],
    ["a non-numeric --max-budget", ["--agent-x", "x", "--exec", "--max-budget", "abc"], {}, /--max-budget expects/],
    ["a zero --timeout", ["--agent-x", "x", "--exec", "--timeout=0"], {}, /--timeout expects/],
    ["a non-numeric --max-revisions", ["--agent-x", "x", "--exec", "--max-revisions", "two"], {}, /--max-revisions expects/],
    ["a value flag without its value", ["--agent-x", "x", "--exec", "--project"], {}, /--project requires a value/],
    ["a --project with a POSIX traversal", ["--agent-x", "x", "--exec", "--project", "../evil"], {}, /--project must be a plain id/],
    ["a --project with a Windows traversal", ["--agent-x", "x", "--exec", "--project", "..\\evil"], {}, /--project must be a plain id/],
    ["a --project with a drive letter", ["--agent-x", "x", "--exec", "--project=C:\\evil"], {}, /--project must be a plain id/],
    ["an unknown --mode", ["--auto", "x", "--exec", "--mode", "wat"], {}, /--mode expects agentic or cards/],
    ["an unknown --runtime", ["--agent-x", "x", "--exec", "--runtime", "nope"], {}, /unknown runtime 'nope' \(--runtime\)\. Valid: claude-code/],
    ["an unknown --exec=<runtime>", ["--agent-x", "x", "--exec=nope"], {}, /unknown runtime 'nope' \(--exec=\)/],
    ["an unknown NIRVANA_HOST_RUNTIME", ["--agent-x", "x", "--exec"], { NIRVANA_HOST_RUNTIME: "bogus" }, /unknown runtime 'bogus' \(NIRVANA_HOST_RUNTIME\)/],
    ["an unknown execution.default_runtime", ["--agent-x", "x", "--exec"], { NIRVANA_DEFAULT_RUNTIME: "bogus" }, /unknown runtime 'bogus' \(execution\.default_runtime/],
    ["a squad that tries to dispatch", ["--agent-x", "x", "--exec"], { NIRVANA_DISPATCH_ROLE: "squad" }, /a squad executes, it never dispatches/],
    ["a solo business that tries to dispatch a squad", ["--squad", "any", "x", "--exec"], { NIRVANA_DISPATCH_ROLE: "solo" }, /a solo executes, it never dispatches/],
    ["a chain past the depth ceiling", ["--agent-x", "x", "--exec"], { NIRVANA_DISPATCH_DEPTH: "9" }, /at depth 9 and the chain ceiling is 4/],
  ];
  test.each(cases)("%s", (_label, args, extra, expected) => {
    const fx = fixture();
    const r = fx.dispatch(args.map((a) => a.replace("<root>", fx.root)), extra);
    expect(r.status, r.stdout + r.stderr).toBe(4);
    expect(r.stderr).toMatch(expected);
    expect(fx.created()).toEqual([]);
  }, spawnBudgetMs(1));

  test("the decided runtime is not installed: refused with what is installed, not a vendor's name", () => {
    const fx = fixture();
    const r = spawnSync(process.execPath, [DISPATCH, "--agent-x", "x", "--exec"], {
      cwd: fx.projectRoot, encoding: "utf8", env: { ...fx.env, PATH: fx.emptyBin, NIRVANA_HOST_RUNTIME: "codex" },
    });
    expect(r.status, r.stdout + r.stderr).toBe(4);
    expect(r.stderr).toContain("runtime 'codex' (this session) is not installed on this machine. Installed: none.");
    expect(r.stderr).not.toContain("--runtime=claude-code");
    expect(fx.created()).toEqual([]);
  }, spawnBudgetMs(1));
});

describe("--help", () => {
  test("prints the usage on stdout and exits 0", () => {
    const fx = fixture();
    for (const flag of ["--help", "-h"]) {
      const r = fx.dispatch([flag]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Usage: nrv dispatch <business_slug>");
      for (const flagText of ["--squad=<slug>[:<capability>]", "--scaffold-only", "--mode=<mode>", "(default: claude-code, the runtime of this session)"]) {
        expect(r.stdout).toContain(flagText);
      }
      expect(r.stdout).not.toContain("(default: claude-code)");
    }
    expect(fx.created()).toEqual([]);
  }, spawnBudgetMs(2));
});

describe("--scaffold-only", () => {
  test("a business: folder and prompt, exit 3, the next step is the same command with --exec", () => {
    const fx = fixture();
    const r = fx.dispatch(["fixture-biz", "Write the final report as report.html", "--scaffold-only", "--project", "proj-scaffold"]);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(fs.existsSync(path.join(fx.projectRoot, "outputs", "proj-scaffold", "businesses", "fixture-biz", "agent-prompt.md"))).toBe(true);
    expect(r.stdout).toContain('nrv dispatch fixture-biz "Write the final report as report.html" --project proj-scaffold --exec');
    expect(r.stdout).not.toContain("validate-chain");
    expect(r.stdout).not.toContain("Do not spawn");
    expect(r.stdout).toContain("delivery only with --exec");
  }, spawnBudgetMs(2));

  test("an agent-x scaffold reuses the argv, never a truncated --auto brief; flags only a business reads are named", () => {
    const fx = fixture();
    const brief = "A".repeat(120);
    const r = fx.dispatch(["--agent-x", brief, "--scaffold-only", "--zip", "--review"]);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).toContain(`nrv dispatch --agent-x ${brief} --zip --review --exec`);
    expect(r.stderr).toContain("--zip --review only apply to a business run; ignored for agent-x.");
  }, spawnBudgetMs(1));

  test("a squad: the brief is scaffolded, the next step is the argv rerun, and business-only flags are named", () => {
    const fx = fixture();
    const squad = path.join(fx.home, "squads", "fixture-squad");
    fs.mkdirSync(path.join(squad, "agents"), { recursive: true });
    fs.writeFileSync(path.join(squad, "agents", "fixture.md"), "# fixture agent\n", "utf8");
    fs.writeFileSync(path.join(squad, "squad.yaml"), [
      "name: fixture-squad", "version: 1.0.0", 'protocol: "5.0"', "description: A fixture squad for the scaffold-only proof.",
      "experimental_domains: true", "components:", "  agents: [fixture.md]", "  tasks: []", "  workflows: []", "capabilities:",
      "  - id: general.fixture.run", "    description: Do the fixture thing.", "    domains: [fixture]", "    produces: [report]",
      '    examples: ["rode o fixture"]', "    invoke:", "      type: agent", "      ref: fixture", "",
    ].join("\n"), "utf8");
    const r = fx.dispatch(["--squad", "fixture-squad", "Write the final report as report.html", "--scaffold-only", "--html", "--project", "proj-squad"]);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(fs.existsSync(path.join(fx.projectRoot, "outputs", "proj-squad", "brief.md"))).toBe(true);
    expect(r.stdout).toContain('nrv dispatch --squad fixture-squad "Write the final report as report.html" --html --project proj-squad --exec');
    expect(r.stdout).not.toContain("…");
    expect(r.stderr).toContain("--html only apply to a business run; ignored for squad fixture-squad.");
  }, spawnBudgetMs(3));

  test("a generated project id already taken this second gets the next suffix instead of sharing the folder", () => {
    const fx = fixture();
    // Every stamp of the next 20 seconds is taken, so the run cannot miss the collision.
    const now = Date.now();
    for (let s = 0; s < 20; s++) {
      const stamp = new Date(now + s * 1000).toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
      fs.mkdirSync(path.join(fx.projectRoot, "outputs", `proj-${stamp}-agent-x`), { recursive: true });
    }
    const r = fx.dispatch(["--agent-x", "x", "--scaffold-only"]);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    const pid = r.stdout.match(/Project ID: (\S+)/)?.[1] ?? "";
    expect(pid).toMatch(/^proj-\d{8}T\d{6}-agent-x-2$/);
    expect(fs.existsSync(path.join(fx.projectRoot, "outputs", pid, "brief-enriched.md"))).toBe(true);
  }, spawnBudgetMs(1));

  test("a --brief-file without the six sections is warned about, not refused", () => {
    const fx = fixture();
    const file = path.join(fx.root, "thin brief.md");
    fs.writeFileSync(file, "A report about the market.\n");
    const r = fx.dispatch(["--agent-x", "--brief-file", file, "--scaffold-only"]);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stderr).toContain("missing section: ## Request (verbatim)");
  }, spawnBudgetMs(1));
});

describe("the prep scripts validate before they write", () => {
  const BRIEF_BUSINESS = path.join(SKILLS, "businesses", "scripts", "brief-business.ts");
  const BRIEF_SQUAD = path.join(SKILLS, "squads", "scripts", "brief-squad.ts");
  test.each([
    ["brief-business, an unknown business", BRIEF_BUSINESS, ["ghost-biz", "x"], /business 'ghost-biz' not found/],
    ["brief-business, a slug that is a path", BRIEF_BUSINESS, ["../fixture-biz", "x"], /is not a business slug/],
    ["brief-business, a --project that is a path", BRIEF_BUSINESS, ["fixture-biz", "x", "--project", "..\\evil"], /--project must be a plain id/],
    ["brief-business, a missing --manifest", BRIEF_BUSINESS, ["fixture-biz", "x", "--manifest", "<root>/nope.json"], /--manifest file not found/],
    ["brief-squad, an unknown squad", BRIEF_SQUAD, ["ghost-squad", "x"], /squad 'ghost-squad' not found/],
    ["brief-squad, a --project that is a path", BRIEF_SQUAD, ["any", "x", "--project", "C:\\evil"], /--project must be a plain id/],
  ])("%s: exit 4, no folder", (_label, script, args, expected) => {
    const fx = fixture();
    const r = spawnSync(process.execPath, [script, ...args.map((a) => a.replace("<root>", fx.root))], { cwd: fx.projectRoot, encoding: "utf8", env: fx.env });
    expect(r.status, r.stdout + r.stderr).toBe(4);
    expect(r.stderr).toMatch(expected);
    expect(fx.created()).toEqual([]);
  }, spawnBudgetMs(1));

  test("brief-business run directly names the next step; under a dispatch it does not", () => {
    const fx = fixture();
    const direct = spawnSync(process.execPath, [BRIEF_BUSINESS, "fixture-biz", "A report"], { cwd: fx.projectRoot, encoding: "utf8", env: fx.env });
    expect(direct.status, direct.stdout + direct.stderr).toBe(0);
    expect(direct.stdout).toContain("nrv dispatch --business fixture-biz --brief-file");
    expect(direct.stdout).not.toContain("Intake:");
    expect(direct.stdout).not.toContain("Do not spawn");
    const tracked = spawnSync(process.execPath, [BRIEF_BUSINESS, "fixture-biz", "A report", "--project", "proj-tracked"],
      { cwd: fx.projectRoot, encoding: "utf8", env: { ...fx.env, NIRVANA_DISPATCH_TRACKS_RUN: "1" } });
    expect(tracked.status, tracked.stdout + tracked.stderr).toBe(0);
    expect(tracked.stdout).not.toContain("Next step");
  }, spawnBudgetMs(2));
});

// The worker reads the brief FILE. This fake records which file its prompt names, and what it held.
const FAKE_CLAUDE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
const prompt = await Bun.stdin.text();
const named = prompt.match(/\x60([^\x60]+)\x60\. Read it first/)?.[1] ?? null;
fs.writeFileSync(path.join(process.env.FAKE_CAPTURE_DIR, "brief.json"), JSON.stringify({ file: named, text: named && fs.existsSync(named) ? fs.readFileSync(named, "utf8") : null }));
const out = process.env.FAKE_CLAUDE_OUTPUTS_ROOT;
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "report.html"), "<!doctype html><html><head><title>Delivery</title></head><body><main><h1>Final delivery</h1><p>This local fixture contains enough structured content for deterministic validation of the gate.</p><p>The manifest, quality gate and publication stages all run without network access or an external runtime.</p></main></body></html>", "utf8");
fs.writeFileSync(path.join(out, "_SUMMARY.md"), "Delivered report.html.", "utf8");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "delivered", session_id: "sess-brief", total_cost_usd: 0.01 }));
`;

describe("a business run reads the brief the dispatch built", () => {
  function run(extraArgs: string[]) {
    const fx = fixture();
    const capture = path.join(fx.root, "capture");
    const out = path.join(fx.root, "deliverables");
    fs.mkdirSync(capture);
    writeFakeCli(fx.bin, "claude", FAKE_CLAUDE);
    const briefFile = path.join(fx.root, "orchestrator brief.md");
    fs.writeFileSync(briefFile, "Produza o relatório final em report.html\n", "utf8");
    const r = fx.dispatch(["fixture-biz", "--brief-file", briefFile, "--exec", "--project", "proj-brief", "--outputs-root", out,
      "--max-revisions", "0", "--no-review", "--no-judge", ...extraArgs],
      { FAKE_CAPTURE_DIR: capture, FAKE_CLAUDE_OUTPUTS_ROOT: out, NIRVANA_PROFILE: "economy" });
    const seen = JSON.parse(fs.readFileSync(path.join(capture, "brief.json"), "utf8")) as { file: string | null; text: string | null };
    return { fx, r, seen, briefFile };
  }

  test("--auto-brief: the worker reads a copy in the run folder that carries the enrichment and names the source", () => {
    const { fx, r, seen, briefFile } = run(["--auto-brief"]);
    expect([0, 2, 3]).toContain(r.status ?? -1);
    expect(seen.file).toBe(path.join(fx.projectRoot, "outputs", "proj-brief", "businesses", "fixture-biz", "brief.md"));
    expect(seen.text).toContain("Produza o relatório final em report.html");
    expect(seen.text).toContain("[inferred assumptions");
    expect(seen.text).toContain(`Source brief: ${briefFile}`);
    expect(fs.readFileSync(briefFile, "utf8")).toBe("Produza o relatório final em report.html\n");
  }, spawnBudgetMs(3) + 60_000);

  test("unchanged: the worker reads the --brief-file itself, so a decision appended mid-run reaches it", () => {
    const { r, seen, briefFile } = run([]);
    expect([0, 2, 3]).toContain(r.status ?? -1);
    expect(seen.file).toBe(briefFile);
  }, spawnBudgetMs(3) + 60_000);
});
