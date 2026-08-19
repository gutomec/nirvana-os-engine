/**
 * The seat ratchet: a seat enters sufficient, or not at all.
 *
 * Debt pattern shared with the fence ceiling and the admission gate — and the
 * same test discipline: every case plants the defect and demands exit 1,
 * against fixture roots and a fixture baseline so the machine's library and
 * state are never read or written.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATE = join(import.meta.dir, "..", "scripts", "check-seat-sufficiency.ts");
const ROOTS: string[] = [];
afterAll(() => { for (const r of ROOTS) try { rmSync(r, { recursive: true, force: true }); } catch {} });

const SUFFICIENT_BODY = [
  "## Identidade", "Faço o corte final de qualidade.",
  "## Regras",
  "1. Nunca aprovo sem ver a fonte primária do dado citado no texto.",
  "2. Sempre confiro o denominador antes de aceitar o percentual.",
  "3. Rejeito média sem desvio quando a distribuição é assimétrica.",
  "4. Exijo critério de pronto por escrito antes de começar o turno.",
  "5. Recuso escopo que muda depois do preço fechado com o cliente.",
].join("\n");
const THIN_BODY = "# Specialist\nFaça o trabalho da área.";

function library(seats: Array<[string, string, string]>): string {
  const root = mkdtempSync(join(tmpdir(), "seats-"));
  ROOTS.push(root);
  for (const [biz, emp, body] of seats) {
    const dir = join(root, biz, "employees");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, biz, "business.yaml"), `name: ${biz}\ndescription: a business for the fixture\n`, "utf8");
    writeFileSync(join(dir, emp), `---\nname: ${emp.replace(/\.md$/, "")}\n---\n${body}\n`, "utf8");
  }
  return root;
}

function run(root: string, opts: { baseline?: string[]; args?: string[] } = {}) {
  const bl = join(root, "baseline.json");
  if (opts.baseline) writeFileSync(bl, JSON.stringify({ recorded_at: "test", thin_seats: opts.baseline }), "utf8");
  const r = spawnSync(process.execPath, [GATE, "--businesses", root, "--baseline", bl, ...(opts.args ?? [])], { encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("the ratchet refuses new thinness and tolerates recorded debt", () => {
  test("a thin seat the baseline never saw fails --strict", () => {
    const root = library([["alpha-co", "good.md", SUFFICIENT_BODY], ["alpha-co", "weak.md", THIN_BODY]]);
    const r = run(root, { baseline: [], args: ["--strict"] });
    expect(r.code).toBe(1);
    expect(r.out).toContain("NEW thinness");
    expect(r.out).toContain("alpha-co/weak.md");
  });

  test("the same thin seat, baselined, passes — recorded debt", () => {
    const root = library([["alpha-co", "weak.md", THIN_BODY]]);
    const r = run(root, { baseline: ["alpha-co/weak.md"], args: ["--strict"] });
    expect(r.code).toBe(0);
    expect(r.out).toContain("No seat is new thinness");
  });

  test("an enriched seat shows the debt shrinking", () => {
    const root = library([["alpha-co", "fixed.md", SUFFICIENT_BODY]]);
    const r = run(root, { baseline: ["alpha-co/fixed.md"], args: ["--strict"] });
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 enriched");
  });

  test("--record refuses to add debt without --allow-regression", () => {
    const root = library([["alpha-co", "weak.md", THIN_BODY]]);
    const r = run(root, { baseline: [], args: ["--record"] });
    expect(r.code).toBe(1);
    expect(r.out).toContain("NEW debt");
  });

  test("no baseline at all refuses under --strict rather than approving", () => {
    const root = library([["alpha-co", "good.md", SUFFICIENT_BODY]]);
    const r = run(root, { args: ["--strict"] });
    expect(r.code).toBe(1);
    expect(r.out).toContain("No debt baseline recorded");
  });

  test("a fully sufficient library with a baseline passes clean", () => {
    const root = library([["alpha-co", "good.md", SUFFICIENT_BODY]]);
    const r = run(root, { baseline: [], args: ["--strict"] });
    expect(r.code).toBe(0);
  });
});
