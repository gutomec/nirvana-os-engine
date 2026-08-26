// fake-glance-child.ts — a stand-in for scripts/dispatch.ts spawned by the Glance
// execution runner. It reads --project, --run-id, --brief-file and --outputs-root,
// opens the kernel of its cwd (the same file the server serves) and, like the
// real dispatch, picks the execution path from its argv: with
// `--execution-mode=gauntlet` it drives runAgentXGauntlet with a deterministic
// producer, evaluator and final gate; without it (the `--business` / `--squad`
// children of the chat) it runs the standard-mode publication (open → start →
// verify → finish) with a deterministic deliverable. Either way the tests prove
// the whole chain across processes: Message → Run → child → kernel → SSE. Zero
// LLM, zero network.
//
// Knobs, read from the environment of the spawned process (the hold knobs apply
// to the Gauntlet path only):
//   FAKE_CHILD_STATE_DIR   root for markers and counters; each Run uses <root>/<runId>
//   FAKE_CHILD_HOLD        "1": after the first candidate is persisted, stop the
//                          Gauntlet and wait (asynchronously, so SIGTERM is honoured)
//                          for <state>/go before resuming to completion
//   FAKE_CHILD_AFTER_WAIT  what to do once released: "crash" exits 1 mid-flight,
//                          "exit" exits 0 without a terminal transition, default resumes
//
// Markers written under <state>: started, holding, killed, crashed, exited-early,
// completed. Counters: spawns, producer, evaluator, final-gate. argv.json records
// the argv, cwd, NIRVANA_PROJECT_ROOT and the NIRVANA_* environment the child saw
// (the settings the runner pinned into it).
import * as fs from "node:fs";
import * as path from "node:path";

const LIB_DIR = path.resolve(import.meta.dir, "..", "..", "lib");

