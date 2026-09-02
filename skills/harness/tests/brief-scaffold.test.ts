// brief-scaffold.test.ts — a brief leaves no empty directory behind.
//
// The owner, looking at a real project in Finder on 2026-09-01, quoted as data:
// i18n-user-facing
// "por que o nirvana-os gera vários diretórios vazios? Uma zona de organização de output que não tem porra nenhuma coerente!"
//
// He was right, and the count was measurable. In ~/mastery-makers, 15 of the
// 514 directories under the two output roots were empty, and 13 of those came
// from one place: brief-business.ts pre-created `handoffs/`, `tickets/` and
// `employees/` at brief time, and brief-squad.ts pre-created `handoffs/`,
// before any work had happened and on the chance something would land there.
// Most runs write to none of them.
//
// `tickets` was the worst of the three. The protocol retired it — it sits in
// both RETIRED_MANIFEST_FIELDS and RETIRED_FILES in verify/kinds/business.ts,
// so `nrv validate` rejects a business that ships one — while the brief script
// created it on every single run.
//
// Removing the mkdirs outright would have broken the thing they were
// accidentally holding up: `fs.appendFileSync` does not create parent
// directories, and audit.jsonl is written into projectDir. So the fix creates
// projectDir itself — the one directory a file actually goes into — and
// nothing else. These cases pin both halves: the audit still lands, and no
// speculative child comes back.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempRoot, removeDir } from "./helpers/temp-dirs.ts";
import { spawnBudgetMs } from "./helpers/test-budgets.ts";
import { businessV1 } from "../../_shared/tests/fixtures/protocol-entities.ts";

const SKILLS = path.resolve(import.meta.dir, "..", "..");
const TMP = makeTempRoot("nrv-brief-scaffold-");

afterAll(() => removeDir(TMP));

/** Every directory under `dir` that holds no file anywhere beneath it. */
function emptyDirs(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): boolean => {
    let hasFile = false;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) hasFile = walk(path.join(d, e.name)) || hasFile;
      else hasFile = true;
    }
    if (!hasFile) out.push(path.relative(dir, d));
    return hasFile;
  };
  walk(dir);
  return out;
}

function runBrief(script: string, args: string[], home: string, projectRoot: string, logs: string) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    cwd: projectRoot,
    env: {
      ...process.env,
      SQUADS_DIR: path.join(home, "squads"),
      BUSINESSES_DIR: path.join(home, "businesses"),
      NIRVANA_HOME: home,
      NIRVANA_PROJECT_ROOT: projectRoot,
      NIRVANA_SKILLS_DIR: SKILLS,
      NIRVANA_RUN_LEDGER_DB: path.join(TMP, `${path.basename(projectRoot)}-ledger.sqlite`),
      HARNESS_LOGS_DIR: logs,
    },
  });
  if (r.status !== 0) throw new Error(`${path.basename(script)} failed (${r.status}): ${r.stdout}\n${r.stderr}`);
  return r;
}

describe("a squad brief creates the dir it writes into, and nothing else", () => {
  const home = path.join(TMP, "sq-home");
  const projectRoot = path.join(TMP, "sq-project");
  let outputs: string;

  beforeAll(() => {
    const squad = path.join(home, "squads", "fixture-squad");
    fs.mkdirSync(path.join(squad, "agents"), { recursive: true });
    fs.writeFileSync(path.join(squad, "agents", "fixture.md"), "# fixture\n");
    fs.writeFileSync(path.join(squad, "squad.yaml"), [
      "name: fixture-squad",
      "version: 1.0.0",
      'protocol: "5.0"',
      "description: A fixture squad used by the brief scaffold test.",
      "experimental_domains: true",
      "components:",
      "  agents: [fixture.md]",
      "  tasks: []",
      "  workflows: []",
      "capabilities:",
      "  - id: general.fixture.run",
      "    description: Do the fixture thing.",
      "    domains: [fixture]",
      "    produces: [nothing]",
      '    examples: ["rode o fixture"]',
      "    invoke:",
      "      type: agent",
      "      ref: fixture",
      "",
    ].join("\n"));
    fs.mkdirSync(projectRoot, { recursive: true });

    runBrief(
      path.join(SKILLS, "squads", "scripts", "brief-squad.ts"),
      ["fixture-squad", "Um brief qualquer para a fixture", "--project", "proj-sq"],
      home, projectRoot, path.join(TMP, "sq-logs"),
    );
    outputs = path.join(projectRoot, "outputs");
  }, spawnBudgetMs(1));

  test("the brief lands, so the run is real and not a no-op", () => {
    expect(fs.existsSync(path.join(outputs, "proj-sq", "brief.md"))).toBe(true);
  });

  test("audit.jsonl lands in projectDir — appendFileSync has a parent to write into", () => {
    const audit = path.join(outputs, "proj-sq", "squads", "fixture-squad", "audit.jsonl");
    expect(fs.existsSync(audit)).toBe(true);
    expect(fs.readFileSync(audit, "utf8")).toContain("brief_received");
  });

  test("no empty directory is left behind", () => {
    expect(emptyDirs(outputs)).toEqual([]);
  });

  test("the speculative handoffs/ is gone specifically", () => {
    expect(fs.existsSync(path.join(outputs, "proj-sq", "squads", "fixture-squad", "handoffs"))).toBe(false);
  });
});

