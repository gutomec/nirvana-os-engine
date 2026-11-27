// evidence.test.ts — `nrv evidence`: each kind of proof in each of its answers,
// from a library, a state folder and an audit built in a temp dir. The library
// functions run in-process with every source named; the command and the host
// dimension run as real processes with their own home.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fakeHomeEnv } from "./helpers/fake-home.ts";
import { removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";
import {
  ANSWERS, DIMENSIONS, changedSinceEvidence, deliveredEvidence, dependenciesEvidence, entityEvidence, hostEvidence,
  newestFile, renderEntity, renderTable, resetEvidenceCache, structureEvidence, type EvidenceOptions, type Kind,
} from "../lib/evidence.ts";
import { extractSurface } from "../../_shared/lib/surface.ts";

const { toEnvelope } = createRequire(import.meta.url)("../../_shared/lib/cloudevents.js");

const SKILLS = path.resolve(import.meta.dir, "..", "..");
const EVIDENCE = path.join(SKILLS, "harness", "scripts", "evidence.ts");
const TEAM = path.join(SKILLS, "harness", "scripts", "team.ts");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-evidence-")));
const home = path.join(root, "home");
const state = path.join(root, "state");
const logs = path.join(root, "logs");
const obRoot = path.join(root, "OpenBot");
const cwd = path.join(root, "elsewhere");
const squadDir = path.join(home, "squads", "alpha");
const bareSquadDir = path.join(home, "squads", "bare");
const bizDir = path.join(home, "businesses", "acme");
const cloneDir = path.join(home, "businesses", "_library", "dna", "sage");
afterAll(() => removeDir(root));

const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, "utf8"); };
const at = (iso: string) => new Date(iso);
/** Give every file of a folder one date, so "newer than the delivery" is the test's to decide. */
function dateTree(dir: string, when: Date): void {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) dateTree(abs, when);
    else fs.utimesSync(abs, when, when);
  }
}

write(path.join(squadDir, "squad.yaml"), "name: alpha\nversion: 1.0.0\ndescription: Writes a short text\n");
write(path.join(squadDir, "agents", "writer.md"), "---\nname: Writer\n---\nWrites.\n");
write(path.join(bareSquadDir, "squad.yaml"), "name: bare\nversion: 1.0.0\n");
write(path.join(bizDir, "business.yaml"), "name: acme\nversion: 1.0.0\nsquads_authorized: [alpha]\n");
write(path.join(bizDir, "employees", "writer.md"), "---\nname: Writer\nrole: Writes the piece\n---\nWrites the piece.\n");
write(path.join(cloneDir, "MANIFEST.yaml"), "slug: sage\nname: Sage\n");
write(path.join(cloneDir, "agent", "AGENT.md"), "# Sage\n");
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(path.join(home, ".nirvana"), { recursive: true });

const OLD = at("2026-01-01T00:00:00Z");
const DELIVERED = "2026-03-10T12:00:00.000Z";

let day = 0;
/** A fresh audit root holding the given events; legacy lines, or envelopes when asked. */
function audit(events: Array<Record<string, unknown>>, envelope = false): string {
  const dir = path.join(logs, `case-${++day}`);
  const lines = events.map((e) => JSON.stringify(envelope ? toEnvelope(e) : e));
  write(path.join(dir, "2026-03-10", "audit.jsonl"), lines.join("\n") + "\n");
  resetEvidenceCache();
  return dir;
}
const ev = (event: string, trace: string, ts: string, rest: Record<string, unknown> = {}) => ({ event, ts, trace_id: trace, project_id: trace, ...rest });
/** One business run: dispatched, gated, and ended as named. */
function run(trace: string, ts: string, end: "pass" | "reservations" | "withheld" | "none", slug = "acme"): Array<Record<string, unknown>> {
  const b = { business_slug: slug };
  const out = [ev("dispatch_business", trace, ts, b)];
  if (end === "pass") out.push(ev("gate_passed", trace, ts, b), ev("delivered", trace, ts, { ...b, gate: "pass", files: 2 }));
  if (end === "reservations") out.push(ev("gate_failed", trace, ts, b), ev("x_delivered_with_reservations", trace, ts, b), ev("delivered", trace, ts, { ...b, gate: "fail-accepted", reservations: true }));
  if (end === "withheld") out.push(ev("gate_failed", trace, ts, b), ev("x_delivery_withheld", trace, ts, { ...b, gate: "fail" }));
  return out;
}

