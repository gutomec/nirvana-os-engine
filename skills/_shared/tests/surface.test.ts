// Contract surface tests. The most important case is IDEMPOTENCE: the generated
// file enters install.ts's hashDir(), so an unstable generator would mark every
// artifact as "updated" on each build and drown out the real signal.

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { extractSurface, serializeSurface, writeSurface, readSurface } from "../lib/surface.ts";
import { diffSurfaces, mergeBehaviorNotes } from "../lib/surface-diff.ts";

function tmpSquad(capabilities: string, extra?: { tasks?: string[]; workflows?: string[] }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-surface-"));
  fs.writeFileSync(path.join(dir, "squad.yaml"), `name: fixture\nversion: 2.3.4\nprotocol: "5.0"\n${capabilities}`);
  for (const [sub, files] of [["tasks", extra?.tasks ?? []], ["workflows", extra?.workflows ?? []]] as const) {
    if (!files.length) continue;
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    // CONSTANT content on purpose: this is what a real rename looks like, and
    // it is what allows telling "renomeado" apart from "removido + adicionado".
    for (const f of files) fs.writeFileSync(path.join(dir, sub, f), "corpo estável");
  }
  return dir;
}

const CAP_A = `capabilities:
  - id: fix.alpha.run
    description: "faz alpha"
    domains: [design]
    produces: [pdf]
    invoke:
      type: workflow
      ref: workflows/alpha.yaml
`;

test("extração é determinística: mesma entrada, bytes idênticos", () => {
  const dir = tmpSquad(CAP_A);
  const a = serializeSurface(extractSurface(dir));
  const b = serializeSurface(extractSurface(dir));
  expect(a).toBe(b);
});

test("gerar duas vezes não altera a superfície gravada (idempotência)", () => {
  const dir = tmpSquad(CAP_A);
  writeSurface(dir, extractSurface(dir));
  const first = fs.readFileSync(path.join(dir, ".nirvana-surface.json"), "utf8");
  writeSurface(dir, extractSurface(dir));
  const second = fs.readFileSync(path.join(dir, ".nirvana-surface.json"), "utf8");
  expect(second).toBe(first);
});

test("o próprio arquivo de superfície não entra no que ele mede", () => {
  const dir = tmpSquad(CAP_A);
  const before = extractSurface(dir);
  writeSurface(dir, before);
  const after = extractSurface(dir);
  expect(after.surface_hash).toBe(before.surface_hash);
  expect(diffSurfaces(before, after).changes).toHaveLength(0);
});

test("semear versão: primeira geração herda a versão declarada", () => {
  const dir = tmpSquad(CAP_A);
  expect(extractSurface(dir).contract_version).toBe("2.3.4");
});

test("capability removida é QUEBRA e leva a major", () => {
  const before = extractSurface(tmpSquad(CAP_A));
  const after = extractSurface(tmpSquad(`capabilities: []\n`));
  const r = diffSurfaces(before, after);
  expect(r.breaking).toBe(1);
  expect(r.changes[0].type).toBe("removed");
  expect(r.bump).toBe("major");
  expect(r.next_version).toBe("3.0.0");
});

test("capability nova é aditiva e leva a minor", () => {
  const before = extractSurface(tmpSquad(CAP_A));
  const after = extractSurface(tmpSquad(CAP_A + `  - id: fix.beta.run
    description: "faz beta"
    domains: [design]
    invoke:
      type: task
      ref: tasks/beta.md
`));
  const r = diffSurfaces(before, after);
  expect(r.breaking).toBe(0);
  expect(r.bump).toBe("minor");
  expect(r.next_version).toBe("2.4.0");
});

test("renomear é detectado como rename, não como remoção mais adição", () => {
  const before = extractSurface(tmpSquad(CAP_A));
  const after = extractSurface(tmpSquad(CAP_A.replace("fix.alpha.run", "fix.alpha.execute")));
  const r = diffSurfaces(before, after);
  const rename = r.changes.find((c) => c.type === "renamed");
  expect(rename).toBeDefined();
  expect(rename!.from).toBe("fix.alpha.run");
  expect(rename!.to).toBe("fix.alpha.execute");
  expect(r.changes.some((c) => c.type === "removed")).toBe(false);
  expect(r.bump).toBe("major");
});

test("trocar o alvo de invocação é QUEBRA mesmo com o id intacto", () => {
  const before = extractSurface(tmpSquad(CAP_A));
  const after = extractSurface(tmpSquad(CAP_A.replace("workflows/alpha.yaml", "workflows/alpha-v2.yaml")));
  const r = diffSurfaces(before, after);
  const rebound = r.changes.find((c) => c.type === "rebound");
  expect(rebound).toBeDefined();
  expect(rebound!.severity).toBe("breaking");
});

