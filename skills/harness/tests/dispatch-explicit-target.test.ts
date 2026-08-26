// dispatch-explicit-target.test.ts — explicit target selection in the scripted
// dispatch: --business <slug> · --squad <slug> · --agent-x.
//
// The multi-target adapters used to name a squad through `--auto` with a brief
// that opened `use squad <slug>:` and agent-x through `use agent-x`: one LLM
// routing call per node, and trust that the router honors the mention. The
// flags resolve the plan through dispatch-cascade's explicit layer instead,
// deterministic and zero-token, and are byte-for-byte the old path when absent.
// Runs with: bun test skills/harness/tests
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { explicitTargetPlan, parseExplicitTarget } from "../scripts/dispatch.ts";

const DISPATCH = path.join(import.meta.dir, "..", "scripts", "dispatch.ts");

describe("parseExplicitTarget", () => {
  test("--squad, --business and --agent-x each resolve to one target, in both flag forms", () => {
    expect(parseExplicitTarget(["--squad", "brandcraft", "brief"])).toEqual({ target: { kind: "squad", slug: "brandcraft" }, error: null });
    expect(parseExplicitTarget(["--squad=brandcraft", "brief"])).toEqual({ target: { kind: "squad", slug: "brandcraft" }, error: null });
    expect(parseExplicitTarget(["--business", "web-studio", "brief", "--exec"])).toEqual({ target: { kind: "business", slug: "web-studio" }, error: null });
    expect(parseExplicitTarget(["brief", "--business=web-studio"])).toEqual({ target: { kind: "business", slug: "web-studio" }, error: null });
    expect(parseExplicitTarget(["--agent-x", "brief"])).toEqual({ target: { kind: "agent-x" }, error: null });
  });

  test("the flags are mutually exclusive with each other and with --auto", () => {
    for (const argv of [
      ["--squad", "a", "--auto", "brief"],
      ["--business", "a", "--squad", "b", "brief"],
      ["--agent-x", "--auto", "brief"],
      ["--business", "a", "--agent-x", "brief"],
    ]) {
      const parsed = parseExplicitTarget(argv);
      expect(parsed.target).toBeNull();
      expect(parsed.error).toContain("mutually exclusive");
    }
  });

  test("a value flag without a slug is an error, never a silent positional", () => {
    expect(parseExplicitTarget(["--squad"]).error).toContain("--squad requires a slug");
    expect(parseExplicitTarget(["--business", "--exec", "brief"]).error).toContain("--business requires a slug");
  });

  test("without the flags nothing changes: no target, no error", () => {
    expect(parseExplicitTarget(["web-studio", "brief", "--exec", "--project", "p"])).toEqual({ target: null, error: null });
    expect(parseExplicitTarget(["--auto", "brief", "--exec"])).toEqual({ target: null, error: null });
    expect(parseExplicitTarget([])).toEqual({ target: null, error: null });
  });
});

describe("explicitTargetPlan resolves the route without the router", () => {
  test("squad → one squad step from the cascade's explicit layer", async () => {
    const plan = await explicitTargetPlan({ kind: "squad", slug: "brandcraft" });
    expect(plan.ok).toBe(true);
    expect(plan.steps).toEqual([{ kind: "squad", slug: "brandcraft", reason: "explicit user target" }]);
    expect(plan.source).toBe("explicit");
    expect(plan.mandatorySquads).toEqual([]);
    expect(plan.optionalSquads).toEqual([]);
  });

  test("business → one business step, source explicit", async () => {
    const plan = await explicitTargetPlan({ kind: "business", slug: "web-studio" });
    expect(plan.ok).toBe(true);
    expect(plan.steps).toEqual([{ kind: "business", slug: "web-studio", reason: "explicit user target" }]);
    expect(plan.source).toBe("explicit");
  });

  test("agent-x → one agent-x step, source explicit", async () => {
    const plan = await explicitTargetPlan({ kind: "agent-x" });
    expect(plan.ok).toBe(true);
    expect(plan.steps).toEqual([{ kind: "agent-x", reason: "explicit user target" }]);
    expect(plan.source).toBe("explicit");
  });
});

describe("dispatch.ts exits 4 on an invalid flag combination before anything runs", () => {
  function run(args: string[]): { status: number | null; stderr: string } {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-explicit-target-"));
    try {
      const r = spawnSync(process.execPath, [DISPATCH, ...args], {
        cwd, encoding: "utf8", env: { ...process.env, NIRVANA_NO_UPDATE_CHECK: "1", NIRVANA_SCOPE_QUIET: "1" },
      });
      return { status: r.status, stderr: r.stderr ?? "" };
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  test("--squad with --auto", () => {
    const r = run(["--squad", "brandcraft", "--auto", "brief"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("mutually exclusive");
  });

  test("--business with --agent-x", () => {
    const r = run(["--business", "web-studio", "--agent-x", "brief"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("mutually exclusive");
  });

  test("--squad without a slug", () => {
    const r = run(["--squad", "--exec", "brief"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("--squad requires a slug");
  });

  test("the legacy usage path is untouched: no args still exits 4 with the usage text, which now lists the flags", () => {
    const r = run([]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("Usage: nrv dispatch <business_slug>");
    expect(r.stderr).toContain("--squad=<slug>");
    expect(r.stderr).toContain("--agent-x");
  });
});