const opts = (over: EvidenceOptions = {}): EvidenceOptions => ({
  stateDir: state, auditRoots: [], baselinePath: null, cwd, teamDirs: [], env: {},
  which: () => null,
  resolve: (kind, slug) => {
    const dir = kind === "squad" ? path.join(home, "squads", slug) : kind === "business" ? path.join(home, "businesses", slug) : path.join(home, "businesses", "_library", "dna", slug);
    return fs.existsSync(dir) ? dir : null;
  },
  ...over,
});

const verifyRecord = (slug: string, kind: Kind, dir: string, over: Record<string, unknown> = {}) => write(path.join(state, slug, "verify.json"), JSON.stringify({
  schema: "nirvana.verify-report/v1", kind, slug, dir, verdict: "ADMITTED", summary: { errors: 0, warnings: 0, debt: 0, passed: 9 },
  findings: [], strict: false, checked_at: "2026-02-01T00:00:00.000Z", ...over,
}));

beforeEach(() => {
  fs.rmSync(state, { recursive: true, force: true });
  for (const dir of [squadDir, bareSquadDir, bizDir, cloneDir]) dateTree(dir, OLD);
});

describe("structure", () => {
  const stub = (findings: unknown[]) => ({ kind: "squad", criteria: [], check: async () => findings }) as any;

  test("an entity the library does not have is not measured", async () => {
    const e = await structureEvidence("squad", "ghost", opts());
    expect(e.answer).toBe("not measured");
    expect(e.detail).toContain("no squad named ghost");
  });

  test("with nothing recorded and no live run it is not measured, and says what measures it", async () => {
    const e = await structureEvidence("squad", "alpha", opts({ live: false }));
    expect(e.answer).toBe("not measured");
    expect(e.action).toBe("nrv validate squad alpha");
  });

  test("a recorded admission newer than every file is verified, with its date and source", async () => {
    verifyRecord("alpha", "squad", squadDir);
    const e = await structureEvidence("squad", "alpha", opts({ live: false }));
    expect(e.answer).toBe("verified");
    expect(e.date).toBe("2026-02-01T00:00:00.000Z");
    expect(e.proof).toContain(path.join(state, "alpha", "verify.json"));
  });

  test("a recorded rejection is failed and names the errors", async () => {
    verifyRecord("alpha", "squad", squadDir, {
      verdict: "REJECTED", summary: { errors: 1, warnings: 0, debt: 0, passed: 8 },
      findings: [{ id: "manifest_parse", severity: "error", autofix: "none", message: "squad.yaml does not parse", evidence: "", baselined: false }],
    });
    const e = await structureEvidence("squad", "alpha", opts({ live: false }));
    expect(e.answer).toBe("failed");
    expect(e.detail).toContain("manifest_parse");
  });

  test("a rejection under --strict with no error is still an admission", async () => {
    verifyRecord("alpha", "squad", squadDir, { verdict: "REJECTED", strict: true, summary: { errors: 0, warnings: 2, debt: 0, passed: 7 } });
    expect((await structureEvidence("squad", "alpha", opts({ live: false }))).answer).toBe("verified");
  });

  test("a file changed after the recorded result makes it stale, not verified", async () => {
    verifyRecord("alpha", "squad", squadDir);
    fs.utimesSync(path.join(squadDir, "agents", "writer.md"), at("2026-02-02T00:00:00Z"), at("2026-02-02T00:00:00Z"));
    const e = await structureEvidence("squad", "alpha", opts({ live: false }));
    expect(e.answer).toBe("stale");
    expect(e.detail).toContain(path.join("agents", "writer.md"));
    expect(e.action).toBe("nrv validate squad alpha");
  });

  test("a result recorded for another kind under the same slug is not this entity's", async () => {
    verifyRecord("alpha", "business", squadDir);
    expect((await structureEvidence("squad", "alpha", opts({ live: false }))).answer).toBe("not measured");
  });

  test("with nothing recorded the checks run here, writing nothing", async () => {
    const ok = await structureEvidence("squad", "alpha", opts({ module: stub([]) }));
    expect(ok.answer).toBe("verified");
    expect(ok.proof).toContain("without writing anything");
    const bad = await structureEvidence("squad", "alpha", opts({ module: stub([{ id: "agents_missing", severity: "error", autofix: "none", message: "no agent", evidence: "", baselined: false }]) }));
    expect(bad.answer).toBe("failed");
    expect(bad.detail).toContain("agents_missing");
    expect(fs.existsSync(state)).toBe(false);
  });

  test("checks that throw leave it not measured", async () => {
    const e = await structureEvidence("squad", "alpha", opts({ module: { kind: "squad", criteria: [], check: async () => { throw new Error("boom"); } } as any }));
    expect(e.answer).toBe("not measured");
    expect(e.detail).toContain("boom");
  });
});

