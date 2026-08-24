// pdf-valid.test.ts — the gate finally covers PDF.
//
// The failure this prevents (VPS field report, 2026-08-22): a PDF-only
// delivery was invisible to the auto gate (.pdf was not gateable), so the
// dispatched agent had to gate by hand with qpdf and emit
// x_quality_gate_tooling_gap. Also pins the object-stream trap: a naive
// /Type /Page regex reads 0 pages on compressed PDFs and must not fail them.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../rubrics/pdf-valid.ts";
import { GATEABLE_EXTS, rubricsForExt } from "../scripts/quality-gate.ts";

const tmp = mkdtempSync(join(tmpdir(), "pdf-valid-"));
const PAD = "%".repeat(6000); // clears the stub floor without changing structure

function minimalPdf(): string {
  return [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj",
    `% ${PAD}`,
    "trailer << /Root 1 0 R >>",
    "%%EOF",
  ].join("\n");
}

describe("pdf-valid rubric", () => {
  test(".pdf is gateable and mapped to pdf-valid", () => {
    expect(GATEABLE_EXTS.has(".pdf")).toBeTrue();
    expect(rubricsForExt(".pdf")).toEqual(["pdf-valid"]);
  });

  test("a minimal valid PDF passes", async () => {
    const p = join(tmp, "ok.pdf");
    writeFileSync(p, minimalPdf(), "latin1");
    const r = await evaluate({ artifact: p, content: "" });
    expect(r.passed).toBe(true);
  });

  test("a truncated PDF (no %%EOF) fails with a named fix", async () => {
    const p = join(tmp, "trunc.pdf");
    writeFileSync(p, minimalPdf().replace("%%EOF", ""), "latin1");
    const r = await evaluate({ artifact: p, content: "" });
    expect(r.passed).toBe(false);
    expect(r.fix_list.some((f) => f.includes("%%EOF"))).toBe(true);
  });

  test("a non-PDF byte blob fails on the header", async () => {
    const p = join(tmp, "fake.pdf");
    writeFileSync(p, "<html>not a pdf</html>" + PAD);
    const r = await evaluate({ artifact: p, content: "" });
    expect(r.passed).toBe(false);
    expect(r.fix_list.some((f) => f.includes("%PDF-"))).toBe(true);
  });

  test("object-stream PDFs with zero regex-visible pages still pass structurally", async () => {
    // /ObjStm present, no /Type /Page in clear text — the compressed-PDF trap.
    const p = join(tmp, "objstm.pdf");
    writeFileSync(p, ["%PDF-1.7", "9 0 obj << /Type /ObjStm /N 4 >> stream", "endstream endobj", `% ${PAD}`, "%%EOF"].join("\n"), "latin1");
    const prevPath = process.env.PATH;
    process.env.PATH = "/nonexistent"; // force the no-tools branch
    try {
      const r = await evaluate({ artifact: p, content: "" });
      expect(r.passed).toBe(true);
      expect(r.reasoning).toContain("unverifiable");
    } finally {
      process.env.PATH = prevPath;
    }
  });

  test("an empty-body PDF (no pages, no object streams) fails", async () => {
    const p = join(tmp, "empty.pdf");
    writeFileSync(p, ["%PDF-1.4", `% ${PAD}`, "%%EOF"].join("\n"), "latin1");
    const prevPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const r = await evaluate({ artifact: p, content: "" });
      expect(r.passed).toBe(false);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});

// cleanup
process.on("beforeExit", () => rmSync(tmp, { recursive: true, force: true }));
