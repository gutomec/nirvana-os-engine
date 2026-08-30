// glance-runs-project-filter.test.ts — the Project pill must not hide a
// project's own dispatches.
//
// The owner, looking at his own Runs tab on 2026-08-30 with the "Project"
// pill on: 2 of 10 runs shown, though /api/runs with no filter at all
// returned all 10 correctly. server.ts's eventMatchesProject only recognized
// a `cwd` or a filesystem-shaped `project_id` — signals an interactive
// coding session carries. A business/squad/agent-x dispatch (brief-
// business.ts / brief-squad.ts / dispatch.ts) never has a `cwd`, and its
// `project_id` IS the trace ID, not a path — so every dispatch this project
// ever ran silently dropped out of its own scoped view. Fixed by trusting
// business_slug / squad_name / target — fields only a dispatch sets, which a
// genuinely different project's session (even one misfiled into this
// project's own log by an importer running from the wrong cwd) never
// carries, so that case still gets excluded.
//
// Hermetic: a temp NIRVANA_PROJECT_ROOT, a temp HARNESS_LOGS_DIR the test
// writes directly (mirrors glance-run-card-brief.test.ts). Runs with:
// bun test skills/harness/tests
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";

const TMP = makeTempRoot("nrv-runs-project-filter-");
const project = path.join(TMP, "project");
const logs = path.join(project, ".nirvana", "logs", "harness");

const savedEnv = new Map<string, string | undefined>();
const ENV_KEYS = ["NIRVANA_PROJECT_ROOT", "HARNESS_LOGS_DIR", "NIRVANA_HOME"];
const servers: Array<{ close: () => void }> = [];

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);
  fs.mkdirSync(path.join(project, ".nirvana"), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.join(logs, today);
  fs.mkdirSync(dir, { recursive: true });
  const at = (n: number) => `${today}T10:${String(n).padStart(2, "0")}:00.000Z`;
  const lines = [
    // A business dispatch: no cwd, project_id IS the trace_id — the shape
    // that used to disappear.
    { ts: at(0), event: "brief_received", trace_id: "biz-trace", project_id: "biz-trace", business_slug: "systems-atelier", brief_excerpt: "faz o reskin" },
    { ts: at(1), event: "dispatch_business", trace_id: "biz-trace", business_slug: "systems-atelier" },
    { ts: at(2), event: "gate_passed", trace_id: "biz-trace", rubric: "code", score: 0.9 },
    // An agent-x dispatch: same shape, only `target` identifies it.
    { ts: at(3), event: "brief_received", trace_id: "agentx-trace", project_id: "agentx-trace", target: "agent-x" },
    { ts: at(4), event: "dispatch_agent_x", trace_id: "agentx-trace" },
    // An interactive session genuinely IN this project — must stay visible.
    { ts: at(5), event: "tool_invoked", trace_id: "session-trace", cwd: project, host: "claude-code-hook" },
    // A genuinely different project's session, misfiled into this log
    // (mirrors the real contamination found live) — must stay excluded.
    { ts: at(6), event: "tool_invoked", trace_id: "other-project-trace", cwd: "/Users/someone/other-project", host: "claude-code-hook" },
  ];
  fs.writeFileSync(path.join(dir, "audit.jsonl"), lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  process.env.NIRVANA_PROJECT_ROOT = project;
  process.env.HARNESS_LOGS_DIR = logs;
  delete process.env.NIRVANA_HOME;
});

afterEach(() => { while (servers.length) { try { servers.pop()!.close(); } catch {} } });

// A fixed high port, not `port: 0`/"auto": findFreePort()'s probe-then-stop
// check can misreport an already-listening port as free (Bun.serve allows a
// probe bind to succeed against a port a real server still holds), which is
// a separate, pre-existing issue unrelated to this fix — pinning a port far
// from Glance's own default (3737) sidesteps it instead of relying on
// detection this test doesn't need.
let nextPort = 48737;
async function startAndFetch(qs: string) {
  const { startServer } = await import("../lib/glance/server.ts");
  const server = await startServer({ port: nextPort++, open: false, idleMin: 60, allowActions: false, theme: "apple" });
  servers.push(server);
  const res = await fetch(`http://127.0.0.1:${server.port}/api/runs?${qs}`);
  return (await res.json()) as { runs: any[]; total: number };
}

describe("the Project pill's ?project= filter", () => {
  test("with no project param, every run in the log comes back unfiltered", async () => {
    const { runs } = await startAndFetch("days=7&limit=200");
    expect(runs.map((r: any) => r.trace_id).sort()).toEqual(
      ["agentx-trace", "biz-trace", "other-project-trace", "session-trace"].sort()
    );
  });

  test("scoped to this project, the business and agent-x dispatches are NOT dropped", async () => {
    const { runs } = await startAndFetch(`days=7&limit=200&project=${encodeURIComponent(project)}`);
    const traces = runs.map((r: any) => r.trace_id);
    expect(traces).toContain("biz-trace");
    expect(traces).toContain("agentx-trace");
    expect(traces).toContain("session-trace");
  });

  test("scoped to this project, a genuinely different project's session stays excluded", async () => {
    const { runs } = await startAndFetch(`days=7&limit=200&project=${encodeURIComponent(project)}`);
    expect(runs.map((r: any) => r.trace_id)).not.toContain("other-project-trace");
  });
});

afterAll(() => {
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  removeDir(TMP);
});
