// rrf.test.ts — fusão Reciprocal Rank Fusion (lib/rrf.js).
// Roda com: bun test skills/harness/tests
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { fuse, DEFAULT_K } = require("../lib/rrf.js");

describe("fuse — Reciprocal Rank Fusion", () => {
  test("item bem posicionado em AMBAS as listas vence o que aparece em uma só", () => {
    const bm25 = { id: "bm25", items: [{ id: "A" }, { id: "B" }, { id: "C" }] };
    const dense = { id: "dense", items: [{ id: "A" }, { id: "D" }, { id: "B" }] };
    const out = fuse([bm25, dense]);
    expect(out[0].id).toBe("A"); // topo em ambas
    // A soma de dois aportes > qualquer aporte único
    const a = out.find((x: any) => x.id === "A");
    const d = out.find((x: any) => x.id === "D");
    expect(a.rrf).toBeGreaterThan(d.rrf);
  });

  test("preserva os ranks de origem por lista", () => {
    const out = fuse([
      { id: "bm25", items: [{ id: "X" }, { id: "Y" }] },
      { id: "dense", items: [{ id: "Y" }, { id: "X" }] },
    ]);
    const x = out.find((r: any) => r.id === "X");
    expect(x.ranks.bm25).toBe(0);
    expect(x.ranks.dense).toBe(1);
  });

  test("k maior achata a vantagem do topo", () => {
    const lists = [{ id: "l", items: [{ id: "A" }, { id: "B" }] }];
    const tight = fuse(lists, { k: 1000 });
    const loose = fuse(lists, { k: 1 });
    const gapTight = tight[0].rrf - tight[1].rrf;
    const gapLoose = loose[0].rrf - loose[1].rrf;
    expect(gapLoose).toBeGreaterThan(gapTight);
  });

  test("weight pondera a contribuição de uma lista", () => {
    const out = fuse([
      { id: "bm25", items: [{ id: "A" }], weight: 0.1 },
      { id: "dense", items: [{ id: "B" }], weight: 10 },
    ]);
    expect(out[0].id).toBe("B");
  });

  test("entradas vazias/ inválidas não quebram", () => {
    expect(fuse([]).length).toBe(0);
    expect(fuse([{ id: "x", items: [] }]).length).toBe(0);
    expect(fuse(null as any).length).toBe(0);
  });

  test("k default = 60 (constante canônica)", () => {
    expect(DEFAULT_K).toBe(60);
  });
});
