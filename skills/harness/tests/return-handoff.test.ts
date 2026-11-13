// return-handoff.test.ts — the closing handoff names every delivered file by
// its absolute path, leaves run state out, and collapses a long list.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HANDOFF_FILE_CAP, returnHandoffLines } from "../lib/return-handoff.ts";

const roots: string[] = [];
function outputsRoot(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "nrv-handoff-")));
  roots.push(root);
  return root;
}
function write(root: string, rel: string, text = "x"): string {
  const file = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("returnHandoffLines", () => {
  test("lists only the deliverables, by absolute path, then the summary and the report", () => {
    const root = outputsRoot();
    const page = write(root, "site/index.html");
    const summary = write(root, "_SUMMARY.md", "# done");
    write(root, "_work/PROGRESS.md");
    write(root, "_STATUS.json", "{}");

    const lines = returnHandoffLines(root, "delivered", "20261113-site");
    expect(lines[0]).toBe("  Delivered files (1):");
    expect(lines[1]).toBe(`    ${page}`);
    expect(path.isAbsolute(lines[1].trim())).toBe(true);
    expect(lines).toContain(`  Summary:      ${summary}`);
    expect(lines.filter((line) => line.includes("_work") || line.includes("_STATUS.json"))).toEqual([]);
    expect(lines).toContain("  Report to the user now, in their language:");
    expect(lines.some((line) => line.includes('"Going live"'))).toBe(true);
    const decisions = lines.find((line) => line.includes('"Decisions made for you"'))!;
    expect(decisions).toContain('nrv revise 20261113-site "<change>"');
    expect(decisions).toContain("same worker in the same session");
    expect(lines[lines.length - 1]).toBe("    5. what is still open");
  });

  test("a relative outputs root is still printed absolute", () => {
    const root = outputsRoot();
    const file = write(root, "report.md");
    const lines = returnHandoffLines(path.relative(process.cwd(), root) || ".", "delivered_with_reservations");
    expect(lines[1].trim()).toBe(path.resolve(file));
  });

  test(`past ${HANDOFF_FILE_CAP} files the rest is a count and the folder`, () => {
    const root = outputsRoot();
    for (let i = 0; i < HANDOFF_FILE_CAP + 3; i++) write(root, `out/f${String(i).padStart(2, "0")}.txt`);
    const lines = returnHandoffLines(root, "delivered");
    expect(lines[0]).toBe(`  Delivered files (${HANDOFF_FILE_CAP + 3}):`);
    expect(lines.filter((line) => line.endsWith(".txt")).length).toBe(HANDOFF_FILE_CAP);
    expect(lines).toContain(`    +3 more under ${root}`);
    expect(lines).toContain("  Summary:      (no _SUMMARY.md was written)");
  });

  test("a withheld run says the files are on disk and not delivered", () => {
    const root = outputsRoot();
    write(root, "report.md");
    const lines = returnHandoffLines(root, "withheld");
    expect(lines[0]).toBe("  Files on disk, NOT delivered (1):");
    expect(lines.some((line) => line.includes("withheld and why"))).toBe(true);
  });

  test("nothing is printed for a run that delivered nothing to report", () => {
    const root = outputsRoot();
    write(root, "report.md");
    for (const state of ["stopped", "quota_wait", "indeterminate", "failed"]) expect(returnHandoffLines(root, state)).toEqual([]);
  });
});
