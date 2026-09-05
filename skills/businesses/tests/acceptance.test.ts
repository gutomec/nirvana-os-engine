// acceptance.test.ts — the acceptance contract a business declares per role
// (Business Protocol 2.0 §11), read into the Gauntlet's requirements and into the
// completeness check. Pure: fixtures on disk, no process, no registry outside them.
// Runs with: bun test skills/businesses/tests
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ACCEPTANCE_MAX, businessDirFor, readAcceptance } from "../lib/acceptance.ts";
import { verifyDeliverableOnDisk } from "../scripts/verify-deliverable.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function business(employees: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-acceptance-")); roots.push(root);
  fs.writeFileSync(path.join(root, "business.yaml"), "name: fixture\n", "utf8");
  fs.mkdirSync(path.join(root, "employees"), { recursive: true });
  for (const [name, front] of Object.entries(employees)) {
    fs.writeFileSync(path.join(root, "employees", `${name}.md`), `---\nname: ${name}\n${front}---\n\n# ${name}\n`, "utf8");
  }
  return root;
}

describe("readAcceptance", () => {
  test("a role's criteria become requirements, blocking by default and namespaced", () => {
    const dir = business({ "brief-intake": "acceptance:\n  - id: sources_cited\n    description: Cada afirmação cita a fonte\n  - id: one_page\n    description: Cabe em uma página\n    blocking: false\n    minimum_score: 0.6\n" });
    const read = readAcceptance(dir, ["brief-intake"], { minimumScore: 0.85 });
    expect(read.requirements).toEqual([
      { id: "acceptance.sources_cited", description: "Cada afirmação cita a fonte", capability: "quality.specification_conformance", blocking: true, minimumScore: 0.85 },
      { id: "acceptance.one_page", description: "Cabe em uma página", capability: "quality.specification_conformance", blocking: false, minimumScore: 0.6 },
    ]);
  });

  test("reads only the roles asked for, and every role when none is named", () => {
    const dir = business({
      "brief-intake": "acceptance:\n  - id: intake_rule\n    description: A do intake\n",
      "editor": "acceptance:\n  - id: editor_rule\n    description: A do editor\n",
    });
    expect(readAcceptance(dir, ["brief-intake"]).entries.map(entry => entry.id)).toEqual(["intake_rule"]);
    expect(readAcceptance(dir).entries.map(entry => entry.id)).toEqual(["intake_rule", "editor_rule"]);
    expect(readAcceptance(dir).entries.map(entry => entry.employee)).toEqual(["brief-intake", "editor"]);
  });

  test("the same id declared by two roles contributes one requirement", () => {
    const dir = business({
      "a-role": "acceptance:\n  - id: house_rule\n    description: A regra da casa\n",
      "b-role": "acceptance:\n  - id: house_rule\n    description: A mesma regra, copiada\n",
    });
    expect(readAcceptance(dir).requirements.map(item => item.id)).toEqual(["acceptance.house_rule"]);
  });

  test("entries with a path are the completeness promise; the rest is ignored there", () => {
    const dir = business({ "brief-intake": "acceptance:\n  - id: has_report\n    description: Entrega o relatório\n    path: report.md\n    min_bytes: 10\n  - id: no_path\n    description: Sem arquivo\n" });
    expect(readAcceptance(dir).paths).toEqual([{ path: "report.md", minBytes: 10 }]);
  });

  test("a malformed or absent business is an empty contract, never a throw", () => {
    expect(readAcceptance("/definitely/not/here")).toEqual({ entries: [], requirements: [], paths: [] });
    const dir = business({ "broken": "acceptance: not-a-list\n" });
    fs.writeFileSync(path.join(dir, "employees", "no-frontmatter.md"), "# nada\n", "utf8");
    expect(readAcceptance(dir).entries).toEqual([]);
  });

  test("the ceiling keeps the contract inside the judge's twelve requirements", () => {
    const many = Array.from({ length: 20 }, (_, index) => `  - id: c_${index}\n    description: criterion ${index}\n`).join("");
    const dir = business({ "brief-intake": `acceptance:\n${many}` });
    const read = readAcceptance(dir);
    expect(read.entries).toHaveLength(20);
    expect(read.requirements).toHaveLength(ACCEPTANCE_MAX);
  });

  test("businessDirFor prefers the registry, falls back to the businesses dir, and admits when it has neither", () => {
    const dir = business({ "brief-intake": "acceptance: []\n" });
    const registry = path.join(dir, "registry.json");
    fs.writeFileSync(registry, JSON.stringify({ businesses: { fixture: { manifest_path: path.join(dir, "business.yaml") } } }), "utf8");
    expect(businessDirFor("fixture", { registryPath: registry })).toBe(dir);
    // No registry: <businessesDir>/<slug>, and only when it really holds a business.yaml.
    const businessesDir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-businesses-")); roots.push(businessesDir);
    fs.mkdirSync(path.join(businessesDir, "fixture"), { recursive: true });
    fs.writeFileSync(path.join(businessesDir, "fixture", "business.yaml"), "name: fixture\n", "utf8");
    expect(businessDirFor("fixture", { registryPath: path.join(dir, "missing.json"), businessesDir }))
      .toBe(path.join(businessesDir, "fixture"));
    expect(businessDirFor("ghost", { registryPath: registry, businessesDir })).toBeNull();
  });
});

