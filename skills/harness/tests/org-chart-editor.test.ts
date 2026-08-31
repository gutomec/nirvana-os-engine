// org-chart-editor.test.ts — regression coverage for the line-surgical
// chart:[] editor Glance's org-chart card editor uses to reparent/add
// employees without reflowing the rest of org-chart.yaml.
//
// Fixtures below mirror the two real indentation conventions found across
// the 59 chart[]-shaped businesses in ~/businesses (verified 2026-08-31):
// flush (entries at column 0, list items at the same indent as their key)
// and indented (entries at column 2, items 2 deeper than their key) — plus
// a comment sitting inside an entry, since real files have those too.

import { describe, expect, test } from "bun:test";
import {
  addDirectReport,
  removeDirectReport,
  setReportsTo,
  appendChartEntry,
  reparentEmployee,
  wouldCreateCycle,
  OrgChartEditError,
} from "../lib/glance/org-chart-editor.ts";
import yaml from "yaml";

const FLUSH = `chart:
- employee: ceo
  reports: []
  direct_reports:
  - director-a
  - director-b
- employee: director-a
  reports:
  - ceo
  # comment inside an entry — must survive every edit below
  direct_reports:
  - worker-a1
- employee: director-b
  reports:
  - ceo
  direct_reports: []
- employee: worker-a1
  reports:
  - director-a
  direct_reports: []
routing_rules:
- id: unrelated
  rationale: a long prose field that must never be touched or re-wrapped by
    any of these edits, no matter what else in the file changes.
`;

const INDENTED = `chart:
  - employee: ceo
    reports: []
    direct_reports:
      - director-a
  - employee: director-a
    reports:
      - ceo
    direct_reports: []
`;

const UNSUPPORTED = `org:
  ceo:
    role: ceo
`;

describe("addDirectReport / removeDirectReport", () => {
  test("adds to a non-empty flush list", () => {
    const out = addDirectReport(FLUSH, "ceo", "director-c");
    expect(yaml.parse(out).chart.find((e: any) => e.employee === "ceo").direct_reports).toEqual(["director-a", "director-b", "director-c"]);
  });

  test("converts an inline [] flush leaf into a block list", () => {
    const out = addDirectReport(FLUSH, "director-b", "worker-b1");
    expect(out).toContain("- employee: director-b");
    expect(yaml.parse(out).chart.find((e: any) => e.employee === "director-b").direct_reports).toEqual(["worker-b1"]);
  });

  test("add then remove round-trips to byte-identical original (flush style)", () => {
    const added = addDirectReport(FLUSH, "ceo", "zz-temp");
    const removed = removeDirectReport(added, "ceo", "zz-temp");
    expect(removed).toBe(FLUSH);
  });

  test("add then remove round-trips to byte-identical original (indented style)", () => {
    const added = addDirectReport(INDENTED, "ceo", "zz-temp");
    const removed = removeDirectReport(added, "ceo", "zz-temp");
    expect(removed).toBe(INDENTED);
  });

  test("removing the last item collapses back to inline []", () => {
    const withChild = addDirectReport(FLUSH, "director-b", "worker-b1");
    const back = removeDirectReport(withChild, "director-b", "worker-b1");
    expect(back).toBe(FLUSH);
  });

  test("adding an already-present child is a no-op", () => {
    expect(addDirectReport(FLUSH, "ceo", "director-a")).toBe(FLUSH);
  });

  test("comments inside an entry survive an edit to that same entry", () => {
    const out = addDirectReport(FLUSH, "director-a", "worker-a2");
    expect(out).toContain("# comment inside an entry — must survive every edit below");
  });

  test("the unrelated routing_rules prose is never touched", () => {
    const out = addDirectReport(FLUSH, "ceo", "zz-temp");
    expect(out.split("routing_rules:")[1]).toBe(FLUSH.split("routing_rules:")[1]);
  });
});

describe("appendChartEntry", () => {
  test("appends a new root-less entry at the end of the chart list, matching file style", () => {
    const out = appendChartEntry(FLUSH, "worker-c1", "director-b");
    expect(out).toContain("- employee: worker-c1");
    const parsed = yaml.parse(out).chart.find((e: any) => e.employee === "worker-c1");
    expect(parsed.reports).toEqual(["director-b"]);
    expect(parsed.direct_reports).toEqual([]);
  });

  test("indented-style file gets an indented-style new entry", () => {
    const out = appendChartEntry(INDENTED, "worker-x", "director-a");
    expect(out).toContain("  - employee: worker-x");
  });

  test("refuses to append a slug that already exists", () => {
    expect(() => appendChartEntry(FLUSH, "director-a", "ceo")).toThrow(OrgChartEditError);
  });
});

describe("setReportsTo / reparentEmployee", () => {
  test("reparent moves the child out of the old parent and into the new one", () => {
    const out = reparentEmployee(FLUSH, "worker-a1", "director-a", "director-b");
    const parsed = yaml.parse(out);
    expect(parsed.chart.find((e: any) => e.employee === "worker-a1").reports).toEqual(["director-b"]);
    expect(parsed.chart.find((e: any) => e.employee === "director-a").direct_reports).toEqual([]);
    expect(parsed.chart.find((e: any) => e.employee === "director-b").direct_reports).toEqual(["worker-a1"]);
  });

  test("setReportsTo rewrites a single-item reports: line in place", () => {
    const out = setReportsTo(FLUSH, "worker-a1", "director-b");
    expect(yaml.parse(out).chart.find((e: any) => e.employee === "worker-a1").reports).toEqual(["director-b"]);
  });
});

describe("wouldCreateCycle", () => {
  test("moving an ancestor under its own descendant is a cycle", () => {
    expect(wouldCreateCycle(FLUSH, yaml.parse, "ceo", "worker-a1")).toBe(true);
  });

  test("moving a leaf under an unrelated node is not a cycle", () => {
    expect(wouldCreateCycle(FLUSH, yaml.parse, "worker-a1", "director-b")).toBe(false);
  });

  test("a node can't become its own parent", () => {
    expect(wouldCreateCycle(FLUSH, yaml.parse, "director-a", "director-a")).toBe(true);
  });
});

describe("unsupported shape", () => {
  test("a legacy org:{} map file throws OrgChartEditError instead of corrupting", () => {
    expect(() => addDirectReport(UNSUPPORTED, "ceo", "x")).toThrow(OrgChartEditError);
  });
});
