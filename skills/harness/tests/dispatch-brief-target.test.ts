// dispatch-brief-target.test.ts — a brief that names its target skips the router.
//
// Seats and the autonomous directive delegate with
// `nrv dispatch --auto "use squad <slug>: <sub-task>" --exec`. Under --auto the
// router honored that phrasing only because its prompt says to, so every nested
// dispatch that named its squad still paid a whole agentic routing run. The
// grammar is the one the Glance already applies to a Message; an installed slug
// now goes straight to its target, an unknown one still reaches the router.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { installedBriefTarget } from "../scripts/dispatch.ts";
import { writeFakeCli } from "./helpers/fake-cli.ts";
import { makeTempRoot } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";

const REGISTRIES = () => ({ squads: { brandcraft: {} }, businesses: { "web-studio": {} } });

describe("installedBriefTarget", () => {
  test("an installed squad named at the head of the brief is the target", () => {
    expect(installedBriefTarget("use squad brandcraft: a logo for the bakery", REGISTRIES)).toEqual({ kind: "squad", slug: "brandcraft" });
    expect(installedBriefTarget("Use Squad brandcraft:branding.brand.audit: audit it", REGISTRIES))
      .toEqual({ kind: "squad", slug: "brandcraft", capabilityId: "branding.brand.audit" });
  });

  test("an installed business named at the head is the target", () => {
    expect(installedBriefTarget("use business web-studio: a landing page", REGISTRIES)).toEqual({ kind: "business", slug: "web-studio" });
  });

  test("a slug the registry does not know is left to the router", () => {
    expect(installedBriefTarget("use squad ghost-squad: anything", REGISTRIES)).toBeNull();
    expect(installedBriefTarget("use business brandcraft: a squad slug is not a business", REGISTRIES)).toBeNull();
  });

  test("a brief that names no target, or names one mid-sentence, is left to the router", () => {
    expect(installedBriefTarget("a logo for the bakery", REGISTRIES)).toBeNull();
    expect(installedBriefTarget("please use squad brandcraft: for this", REGISTRIES)).toBeNull();
    expect(installedBriefTarget("", REGISTRIES)).toBeNull();
  });

  test("an unreadable registry never guesses a target", () => {
    expect(installedBriefTarget("use squad brandcraft: x", () => { throw new Error("no registry"); })).toBeNull();
  });
});

// ── end to end: the router never starts ──────────────────────────────────────

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const DISPATCH = path.join(REPO, "skills", "harness", "scripts", "dispatch.ts");

const PASSING_HTML = [
  "<!doctype html><html><head><title>Delivery</title></head><body><main>",
  "<h1>Final delivery</h1><p>This local fixture contains enough structured content for deterministic validation.</p>",
  "<p>The manifest, quality gate and publication stages all run without network access or an external runtime.</p>",
  "</main></body></html>",
].join("");

// Every call appends the head of its prompt, so the test can tell a routing call
// from a worker call; each call writes the deliverable and answers success.
const FAKE_CLAUDE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
const input = await Bun.stdin.text();
fs.appendFileSync(path.join(process.env.FAKE_CAPTURE_DIR, "prompts.log"), input.slice(0, 400).replace(/\n/g, " ") + "\n");
const outputsRoot = process.env.FAKE_CLAUDE_OUTPUTS_ROOT;
fs.mkdirSync(outputsRoot, { recursive: true });
fs.writeFileSync(path.join(outputsRoot, "report.html"), ${JSON.stringify(PASSING_HTML)}, "utf8");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "delivered", session_id: "sess-fake", total_cost_usd: 0.01 }));
`;

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = makeTempRoot("nrv-brief-target-"); roots.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const bin = path.join(root, "bin");
  const capture = path.join(root, "capture");
  const outputs = path.join(root, "outputs");
  for (const d of [path.join(projectRoot, ".nirvana"), home, capture, outputs]) fs.mkdirSync(d, { recursive: true });
  writeFakeCli(bin, "claude", FAKE_CLAUDE);
  const squadDir = path.join(home, "squads", "fixture-squad");
  fs.mkdirSync(path.join(squadDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(squadDir, "agents", "fixture.md"), "# fixture agent\n", "utf8");
  fs.writeFileSync(path.join(squadDir, "squad.yaml"), [
    "name: fixture-squad", "version: 1.0.0", 'protocol: "5.0"', "description: A fixture squad for the brief-target proof.", "experimental_domains: true",
    "components:", "  agents: [fixture.md]", "  tasks: []", "  workflows: []", "capabilities:",
    "  - id: general.fixture.run", "    description: Do the fixture thing.", "    domains: [fixture]", "    produces: [report]",
    '    examples: ["rode o fixture"]', "    invoke:", "      type: agent", "      ref: fixture", "",
  ].join("\n"), "utf8");
  const registry = path.join(root, "squads-registry.json");
  fs.writeFileSync(registry, JSON.stringify({
    squads: { "fixture-squad": { name: "fixture-squad", manifest_path: path.join(squadDir, "squad.yaml") } },
    capabilities: { "general.fixture.run": [{ squad: "fixture-squad", description: "Do the fixture thing.", invoke: { type: "agent", ref: "fixture" } }] },
  }), "utf8");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NIRVANA_|HARNESS_|FAKE_|NRV_|LLM_CASCADE|SQUADS_DIR|BUSINESSES_DIR|SQUADS_REGISTRY_PATH|BUSINESSES_REGISTRY_PATH)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, NIRVANA_HOME: home, SQUADS_DIR: path.join(home, "squads"), SQUADS_REGISTRY_PATH: registry,
    NIRVANA_SKILLS_DIR: path.join(REPO, "skills"), NIRVANA_PROJECT_ROOT: projectRoot, NIRVANA_HOST_RUNTIME: "claude-code",
    NIRVANA_RUN_LEDGER_DB: path.join(root, "ledger.sqlite"), NIRVANA_STATE_DB: path.join(root, "state.db"), HARNESS_LOGS_DIR: path.join(root, "logs"),
    NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1", NRV_PREFLIGHT: "0",
    FAKE_CAPTURE_DIR: capture, FAKE_CLAUDE_OUTPUTS_ROOT: outputs, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  const dispatch = (args: string[]) => spawnSync(process.execPath, [DISPATCH, ...args], { cwd: projectRoot, encoding: "utf8", env });
  const prompts = () => { try { return fs.readFileSync(path.join(capture, "prompts.log"), "utf8"); } catch { return ""; } };
  const audit = () => {
    const out: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : e.name === "audit.jsonl" && out.push(fs.readFileSync(f, "utf8")); } };
    try { walk(path.join(root, "logs")); } catch { /* none */ }
    return out.join("\n");
  };
  return { outputs, dispatch, prompts, audit };
}

describe("nrv dispatch --auto with a target named in the brief", () => {
  test("an installed squad runs with no routing call", () => {
    const fx = fixture();
    const r = fx.dispatch(["--auto", "use squad fixture-squad: Produza o relatório final em report.html", "--exec",
      "--project", "proj-brief-target", "--outputs-root", fx.outputs, "--no-color"]);
    expect(r.stdout + r.stderr).toContain("Target named in the brief — squad fixture-squad");
    expect(fx.prompts()).not.toContain("agentic router");
    expect(fx.audit()).toContain("x_explicit_target_short_circuit");
    expect(fx.audit()).not.toContain("agentic_route_called");
    // And the squad did the work: its worker got a prompt and wrote the deliverable.
    expect(fx.prompts()).toContain("fixture-squad");
    expect(fs.existsSync(path.join(fx.outputs, "report.html"))).toBeTrue();
  }, spawnBudgetMs(4));
});
