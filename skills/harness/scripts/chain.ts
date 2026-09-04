#!/usr/bin/env bun
/**
 * chain.ts — the business org chart, as data, for an executor that is not us.
 *
 * The engine had exactly one way to run a business's employees: `runTeam`, which
 * spawns a child runtime per step. On claude-code, codex and antigravity the
 * protocol says NOT to use that path — a child `claude -p` is killed at 20
 * minutes and truncates long deliverables — so the interactive maestro dispatches
 * through its own in-process subagents instead. Which left it with no way to run
 * the org chart at all, and the maestro did the only thing it could: hand the
 * whole business to a single subagent.
 *
 * Measured on a live run, 2026-09-04: `nexus-council` (9 seats) and
 * `systems-atelier` (14 seats) each emitted ONE `dispatch_business` and zero
 * per-employee events — while the deliverables named six of those seats as
 * contributors. Work attributed to seats that never ran as audited agents is the
 * exact fiction the audit protocol exists to prevent, and it was not a bug in
 * anyone's code: no procedure existed.
 *
 * So this file does not execute anything. It splits the run in two:
 *
 *   the ENGINE decides and audits   →  `team plan`, `team step`
 *   the RUNTIME executes            →  the maestro's own subagent, in-session
 *
 * `plan` runs the same director `runTeam` uses (`planChain`) and leaves the same
 * three events behind. `step` builds the same employee prompt `runTeam` builds
 * (`employee-prompt.ts`, DNA injected, resource map, scope guard) and emits the
 * same `dispatch_business`. Both paths therefore decide the same way, speak the
 * same vocabulary and leave the same proof — which is the point: a reader could
 * not previously tell one path's silence from the other's absence.
 *
 * Usage:
 *   nrv team plan --business <slug> --brief <file> --project <dir> \
 *                  --outputs <dir> [--runtime <rt>] [--team|--single] [--safe] \
 *                  [--project-id <id>] [--save <plan.json>]
 *     → the plan on stdout as JSON. Emits x_chain_shape_decided +
 *       team_chain_selected (or team_director_failed, exit 1).
 *
 *   nrv team step --plan <plan.json> --index <n>
 *     → the employee's full prompt on stdout. Emits dispatch_business.
 *       Run that prompt in your own subagent; do not paraphrase it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { planChain, buildStepBrief, type ChainStep, type TeamRunArgs } from "../lib/team-orchestrator.ts";
import { resolveEntityDir } from "../../_shared/lib/entity-resource-map.ts";
import { harnessLogsDir } from "../../_shared/lib/log-paths.ts";
import type { Runtime } from "../lib/host-agent-driver.ts";

const SKILLS = process.env.NIRVANA_SKILLS_DIR
  || (fs.existsSync(path.join(os.homedir(), ".nirvana", "skills")) ? path.join(os.homedir(), ".nirvana", "skills") : path.join(os.homedir(), ".claude", "skills"));

const EXIT_OK = 0, EXIT_FAIL = 1, EXIT_ARGS = 4;

function emitAudit(payload: Record<string, any>, projectRoot?: string): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(harnessLogsDir({ cwd: projectRoot }), today);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n");
  } catch { /* non-fatal */ }
}