describe("delivered", () => {
  test("an empty or absent audit is not measured", () => {
    expect(deliveredEvidence("business", "acme", opts()).answer).toBe("not measured");
    const e = deliveredEvidence("business", "acme", opts({ auditRoots: [path.join(root, "no-such-logs")] }));
    expect(e.answer).toBe("not measured");
    expect(e.action).toContain("nrv dispatch acme");
  });

  test("a dispatch that never reached a verdict is not measured", () => {
    const e = deliveredEvidence("business", "acme", opts({ auditRoots: [audit(run("t1", DELIVERED, "none"))] }));
    expect(e.answer).toBe("not measured");
    expect(e.detail).toContain("1 run(s) were dispatched");
  });

  test("one passing delivery is verified, counted beside the ones that did not pass", () => {
    const logsDir = audit([
      ...run("t1", "2026-03-01T10:00:00.000Z", "withheld"),
      ...run("t2", DELIVERED, "pass"),
      ...run("t3", "2026-03-12T10:00:00.000Z", "reservations"),
      ...run("t4", "2026-03-13T10:00:00.000Z", "pass", "another-business"),
    ]);
    const e = deliveredEvidence("business", "acme", opts({ auditRoots: [logsDir] }));
    expect(e.answer).toBe("verified");
    expect(e.date).toBe(DELIVERED);
    expect(e.detail).toContain("1 delivered with the gate passing, 1 delivered with reservations, 1 withheld");
    expect(e.proof).toContain("run t2");
    expect(e.data).toMatchObject({ dispatched: 3, passed: 1, with_reservations: 1, withheld: 1 });
  });

  test("runs that were only withheld or accepted with reservations are failed", () => {
    const e = deliveredEvidence("business", "acme", opts({ auditRoots: [audit([...run("t1", "2026-03-01T10:00:00.000Z", "reservations"), ...run("t2", DELIVERED, "withheld")])] }));
    expect(e.answer).toBe("failed");
    expect(e.detail).toContain("no run passed the gate");
    expect(e.detail).toContain("withheld");
  });

  test("a squad is found by its dispatch and a clone by its DNA being loaded, in either line format", () => {
    const events = [
      ev("dispatch_squad", "s1", DELIVERED, { squad_slug: "alpha", squad_name: "alpha" }),
      ev("mind_clone_injected", "s1", DELIVERED, { slug: "sage" }),
      ev("gate_passed", "s1", DELIVERED),
      ev("delivered", "s1", DELIVERED, { gate: "pass" }),
    ];
    for (const envelope of [false, true]) {
      const logsDir = audit(events, envelope);
      expect(deliveredEvidence("squad", "alpha", opts({ auditRoots: [logsDir] })).answer).toBe("verified");
      expect(deliveredEvidence("mind-clone", "sage", opts({ auditRoots: [logsDir] })).answer).toBe("verified");
      expect(deliveredEvidence("squad", "bare", opts({ auditRoots: [logsDir] })).answer).toBe("not measured");
    }
  });
});

