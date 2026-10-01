// run-id.test.ts — a run's folder is named date first, so outputs/ sorts by when it ran.
import { describe, expect, test } from "bun:test";
import { isSafeId, runFolderId } from "../lib/run-id.ts";

describe("run folder ids", () => {
  test("date and time first, in local time, then the target", () => {
    expect(runFolderId("copywriting-infoprodutos", new Date(2026, 9, 1, 13, 7))).toBe("20261001-1307-copywriting-infoprodutos");
    expect(runFolderId("agent-x", new Date(2026, 0, 2, 3, 4))).toBe("20260102-0304-agent-x");
  });

  test("ids sort in the order the runs happened", () => {
    const ids = [new Date(2026, 9, 1, 13, 7), new Date(2026, 8, 30, 23, 59), new Date(2026, 9, 1, 9, 0)].map((d) => runFolderId("x", d));
    expect([...ids].sort()).toEqual(["20260930-2359-x", "20261001-0900-x", "20261001-1307-x"]);
  });

  test("a generated id and an orchestrator's name are both safe folder names", () => {
    expect(isSafeId(runFolderId("launch-lab-br"))).toBe(true);
    expect(isSafeId("20261001-motion-design-genius-copy")).toBe(true);
    for (const bad of ["../x", "a\\b", "C:x", "con", "x.", ""]) expect(isSafeId(bad)).toBe(false);
  });
});