function die(msg: string, code = EXIT_FAIL): never {
  console.error(`nrv team: ${msg}`);
  process.exit(code);
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** The plan is the contract between the two halves: everything `step` needs to
 *  rebuild a step exactly as `runTeam` would, without re-deciding anything. */
interface ChainPlan {
  business: string;
  project_id: string;
  project_dir: string;
  project_root: string;
  outputs_root: string;
  brief_file: string;
  businesses_root?: string;
  intake: string;
  reason: string;
  chain: ChainStep[];
}

/** The seat that consolidates. Resolved through the businesses loader — the same
 *  owner `brief-business.ts` asks, so a business cannot have two answers. */
function intakeEmployee(bizDir: string): string {
  const loader = path.join(SKILLS, "businesses", "lib", "loader.ts");
  const r = spawnSync("bun", [loader, bizDir, "--field", "intake_employee"], { encoding: "utf8" });
  const name = (r.stdout || "").trim();
  if (name) return name;

  // The loader validates the whole manifest, so an empty answer has two very
  // different causes and only one of them is a missing intake seat. Blaming the
  // seat for an invalid `business.yaml` sends the reader to edit the right
  // directory for the wrong reason — pass its own words through instead.
  //
  // Note the loader refuses a business with no intake seat itself, with its own
  // integrity error — so there is no "missing intake" branch to write here. Its
  // wording is not always actionable ("Integrity check falhou"), which is why
  // the repair command goes in the same breath rather than being left for the
  // reader to remember.
  const why = (r.stderr || "").trim();
  const fix = `  Repair it with: nrv validate business ${path.basename(bizDir)} --fix`;
  if (why) die(`business at ${bizDir} could not be loaded:\n  ${why.split("\n").join("\n  ")}\n${fix}`);
  die(`business at ${bizDir} named no intake employee.\n${fix}`);
}

function cmdPlan(argv: string[]): void {
  const slug = arg(argv, "--business");
  const briefFile = arg(argv, "--brief");
  const projectDir = arg(argv, "--project");
  const outputsRoot = arg(argv, "--outputs");
  if (!slug || !briefFile || !projectDir || !outputsRoot) {
    die("plan needs --business, --brief, --project and --outputs.", EXIT_ARGS);
  }
  if (!fs.existsSync(briefFile)) die(`brief file not found: ${briefFile}`, EXIT_ARGS);

  const projectRoot = arg(argv, "--project-root") ?? projectDir;
  const projectId = arg(argv, "--project-id") ?? path.basename(projectDir);
  const businessesRoot = arg(argv, "--businesses-root");
  const bizDir = businessesRoot ? path.join(businessesRoot, slug) : resolveEntityDir("businesses", slug, projectDir);
  if (!fs.existsSync(bizDir)) die(`business '${slug}' not found at ${bizDir}`);

  const brief = fs.readFileSync(briefFile, "utf8");
  const intake = intakeEmployee(bizDir);

  const args: TeamRunArgs = {
    slug, brief, projectId, projectDir, projectRoot, outputsRoot,
    runtime: (arg(argv, "--runtime") ?? "claude-code") as Runtime,
    intakeEmployee: intake,
    forceChain: argv.includes("--team"),
    // `--single` skips the director outright: the user already decided, and
    // paying for a decision call to be told what you just said is waste.
    yolo: !argv.includes("--safe"),
    ...(businessesRoot ? { businessesRoot } : {}),
  };

  let chain: ChainStep[], reason: string;
  if (argv.includes("--single")) {
    chain = [{ employee: intake, task: "Carry the brief end to end." }];
    reason = "--single: the caller chose one seat";
    emitAudit({
      event: "x_chain_shape_decided", project_id: projectId, business_slug: slug,
      steps: 1, reason, forced: "single",
    }, projectRoot);
  } else {
    try { ({ chain, reason } = planChain(args)); }
    catch (e: any) { die(`director: ${e?.message || e}`); }
  }

  const plan: ChainPlan = {
    business: slug, project_id: projectId, project_dir: projectDir, project_root: projectRoot,
    outputs_root: outputsRoot, brief_file: path.resolve(briefFile),
    ...(businessesRoot ? { businesses_root: businessesRoot } : {}),
    intake, reason, chain,
  };

  const save = arg(argv, "--save");
  if (save) {
    fs.mkdirSync(path.dirname(save), { recursive: true });
    fs.writeFileSync(save, JSON.stringify(plan, null, 2));
  }
  console.log(JSON.stringify(plan, null, 2));
}

function cmdStep(argv: string[]): void {
  const planFile = arg(argv, "--plan");
  const indexRaw = arg(argv, "--index");
  if (!planFile || indexRaw === undefined) die("step needs --plan and --index.", EXIT_ARGS);
  if (!fs.existsSync(planFile)) die(`plan file not found: ${planFile}`, EXIT_ARGS);

  const plan: ChainPlan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const idx = Number(indexRaw);
  const total = plan.chain.length;
  if (!Number.isInteger(idx) || idx < 0 || idx >= total) {
    die(`--index ${indexRaw} is out of range: this plan has ${total} step(s), so 0..${total - 1}.`, EXIT_ARGS);
  }

  const step = plan.chain[idx];
  const isLast = idx === total - 1;
  // Same layout `runTeam` uses: colleagues write under `_team/<employee>/`, the
  // synthesizer writes the finals to the outputs root itself.
  const outDir = isLast ? plan.outputs_root : path.join(plan.outputs_root, "_team", step.employee);
  fs.mkdirSync(outDir, { recursive: true });

  // What the earlier seats produced, as they actually exist on disk. A seat that
  // was planned and did not run contributes nothing — the same rule the chain
  // applies, so a later step is never told to read a directory that is empty.
  const priorOutputs = plan.chain.slice(0, idx)
    .map(s => ({ employee: s.employee, dir: path.join(plan.outputs_root, "_team", s.employee) }))
    .filter(p => { try { return fs.readdirSync(p.dir).some(f => !f.startsWith(".")); } catch { return false; } });

  const brief = fs.readFileSync(plan.brief_file, "utf8");
  const stepBrief = buildStepBrief(step, idx, total, { brief, outputsRoot: plan.outputs_root }, priorOutputs, outDir);
  const stepBriefFile = path.join(outDir, ".step-brief.md");
  fs.writeFileSync(stepBriefFile, stepBrief);

  const bizDir = plan.businesses_root
    ? path.join(plan.businesses_root, plan.business)
    : resolveEntityDir("businesses", plan.business, plan.project_dir);

  const ep = spawnSync("bun", [
    path.join(SKILLS, "businesses/lib/employee-prompt.ts"),
    plan.business, step.employee, plan.project_dir, stepBriefFile, outDir,
  ], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    // The child resolves the business independently; handing it the library root
    // this plan settled on removes the second opinion.
    env: { ...process.env, BUSINESSES_DIR: path.dirname(bizDir) },
  });
  if (ep.status !== 0) {
    emitAudit({
      event: "team_step_failed", project_id: plan.project_id, business_slug: plan.business,
      employee: step.employee, reason: "employee-prompt build failed", error: ep.stderr?.slice(0, 500),
    }, plan.project_root);
    die(`could not build the prompt for ${step.employee}: ${ep.stderr?.slice(0, 300) || `exit ${ep.status}`}`);
  }

  // The proof. Emitted HERE rather than by the caller, because a caller that
  // must remember to audit is a caller that will eventually forget — which is
  // how two businesses and 23 seats produced one dispatch event between them.
  emitAudit({
    event: "dispatch_business", trace_id: plan.project_id, project_id: plan.project_id,
    business_slug: plan.business, employee: step.employee,
    mode: "chain-step", step: idx + 1, total,
  }, plan.project_root);

  process.stdout.write(ep.stdout);
  // Where to write, on stderr so it never contaminates the prompt on stdout.
  console.error(`[chain] step ${idx + 1}/${total} · ${step.employee} → ${outDir}`);
}