describe("changed since", () => {
  test("with no passing delivery there is nothing to compare, so it is not measured", () => {
    expect(changedSinceEvidence("business", "acme", opts()).answer).toBe("not measured");
    expect(changedSinceEvidence("business", "ghost", opts()).answer).toBe("not measured");
  });

  test("files older than the delivery: verified, labelled by file date", () => {
    const e = changedSinceEvidence("business", "acme", opts({ auditRoots: [audit(run("t1", DELIVERED, "pass"))] }));
    expect(e.answer).toBe("verified");
    expect(e.detail).toStartWith("by file date");
  });

  test("a file changed after the delivery: stale, and the delivery stops reading as verified", async () => {
    const logsDir = audit(run("t1", DELIVERED, "pass"));
    fs.utimesSync(path.join(bizDir, "employees", "writer.md"), at("2026-03-11T00:00:00Z"), at("2026-03-11T00:00:00Z"));
    const e = changedSinceEvidence("business", "acme", opts({ auditRoots: [logsDir] }));
    expect(e.answer).toBe("stale");
    expect(e.detail).toContain(path.join("employees", "writer.md"));
    expect(e.detail).toContain("by file date");

    const all = await entityEvidence("business", "acme", opts({ auditRoots: [logsDir], live: false }));
    expect(all.evidence.delivered.answer).toBe("stale");
    expect(all.evidence.delivered.detail).toContain("earlier version");
    expect(renderEntity(all)).toContain("delivered: stale");
    expect(renderEntity(all)).not.toContain("delivered: verified");
  });

  test("generated files and dot entries are not the entity changing", () => {
    const logsDir = audit(run("t1", DELIVERED, "pass"));
    write(path.join(bizDir, ".nirvana-surface.json"), "{}");
    write(path.join(bizDir, "CHANGELOG.md"), "# changes\n");
    write(path.join(bizDir, ".DS_Store"), "x");
    expect(newestFile(bizDir)!.mtimeMs).toBe(OLD.getTime());
    expect(changedSinceEvidence("business", "acme", opts({ auditRoots: [logsDir] })).answer).toBe("verified");
    for (const f of [".nirvana-surface.json", "CHANGELOG.md", ".DS_Store"]) fs.rmSync(path.join(bizDir, f));
  });

  test("a surface hash recorded at dispatch decides by content, whatever the file dates say", () => {
    const hash = extractSurface(squadDir, "squad").surface_hash;
    const events = (surface_hash: string) => [
      ev("dispatch_squad", "s1", DELIVERED, { squad_slug: "alpha", surface_hash }),
      ev("delivered", "s1", DELIVERED, { gate: "pass" }),
    ];
    fs.utimesSync(path.join(squadDir, "agents", "writer.md"), at("2026-03-11T00:00:00Z"), at("2026-03-11T00:00:00Z"));
    const same = changedSinceEvidence("squad", "alpha", opts({ auditRoots: [audit(events(hash))] }));
    expect(same.answer).toBe("verified");
    expect(same.detail).toStartWith("by content hash");
    const other = changedSinceEvidence("squad", "alpha", opts({ auditRoots: [audit(events("0".repeat(64)))] }));
    expect(other.answer).toBe("stale");
  });
});