describe("a business brief creates the dir it writes into, and nothing else", () => {
  const home = path.join(TMP, "biz-home");
  const projectRoot = path.join(TMP, "biz-project");
  let outputs: string;

  beforeAll(() => {
    const biz = businessV1(path.join(home, "businesses"), "fixture-biz");
    // The shared fixture still writes the pre-6.0 chart shape (`id` /
    // `reports_to`), which the current validator rejects. Overwrite it here
    // rather than editing the fixture: this test is about empty directories,
    // and every other consumer of businessV1 passes as-is.
    fs.writeFileSync(path.join(biz, "org-chart.yaml"), [
      "chart:",
      "  - employee: intake",
      "    reports: []",
      "    direct_reports: []",
      "",
    ].join("\n"));
    fs.mkdirSync(projectRoot, { recursive: true });

    runBrief(
      path.join(SKILLS, "businesses", "scripts", "brief-business.ts"),
      ["fixture-biz", "Um brief qualquer para a fixture", "--project", "proj-biz"],
      home, projectRoot, path.join(TMP, "biz-logs"),
    );
    outputs = path.join(projectRoot, "outputs");
  }, spawnBudgetMs(1));

  test("audit.jsonl lands in projectDir", () => {
    const audit = path.join(outputs, "proj-biz", "businesses", "fixture-biz", "audit.jsonl");
    expect(fs.existsSync(audit)).toBe(true);
    expect(fs.readFileSync(audit, "utf8")).toContain("brief_received");
  });

  test("no empty directory is left behind", () => {
    expect(emptyDirs(outputs)).toEqual([]);
  });

  test("tickets/ is never created — the protocol retired it", () => {
    const dir = path.join(outputs, "proj-biz", "businesses", "fixture-biz");
    for (const speculative of ["tickets", "handoffs", "employees"]) {
      expect(fs.existsSync(path.join(dir, speculative))).toBe(false);
    }
  });
});

describe("the contract points agents at the real outputs root", () => {
  // The root moved from <project>/.nirvana/outputs to <project>/outputs on
  // 2026-08-11 (engine 0.3.3, 63e4f4c). The contract files were not updated
  // with it, so for three weeks the orchestrator read `.nirvana/outputs/` from
  // its own instructions and created a mirror tree there while every script
  // wrote to `outputs/`. Measured in ~/mastery-makers: the mirror held 5 files,
  // all of them .DS_Store, beside a real tree of 6,101 files and 265 MB. 52
  // projects on the owner's machine carried the ghost, 28 carried both.
  const CONTRACTS = [
    "AGENTS.md", "CLAUDE.md", "GEMINI.md",
    path.join("skills", "_shared", "templates", "AGENTS.md"),
    path.join("skills", "harness", "SKILL.md"),
  ];
  const REPO = path.resolve(SKILLS, "..");

  test("no contract tells an agent to write under .nirvana/outputs", () => {
    for (const rel of CONTRACTS) {
      const body = fs.readFileSync(path.join(REPO, rel), "utf8");
      expect(`${rel}: ${body.includes(".nirvana/outputs")}`).toBe(`${rel}: false`);
    }
  });

  test("the template nrv init copies names the real root, so new projects start correct", () => {
    const tpl = fs.readFileSync(path.join(REPO, "skills", "_shared", "templates", "AGENTS.md"), "utf8");
    expect(tpl).toContain("`outputs/<trace>/audit.jsonl`");
  });
});
