// audit-events-doc.test.ts — the event table in references/03-audit.md is
// GENERATED from lib/audit.js ALLOWED_EVENTS (scripts/gen-audit-events-doc.ts).
// This test asserts the doc matches the enum, so the table can never fossilize
// again: adding an event without regenerating the doc is a test failure.
//
// Fix when red: bun scripts/gen-audit-events-doc.ts --write

import { describe, expect, test } from "bun:test";
import { BEGIN, END, allowedEvents, currentDoc, docInSync, renderBlock } from "../../../scripts/gen-audit-events-doc.ts";

describe("references/03-audit.md generated event table", () => {
  test("markers are present in the doc", () => {
    const doc = currentDoc();
    expect(doc).toContain(BEGIN);
    expect(doc).toContain(END);
  });

  test("doc block matches ALLOWED_EVENTS exactly (regen with gen-audit-events-doc --write)", () => {
    expect(docInSync()).toBe(true);
  });

  test("rendered block lists every enum event once", () => {
    const block = renderBlock();
    const events = allowedEvents();
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(block.split("\n")).toContain(e);
    }
  });
});