describe("dependencies", () => {
  const deps = (text: string) => { write(path.join(squadDir, "dependencies.yaml"), text); dateTree(squadDir, OLD); };
  afterAll(() => fs.rmSync(path.join(squadDir, "dependencies.yaml"), { force: true }));

  test("a mind-clone declares nothing; a squad with no declaration has nothing to check; a missing one is not measured", () => {
    expect(dependenciesEvidence("mind-clone", "sage", opts()).answer).toBe("does not apply");
    expect(dependenciesEvidence("squad", "bare", opts()).answer).toBe("does not apply");
    expect(dependenciesEvidence("squad", "ghost", opts()).answer).toBe("not measured");
  });

  test("a program off PATH and a required credential not set are failed, each named", () => {
    deps("system:\n  - ffmpeg >= 6.0\n  - name: ImageMagick\n    check: magick -version\nenv_vars:\n  required:\n    - name: ACME_API_KEY\n");
    const e = dependenciesEvidence("squad", "alpha", opts({ which: (tool) => (tool === "magick" ? "/usr/bin/magick" : null) }));
    expect(e.answer).toBe("failed");
    expect(e.detail).toContain("the program ffmpeg is not on PATH");
    expect(e.detail).toContain("the credential ACME_API_KEY is not set");
    expect(e.detail).not.toContain("magick");
    expect(e.action).toContain("ffmpeg");
  });

  test("everything present is verified, and a secret is only ever 'set'", () => {
    deps("system:\n  - ffmpeg\nenv_vars:\n  required:\n    - name: ACME_API_KEY\n  optional:\n    - name: ACME_REGION\n");
    const e = dependenciesEvidence("squad", "alpha", opts({ which: () => "/usr/bin/ffmpeg", env: { ACME_API_KEY: "s3cr3t-value-123" } }));
    expect(e.answer).toBe("verified");
    expect(e.detail).toContain("optional and absent: ACME_REGION");
    expect(JSON.stringify(e)).not.toContain("s3cr3t-value-123");
    expect((e.data!.items as any[]).find((i) => i.name === "ACME_API_KEY").state).toBe("set");
  });

  test("declared packages: not measured before activation, verified after, stale once the declaration changes", () => {
    deps("python:\n  - requests\n");
    const before = dependenciesEvidence("squad", "alpha", opts());
    expect(before.answer).toBe("not measured");
    expect(before.action).toBe("nrv activate alpha");

    write(path.join(state, "alpha", "activated.json"), JSON.stringify({ slug: "alpha", activated_at: "2026-02-01T00:00:00.000Z" }));
    expect(dependenciesEvidence("squad", "alpha", opts()).answer).toBe("verified");

    fs.utimesSync(path.join(squadDir, "dependencies.yaml"), at("2026-02-05T00:00:00Z"), at("2026-02-05T00:00:00Z"));
    expect(dependenciesEvidence("squad", "alpha", opts()).answer).toBe("stale");
  });

  test("a business needs what its squads need, and a squad it names that is not installed fails it", () => {
    deps("system:\n  - ffmpeg\n");
    const missing = dependenciesEvidence("business", "acme", opts());
    expect(missing.answer).toBe("failed");
    expect(missing.detail).toContain("ffmpeg (alpha)");
    expect(dependenciesEvidence("business", "acme", opts({ which: () => "/usr/bin/ffmpeg" })).answer).toBe("verified");

    write(path.join(bizDir, "business.yaml"), "name: acme\nversion: 1.0.0\nsquads_authorized: [alpha, nowhere]\n");
    const unknown = dependenciesEvidence("business", "acme", opts({ which: () => "/usr/bin/ffmpeg" }));
    expect(unknown.answer).toBe("failed");
    expect(unknown.detail).toContain("the squad nowhere is not installed");
    write(path.join(bizDir, "business.yaml"), "name: acme\nversion: 1.0.0\nsquads_authorized: [alpha]\n");
  });
});

