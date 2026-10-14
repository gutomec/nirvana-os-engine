// routing-fast-retired.e2e.test.ts — the keyword router never decides who executes.
//
// `fast` (BM25 picking the dispatch target) was retired on 2026-10-13: on 48
// labeled requests it answered AMBIGUOUS for 42 and found the right business
// for 4 of 42, and `dispatch --auto --mode=fast` exited 1 on every one of them.
// BM25 still builds shortlists (`nrv find`, the clone search). These tests run
// the REAL scripts/dispatch.ts with a fake `claude` on PATH (no LLM, no
// network) and hold the three ways `fast` used to reach a dispatch:
//   1. `--mode=fast` is refused, exit 4, before anything is created;
//   2. a stored `routing.mode: fast` reads as the profile default, with a warning;
//   3. a router transport failure goes to agent-x, never to BM25, even under a
//      stored `on_router_failure: cascade`.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { IS_WINDOWS, writeFakeCli } from "./helpers/fake-cli.ts";
import { makeTempRoot } from "./helpers/temp-dirs.ts";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const SKILLS = path.join(REPO, "skills");
const DISPATCH = path.join(SKILLS, "harness", "scripts", "dispatch.ts");

/** The routing call (`--tools ""`) answers `business:landing-house`, or fails when FAKE_ROUTER_FAILS is set. */
const FAKE_CLAUDE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
await Bun.stdin.text();
const argv = Bun.argv.slice(2);
const capture = process.env.FAKE_CAPTURE_DIR;
if (argv.includes("--tools")) {
  fs.appendFileSync(path.join(capture, "router-calls"), "x");
  if (process.env.FAKE_ROUTER_FAILS) { process.stderr.write("connection reset by peer\n"); process.exit(1); }
  const answer = { target: "business:landing-house", voices: [], squads: [], done: ["The landing page is delivered"], reason: "It builds landing pages." };
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(answer), session_id: "route", total_cost_usd: 0.001 }));
  process.exit(0);
}
fs.writeFileSync(path.join(capture, "worker-ran"), "a worker ran");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "x", session_id: "w", total_cost_usd: 0.01 }));
`;

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

// A request BM25 matches confidently: if the keyword router were consulted it would pick landing-house.
const REQUEST = "Build a landing page for my bakery with a hero section and a contact form";

function setup(opts: { globalConfig?: string; projectConfig?: string; env?: Record<string, string> } = {}) {
  const root = makeTempRoot("nrv-fast-retired-"); roots.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const nirvana = path.join(projectRoot, ".nirvana");
  const bin = path.join(root, "bin");
  const capture = path.join(root, "capture");
  const logs = path.join(root, "logs");
  for (const dir of [nirvana, capture, path.join(home, ".nirvana")]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(nirvana, ".businesses-registry.json"), JSON.stringify({ businesses: {
    "landing-house": {
      description: "Builds landing pages: hero section, contact form, copy and layout.",
      produces: ["landing-page"], keywords: ["landing page", "hero section", "contact form"],
      example_briefs: ["Build a landing page with a hero section and a contact form"],
    },
  } }));
  fs.writeFileSync(path.join(nirvana, ".squads-registry.json"), JSON.stringify({ squads: {}, capabilities: {} }));
  fs.writeFileSync(path.join(nirvana, ".mind-clones-registry.json"), JSON.stringify({ mind_clones: {} }));
  if (opts.globalConfig) fs.writeFileSync(path.join(home, ".nirvana", "config.yaml"), opts.globalConfig, "utf8");
  if (opts.projectConfig) fs.writeFileSync(path.join(nirvana, "config.yaml"), opts.projectConfig, "utf8");
  writeFakeCli(bin, "claude", FAKE_CLAUDE);
  const briefFile = path.join(root, "brief.md");
  fs.writeFileSync(briefFile, REQUEST, "utf8");

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(NIRVANA_|HARNESS_|FAKE_|NRV_|LLM_CASCADE|SQUADS_DIR|BUSINESSES_DIR)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, NIRVANA_HOME: home, NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_PROJECT_ROOT: projectRoot,
    NIRVANA_HOST_RUNTIME: "claude-code", NIRVANA_RUN_LEDGER_DB: path.join(root, "ledger.sqlite"),
    NIRVANA_STATE_DB: path.join(root, "state.db"), HARNESS_LOGS_DIR: logs,
    NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1", NRV_PREFLIGHT: "0", NIRVANA_NO_DESKTOP_NOTIFY: "1",
    FAKE_CAPTURE_DIR: capture,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    ...opts.env,
  });
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, [DISPATCH, "--auto", "--brief-file", briefFile, "--scaffold-only", "--project", "fast-retired", ...args],
      { cwd: projectRoot, env, encoding: "utf8", timeout: 90_000 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", log: `${r.stdout}\n${r.stderr}` };
  };
  const routerCalls = () => { try { return fs.readFileSync(path.join(capture, "router-calls"), "utf8").length; } catch { return 0; } };
  const events = (): Array<Record<string, any>> => {
    const out: Array<Record<string, any>> = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name === "audit.jsonl") {
          for (const line of fs.readFileSync(p, "utf8").split("\n")) {
            if (!line.trim()) continue;
            // Both shapes the audit writes: a flat event, and a CloudEvent with the payload in `data`.
            const e = JSON.parse(line);
            out.push(e.event ? e : { event: String(e.type ?? "").split(".").pop(), ...(e.data ?? {}) });
          }
        }
      }
    };
    walk(root);
    return out;
  };
  return { root, home, projectRoot, run, routerCalls, events };
}

describe.skipIf(IS_WINDOWS)("the retired fast mode", () => {
  test("--mode=fast is refused with exit 4, before any router call or project", () => {
    const s = setup();
    const r = s.run(["--mode=fast"]);
    expect(r.status, r.log).toBe(4);
    expect(r.stderr).toContain("--mode=fast was retired");
    expect(r.stderr).toContain("--mode=cards");
    expect(s.routerCalls()).toBe(0);
    expect(fs.existsSync(path.join(s.projectRoot, "outputs"))).toBe(false);
  }, 90_000);

  test("a stored routing.mode: fast falls back to the profile default (cards in balanced), with one warning naming the file", () => {
    const s = setup({ globalConfig: "execution:\n  profile: balanced\nrouting:\n  mode: fast\n" });
    const r = s.run([]);
    expect(r.log).toContain("Auto-route — cards");
    expect(s.routerCalls()).toBeGreaterThan(0);
    expect(r.log).toContain("landing-house");
    expect(r.stderr).toContain(`routing.mode: "fast" in ${path.join(s.home, ".nirvana", "config.yaml")} was retired`);
    expect(r.stderr).toContain("nrv config unset routing.mode --global");
  }, 90_000);

  test("a router transport failure goes to agent-x and never asks BM25, even under a stored on_router_failure: cascade", () => {
    const s = setup({ projectConfig: "routing:\n  mode: cards\n  on_router_failure: cascade\n", env: { FAKE_ROUTER_FAILS: "1" } });
    const r = s.run([]);
    expect(s.routerCalls(), r.log).toBe(2); // the call and its one retry
    expect(r.stderr).toContain('routing.on_router_failure: "cascade"');
    expect(r.stderr).toContain('read as "agent-x-only"');
    expect(r.log).toContain("never BM25");
    expect(r.log).not.toContain("landing-house");
    const ladder = s.events().filter((e) => e.event === "x_router_failure_cascade");
    expect(ladder.length, r.log).toBeGreaterThan(0);
    expect(ladder.every((e) => e.stage === "agent-x" && e.policy === "agent-x-only")).toBe(true);
    expect(s.events().some((e) => e.event === "auto_route_selected" && e.business_slug === "landing-house")).toBe(false);
  }, 90_000);
});