const argv = process.argv.slice(2);
const sub = argv[0];
if (!sub || sub === "-h" || sub === "--help") {
  console.log(`nrv team — run a business's org chart from your own runtime.

  nrv team plan --business <slug> --brief <file> --project <dir> --outputs <dir>
                 [--project-id <id>] [--project-root <dir>] [--runtime <rt>]
                 [--team | --single] [--safe] [--save <plan.json>]

      The director reads the brief against the org chart and answers with a
      chain and a reason. --team asks for 3 to 6 seats; --single skips the
      director. Prints the plan as JSON.

  nrv team step --plan <plan.json> --index <n>

      Prints the full prompt for step <n> — persona, mind-clone DNA, resource
      map, the colleagues' output paths and the scope guard. Run it in your own
      subagent, verbatim. Emits dispatch_business for that seat.

  Loop:
      nrv team plan … --save .nirvana/chain.json
      for i in 0 1 2: nrv team step --plan .nirvana/chain.json --index $i
                      → run each prompt in a subagent, in order.`);
  process.exit(EXIT_OK);
}
if (sub === "plan") cmdPlan(argv.slice(1));
else if (sub === "step") cmdStep(argv.slice(1));
else die(`unknown subcommand '${sub}'. Try: plan, step.`, EXIT_ARGS);