describe("text", () => {
  test("not measured is never rendered as verified, in the sentence or in the table", async () => {
    const e = await entityEvidence("squad", "bare", opts({ live: false }));
    expect(DIMENSIONS.map((d) => e.evidence[d].answer)).toEqual(["not measured", "not measured", "not measured", "does not apply", "does not apply"]);
    const text = renderEntity(e);
    expect(text).not.toContain("verified");
    expect(text).toContain("structure: not measured");
    expect(text).toContain("To measure it: nrv validate squad bare");
    expect(text).toContain("Not measured is not a pass.");
    expect(text).not.toContain("?");
    const table = renderTable([e]);
    expect(table.split("\n")[1]).toMatch(/^squad\s+bare\s+not measured\s+not measured\s+not measured\s+does not apply\s+does not apply$/);
    expect(table).toContain("0 verified");
  });

  test("an entity that does not exist answers without throwing", async () => {
    const e = await entityEvidence("business", "ghost", opts());
    expect(e.dir).toBeNull();
    for (const d of DIMENSIONS) expect(ANSWERS).toContain(e.evidence[d].answer);
    expect(DIMENSIONS.some((d) => e.evidence[d].answer === "verified")).toBe(false);
  });
});

// ── as a process, with its own home ──────────────────────────────────

function cli(script: string, args: string[], extra: Record<string, string> = {}): { code: number; out: string; err: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "NIRVANA_PROJECT_ROOT") env[k] = v;
  Object.assign(env, fakeHomeEnv(home, {
    NIRVANA_HOME: home, NIRVANA_SKILLS_DIR: SKILLS, NIRVANA_SCOPE_QUIET: "1", NIRVANA_ORCA_HOST: "off",
    NIRVANA_STATE_DIR: state, HARNESS_LOGS_DIR: path.join(logs, "cli"),
    NIRVANA_OPENBOT_DIR: obRoot, NIRVANA_OPENBOT_STATE: path.join(root, "openbot-state.json"), NIRVANA_OPENBOT_DB: path.join(root, "openbot.db"),
    NIRVANA_HERMES_HOME: path.join(root, "hermes"), ...extra,
  }) as Record<string, string>);
  const r = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const auditFiles = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith("audit.jsonl")) : []);

