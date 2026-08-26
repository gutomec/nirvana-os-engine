// fake-dispatch.ts — a stand-in for scripts/dispatch.ts, shared by the
// multi-target tests (adapters and CLI). It records argv, the Nirvana env keys,
// cwd and the brief it received into the outputs root, appends one
// agent_executed cost event exactly where the legacy paths write it, produces
// _SUMMARY.md and exits with the configured code. Zero LLM, zero network.
//
// Knobs, read from the environment of the spawned process:
//   FAKE_DISPATCH_SPAWN_LOG        append the outputs root on every spawn
//   FAKE_DISPATCH_SLEEP_MS         wait before finishing
//   FAKE_DISPATCH_COST_USD         cost_usd of the audit event (0 = no event)
//   FAKE_DISPATCH_EXIT_CODE        exit code for every node (default 0)
//   FAKE_DISPATCH_EXIT_CODE_FOR    "<nodeId>=<code>[,...]" exit code per node
//   FAKE_DISPATCH_KILL_PARENT_FOR  "<nodeId>": SIGKILL the parent process before
//                                  doing anything else, simulating the engine
//                                  crashing while that node is running
//
// The node id comes from --business / --squad, or from the outputs root for
// agent-x nodes (<workspace>/<kind>/<nodeId>/outputs).
import * as fs from "node:fs";
import * as path from "node:path";

export const FAKE_DISPATCH_SOURCE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
const argv = Bun.argv.slice(2);
const VALUE_FLAGS = new Set(["--brief-file", "--project", "--outputs-root", "--runtime", "--max-budget", "--business", "--squad"]);
const value = (name) => {
  const index = argv.findIndex((item) => item === name || item.startsWith(name + "="));
  if (index < 0) return undefined;
  return argv[index].includes("=") ? argv[index].slice(name.length + 1) : argv[index + 1];
};
const positional = argv.filter((item, index) => !item.startsWith("--") && !(index > 0 && VALUE_FLAGS.has(argv[index - 1])));
const outputsRoot = value("--outputs-root");
const nodeId = value("--business") ?? value("--squad") ?? path.basename(path.dirname(outputsRoot));
const brief = fs.readFileSync(value("--brief-file"), "utf8");
fs.mkdirSync(outputsRoot, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(NIRVANA_|HARNESS_|FAKE_)/.test(key)));
fs.writeFileSync(path.join(outputsRoot, "dispatch-capture.json"), JSON.stringify({ argv, positional, env, cwd: process.cwd(), brief }));
if (process.env.FAKE_DISPATCH_SPAWN_LOG) fs.appendFileSync(process.env.FAKE_DISPATCH_SPAWN_LOG, outputsRoot + "\n");
if (process.env.FAKE_DISPATCH_KILL_PARENT_FOR === nodeId) { process.kill(process.ppid, "SIGKILL"); process.exit(1); }
const sleepMs = Number(process.env.FAKE_DISPATCH_SLEEP_MS ?? 0);
if (sleepMs > 0) await Bun.sleep(sleepMs);
const cost = Number(process.env.FAKE_DISPATCH_COST_USD ?? 0);
if (cost > 0) {
  const target = value("--business") ? { business_slug: value("--business"), employee: "intake" }
    : value("--squad") ? { squad_slug: value("--squad"), employee: "squad:" + value("--squad") } : { employee: "agent-x" };
  const logsDir = process.env.HARNESS_LOGS_DIR ?? path.join(process.cwd(), ".nirvana", "logs", "harness");
  const day = path.join(logsDir, new Date().toISOString().slice(0, 10));
  fs.mkdirSync(day, { recursive: true });
  const project = value("--project");
  fs.appendFileSync(path.join(day, "audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), event: "agent_executed",
    trace_id: project, project_id: project, ...target, cost_usd: cost }) + "\n");
}
fs.writeFileSync(path.join(outputsRoot, "_SUMMARY.md"), "# Summary\n\n" + nodeId + "\n");
const perNode = (process.env.FAKE_DISPATCH_EXIT_CODE_FOR ?? "").split(",").map((item) => item.split("=")).find(([id]) => id === nodeId);
const code = Number(perNode?.[1] ?? process.env.FAKE_DISPATCH_EXIT_CODE ?? 0);
if (code !== 0) console.error("fake dispatch stopped with exit " + code);
process.exit(code);
`;

/** Writes the fake to `<dir>/fake-dispatch.ts` and returns its path. */
export function writeFakeDispatch(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "fake-dispatch.ts");
  fs.writeFileSync(file, FAKE_DISPATCH_SOURCE, "utf8");
  return file;
}
