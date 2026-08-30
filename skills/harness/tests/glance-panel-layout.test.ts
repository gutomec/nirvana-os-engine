import { describe, expect, test } from "bun:test";
import {
  CHAT_WIDTH_MAX,
  CHAT_WIDTH_MIN,
  clampChatWidth,
  filterRelatedActivity,
  filterRunsByQuery,
  shouldCollapseSidebar,
} from "../lib/glance/views/panel-layout.js";

describe("clampChatWidth — 460..920px resize bounds (page-layout-redesign.md §2.2)", () => {
  test("a value inside the range passes through unchanged", () => {
    expect(clampChatWidth(500)).toBe(500);
  });

  test("a drag or ArrowLeft/ArrowRight step past either edge clamps, never overshoots", () => {
    expect(clampChatWidth(100)).toBe(CHAT_WIDTH_MIN);
    expect(clampChatWidth(2000)).toBe(CHAT_WIDTH_MAX);
  });

  test("the bounds are exactly the ones the orchestrator measured live on the mockup", () => {
    expect(CHAT_WIDTH_MIN).toBe(460);
    expect(CHAT_WIDTH_MAX).toBe(920);
    // ArrowRight from the compact floor, +40px per keypress, must land in range.
    expect(clampChatWidth(CHAT_WIDTH_MIN + 40)).toBe(500);
  });
});

describe("shouldCollapseSidebar — the 64px icon rail (page-layout-redesign.md §1.3)", () => {
  test("collapses when a run is open and not pinned", () => {
    expect(shouldCollapseSidebar({ pinnedFull: false, hasSelectedRun: true })).toBe(true);
  });

  test("pinning wins over an open run — the escape hatch always works", () => {
    expect(shouldCollapseSidebar({ pinnedFull: true, hasSelectedRun: true })).toBe(false);
  });

  test("no run open means full width regardless of the pin", () => {
    expect(shouldCollapseSidebar({ pinnedFull: false, hasSelectedRun: false })).toBe(false);
    expect(shouldCollapseSidebar({ pinnedFull: true, hasSelectedRun: false })).toBe(false);
  });
});

describe("filterRunsByQuery — the runs-rail search box", () => {
  const runs = [
    { trace_id: "a1", brief: "Redesign de layout do Glance", business_slug: "ux-atelier", squad_name: null },
    { trace_id: "b2", brief: "Plano de conteúdo 30 dias", business_slug: "content-social-factory", squad_name: "copywriter-squad" },
    { trace_id: "c3", brief: null, business_slug: null, squad_name: "seo-geo-aeo" },
  ];

  test("an empty query returns the list unchanged", () => {
    expect(filterRunsByQuery(runs, "")).toEqual(runs);
    expect(filterRunsByQuery(runs, "   ")).toEqual(runs);
  });

  test("matches the brief, case-insensitively", () => {
    expect(filterRunsByQuery(runs, "REDESIGN").map((r) => r.trace_id)).toEqual(["a1"]);
  });

  test("matches business_slug and squad_name too, not just the brief", () => {
    expect(filterRunsByQuery(runs, "content-social").map((r) => r.trace_id)).toEqual(["b2"]);
    expect(filterRunsByQuery(runs, "seo-geo").map((r) => r.trace_id)).toEqual(["c3"]);
  });

  test("a run with every matched field null never throws (the empty run in the fixture)", () => {
    expect(() => filterRunsByQuery(runs, "nothing matches this")).not.toThrow();
    expect(filterRunsByQuery(runs, "nothing matches this")).toEqual([]);
  });
});

describe("filterRelatedActivity — the run-detail strip scoped to business/project", () => {
  const run = { trace_id: "this-run", business_slug: "ux-atelier", project_id: "proj-1" };

  test("matches by business_slug", () => {
    const events = [{ trace_id: "other", business_slug: "ux-atelier", event: "delivered" }];
    expect(filterRelatedActivity(events, run)).toEqual(events);
  });

  test("matches by project_id when business_slug differs or is absent", () => {
    const events = [{ trace_id: "other", project_id: "proj-1", event: "gate_passed" }];
    expect(filterRelatedActivity(events, run)).toEqual(events);
  });

  test("excludes events already on this run's own trace — the Trajectory Card already shows those", () => {
    const events = [{ trace_id: "this-run", business_slug: "ux-atelier", event: "dispatch_business" }];
    expect(filterRelatedActivity(events, run)).toEqual([]);
  });

  test("excludes events matching neither field", () => {
    const events = [{ trace_id: "other", business_slug: "unrelated-biz", project_id: "other-proj", event: "x" }];
    expect(filterRelatedActivity(events, run)).toEqual([]);
  });

  test("no selected run means no related activity", () => {
    expect(filterRelatedActivity([{ trace_id: "x" }], null)).toEqual([]);
  });
});