describe("nrv evidence as an agent runs it", () => {
  test("one entity: every dimension in plain sentences, exit 0, and --json carries the same answers", () => {
    write(path.join(logs, "cli", "2026-03-10", "audit.jsonl"), run("t1", DELIVERED, "pass").map((e) => JSON.stringify(e)).join("\n") + "\n");
    const before = fs.readFileSync(path.join(logs, "cli", "2026-03-10", "audit.jsonl"), "utf8");

    const text = cli(EVIDENCE, ["business", "acme"]);
    expect(text.code).toBe(0);
    for (const title of ["structure:", "delivered: verified (2026-03-10)", "changed since: verified", "dependencies:", "on a host: does not apply"]) expect(text.out).toContain(title);
    expect(text.out.trimEnd().endsWith("?")).toBe(false);

    const json = cli(EVIDENCE, ["business", "acme", "--json"]);
    expect(json.code).toBe(0);
    const doc = JSON.parse(json.out);
    expect(doc.schema).toBe("nirvana.evidence/v1");
    expect(Object.keys(doc.evidence)).toEqual([...DIMENSIONS]);
    for (const d of DIMENSIONS) expect(ANSWERS).toContain(doc.evidence[d].answer);
    expect(doc.evidence.delivered.data.passed).toBe(1);
    // The admission checks ran here, on this fixture: an answer, never "not measured".
    expect(["verified", "failed"]).toContain(doc.evidence.structure.answer);

    // A read: no audit event, no recorded gate result.
    expect(auditFiles(path.join(logs, "cli"))).toEqual([path.join("2026-03-10", "audit.jsonl")]);
    expect(fs.readFileSync(path.join(logs, "cli", "2026-03-10", "audit.jsonl"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(state, "acme", "verify.json"))).toBe(false);
  }, spawnBudgetMs(2));

  test("--all is one row per entity and one column per dimension; --kind narrows it", () => {
    const all = cli(EVIDENCE, ["--all"]);
    expect(all.code).toBe(0);
    const lines = all.out.split("\n");
    expect(lines[0]).toMatch(/^kind\s+entity\s+structure\s+delivered\s+changed since\s+dependencies\s+on a host$/);
    expect(lines.some((l) => /^business\s+acme\s+not measured\s+verified\s+verified/.test(l))).toBe(true);
    expect(lines.some((l) => /^squad\s+bare\s+not measured\s+not measured\s+not measured/.test(l))).toBe(true);
    expect(lines.some((l) => /^clone\s+sage\s/.test(l))).toBe(true);
    expect(all.out).toContain("Not measured is not a pass.");

    const squads = JSON.parse(cli(EVIDENCE, ["--all", "--kind", "squad", "--json"]).out);
    expect(squads.entities.map((e: any) => e.slug).sort()).toEqual(["alpha", "bare"]);
  }, spawnBudgetMs(2));

  test("wrong arguments exit 4 with the usage; an unknown slug is still a read", () => {
    for (const args of [[], ["squad"], ["planet", "alpha"], ["squad", "alpha", "extra"], ["--all", "--kind", "planet"]]) {
      const r = cli(EVIDENCE, args);
      expect(r.code).toBe(4);
      expect(r.err).toContain("usage: nrv evidence");
    }
    const ghost = cli(EVIDENCE, ["clone", "ghost"]);
    expect(ghost.code).toBe(0);
    expect(ghost.out).toContain("no mind-clone named ghost");
    expect(ghost.out).not.toContain("verified");
  }, spawnBudgetMs(6));

  test("on a host: a team that names the entity and is not synced fails; synced, it is verified; a squad is found by its workflow", () => {
    const teamDir = path.join(home, ".nirvana", "teams", "duo");
    write(path.join(teamDir, ".nirvana", "team.yaml"), [
      "team: duo", 'display_name: "Duo"', "orchestrator: director", "members:",
      '  - id: director', '    name: "Duo Director"', "    tier: lead",
      '    expert: { role: "Runs the project", delivers: "The delivery", done_when: "Every part exists" }',
      '  - id: writer', '    name: "Duo Writer"', "    role_from: acme/writer", "    clones: [sage]", "    reports_to: director", "",
    ].join("\n"));
    const host = (kind: string, slug: string) => JSON.parse(cli(EVIDENCE, [kind, slug, "--json"]).out).evidence.on_host;

    const unsynced = host("business", "acme");
    expect(unsynced.answer).toBe("failed");
    expect(unsynced.action).toBe("nrv team sync --team duo");

    const sync = cli(TEAM, ["sync", "--team", "duo", "--host", "claude-code"]);
    expect(sync.code).toBe(0);
    const biz = host("business", "acme");
    expect(biz.answer).toBe("verified");
    expect(biz.detail).toContain("Claude Code subagent duo-writer");
    expect(host("clone", "sage").answer).toBe("verified");

    expect(host("squad", "alpha").answer).toBe("does not apply");
    fs.mkdirSync(path.join(obRoot, "Agents", "agent-prime"), { recursive: true });
    write(path.join(home, ".nirvana", "state", "openbot-flows.json"), JSON.stringify({
      "agent-prime": [{ squad: "alpha", workflow: "main", workflowId: "wf_1", title: "Alpha main", description: "", revision: "r1" }],
    }));
    const squad = host("squad", "alpha");
    expect(squad.answer).toBe("verified");
    expect(squad.detail).toContain("wf_1");
  }, spawnBudgetMs(8));
});

test("hostEvidence with no team to read does not apply, and never throws", () => {
  expect(hostEvidence("business", "acme", opts()).answer).toBe("does not apply");
  expect(hostEvidence("mind-clone", "sage", opts({ teamDirs: [path.join(root, "no-such-team")] })).answer).toBe("does not apply");
});
