// registry-concurrent-write.test.ts — two indexers at once must both survive.
//
// The registry write staged through a temp file named `<target>.tmp` — one
// path, shared by every process. `nrv index` on a cold start is exactly the
// case that breaks it: sibling children each reindex, the first rename moves
// the temp away, and every later rename finds nothing to move:
//
//   ENOENT: no such file or directory, rename '<target>.tmp' -> '<target>'
//
// Measured before the fix at 9 of 10 concurrent writers dying. rename(2) is
// atomic within a filesystem, so a READER was never at risk and no registry was
// ever corrupted — the damage was that every writer but one crashed, and the
// caller saw an indexer that simply failed.
//
// The businesses twin had the same job done worse: a direct writeFileSync with
// no temp at all, which does expose a half-written file to a reader.
import { afterEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const SQUADS_REGISTRY = path.join(import.meta.dir, "..", "lib", "registry.js");
const BUSINESSES_REGISTRY = path.join(import.meta.dir, "..", "..", "businesses", "lib", "registry.ts");
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nrv-reg-race-")); dirs.push(d); return d; };

/** Big enough that the write is not one instantaneous syscall. */
function payload(tag: string) {
  const squads: Record<string, unknown> = {};
  for (let i = 0; i < 6000; i++) squads[`s-${tag}-${i}`] = { name: `squad ${i}`, tag, blurb: "x".repeat(80) };
  return { schema_version: "1.0", tag, squads };
}

describe("concurrent indexers do not kill each other", () => {
  test("ten writers, ten rounds each, all survive", async () => {
    const dir = tmpDir();
    const target = path.join(dir, "reg.json");
    const child = path.join(dir, "writer.ts");
    fs.writeFileSync(child, `
      const reg = require(${JSON.stringify(SQUADS_REGISTRY)});
      const tag = process.argv[2], target = process.argv[3];
      const squads = {};
      for (let i = 0; i < 6000; i++) squads["s-" + tag + "-" + i] = { name: "squad " + i, tag, blurb: "x".repeat(80) };
      for (let r = 0; r < 10; r++) reg.write({ schema_version: "1.0", tag, squads }, target);
    `);

    const procs = Array.from({ length: 10 }, (_, w) =>
      Bun.spawn([process.execPath, child, `w${w}`, target], { stdout: "ignore", stderr: "pipe" }));

    // Read while they write: rename is atomic, so this must never see a
    // half-written file either.
    let corrupted = 0;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && procs.some((p) => p.exitCode === null)) {
      try { JSON.parse(fs.readFileSync(target, "utf8")); }
      catch (e: any) { if (e?.code !== "ENOENT") corrupted++; }
    }

    const codes = await Promise.all(procs.map((p) => p.exited));
    const died = codes.filter((c) => c !== 0);
    let firstError = "";
    if (died.length) firstError = (await new Response(procs[codes.indexOf(died[0])].stderr).text()).slice(-400);

    expect(died.length, `writers that died: ${died.length}/10\n${firstError}`).toBe(0);
    expect(corrupted).toBe(0);
    // A crashed writer must not leave its staging file behind either.
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  }, 60_000);

  test("a write leaves nothing staged behind", () => {
    const dir = tmpDir();
    const target = path.join(dir, "reg.json");
    require(SQUADS_REGISTRY).write(payload("a"), target);
    expect(JSON.parse(fs.readFileSync(target, "utf8")).tag).toBe("a");
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  test("the staging name carries the process, so two of them cannot collide", () => {
    // Asserted on the source: after a SUCCESSFUL write the temp is gone either
    // way, so no filesystem check can tell a shared name from a private one.
    // The shared name is the whole defect, so it is the thing to pin.
    const src = fs.readFileSync(SQUADS_REGISTRY, "utf8");
    expect(src).not.toMatch(/const tmp = target \+ '\.tmp';/);
    expect(src).toMatch(/const tmp = `\$\{target\}\.\$\{process\.pid\}\./);
  });

  test("the businesses twin stages through a temp file at all", () => {
    // It wrote straight onto the target, so a reader could parse a partial
    // registry. Asserted on the source because the writer is not exported.
    const src = fs.readFileSync(BUSINESSES_REGISTRY, "utf8");
    expect(src).toContain("fs.renameSync(tmp, out)");
    expect(src).not.toMatch(/fs\.writeFileSync\(out,/);
  });
});