describe("verify-deliverable reads the acceptance promise", () => {
  function project(files: Record<string, string>): { cwd: string; outputsRoot: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-acceptance-project-")); roots.push(root);
    const projectDir = path.join(root, "outputs", "prj_1");
    const outputsRoot = path.join(projectDir, "deliverables");
    fs.mkdirSync(outputsRoot, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "brief.md"), "Produza o relatório.\n", "utf8");
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(outputsRoot, name), body, "utf8");
    return { cwd: root, outputsRoot };
  }

  test("a promised path that exists passes, and manifest_source names the acceptance", () => {
    const bizDir = business({ "brief-intake": "acceptance:\n  - id: has_report\n    description: Entrega o relatório\n    path: report.md\n    min_bytes: 10\n" });
    const { cwd, outputsRoot } = project({ "report.md": "Um relatório com corpo suficiente para não ser stub.\n" });
    const saved = process.cwd();
    try {
      process.chdir(cwd);
      const report = verifyDeliverableOnDisk("prj_1", "fixture", { outputsRoot, businessDir: bizDir });
      expect(report).toMatchObject({ status: "PASS", manifest_source: "acceptance", expected: 1, found: 1 });
    } finally { process.chdir(saved); }
  });

  test("a promised path that is missing fails, naming the file", () => {
    const bizDir = business({ "brief-intake": "acceptance:\n  - id: has_report\n    description: Entrega o relatório\n    path: report.md\n" });
    const { cwd, outputsRoot } = project({});
    const saved = process.cwd();
    try {
      process.chdir(cwd);
      const report = verifyDeliverableOnDisk("prj_1", "fixture", { outputsRoot, businessDir: bizDir });
      expect(report.status).toBe("FAIL");
      expect(report.missing[0]).toBe(path.join(outputsRoot, "report.md"));
    } finally { process.chdir(saved); }
  });

  // A squad run writes its manifest under `squads/<slug>/`, mirroring the
  // `businesses/<slug>/` convention. On 2026-09-04 a live run had two of those
  // on disk, every promised file present, and this check answered
  // FAIL_INDETERMINATE "no deliverables.json" — it had never looked there.
  test("a squad run's manifest under squads/<slug>/ is found and verified", () => {
    const { cwd } = project({});
    const squadOut = path.join(cwd, "outputs", "prj_1", "squads", "brandcraft", "outputs");
    fs.mkdirSync(squadOut, { recursive: true });
    const report = path.join(squadOut, "01-veredicto.md");
    fs.writeFileSync(report, "Um veredicto com corpo suficiente para não ser stub.\n", "utf8");
    fs.writeFileSync(path.join(cwd, "outputs", "prj_1", "squads", "brandcraft", "deliverables.json"), JSON.stringify({ deliverables: [report] }), "utf8");
    const saved = process.cwd();
    try {
      process.chdir(cwd);
      const r = verifyDeliverableOnDisk("prj_1", "brandcraft", { businessDir: null, minBytes: 10 });
      expect(r).toMatchObject({ status: "PASS", expected: 1, found: 1 });
      expect(r.manifest_source).toContain("squads/brandcraft/deliverables.json");
    } finally { process.chdir(saved); }
  });

  test("a business that promises nothing keeps the brief-regex behavior", () => {
    const bizDir = business({ "brief-intake": "acceptance:\n  - id: quality\n    description: Sem path\n" });
    const { cwd, outputsRoot } = project({ "report.md": "conteúdo" });
    const saved = process.cwd();
    try {
      process.chdir(cwd);
      expect(verifyDeliverableOnDisk("prj_1", "fixture", { outputsRoot, businessDir: bizDir }).manifest_source).toBe("brief-regex");
    } finally { process.chdir(saved); }
  });
});