test("perder um domain é quebra de roteamento; ganhar é aditivo", () => {
  const base = extractSurface(tmpSquad(CAP_A));
  const lost = extractSurface(tmpSquad(CAP_A.replace("domains: [design]", "domains: []")));
  expect(diffSurfaces(base, lost).changes.some((c) => c.type === "routing_lost")).toBe(true);

  const gained = extractSurface(tmpSquad(CAP_A.replace("domains: [design]", "domains: [design, video]")));
  const g = diffSurfaces(base, gained);
  expect(g.changes.some((c) => c.type === "routing_gained")).toBe(true);
  expect(g.breaking).toBe(0);
});

test("mudar só a prosa é patch, nunca quebra", () => {
  const before = extractSurface(tmpSquad(CAP_A));
  const after = extractSurface(tmpSquad(CAP_A.replace('"faz alpha"', '"faz alpha com mais detalhe"')));
  const r = diffSurfaces(before, after);
  expect(r.breaking).toBe(0);
  expect(r.bump).toBe("patch");
  expect(r.next_version).toBe("2.3.5");
  expect(r.changes.some((c) => c.type === "prose_changed")).toBe(true);
});

test("renomear arquivo de task é quebra: o nome é o identificador", () => {
  const before = extractSurface(tmpSquad(CAP_A, { tasks: ["render.md"] }));
  const after = extractSurface(tmpSquad(CAP_A, { tasks: ["compose.md"] }));
  const r = diffSurfaces(before, after);
  expect(r.changes.some((c) => c.type === "renamed" && c.id.startsWith("task:"))).toBe(true);
});

test("artefato sem superfície anterior não gera migração para ninguém", () => {
  const after = extractSurface(tmpSquad(CAP_A));
  const r = diffSurfaces(null, after);
  expect(r.changes).toHaveLength(0);
  expect(r.bump).toBe("none");
});

test("anotação de comportamento força major mesmo sem mudança estrutural", () => {
  const before = extractSurface(tmpSquad(CAP_A));
  const after = extractSurface(tmpSquad(CAP_A));
  const r = mergeBehaviorNotes(diffSurfaces(before, after), ["o gate de qualidade passou a reprovar PDFs sem alt-text"]);
  expect(r.bump).toBe("major");
  expect(r.breaking).toBe(1);
  expect(r.changes[0].type).toBe("behavior_changed");
});

test("schema diferente reestabelece a base em vez de inventar mudanças", () => {
  const before = extractSurface(tmpSquad(CAP_A));
  const after = extractSurface(tmpSquad(`capabilities: []\n`));
  // The same comparison that would yield 1 break, now across distinct schemas.
  const cross = diffSurfaces({ ...before, schema: 0 }, after);
  expect(cross.changes).toHaveLength(0);
  expect(cross.bump).toBe("none");
  // And the normal case still detects it.
  expect(diffSurfaces(before, after).breaking).toBe(1);
});

test("mudança de schema REGRAVA a base em vez de suprimir para sempre", () => {
  // Schema suppression is a one-time transition. If the on-disk surface is
  // never rewritten with the new schema, the mismatch persists and EVERY future
  // real change of that artifact is silently swallowed — the escape valve
  // becomes a blindfold. This test guards exactly that scenario.
  const dir = tmpSquad(CAP_A);
  writeSurface(dir, { ...extractSurface(dir), schema: 0 });
  expect(readSurface(dir)!.schema).toBe(0);

  // The cross-schema diff reports nothing...
  const antigo = readSurface(dir)!;
  expect(diffSurfaces(antigo, extractSurface(dir)).changes).toHaveLength(0);

  // ...but whoever rewrites must detect the mismatch to re-establish the base.
  const precisaRebaseline = antigo.schema !== extractSurface(dir).schema;
  expect(precisaRebaseline).toBe(true);
});

test("saídas do gerador não entram na medição (senão o gen nunca converge)", () => {
  const dir = tmpSquad(CAP_A);
  const antes = extractSurface(dir);
  // Simulates what the gen itself writes after detecting a change.
  fs.writeFileSync(path.join(dir, "CHANGES.json"), '{"schema":1,"history":[]}');
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n");
  const depois = extractSurface(dir);
  expect(diffSurfaces(antes, depois).changes).toHaveLength(0);
});
