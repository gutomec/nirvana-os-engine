/**
 * enrich-business-admission.test.ts — the buyer-facing surface is repaired
 * only in the shape the gate admits, and never at the cost of anything else.
 *
 * Measured on the pack sources 2026-09-02, after the mechanical fixers had
 * done everything they own: 27 businesses, 0 errors, 407 warnings — and 391 of
 * those were three findings the fixers refuse to invent: 341 v1 ticket-dialect
 * routes (`type:strategy|approval-gate|…`) firing on no brief, 27 businesses
 * without not_for, 23 README stubs. These cases pin the script that writes
 * that meaning: every deterministic rule it applies BEFORE writing is the
 * gate's own, the writes are surgical, and a candidate the gate still rejects
 * is reverted whole.
 *
 * Synthetic fixtures throughout — no LLM (the generator is injected), no live
 * library. The round-trip case runs the real `checkSync`, which is the point.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  compileRoute, enrichBusinessDir, listIndentOf, needsOf, setAutoRoutes, setTopLevelList, validateGenerated,
  type GenResult, type Needs, type RunCtx,
} from "../scripts/enrich-business-admission.ts";
import { checkSync } from "../lib/verify/kinds/business.ts";
import { surfaceRegenFixer } from "../lib/verify/common.ts";

const YAML = require("yaml");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nrv-enrich-biz-"));

const SEATS = ["ee-ceo", "ee-k12-head", "ee-qa"];
const EXISTING_BRIEFS = [
  "Preciso de um currículo alinhado à BNCC para o ensino fundamental da minha escola",
  "quero montar a trilha de formação de professores da rede para o próximo semestre",
  "Revisão pedagógica das aulas antes de publicar no portal dos alunos",
];
const ALL: Needs = { notFor: true, briefLangs: true, routes: true, readme: true };

const GOOD = {
  not_for: ["aula particular", "private tutoring", "reforço escolar", "diploma reconhecimento", "degree accreditation"],
  example_briefs_add: [
    "Design a BNCC-aligned curriculum map for grades 6 to 9 at our private school",
    "Audit the lesson plans for factual errors and fixed-mindset feedback before they go live",
  ],
  routes: [
    { pattern: "(?i)(revis[aã]o\\s+pedag[oó]gica|audit\\w*\\s+the\\s+lesson|factual\\s+errors?|fixed[- ]mindset)", route_to: "ee-qa", why: "QA first: a review brief also names the lesson it reviews" },
    { pattern: "(?i)(bncc|curr[ií]culo|curriculum|ensino\\s+fundamental|grades?\\s+\\d)", route_to: "ee-k12-head", why: null },
    { pattern: "(?i)(forma[çc][aã]o\\s+de\\s+professores|teacher\\s+training|trilha\\s+de\\s+forma)", route_to: "ee-ceo", why: null },
  ],
  readme: [
    "# edu-fixture", "",
    "An education department in a box. It takes a school's brief and returns curriculum",
    "maps, lesson plans and the review that clears them for publication.", "",
    "## Domains", "", "- k12", "- teacher training", "",
    "## What it produces", "", "- curriculum-map", "- lesson-plan", "- pedagogical-review", "",
    "## The org chart", "", "- `ee-ceo` — intake, owns the plan", "- `ee-k12-head` — K-12 curriculum", "- `ee-qa` — pedagogical review with veto", "",
    "## The ship gate", "", "Nothing publishes before `ee-qa` clears it for factual errors and feedback language.", "",
    "## Usage", "", "```bash", 'nrv run edu-fixture "<brief>"', "```", "", "The intake seat is `ee-ceo`; the description in business.yaml is what the router reads.", "",
    "## Layout", "", "- business.yaml", "- routing.yaml", "- employees/", "- org-chart.yaml", "",
    "## Method", "", "Mastery learning, deliberate practice and growth-mindset feedback framing.", "",
    "## Limits", "", "No private tutoring, no degree accreditation, no individual grading of real students.", "", "",
  ].join("\n"),
};

const ctxAll = { needs: ALL, slug: "edu-fixture", seats: SEATS, existingBriefs: EXISTING_BRIEFS, existingNotFor: [] as string[] };

describe("compileRoute is the gate's compile", () => {
  test("(?i) becomes the i flag; without it the regex is case-sensitive; garbage is null", () => {
    expect(compileRoute("(?i)bncc")!.test("Curriculo BNCC")).toBe(true);
    expect(compileRoute("bncc")!.test("Curriculo BNCC")).toBe(false);
    expect(compileRoute("(?i)(unclosed")).toBeNull();
  });
});

describe("needsOf reads the gate's findings", () => {
  test("not_for and the language split come from the evidence string; routes and readme from ids", () => {
    const n = needsOf([
      { id: "routing_metadata_incomplete", evidence: "example_briefs in both EN and PT (found pt) · not_for" },
      { id: "auto_route_never_fires" }, { id: "readme_thin" },
    ]);
    expect(n).toEqual({ notFor: true, briefLangs: true, routes: true, readme: true });
    expect(needsOf([{ id: "routing_metadata_incomplete", evidence: "produces · keywords" }])).toEqual({ notFor: false, briefLangs: false, routes: false, readme: false });
  });
});

describe("validateGenerated — the gate's rules, asked before any write", () => {
  test("a good answer passes whole, and the merged briefs carry both languages", () => {
    const v = validateGenerated(GOOD, ctxAll);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.cleaned!.example_briefs.length).toBe(5);
    expect(v.cleaned!.routes.length).toBe(3);
    expect(v.cleaned!.routes[0].why).toContain("QA first");
  });

  test("a not_for past 25 chars, or with a (use X) suffix, is rejected — the fence would never fire", () => {
    const v = validateGenerated({ ...GOOD, not_for: ["aula particular", "tarefa pontual de copy isolada (use copy.sales)", "x", "reforço escolar"] }, ctxAll);
    const e = v.errors.join("\n");
    expect(e).toContain("chars");
    expect(e).toContain("(use X)");
  });

  test("a pattern without (?i) is rejected: the gate would test it case-sensitive", () => {
    const routes = GOOD.routes.map((r, i) => (i === 1 ? { ...r, pattern: r.pattern.slice(4) } : r));
    const v = validateGenerated({ ...GOOD, routes }, ctxAll);
    expect(v.errors.join("\n")).toContain("starts with (?i)");
  });

  test("a route that fires on no brief, and a brief that fires no route, both fail", () => {
    const routes = [...GOOD.routes, { pattern: "(?i)(orçamento\\s+anual)", route_to: "ee-ceo", why: null }];
    let v = validateGenerated({ ...GOOD, routes }, ctxAll);
    expect(v.errors.join("\n")).toContain("fires against none");
    v = validateGenerated({ ...GOOD, routes: GOOD.routes.slice(0, 2) }, ctxAll);
    expect(v.errors.join("\n")).toContain("no route fires on the brief");
  });

  test("route_to must name a seat; a catch-all is refused", () => {
    let v = validateGenerated({ ...GOOD, routes: [{ ...GOOD.routes[0], route_to: "ghost" }, ...GOOD.routes.slice(1)] }, ctxAll);
    expect(v.errors.join("\n")).toContain("not a seat");
    v = validateGenerated({ ...GOOD, routes: [{ pattern: "(?i).*", route_to: "ee-ceo", why: null }, ...GOOD.routes] }, ctxAll);
    expect(v.errors.join("\n")).toContain("catch-all");
  });

  test("a new brief carrying the slug is rejected — self-retrieval would pass for the wrong reason", () => {
    const v = validateGenerated({ ...GOOD, example_briefs_add: [...GOOD.example_briefs_add, "Please have edu-fixture design our reading program"] }, ctxAll);
    expect(v.errors.join("\n")).toContain("own slug");
  });

  test("a README under 40 lines, or pointing into a home directory, is not the buyer's document", () => {
    let v = validateGenerated({ ...GOOD, readme: "# x\n\n## Usage\n\nrun it\n" }, ctxAll);
    expect(v.errors.join("\n")).toContain("lines");
    v = validateGenerated({ ...GOOD, readme: GOOD.readme + "\nSee /Users/someone/businesses/edu-fixture\n" }, ctxAll);
    expect(v.errors.join("\n")).toContain("home directory");
  });

  test("only what the gate asked for is required: routes alone needs no README and keeps not_for as is", () => {
    const v = validateGenerated({ routes: GOOD.routes, example_briefs_add: GOOD.example_briefs_add }, { ...ctxAll, needs: { notFor: false, briefLangs: false, routes: true, readme: false }, existingNotFor: ["kept"] });
    expect(v.ok).toBe(true);
    expect(v.cleaned!.not_for).toEqual(["kept"]);
    expect(v.cleaned!.readme).toBeNull();
  });
});

describe("surgical writers", () => {
  test("setTopLevelList matches the file's own indent and replaces in place", () => {
    const indented = "name: x\ndomains:\n  - a\n  - b\nnot_for:\n  - old\ndescription: y\n";
    const out = setTopLevelList(indented, "not_for", ["new one", "another"]);
    expect(listIndentOf(indented)).toBe("  ");
    expect(out).toBe("name: x\ndomains:\n  - a\n  - b\nnot_for:\n  - new one\n  - another\ndescription: y\n");
    const flush = "name: x\ndomains:\n- a\n";
    expect(setTopLevelList(flush, "not_for", ["z"])).toBe("name: x\ndomains:\n- a\nnot_for:\n- z\n");
  });

  test("setAutoRoutes replaces the block and its comment run; brief_intake survives verbatim", () => {
    const old = "brief_intake:\n  default_employee: ee-ceo\n  alternates: []\n# old comment\nauto_routes:\n  - pattern: type:strategy|approval-gate\n    route_to: ee-ceo\n";
    const out = setAutoRoutes(old, GOOD.routes.slice(0, 2), "ee-ceo");
    const doc = YAML.parse(out);
    expect(doc.brief_intake).toEqual({ default_employee: "ee-ceo", alternates: [] });
    expect(doc.auto_routes).toEqual(GOOD.routes.slice(0, 2).map((r) => ({ pattern: r.pattern, route_to: r.route_to })));
    expect(out).not.toContain("old comment");
    expect(out).not.toContain("type:strategy");
    expect(out).toContain("# QA first");
  });

  test("setAutoRoutes from nothing writes brief_intake with the intake seat", () => {
    const doc = YAML.parse(setAutoRoutes(null, GOOD.routes.slice(0, 1), "ee-ceo"));
    expect(doc.brief_intake.default_employee).toBe("ee-ceo");
    expect(doc.auto_routes.length).toBe(1);
  });
});

// ── a synthetic business that passes the gate with exactly the three agentic findings ──

function fixtureBusiness(root: string): string {
  const dir = path.join(root, "edu-fixture");
  fs.mkdirSync(path.join(dir, "employees"), { recursive: true });
  fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
  fs.writeFileSync(path.join(dir, "business.yaml"), [
    "name: edu-fixture", 'protocol: "2.0"', "version: 1.0.0",
    "description: Designs BNCC-aligned curricula, lesson plans and the pedagogical review that clears them for a private school network.",
    "domains:", "  - education",
    "produces:", "  - curriculum-map", "  - lesson-plan",
    "keywords:", "  - bncc", "  - curriculo", "  - currículo", "  - curriculum", "  - lesson plan", "  - plano de aula",
    "example_briefs:", ...EXISTING_BRIEFS.map((b) => `  - "${b}"`),
    "runtime_requirements:", "  policy: declared", "  minimum:", "    - runtime: claude-code", "",
  ].join("\n"));
  const seat = (name: string, role: string, extra: string[]) => fs.writeFileSync(path.join(dir, "employees", `${name}.md`), [
    "---", `name: ${name}`, `role: ${role}`, `description: "${role} of the fixture business, grounded in the school brief."`, ...extra, "---", "",
    `# ${role}`, "", "## Regras", "", "- Nunca aprovo material sem a fonte da competência BNCC citada.", "- Sempre entrego o plano com objetivos mensuráveis por aula.",
    "- Reprovado qualquer feedback que envergonhe o aluno; a linguagem segue growth mindset.", "- Cobertura mínima de 90% das habilidades do ano antes de fechar o mapa.",
    "- Prazo de revisão: 2 dias úteis por unidade.", "",
  ].join("\n"));
  seat("ee-ceo", "Diretor", ["is_brief_intake: true", "manages: [ee-k12-head, ee-qa]", "acceptance:", "  - id: plan_measurable", '    description: "Todo plano traz objetivos mensuráveis por aula"', "    blocking: true", "    minimum_score: 0.9"]);
  seat("ee-k12-head", "Head K-12", ["reports_to: ee-ceo"]);
  seat("ee-qa", "Revisão pedagógica", ["reports_to: ee-ceo", "is_antagonist: true"]);
  fs.writeFileSync(path.join(dir, "org-chart.yaml"), "chart:\n  - employee: ee-ceo\n    reports: []\n    direct_reports: [ee-k12-head, ee-qa]\n  - employee: ee-k12-head\n    reports: [ee-ceo]\n    direct_reports: []\n  - employee: ee-qa\n    reports: [ee-ceo]\n    direct_reports: []\n    is_antagonist: true\n");
  fs.writeFileSync(path.join(dir, "routing.yaml"), "brief_intake:\n  default_employee: ee-ceo\n  alternates: []\nauto_routes:\n  - pattern: type:strategy|approval-gate|budget\n    route_to: ee-ceo\n  - pattern: type:k12-curriculum|bncc-alignment\n    route_to: ee-k12-head\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# edu-fixture\n\nScaffolded.\n");
  fs.writeFileSync(path.join(dir, "memory", "permanent.md"), "# Memory\n");
  surfaceRegenFixer("business")({ dir, finding: { id: "surface_missing" } } as never);
  return dir;
}

function ctxWith(root: string, answers: GenResult[]): { ctx: RunCtx; calls: string[] } {
  const calls: string[] = []; let i = 0;
  return { calls, ctx: { attempts: 3, backupRoot: path.join(root, "backups"), generate: (p) => { calls.push(p); return answers[Math.min(i++, answers.length - 1)]; } } };
}
const ok = (json: unknown): GenResult => ({ ok: true, json, costUsd: 0.5 });

describe("enrichBusinessDir — the loop, proven by the real gate", () => {
  test("the fixture starts with exactly the three agentic findings and no error", () => {
    const root = tmp(); const dir = fixtureBusiness(root);
    const f = checkSync(dir);
    const ids = new Set(f.map((x) => x.id));
    expect(f.filter((x) => x.severity === "error").map((x) => x.id)).toEqual([]);
    expect(ids.has("routing_metadata_incomplete")).toBe(true);
    expect(ids.has("auto_route_never_fires")).toBe(true);
    expect(ids.has("readme_thin")).toBe(true);
    expect(needsOf(f as never)).toEqual(ALL);
  });

  test("a good answer enriches: all three findings gone, brief_intake intact, surface fresh, cost recorded", async () => {
    const root = tmp(); const dir = fixtureBusiness(root);
    const errorsBefore = checkSync(dir).filter((x) => x.severity === "error").length;
    const { ctx } = ctxWith(root, [ok(GOOD)]);
    const r = await enrichBusinessDir(dir, ctx);
    expect(r.errors).toEqual([]);
    expect(r.status).toBe("enriched");
    expect(r.attempts).toBe(1);
    expect(r.cost_usd).toBeCloseTo(0.5);
    expect(r.files_written.join(" ")).toContain("routing.yaml");
    expect(r.files_written.join(" ")).toContain("README.md");
    const after = checkSync(dir);
    const ids = new Set(after.map((x) => x.id));
    expect(ids.has("routing_metadata_incomplete")).toBe(false);
    expect(ids.has("auto_route_never_fires")).toBe(false);
    expect(ids.has("readme_thin")).toBe(false);
    expect(ids.has("surface_stale")).toBe(false);
    expect(after.filter((x) => x.severity === "error").length).toBe(errorsBefore);
    const routing = YAML.parse(fs.readFileSync(path.join(dir, "routing.yaml"), "utf8"));
    expect(routing.brief_intake).toEqual({ default_employee: "ee-ceo", alternates: [] });
    expect(routing.auto_routes.length).toBe(3);
    const biz = YAML.parse(fs.readFileSync(path.join(dir, "business.yaml"), "utf8"));
    expect(biz.not_for.length).toBe(5);
    expect(biz.example_briefs.length).toBe(5);
    expect(biz.description).toContain("BNCC-aligned"); // untouched keys survive
  });

  test("a rejected answer carries the gate's own words back, and the retry succeeds", async () => {
    const root = tmp(); const dir = fixtureBusiness(root);
    const bad = ok({ ...GOOD, routes: GOOD.routes.slice(0, 2) }); // one brief left without a route
    const { ctx, calls } = ctxWith(root, [bad, bad, ok(GOOD)]);
    const r = await enrichBusinessDir(dir, ctx);
    expect(r.status).toBe("enriched");
    expect(r.attempts).toBe(2);
    expect(calls.slice(1).some((p) => p.includes("no route fires on the brief"))).toBe(true);
  });

  test("when every attempt fails, every file is byte-identical to the original", async () => {
    const root = tmp(); const dir = fixtureBusiness(root);
    const snapshot = Object.fromEntries(["business.yaml", "routing.yaml", "README.md"].map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
    const { ctx } = ctxWith(root, [ok({ not_for: ["x"] })]);
    const r = await enrichBusinessDir(dir, ctx);
    expect(r.status).toBe("gate_failed");
    for (const [f, text] of Object.entries(snapshot)) expect(fs.readFileSync(path.join(dir, f), "utf8")).toBe(text);
  });

  test("a business with nothing agentic to repair is skipped without a call", async () => {
    const root = tmp(); const dir = fixtureBusiness(root);
    const { ctx: first } = ctxWith(root, [ok(GOOD)]);
    await enrichBusinessDir(dir, first);
    const { ctx, calls } = ctxWith(root, [ok(GOOD)]);
    const r = await enrichBusinessDir(dir, ctx);
    expect(r.status).toBe("skipped");
    expect(calls.length).toBe(0);
  });
});