export const FAKE_GLANCE_CHILD_SOURCE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentXGauntletInterruption, runAgentXGauntlet } from ${JSON.stringify(path.join(LIB_DIR, "gauntlet", "agent-x-cutover.ts"))};
import { openKernel } from ${JSON.stringify(path.join(LIB_DIR, "run-kernel", "index.ts"))};
import { openStandardPublication } from ${JSON.stringify(path.join(LIB_DIR, "run-kernel", "standard-publication.ts"))};
const argv = Bun.argv.slice(2);
const value = (name) => {
  const index = argv.findIndex((item) => item === name || item.startsWith(name + "="));
  if (index < 0) return undefined;
  return argv[index].includes("=") ? argv[index].slice(name.length + 1) : argv[index + 1];
};
const projectId = value("--project");
const runId = value("--run-id");
const outputsRoot = value("--outputs-root");
const brief = fs.readFileSync(value("--brief-file"), "utf8");
const state = path.join(process.env.FAKE_CHILD_STATE_DIR, runId);
fs.mkdirSync(state, { recursive: true });
const mark = (name) => fs.writeFileSync(path.join(state, name), new Date().toISOString());
const bump = (name) => {
  const file = path.join(state, name);
  const current = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
  fs.writeFileSync(file, String(current + 1));
};
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("NIRVANA_")));
fs.writeFileSync(path.join(state, "argv.json"), JSON.stringify({ argv, cwd: process.cwd(), projectRoot: process.env.NIRVANA_PROJECT_ROOT ?? null, env }));
bump("spawns"); mark("started");
const kernel = openKernel(path.join(process.cwd(), ".nirvana", "run-kernel.sqlite"));
if (!argv.some((item) => item.startsWith("--execution-mode=gauntlet"))) {
  // Standard mode: the publication module the real dispatch uses, around a deterministic executor.
  const target = value("--business") ? { kind: "business", slug: value("--business") }
    : value("--squad") ? { kind: "squad", slug: value("--squad"), capabilityId: "squad.execute" } : { kind: "agent-x", slug: "agent-x" };
  const publication = openStandardPublication({ kernelPath: kernel.path, projectId, runId, traceId: "trace_fake_child", target,
    snapshot: { runtime: { id: "claude-code", source: "default" }, provider: { selection: "runtime-provider", resolved: false },
      model: { selection: "runtime-default", resolved: false }, reason: "no provider descriptor for runtime" },
    audit() {}, warn() {} });
  publication.start();
  bump("producer"); fs.mkdirSync(outputsRoot, { recursive: true });
  fs.writeFileSync(path.join(outputsRoot, "result.md"), "# Resultado\n\n" + brief, "utf8");
  publication.verify();
  bump("final-gate");
  publication.finish({ exitCode: 0, gateOutcome: "pass" }, outputsRoot);
  mark("completed");
  kernel.close();
  process.exit(0);
}
const evaluatorTarget = { kind: "squad", slug: "fake-evaluator", capabilityId: "quality.specification_conformance" };
const common = {
  kernel, projectId, runId, traceId: "trace_fake_child", brief, projectRoot: process.cwd(), outputsRoot, expectedCostUsd: 1,
  executeCandidate(candidateRoot) {
    bump("producer"); fs.mkdirSync(candidateRoot, { recursive: true });
    fs.writeFileSync(path.join(candidateRoot, "result.md"), "# Resultado\n\n" + brief, "utf8");
    return { ok: true, sessionId: "session_fake" };
  },
  evaluator: { target: evaluatorTarget, evaluate({ candidateId, revisionId, artifactRefs }) {
    bump("evaluator");
    return [{ evaluationId: "evl_" + revisionId, candidateId, revisionId, gauntletId: "brief-conformance", rubricVersion: "test/v1", verdict: "pass",
      dimensions: [{ id: "brief", score: 1, confidence: 1, blocking: true, passed: true, evidenceRefs: artifactRefs.map((ref) => ref.revisionId) }],
      regressions: [], revisionRequests: [], evaluator: evaluatorTarget, costUsd: 0, createdAt: new Date().toISOString() }];
  } },
  finalGate() { bump("final-gate"); return { exitCode: 0, gateOutcome: "pass" }; },
};
if (process.env.FAKE_CHILD_HOLD === "1") {
  process.on("SIGTERM", () => { mark("killed"); process.exit(143); });
  try { runAgentXGauntlet({ ...common, afterCandidatePersisted() { throw new AgentXGauntletInterruption("hold"); } }); }
  catch (error) { if (!(error instanceof AgentXGauntletInterruption)) throw error; }
  mark("holding");
  const deadline = Date.now() + Number(process.env.FAKE_CHILD_WAIT_MAX_MS ?? 30000);
  while (!fs.existsSync(path.join(state, "go"))) {
    if (Date.now() > deadline) { mark("wait-timeout"); process.exit(1); }
    await Bun.sleep(20);
  }
  if (process.env.FAKE_CHILD_AFTER_WAIT === "crash") { mark("crashed"); process.exit(1); }
  if (process.env.FAKE_CHILD_AFTER_WAIT === "exit") { mark("exited-early"); process.exit(0); }
}
const result = runAgentXGauntlet(common);
mark("completed");
kernel.close();
process.exit(result.exitCode);
`;

/** Writes the fake child to `<dir>/fake-glance-child.ts` and returns its path. */
export function writeFakeGlanceChild(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "fake-glance-child.ts");
  fs.writeFileSync(file, FAKE_GLANCE_CHILD_SOURCE, "utf8");
  return file;
}

/** Puts an executable `<dir>/bin/<bin>` shim at the head of PATH so the runner's
 * availability probe (`which <bin>`) succeeds on any machine; returns the restore. */
export function shimRuntimeOnPath(dir: string, bin = "claude"): () => void {
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, bin), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previous ?? ""}`;
  return () => { process.env.PATH = previous; };
}

/** Markers and counters the fake child writes for one Run. */
export function childState(stateRoot: string, runId: string) {
  const dir = path.join(stateRoot, runId);
  return {
    dir,
    has: (name: string) => fs.existsSync(path.join(dir, name)),
    count: (name: string) => fs.existsSync(path.join(dir, name)) ? Number(fs.readFileSync(path.join(dir, name), "utf8")) : 0,
    argv: () => JSON.parse(fs.readFileSync(path.join(dir, "argv.json"), "utf8")) as { argv: string[]; cwd: string; projectRoot: string | null; env: Record<string, string> },
    release: () => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "go"), "go"); },
    async waitFor(name: string, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (!fs.existsSync(path.join(dir, name))) {
        if (Date.now() > deadline) throw new Error(`fake child never wrote ${name}`);
        await Bun.sleep(10);
      }
    },
  };
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}
